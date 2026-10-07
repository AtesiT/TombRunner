/**
 * Locomotion mathematics — pure functions, no engine, no state, fully testable.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS (the same reasoning as src/core/math/ps1.ts)
 * ────────────────────────────────────────────────────────────────────────────────
 * Character movement is the highest-risk system in the project (risk R4, scored 20/25).
 * Its hardest parts are numerical: the exact airtime of a jump, the boundary of a coyote
 * window, the angle at which a slope stops being walkable. Those are precisely the
 * conditions that are tedious to reproduce by hand in a running game and trivial to test
 * exhaustively as pure functions.
 *
 * Everything here is deterministic and side-effect free. The stateful wrappers
 * ({@link TickWindow}) hold state but expose it through pure predicates, so a test can
 * drive them through any sequence of ticks without a game loop.
 *
 * Source of truth for all targets: docs/GAME_DESIGN_DOC.md §4.
 */

// ─────────────────────────────────────────────────────────────────────────────
// JUMP ARC SOLVER
// ─────────────────────────────────────────────────────────────────────────────

/** Inputs describing the shape of a jump. All values are positive magnitudes. */
export interface JumpArcParams {
  /** Peak height above the takeoff point, in metres. */
  peakHeight: number;
  /** Downward acceleration while rising, in m/s². */
  gravityRise: number;
  /** Downward acceleration while falling, in m/s². Must exceed `gravityRise`. */
  gravityFall: number;
}

/** The solved trajectory of a jump. */
export interface JumpArc {
  /** Upward velocity required at takeoff, in m/s. */
  initialVerticalVelocity: number;
  /** Seconds spent rising to the peak. */
  riseTime: number;
  /** Seconds spent falling from the peak back to the takeoff height. */
  fallTime: number;
  /** Total seconds airborne. */
  airtime: number;
  /** Peak height, echoed back for convenience in tests and assertions. */
  peakHeight: number;
}

/**
 * Solve the trajectory of a jump with *asymmetric* gravity.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE MATHS
 * ────────────────────────────────────────────────────────────────────────────────
 * Rising (decelerating at `gRise` from `v0` to 0 over height `h`):
 *
 *     v0 = sqrt(2 · gRise · h)          (from v² = u² + 2as, with v = 0)
 *     tRise = v0 / gRise                (from v = u + at, with v = 0)
 *
 * Falling (accelerating at `gFall` from rest through the same height `h`):
 *
 *     h = ½ · gFall · tFall²   ⟹   tFall = sqrt(2h / gFall)
 *
 * Total airtime is the sum. Note that the descent is deliberately *faster* than the
 * ascent (gFall > gRise), which is the single most important trick for making a
 * platformer feel snappy rather than floaty — the player spends less time in the air
 * and more time making decisions on the ground.
 *
 * @param params - Trajectory parameters.
 * @returns The solved arc.
 */
export function solveJumpArc(params: JumpArcParams): JumpArc {
  const { peakHeight, gravityRise, gravityFall } = params;

  // NOTE the `!(x > 0)` form rather than `x <= 0`. Every comparison against NaN is false,
  // so `NaN <= 0` is false and a NaN input would slip straight through a `<= 0` guard,
  // producing a NaN takeoff velocity. That NaN would then propagate into the character's
  // position, and a NaN position is *unrecoverable* — every subsequent collision test
  // fails, so the character can neither move nor land. Found by the degenerate-input test.
  const isPositiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;

  if (
    !isPositiveFinite(peakHeight) ||
    !isPositiveFinite(gravityRise) ||
    !isPositiveFinite(gravityFall)
  ) {
    return {
      initialVerticalVelocity: 0,
      riseTime: 0,
      fallTime: 0,
      airtime: 0,
      peakHeight: 0,
    };
  }

  const initialVerticalVelocity = Math.sqrt(2 * gravityRise * peakHeight);
  const riseTime = initialVerticalVelocity / gravityRise;
  const fallTime = Math.sqrt((2 * peakHeight) / gravityFall);

  return {
    initialVerticalVelocity,
    riseTime,
    fallTime,
    airtime: riseTime + fallTime,
    peakHeight,
  };
}

/**
 * Invert the arc solver: what horizontal speed is needed to travel a given distance?
 *
 * This is how the GDD's jump distances become *derived constants* rather than magic
 * numbers. Given a target distance and a solved arc, the required speed is simply
 * `distance / airtime`.
 *
 * @param distance - Desired horizontal travel in metres.
 * @param arc - The solved jump arc.
 * @returns The required horizontal speed in m/s, or 0 for a degenerate arc.
 */
export function solveHorizontalSpeedForDistance(distance: number, arc: JumpArc): number {
  if (arc.airtime <= 0 || distance <= 0) {
    return 0;
  }
  return distance / arc.airtime;
}

/**
 * Predict where a jump will land, for tests, level authoring and the debug overlay.
 *
 * @param arc - The solved jump arc.
 * @param horizontalSpeed - Horizontal speed at takeoff, in m/s.
 * @returns Horizontal distance travelled by the time the jumper returns to takeoff height.
 */
export function predictJumpDistance(arc: JumpArc, horizontalSpeed: number): number {
  return horizontalSpeed * arc.airtime;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLOPE CLASSIFICATION (GDD §4.5)
// ─────────────────────────────────────────────────────────────────────────────

/** Behavioural band a slope angle falls into. */
export enum SlopeBand {
  /** 0–30°: full speed, jumping allowed. */
  Walkable = 'walkable',
  /** 30–45°: reduced speed, jumping forbidden. */
  Slow = 'slow',
  /** 45–60°: slides down, steerable. */
  Slide = 'slide',
  /** 60°+: not traversable on foot, regardless of jump. */
  Unclimbable = 'unclimbable',
}

/** Thresholds separating the slope bands, in degrees. */
export interface SlopeThresholds {
  walkableMax: number;
  slowMax: number;
  slideMax: number;
}

/**
 * Convert a surface normal into a slope angle in degrees.
 *
 * The angle is measured from vertical: a perfectly flat floor has normal (0, 1, 0) and
 * yields 0°. The normal is clamped before the arc cosine because floating-point error
 * can push a component marginally outside [-1, 1] and produce NaN — which would then
 * silently classify a flat floor as an unclimbable cliff.
 *
 * @param normalY - The Y component of the *unit* surface normal.
 * @returns The slope angle in degrees, in [0, 90].
 */
export function slopeAngleFromNormalY(normalY: number): number {
  const clamped = Math.min(1, Math.max(-1, normalY));
  return (Math.acos(clamped) * 180) / Math.PI;
}

/**
 * Classify a slope angle into its behavioural band.
 *
 * Bands are inclusive of their upper bound and exclusive of their lower, so 30° is
 * `Walkable` and 30.0001° is `Slow`. The boundaries are asserted by test because an
 * off-by-one here would make a 45° ramp either silently climbable or an invisible wall.
 *
 * @param slopeDegrees - Slope angle in degrees.
 * @param thresholds - Band boundaries. Defaults are supplied by the caller so this
 *   module stays free of the constants module and therefore importable anywhere.
 * @returns The band.
 */
export function classifySlope(slopeDegrees: number, thresholds: SlopeThresholds): SlopeBand {
  if (slopeDegrees <= thresholds.walkableMax) return SlopeBand.Walkable;
  if (slopeDegrees <= thresholds.slowMax) return SlopeBand.Slow;
  if (slopeDegrees <= thresholds.slideMax) return SlopeBand.Slide;
  return SlopeBand.Unclimbable;
}

/**
 * Whether a jump may be initiated from the given band.
 *
 * Per GDD §4.5, jumping is forbidden on the 30–45° band. The reason is not arbitrary: a
 * jump launches the character off the surface, and on a slope steep enough to be
 * "scrambling" that reads as the character defying gravity. Forbidding it entirely is
 * clearer than weakening it.
 *
 * @param band - The current slope band.
 * @returns True when a jump is permitted.
 */
export function canJumpFromBand(band: SlopeBand): boolean {
  return band === SlopeBand.Walkable;
}

/**
 * Whether ground friction is applied on the given band.
 *
 * On a slide band the character must keep accelerating rather than being slowed, so the
 * normal ground-friction path is bypassed.
 *
 * @param band - The current slope band.
 * @returns True when ordinary ground friction applies.
 */
export function hasGroundFriction(band: SlopeBand): boolean {
  return band === SlopeBand.Walkable || band === SlopeBand.Slow;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLOPE PHYSICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The downhill acceleration component induced by gravity on a slope.
 *
 * Gravity's downslope component is `g · sin θ`, directed along the surface. This is what
 * makes a steep slope accelerate the player even when they have stopped pressing forward.
 *
 * @param gravity - Gravity magnitude in m/s².
 * @param slopeDegrees - Slope angle in degrees.
 * @returns Downhill acceleration magnitude in m/s².
 */
export function downslopeAcceleration(gravity: number, slopeDegrees: number): number {
  const radians = (slopeDegrees * Math.PI) / 180;
  return gravity * Math.sin(radians);
}

/**
 * Remove the component of a velocity that points into a surface.
 *
 * Without this, walking down a slope accumulates downward speed that is stored in the
 * velocity vector and then launched on the next jump — the classic "launched off a
 * downhill" bug, where a player running gently downhill suddenly jumps twice as high.
 * Projecting the velocity onto the surface plane keeps speed tangential and the jump
 * arc predictable.
 *
 * @param velocity - Current velocity.
 * @param normal - Unit surface normal.
 * @returns The velocity projected onto the surface plane.
 */
export function projectVelocityOntoSurface(
  velocity: { x: number; y: number; z: number },
  normal: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const intoSurface =
    velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z;

  // Subtracting the normal component leaves only the tangential part.
  return {
    x: velocity.x - intoSurface * normal.x,
    y: velocity.y - intoSurface * normal.y,
    z: velocity.z - intoSurface * normal.z,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INPUT TIMING WINDOWS (coyote time, jump buffering, interact buffering)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A countdown window measured in simulation ticks.
 *
 * Coyote time, jump buffering and interact buffering are all the same construct: a
 * one-shot flag that stays true for a fixed number of ticks after being armed. Expressing
 * them in *ticks* rather than seconds is what makes them framerate-independent: at 60 Hz
 * a 150 ms window is exactly 9 ticks whether the display runs at 30, 60 or 144 Hz.
 *
 * The window is deliberately modelled as a *consumable* rather than a timestamp: a
 * timestamp comparison invites subtle bugs where a window is re-armed accidentally, or
 * where the comparison uses the wrong frame's tick.
 */
export class TickWindow {
  private remainingTicks = 0;

  /**
   * @param durationTicks - How many ticks the window stays open once armed.
   */
  constructor(private readonly durationTicks: number) {}

  /** Open the window for its full duration, restarting it if already open. */
  public arm(): void {
    this.remainingTicks = this.durationTicks;
  }

  /** Close the window immediately (for example, once it has been consumed). */
  public clear(): void {
    this.remainingTicks = 0;
  }

  /**
   * Advance the window by one tick.
   *
   * Must be called exactly once per simulation tick, after all consumers have had the
   * chance to read {@link isActive}. Calling it before the consumers would close a
   * window one tick early.
   */
  public advance(): void {
    if (this.remainingTicks > 0) {
      this.remainingTicks--;
    }
  }

  /** Whether the window is currently open. */
  public get isActive(): boolean {
    return this.remainingTicks > 0;
  }

  /** Ticks remaining, for the debug overlay. */
  public get remaining(): number {
    return this.remainingTicks;
  }

  /** The configured duration, for tests that assert configuration matches the GDD. */
  public get duration(): number {
    return this.durationTicks;
  }
}

/**
 * Convert milliseconds to simulation ticks.
 *
 * @param milliseconds - Duration in ms.
 * @param tickRate - Ticks per second.
 * @returns The equivalent number of ticks.
 */
export function millisecondsToTicks(milliseconds: number, tickRate: number): number {
  return (milliseconds / 1000) * tickRate;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPEED INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Move a speed value toward a target at a bounded rate.
 *
 * This is the whole of the "smooth acceleration and deceleration" requirement: a speed
 * that reaches its target at a linear rate over the configured time. Instant start/stop
 * removes all sense of mass, and mass is what makes a 6 m running jump feel earned.
 *
 * @param current - Current speed.
 * @param target - Desired speed.
 * @param maxDelta - Maximum change this tick.
 * @returns The new speed, never overshooting the target.
 */
export function approachSpeed(current: number, target: number, maxDelta: number): number {
  const difference = target - current;
  if (Math.abs(difference) <= maxDelta) {
    return target;
  }
  return current + Math.sign(difference) * maxDelta;
}

/**
 * Maximum speed change available in one tick, from an acceleration time.
 *
 * @param fromSpeed - Speed at the start of the transition.
 * @param toSpeed - Speed at the end.
 * @param durationSeconds - Time the transition should take.
 * @param dt - Tick duration in seconds.
 * @returns The per-tick delta.
 */
export function speedDeltaForTransition(
  fromSpeed: number,
  toSpeed: number,
  durationSeconds: number,
  dt: number,
): number {
  if (durationSeconds <= 0) {
    return Math.abs(toSpeed - fromSpeed);
  }
  return (Math.abs(toSpeed - fromSpeed) / durationSeconds) * dt;
}

/**
 * Re-orient a horizontal direction toward a target direction at a bounded turn rate.
 *
 * Turning is rate-limited rather than instant so that the character carries momentum
 * through a direction change. Instant turning is the single most common reason a
 * third-person character feels weightless.
 *
 * @param currentRadians - Current facing angle, radians.
 * @param targetRadians - Desired facing angle, radians.
 * @param maxTurnRadians - Maximum rotation permitted this tick.
 * @returns The new facing angle, wrapped to [-π, π].
 */
export function approachAngle(
  currentRadians: number,
  targetRadians: number,
  maxTurnRadians: number,
): number {
  // Shortest signed angular difference, which is essential: without the wrap, a turn
  // from 179° to -179° would rotate 358° the wrong way instead of 2° the right way.
  let difference = targetRadians - currentRadians;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;

  if (Math.abs(difference) <= maxTurnRadians) {
    return wrapAngle(targetRadians);
  }
  return wrapAngle(currentRadians + Math.sign(difference) * maxTurnRadians);
}

/**
 * Wrap an angle in radians to [-π, π].
 *
 * @param radians - Any angle.
 * @returns The equivalent angle in [-π, π].
 */
export function wrapAngle(radians: number): number {
  let wrapped = radians % (Math.PI * 2);
  if (wrapped > Math.PI) wrapped -= Math.PI * 2;
  if (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH RESOLUTION — the single source of truth for jump takeoff
// ─────────────────────────────────────────────────────────────────────────────

/** Parameters for resolving a jump's takeoff velocities. */
export interface SolveJumpLaunchParams {
  /** Desired peak height in metres, measured from the takeoff position. */
  peakHeight: number;
  /** Desired horizontal distance in metres over the full flight. */
  horizontalDistance: number;
  /** Nominal rise gravity in m/s², as configured. */
  gravityRise: number;
  /** Fall gravity in m/s², as configured. */
  gravityFall: number;
  /**
   * Multiplier applied to the rise gravity while the jump control is held. This exists to
   * give a variable jump height; see the note on `effectiveRiseGravity`.
   */
  holdGravityScale: number;
  /** Whether the jump control is held at the moment of takeoff. */
  held: boolean;
  /** The simulation timestep in seconds. Required for discrete-integrator compensation. */
  dt: number;
}

/** The resolved takeoff velocities for a jump. */
export interface JumpLaunch {
  /** Upward velocity to apply at takeoff, in m/s. */
  verticalVelocity: number;
  /** Horizontal velocity magnitude at takeoff, in m/s. */
  horizontalSpeed: number;
  /** The continuous arc matching this launch, for reference and debugging. */
  arc: JumpArc;
  /** The rise gravity actually used, after any hold scaling. */
  effectiveRiseGravity: number;
  /** Whole ticks spent rising. */
  riseTicks: number;
  /** Whole ticks spent falling. */
  fallTicks: number;
  /** Total airtime in seconds, quantised to the tick grid. */
  airtimeSeconds: number;
}

/**
 * The rise gravity to use for an arc, given whether the jump control is held.
 *
 * ─── WHY THIS IS A FUNCTION AND NOT AN INLINE MULTIPLY ──────────────────────────────
 * The first implementation of the character controller multiplied the rise gravity by the
 * hold scale inside the *integration* step, but solved the trajectory arc with the nominal
 * gravity inside the *jump* step. The two disagreed, so a held jump peaked at
 * `2.0 / 0.75 = 2.67 m` instead of the documented 2.0 m, its airtime was 0.879 s instead of
 * 0.701 s, and because the horizontal launch speed had been derived from the nominal
 * airtime, the jump also overshot its target distance by 26%.
 *
 * The lesson is not "multiply in the right place" but "an arc must be solved against the
 * same gravity that will actually be applied to it". Both call sites now go through this
 * function, so they cannot disagree again.
 *
 * @param gravityRise - Nominal rise gravity in m/s².
 * @param holdGravityScale - Multiplier applied while held, clamped to (0, 1].
 * @param held - Whether the control is held.
 * @returns The gravity to solve and integrate the rise against.
 */
export function effectiveRiseGravity(
  gravityRise: number,
  holdGravityScale: number,
  held: boolean,
): number {
  if (!Number.isFinite(gravityRise) || gravityRise <= 0) return 0;
  if (!held) return gravityRise;
  if (!Number.isFinite(holdGravityScale) || holdGravityScale <= 0) return gravityRise;

  // Clamped to a sane band. A scale of 0 would mean no gravity and an infinite jump, and a
  // scale above 1 would make holding the button *reduce* the jump height.
  return gravityRise * Math.min(1, holdGravityScale);
}

/**
 * Takeoff velocity that reaches a target peak height on a *discrete* integrator.
 *
 * ─── WHY THE CONTINUOUS FORMULA IS NOT GOOD ENOUGH ──────────────────────────────────
 * `solveJumpArc` uses the textbook `v0 = sqrt(2gh)`, which is exact for continuous motion
 * but overshoots on any real fixed-step integrator. The controller uses semi-implicit
 * Euler (`v -= g·dt`, then `y += v·dt`), which peaks `v0·dt/2` above the target — 7.4 cm
 * on a 2.0 m jump at 60 Hz, or 3.7%. Measured on the real controller it was 8.6 cm.
 *
 * That is small enough to dismiss as "close enough", and that is exactly why it is worth
 * correcting: the GDD specifies the peak height, gaps in the level are authored against it,
 * and a documented number that quietly runs 4% high is the kind of drift that eventually
 * makes a jump that "should" clear a gap fail. Compensating is three lines and makes the
 * specification literally true.
 *
 * Solving `v0²/(2g) + v0·dt/2 = h` for `v0` gives the positive root below.
 *
 * @param peakHeight - Target peak height in metres.
 * @param gravity - Rise gravity in m/s².
 * @param dt - Timestep in seconds.
 * @returns The takeoff velocity in m/s, or 0 for degenerate inputs.
 */
export function discreteTakeoffVelocity(
  peakHeight: number,
  gravity: number,
  dt: number,
): number {
  if (!Number.isFinite(peakHeight) || peakHeight <= 0) return 0;
  if (!Number.isFinite(gravity) || gravity <= 0) return 0;
  if (!Number.isFinite(dt) || dt <= 0) return 0;

  const halfStep = (gravity * dt) / 2;
  return -halfStep + Math.sqrt(halfStep * halfStep + 2 * gravity * peakHeight);
}

/**
 * Resolve a jump's takeoff velocities so the peak height *and* the horizontal distance both
 * land on their targets when integrated at the given timestep.
 *
 * This is the only place a jump's numbers are computed, which is what makes the tuning
 * constants in `constants.ts` documentation rather than a second source of truth.
 *
 * ─── WHY AIRTIME IS COUNTED IN WHOLE TICKS ──────────────────────────────────────────
 * A continuous airtime of 0.7533 s is not reachable: the character lands on tick 46, not
 * tick 45.19. Dividing the target distance by a fractional airtime therefore misses by
 * whatever fraction of a tick was discarded. Counting "how many ticks does the rise take,
 * how many does the fall take" and multiplying the distance out over that whole-tick total
 * makes the distance exact on the actual simulation grid.
 *
 * @param params - Jump targets, gravity profile, and the timestep.
 * @returns Takeoff velocities and the tick-quantised flight breakdown. Degenerate inputs
 *   yield zeros rather than NaN, because a NaN velocity destroys the character's position
 *   irrecoverably.
 */
export function solveJumpLaunch(params: SolveJumpLaunchParams): JumpLaunch {
  const {
    peakHeight,
    horizontalDistance,
    gravityRise,
    gravityFall,
    holdGravityScale,
    held,
    dt,
  } = params;

  const effectiveRise = effectiveRiseGravity(gravityRise, holdGravityScale, held);

  // `horizontalDistance` is validated even though a zero or negative distance is
  // *arithmetically* harmless (it yields a zero speed): a NaN or Infinity distance would
  // divide through into `horizontalSpeed` and hence into the character's position, where a
  // NaN is unrecoverable. Caught by the degenerate-input sweep, not by inspection.
  if (
    !Number.isFinite(peakHeight) ||
    peakHeight <= 0 ||
    !Number.isFinite(horizontalDistance) ||
    horizontalDistance < 0 ||
    effectiveRise <= 0 ||
    !Number.isFinite(gravityFall) ||
    gravityFall <= 0 ||
    !Number.isFinite(dt) ||
    dt <= 0
  ) {
    return {
      verticalVelocity: 0,
      horizontalSpeed: 0,
      arc: solveJumpArc({ peakHeight: 0, gravityRise: 1, gravityFall: 1 }),
      effectiveRiseGravity: effectiveRise,
      riseTicks: 0,
      fallTicks: 0,
      airtimeSeconds: 0,
    };
  }

  const verticalVelocity = discreteTakeoffVelocity(peakHeight, effectiveRise, dt);

  // Whole ticks, rounded up, for each phase. `ceil` rather than `round` because a partial
  // tick still costs a full tick of travel.
  const riseTicks = Math.max(1, Math.ceil(verticalVelocity / (effectiveRise * dt)));
  const fallTicks = Math.max(1, Math.ceil(Math.sqrt((2 * peakHeight) / gravityFall) / dt));
  const airtimeSeconds = (riseTicks + fallTicks) * dt;

  return {
    verticalVelocity,
    horizontalSpeed: airtimeSeconds > 0 ? horizontalDistance / airtimeSeconds : 0,
    // Reference arc, solved against the compensated velocity so it describes what the
    // character will actually do rather than what the continuous ideal would do.
    arc: {
      initialVerticalVelocity: verticalVelocity,
      riseTime: verticalVelocity / effectiveRise,
      fallTime: Math.sqrt((2 * peakHeight) / gravityFall),
      airtime: airtimeSeconds,
      peakHeight,
    },
    effectiveRiseGravity: effectiveRise,
    riseTicks,
    fallTicks,
    airtimeSeconds,
  };
}
