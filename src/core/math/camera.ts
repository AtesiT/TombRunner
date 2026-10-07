/**
 * Camera mathematics — pure, engine-free, and fully testable.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY THE CAMERA GETS ITS OWN MATHS MODULE
 * ────────────────────────────────────────────────────────────────────────────────
 * A camera's bugs are *feel* bugs. Nothing crashes, nothing turns black, and no assertion that
 * a naive test would think to write will fail — the game just becomes subtly unpleasant to
 * play, and the cause is invisible. An off-by-one in a damping factor, a sign error in a
 * shoulder offset, or a pitch clamp that is one degree too wide all produce a camera that is
 * wrong in a way a player would describe only as "it feels bad".
 *
 * That makes pure, asserted mathematics more valuable here than anywhere else in the project.
 * Every formula below is a candidate for a silent feel regression, so every one has a test.
 *
 * ─── THE HEADLINE DECISION: FRAME-RATE INDEPENDENT DAMPING ──────────────────────────
 * The GDD specifies damping as per-frame lerp factors ("lerp 0.10", "pull-in at 0.35"). Read
 * literally, `current += (target - current) * 0.10` applied once per frame produces a
 * *different camera* at 144 Hz than at 60 Hz, and a camera whose damping changes mid-motion on
 * a machine that dips between the two.
 *
 * `dampRateFromPerFrameLerp` converts the authored factor into an exponential rate constant λ,
 * and `damp` applies `current += (target - current) * (1 - exp(-λ·dt))`. The convergence after
 * one reference frame is *identical* to the naive formula, so the GDD's numbers are exactly
 * what a 60 Hz player experiences — only the rate-independence is added.
 *
 * Finding a GDD-specified constant that is unimplementable as written is worth recording: the
 * specification was not wrong about the *feel* it wanted, it was just expressed in a form tied
 * to one frame rate.
 */

/** A 3-vector, as a plain object so this module imports nothing. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// DAMPING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a per-frame lerp factor into an exponential damping rate.
 *
 * Solving `exp(-λ/referenceHz) = 1 - factor` for λ gives the rate that reproduces the authored
 * per-frame factor at the reference rate.
 *
 * @param perFrameLerp - The authored factor in [0, 1]. 0.1 means "close 10% of the gap each
 *   frame". Values at or above 1 mean instant convergence.
 * @param referenceHz - The frame rate the factor was authored against. 60 for this project,
 *   because that is the simulation rate.
 * @returns The rate constant λ in units of 1/s. `Infinity` for instant convergence, 0 for none.
 */
export function dampRateFromPerFrameLerp(perFrameLerp: number, referenceHz: number): number {
  if (!Number.isFinite(perFrameLerp) || perFrameLerp <= 0) return 0;
  if (!Number.isFinite(referenceHz) || referenceHz <= 0) return 0;
  // At or above 1 the gap is closed completely each frame, which is not a damping rate at all.
  if (perFrameLerp >= 1) return Number.POSITIVE_INFINITY;

  return -referenceHz * Math.log(1 - perFrameLerp);
}

/**
 * Exponententially damp a scalar toward a target.
 *
 * Frame-rate independent: the convergence after any elapsed time depends only on λ and dt, not
 * on how many frames that time was divided into. A single 1/30 s step lands in exactly the same
 * place as two 1/60 s steps, which is what makes the camera behave identically on a machine
 * holding 60 and one dropping to 30.
 *
 * @param current - The current value.
 * @param target - The value to approach.
 * @param rate - The rate constant λ in 1/s, from {@link dampRateFromPerFrameLerp}.
 * @param dt - Timestep in seconds.
 * @returns The new value. Never overshoots.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  // ─── ORDER MATTERS HERE, AND IT IS LOAD-BEARING ────────────────────────────────────
  // An infinite rate means "close the whole gap in one step", which is what
  // `dampRateFromPerFrameLerp(1, hz)` legitimately returns for a tunable set to instant. This
  // test MUST come before the `Number.isFinite(rate)` guard below, because `isFinite(Infinity)`
  // is false — putting it afterwards, where it looks natural, makes it unreachable dead code and
  // silently turns an instant camera into one that never moves at all.
  if (rate === Number.POSITIVE_INFINITY) {
    // Guard the target first: exp() of a NaN would poison the camera position, and a NaN camera
    // renders a black screen with no error anywhere.
    return Number.isFinite(target) && Number.isFinite(dt) && dt > 0 ? target : current;
  }

  if (!Number.isFinite(rate) || rate <= 0) return current;
  if (!Number.isFinite(dt) || dt <= 0) return current;
  if (!Number.isFinite(target)) return current;

  const alpha = 1 - Math.exp(-rate * dt);
  return current + (target - current) * alpha;
}

/**
 * Exponententially damp an angle toward a target, taking the short way around.
 *
 * Without the wrap, a camera crossing the ±π seam takes the 358-degree route and spins the
 * long way round — extremely visible and extremely confusing.
 *
 * @param current - The current angle in radians.
 * @param target - The target angle in radians.
 * @param rate - The rate constant λ in 1/s.
 * @param dt - Timestep in seconds.
 * @returns The new angle, wrapped into [-π, π].
 */
export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return current;
  if (!Number.isFinite(dt) || dt <= 0) return current;
  if (!Number.isFinite(target)) return current;

  const twoPi = Math.PI * 2;
  let difference = (target - current) % twoPi;
  if (difference > Math.PI) difference -= twoPi;
  if (difference < -Math.PI) difference += twoPi;

  const alpha =
    rate === Number.POSITIVE_INFINITY ? 1 : 1 - Math.exp(-rate * dt);
  const next = current + difference * alpha;

  // Re-wrap so the value the caller stores can never drift outside the canonical range over a
  // long session; repeated small additions would otherwise accumulate.
  return wrapAngle(next);
}

/**
 * Wrap an angle into the range [-π, π].
 *
 * @param angle - The angle in radians.
 * @returns The equivalent angle in [-π, π].
 */
export function wrapAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  return wrapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SPRING ARM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The boom length the arm is allowed to occupy, given what the collision probe found.
 *
 * @param desiredDistance - The authored boom length for the active mode.
 * @param obstructedDistance - How far the collision probe travelled before hitting something,
 *   or `Infinity` when unobstructed.
 * @param minDistance - The hard floor. The camera is never closer than this, even if that means
 *   it is technically inside geometry — a camera closer than this is unusable, so a slightly
 *   wrong image beats no image.
 * @param skin - Clearance subtracted from the probe result, so the camera sits *just* off the
 *   surface rather than exactly on it, where floating-point error and the near plane conspire to
 *   show the inside of the wall.
 * @returns The permitted boom length.
 */
export function springArmTarget(
  desiredDistance: number,
  obstructedDistance: number,
  minDistance: number,
  skin: number,
): number {
  if (!Number.isFinite(desiredDistance) || desiredDistance <= 0) return minDistance;

  // An unobstructed probe cannot pull the arm in, so the desired length stands.
  if (!Number.isFinite(obstructedDistance)) return desiredDistance;

  const permitted = obstructedDistance - skin;
  return Math.min(desiredDistance, Math.max(minDistance, permitted));
}

/**
 * Advance the spring arm's actual length toward its permitted target.
 *
 * ─── WHY THIS IS ASYMMETRIC, AND WHY IT MATTERS MORE THAN IT LOOKS ──────────────────
 * Pulling in and pushing out have genuinely different jobs, so they get different rates:
 *
 *   • **Pulling in is a correctness problem.** Every frame spent longer than permitted is a
 *     frame with geometry through the camera's near plane. Asymmetric rates exist so this
 *     direction can be fast without making the other direction fast too.
 *   • **Pushing out is a feel problem.** A camera that whips back the instant an obstruction
 *     clears is genuinely disorienting; easing out reads as the camera calmly taking up space
 *     again.
 *
 * Collapsing them into one rate forces a choice between visible clipping and a nauseating whip.
 * The GDD's 0.35 in / 0.08 out split is correct, and is preserved here as exponential rates.
 *
 * The catch — which is why this is a function rather than two calls to `damp` — is that the
 * direction is chosen from the *target relative to current*, not from whether an obstruction
 * exists. A camera easing out past a still-present obstruction would otherwise keep pulling in
 * and out against it.
 *
 * @param current - The current boom length.
 * @param target - The permitted boom length from {@link springArmTarget}.
 * @param pullInRate - Rate constant for shortening, in 1/s. Fast.
 * @param pushOutRate - Rate constant for lengthening, in 1/s. Slow.
 * @param dt - Timestep in seconds.
 * @returns The new boom length.
 */
export function advanceSpringArm(
  current: number,
  target: number,
  pullInRate: number,
  pushOutRate: number,
  dt: number,
): number {
  // Direction is chosen from target-versus-current, NOT from whether an obstruction exists.
  // Deciding by "is something blocking us" would make an arm that is still easing outward past a
  // now-present obstruction keep switching rates and judder against it.
  const rate = target < current ? pullInRate : pushOutRate;
  return damp(current, target, rate, dt);
}

// ─────────────────────────────────────────────────────────────────────────────
// PITCH AND ORBIT GEOMETRY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamp a pitch angle into the permitted range.
 *
 * @param pitch - The pitch in radians. Positive is above the horizon.
 * @param minPitch - The lower limit in radians.
 * @param maxPitch - The upper limit in radians.
 * @returns The clamped pitch. Degenerate limits fall back to 0 rather than producing NaN.
 */
export function clampPitch(pitch: number, minPitch: number, maxPitch: number): number {
  if (!Number.isFinite(pitch)) return 0;
  if (!Number.isFinite(minPitch) || !Number.isFinite(maxPitch)) return 0;
  // A reversed pair would clamp every input to one endpoint. Treating it as "no range" is a
  // loud, obvious failure rather than a camera frozen at a strange angle.
  if (minPitch > maxPitch) return 0;
  return Math.min(maxPitch, Math.max(minPitch, pitch));
}

/**
 * The unit vector from the orbit pivot out to the camera.
 *
 * ─── THE CONVENTION, STATED EXPLICITLY BECAUSE IT IS EASY TO GET BACKWARDS ──────────
 * Yaw is measured from +Z, matching the character controller's `facing` and three.js's
 * `rotation.y` for an object whose local forward is +Z. So at `yaw = 0` the camera looks along
 * +Z, and the camera itself sits at -Z relative to the pivot.
 *
 * Positive pitch raises the camera, which makes it look *down*. That is deliberate: the game is
 * about watching your footing, so the GDD's asymmetric pitch range allows more down-look than
 * up-look.
 *
 * @param yaw - The camera's facing yaw in radians.
 * @param pitch - The pitch in radians. Positive is above.
 * @returns A unit vector from the pivot toward the camera.
 */
export function orbitDirection(yaw: number, pitch: number): Vec3 {
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return { x: 0, y: 0, z: -1 };
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

/**
 * The camera's rightward unit vector in the world, given its yaw.
 *
 * ─── DERIVATION, BECAUSE A SIGN ERROR HERE IS A SUBTLE, ANNOYING BUG ────────────────
 * In a right-handed Y-up frame, `right = forward × up`. With `forward = (sin y, 0, cos y)` and
 * `up = (0, 1, 0)`:
 *
 *     right = (sin y, 0, cos y) × (0, 1, 0) = (-cos y, 0, sin y)
 *
 * Sanity check against a known case: facing -Z (yaw = π) must give right = +X, which is the
 * screen-right direction for a camera looking into the screen. `(-cos π, 0, sin π) = (1, 0, 0)`.
 * Correct.
 *
 * The opposite sign puts the over-the-shoulder camera on the player's *left*, which does not
 * look broken — it just looks wrong, forever, and nobody can say why.
 *
 * @param yaw - The yaw in radians.
 * @returns A unit vector pointing to the camera's right.
 */
export function rightDirection(yaw: number): Vec3 {
  if (!Number.isFinite(yaw)) return { x: 1, y: 0, z: 0 };
  return { x: -Math.cos(yaw), z: Math.sin(yaw), y: 0 };
}

/**
 * The camera's position for a given orbit.
 *
 * @param pivot - The point being orbited.
 * @param yaw - Camera yaw in radians.
 * @param pitch - Camera pitch in radians.
 * @param distance - Boom length in metres.
 * @param shoulderOffset - Lateral offset to the camera's right, in metres. Positive puts the
 *   camera on the right of the character, which frames the character to the left — the
 *   over-the-shoulder composition the GDD specifies.
 * @returns The camera position in world space.
 */
export function orbitPosition(
  pivot: Vec3,
  yaw: number,
  pitch: number,
  distance: number,
  shoulderOffset: number,
): Vec3 {
  const direction = orbitDirection(yaw, pitch);
  const right = rightDirection(yaw);

  return {
    x: pivot.x + direction.x * distance + right.x * shoulderOffset,
    y: pivot.y + direction.y * distance + right.y * shoulderOffset,
    z: pivot.z + direction.z * distance + right.z * shoulderOffset,
  };
}

/**
 * The world-space point the camera should look at, for an over-the-shoulder framing.
 *
 * ─── WHY THIS IS NOT SIMPLY THE PIVOT ───────────────────────────────────────────────
 * Aiming the camera *at* the player is the obvious implementation and it is wrong for an
 * over-the-shoulder camera. Because the camera is offset to the right, aiming at the character
 * rotates the view inward, so the character sits dead centre and the whole screen yaws slightly
 * every time the shoulder offset changes — which it does whenever the player aims.
 *
 * An over-the-shoulder camera looks *forward*, parallel to the movement direction, so the
 * character is offset in frame and the world ahead stays centred. That means the look target is
 * the camera's own position plus the view direction (the reverse of the orbit offset), which is
 * exactly what this computes.
 *
 * @param cameraPosition - The camera's world position.
 * @param yaw - Camera yaw in radians.
 * @param pitch - Camera pitch in radians.
 * @param lookAheadDistance - How far along the view direction to aim. Any positive value gives
 *   the same orientation; 1 is used for numerical comfort.
 * @returns The world point to look at.
 */
export function lookTarget(
  cameraPosition: Vec3,
  yaw: number,
  pitch: number,
  lookAheadDistance: number,
): Vec3 {
  const direction = orbitDirection(yaw, pitch);
  const ahead = Number.isFinite(lookAheadDistance) && lookAheadDistance > 0 ? lookAheadDistance : 1;

  // The view direction is the reverse of the pivot-to-camera direction.
  return {
    x: cameraPosition.x - direction.x * ahead,
    y: cameraPosition.y - direction.y * ahead,
    z: cameraPosition.z - direction.z * ahead,
  };
}

/**
 * Raise a camera's height to the ground clamp, if it is below it.
 *
 * @param cameraY - The camera's proposed world Y.
 * @param groundY - The world Y of the ground beneath the camera, or `-Infinity` when unknown.
 * @param clearance - The minimum height above that ground.
 * @returns The clamped Y.
 */
export function applyGroundClamp(cameraY: number, groundY: number, clearance: number): number {
  if (!Number.isFinite(cameraY)) return 0;
  if (!Number.isFinite(groundY) || !Number.isFinite(clearance)) return cameraY;
  return Math.max(cameraY, groundY + clearance);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXTUAL MODES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The camera's contextual modes, from GDD §5.3.
 *
 * Declared in priority order, highest first. `resolveCameraMode` relies on that ordering, so
 * reordering this enum silently changes which mode wins a conflict.
 */
export enum CameraMode {
  /** Story beats: a scripted spline transform, with player camera input disabled. */
  Cinematic = 'cinematic',
  /** Riding a zip line. */
  ZipLine = 'zip-line',
  /** Submerged. */
  Water = 'water',
  /** Mid-mantle. */
  Mantle = 'mantle',
  /** Climbing or hanging: pull back and look up the wall. */
  Climb = 'climb',
  /** Aiming: centre behind the weapon, narrow the FOV. */
  Aim = 'aim',
  /** Inside an authored narrow-corridor volume. */
  Tunnel = 'tunnel',
  /** The default third-person framing. */
  Default = 'default',
}

/** Which contextual modes are currently active. */
export interface CameraModeTriggers {
  cinematic: boolean;
  onZipLine: boolean;
  submerged: boolean;
  mantling: boolean;
  climbingOrHanging: boolean;
  aiming: boolean;
  inTunnel: boolean;
}

/** A trigger set with nothing active. */
export const NO_TRIGGERS: CameraModeTriggers = {
  cinematic: false,
  onZipLine: false,
  submerged: false,
  mantling: false,
  climbingOrHanging: false,
  aiming: false,
  inTunnel: false,
};

/**
 * Resolve exactly one active camera mode from a set of triggers.
 *
 * Returns a single value rather than a set, which is what makes the GDD's claim that "ties are
 * impossible by construction" true rather than aspirational: there is no representation in which
 * two modes are both active, so a conflict cannot be expressed.
 *
 * @param triggers - Which conditions currently hold.
 * @returns The highest-priority active mode, or `Default`.
 */
export function resolveCameraMode(triggers: CameraModeTriggers): CameraMode {
  // Ordered exactly as GDD §5.3 lists it. A table rather than a chain of ifs so the priority
  // order is visible as data and cannot be scrambled by a careless edit.
  const priority: ReadonlyArray<{ mode: CameraMode; active: boolean }> = [
    { mode: CameraMode.Cinematic, active: triggers.cinematic },
    { mode: CameraMode.ZipLine, active: triggers.onZipLine },
    { mode: CameraMode.Water, active: triggers.submerged },
    { mode: CameraMode.Mantle, active: triggers.mantling },
    { mode: CameraMode.Climb, active: triggers.climbingOrHanging },
    { mode: CameraMode.Aim, active: triggers.aiming },
    { mode: CameraMode.Tunnel, active: triggers.inTunnel },
  ];

  for (const entry of priority) {
    if (entry.active) return entry.mode;
  }
  return CameraMode.Default;
}

/** The framing parameters a mode asks for. All of these are damped, never cut. */
export interface CameraFraming {
  /** Boom length in metres. */
  distance: number;
  /** Vertical field of view in degrees. */
  fovDeg: number;
  /** Lateral over-the-shoulder offset in metres. */
  shoulderOffset: number;
  /** Extra pitch added to the player's input pitch, in radians. */
  pitchBias: number;
  /** Vertical offset added to the pivot, in metres. */
  heightOffset: number;
}

/**
 * The framing a mode asks for, from the GDD §5.3 table.
 *
 * @param mode - The active mode.
 * @param defaults - The base framing values, typically read from `constants.ts`. Passed in rather
 *   than imported so this module stays dependency-free.
 * @returns The target framing for the mode.
 */
export function framingForMode(
  mode: CameraMode,
  defaults: CameraFraming & {
    aimDistance: number;
    aimFovDeg: number;
    aimShoulderOffset: number;
    tunnelDistance: number;
    tunnelFovDeg: number;
    climbDistance: number;
    zipLineDistance: number;
    climbPitchBias: number;
    zipLinePitchBias: number;
    mantlePullBack: number;
    mantleRaise: number;
  },
): CameraFraming {
  switch (mode) {
    case CameraMode.Aim:
      return {
        distance: defaults.aimDistance,
        fovDeg: defaults.aimFovDeg,
        shoulderOffset: defaults.aimShoulderOffset,
        pitchBias: 0,
        heightOffset: 0,
      };

    case CameraMode.Climb:
      // Shoulder offset drops to 0 so the player is centred against the wall, and the pitch
      // biases upward: you need to see where you are going, not the wall in front of your face.
      return {
        distance: defaults.climbDistance,
        fovDeg: defaults.fovDeg,
        shoulderOffset: 0,
        pitchBias: defaults.climbPitchBias,
        heightOffset: 0,
      };

    case CameraMode.Mantle:
      return {
        distance: defaults.distance + defaults.mantlePullBack,
        fovDeg: defaults.fovDeg,
        shoulderOffset: defaults.shoulderOffset,
        pitchBias: 0,
        heightOffset: defaults.mantleRaise,
      };

    case CameraMode.Tunnel:
      return {
        distance: defaults.tunnelDistance,
        fovDeg: defaults.tunnelFovDeg,
        shoulderOffset: defaults.shoulderOffset,
        pitchBias: 0,
        heightOffset: 0,
      };

    case CameraMode.ZipLine:
      return {
        distance: defaults.zipLineDistance,
        fovDeg: defaults.fovDeg,
        shoulderOffset: defaults.shoulderOffset,
        pitchBias: defaults.zipLinePitchBias,
        heightOffset: 0,
      };

    case CameraMode.Water:
      // Framing is unchanged; the water treatment is a positional wobble and an FOV breath,
      // applied by the rig on top of the default framing.
      return {
        distance: defaults.distance,
        fovDeg: defaults.fovDeg,
        shoulderOffset: defaults.shoulderOffset,
        pitchBias: 0,
        heightOffset: 0,
      };

    case CameraMode.Cinematic:
      // A cinematic drives the transform from a scripted spline. The framing here is what the
      // rig cross-fades *from* when the cinematic begins, so it is deliberately the default
      // rather than something invented.
      return {
        distance: defaults.distance,
        fovDeg: defaults.fovDeg,
        shoulderOffset: defaults.shoulderOffset,
        pitchBias: 0,
        heightOffset: 0,
      };

    case CameraMode.Default:
    default:
      return {
        distance: defaults.distance,
        fovDeg: defaults.fovDeg,
        shoulderOffset: defaults.shoulderOffset,
        pitchBias: 0,
        heightOffset: 0,
      };
  }
}

/**
 * Damp one framing toward another, component by component.
 *
 * All mode transitions are lerped, never cut, per GDD §5.3.
 *
 * @param current - The current framing.
 * @param target - The framing to approach.
 * @param rate - The rate constant λ in 1/s.
 * @param dt - Timestep in seconds.
 * @returns The new framing.
 */
export function dampFraming(
  current: CameraFraming,
  target: CameraFraming,
  rate: number,
  dt: number,
): CameraFraming {
  return {
    distance: damp(current.distance, target.distance, rate, dt),
    fovDeg: damp(current.fovDeg, target.fovDeg, rate, dt),
    shoulderOffset: damp(current.shoulderOffset, target.shoulderOffset, rate, dt),
    pitchBias: dampAngle(current.pitchBias, target.pitchBias, rate, dt),
    heightOffset: damp(current.heightOffset, target.heightOffset, rate, dt),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-ROTATION, THE STUCK DETECTOR, AND THE DEADZONE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether auto-rotation should be running.
 *
 * Auto-rotation exists so a player walking a long straight path does not have to hold the camera
 * straight. It must never fight a player who is actively looking around, which is why it is
 * gated on elapsed idleness rather than on whether the yaw happens to be misaligned.
 *
 * @param secondsSinceLookInput - Seconds since the last camera input. Negative values are
 *   treated as "just now".
 * @param delaySeconds - How long to wait.
 * @returns True when auto-rotation should run this tick.
 */
export function shouldAutoRotate(
  secondsSinceLookInput: number,
  delaySeconds: number,
): boolean {
  if (!Number.isFinite(secondsSinceLookInput) || secondsSinceLookInput < 0) return false;
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) return true;
  return secondsSinceLookInput >= delaySeconds;
}

/**
 * Advance a yaw toward a target at a fixed angular rate.
 *
 * Rate-limited rather than damped, because the GDD specifies a speed ("1.2 rad/s") rather than a
 * smoothing factor. A rate limit also guarantees the rotation cannot outrun the player's own
 * turning, which a damping factor would not.
 *
 * @param currentYaw - Current yaw in radians.
 * @param targetYaw - Target yaw in radians.
 * @param rateRadPerSecond - Maximum angular speed.
 * @param dt - Timestep in seconds.
 * @returns The new yaw, wrapped, taking the short way around.
 */
export function rotateToward(
  currentYaw: number,
  targetYaw: number,
  rateRadPerSecond: number,
  dt: number,
): number {
  if (!Number.isFinite(currentYaw) || !Number.isFinite(targetYaw)) return currentYaw;
  if (!Number.isFinite(rateRadPerSecond) || rateRadPerSecond <= 0) return currentYaw;
  if (!Number.isFinite(dt) || dt <= 0) return currentYaw;

  const twoPi = Math.PI * 2;
  let difference = (targetYaw - currentYaw) % twoPi;
  if (difference > Math.PI) difference -= twoPi;
  if (difference < -Math.PI) difference += twoPi;

  const maxStep = rateRadPerSecond * dt;
  if (Math.abs(difference) <= maxStep) return wrapAngle(targetYaw);
  return wrapAngle(currentYaw + Math.sign(difference) * maxStep);
}

/**
 * Whether the stuck detector should force a camera reset.
 *
 * ─── WHY A STUCK DETECTOR EXISTS AT ALL ─────────────────────────────────────────────
 * Everything else in the spring arm is a smoothing strategy, and every smoothing strategy has
 * inputs it cannot fix. A player wedged into a corner where *every* direction is inside geometry
 * leaves the arm pinned at its minimum distance, and no amount of damping improves that: the
 * camera is stuck and the player may not even be able to tell which way is out.
 *
 * The detector is therefore not a nicety but the system's *guarantee of escape* — the one
 * mechanism that says "however bad the geometry gets, the camera will resolve within a bounded
 * time". Two independent conditions trigger it, because they cover different failures: being
 * pinned at minimum distance (the arm is blocked in every direction) and being inside geometry
 * (the arm is not blocked but the camera is penetrating anyway, which happens when an obstruction
 * appears *between* ticks or when the near plane reaches past the skin).
 *
 * @param secondsAtMinimumDistance - How long the arm has been pinned.
 * @param secondsPenetrating - How long the camera has been inside geometry.
 * @param minDistanceTimeoutS - The pin timeout.
 * @param penetrationTimeoutS - The penetration timeout.
 * @returns True when a reset should be forced.
 */
export function shouldForceCameraReset(
  secondsAtMinimumDistance: number,
  secondsPenetrating: number,
  minDistanceTimeoutS: number,
  penetrationTimeoutS: number,
): boolean {
  if (Number.isFinite(secondsAtMinimumDistance) && secondsAtMinimumDistance >= minDistanceTimeoutS) {
    return true;
  }
  if (Number.isFinite(secondsPenetrating) && secondsPenetrating >= penetrationTimeoutS) {
    return true;
  }
  return false;
}

/**
 * Apply a radial deadzone to a stick, rescaling the live region so there is no jump at the edge.
 *
 * ─── WHY THIS IS MATH AND NOT AN `if` ───────────────────────────────────────────────
 * The GDD calls this out as "a genuinely common reported bug in shipped games", and the reason is
 * that the obvious implementation is subtly wrong. Two failure modes:
 *
 *   1. **Per-axis deadzones** create a cross-shaped dead region, so pushing diagonally registers
 *      when pushing straight up does not. Players feel this as "the stick is broken in the
 *      corners" and cannot describe it.
 *   2. **A hard cutoff without rescaling** makes the output jump from 0 to `deadzone` the instant
 *      the stick crosses the threshold, which is a visible lurch and defeats the point of a soft
 *      region.
 *
 * This applies one radial deadzone and rescales the remaining range back to [0, 1], so the
 * response is continuous and reaches full magnitude at the stick's physical limit.
 *
 * @param x - Raw stick X in [-1, 1].
 * @param y - Raw stick Y in [-1, 1].
 * @param deadzone - The radial deadzone radius in [0, 1).
 * @returns The filtered stick, with magnitude 0 inside the deadzone and continuous beyond it.
 */
export function applyRadialDeadzone(x: number, y: number, deadzone: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };

  const magnitude = Math.hypot(x, y);
  if (!Number.isFinite(deadzone) || deadzone <= 0) return { x, y };
  // A deadzone at or beyond full deflection would make the stick permanently dead. Refusing to
  // apply it is better than a controller that does nothing.
  if (deadzone >= 1) return { x: 0, y: 0 };

  if (magnitude <= deadzone) return { x: 0, y: 0 };

  const rescaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
  return {
    x: (x / magnitude) * rescaled,
    y: (y / magnitude) * rescaled,
  };
}

/**
 * The water mode's positional wobble.
 *
 * Deliberately tiny — the GDD asks for 0.05 rad, which is under three degrees — because its job
 * is to signal *submerged* at the edge of perception, not to make the player seasick.
 *
 * @param elapsedSeconds - Seconds since entering the water.
 * @param frequencyHz - Wobble frequency.
 * @param amplitudeRad - Peak angular deviation.
 * @param phase - Which of the two wobble axes to sample. 0 and π/2 give a circular motion.
 * @returns The angular offset in radians.
 */
export function waterWobble(
  elapsedSeconds: number,
  frequencyHz: number,
  amplitudeRad: number,
  phase: number,
): number {
  if (!Number.isFinite(elapsedSeconds) || !Number.isFinite(frequencyHz)) return 0;
  if (!Number.isFinite(amplitudeRad) || !Number.isFinite(phase)) return 0;
  return Math.sin(elapsedSeconds * frequencyHz * Math.PI * 2 + phase) * amplitudeRad;
}
