/**
 * The player character controller.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE
 * ────────────────────────────────────────────────────────────────────────────────
 * Responsibilities are split so the interesting logic is testable without an engine:
 *
 *   GroundProbe          -> what is under us?          (physics queries)
 *   LocomotionStates     -> which state are we in?     (pure transitions)
 *   locomotion maths     -> how do the numbers change? (pure functions)
 *   CharacterController  -> owns velocity + state and drives the body
 *
 * This file is therefore mostly *glue*: read the probe, resolve the state, integrate the
 * velocity, hand the result to Rapier. Every decision lives in a tested module above it.
 *
 * ─── THE PER-TICK ORDER, AND WHY IT IS THIS ORDER ───────────────────────────────────
 *   1. Guard non-finite position   (a NaN position is unrecoverable)
 *   2. Probe the ground            (before deciding anything)
 *   3. Sample input windows        (coyote/buffer, before resolving state)
 *   4. Resolve the locomotion state(pure function of 1-3)
 *   5. Project inherited velocity  (BEFORE jump integration — see the note below)
 *   6. Integrate velocity per state(including jump impulses)
 *   7. Move and collide            (the single Rapier call)
 *   8. Post-move bookkeeping       (landing, safety nets, window advance)
 *
 * Two orderings here are load-bearing and were both wrong in the first draft:
 *
 *  • **Probing precedes state resolution.** The controller's own `computedGrounded()` is
 *    only valid *after* a move, so reading the engine's opinion and then reacting to it
 *    would make every decision one tick stale.
 *
 *  • **Slope projection precedes jump integration.** Projecting the velocity onto the
 *    ground plane removes the component pointing *into* the surface — which, applied after
 *    a jump, also removes the jump's upward impulse. Running uphill and jumping would then
 *    silently do nothing. The projection is only ever meant to clean up velocity the
 *    character *inherited*, so it must run before any new impulse is applied.
 *
 *  • **Windows advance last**, so every consumer reads them at their current value.
 */

import {
  ACCELERATION_TIME_S,
  AIR_CONTROL_FACTOR,
  AUTOSTEP_MAX_M,
  COYOTE_TICKS,
  CROUCH_SPEED_SCALE,
  DECELERATION_TIME_S,
  GRAVITY_FALLING_MPS2,
  GRAVITY_RISING_MPS2,
  JUMP_BUFFER_TICKS,
  JUMP_COOLDOWN_S,
  JUMP_HEIGHT_RUNNING_M,
  JUMP_HEIGHT_STANDING_M,
  JUMP_HOLD_GRAVITY_SCALE,
  JUMP_RELEASE_CUT,
  JUMP_STANDING_DISTANCE_M,
  JUMP_RUNNING_DISTANCE_M,
  KILL_PLANE_Y,
  MANTLE_FORWARD_DRIFT_MPS,
  MANTLE_HIGH_MAX_M,
  MANTLE_LOW_DURATION_S,
  MANTLE_LOW_MAX_M,
  RUN_SPEED_MPS,
  SLOPE_SLIDE_SPEED_MPS,
  SLOPE_SLOW_SPEED_SCALE,
  TERMINAL_VELOCITY_MPS,
  TICK_RATE,
  TURN_RATE_AIR_DEG,
  TURN_RATE_GROUND_DEG,
  WALK_SPEED_MPS,
} from '../core/constants';
import {
  approachAngle,
  approachSpeed,
  effectiveRiseGravity,
  hasGroundFriction,
  projectVelocityOntoSurface,
  solveJumpLaunch,
  speedDeltaForTransition,
  SlopeBand,
  TickWindow,
} from '../core/math/locomotion';
import { CollisionLayer } from '../physics/Layers';
import type {
  CharacterMoveResult,
  KinematicCharacter,
  PhysicsWorld,
  Vec3Like,
} from '../physics/PhysicsWorld';
import { GroundProbe, type GroundProbeResult } from './GroundProbe';
import {
  canJump,
  LocomotionState,
  resolveLocomotionState,
  type CharacterIntent,
  type LocomotionContext,
} from './LocomotionStates';

/** A mutable world-space vector owned by the controller. */
interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/** Everything the controller observed during a tick, for other systems to react to. */
export interface CharacterTickReport {
  state: LocomotionState;
  previousState: LocomotionState;
  position: Vec3Like;
  velocity: Readonly<MutableVec3>;
  grounded: boolean;
  slopeAngle: number;
  slopeBand: SlopeBand;
  groundNormal: Readonly<{ x: number; y: number; z: number }>;
  /** 0 when all outer ground rays hit; 1 when none did. */
  edgeProximity: number;
  surfaceType: string | null;
  horizontalSpeed: number;
  facingAngle: number;
  coyoteTicksRemaining: number;
  jumpBufferTicksRemaining: number;
}

/** Things that happened during a tick which other systems need to react to. */
export interface CharacterEvents {
  jumped: boolean;
  /** Downward speed absorbed on landing, in m/s. Drives landing audio and camera dip. */
  landedAtSpeed: number;
  /** Left the ground without jumping. This is what arms coyote time. */
  walkedOffLedge: boolean;
  mantleStarted: boolean;
  mantleFinished: boolean;
  /** A jump was requested but the slope band forbade it (needs visible feedback). */
  jumpRejectedOnSlope: boolean;
  /**
   * The player asked to grab a surface that is not climbable.
   *
   * Edge case 7 requires "clear feedback, no hang". A silent refusal is as bad as a hang:
   * the player cannot distinguish "the game ignored me" from "this surface is not
   * climbable", so the refusal has to be an explicit, observable event.
   */
  rejectedGrab: boolean;
  /** The safety net rescued the player (kill plane, NaN position, or a stuck state). */
  rescued: boolean;
  /** Deflected off another character rather than standing on them. */
  bouncedOffCharacter: boolean;
}

/**
 * The player's character controller.
 *
 * Deterministic: given the same world and the same sequence of intents it produces the
 * same trajectory, which is what makes the integration tests meaningful.
 */
export class CharacterController {
  private readonly character: KinematicCharacter;
  private readonly probe: GroundProbe;

  // ── Velocity and orientation ────────────────────────────────────────────────
  private readonly velocity: MutableVec3 = { x: 0, y: 0, z: 0 };
  private facing = 0;

  // ── State ───────────────────────────────────────────────────────────────────
  private state: LocomotionState = LocomotionState.Airborne;
  private previousState: LocomotionState = LocomotionState.Airborne;

  // ── Input windows (the forgiveness layer) ───────────────────────────────────
  private readonly coyote = new TickWindow(COYOTE_TICKS);
  private readonly jumpBuffer = new TickWindow(JUMP_BUFFER_TICKS);
  private jumpCooldownTicks = 0;

  // ── Mantle bookkeeping ──────────────────────────────────────────────────────
  private mantleElapsed = 0;
  private mantleDuration = MANTLE_LOW_DURATION_S;

  /** Whether the jump control was held last tick, so release can be edge-triggered. */
  private jumpHeldLastTick = false;

  /** Whether interact was requested last tick, so a pressured grab fires once per press. */
  private interactLastTick = false;

  // ── Safety nets ─────────────────────────────────────────────────────────────
  private stuckTicks = 0;
  private rescueCount = 0;
  private rescueReason = '';

  /** Latest ground probe result, retained for the camera, the rig and debugging. */
  private lastProbe: {
    grounded: boolean;
    normal: { x: number; y: number; z: number };
    slopeAngle: number;
    band: SlopeBand;
    edgeProximity: number;
    surfaceType: string | null;
    groundColliderHandle: number;
  } = {
    grounded: false,
    normal: { x: 0, y: 1, z: 0 },
    slopeAngle: 0,
    band: SlopeBand.Walkable,
    edgeProximity: 0,
    surfaceType: null,
    groundColliderHandle: -1,
  };

  // ── Moving-platform support (edge case 4) ───────────────────────────────────
  /** Collider the character stood on last tick, or -1. */
  private lastGroundCollider = -1;
  /** That collider's translation last tick, used to derive its velocity. */
  private lastGroundPosition: MutableVec3 | null = null;
  /** The ground surface's velocity this tick, in m/s. Zero on static ground. */
  private readonly platformVelocity: MutableVec3 = { x: 0, y: 0, z: 0 };

  /** Reusable event record, mutated in place to avoid per-tick allocation. */
  private readonly events: CharacterEvents = {
    jumped: false,
    landedAtSpeed: 0,
    walkedOffLedge: false,
    mantleStarted: false,
    mantleFinished: false,
    jumpRejectedOnSlope: false,
    rejectedGrab: false,
    rescued: false,
    bouncedOffCharacter: false,
  };

  private readonly spawnPoint: MutableVec3;

  /**
   * @param physics - The primed physics world. The controller inherits the prime-step
   *   guarantee because characters are created through `PhysicsWorld.createCharacter`.
   * @param spawnPoint - Where the player begins, and where the safety net returns them.
   */
  constructor(
    private readonly physics: PhysicsWorld,
    spawnPoint: Vec3Like,
  ) {
    this.spawnPoint = { x: spawnPoint.x, y: spawnPoint.y, z: spawnPoint.z };
    this.probe = new GroundProbe(physics);
    this.character = physics.createCharacter(spawnPoint, { layer: CollisionLayer.Player });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ACCESSORS
  // ─────────────────────────────────────────────────────────────────────────────

  /** The active locomotion state. */
  public get currentState(): LocomotionState {
    return this.state;
  }

  /** Body origin in world space. */
  public get position(): Vec3Like {
    return this.character.position;
  }

  /** Current velocity. Treat as read-only. */
  public get currentVelocity(): Readonly<MutableVec3> {
    return this.velocity;
  }

  /** Facing angle in radians. */
  public get facingAngle(): number {
    return this.facing;
  }

  /** Horizontal speed in m/s, for animation blending and footstep cadence. */
  public get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Latest ground information. */
  public get ground(): Readonly<typeof this.lastProbe> {
    return this.lastProbe;
  }

  /** Events raised during the most recent tick. */
  public get lastEvents(): Readonly<CharacterEvents> {
    return this.events;
  }

  /** How many times a safety net has fired. Surfaced by the debug overlay. */
  public get rescues(): number {
    return this.rescueCount;
  }

  /** Why the safety net last fired. Empty when it never has. */
  public get lastRescueReason(): string {
    return this.rescueReason;
  }

  /** Ticks remaining on the coyote window. */
  public get coyoteTicksRemaining(): number {
    return this.coyote.remaining;
  }

  /** Ticks remaining on the jump buffer. */
  public get jumpBufferTicksRemaining(): number {
    return this.jumpBuffer.remaining;
  }

  /** A complete snapshot of this tick's state, for the rig, camera and tests. */
  public get report(): CharacterTickReport {
    return {
      state: this.state,
      previousState: this.previousState,
      position: this.position,
      velocity: this.velocity,
      grounded: this.lastProbe.grounded,
      slopeAngle: this.lastProbe.slopeAngle,
      slopeBand: this.lastProbe.band,
      groundNormal: this.lastProbe.normal,
      edgeProximity: this.lastProbe.edgeProximity,
      surfaceType: this.lastProbe.surfaceType,
      horizontalSpeed: this.horizontalSpeed,
      facingAngle: this.facing,
      coyoteTicksRemaining: this.coyote.remaining,
      jumpBufferTicksRemaining: this.jumpBuffer.remaining,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN UPDATE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Advance the character by exactly one fixed tick.
   *
   * @param dt - Timestep in seconds. Always FIXED_DT; passed in so the controller can
   *   never silently read a variable real-time delta and lose determinism.
   * @param intent - The player's resolved intent for this tick.
   */
  public update(dt: number, intent: CharacterIntent): void {
    this.clearEvents();

    // A non-finite position makes every later query fail, and it is unrecoverable.
    if (!this.isPositionFinite()) {
      this.rescue('non-finite position');
      return;
    }

    const probe = this.readGroundProbe();

    // Moving-platform carry: Rapier does not carry kinematic characters on moving colliders.
    this.updatePlatformVelocity(probe.grounded, probe.groundColliderHandle);

    this.sampleInputWindows(intent, probe.grounded);
    const jumpWindowOpen = this.isJumpWindowOpen(probe.grounded);

    // Resolve the state first: the integration below depends on where we now are.
    const context = this.buildContext(probe, intent, jumpWindowOpen);
    this.advanceState(context, intent);

    // Clean inherited velocity BEFORE any new impulse is applied. Doing this after the jump
    // would delete the jump's own upward velocity whenever the ground normal has a
    // horizontal component, so running uphill and jumping would silently do nothing.
    this.projectInheritedVelocity(probe);

    this.integrateForState(dt, intent, probe, context.mantleLedgeHeight);
    this.applyMovement(dt, probe.grounded);
  }

  /**
   * Probe the ground and cache the result for this tick's consumers.
   *
   * @returns The raw probe result.
   */
  private readGroundProbe(): GroundProbeResult {
    const probe = this.probe.probe(this.position);
    this.lastProbe = {
      grounded: probe.grounded,
      normal: probe.normal,
      slopeAngle: probe.slopeAngle,
      band: probe.band,
      edgeProximity: probe.edgeProximity,
      surfaceType: probe.surfaceType,
      groundColliderHandle: probe.groundColliderHandle,
    };
    return probe;
  }

  /**
   * Advance the coyote and jump-buffer windows, and emit the interact refusal.
   *
   * @param intent - The player's intent.
   * @param grounded - Whether the ground probe found support.
   */
  private sampleInputWindows(intent: CharacterIntent, grounded: boolean): void {
    if (this.jumpCooldownTicks > 0) {
      this.jumpCooldownTicks--;
    }
    if (intent.jumpRequested) {
      this.jumpBuffer.arm();
    }

    // Coyote time is armed by *leaving* the ground without jumping — precisely the case it
    // exists to forgive. Arming it on every grounded tick would let a player who never left
    // the ground retain the window indefinitely.
    if (this.state === LocomotionState.Grounded && !grounded && this.velocity.y <= 0) {
      this.coyote.arm();
      this.events.walkedOffLedge = true;
    }

    // Interact refusal, edge-triggered on the press so holding interact does not emit the
    // event every tick and spam audio and UI. Nothing is climbable yet (authored climb
    // surfaces arrive in Milestone 2.3), so any interact press is by definition refused.
    if (intent.interactRequested && !this.interactLastTick) {
      this.events.rejectedGrab = true;
    }
    this.interactLastTick = intent.interactRequested;
  }

  /**
   * Whether a buffered jump may be consumed this tick.
   *
   * A jump is *available* when the buffer is open and the player is either grounded or inside
   * the coyote window. Whether the active state permits it at all is a separate question,
   * answered by `canJump` during integration.
   *
   * @param grounded - Whether the ground probe found support.
   * @returns True when the jump window is open.
   */
  private isJumpWindowOpen(grounded: boolean): boolean {
    return (
      this.jumpBuffer.isActive && (grounded || this.coyote.isActive) && this.jumpCooldownTicks === 0
    );
  }

  /**
   * Assemble the world snapshot the pure state machine consumes.
   *
   * @param probe - This tick's ground probe result.
   * @param intent - The player's intent.
   * @param jumpWindowOpen - Whether a buffered jump is available.
   * @returns The context for `resolveLocomotionState`.
   */
  private buildContext(
    probe: GroundProbeResult,
    intent: CharacterIntent,
    jumpWindowOpen: boolean,
  ): LocomotionContext {
    // A mantle is not sought while a jump is pending: the player pressing jump wants to jump,
    // not to be captured by a ledge.
    const mantleLedgeHeight = jumpWindowOpen ? 0 : this.detectMantleLedge(intent);

    return {
      grounded: probe.grounded,
      slopeBand: probe.band,
      verticalVelocity: this.velocity.y,
      // Wired in later milestones: authored climb surfaces (2.3) and water volumes (2.2).
      ledgeAvailable: false,
      climbSurfaceAvailable: false,
      mantleLedgeHeight,
      inWater: false,
      zipLineAvailable: false,
      jumpRequested: jumpWindowOpen,
      mantleComplete:
        this.state === LocomotionState.Mantle && this.mantleElapsed >= this.mantleDuration,
      hangingInputReleased: false,
      horizontalSpeed: this.horizontalSpeed,
    };
  }

  /**
   * Resolve and commit the locomotion state, running the mantle's entry and exit bookkeeping.
   *
   * @param context - The world snapshot.
   * @param intent - The player's intent.
   */
  private advanceState(context: LocomotionContext, intent: CharacterIntent): void {
    this.previousState = this.state;
    const nextState = resolveLocomotionState(this.state, context, intent);

    if (nextState === LocomotionState.Mantle && this.state !== LocomotionState.Mantle) {
      this.beginMantle(context.mantleLedgeHeight);
    } else if (this.state === LocomotionState.Mantle && nextState !== LocomotionState.Mantle) {
      // A mantle that ends by any route must reset its clock, or the next mantle would begin
      // already complete.
      this.mantleElapsed = 0;
      this.events.mantleFinished = true;
    }

    this.state = nextState;
  }

  /**
   * Remove the into-surface component of the velocity the character inherited.
   *
   * Only the horizontal components are taken from the projection: the vertical component is
   * where gravity and jumps live, and projecting it would cancel both.
   *
   * @param probe - This tick's ground probe result, which supplies the surface normal.
   */
  private projectInheritedVelocity(probe: GroundProbeResult): void {
    if (!probe.grounded || this.state === LocomotionState.Mantle) return;

    const projected = projectVelocityOntoSurface(this.velocity, probe.normal);
    this.velocity.x = projected.x;
    this.velocity.z = projected.z;
  }

  /**
   * Integrate the velocity for whichever state is now active.
   *
   * @param dt - Timestep in seconds.
   * @param intent - The player's intent.
   * @param probe - This tick's ground probe result.
   * @param mantleLedgeHeight - The ledge height, when mantling.
   */
  private integrateForState(
    dt: number,
    intent: CharacterIntent,
    probe: GroundProbeResult,
    mantleLedgeHeight: number,
  ): void {
    switch (this.state) {
      case LocomotionState.Grounded:
        this.integrateGrounded(dt, intent, probe.band);
        break;
      case LocomotionState.Mantle:
        this.integrateMantle(mantleLedgeHeight);
        break;
      case LocomotionState.Airborne:
      default:
        this.integrateAirborne(dt, intent);
        break;
    }

    // A steep ground band overrides ordinary locomotion with a slide.
    if (this.state === LocomotionState.Grounded && !hasGroundFriction(probe.band)) {
      this.applySlide(probe.band, probe.normal);
    }
  }

  /**
   * Move and collide — the single Rapier call — and apply the post-move bookkeeping.
   *
   * @param dt - Timestep in seconds.
   * @param wasGrounded - Whether the probe found support before the move.
   */
  private applyMovement(dt: number, wasGrounded: boolean): void {
    // The platform's motion is added to the requested movement so the character rides it. It
    // is deliberately NOT folded into `velocity`: a player standing still on a moving platform
    // has no horizontal *velocity*, and adding one would make them slide off when it stops.
    const result = this.character.moveAndSlide({
      x: (this.velocity.x + this.platformVelocity.x) * dt,
      y: (this.velocity.y + this.platformVelocity.y) * dt,
      z: (this.velocity.z + this.platformVelocity.z) * dt,
    });

    this.resolveVerticalCollision(result, dt);

    if (!wasGrounded && result.grounded) {
      this.events.landedAtSpeed = Math.abs(this.velocity.y);
      this.velocity.y = 0;
      // Landing deliberately does NOT arm coyote time: the player is on the ground now, and
      // the window exists for the moment after leaving it.
      this.coyote.clear();
    }

    if (this.state === LocomotionState.Mantle) {
      this.mantleElapsed += dt;
    }

    this.updateStuckWatchdog();
    this.enforceKillPlane();

    // Windows advance LAST, after every consumer has read them this tick.
    this.coyote.advance();
    this.jumpBuffer.advance();
  }

  /**
   * Kill upward velocity when the move was blocked, which means a ceiling was hit.
   *
   * Without this the velocity keeps accumulating into the obstruction and then fires the
   * player sideways when they clear it.
   *
   * @param result - The move result from the character controller.
   * @param dt - Timestep in seconds.
   */
  private resolveVerticalCollision(result: CharacterMoveResult, dt: number): void {
    const requestedUpward = Math.max(0, this.velocity.y * dt);
    if (requestedUpward > 1e-6 && result.movement.y < requestedUpward * 0.5) {
      this.velocity.y = 0;
    }
  }

  /**
   * Derive the ground surface's velocity from how far it moved since the previous tick, and
   * carry the character with it.
   *
   * @param grounded - Whether the character is on the ground this tick.
   * @param handle - The collider under the centre probe ray, or -1.
   */
  private updatePlatformVelocity(grounded: boolean, handle: number): void {
    this.platformVelocity.x = 0;
    this.platformVelocity.y = 0;
    this.platformVelocity.z = 0;

    if (!grounded || handle < 0) {
      // Airborne, or standing on nothing identifiable: there is no surface to inherit from.
      // Clearing here rather than merely skipping is what stops a stale platform velocity
      // from being inherited by a jump taken after leaving the platform.
      this.lastGroundCollider = -1;
      this.lastGroundPosition = null;
      return;
    }

    const current = this.physics.colliderTranslation(handle);

    // Only compare against the previous position when it is the SAME collider. Otherwise
    // stepping from one platform to an adjacent one would register a large phantom velocity
    // equal to the distance between them, and fling the player across the level.
    if (current && this.lastGroundCollider === handle && this.lastGroundPosition) {
      const deltaX = (current.x - this.lastGroundPosition.x) * TICK_RATE;
      const deltaY = (current.y - this.lastGroundPosition.y) * TICK_RATE;
      const deltaZ = (current.z - this.lastGroundPosition.z) * TICK_RATE;
      const speed = Math.hypot(deltaX, deltaY, deltaZ);

      // ── A teleported surface must not become a catapult ─────────────────────────
      // The derived velocity is a difference of two positions, so a collider that is
      // *teleported* rather than moved registers a speed of (distance x tick rate) — moving a
      // platform 200 m in one tick reads as 12,000 m/s and would fire the player into orbit.
      //
      // Platforms that are reset, respawned, or snapped to a loop point would do exactly this.
      // Treating an implausible delta as "the surface was not really moving" is the honest
      // resolution: a genuine platform cannot cross the level in one tick, so a delta that
      // large cannot be a platform's motion.
      const MAX_PLATFORM_SPEED_MPS = 30;
      if (speed <= MAX_PLATFORM_SPEED_MPS) {
        this.platformVelocity.x = deltaX;
        this.platformVelocity.y = deltaY;
        this.platformVelocity.z = deltaZ;
      }
    }

    this.lastGroundCollider = handle;
    this.lastGroundPosition = current
      ? { x: current.x, y: current.y, z: current.z }
      : null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // JUMP
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Apply a jump, with the launch velocity derived from the GDD's target distances.
   *
   * Both the peak height *and* the horizontal launch speed scale with the momentum the
   * player had built up. That is what makes a running jump go both higher (2.5 m vs 2.0 m)
   * and further (6.0 m vs 3.0 m) than a standing one, exactly as the GDD specifies — and
   * it is why both figures come out of `solveJumpArc` rather than being hand-set.
   *
   * @param intent - The resolved intent, supplying jump-hold state and direction.
   */
  private applyJump(intent: CharacterIntent, dt: number): void {
    const speedBeforeJump = Math.hypot(this.velocity.x, this.velocity.z);
    const momentum = Math.min(1, speedBeforeJump / RUN_SPEED_MPS);

    // Peak height interpolates between the standing and running figures, so a jump taken at
    // half speed earns half the extra height.
    const peakHeight =
      JUMP_HEIGHT_STANDING_M + (JUMP_HEIGHT_RUNNING_M - JUMP_HEIGHT_STANDING_M) * momentum;

    // Distance target interpolates the same way: 3.0 m from a standstill, 6.0 m at full run.
    const horizontalDistance =
      JUMP_STANDING_DISTANCE_M +
      (JUMP_RUNNING_DISTANCE_M - JUMP_STANDING_DISTANCE_M) * momentum;

    // Solves the arc against the gravity that will ACTUALLY be applied, including the
    // hold scaling. Solving against the nominal gravity instead is the bug documented in
    // `effectiveRiseGravity`: a held jump then peaks at 2.67 m instead of 2.0 m and
    // overshoots its distance by 26%.
    const launch = solveJumpLaunch({
      peakHeight,
      horizontalDistance,
      gravityRise: GRAVITY_RISING_MPS2,
      gravityFall: GRAVITY_FALLING_MPS2,
      holdGravityScale: JUMP_HOLD_GRAVITY_SCALE,
      held: intent.jumpHeld,
      dt,
    });

    this.velocity.y = launch.verticalVelocity;

    // ── Direction: rotate the existing velocity, never replace it ──────────────────
    // The first implementation assigned `dir * launchSpeed` outright. Direction came from
    // raw input (camera frame) while the velocity being replaced had been built along the
    // character's facing, and the turn rate had not yet caught up — so the two were up to
    // 24° apart and the difference was silently discarded. A running jump then measured
    // 20 m because the character was airborne for the whole test and never landed.
    //
    // Rotating instead of replacing preserves the momentum the player built up. The launch
    // speed only ever raises the magnitude, which is what "a jump preserves momentum" means.
    //
    // Note that the platform's own velocity is added separately, after this block, so a
    // player standing still on a fast platform still gets the full carried momentum even
    // though their own horizontal speed is zero.
    const inputLength = Math.hypot(intent.moveDirection.x, intent.moveDirection.z);
    const hasInput = inputLength > 1e-6;
    const dirX = hasInput ? intent.moveDirection.x / inputLength : Math.sin(this.facing);
    const dirZ = hasInput ? intent.moveDirection.z / inputLength : Math.cos(this.facing);

    const currentSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (currentSpeed > 1e-6) {
      const currentDirX = this.velocity.x / currentSpeed;
      const currentDirZ = this.velocity.z / currentSpeed;

      // A quarter-weight steer toward the requested direction: enough to correct aim,
      // never enough to erase a committed run-up in a single tick.
      const steerWeight = 0.25;
      const blendedX = currentDirX * (1 - steerWeight) + dirX * steerWeight;
      const blendedZ = currentDirZ * (1 - steerWeight) + dirZ * steerWeight;
      const blendedLength = Math.hypot(blendedX, blendedZ);

      if (blendedLength > 1e-6) {
        this.velocity.x = (blendedX / blendedLength) * launch.horizontalSpeed;
        this.velocity.z = (blendedZ / blendedLength) * launch.horizontalSpeed;
      } else {
        // Exact reversal: the two directions cancelled, so fall back to the input.
        this.velocity.x = dirX * launch.horizontalSpeed;
        this.velocity.z = dirZ * launch.horizontalSpeed;
      }
    } else {
      this.velocity.x = dirX * launch.horizontalSpeed;
      this.velocity.z = dirZ * launch.horizontalSpeed;
    }

    // ── Platform momentum inheritance (edge case 4) ─────────────────────────────
    // Added AFTER the launch velocity is resolved, for two reasons: the derived horizontal
    // speed still lands on its target *relative to the platform*, and a jump from static
    // ground is completely unaffected because the platform velocity is zero there.
    //
    // Without this, a player standing still on a moving platform would jump straight up and
    // watch the platform leave without them — the classic "moving platforms feel broken" bug.
    //
    // ── THIS PATCH SILENTLY FAILED TO APPLY THE FIRST TIME ──────────────────────────────
    // The edit that was supposed to insert these lines matched nothing (the search string had
    // the wrong indentation) and, because the edit was unasserted, it reported success anyway.
    // The only reason it was caught is that the test asserted an *observable* outcome — the
    // character's position — rather than trusting that the feature existed. A reminder that a
    // test which measures behaviour is worth more than any amount of careful reading, and that
    // scripted edits must assert that they matched.
    this.velocity.x += this.platformVelocity.x;
    this.velocity.z += this.platformVelocity.z;

    this.jumpCooldownTicks = Math.round(JUMP_COOLDOWN_S * TICK_RATE);
    this.coyote.clear();
    this.jumpBuffer.clear();
    this.jumpHeldLastTick = intent.jumpHeld;
    this.events.jumped = true;
  }

  /**
   * Consume an available jump if the active state permits one.
   *
   * @param intent - Player intent.
   * @param dt - Timestep in seconds.
   * @returns True when a jump was applied.
   */
  private tryConsumeJump(intent: CharacterIntent, dt: number): boolean {
    if (this.jumpCooldownTicks > 0) return false;
    if (!this.jumpBuffer.isActive) return false;

    // ── Edge case 1: CROUCH WINS ────────────────────────────────────────────────
    // With crouch and jump pressed on the same tick, crouch takes priority and no jump
    // happens. This is the rule that stops a player crouch-walking along a ledge from
    // launching themselves into a ravine on a stray button graze — the single most annoying
    // possible controller behaviour, and the reason this case is enumerated in the brief.
    //
    // The buffered jump is deliberately NOT cleared: the player is holding crouch, and if
    // they release it within the buffer window the jump should still fire. Clearing it would
    // punish an ambiguous input rather than resolving it.
    if (intent.crouchHeld && this.state === LocomotionState.Grounded) {
      return false;
    }

    // The buffered/coyote jump window, which is what these mechanisms exist to permit.
    const windowOpen = this.lastProbe.grounded || this.coyote.isActive;
    if (!windowOpen) return false;

    if (!canJump(this.state, this.lastProbe.band)) {
      if (this.state === LocomotionState.Grounded) {
        // GDD §4.5 forbids jumping on the 30–45° band. The player gets an explicit signal
        // rather than silence, because unexplained non-response reads as a bug.
        this.events.jumpRejectedOnSlope = true;
      }
      return false;
    }

    this.applyJump(intent, dt);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PER-STATE INTEGRATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Integrate velocity while on the ground.
   *
   * @param dt - Timestep in seconds.
   * @param intent - Player intent.
   * @param band - The ground's slope band, which sets the speed ceiling.
   */
  private integrateGrounded(dt: number, intent: CharacterIntent, band: SlopeBand): void {
    // Target speed from the movement magnitude. A magnitude of 1 means run; anything less
    // interpolates down toward walk speed, so an analogue stick has a full range rather
    // than a binary walk/run switch.
    const baseTarget =
      intent.moveMagnitude >= 0.99
        ? RUN_SPEED_MPS
        : WALK_SPEED_MPS + (RUN_SPEED_MPS - WALK_SPEED_MPS) * Math.min(1, intent.moveMagnitude);

    // Steep-but-walkable ground reduces the ceiling rather than adding friction, so the
    // character decelerates smoothly into a slope instead of hitting a speed wall. Crouching
    // scales it down further, so the crouch is a movement mode rather than only a jump lock.
    let targetSpeed = baseTarget * (band === SlopeBand.Slow ? SLOPE_SLOW_SPEED_SCALE : 1);
    if (intent.crouchHeld) targetSpeed *= CROUCH_SPEED_SCALE;

    const inputLength = Math.hypot(intent.moveDirection.x, intent.moveDirection.z);
    const hasDirection = inputLength > 1e-6;

    if (hasDirection) {
      const dirX = intent.moveDirection.x / inputLength;
      const dirZ = intent.moveDirection.z / inputLength;

      // Turn toward the desired direction at a bounded rate so a change of direction
      // carries momentum instead of snapping.
      this.facing = approachAngle(
        this.facing,
        Math.atan2(dirX, dirZ),
        ((TURN_RATE_GROUND_DEG * Math.PI) / 180) * dt,
      );

      // Move along the FACING rather than directly along the input. This is the single
      // biggest contributor to the character feeling like it has mass: a sharp turn
      // produces an arc, not an instant sideways slide.
      const alongFacing = { x: Math.sin(this.facing), z: Math.cos(this.facing) };
      const currentSpeed = Math.hypot(this.velocity.x, this.velocity.z);
      const delta = speedDeltaForTransition(currentSpeed, targetSpeed, ACCELERATION_TIME_S, dt);
      const newSpeed = approachSpeed(currentSpeed, targetSpeed, delta);

      this.velocity.x = alongFacing.x * newSpeed;
      this.velocity.z = alongFacing.z * newSpeed;
    } else {
      const currentSpeed = Math.hypot(this.velocity.x, this.velocity.z);
      const delta = speedDeltaForTransition(currentSpeed, 0, DECELERATION_TIME_S, dt);
      const newSpeed = approachSpeed(currentSpeed, 0, delta);

      if (currentSpeed > 1e-6) {
        const scale = newSpeed / currentSpeed;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      } else {
        this.velocity.x = 0;
        this.velocity.z = 0;
      }
    }

    this.tryConsumeJump(intent, dt);
  }

  /**
   * Integrate velocity while airborne.
   *
   * @param dt - Timestep in seconds.
   * @param intent - Player intent.
   */
  private integrateAirborne(dt: number, intent: CharacterIntent): void {
    const rising = this.velocity.y > 0;

    // Asymmetric gravity, softened while the jump is held — see `effectiveRiseGravity` for
    // why the same function is used to solve the arc and to integrate it.
    const gravity = rising
      ? effectiveRiseGravity(GRAVITY_RISING_MPS2, JUMP_HOLD_GRAVITY_SCALE, intent.jumpHeld)
      : GRAVITY_FALLING_MPS2;

    // Variable jump height: releasing the control cuts the remaining upward velocity.
    //
    // EDGE-triggered, not level-triggered. The first implementation applied this every tick
    // the control was unheld while rising, which compounds: at 45% per tick, twelve ticks of
    // rising became a 0.55^12 = 0.08 multiplier — a 92% cut rather than a 45% one, and a
    // result that depended on how many ticks the rise happened to last. Cutting once, on the
    // release edge, makes the reduction exactly the configured fraction.
    if (rising && !intent.jumpHeld && this.jumpHeldLastTick) {
      this.velocity.y *= 1 - JUMP_RELEASE_CUT;
    }
    this.jumpHeldLastTick = intent.jumpHeld;

    this.velocity.y -= gravity * dt;

    // Clamp to terminal velocity so a long fall cannot tunnel geometry, and cannot reach a
    // speed from which no landing state is recoverable.
    if (this.velocity.y < -TERMINAL_VELOCITY_MPS) {
      this.velocity.y = -TERMINAL_VELOCITY_MPS;
    }

    // Air control: enough to adjust a jump, not enough to redirect one. Applied to the
    // acceleration rather than to top speed, so a committed jump keeps its trajectory.
    const inputLength = Math.hypot(intent.moveDirection.x, intent.moveDirection.z);
    if (inputLength > 1e-6) {
      const dirX = intent.moveDirection.x / inputLength;
      const dirZ = intent.moveDirection.z / inputLength;

      this.facing = approachAngle(
        this.facing,
        Math.atan2(dirX, dirZ),
        ((TURN_RATE_AIR_DEG * Math.PI) / 180) * dt,
      );

      const alongFacing = { x: Math.sin(this.facing), z: Math.cos(this.facing) };
      const currentSpeed = Math.hypot(this.velocity.x, this.velocity.z);

      if (currentSpeed >= RUN_SPEED_MPS) {
        // ─── BUG FOUND BY MEASUREMENT: AIR CONTROL WAS SCRUBBING THE JUMP BOOST ──────
        // The jump launches at a derived speed *above* run speed (7.05 m/s at full
        // momentum, versus a 6.0 m/s run). Air control originally approached a target of
        // RUN_SPEED_MPS unconditionally, so it actively *decelerated* every running jump
        // from 7.05 back down to 6.0 during flight — which cut a 6 m jump to 5.04 m and
        // made the boost almost entirely self-cancelling.
        //
        // Air control exists to let the player adjust direction, not to impose a speed
        // ceiling on a body that is already faster than running. Steering still applies;
        // the magnitude is left alone.
        this.velocity.x = alongFacing.x * currentSpeed;
        this.velocity.z = alongFacing.z * currentSpeed;
      } else {
        const delta =
          speedDeltaForTransition(0, RUN_SPEED_MPS, ACCELERATION_TIME_S, dt) * AIR_CONTROL_FACTOR;
        const newSpeed = approachSpeed(currentSpeed, RUN_SPEED_MPS, delta);

        this.velocity.x = alongFacing.x * newSpeed;
        this.velocity.z = alongFacing.z * newSpeed;
      }
    }

    // Coyote time and the jump buffer are consumed here, in the airborne branch, because
    // this is exactly the situation both mechanisms exist to forgive: the player *believes*
    // they are on the ground.
    this.tryConsumeJump(intent, dt);
  }

  /**
   * Integrate velocity during a mantle.
   *
   * The mantle is a committed motion the player cannot steer, but can always cancel via a
   * jump (edge case 6) — see the `Mantle` branch of the state machine.
   *
   * @param ledgeHeight - Height of the ledge being climbed, in metres.
   */
  private integrateMantle(ledgeHeight: number): void {
    const progress = Math.min(1, this.mantleElapsed / this.mantleDuration);

    // Ease-out: fast at the start, settling as it finishes. Reads as heaving yourself up
    // rather than being lifted at a constant rate.
    const eased = 1 - (1 - progress) * (1 - progress);

    this.velocity.y = Math.max(0, (ledgeHeight / this.mantleDuration) * (1 - eased));

    // Forward drift carries the character onto the ledge rather than up its face, so the
    // mantle does not end with the player still pressed against the wall.
    const forwardSpeed = MANTLE_FORWARD_DRIFT_MPS * (1 - eased);
    this.velocity.x = Math.sin(this.facing) * forwardSpeed;
    this.velocity.z = Math.cos(this.facing) * forwardSpeed;
  }

  /**
   * Apply a downhill slide on a steep ground band.
   *
   * @param band - The ground's slope band.
   * @param normal - Ground normal, which defines the downhill direction.
   */
  private applySlide(band: SlopeBand, normal: { x: number; y: number; z: number }): void {
    const steepness = band === SlopeBand.Unclimbable ? 1 : 0.6;

    // The downhill direction is gravity's projection onto the slope: the horizontal
    // component of the surface normal, normalised.
    const horizontalLength = Math.hypot(normal.x, normal.z);
    if (horizontalLength < 1e-4) {
      // A perfectly vertical wall has no downhill direction, so there is nothing to slide
      // along and any slide velocity would be arbitrary.
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }

    const targetSpeed = SLOPE_SLIDE_SPEED_MPS * steepness;
    this.velocity.x = (normal.x / horizontalLength) * targetSpeed;
    this.velocity.z = (normal.z / horizontalLength) * targetSpeed;
    // A small downward push keeps the capsule attached to the slope instead of skipping
    // down it in discrete hops.
    this.velocity.y = -1.0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MANTLE DETECTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Look for a mantleable ledge directly in front of the character.
   *
   * A ledge is mantleable when there is a tall obstruction ahead *and* clear space on top
   * of it. Both halves are required: checking only for the obstruction would make the
   * character mantle into the middle of a flat wall face.
   *
   * @param intent - Player intent, which gates the check behind forward input.
   * @returns The ledge height above the player's feet, or 0 when none is found.
   */
  private detectMantleLedge(intent: CharacterIntent): number {
    // Mantling must be an action, not something that happens because the player walked
    // near a wall. Requiring forward intent is what keeps it from feeling like the
    // character has a mind of its own.
    if (intent.moveMagnitude <= 0.1) return 0;

    const facingX = Math.sin(this.facing);
    const facingZ = Math.cos(this.facing);
    const position = this.position;
    const maxLedgeHeight = MANTLE_HIGH_MAX_M;

    for (let distance = 0.35; distance <= 0.9; distance += 0.2) {
      const sampleX = position.x + facingX * distance;
      const sampleZ = position.z + facingZ * distance;

      // Probe downward from above the highest reachable ledge. A hit shallower than the
      // maximum reach means there is a top surface to climb onto.
      const downHit = this.physics.castRay(
        { x: sampleX, y: position.y + maxLedgeHeight + 0.2, z: sampleZ },
        { x: 0, y: -1, z: 0 },
        maxLedgeHeight + 0.4,
        [CollisionLayer.StaticWorld],
      );
      if (!downHit) continue;

      const ledgeHeight = downHit.point.y - position.y;
      if (ledgeHeight <= AUTOSTEP_MAX_M || ledgeHeight > maxLedgeHeight) continue;

      // Clearance check: nothing may occupy the space the character will stand in.
      const blocked = this.physics.sphereOverlaps(
        { x: sampleX, y: position.y + ledgeHeight + 0.7, z: sampleZ },
        0.3,
        [CollisionLayer.StaticWorld],
      );
      if (blocked) continue;

      // Confirm a real obstruction in front, so a ledge that is merely beside the player
      // (and approachable sideways) is not mistaken for one directly ahead.
      const wallHit = this.physics.castRay(
        { x: position.x, y: position.y + 0.2, z: position.z },
        { x: facingX, y: 0, z: facingZ },
        1.3,
        [CollisionLayer.StaticWorld],
      );
      if (!wallHit) continue;

      return ledgeHeight;
    }

    return 0;
  }

  /**
   * Begin a mantle.
   *
   * @param ledgeHeight - Height of the ledge, which sets the duration.
   */
  private beginMantle(ledgeHeight: number): void {
    this.mantleElapsed = 0;

    // A taller ledge takes proportionally longer, bounded so a 1.2 m mantle does not stall
    // the player. The floor exists so a barely-mantleable 0.5 m ledge is still a distinct
    // animation rather than an instant teleport.
    const proportional = MANTLE_LOW_DURATION_S * (ledgeHeight / MANTLE_LOW_MAX_M);
    this.mantleDuration = Math.min(MANTLE_LOW_DURATION_S, Math.max(0.25, proportional));

    this.events.mantleStarted = true;
    this.coyote.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SAFETY NETS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Whether every component of the character's position is finite.
   *
   * A NaN position is unrecoverable: every subsequent collision query fails, so the
   * character can neither move nor land and simply vanishes from the world. The only cure
   * is a teleport, which is why this is checked before anything else, every tick.
   *
   * @returns True when the position is usable.
   */
  private isPositionFinite(): boolean {
    const position = this.position;
    return (
      Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)
    );
  }

  /**
   * Recover the character and record why.
   *
   * @param reason - A short human-readable cause, surfaced by the debug overlay so a
   *   recurring rescue is diagnosable rather than merely survivable.
   */
  private rescue(reason: string): void {
    this.rescueCount++;
    this.rescueReason = reason;
    this.events.rescued = true;

    // Logged once per rescue rather than per tick: a persistent fault would otherwise
    // produce an unbounded stream of identical messages and hide everything else.
    console.warn(`[JungleRelic] Character rescued (${reason}); resetting. Total: ${this.rescueCount}`);

    this.respawn();
  }

  /**
   * Respawn the player if they have fallen out of the world.
   *
   * Edge case 5: a fall from extreme height is a *safe respawn*, never a death. Falling out
   * of the level through a geometry gap must never be fatal, because the player has no way
   * to tell that apart from their own mistake.
   */
  private enforceKillPlane(): void {
    if (this.position.y > KILL_PLANE_Y) return;
    this.rescue('fell below the kill plane');
  }

  /**
   * Watchdog for the player being stuck in a precarious state with no progress.
   *
   * The character-controller half of the anti-stuck strategy from risk R6. It cannot fire
   * during normal play: the timer only advances in states that depend on the player's grip,
   * and resets the moment anything moves.
   */
  private updateStuckWatchdog(): void {
    const isPrecarious =
      this.state === LocomotionState.LedgeHang || this.state === LocomotionState.Climb;

    if (!isPrecarious || this.horizontalSpeed > 0.05) {
      this.stuckTicks = 0;
      return;
    }

    this.stuckTicks++;
    // Thirty seconds of holding a ledge without moving is not a playstyle; it is a bug or
    // an abandoned input.
    if (this.stuckTicks > TICK_RATE * 30) {
      this.stuckTicks = 0;
      this.rescue('stuck in a precarious state');
    }
  }

  /**
   * Return the player to the spawn point, clearing all momentum and state.
   *
   * Deliberately does not touch health or inventory: this is a positional recovery, not a
   * death. A player who fell through the world should lose nothing but their position.
   */
  public respawn(): void {
    this.character.teleport(this.spawnPoint);
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.velocity.z = 0;
    this.state = LocomotionState.Airborne;
    this.mantleElapsed = 0;
    this.stuckTicks = 0;
    this.coyote.clear();
    this.jumpBuffer.clear();
  }

  /**
   * Replace the character's spawn anchor, for checkpoints.
   *
   * @param point - The new spawn position.
   * @throws If the point is not finite, because a bad checkpoint would otherwise be
   *   indistinguishable from a character bug and would be replayed on every respawn.
   */
  public setSpawnPoint(point: Vec3Like): void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
      throw new Error('setSpawnPoint requires a finite position.');
    }
    this.spawnPoint.x = point.x;
    this.spawnPoint.y = point.y;
    this.spawnPoint.z = point.z;
  }

  /**
   * Deflect the character off another character rather than letting them stand on it.
   *
   * Phase 0 (E12/Q3) proved that Rapier will rest one kinematic capsule on another, stably
   * and indefinitely, in *both* directions — so an enemy can stand on the player's head.
   * The engine permits it, so the rule has to be enforced here.
   *
   * @param otherPosition - The other character's position.
   */
  public deflectOffCharacter(otherPosition: Vec3Like): void {
    const position = this.position;
    const deltaX = position.x - otherPosition.x;
    const deltaZ = position.z - otherPosition.z;
    const length = Math.hypot(deltaX, deltaZ);

    // Degenerate case: perfectly coincident positions leave no direction to deflect along.
    // An arbitrary but *stable* direction avoids a divide by zero and a random jitter.
    const dirX = length > 1e-4 ? deltaX / length : 1;
    const dirZ = length > 1e-4 ? deltaZ / length : 0;

    this.velocity.x += dirX * 2.0;
    this.velocity.z += dirZ * 2.0;
    this.velocity.y = Math.max(this.velocity.y, 1.5);
    this.events.bouncedOffCharacter = true;
  }

  /**
   * Force the character's body position, bypassing physics.
   *
   * ─── WHY A PRODUCTION CLASS EXPOSES A TEST HOOK ─────────────────────────────────────
   * A non-finite position is the one controller failure that cannot be triggered through the
   * public interface, because every path that could produce one is (deliberately) guarded.
   * The NaN recovery path would therefore be untestable, and untested safety nets are
   * decoration — they are written precisely for the cases nobody can reach on purpose.
   *
   * The name is explicit rather than generic so it cannot be mistaken for gameplay API, and
   * it is the only test hook on this class.
   *
   * @param position - The position to force. May be non-finite, which is the point.
   */
  public injectPositionForTest(position: Vec3Like): void {
    this.character.teleport(position);
  }

  /**
   * Reset the per-tick event record.
   *
   * Mutates one pre-allocated object rather than constructing a new one, because this runs
   * sixty times a second and allocation churn is the mechanism behind the frame-time
   * hitches described in risk R1.
   */
  private clearEvents(): void {
    this.events.jumped = false;
    this.events.landedAtSpeed = 0;
    this.events.walkedOffLedge = false;
    this.events.mantleStarted = false;
    this.events.mantleFinished = false;
    this.events.jumpRejectedOnSlope = false;
    this.events.rejectedGrab = false;
    this.events.rescued = false;
    this.events.bouncedOffCharacter = false;
  }
}
