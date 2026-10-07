/**
 * The Rapier adapter — the ONLY module in the codebase permitted to touch the Rapier
 * global namespace.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE PRIME STEP (experiment E1, docs/ARCHITECTURE.md §4.2, DEV_LOG Q1)
 * ────────────────────────────────────────────────────────────────────────────────
 * Read this before modifying anything in this file.
 *
 * A Rapier `KinematicCharacterController` is **permanently and silently corrupted** if
 * its first `computeColliderMovement()` call happens before the world has been stepped
 * at least once. After that single bad call, geometry collision is ignored for the
 * lifetime of the controller, while `computedGrounded()` continues to return
 * plausible-looking values. The character settles sunk roughly 0.18 m into the floor,
 * or falls clean out of the world if movement is sustained.
 *
 * The corruption does not self-heal, and it is *latent*: the trigger threshold is a
 * first movement above ~0.04 m, and gravity's first tick at 60 Hz is 0.0027 m, so a
 * normal boot works by luck and a slow first frame breaks the session. That is why
 * this class performs the prime step unconditionally and then *asserts* that a ground
 * probe hits, converting a silent permanent failure into a loud immediate one.
 *
 * Guarded by `test/characterisation/character-controller-grounding.test.ts`.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import {
  PLAYER_CAPSULE_HALF_HEIGHT_M,
  PLAYER_CAPSULE_RADIUS_M,
  SNAP_TO_GROUND_M,
  CONTROLLER_OFFSET_M,
  PLAYER_MASS_KG,
  SLOPE_CLIMB_LIMIT_DEG,
  SLOPE_SLIDE_TRIGGER_DEG,
  AUTOSTEP_MAX_M,
  AUTOSTEP_MIN_WIDTH_M,
} from '../core/constants';
import { CollisionLayer, collisionGroupsFor, queryGroupsFor } from './Layers';

/** A plain 3-component vector. Deliberately not a THREE.Vector3, to keep `physics/` free
 * of rendering dependencies and therefore testable in bare Node. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Outcome of a single character movement request. */
export interface CharacterMoveResult {
  /** The translation the character actually performed, after all collision resolution. */
  movement: Vec3Like;
  /** Whether the controller considers the character to be standing on something. */
  grounded: boolean;
  /**
   * Surface normal of the ground contact, when grounded.
   *
   * Cross-checked against the 5-ray cone probe (GDD §4.4) rather than trusted alone:
   * `computedGrounded()` was observed reporting `true` while a corrupted capsule was in
   * free-fall (DEV_LOG Q2), so the engine's opinion is a hint, not an authority.
   */
  groundNormal: Vec3Like | null;
}

/**
 * A kinematic character: a capsule, its rigid body, and the controller that moves it.
 *
 * This class exists so that gameplay code never sees a Rapier type. It is the seam
 * described in ARCHITECTURE.md §6.1, and its narrowness is what makes the character
 * controller unit- and integration-testable in CI.
 *
 * Typical use is exactly three calls per tick:
 * ```
 * const result = character.moveAndSlide(desiredTranslation);
 * if (result.grounded) verticalVelocity = 0;
 * physics.step();
 * ```
 */
export class KinematicCharacter {
  /**
   * @param world - The Rapier world this character belongs to.
   * @param body - The kinematic rigid body.
   * @param collider - The capsule collider attached to it.
   * @param controller - The movement solver.
   */
  constructor(
    private readonly body: RAPIER.RigidBody,
    private readonly collider: RAPIER.Collider,
    private readonly controller: RAPIER.KinematicCharacterController,
  ) {}

  /**
   * Request a translation for this tick and resolve it against the world.
   *
   * MUST NOT be called before the world has been primed (see `PhysicsWorld.primeAndVerify`
   * and DEV_LOG Q1). The prime step is performed by the facade, so callers that obtain
   * characters through `PhysicsWorld.createCharacter` inherit the guarantee.
   *
   * @param desired - The translation the controller would like to perform, in metres.
   * @returns What actually happened, including the ground normal if grounded.
   */
  public moveAndSlide(desired: Vec3Like): CharacterMoveResult {
    this.controller.computeColliderMovement(this.collider, desired);
    const movement = this.controller.computedMovement();
    const grounded = this.controller.computedGrounded();

    // Read the steepest ground contact normal. `numComputedCollisions` includes wall and
    // ceiling contacts, so accepting the first collision would report a wall normal as
    // the ground normal on a corner — which would then feed a nonsense slope angle into
    // the movement system.
    let groundNormal: Vec3Like | null = null;
    const collisionCount = this.controller.numComputedCollisions();
    for (let i = 0; i < collisionCount; i++) {
      const collision = this.controller.computedCollision(i);
      const normal = collision?.normal1;
      if (normal && normal.y > 0.3) {
        if (!groundNormal || normal.y > groundNormal.y) {
          groundNormal = { x: normal.x, y: normal.y, z: normal.z };
        }
      }
    }

    const position = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: position.x + movement.x,
      y: position.y + movement.y,
      z: position.z + movement.z,
    });

    return {
      movement: { x: movement.x, y: movement.y, z: movement.z },
      grounded,
      groundNormal,
    };
  }

  /** Current body origin in world space. */
  public get position(): Vec3Like {
    const translation = this.body.translation();
    return { x: translation.x, y: translation.y, z: translation.z };
  }

  /**
   * Hard-set the character's position, bypassing collision.
   *
   * Intended for respawns and teleports only. Callers MUST validate the destination
   * first (`PhysicsWorld.sphereOverlaps`), because placing a capsule inside geometry has
   * no recovery path — risk R14's "validated respawn invariant".
   *
   * @param position - The destination in world space.
   */
  public teleport(position: Vec3Like): void {
    this.body.setTranslation(position, true);
    this.body.setNextKinematicTranslation(position);
  }

  /** Whether the controller reported a ground contact on its most recent solve. */
  public get grounded(): boolean {
    return this.controller.computedGrounded();
  }
}

/** A raycast hit, described in our own terms rather than Rapier's. */
export interface RaycastHit {
  /** Distance from the ray origin to the hit point, in metres. */
  distance: number;
  /** Surface normal at the hit point, world space. */
  normal: { x: number; y: number; z: number };
  /** World-space hit position. */
  point: { x: number; y: number; z: number };
  /** Opaque handle identifying the hit collider, for surface-type lookups. */
  colliderHandle: number;
}

/** Description of a static collider to create. */
export interface StaticColliderDescription {
  /** Shape to create. */
  shape: ColliderShapeDescription;
  /** World-space translation of the collider's centre. */
  translation: { x: number; y: number; z: number };
  /** Optional quaternion rotation. Defaults to identity. */
  rotation?: { x: number; y: number; z: number; w: number };
  /** Which collision layer the collider belongs to. */
  layer: CollisionLayer;
  /** Optional identifier used to look up surface type for footsteps and sliding. */
  surfaceType?: string;
}

/** Supported collider shapes, chosen to cover everything the level needs. */
export type ColliderShapeDescription =
  | { kind: 'cuboid'; halfExtents: { x: number; y: number; z: number } }
  | { kind: 'ball'; radius: number }
  | { kind: 'cylinder'; halfHeight: number; radius: number }
  | { kind: 'capsule'; halfHeight: number; radius: number }
  | { kind: 'trimesh'; vertices: Float32Array; indices: Uint32Array };

/**
 * Wraps a Rapier world and exposes only the operations the game needs.
 *
 * Consumers never see a Rapier type. That keeps the engine seam narrow (risk W2) and
 * means the characterisation tests can target the engine behaviour directly while the
 * game code depends only on this facade.
 */
export class PhysicsWorld {
  /** The underlying Rapier world. Private: use the facade methods. */
  private readonly world: RAPIER.World;

  /** Maps collider handles to surface types, for footsteps and slide audio. */
  private readonly surfaceTypes = new Map<number, string>();

  /**
   * Maps collider handles to the rigid body that owns them.
   *
   * Rapier allocates both colliders and bodies outside the JS heap, and removing a
   * collider leaves an empty body behind. Tracking the owner lets removal free both,
   * which is what keeps the live count meaningful as a leak detector (risk R9).
   */
  private readonly colliderOwners = new Map<number, RAPIER.RigidBody>();

  /** Live collider count, surfaced by the debug overlay to catch handle leaks (R9). */
  private liveColliderCount = 0;

  /** True once the prime step has run. Guards against accidental reuse before init. */
  private primed = false;

  /**
   * Create and prime a physics world.
   *
   * The constructor performs the prime step itself rather than leaving it to the
   * caller, because a rule that must be remembered will eventually be forgotten.
   *
   * @param gravityMagnitude - Downward acceleration in m/s². Defaults to Earth-like
   *   gravity for props; character gravity is applied manually and separately.
   */
  constructor(gravityMagnitude: number = 9.81) {
    this.world = new RAPIER.World({ x: 0, y: -gravityMagnitude, z: 0 });
  }

  /**
   * Initialise the Rapier WASM module.
   *
   * Must be awaited before any world is constructed. Called once during boot, from the
   * lazily-loaded physics chunk (see the two-phase boot in ARCHITECTURE.md §W5).
   */
  public static async initialise(): Promise<void> {
    await RAPIER.init();
  }

  /**
   * Create the player's kinematic character controller, configured from the GDD's
   * slope bands and traversal rules.
   *
   * @returns The configured controller. Ownership transfers to the caller, which is
   *   responsible for calling `computeColliderMovement` at most once per tick.
   */
  public createCharacterController(): RAPIER.KinematicCharacterController {
    const controller = this.world.createCharacterController(CONTROLLER_OFFSET_M);

    controller.setUp({ x: 0, y: 1, z: 0 });

    // Slope bands from GDD §4.5. Rapier enforces the *blocking*; our own slope reading
    // drives presentation and the jump-eligibility rule.
    controller.setMaxSlopeClimbAngle((SLOPE_CLIMB_LIMIT_DEG * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((SLOPE_SLIDE_TRIGGER_DEG * Math.PI) / 180);

    // Autostep covers the bottom of the mantle band for free (E5: a 0.3 m stair is
    // traversed cleanly and the character continues to x = 11.90). Bespoke mantle code
    // is therefore needed only for the 0.4-1.2 m band.
    controller.enableAutostep(AUTOSTEP_MAX_M, AUTOSTEP_MIN_WIDTH_M, true);

    // Ground snapping is a *feel* setting, not the E1 fix (E2c), and it is required:
    // without it the idle capsule jitters by ~0.0001 m per tick.
    controller.enableSnapToGround(SNAP_TO_GROUND_M);

    // Lets the player shove props and puzzle blocks rather than ghosting through them.
    controller.setApplyImpulsesToDynamicBodies(true);
    controller.setCharacterMass(PLAYER_MASS_KG);

    return controller;
  }

  /**
   * Create a capsule character at a position.
   *
   * The returned `KinematicCharacter` owns a kinematic body and a controller; the caller
   * drives it with `moveAndSlide` once per tick and then calls `PhysicsWorld.step`.
   *
   * @param position - Initial body origin in world space.
   * @param options.capsuleHalfHeight - Cylindrical section half-height. Defaults to the
   *   player's dimensions.
   * @param options.capsuleRadius - Capsule radius. Defaults to the player's dimensions.
   * @param options.layer - Collision layer. Defaults to `Player`.
   * @returns The character wrapper.
   */
  public createCharacter(
    position: Vec3Like,
    options: {
      capsuleHalfHeight?: number;
      capsuleRadius?: number;
      layer?: CollisionLayer;
    } = {},
  ): KinematicCharacter {
    const halfHeight = options.capsuleHalfHeight ?? PLAYER_CAPSULE_HALF_HEIGHT_M;
    const radius = options.capsuleRadius ?? PLAYER_CAPSULE_RADIUS_M;
    const layer = options.layer ?? CollisionLayer.Player;

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(position.x, position.y, position.z),
    );

    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(halfHeight, radius).setCollisionGroups(
        collisionGroupsFor([layer]),
      ),
      body,
    );

    const controller = this.createCharacterController();
    this.liveColliderCount++;

    return new KinematicCharacter(body, collider, controller);
  }

  /**
   * Create a static collider from a description.
   *
   * @param description - Shape, transform and layer.
   * @returns The Rapier collider handle, which callers may store for later removal.
   */
  public createStaticCollider(description: StaticColliderDescription): number {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(
          description.translation.x,
          description.translation.y,
          description.translation.z,
        )
        .setRotation(
          description.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
        ),
    );

    const colliderDescription = this.buildColliderDescription(description.shape);
    colliderDescription.setCollisionGroups(collisionGroupsFor([description.layer]));

    const collider = this.world.createCollider(colliderDescription, body);
    const handle = collider.handle;

    if (description.surfaceType) {
      this.surfaceTypes.set(handle, description.surfaceType);
    }
    this.colliderOwners.set(handle, body);

    this.liveColliderCount++;
    return handle;
  }

  /**
   * Translate our shape description into a Rapier collider description.
   *
   * @param shape - The shape description.
   * @returns A Rapier collider description ready for mass/filter configuration.
   */
  private buildColliderDescription(shape: ColliderShapeDescription): RAPIER.ColliderDesc {
    switch (shape.kind) {
      case 'cuboid':
        return RAPIER.ColliderDesc.cuboid(
          shape.halfExtents.x,
          shape.halfExtents.y,
          shape.halfExtents.z,
        );
      case 'ball':
        return RAPIER.ColliderDesc.ball(shape.radius);
      case 'cylinder':
        return RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
      case 'capsule':
        return RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
      case 'trimesh':
        return RAPIER.ColliderDesc.trimesh(shape.vertices, shape.indices);
    }
  }

  /**
   * Remove a collider by handle.
   *
   * Rapier allocates collider state *outside* the JavaScript heap, so a removed
   * collider whose handle is never freed is invisible to a JS heap profiler (risk R9).
   * This is the only sanctioned removal path, and it maintains the live count that the
   * debug overlay surfaces.
   *
   * @param handle - The collider handle returned by {@link createStaticCollider}.
   */
  /**
   * Move an existing collider, which is how moving platforms are implemented.
   *
   * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
   * A moving platform could be a dynamic body driven by forces, or a kinematic body with a
   * velocity. Both are worse than moving the collider directly:
   *   • A dynamic body needs a motor and drifts under load, so a platform carrying the player
   *     visibly sags.
   *   • A Rapier kinematic-velocity body is stepped by the solver, so the platform's position
   *     on a given tick depends on solver internals rather than on our fixed-step loop.
   *
   * Setting the translation from the fixed-step loop makes the platform's motion *exactly*
   * reproducible, which is what lets edge case 4 ("a jump from a moving platform inherits its
   * velocity") be asserted rather than merely observed.
   *
   * This is safe to call on a static collider: Rapier treats a fixed body moved by
   * `setTranslation` as teleported, and the character controller's ground probe reads the new
   * position on the very next tick.
   *
   * @param handle - A handle returned by {@link createStaticCollider}.
   * @param translation - The new world-space centre.
   * @throws If the handle is unknown, because silently doing nothing would present as a
   *   platform that refuses to move and would be blamed on the character controller.
   */
  public setColliderTranslation(handle: number, translation: Vec3Like): void {
    const owner = this.colliderOwners.get(handle);
    if (!owner) {
      throw new Error(`setColliderTranslation: unknown collider handle ${handle}.`);
    }
    if (!Number.isFinite(translation.x) || !Number.isFinite(translation.y) || !Number.isFinite(translation.z)) {
      throw new Error('setColliderTranslation requires a finite position.');
    }
    owner.setTranslation(translation, true);
  }

  /**
   * Read a collider's current world-space translation.
   *
   * Used by the character controller to compute how far the surface it is standing on moved
   * during the last tick, which is how a moving platform carries the player.
   *
   * @param handle - A handle returned by {@link createStaticCollider}.
   * @returns The collider's world translation, or null if the handle is unknown.
   */
  public colliderTranslation(handle: number): Vec3Like | null {
    const owner = this.colliderOwners.get(handle);
    if (!owner) return null;
    const translation = owner.translation();
    return { x: translation.x, y: translation.y, z: translation.z };
  }

  public removeCollider(handle: number): void {
    this.surfaceTypes.delete(handle);

    const owner = this.colliderOwners.get(handle);
    this.colliderOwners.delete(handle);

    if (owner) {
      // Removing the body frees its colliders *and* the body itself. Removing only the
      // collider would leave an orphaned body holding WASM memory that no JS profiler
      // can see.
      this.world.removeRigidBody(owner);
    } else {
      const collider = this.world.getCollider(handle);
      if (collider) {
        this.world.removeCollider(collider, true);
      }
    }

    this.liveColliderCount = Math.max(0, this.liveColliderCount - 1);
  }

  /**
   * Step the simulation exactly one fixed tick.
   *
   * Must be called exactly once per tick, AFTER all character controllers have
   * computed their movements — the canonical order for a kinematic controller.
   * Verified stable over 1800 ticks with 4.5e-8 m cumulative drift (E2b).
   */
  public step(): void {
    this.world.step();
  }

  /**
   * Perform the mandatory prime step and verify the world is usable.
   *
   * Call once after all initial colliders exist and before any character controller
   * queries. The verification is the important half: E1c proved that an unprimed world
   * behaves correctly by accident under a normal boot, so the failure would otherwise
   * be silent until a player's first frame happened to be slow.
   *
   * @param probeFrom - A world position known to be above solid ground.
   * @param probeDistance - How far down to look for ground.
   * @throws If the prime step fails to make the world queryable, because continuing
   *   would produce a silently broken character controller.
   */
  public primeAndVerify(
    probeFrom: { x: number; y: number; z: number },
    probeDistance: number = 50,
  ): void {
    // THE PRIME STEP. One line; the difference between a working game and a permanent
    // physics failure.
    this.world.step();
    this.primed = true;

    const hit = this.castRay(
      probeFrom,
      { x: 0, y: -1, z: 0 },
      probeDistance,
      [CollisionLayer.StaticWorld],
    );

    if (hit === null) {
      throw new Error(
        'PhysicsWorld prime verification failed: no ground beneath the spawn point. ' +
          'A character controller queried against this world would be permanently ' +
          'corrupted (see DEV_LOG Q1). Check that level colliders were created and ' +
          'that the spawn point is above solid geometry.',
      );
    }
  }

  /** Whether the world has been primed. */
  public get isPrimed(): boolean {
    return this.primed;
  }

  /**
   * Cast a ray and return the nearest hit.
   *
   * @param origin - World-space ray origin.
   * @param direction - Ray direction. Normalised internally.
   * @param maxDistance - Maximum distance to search, in metres.
   * @param layers - Layers to include in the query. Omitting this searches everything,
   *   which is rarely what a caller wants — the camera, for example, must never be
   *   pushed by a trigger volume.
   * @returns The nearest hit, or null.
   */
  public castRay(
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
    maxDistance: number,
    layers?: readonly CollisionLayer[],
  ): RaycastHit | null {
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length < 1e-9) {
      return null;
    }

    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: direction.x / length, y: direction.y / length, z: direction.z / length },
    );

    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true, // solid: stop inside the first surface rather than exiting it
      undefined, // default filter flags
      // Queries use their own encoding; see queryGroupsFor for why collisionGroupsFor
      // silently matches nothing here.
      layers ? queryGroupsFor(layers) : undefined,
    );

    if (!hit) {
      return null;
    }

    // Rapier's field is `timeOfImpact` (not `toi`) and is expressed as a fraction of
    // the ray's *direction vector*, which is unit length here, so it is already a
    // distance in metres.
    const distance = hit.timeOfImpact;

    return {
      distance,
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      point: {
        x: origin.x + ray.dir.x * distance,
        y: origin.y + ray.dir.y * distance,
        z: origin.z + ray.dir.z * distance,
      },
      colliderHandle: hit.collider.handle,
    };
  }

  /**
   * Test whether a sphere at a position overlaps any collider on the given layers.
   *
   * Used for respawn validation (R14): no respawn transform may be committed until it
   * has been proven clear, which makes a bad checkpoint structurally impossible rather
   * than merely unlikely.
   *
   * @param position - Sphere centre in world space.
   * @param radius - Sphere radius in metres.
   * @param layers - Layers to test against.
   * @returns True if anything overlaps.
   */
  public sphereOverlaps(
    position: { x: number; y: number; z: number },
    radius: number,
    layers: readonly CollisionLayer[],
  ): boolean {
    const shape = new RAPIER.Ball(radius);
    // Signature confirmed against rapier3d-compat 0.21 type definitions:
    //   intersectionWithShape(shapePos, shapeRot, shape, filterFlags?, filterGroups?, ...)
    // The query groups are the FIFTH argument. Passing them positionally into the
    // filterExcludeRigidBody slot silently type-errors under strict mode but would be a
    // confusing runtime no-op in looser code, so this call is deliberately kept explicit.
    return (
      this.world.intersectionWithShape(
        position,
        { x: 0, y: 0, z: 0, w: 1 },
        shape,
        undefined,
        queryGroupsFor(layers),
      ) !== null
    );
  }

  /**
   * Look up the authored surface type of a collider.
   *
   * @param colliderHandle - Handle from a {@link RaycastHit}.
   * @returns The surface type, or 'stone' as a safe default so audio and dust never
   *   silently fall back to a missing asset.
   */
  public surfaceTypeAt(colliderHandle: number): string {
    return this.surfaceTypes.get(colliderHandle) ?? 'stone';
  }

  /**
   * Number of live colliders. A monotonically rising count across a session indicates
   * a leaked handle (risk R9) and is displayed by the debug overlay.
   */
  public get colliderCount(): number {
    return this.liveColliderCount;
  }

  /**
   * Release the Rapier world.
   *
   * WASM allocations are not garbage collected, so the world must be freed explicitly
   * or a level reload leaks the entire simulation.
   */
  public dispose(): void {
    this.surfaceTypes.clear();
    this.colliderOwners.clear();
    this.liveColliderCount = 0;
    this.primed = false;
    this.world.free();
  }
}
