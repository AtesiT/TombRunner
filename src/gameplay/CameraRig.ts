/**
 * The third-person camera rig.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE OWNS, AND WHAT IT DELIBERATELY DOES NOT
 * ────────────────────────────────────────────────────────────────────────────────────
 * This file owns *state*: the yaw the player has turned the camera to, how long the boom
 * currently is, how long input has been quiet, how long the camera has been stuck. It owns the
 * imperative act of asking the physics world whether the line from the player's shoulder to the
 * camera is clear.
 *
 * Every *decision* lives in `src/core/math/camera.ts` as a pure function. Which mode is active,
 * how the boom resolves against an obstruction, how an angle damps, whether auto-rotation is
 * allowed, what the deadzone does — all of it is testable without a physics world, a renderer or
 * a DOM. What remains here is sequencing and state, which is why this file is thin and the maths
 * file is not.
 *
 * ─── WHY AN OVER-THE-SHOULDER RIG IS HARDER THAN IT LOOKS ───────────────────────────
 * A third-person camera has no local reference frame. Every individual piece is easy and the
 * failure modes are all interaction effects:
 *
 *   • The boom must shorten *fast enough* to avoid clipping and lengthen *slowly enough* not to
 *     nauseate, and those are different requirements on the same number.
 *   • Ground clamping moves the camera off the boom axis, which changes the framing, which fights
 *     the mode transition that is also moving the boom. So ground clamping has to reduce to a
 *     re-solve of the boom rather than a height adjustment.
 *   • Any camera that follows the player will eventually place itself inside geometry through no
 *     player action at all — a door closing, a platform rising, an enemy spawning. A camera with
 *     no escape hatch stays there, and the player's only recourse is to quit.
 *   • Auto-rotation helps when the player is idle and is infuriating when they are not, and the
 *     distinction is a *duration*, not a state.
 *
 * The milestone's edge cases are each realised below and each is marked with the failure it
 * prevents.
 */

import type { CharacterEvents, CharacterTickReport } from './CharacterController';
import { CollisionLayer } from '../physics/Layers';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import {
  advanceSpringArm,
  applyGroundClamp,
  CameraMode,
  clampPitch,
  dampFraming,
  dampRateFromPerFrameLerp,
  type CameraFraming,
  type CameraModeTriggers,
  framingForMode,
  NO_TRIGGERS,
  lookTarget as computeLookTarget,
  orbitDirection,
  orbitPosition,
  resolveCameraMode,
  rotateToward,
  shouldAutoRotate,
  shouldForceCameraReset,
  springArmTarget,
  waterWobble,
  type Vec3,
} from '../core/math/camera';
import {
  CAMERA_AIM_DISTANCE_M,
  CAMERA_AIM_FOV_DEG,
  CAMERA_AIM_SHOULDER_OFFSET_M,
  CAMERA_AUTO_ROTATE_DELAY_S,
  CAMERA_AUTO_ROTATE_SPEED_RAD,
  CAMERA_CLIMB_DISTANCE_M,
  CAMERA_CLIMB_PITCH_BIAS_DEG,
  CAMERA_DISTANCE_M,
  CAMERA_FOLLOW_LERP,
  CAMERA_FOV_DEG,
  CAMERA_GROUND_CLEARANCE_M,
  CAMERA_HEIGHT_M,
  CAMERA_LOOK_AHEAD_M,
  CAMERA_MANTLE_PULL_BACK_M,
  CAMERA_MANTLE_RAISE_M,
  CAMERA_MIN_DISTANCE_M,
  CAMERA_MODE_TRANSITION_RATE,
  CAMERA_PENETRATION_TIMEOUT_S,
  CAMERA_PITCH_MAX_DEG,
  CAMERA_PITCH_MIN_DEG,
  CAMERA_PROBE_RADIUS_M,
  CAMERA_PULL_IN_LERP,
  CAMERA_PUSH_OUT_LERP,
  CAMERA_RESET_LIFT_M,
  CAMERA_RESET_MIN_SCALE,
  CAMERA_RESET_S,
  CAMERA_SHOULDER_OFFSET_M,
  CAMERA_SKIN_M,
  CAMERA_STUCK_TIMEOUT_S,
  CAMERA_TELEPORT_SNAP_M,
  CAMERA_TUNNEL_DISTANCE_M,
  CAMERA_TUNNEL_FOV_DEG,
  CAMERA_WATER_WOBBLE_HZ,
  CAMERA_WATER_WOBBLE_RAD,
  CAMERA_ZIPLINE_DISTANCE_M,
  CAMERA_ZIPLINE_PITCH_BIAS_DEG,
  TICK_RATE,
} from '../core/constants';

/** Degrees to radians, local to avoid importing the whole angle library. */
const DEG = Math.PI / 180;

/**
 * How many time constants the forced reset is allowed to span.
 *
 * Damping reaches 95% of its destination after three time constants, so deriving the rate from
 * the duration this way means `CAMERA_RESET_S` means what a designer would expect it to mean:
 * the reset is essentially complete when it elapses.
 */
const RESET_TIME_CONSTANTS = 3;

/**
 * How far down the ground probe looks, in metres.
 *
 * Named rather than inlined because it is a *tuning* value with a real trade-off at both ends. Too
 * short and a camera high above a deep pit reports no ground at all, skipping the correction
 * entirely; too long and the probe can reach a floor the camera could never fall to, clamping it
 * against geometry that is nowhere near. 200 m is far beyond any drop in the level and still
 * bounded, so the query stays a single cheap ray.
 */
const GROUND_PROBE_REACH_M = 200;

/**
 * Bisection iterations for the ground re-solve.
 *
 * Eight halvings narrow the interval to 1/256 of the boom — sub-centimetre at any plausible boom
 * length, which is well below the screen-space threshold at which a player could perceive the
 * difference, and cheap enough that the cost is invisible in a profile.
 */
const GROUND_RESOLVE_ITERATIONS = 8;

/** What the player is asking the camera to do this tick. Already in radians. */
export interface CameraIntent {
  /** Yaw change requested by mouse/stick, in radians. Positive turns the view to the right. */
  yawDelta: number;
  /** Pitch change requested by mouse/stick, in radians. Positive looks up. */
  pitchDelta: number;
}

/** Read-only view of everything the rig decided this tick, for the overlay and the tests. */
export interface CameraState {
  mode: CameraMode;
  /** The pivot the rig orbits, world space, after the mode's height offset. */
  pivot: Vec3;
  /** Final camera position, world space, after every correction. */
  position: Vec3;
  /** Final yaw actually used for geometry, radians. */
  yaw: number;
  /** Final pitch actually used for geometry, radians, including the mode's bias. */
  pitch: number;
  /** The boom length actually in use, after obstruction and ground correction. */
  boom: number;
  fovDeg: number;
  /** True when the arm was shortened by an obstruction this tick. */
  obstructed: boolean;
  /** True when the absolute ground clamp had to move the camera vertically. */
  groundClamped: boolean;
  /** True while the forced reset is interpolating. */
  resetting: boolean;
  /** Seconds since the player last moved the camera deliberately. */
  idleSeconds: number;
}

/**
 * The camera rig. Owns orbit state and the spring arm; consults the physics world for occlusion.
 */
export class CameraRig {
  /** Player-owned orbit yaw. Auto-rotation eases this when the player is idle. */
  private yaw = 0;

  /** Player-owned orbit pitch, *before* the active mode's bias. */
  private pitch = 0;

  /**
   * The submerged wobble, kept as a separate offset rather than folded into {@link yaw}.
   *
   * This is the difference between an effect and a bug. Folding the wobble into the stored yaw
   * makes it *accumulate*: the camera drifts by whatever the oscillation happened to sum to while
   * the player was underwater, and surfaces pointing somewhere slightly random. As a separate
   * offset it is purely transient — surface, and it is gone.
   */
  private wobbleYaw = 0;
  private wobblePitch = 0;

  /** The boom length actually in use. Distinct from the framing's desired distance. */
  private boom = CAMERA_DISTANCE_M;

  /** The mode-resolved framing, damped rather than cut. This is what is rendered from. */
  private framing: CameraFraming;

  /** The framing the current mode asks for, before damping. Retained for reporting. */
  private resolvedFraming: CameraFraming;

  private mode: CameraMode = CameraMode.Default;

  /** Seconds since the player last moved the camera. Drives auto-rotation. */
  private idleSeconds = 0;

  /** Seconds the boom has been pinned at minimum distance, with an obstruction present. */
  private pinnedSeconds = 0;

  /** Seconds the camera has been inside geometry. Drives the earlier stuck condition. */
  private penetratingSeconds = 0;

  /**
   * Whether the forced escape is active.
   *
   * ─── WHY THIS IS A STATE AND NOT A TIMER ────────────────────────────────────────────
   * The first draft held a countdown and ended the escape when it reached zero, with `CAMERA_RESET_S`
   * as the duration. That is the GDD's number applied to the wrong thing: 0.4 s is how long the
   * arm takes to *collapse*, not how long the escape lasts. A countdown that expires while the
   * camera is still inside geometry does not rescue the player — it restores the normal minimum
   * distance, pushes the camera straight back into the wall it had just escaped, and starts the
   * whole cycle again, forever. The camera visibly juddered against the wall on a period of about
   * 2.5 s in the pocket test.
   *
   * So the escape ends when its *cause* is gone — the camera is no longer penetrating and the arm
   * is no longer pinned — which is self-terminating. If the geometry genuinely admits no valid
   * camera position, the escape stays active permanently, and that is correct: a permanently
   * close view of a playable character beats a camera that alternates between two bad states.
   */
  private escaping = false;

  /** Seconds spent in the current escape, used for the overlay and for the tests. */
  private escapeSeconds = 0;

  /** Seconds accumulated for the water wobble's phase, so it is frame-rate independent. */
  private wobblePhaseSeconds = 0;

  /** Whether the camera was submerged last tick, so the phase can be reset on surfacing. */
  private wasSubmerged = false;

  /** The pivot from the previous tick, used for the teleport backstop. */
  private previousPivot: Vec3 | null = null;

  private readonly followRate: number;
  private readonly pullInRate: number;
  private readonly pushOutRate: number;
  private readonly resetRate: number;

  /** Reused output object. Allocating one of these per tick is a GC stutter waiting to happen. */
  private readonly state: CameraState;

  /**
   * @param physics - The world to query for obstructions. Queries only; nothing is mutated.
   * @param probeRadius - Radius of the occlusion sphere. Defaults to the GDD's 0.25 m.
   */
  constructor(
    private readonly physics: PhysicsWorld,
    private readonly probeRadius: number = CAMERA_PROBE_RADIUS_M,
  ) {
    // The damping rates are derived from the per-frame factors the GDD specifies, once, here,
    // rather than every tick. `dampRateFromPerFrameLerp` contains a logarithm, and the per-tick
    // path should not.
    this.followRate = dampRateFromPerFrameLerp(CAMERA_FOLLOW_LERP, TICK_RATE);
    this.pullInRate = dampRateFromPerFrameLerp(CAMERA_PULL_IN_LERP, TICK_RATE);
    this.pushOutRate = dampRateFromPerFrameLerp(CAMERA_PUSH_OUT_LERP, TICK_RATE);
    this.resetRate = RESET_TIME_CONSTANTS / CAMERA_RESET_S;

    // `followRate` is deliberately not applied to the pivot. The camera is rigidly attached to a
    // shoulder-height point on the character, and the follow smoothing happens in the *input* to
    // the pivot. Damping the pivot itself would make the camera lag the player's own body, so a
    // stationary player would see the camera still sliding toward them after they stopped.

    this.resolvedFraming = this.baseFraming();
    this.framing = { ...this.resolvedFraming };

    this.state = {
      mode: CameraMode.Default,
      pivot: { x: 0, y: CAMERA_HEIGHT_M, z: 0 },
      position: { x: 0, y: CAMERA_HEIGHT_M, z: CAMERA_DISTANCE_M },
      yaw: 0,
      pitch: 0,
      boom: this.boom,
      fovDeg: CAMERA_FOV_DEG,
      obstructed: false,
      groundClamped: false,
      resetting: false,
      idleSeconds: 0,
    };
  }

  /** The damping rate the follow smoothing uses, exposed for the overlay and the tests. */
  public get pivotFollowRate(): number {
    return this.followRate;
  }

  /** The most recent state. Never null; the rig reports a sane default before its first tick. */
  public get current(): Readonly<CameraState> {
    return this.state;
  }

  /** The active camera mode. */
  public get activeMode(): CameraMode {
    return this.mode;
  }

  /**
   * The look target the camera should aim at, one metre ahead of it along the view axis.
   *
   * ─── WHY NOT `camera.lookAt(player)` ────────────────────────────────────────────────
   * Because the camera is offset sideways by the shoulder offset, aiming *at* the player swings
   * the view inward. The visible consequence is that the whole screen yaws every time the
   * shoulder offset changes — which it does the instant the player aims, or climbs, or mantles.
   * An over-the-shoulder camera looks parallel to the movement direction instead, so the world
   * ahead stays centred and the character sits off to one side of frame.
   *
   * @returns World-space look target.
   */
  public lookTarget(): Vec3 {
    // Delegated to the pure module rather than reimplemented. The first draft of this method
    // recomputed the geometry locally and got the sign of the look direction backwards, so the
    // camera stared away from the player into the void. The unit tests passed throughout, because
    // they test `camera.ts` — which was right. Anything this easy to get wrong belongs in exactly
    // one place, and that place is the one under test.
    return computeLookTarget(this.state.position, this.state.yaw, this.state.pitch, CAMERA_LOOK_AHEAD_M);
  }

  /**
   * Place the camera immediately, with no easing.
   *
   * ─── EDGE CASE 5: TELEPORT ──────────────────────────────────────────────────────────
   * The character controller rescues the player from a kill plane, a NaN position or a stuck
   * state by moving them instantly. A camera that *eases* across that distance flies backwards
   * through the entire level, which reads as the game breaking.
   *
   * `CharacterEvents.rescued` is the authoritative signal and is what `handleTeleport` acts on.
   * The distance check there is only a backstop for any *other* instantaneous move, because
   * relying on a magnitude threshold alone would make a legitimate fast fall look like a
   * teleport and snap the camera mid-parkour.
   *
   * @param characterPosition - The character's own world position, i.e. the value `update`
   *   receives as `report.position`. The rig applies the chest lift itself.
   *
   *   Earlier this parameter was documented as "the pivot, already lifted", and the two callers
   *   disagreed about it: the public path passed feet height while the teleport path passed chest
   *   height. The result was a camera that solved its occlusion at the character's knees on the
   *   first frame, sailed through a wall, and then behaved correctly forever after — a
   *   first-frame-only bug, which is the hardest kind to notice. One entry point, one meaning.
   * @param facingAngle - The character's facing, so the camera starts behind them.
   */
  public snapTo(characterPosition: Vec3, facingAngle: number): void {
    const angle = Number.isFinite(facingAngle) ? facingAngle : 0;

    this.yaw = angle;
    this.pitch = 0;
    // Snap *into* the idle state rather than out of it: after a rescue the player is stationary
    // and disoriented, and the camera swinging round to face where they were going is the one
    // thing that helps. `CAMERA_AUTO_ROTATE_DELAY_S` is the smallest honest value for that.
    this.idleSeconds = CAMERA_AUTO_ROTATE_DELAY_S;
    this.pinnedSeconds = 0;
    this.penetratingSeconds = 0;
    this.escaping = false;
    this.escapeSeconds = 0;
    this.wobblePhaseSeconds = 0;
    this.wobbleYaw = 0;
    this.wobblePitch = 0;

    const pivot = {
      x: characterPosition.x,
      y: characterPosition.y + CAMERA_HEIGHT_M,
      z: characterPosition.z,
    };
    this.previousPivot = { x: pivot.x, y: pivot.y, z: pivot.z };

    this.boom = this.framing.distance;
    this.solve(0, pivot);
  }

  /**
   * Advance the rig one tick.
   *
   * @param dt - Timestep in seconds.
   * @param report - The character's tick report: where the pivot is and what state they are in.
   * @param events - What happened to the character this tick.
   * @param intent - The player's camera input.
   * @param triggers - Situational flags that select the camera mode. Supplied by gameplay so this
   *   file does not have to reach into systems that do not exist yet.
   * @returns The new camera state.
   */
  public update(
    dt: number,
    report: CharacterTickReport,
    events: CharacterEvents,
    intent: CameraIntent,
    triggers: Partial<CameraModeTriggers> = {},
  ): Readonly<CameraState> {
    // A non-finite timestep would poison every accumulator here permanently. Refusing the tick
    // leaves the last good camera in place, which is recoverable; a NaN camera is a black screen.
    if (!Number.isFinite(dt) || dt <= 0) return this.state;

    const pivot = this.pivotFor(report);
    const allTriggers: CameraModeTriggers = { ...NO_TRIGGERS, ...triggers };

    this.mode = resolveCameraMode(allTriggers);
    this.resolvedFraming = framingForMode(this.mode, this.modeDefaults());

    this.advanceWobble(dt, allTriggers.submerged);
    this.applyPlayerLook(dt, intent);
    this.applyAutoRotation(dt, report);
    this.advanceFraming(dt);

    // The reset's lift is added to the pivot rather than to the framing, because it is a
    // *temporary escape* and must not be blended into the framing the mode transitions are
    // damping — otherwise the lift would outlive the reset by the whole damping duration and
    // release the camera gradually, which is exactly the slow drift the reset exists to stop.
    const resetLift = this.escaping ? CAMERA_RESET_LIFT_M : 0;

    const liftedPivot = {
      x: pivot.x,
      y: pivot.y + this.framing.heightOffset + resetLift,
      z: pivot.z,
    };

    // Teleport handling runs AFTER the mode and framing are resolved so a snap lands with the
    // right boom length for the situation the player is now in, and before the solve so the
    // solve operates on the new pivot rather than the old one.
    if (this.handleTeleport(report, events, liftedPivot)) {
      this.previousPivot = { x: pivot.x, y: pivot.y, z: pivot.z };
      return this.state;
    }

    const obstructed = this.solve(dt, liftedPivot);

    this.updateStuckTimers(dt, obstructed);
    this.previousPivot = { x: pivot.x, y: pivot.y, z: pivot.z };

    this.state.mode = this.mode;
    this.state.pivot = liftedPivot;
    this.state.obstructed = obstructed;
    this.state.fovDeg = this.framing.fovDeg;
    this.state.idleSeconds = this.idleSeconds;
    this.state.resetting = this.escaping;

    return this.state;
  }

  /**
   * The point the camera orbits: chest height on the character, plus the mode's height offset.
   *
   * The pivot sits at chest rather than eye height. At eye height the boom passes through the
   * character's own head the moment the camera pitches up, which is a self-occlusion problem no
   * amount of collision handling can fix.
   */
  private pivotFor(report: CharacterTickReport): Vec3 {
    const position = report.position;

    // A non-finite character position means the controller's own safety net has not fired yet.
    // Falling back to the previous pivot keeps the camera somewhere valid rather than nowhere.
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      return this.previousPivot ?? { x: 0, y: CAMERA_HEIGHT_M, z: 0 };
    }

    return { x: position.x, y: position.y + CAMERA_HEIGHT_M, z: position.z };
  }

  /**
   * ─── EDGE CASE 5, CONTINUED: THE SNAP PATH ──────────────────────────────────────────
   *
   * @returns True when a snap happened and the rest of the tick should be skipped.
   */
  private handleTeleport(
    report: CharacterTickReport,
    events: CharacterEvents,
    pivot: Vec3,
  ): boolean {
    const rescued = events.rescued === true;

    // The backstop. The threshold is far above anything reachable by movement — even the fastest
    // scripted platform in the GDD moves a fraction of this per tick — so it cannot misfire on
    // legitimate motion.
    let travelled = 0;
    if (this.previousPivot) {
      travelled = Math.hypot(
        pivot.x - this.previousPivot.x,
        pivot.y - this.previousPivot.y,
        pivot.z - this.previousPivot.z,
      );
    }

    if (!rescued && travelled <= CAMERA_TELEPORT_SNAP_M) return false;

    this.snapTo(report.position, report.facingAngle);

    // The state must be fully consistent before returning, because a single frame rendered at the
    // stale position is a very visible flash of the old location.
    this.state.mode = this.mode;
    this.state.pivot = pivot;
    this.state.fovDeg = this.framing.fovDeg;
    this.state.obstructed = false;
    this.state.groundClamped = false;
    this.state.resetting = false;
    this.state.idleSeconds = this.idleSeconds;

    return true;
  }

  /**
   * Advance the submerged wobble's phase, and zero the offset when not submerged.
   *
   * The phase is integrated from `dt` rather than read from a wall clock: a stalled tab must not
   * teleport the phase, and the oscillation has to run at the same speed regardless of frame rate.
   */
  private advanceWobble(dt: number, submerged: boolean): void {
    if (!submerged) {
      // Resuming on the surface with a phase of zero means the wobble never leaves the camera at
      // a half-amplitude offset that then visibly snaps away.
      if (this.wasSubmerged) {
        this.wobblePhaseSeconds = 0;
        this.wobbleYaw = 0;
        this.wobblePitch = 0;
        this.wasSubmerged = false;
      }
      return;
    }

    this.wasSubmerged = true;
    this.wobblePhaseSeconds += dt;

    // Two oscillations in quadrature describe an ellipse, which reads as buoyancy. In phase they
    // would be a single stronger pendulum. The pitch amplitude is half the yaw's, because a
    // vertical wobble is far more nauseating than a lateral one.
    this.wobbleYaw = waterWobble(
      this.wobblePhaseSeconds,
      CAMERA_WATER_WOBBLE_HZ,
      CAMERA_WATER_WOBBLE_RAD,
      0,
    );
    this.wobblePitch = waterWobble(
      this.wobblePhaseSeconds,
      CAMERA_WATER_WOBBLE_HZ,
      CAMERA_WATER_WOBBLE_RAD * 0.5,
      Math.PI / 2,
    );
  }

  /**
   * Apply the player's deliberate camera input.
   *
   * Mouse deltas arrive as radians already, scaled by the input layer, and are *not* damped.
   * Damping mouse look adds input latency, and the correct way to smooth a jittery mouse is a
   * deadzone or a moving average on the raw deltas, not a lag on the result.
   */
  private applyPlayerLook(dt: number, intent: CameraIntent): void {
    const yawDelta = Number.isFinite(intent.yawDelta) ? intent.yawDelta : 0;
    const pitchDelta = Number.isFinite(intent.pitchDelta) ? intent.pitchDelta : 0;

    if (yawDelta !== 0 || pitchDelta !== 0) this.idleSeconds = 0;
    else this.idleSeconds += dt;

    this.yaw = this.wrapYaw(this.yaw + yawDelta);

    // Pitch accumulates *through* the clamp every tick, so it can never leave the legal range
    // even momentarily. A camera outside the range for one tick is a camera the player watches
    // flip over the pole.
    this.pitch = clampPitch(
      this.pitch + pitchDelta,
      CAMERA_PITCH_MIN_DEG * DEG,
      CAMERA_PITCH_MAX_DEG * DEG,
    );
  }

  /**
   * Auto-rotate the yaw toward the character's facing once the player has been idle long enough.
   *
   * ─── EDGE CASE 8: NEVER FIGHT THE PLAYER ────────────────────────────────────────────
   * The failure this prevents is the most-complained-about camera behaviour in third-person
   * games: the camera slowly rotating back while the player is holding forward, so their path
   * curves and they cannot work out why. The gate is a *duration of no camera input*, which is
   * the only thing that reliably distinguishes "idle" from "being steered".
   */
  private applyAutoRotation(dt: number, report: CharacterTickReport): void {
    if (!shouldAutoRotate(this.idleSeconds, CAMERA_AUTO_ROTATE_DELAY_S)) return;
    if (!Number.isFinite(report.facingAngle)) return;

    // Rate-limited rather than damped, so the rotation cannot outpace the player's own turning
    // when it does engage. `rotateToward` takes the short way around the seam.
    this.yaw = rotateToward(this.yaw, report.facingAngle, CAMERA_AUTO_ROTATE_SPEED_RAD, dt);
  }

  /**
   * Ease the active framing toward the mode's target.
   *
   * Mode changes are *cut* nowhere. The transition is short enough to read as a snap and long
   * enough that the horizon does not jump, which is the difference between a camera that feels
   * reactive and one that feels like it is being operated by someone else.
   */
  private advanceFraming(dt: number): void {
    this.framing = dampFraming(this.framing, this.resolvedFraming, CAMERA_MODE_TRANSITION_RATE, dt);
  }

  /**
   * Resolve the boom, cast for obstructions, clamp to the ground, and place the camera.
   *
   * ─── EDGE CASE 1: WALLS ─────────────────────────────────────────────────────────────
   * A sphere is cast, never a ray. A ray threads gaps the camera's near plane cannot, and the
   * result is geometry through the lens. The sphere's radius is the near-plane radius, so the
   * boom is shortened by exactly the amount that matters for visibility.
   *
   * @param dt - Timestep in seconds. Zero means "place, do not advance" — used by {@link snapTo}.
   * @param pivot - The orbit centre, already lifted by the mode's height offset.
   * @returns True when the arm was shortened by an obstruction.
   */
  private solve(dt: number, pivot: Vec3): boolean {
    const desired = this.framing.distance;
    const yaw = this.finalYaw();
    const pitch = this.finalPitch();

    // ─── EDGE CASE 3: THE ESCAPE HATCH ────────────────────────────────────────────────
    // During a forced reset the arm is allowed to collapse below `CAMERA_MIN_DISTANCE_M`.
    //
    // The first draft of this did not do that. It drove the boom to a *fallback* of 60% of the
    // full distance, on the reasoning that the obstruction cast could not be trusted while stuck.
    // That was wrong twice over: the cast was never the problem, and pushing the boom OUT is
    // precisely the wrong direction in a tight space — it drove the camera deeper into the wall it
    // was already stuck against. The pocket test caught it: the camera ended up penetrating
    // geometry *after* the escape hatch had run, which is the one outcome the hatch exists to
    // prevent.
    //
    // The minimum distance is the real obstacle. It exists so the player is never shown the back
    // of their own head, which is a *bad view*; inside a niche or a sealed pocket there is no
    // legal position at all, so enforcing it produces no view. Relaxing it means the arm can
    // collapse toward the pivot, and the pivot is by construction inside free space — the
    // character is standing there. That makes the escape provably convergent rather than
    // hopeful: every reset cycle that still finds geometry pulls the camera closer to a point
    // that is known to be clear.
    const minDistance =
      this.escaping
        ? CAMERA_MIN_DISTANCE_M * CAMERA_RESET_MIN_SCALE
        : CAMERA_MIN_DISTANCE_M;

    const direction = orbitDirection(yaw, pitch);

    // Cast from the pivot outward, against the static world only. Querying everything would make
    // the camera collide with the character it is following, and with the enemy the player is
    // fighting — both of which are objects the camera is *supposed* to look through.
    const hit = this.physics.castSphere(
      pivot,
      direction,
      this.probeRadius,
      desired + CAMERA_SKIN_M,
      [CollisionLayer.StaticWorld],
    );

    // ─── WHEN THE MINIMUM DISTANCE AND THE WALL DISAGREE, THE WALL WINS ──────────────
    // `springArmTarget` applies the minimum as a floor, so passing the GDD's 1.5 m straight in
    // means that against a wall 1.25 m away the arm resolves to 1.5 m — and the camera is placed a
    // quarter of a metre *inside the wall*. The minimum distance is a framing preference; not being
    // inside geometry is a correctness constraint, and a preference must never override one.
    //
    // So the floor handed to the resolver is capped at what the geometry actually permits. Against a
    // generous wall nothing changes and the 1.5 m minimum still governs. Against a wall closer than
    // the minimum, the arm collapses just far enough to stay outside it, and the *pinned* detector
    // notices that the view has fallen below spec and brings in the escape hatch to raise the pivot
    // — which is the remedy for a close camera, rather than a futile attempt to push the boom out
    // through the wall.
    const hardLimit = hit ? Math.max(0, hit.distance - CAMERA_SKIN_M) : Number.POSITIVE_INFINITY;

    const permitted = springArmTarget(
      desired,
      hit ? hit.distance : Number.POSITIVE_INFINITY,
      Math.min(minDistance, hardLimit),
      CAMERA_SKIN_M,
    );

    const rate = this.escaping ? this.resetRate : this.pullInRate;
    const outRate = this.escaping ? this.resetRate : this.pushOutRate;

    this.boom = dt > 0 ? advanceSpringArm(this.boom, permitted, rate, outRate, dt) : permitted;

    const obstructed = permitted < desired - 1e-6;

    this.state.yaw = yaw;
    this.state.pitch = pitch;
    this.placeCamera(dt, pivot, yaw, pitch);

    return obstructed;
  }

  /**
   * Place the camera on the boom, then correct it against the ground.
   *
   * ─── EDGE CASE 2: THE GROUND, AND WHY THIS RE-SOLVES RATHER THAN LIFTING ────────────
   * The obvious fix for "the camera is under the floor" is to raise its Y. That is wrong: the
   * camera then sits *off* the boom axis, so the framing shifts sideways and the view tilts, all
   * as a side effect of walking downhill. Worse, the misplacement feeds back into the look target
   * on the next tick and the view drifts for as long as the player walks.
   *
   * Re-solving the boom instead keeps the camera on the arm: it slides *in* toward the player as
   * the ground rises behind them, which is both correct and what the player expects.
   *
   * The common case costs a single downward ray. The bisection runs only where the full-length
   * position is actually in the ground, so the cost is paid only where the correction is needed.
   */
  private placeCamera(dt: number, pivot: Vec3, yaw: number, pitch: number): void {
    let position = orbitPosition(pivot, yaw, pitch, this.boom, this.framing.shoulderOffset);

    const clearance = CAMERA_GROUND_CLEARANCE_M;
    const groundHere = this.groundBelow(position);

    let clamped = false;
    if (Number.isFinite(groundHere) && position.y < groundHere + clearance) {
      // ─── WHAT THE RE-SOLVE CAN AND CANNOT DO ────────────────────────────────────────────
      // Shortening the boom raises the camera along the arm only when the arm points DOWNWARD.
      // At a level or upward pitch the camera's height does not depend on the boom length at all,
      // so no amount of re-solving can lift it. An earlier draft re-solved unconditionally, and
      // when the bisection found that no distance clears the ground — every distance to try, at
      // level pitch — it returned the largest clear distance, which was the pivot itself, and the
      // camera collapsed to zero length. A crate behind the player became a first-person view.
      //
      // So the re-solve is attempted exactly when it is capable of helping: a descending arm. It
      // also declines a result that would cost more than half the boom, because sliding 3 m in to
      // gain 6 cm of clearance is a much more visible artefact than the clearance is.
      //
      // Whether or not the re-solve ran or helped, the absolute clamp below guarantees the
      // clearance. That makes this correction a framing nicety rather than the safety mechanism,
      // which is the opposite of the first draft's arrangement and the reason the first draft was
      // able to place the camera underground.
      if (pitch < 0) {
        const resolved = this.resolveBoomAgainstGround(pivot, yaw, pitch);
        const floor = this.escaping ? CAMERA_MIN_DISTANCE_M * CAMERA_RESET_MIN_SCALE : 0;
        const usable = resolved >= this.boom * 0.5 ? resolved : Math.max(floor, this.boom * 0.5);

        if (Math.abs(usable - this.boom) > 1e-4) {
          this.boom =
            dt > 0
              ? advanceSpringArm(
                  this.boom,
                  usable,
                  this.escaping ? this.resetRate : this.pullInRate,
                  this.escaping ? this.resetRate : this.pushOutRate,
                  dt,
                )
              : usable;

          position = orbitPosition(pivot, yaw, pitch, this.boom, this.framing.shoulderOffset);
        }
      }

      const groundAfter = this.groundBelow(position);
      const lifted = applyGroundClamp(position.y, groundAfter, clearance);
      if (Math.abs(lifted - position.y) > 1e-6) {
        position = { x: position.x, y: lifted, z: position.z };
        clamped = true;
      }
    }

    this.state.boom = this.boom;
    this.state.position = position;
    this.state.groundClamped = clamped;
  }

  /**
   * Find the largest boom length at which the camera is still above the ground.
   *
   * A bounded bisection rather than an analytic solution: the ground is arbitrary geometry, so
   * there is no closed form. Eight iterations narrow the interval to 1/256 of the boom, which is
   * sub-centimetre at any plausible distance — well below the screen-space threshold at which a
   * player could see the difference, and cheap enough to be unremarkable in a profile.
   *
   * @returns The resolved boom length, or 0 when no length is clear (the caller then clamps).
   */
  private resolveBoomAgainstGround(pivot: Vec3, yaw: number, pitch: number): number {
    const clearance = CAMERA_GROUND_CLEARANCE_M;

    const clearAt = (distance: number): boolean => {
      const candidate = orbitPosition(pivot, yaw, pitch, distance, this.framing.shoulderOffset);
      const ground = this.groundBelow(candidate);
      return !Number.isFinite(ground) || candidate.y >= ground + clearance;
    };

    let low = 0;
    let high = this.boom;

    if (!clearAt(high)) return 0;
    if (clearAt(low)) return high;

    for (let i = 0; i < GROUND_RESOLVE_ITERATIONS; i++) {
      const mid = (low + high) * 0.5;
      if (clearAt(mid)) low = mid;
      else high = mid;
    }

    // `low` is the largest distance *measured* clear. Returning `high` would place the camera at a
    // distance that was measured as not clear, which is the exact failure the re-solve exists to
    // prevent.
    return low;
  }

  /**
   * The ground height directly below a point, via a single downward ray.
   *
   * @returns The ground Y, or -Infinity when nothing is below — which means "no ground
   *   constraint" and must not be conflated with "ground at zero".
   */
  private groundBelow(point: Vec3): number {
    // ─── THE RAY STARTS AT THE CAMERA, AND THAT IS THE WHOLE POINT ────────────────────
    // The first draft started it a metre ABOVE the camera, reasoning that this would stop an
    // overhang from hiding the floor beneath it. It did the exact opposite: starting above the
    // camera put the ray's origin inside any overhang the camera was standing under, and Rapier's
    // solid ray reporting makes a ray that starts inside a shape hit it at zero distance. The
    // ceiling underneath became "the ground", the clamp then lifted the camera *into* the ceiling,
    // and the next tick found the ceiling's top surface and lifted it further. In the sealed-pocket
    // test the camera climbed to y = 4.52 and stayed inside the ceiling slab.
    //
    // Casting downward from the camera's own height makes an overhang structurally unreachable:
    // the ray simply never goes up. The camera's position is assumed to be free space, which is
    // what the separate penetration detector exists to check.
    const hit = this.physics.castRay(
      { x: point.x, y: point.y, z: point.z },
      { x: 0, y: -1, z: 0 },
      GROUND_PROBE_REACH_M,
      [CollisionLayer.StaticWorld],
    );

    return hit ? point.y - hit.distance : Number.NEGATIVE_INFINITY;
  }

  /**
   * Maintain the two independent stuck conditions and drive the forced reset.
   *
   * ─── EDGE CASE 3: THE CAMERA MUST NEVER BE PERMANENTLY STUCK ────────────────────────
   * There are two distinct ways to end up with an unusable camera, and they need separate
   * detectors because they have different signatures:
   *
   *   • **Pinned.** The boom has been at minimum distance for a sustained period. The camera is
   *     not inside anything — it is simply jammed against a wall with no room, so the player sees
   *     the back of the character's head and cannot see where they are going. Normal in a tight
   *     corridor for a moment; a bug if sustained.
   *   • **Penetrating.** The camera's position is inside geometry. This happens without the boom
   *     being pinned, because an obstruction can appear *between* the pivot and the camera without
   *     the cast having been aimed at it — a rising platform, a closing door, a spawned collider.
   *     Being inside geometry is worse than being too close, so it fires sooner.
   *
   * A single timeout covering both would have to choose between ignoring a real penetration for
   * two seconds and resetting during every corridor. The GDD's 2.0 s / 0.5 s split is the correct
   * resolution, and the two counters are independent because a camera can penetrate without ever
   * being pinned.
   */
  private updateStuckTimers(dt: number, obstructed: boolean): void {
    // Compared against the NORMAL minimum, never the relaxed one: "the view has fallen below
    // spec" is the condition worth acting on, and while the escape is active the boom is *expected*
    // to be below it, so comparing against the relaxed floor would make the escape self-cancel.
    const pinned = obstructed && this.boom <= CAMERA_MIN_DISTANCE_M + 1e-3;

    this.pinnedSeconds = pinned ? this.pinnedSeconds + dt : 0;

    // Penetration is only meaningful when the arm is *not* already pinned: a pinned arm has
    // nothing left to give, and the pinned timer is the one that should fire.
    const insideGeometry = !pinned && this.isPenetrating();
    this.penetratingSeconds = insideGeometry ? this.penetratingSeconds + dt : 0;

    if (this.escaping) {
      this.escapeSeconds += dt;

      // Self-terminating: the escape ends when the condition that started it is gone. There is no
      // countdown to expire early, because expiring early means handing the camera straight back
      // to the geometry it just left. See the field's own comment for the full failure.
      const relieved = !pinned && !insideGeometry;

      // A floor on the duration, so a marginal penetration cannot flicker the escape on and off
      // within a couple of frames. `CAMERA_RESET_S` is exactly this: the minimum time the arm is
      // allowed to spend collapsing, which is the number the GDD is actually specifying.
      if (relieved && this.escapeSeconds >= CAMERA_RESET_S) {
        this.escaping = false;
        this.escapeSeconds = 0;
        this.pinnedSeconds = 0;
        this.penetratingSeconds = 0;
      }
      return;
    }

    if (
      shouldForceCameraReset(
        this.pinnedSeconds,
        this.penetratingSeconds,
        CAMERA_STUCK_TIMEOUT_S,
        CAMERA_PENETRATION_TIMEOUT_S,
      )
    ) {
      this.escaping = true;
      this.escapeSeconds = 0;
      this.pinnedSeconds = 0;
      this.penetratingSeconds = 0;
    }
  }

  /**
   * Is the camera inside solid geometry?
   *
   * Checked with a sphere deliberately smaller than the occlusion probe. Using the same radius
   * would report "penetrating" whenever the camera is exactly at the skin distance, which is the
   * *normal* resting state against a wall — and the reset would then fire constantly in every
   * corridor, which is far worse than the problem it exists to solve. Half the probe radius means
   * the report is "the camera's centre is well inside something", not "the camera is touching it".
   */
  private isPenetrating(): boolean {
    return this.physics.sphereOverlaps(this.state.position, this.probeRadius * 0.5, [
      CollisionLayer.StaticWorld,
    ]);
  }

  /** The pitch actually used for geometry: the player's pitch plus the mode's bias. */
  private finalPitch(): number {
    return clampPitch(
      this.pitch + this.framing.pitchBias + this.wobblePitch,
      CAMERA_PITCH_MIN_DEG * DEG,
      CAMERA_PITCH_MAX_DEG * DEG,
    );
  }

  /** The yaw actually used for geometry: the player's yaw plus the transient wobble offset. */
  private finalYaw(): number {
    return this.wrapYaw(this.yaw + this.wobbleYaw);
  }

  /** Keep yaw in the canonical range, wrapping the short way at the seam. */
  private wrapYaw(yaw: number): number {
    const twoPi = Math.PI * 2;
    let wrapped = yaw % twoPi;
    if (wrapped > Math.PI) wrapped -= twoPi;
    if (wrapped < -Math.PI) wrapped += twoPi;
    return wrapped;
  }

  /** The base framing, assembled from constants. Passed to `framingForMode` as its defaults. */
  private baseFraming(): CameraFraming {
    return {
      distance: CAMERA_DISTANCE_M,
      fovDeg: CAMERA_FOV_DEG,
      shoulderOffset: CAMERA_SHOULDER_OFFSET_M,
      pitchBias: 0,
      heightOffset: 0,
    };
  }

  /** The GDD §5.3 table, as `framingForMode` wants it: base values plus the per-mode extras. */
  private modeDefaults(): Parameters<typeof framingForMode>[1] {
    return {
      ...this.baseFraming(),
      aimDistance: CAMERA_AIM_DISTANCE_M,
      aimFovDeg: CAMERA_AIM_FOV_DEG,
      aimShoulderOffset: CAMERA_AIM_SHOULDER_OFFSET_M,
      tunnelDistance: CAMERA_TUNNEL_DISTANCE_M,
      tunnelFovDeg: CAMERA_TUNNEL_FOV_DEG,
      climbDistance: CAMERA_CLIMB_DISTANCE_M,
      zipLineDistance: CAMERA_ZIPLINE_DISTANCE_M,
      climbPitchBias: CAMERA_CLIMB_PITCH_BIAS_DEG * DEG,
      zipLinePitchBias: CAMERA_ZIPLINE_PITCH_BIAS_DEG * DEG,
      mantlePullBack: CAMERA_MANTLE_PULL_BACK_M,
      mantleRaise: CAMERA_MANTLE_RAISE_M,
    };
  }
}

export { CameraMode };
