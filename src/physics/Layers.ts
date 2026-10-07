/**
 * Collision layer definitions.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY CENTRALISED
 * ────────────────────────────────────────────────────────────────────────────────
 * Rapier encodes collision filtering as a pair of 16-bit masks (membership and filter)
 * packed into a single number, which makes ad-hoc bit twiddling at call sites both
 * unreadable and extremely easy to get subtly wrong. A mis-targeted bit does not throw;
 * it silently produces an object that collides with the wrong things, which surfaces
 * much later as an inexplicable gameplay bug.
 *
 * Every layer is declared here, every collider in the game is created through
 * {@link collisionGroupsFor}, and no other module is permitted to construct a group
 * integer. That makes an entire bug class unrepresentable.
 */

/**
 * Collision layer indices.
 *
 * Ordered roughly by "how solid" the layer is. Indices are permanent: they are packed
 * into serialised save data for puzzle bodies, so changing one invalidates saves.
 */
export enum CollisionLayer {
  /** Ground, walls, ruins, terrain. The only layer the camera collides against. */
  StaticWorld = 0,

  /** The player capsule. */
  Player = 1,

  /** Wolves, jaguars, cultists, the boss. */
  Enemy = 2,

  /** Debris, ragdolls, dropped items — pushed around, never blocking. */
  PropDynamic = 3,

  /** Pushable puzzle blocks and moving platforms. */
  PuzzleBlock = 4,

  /** Volumes, checkpoints, objective markers. Sensor only: never applies forces. */
  Trigger = 5,

  /**
   * Water volumes. Sensors; buoyancy is applied by our own code rather than by the
   * solver, because force-based buoyancy oscillates without heavy damping (E9's
   * lesson generalised).
   */
  WaterVolume = 6,

  /** Grenades and any other genuinely ballistic body. CCD is enabled for these. */
  Projectile = 7,

  /** Climbable geometry. Sensor only; the climb system reads it, collision ignores it. */
  ClimbSurface = 8,

  /**
   * Damageable volumes. Raycast targets that must never resolve contact forces —
   * otherwise a head hitbox would shove the player's capsule.
   */
  Hitbox = 9,
}

/**
 * The set of layers each layer collides with.
 *
 * Written as an explicit table rather than as symmetric rules, because the
 * relationships in this game are genuinely asymmetric: the camera collides with the
 * static world but the static world does not care about the camera; triggers detect
 * the player without the player being blocked by them.
 */
const COLLISION_TABLE: Readonly<Record<CollisionLayer, readonly CollisionLayer[]>> = {
  [CollisionLayer.StaticWorld]: [
    CollisionLayer.Player,
    CollisionLayer.Enemy,
    CollisionLayer.PropDynamic,
    CollisionLayer.PuzzleBlock,
    CollisionLayer.Projectile,
  ],

  // The player collides with the world, enemies, props and blocks, and *detects*
  // triggers, water and climb surfaces without being blocked by them.
  [CollisionLayer.Player]: [
    CollisionLayer.StaticWorld,
    CollisionLayer.Enemy,
    CollisionLayer.PropDynamic,
    CollisionLayer.PuzzleBlock,
    CollisionLayer.Trigger,
    CollisionLayer.WaterVolume,
    CollisionLayer.ClimbSurface,
  ],

  [CollisionLayer.Enemy]: [
    CollisionLayer.StaticWorld,
    CollisionLayer.Player,
    CollisionLayer.PropDynamic,
    CollisionLayer.PuzzleBlock,
    CollisionLayer.Trigger,
    CollisionLayer.WaterVolume,
    CollisionLayer.Projectile,
  ],

  [CollisionLayer.PropDynamic]: [
    CollisionLayer.StaticWorld,
    CollisionLayer.Player,
    CollisionLayer.Enemy,
    CollisionLayer.PropDynamic,
    CollisionLayer.PuzzleBlock,
    CollisionLayer.Projectile,
  ],

  [CollisionLayer.PuzzleBlock]: [
    CollisionLayer.StaticWorld,
    CollisionLayer.Player,
    CollisionLayer.Enemy,
    CollisionLayer.PropDynamic,
    CollisionLayer.PuzzleBlock,
    CollisionLayer.Trigger,
  ],

  // Triggers are sensors: they report overlap but never resolve contact.
  [CollisionLayer.Trigger]: [
    CollisionLayer.Player,
    CollisionLayer.Enemy,
    CollisionLayer.PuzzleBlock,
  ],

  [CollisionLayer.WaterVolume]: [
    CollisionLayer.Player,
    CollisionLayer.Enemy,
    CollisionLayer.PropDynamic,
  ],

  [CollisionLayer.Projectile]: [
    CollisionLayer.StaticWorld,
    CollisionLayer.Enemy,
    CollisionLayer.PropDynamic,
    CollisionLayer.PuzzleBlock,
  ],

  // Climb surfaces are queried by raycast only.
  [CollisionLayer.ClimbSurface]: [],

  // Hitboxes exist solely to be raycast against; they must never resolve forces, or a
  // head hitbox would push the player's capsule around.
  [CollisionLayer.Hitbox]: [],
};

/**
 * Pack a membership bitfield from a list of layers.
 *
 * @param layers - The layers an entity belongs to.
 * @returns A 16-bit membership mask.
 */
export function membershipMask(layers: readonly CollisionLayer[]): number {
  let mask = 0;
  for (const layer of layers) {
    mask |= 1 << layer;
  }
  return mask >>> 0;
}

/**
 * Pack a filter bitfield from a list of layers.
 *
 * @param layers - The layers an entity collides with.
 * @returns A 16-bit filter mask.
 */
export function filterMask(layers: readonly CollisionLayer[]): number {
  return membershipMask(layers);
}

/**
 * Compute the Rapier `collisionGroups` integer for a set of layers.
 *
 * Rapier packs the membership mask in the high 16 bits and the filter mask in the low
 * 16 bits. The filter is the union of everything the given layers should collide
 * with, plus the layers themselves (an entity must be able to collide with its own
 * layer unless the table says otherwise), computed from {@link COLLISION_TABLE}.
 *
 * @param layers - The layers an entity belongs to.
 * @returns The packed collision-groups value to pass to Rapier.
 */
export function collisionGroupsFor(layers: readonly CollisionLayer[]): number {
  const membership = membershipMask(layers);

  // Union of the collision table entries for every layer we belong to.
  const collidesWith = new Set<CollisionLayer>();
  for (const layer of layers) {
    for (const target of COLLISION_TABLE[layer]) {
      collidesWith.add(target);
    }
  }

  const filter = membershipMask([...collidesWith]);
  return ((membership << 16) | filter) >>> 0;
}

/**
 * Compute the `collisionGroups` integer for a **query** (raycast or shape query).
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY QUERIES NEED A DIFFERENT ENCODING FROM COLLIDERS  (found the hard way)
 * ────────────────────────────────────────────────────────────────────────────────
 * Rapier accepts a collider if and only if *both* halves of this test pass:
 *
 *     (query.membership & collider.filter) !== 0
 *     (collider.membership & query.filter) !== 0
 *
 * A collider's filter mask lists the layers it collides with, which for the static
 * world is {Player, Enemy, PropDynamic, PuzzleBlock, Projectile} — notably NOT
 * StaticWorld itself. So passing {@link collisionGroupsFor} for a query aimed at
 * StaticWorld produces membership = {StaticWorld}, and the first half of the test
 * evaluates to `{StaticWorld} & {Player, Enemy, ...}` = 0. The ray hits nothing, with
 * no error, no warning, and a result that looks exactly like "there is no ground here".
 *
 * That is precisely how this was discovered: the boot-time ground assertion in
 * `PhysicsWorld.primeAndVerify` failed against a level whose ground collider demonstrably
 * existed. Queries therefore claim membership in *every* layer — meaning "this query may
 * touch anything whose filter admits it" — and express their real intent through the
 * filter mask alone.
 *
 * @param layers - The layers the query should be able to hit.
 * @returns Packed collision groups for a query.
 */
export function queryGroupsFor(layers: readonly CollisionLayer[]): number {
  const QUERY_MEMBERSHIP_ALL = 0xffff;
  const filter = membershipMask(layers);
  return ((QUERY_MEMBERSHIP_ALL << 16) | filter) >>> 0;
}

/**
 * Compute collision groups that also collide with a specific extra layer.
 *
 * Used for one-off exceptions, such as a puzzle block that must additionally detect a
 * trigger volume that is not in the default table for its layer. Keeping this function
 * as the only escape hatch means exceptions stay greppable.
 *
 * @param layers - The layers an entity belongs to.
 * @param extra - An additional layer to include in the filter mask.
 * @returns The packed collision-groups value.
 */
export function collisionGroupsWith(
  layers: readonly CollisionLayer[],
  extra: CollisionLayer,
): number {
  const base = collisionGroupsFor(layers);
  const membership = base >>> 16;
  const filter = (base & 0xffff) | (1 << extra);
  return ((membership << 16) | filter) >>> 0;
}
