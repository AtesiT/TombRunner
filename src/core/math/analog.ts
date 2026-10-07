/**
 * Analogue signal shaping: the mathematics that turns raw controller and mouse values into the
 * numbers gameplay systems consume.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS SEPARATELY FROM THE TWO SYSTEMS THAT USE IT
 * ────────────────────────────────────────────────────────────────────────────────────
 * The radial deadzone was written for the camera in Milestone 1.3 and lived in
 * `core/math/camera.ts`. Milestone 1.4 needs the identical function for the movement stick, and at
 * that point the input system would have had to import camera mathematics to filter a joystick.
 * That dependency looks harmless and is not: it makes the input layer a consumer of the camera's
 * conventions, so a future change to how the camera thinks about its look axis would silently
 * change how the character walks.
 *
 * The functions here are shared *because they are the same function*, not because they happen to
 * be similar. Anything that ends up here has to be genuinely device-agnostic — it takes numbers and
 * returns numbers, and knows nothing about cameras, characters or frames.
 */

/** A two-axis analogue reading, such as a stick or a mouse delta. Device space. */
export interface Analog2D {
  x: number;
  y: number;
}

/**
 * A horizontal direction in world space.
 *
 * Deliberately its own type rather than `Analog2D`. Input readings live in *device* space (x/y),
 * world directions live in the *ground plane* (x/z), and the whole point of the transform between
 * them is that they are different spaces. Sharing one type makes it possible to pass a world
 * direction where a stick reading is expected, and the resulting bug is a character that walks in
 * the wrong direction only when the camera is turned — which the initial draft of this module
 * caused by returning `{ x, z }` from a function typed `Analog2D` and silencing the compiler with
 * a cast. The type is the documentation; it is not worth bodging to save an interface.
 */
export interface WorldDirection {
  x: number;
  z: number;
}

/**
 * Apply a radial deadzone to a two-axis analogue input, rescaling so the output is continuous.
 *
 * ─── WHY RADIAL, AND WHY THE RESCALE IS NOT OPTIONAL ────────────────────────────────
 * A **per-axis** deadzone creates a cross-shaped dead region: pushing the stick straight up
 * registers while pushing it diagonally does not, even at a greater total deflection. Players feel
 * this as "the stick is broken in the corners" and cannot describe it. A radial deadzone treats
 * every direction identically, which is the only property that matches how a stick physically
 * behaves.
 *
 * The **rescale** is what makes the deadzone's edge invisible. Without it, output jumps from 0 to
 * `deadzone` the instant the stick crosses the threshold — the stick appears to catch, and the
 * soft region the deadzone exists to create is destroyed. Rescaling the remaining range onto
 * [0, 1] keeps the output continuous at the boundary while still reaching full magnitude at full
 * deflection.
 *
 * The GDD names this mechanism explicitly (GDD §5.4, edge case 10): a stick resting off-centre must
 * not slowly rotate the camera. The player cannot reproduce that bug and cannot describe it, which
 * makes it exactly the class of defect worth preventing in one shared, tested function.
 *
 * @param x - Horizontal axis, conventionally -1 (left) to +1 (right).
 * @param y - Vertical axis, conventionally -1 (down) to +1 (up). The contract is sign-agnostic;
 *   callers own their own conventions.
 * @param deadzone - Radius below which the input is treated as zero, in the same units as the axes.
 * @returns The filtered and rescaled axes. Zero inside the deadzone; unit length or less outside.
 */
export function applyRadialDeadzone(x: number, y: number, deadzone: number): Analog2D {
  // A non-finite axis is a broken device or a broken driver. Zero is the only safe output: a NaN
  // here would propagate into a character's position or a camera's yaw and never recover.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };

  const magnitude = Math.hypot(x, y);

  // A non-positive deadzone means "no filtering", which must pass the input through *unchanged*
  // rather than normalising it — a caller asking for no deadzone is not asking for unit length.
  if (!Number.isFinite(deadzone) || deadzone <= 0) return { x, y };

  // A deadzone at or beyond full deflection makes the stick permanently dead. There is no correct
  // answer here and a controller that does nothing is the worst available outcome, so this refuses
  // rather than merely being wrong quietly.
  if (deadzone >= 1) return { x: 0, y: 0 };

  if (magnitude <= deadzone) return { x: 0, y: 0 };

  const rescaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone));

  // Direction is preserved exactly by dividing by the original magnitude. A deadzone must change
  // how *much* the player is pushing, never *where* they are pushing.
  return {
    x: (x / magnitude) * rescaled,
    y: (y / magnitude) * rescaled,
  };
}

/**
 * Shape an analogue trigger reading into a [0, 1] magnitude, discarding its rest offset.
 *
 * ─── WHY A TRIGGER NEEDS ITS OWN DEADZONE ───────────────────────────────────────────
 * Digital triggers are exact 0 or 1 and need nothing. Analogue triggers are not: they report a
 * small non-zero value at rest on real hardware — typically because the mechanism rests under its
 * own spring load — and browsers do not normalise it. Without a trigger-specific deadzone a
 * resting trigger reads as "held", so a player who is not touching the controller is permanently
 * aiming.
 *
 * The at-rest value is device-specific, so the threshold is a parameter rather than a constant
 * baked in here; the input layer owns the tuning.
 *
 * @param raw - The trigger's reported value, nominally 0 (released) to 1 (fully pulled).
 * @param restThreshold - Value at or below which the trigger counts as released.
 * @returns 0 when released, otherwise the deflection rescaled to [0, 1].
 */
export function normalizeTrigger(raw: number, restThreshold: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (!Number.isFinite(restThreshold) || restThreshold <= 0) {
    return Math.max(0, Math.min(1, raw));
  }

  // A threshold at or above the full pull would make the trigger permanently dead.
  if (restThreshold >= 1) return 0;

  if (raw <= restThreshold) return 0;

  return Math.min(1, (raw - restThreshold) / (1 - restThreshold));
}

/**
 * Resolve two competing movement sources into one direction and magnitude.
 *
 * ─── WHY THE LARGER MAGNITUDE WINS, RATHER THAN THE SUM ─────────────────────────────
 * The keyboard and a controller can both be live at once, and this is not a corner case: a player
 * holding W while their other hand pushes a stick is common, and so is a stick that is being
 * nudged while a key is held. Adding the two vectors lets a half-deflected stick add to a
 * full-magnitude key and produce a magnitude above 1, which the character controller would then
 * have to clamp — moving the arbitration into a system that has no business knowing two devices
 * exist.
 *
 * Taking the larger *magnitude* and its direction means the faster source always wins, the two can
 * never fight, and the result is always within the [0, 1] the controller documents. Ties prefer
 * the first argument, so the caller controls precedence on equal pushes.
 *
 * @param primary - The first source, conventionally the keyboard or the more explicit device.
 * @param secondary - The second source.
 * @returns The winning direction and its magnitude.
 */
export function resolveMovement(
  primary: Analog2D,
  secondary: Analog2D,
): { direction: Analog2D; magnitude: number } {
  const primaryMagnitude = Number.isFinite(primary.x) && Number.isFinite(primary.y)
    ? Math.hypot(primary.x, primary.y)
    : 0;
  const secondaryMagnitude =
    Number.isFinite(secondary.x) && Number.isFinite(secondary.y)
      ? Math.hypot(secondary.x, secondary.y)
      : 0;

  const winner = secondaryMagnitude > primaryMagnitude ? secondary : primary;
  const magnitude = Math.max(primaryMagnitude, secondaryMagnitude);

  if (magnitude <= 1e-6) return { direction: { x: 0, y: 0 }, magnitude: 0 };

  // Re-normalised rather than returned as-is, so the magnitude is carried separately from the
  // direction and a caller cannot accidentally apply the magnitude twice.
  return {
    direction: { x: winner.x / magnitude, y: winner.y / magnitude },
    magnitude: Math.min(1, magnitude),
  };
}

/**
 * Rotate a stick reading into world space, relative to where the camera is looking.
 *
 * ─── WHY MOVEMENT IS CAMERA-RELATIVE, AND WHY THIS LIVES HERE ───────────────────────
 * `CharacterIntent.moveDirection` is documented as world space, and `CharacterController`
 * deliberately does not read the camera. The transform from "the player pushed forward" to "walk
 * that way in the world" therefore has to happen somewhere, and the input layer is the only place
 * that knows both the device state and the camera's yaw.
 *
 * Without it, W would mean "move north", which is wrong in a third-person game the moment the
 * player turns the camera: the character would strafe across the screen instead of walking away
 * from it. Every third-person game since the N64 era maps forward to camera-forward, and the
 * player's hands already expect it.
 *
 * ─── THE CONVENTION ─────────────────────────────────────────────────────────────────
 * `stick.y = +1` means "away from the camera" (which is what W does) and `stick.x = +1` means
 * "the player's right". The camera yaw is measured from world +Z toward +X, matching
 * `core/math/camera.ts`, and the camera sits *behind* its pivot, so camera-forward is
 * `(sin yaw, cos yaw)`.
 *
 * Right is that vector rotated -90 degrees about +Y — which, working through the rotation, gives
 * `(cos yaw, -sin yaw)`. The sign of the z component is the one that is easy to get backwards, and
 * getting it backwards does not produce an obvious bug: it produces a character that walks
 * correctly forward and backwards and sideways-inverted, which players report as "strafing feels
 * wrong" and cannot pin down.
 *
 * @param stick - The already-deadzoned stick reading. +y is forward, +x is right.
 * @param cameraYaw - The camera's yaw in radians, measured from +Z toward +X.
 * @returns A world-space direction with unit length, or zero when there is no input.
 */
export function stickToWorldDirection(stick: Analog2D, cameraYaw: number): WorldDirection {
  const magnitude = Math.hypot(stick.x, stick.y);
  if (!Number.isFinite(magnitude) || magnitude <= 1e-6) return { x: 0, z: 0 };

  const yaw = Number.isFinite(cameraYaw) ? cameraYaw : 0;

  const forwardX = Math.sin(yaw);
  const forwardZ = Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);

  const rawX = forwardX * stick.y + rightX * stick.x;
  const rawZ = forwardZ * stick.y + rightZ * stick.x;

  const length = Math.hypot(rawX, rawZ);

  // The input direction is diagonal and the two basis vectors are unit length, so this is only
  // reachable through floating-point drift. Guarded anyway: a zero-length normalisation would
  // produce a NaN world direction, which the controller would then integrate.
  if (length <= 1e-9) return { x: 0, z: 0 };

  return { x: rawX / length, z: rawZ / length };
}
