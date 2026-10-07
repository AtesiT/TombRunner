/**
 * The 5-ray ground probe (GDD §4.4).
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY RAYCASTS RATHER THAN `computedGrounded()`
 * ────────────────────────────────────────────────────────────────────────────────
 * The character controller's own `computedGrounded()` is necessary but not sufficient. It
 * cannot tell us the slope angle, the surface type, or how close the player is to the edge
 * of a ledge — and Phase 0 proved it can even report `grounded = true` while a corrupted
 * capsule is in free-fall (DEV_LOG Q2).
 *
 * A cone of five rays supplies all of it: a majority vote for ground truth, an averaged
 * normal for slope handling and body orientation, a per-ray hit pattern for edge
 * proximity, and collider handles for surface-type lookups (footstep audio, dust, slide
 * behaviour).
 *
 * ─── LAYER DISCIPLINE ───────────────────────────────────────────────────────────────
 * The probe reads `StaticWorld` and `PropDynamic` only. Triggers and water volumes are
 * deliberately excluded: they are sensor geometry, and including them would let the player
 * "stand" on a checkpoint volume or on the surface of water. That is not a hypothetical —
 * it is the natural consequence of querying everything, and it is why the layer list is
 * explicit rather than omitted.
 */

import { CollisionLayer } from '../physics/Layers';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import {
  GROUND_PROBE_LENGTH_M,
  GROUND_PROBE_ORIGIN_Y_M,
  GROUND_PROBE_RADIUS_M,
  SLOPE_SLOW_MAX_DEG,
  SLOPE_SLIDE_MAX_DEG,
  SLOPE_WALK_MAX_DEG,
} from '../core/constants';
import { classifySlope, slopeAngleFromNormalY, SlopeBand } from '../core/math/locomotion';

/** The result of one ground probe. */
export interface GroundProbeResult {
  /** True when a majority of the rays found ground within reach. */
  grounded: boolean;
  /** Averaged unit surface normal of the hits. Defaults to straight up when airborne. */
  normal: { x: number; y: number; z: number };
  /** Slope angle in degrees, derived from the averaged normal. */
  slopeAngle: number;
  /** Behavioural band for that angle. */
  band: SlopeBand;
  /**
   * How close the player is to falling off an edge: 0 means every outer ray hit ground,
   * 1 means none did. Drives ledge detection and the "about to walk off" animation.
   */
  edgeProximity: number;
  /** Authored surface type under the centre ray, or null when airborne. */
  surfaceType: string | null;
  /**
   * Collider handle under the centre ray, or -1 when airborne.
   *
   * Exposed so the controller can identify the surface it is standing on and track that
   * surface's motion. Without it, a moving platform would slide out from under the player:
   * see the platform-carry implementation in `CharacterController.update`.
   */
  groundColliderHandle: number;
  /** Distance from the probe origin down to the centre hit, or null when airborne. */
  distanceToGround: number | null;
  /** How many of the five rays hit. Exposed for tests and the debug overlay. */
  hitCount: number;
}

/** Directions of the four outer probe rays, as offsets from the centre, in metres. */
const OUTER_RAY_OFFSETS: ReadonlyArray<{ x: number; z: number }> = [
  { x: GROUND_PROBE_RADIUS_M, z: 0 },
  { x: -GROUND_PROBE_RADIUS_M, z: 0 },
  { x: 0, z: GROUND_PROBE_RADIUS_M },
  { x: 0, z: -GROUND_PROBE_RADIUS_M },
];

/** Layers a ground probe may hit. Sensor geometry is excluded on purpose; see the header. */
const PROBE_LAYERS: readonly CollisionLayer[] = [
  CollisionLayer.StaticWorld,
  CollisionLayer.PropDynamic,
];

/**
 * Casts the five-ray cone and summarises the result.
 *
 * Stateless: it is constructed once and called once per tick. Holding no state means a
 * test can call it against any world in any order.
 */
export class GroundProbe {
  /**
   * @param physics - The primed physics world to query.
   */
  constructor(private readonly physics: PhysicsWorld) {}

  /**
   * Probe the ground beneath a position.
   *
   * @param position - The character's body origin (the capsule's centre).
   * @returns The summarised probe result. Never throws and never allocates per call
   *   beyond the result object.
   */
  public probe(position: { x: number; y: number; z: number }): GroundProbeResult {
    // Origin sits slightly above the body origin so the rays start inside the capsule rather
    // than at the exact contact point, where floating-point error could miss.
    const originY = position.y + GROUND_PROBE_ORIGIN_Y_M;

    const hits = this.castCone(position.x, position.z, originY);
    const grounded = hits.count >= MAJORITY_HITS;
    const normal = averageNormal(hits);

    // Edge proximity counts the FOUR outer rays only; the centre ray always hits when the
    // player is on solid ground, so including it would make the value never reach 1.
    const outerHits = hits.count - (hits.centre ? 1 : 0);
    const edgeProximity = hits.count > 0 ? 1 - outerHits / OUTER_RAY_OFFSETS.length : 0;

    const slopeAngle = slopeAngleFromNormalY(normal.y);

    return {
      grounded,
      normal,
      slopeAngle,
      band: classifySlope(slopeAngle, {
        walkableMax: SLOPE_WALK_MAX_DEG,
        slowMax: SLOPE_SLOW_MAX_DEG,
        slideMax: SLOPE_SLIDE_MAX_DEG,
      }),
      edgeProximity: Math.min(1, Math.max(0, edgeProximity)),
      surfaceType: hits.centreSurface,
      groundColliderHandle: hits.centreHandle,
      distanceToGround: hits.centreDistance,
      hitCount: hits.count,
    };
  }

  /**
   * Cast the five rays of the cone and accumulate their hits.
   *
   * The centre ray is tracked separately because only its hit defines the surface type and the
   * distance to ground. Averaging those across the cone would produce a value halfway between
   * the player's feet and the ground beside them, which is meaningless.
   *
   * @param x - World X of the body origin.
   * @param z - World Z of the body origin.
   * @param originY - World Y at which the rays start.
   * @returns The accumulated hit data. Never null; a miss is `count: 0`.
   */
  private castCone(x: number, z: number, originY: number): ConeHits {
    const hits: ConeHits = {
      count: 0,
      normalSum: { x: 0, y: 0, z: 0 },
      centre: false,
      centreDistance: null,
      centreSurface: null,
      centreHandle: -1,
    };

    const down = { x: 0, y: -1, z: 0 };

    // The centre ray goes first (i === -1), then the four outer ones.
    for (let i = -1; i < OUTER_RAY_OFFSETS.length; i++) {
      const isCentre = i === -1;
      const offset = isCentre ? { x: 0, z: 0 } : OUTER_RAY_OFFSETS[i];

      const hit = this.physics.castRay(
        { x: x + offset.x, y: originY, z: z + offset.z },
        down,
        GROUND_PROBE_LENGTH_M,
        PROBE_LAYERS,
      );
      if (!hit) continue;

      hits.count++;
      hits.normalSum.x += hit.normal.x;
      hits.normalSum.y += hit.normal.y;
      hits.normalSum.z += hit.normal.z;

      if (isCentre) {
        hits.centre = true;
        hits.centreDistance = hit.distance;
        hits.centreSurface = this.physics.surfaceTypeAt(hit.colliderHandle);
        hits.centreHandle = hit.colliderHandle;
      }
    }

    return hits;
  }
}

/** Raw accumulated data from one five-ray cone cast. */
interface ConeHits {
  count: number;
  normalSum: { x: number; y: number; z: number };
  centre: boolean;
  centreDistance: number | null;
  centreSurface: string | null;
  centreHandle: number;
}

/** A majority of five is three. */
const MAJORITY_HITS = 3;

/**
 * Average and normalise a set of summed surface normals.
 *
 * @param hits - The accumulated cone hits.
 * @returns A unit normal, or straight up when there were no hits or the normals cancelled.
 */
function averageNormal(hits: ConeHits): { x: number; y: number; z: number } {
  if (hits.count === 0) return { x: 0, y: 1, z: 0 };

  const { x, y, z } = hits.normalSum;
  const length = Math.hypot(x, y, z);

  // Opposing normals can cancel out entirely (probing a narrow crevice, for example). Falling
  // back to straight up keeps the slope classification sane rather than dividing by zero and
  // producing NaN, which would then propagate into the character's position.
  if (length <= 1e-6) return { x: 0, y: 1, z: 0 };

  return { x: x / length, y: y / length, z: z / length };
}
