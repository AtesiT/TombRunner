/**
 * Central tuning constants for Jungle Relic.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * The code review protocol forbids magic numbers in gameplay code. Every tunable
 * value in the game lives here, named, typed, documented, and with its unit encoded
 * in the identifier (`_MPS` = metres per second, `_TICKS` = simulation ticks, `_S` =
 * seconds, `_M` = metres, `_DEG` = degrees, `_RAD` = radians).
 *
 * Sources of truth: docs/GAME_DESIGN_DOC.md §4-§10 and docs/ARCHITECTURE.md §4.2.
 * Changing a value here must be reflected in the GDD and, where a test asserts the
 * value numerically, matched by the corresponding test.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATION
// ─────────────────────────────────────────────────────────────────────────────

/** Fixed simulation timestep: 60 Hz. Physics must never use a variable dt. */
export const FIXED_DT = 1 / 60;

/** Simulation rate in ticks per second, derived for readability. */
export const TICK_RATE = 60;

/**
 * Maximum real time folded into the accumulator in a single frame.
 *
 * After an alt-tab or a GC hitch an unclamped accumulator queues hundreds of ticks
 * and the game "fast-forwards" — the player clips through walls at 40x speed.
 * Clamping trades a lost half-second of simulation for a guaranteed-correct one.
 */
export const MAX_FRAME_DELTA_S = 0.25;

/** End of the authored level. Falling below this triggers the R14 kill-plane respawn. */
export const KILL_PLANE_Y = -30;

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER LOCOMOTION (GDD §4)
// ─────────────────────────────────────────────────────────────────────────────

/** Exploration speed. */
export const WALK_SPEED_MPS = 2.0;

/** Default traversal speed. There is no sprint modifier and no stamina system. */
export const RUN_SPEED_MPS = 6.0;

/** Time to accelerate from rest to run speed (~20 m/s²). */
export const ACCELERATION_TIME_S = 0.3;

/** Time to decelerate from run speed to rest (~15 m/s²). Measured feel: 52° ≈ 15 m/s². */
export const DECELERATION_TIME_S = 0.4;

/** Fraction of ground acceleration available while airborne. */
export const AIR_CONTROL_FACTOR = 0.55;

/** Ground turning rate. */
export const TURN_RATE_GROUND_DEG = 540;

/** Airborne turning rate — commitment in the air. */
export const TURN_RATE_AIR_DEG = 220;

/** Turning rate while aiming. Deliberately restricted: aiming is a commitment. */
export const TURN_RATE_AIM_DEG = 300;

/** Gravity while rising. Deliberately lower than falling gravity for a snappy feel. */
export const GRAVITY_RISING_MPS2 = 26;

/** Gravity while falling. Heavy descent is what makes platforming feel precise. */
export const GRAVITY_FALLING_MPS2 = 42;

/** Multiplier applied to rising gravity while the jump button is held. */
export const JUMP_HOLD_GRAVITY_SCALE = 0.75;

/** Terminal velocity, chosen to prevent tunnelling and unrecoverable falls. */
export const TERMINAL_VELOCITY_MPS = 45;

/** Peak height of a standing jump. */
export const JUMP_HEIGHT_STANDING_M = 2.0;

/** Peak height of a running jump. */
export const JUMP_HEIGHT_RUNNING_M = 2.5;

/** Peak height of a tapped (early-released) jump. */
export const JUMP_HEIGHT_TAPPED_M = 1.4;

/** Minimum time between jumps. */
export const JUMP_COOLDOWN_S = 0.2;

/** Fraction of upward velocity removed when the jump button is released early. */
export const JUMP_RELEASE_CUT = 0.45;

/**
 * Ground speed multiplier while crouching.
 *
 * A crouch-walk, slow enough to read as deliberate but not so slow that traversing a tunnel
 * becomes tedious. It also multiplies into the jump lock in edge case 1, so crouch is a real
 * movement mode rather than only a jump suppressor.
 */
export const CROUCH_SPEED_SCALE = 0.35;

/** Horizontal distance a standing jump must clear, from the GDD. */
export const JUMP_STANDING_DISTANCE_M = 3.0;

/** Horizontal distance a full-speed running jump must clear, from the GDD. */
export const JUMP_RUNNING_DISTANCE_M = 6.0;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DERIVED JUMP CONSTANTS — documentation and test references, not runtime inputs
 * ─────────────────────────────────────────────────────────────────────────────
 * The character controller does NOT read these at runtime. It calls `solveJumpLaunch()`
 * (src/core/math/locomotion.ts), which derives the takeoff velocities from the targets and
 * the actual gravity profile. These constants exist so the derived numbers are visible in
 * the tuning table and so the tests can assert the solver still reproduces them.
 *
 * **If a test here fails, the solver changed — do not "fix" it by editing these values.**
 *
 * ─── WHY A FORWARD IMPULSE EXISTS AT ALL ────────────────────────────────────────────
 * With the GDD's asymmetric gravity, a 6 m/s run produces only 4.70 m of jump travel at a
 * 2.5 m peak, so the GDD's 6 m running jump is *unreachable* at run speed. The options were:
 *
 *   • Weaken gravity — rejected. It would make the jump floaty and undo the entire point of
 *     asymmetric gravity, which is the single largest contributor to the TR2013 feel.
 *   • Raise run speed past 6 m/s — rejected. It would make ground movement frantic and
 *     contradict the GDD's own walk/run numbers.
 *   • A forward impulse at takeoff — chosen. A running jump thrusts forward, which is what
 *     momentum-based platformers do and what the GDD's requirement that a running jump goes
 *     further than a standing one is actually describing.
 *
 * ─── THE HOLD-GRAVITY CORRECTION ────────────────────────────────────────────────────
 * `JUMP_HOLD_GRAVITY_SCALE` (0.75) softens the rise while the control is held, so the arc
 * must be solved against the *scaled* gravity. Solving against nominal gravity made a held
 * jump peak at `2.0 / 0.75 = 2.67 m` instead of 2.0 m and raised its airtime from 0.701 s
 * to 0.879 s, which then overshot the distance target by 26%. Measured, not theorised.
 *
 * ─── THE DISCRETE-INTEGRATOR CORRECTION ─────────────────────────────────────────────
 * The controller integrates with semi-implicit Euler, which peaks `v0·dt/2` above the
 * target: 8.6 cm on the 2.0 m jump, measured. `discreteTakeoffVelocity()` compensates, and
 * airtime is counted in *whole ticks* so the distance target is exact on the tick grid
 * rather than 0.19 of a tick short. The figures below are the compensated held values.
 *
 *   Standing, held: v0 8.671, 27+19 ticks, airtime 0.7667 s -> 3.0 m needs 3.9130 m/s
 *   Running,  held: v0 9.713, 30+21 ticks, airtime 0.8500 s -> 6.0 m needs 7.0588 m/s
 *
 * Measured end-to-end on the real controller: standing 2.997 m / 2.000 m peak, running
 * 6.109 m / 2.498 m peak (the extra 0.109 m is one tick of post-landing running).
 */

/** Reference horizontal launch speed for a standing jump at the solved arc. */
export const JUMP_STANDING_SPEED_MPS = 3.913;

/** Reference horizontal launch speed for a full-speed running jump at the solved arc. */
export const JUMP_RUNNING_SPEED_MPS = 7.0588;

/** Reference airtime of a held standing jump, in seconds (46 ticks). */
export const JUMP_STANDING_AIRTIME_S = 0.7667;

/** Reference airtime of a held running jump, in seconds (51 ticks). */
export const JUMP_RUNNING_AIRTIME_S = 0.85;

/** Danger threshold: below this many ticks of airtime a jump would feel unresponsive. */
export const JUMP_MIN_AIRTIME_TICKS = 20;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * INPUT ASSISTANCE — the "forgiveness layer" (GDD §4.3)
 * ─────────────────────────────────────────────────────────────────────────────

/**
 * Coyote time: how long a jump remains legal after leaving a ledge.
 * Expressed in ticks (not seconds) so the window is framerate-independent.
 */
export const COYOTE_TICKS = 8; // 8 ticks @ 60 Hz = 133 ms ≈ the 120 ms design target

/** Jump buffering: how long a jump input is remembered before landing. */
export const JUMP_BUFFER_TICKS = 9; // 9 ticks @ 60 Hz = 150 ms, exact design target

/** Interact buffering: remembered before the player comes into range. */
export const INTERACT_BUFFER_TICKS = 12; // 200 ms

/** Attack buffering: remembered before the fire cooldown expires. */
export const ATTACK_BUFFER_TICKS = 6; // 100 ms

/** Ledges within this vertical error of a failed jump snap to a ledge grab instead. */
export const LEDGE_ASSIST_M = 0.3;

/** Obstacles this much narrower than the capsule lip are nudged past while rising. */
export const CORNER_CORRECTION_M = 0.25;

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER CAPSULE AND CONTROLLER GEOMETRY
// ─────────────────────────────────────────────────────────────────────────────
// Declared HERE, above the ground-detection block, because the probe's ray length is
// derived from these values. `const` declarations are hoisted but not initialised, so a
// module that reads them earlier than their declaration throws a ReferenceError in the
// temporal dead zone at import time — which would present as the entire game failing to
// load, with the error pointing at a constants file.

/** Rapier character controller skin width. */
export const CONTROLLER_OFFSET_M = 0.02;
/** Capsule half-height (the cylindrical section), excluding the hemispherical caps. */
export const PLAYER_CAPSULE_HALF_HEIGHT_M = 0.6;
/** Capsule radius. */
export const PLAYER_CAPSULE_RADIUS_M = 0.35;

// ─────────────────────────────────────────────────────────────────────────────
// GROUND DETECTION — 5-ray cone (GDD §4.4)
// ─────────────────────────────────────────────────────────────────────────────

/** Radius of the ray cone around the player origin. */
export const GROUND_PROBE_RADIUS_M = 0.3;

/** Origin height of the probe rays above the player origin (inside the capsule). */
export const GROUND_PROBE_ORIGIN_Y_M = 0.1;

/**
 * Extra reach beneath the capsule's bottom, so uneven terrain and the small floating
 * offset introduced by ground snapping are both covered.
 */
export const GROUND_PROBE_MARGIN_M = 0.2;

/**
 * How far below the probe origin the ground rays look.
 *
 * ─── DERIVED, AND WRONG IN THE GDD (§4.4) UNTIL MEASURED ────────────────────────────
 * The GDD specified this as `capsuleHalfHeight + 0.45` = 1.05 m, which looks reasonable
 * and is *not enough*. The body origin rests `halfHeight + radius + controllerOffset` above
 * the surface, so the distance the ray must cover is that entire height, not just the
 * cylindrical half-height. The GDD's formula omitted the capsule radius and ended up 2 cm
 * short of the ground it was trying to detect — and the originally implemented value of
 * 0.45 m was 1.32 m short, meaning the probe could **never** register ground.
 *
 * The consequence of the bug was instructive: the character fell, was physically caught by
 * Rapier (`computedGrounded()` was true throughout), but the probe reported `grounded:
 * false` on every tick, so the state machine never left `Airborne`. The player could still
 * run around — the controller was simply never told they were standing on anything. A jump
 * therefore never fired, and a "running jump" measured 20 m because the character spent the
 * whole test nominally airborne at run speed.
 *
 * Derived here from the capsule geometry so it can never drift out of step with it again,
 * and asserted by `test/integration/character-controller.test.ts`.
 */
export const GROUND_PROBE_LENGTH_M =
  PLAYER_CAPSULE_HALF_HEIGHT_M +
  PLAYER_CAPSULE_RADIUS_M +
  CONTROLLER_OFFSET_M +
  GROUND_PROBE_MARGIN_M; // = 1.17 m

/**
 * Measured resting height of the player body origin (docs/DEV_LOG.md Doubt #8).
 *
 * 0.95 (capsule half-height 0.6 + radius 0.35) + 0.02 controller offset.
 * Used by the camera ground clamp, foot IK, and ledge thresholds, so it is named
 * rather than inlined — assuming 0.95 here caused a real test failure.
 */
export const PLAYER_RESTING_HEIGHT_M = 0.97;

// ─────────────────────────────────────────────────────────────────────────────
// SLOPE BANDS (GDD §4.5)
// ─────────────────────────────────────────────────────────────────────────────

/** 0-30°: walk normally. */
export const SLOPE_WALK_MAX_DEG = 30;

/** 30-45°: walk slowly, cannot jump. */
export const SLOPE_SLOW_MAX_DEG = 45;

/** 45-60°: slide down. */
export const SLOPE_SLIDE_MAX_DEG = 60;

/** Rapier's climbable limit, deliberately above the GDD's 45° walk band. */
export const SLOPE_CLIMB_LIMIT_DEG = 50;

/** Rapier's slide trigger angle. */
export const SLOPE_SLIDE_TRIGGER_DEG = 38;

/** Speed multiplier while traversing the 30-45° band. */
export const SLOPE_SLOW_SPEED_SCALE = 0.6;

/** Downhill slide speed in the 45-60° band. */
export const SLOPE_SLIDE_SPEED_MPS = 4.0;

// ─────────────────────────────────────────────────────────────────────────────
// MANTLE / LEDGE / TRAVERSAL (GDD §4.6, §7)
// ─────────────────────────────────────────────────────────────────────────────

/** Handled natively by Rapier autostep; the rest needs bespoke code. */
export const AUTOSTEP_MAX_M = 0.4;

/** Rapier autostep minimum walkable width. */
export const AUTOSTEP_MIN_WIDTH_M = 0.25;

/** Bespoke mantle band: 0.4-0.8 m is a committed climb-up. */
export const MANTLE_LOW_MAX_M = 0.8;

/** 0.8-1.2 m requires an explicit hang, then a player-chosen pull-up or drop. */
export const MANTLE_HIGH_MAX_M = 1.2;

/** Duration of the low mantle. Cancellable; never gates player input. */
export const MANTLE_LOW_DURATION_S = 0.35;

/**
 * Forward drift speed while mantling.
 *
 * Keeps the character moving onto the ledge rather than climbing straight up its face and
 * ending the mantle still against the wall.
 */
export const MANTLE_FORWARD_DRIFT_MPS = 1.6;

/** Duration of a vault over a low obstacle at speed. */
export const VAULT_DURATION_S = 0.25;

/** Minimum run speed required to vault rather than mantle. */
export const VAULT_MIN_SPEED_MPS = 4.0;

/** Airborne downward speed below which a ledge grab is permitted. */
export const LEDGE_GRAB_MAX_FALL_SPEED_MPS = 1.0;

/** Horizontal reach for a ledge grab. */
export const LEDGE_GRAB_REACH_M = 0.55;

/** Ledge shimmy speed. */
export const LEDGE_SHIMMY_SPEED_MPS = 1.0;

/** Jump-away-from-wall arc when leaping from a hang. */
export const LEDGE_JUMP_DISTANCE_M = 4.5;

/** Vertical rise of a ledge jump. */
export const LEDGE_JUMP_RISE_M = 0.8;

/** Climb speed (multiplied by the Faster Climb skill). */
export const CLIMB_SPEED_MPS = 1.0;

/** Lateral climb speed. */
export const CLIMB_LATERAL_SPEED_MPS = 1.2;

/** Window for jumping between holds. */
export const CLIMB_HOLD_JUMP_WINDOW_TICKS = 12; // 200 ms

/** A surface is climbable only if its normal is within this of horizontal. */
export const CLIMB_MAX_NORMAL_TILT_DEG = 30;

/** Swim speed. */
export const SWIM_SPEED_MPS = 2.5;

/** Seconds of air before the drowning warning. */
export const AIR_METER_S = 25;

/** Seconds of air remaining when the warning starts. */
export const AIR_WARNING_S = 5;

/** Buoyancy spring constant toward the neutral depth. */
export const BUOYANCY_STIFFNESS = 6.0;

/** Buoyancy damping. High damping is required: undamped force application oscillates (E9). */
export const BUOYANCY_DAMPING = 3.5;

/** Zip line travel speed. */
export const ZIPLINE_SPEED_MPS = 12;

/** Beam width below which only walk speed is allowed. */
export const BEAM_WIDTH_M = 0.25;

// ─────────────────────────────────────────────────────────────────────────────
// PHYSICS ADAPTER
// ─────────────────────────────────────────────────────────────────────────────


/** Distance the controller may be pulled down to stay attached to the ground. */
export const SNAP_TO_GROUND_M = 0.4;

/** Assumed player mass, used when pushing dynamic bodies. */
export const PLAYER_MASS_KG = 80;



/** Camera collision probe radius. Larger than a ray to prevent near-plane pop-through. */
export const CAMERA_PROBE_RADIUS_M = 0.25;

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA (GDD §5)
// ─────────────────────────────────────────────────────────────────────────────

/** Default boom length. */
export const CAMERA_DISTANCE_M = 4.0;

/** Boom length while climbing — pulls back to show the climbable surface. */
export const CAMERA_CLIMB_DISTANCE_M = 5.0;

/** Boom length while aiming — pushes in for framing. */
export const CAMERA_AIM_DISTANCE_M = 3.0;

/** Boom length while on a zip line. */
export const CAMERA_ZIPLINE_DISTANCE_M = 5.5;

/** Boom length inside authored narrow-corridor volumes. */
export const CAMERA_TUNNEL_DISTANCE_M = 2.4;

/** Over-the-shoulder lateral offset. */
export const CAMERA_SHOULDER_OFFSET_M = 0.5;

/** Shoulder offset while aiming: centres the camera behind the weapon. */
export const CAMERA_AIM_SHOULDER_OFFSET_M = 0.15;

/** Pivot height above the player origin. */
export const CAMERA_HEIGHT_M = 1.45;

/** Hard minimum boom length (camera collision floor). */
export const CAMERA_MIN_DISTANCE_M = 1.5;

/** Base field of view. */
export const CAMERA_FOV_DEG = 60;

/** Aim field of view. */
export const CAMERA_AIM_FOV_DEG = 45;

/** Narrow-corridor field of view. */
export const CAMERA_TUNNEL_FOV_DEG = 52;

/** Positional follow damping (GDD: lerp factor 0.1). */
export const CAMERA_FOLLOW_LERP = 0.1;

/** Rotational follow damping. */
export const CAMERA_ROTATION_LERP = 0.15;

/** Pull-in rate on collision. Fast: correctness. */
export const CAMERA_PULL_IN_LERP = 0.35;

/** Push-out rate on collision. Slow: feel. Whip-out is disorienting. */
export const CAMERA_PUSH_OUT_LERP = 0.08;

/** Delay before auto-rotation begins after the last camera input. */
export const CAMERA_AUTO_ROTATE_DELAY_S = 0.5;

/** Auto-rotation rate. */
export const CAMERA_AUTO_ROTATE_SPEED_RAD = 1.2;

/** Unobstructed time before the camera snaps in. */
export const CAMERA_STUCK_TIMEOUT_S = 2.0;

/** Time the camera may remain inside geometry before forcing a reset. */
export const CAMERA_PENETRATION_TIMEOUT_S = 0.5;

/** Duration of the forced camera reset interpolation. */
export const CAMERA_RESET_DURATION_S = 0.4;

/** Camera ground clamp offset. Uses the true resting height, not half-height + radius. */
export const CAMERA_GROUND_CLEARANCE_M = 0.5;

/** Clearance subtracted from a collision probe, so the camera sits just off the surface. */
export const CAMERA_SKIN_M = 0.15;

/** Rate at which aim and other mode framings transition. GDD specifies 0.18 s for Aim. */
export const CAMERA_MODE_TRANSITION_RATE = 12.8;

/** Extra pitch while climbing, so the player looks up the wall they are on rather than at it. */
export const CAMERA_CLIMB_PITCH_BIAS_DEG = 10;

/** Pitch bias on a zip line: look ahead and down at the destination. */
export const CAMERA_ZIPLINE_PITCH_BIAS_DEG = -8;

/** Extra boom length during a mantle, to keep the whole body in frame. */
export const CAMERA_MANTLE_PULL_BACK_M = 0.8;

/** Extra pivot height during a mantle. */
export const CAMERA_MANTLE_RAISE_M = 0.3;

/** Peak positional wobble in radians while submerged. */
export const CAMERA_WATER_WOBBLE_RAD = 0.05;

/** Frequency of the submerged wobble, in Hz. */
export const CAMERA_WATER_WOBBLE_HZ = 0.6;

/** Radial deadzone for the right stick, applied BEFORE integration. */
export const CAMERA_STICK_DEADZONE = 0.15;

/** How far ahead of the camera the look target sits, in metres. Any positive value gives the
 * same orientation; this only needs to be comfortably non-zero. */
export const CAMERA_LOOK_AHEAD_M = 1.0;

/**
 * The boom length the forced reset may collapse to, as a fraction of the normal minimum.
 *
 * ─── WHY THE MINIMUM IS ALLOWED TO MOVE AT ALL ──────────────────────────────────────
 * `CAMERA_MIN_DISTANCE_M` exists because a camera closer than 1.5 m to the pivot shows the back
 * of the character's head and nothing else — a bad view, but a *view*. That trade stops being
 * correct when there is no legal position at all: in a niche, a narrow cave mouth or a sealed
 * pocket, every distance down to the minimum is inside geometry, so the minimum is not protecting
 * the player from a bad view, it is *causing* an unusable one. The reset therefore relaxes it.
 *
 * This is the difference between an escape hatch and a gesture at one.
 */
export const CAMERA_RESET_MIN_SCALE = 0.04;

/**
 * How far the forced reset raises the pivot, in metres.
 *
 * Addresses the *other* half of being stuck. Relaxing the minimum distance fixes a camera that is
 * inside geometry, but it does nothing for a camera that is pinned at minimum distance and merely
 * pressed against a wall — a corridor, a doorway, the inside of a chimney. Pulling such a camera
 * in further just buries it in the character's back.
 *
 * Raising the pivot instead converts the view into a downward look over the character's own
 * shoulder, which is always informative: the player sees the character, the floor they are
 * standing on, and the space immediately around them. That is the view that gets them unstuck.
 */
export const CAMERA_RESET_LIFT_M = 0.6;

/** Duration of the forced camera reset when the stuck detector fires, in seconds. */
export const CAMERA_RESET_S = 0.4;

/** Distance the camera may lag the player before it is treated as a teleport and snaps. */
export const CAMERA_TELEPORT_SNAP_M = 8.0;

/** Pitch limits. Asymmetric: the game is about looking down at footing. */
export const CAMERA_PITCH_MIN_DEG = -60;
export const CAMERA_PITCH_MAX_DEG = 45;

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — PS1 AESTHETIC (GDD §9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Internal render target resolution.
 *
 * 480x270 (16:9) is the default; 320x240 is offered as a "chunkier" option.
 * The low internal resolution is a large fill-rate win on weak GPUs — one of the
 * few cases where the art direction and the performance budget want the same thing.
 */
export const RENDER_TARGET_WIDTH = 480;
export const RENDER_TARGET_HEIGHT = 270;

/** Virtual pixel rows the vertex snap grid is quantised to (half the vertical res). */
export const VERTEX_SNAP_GRID_ROWS = RENDER_TARGET_HEIGHT / 2;

/** Degree of affine texture warping. 0 = perspective-correct, 1 = full PS1 affine. */
export const AFFINE_WARP_AMOUNT = 0.65;

/** Palette quantisation levels per channel. */
export const PALETTE_LEVELS = 32;

/** Enable the 4x4 ordered dither before quantisation. */
export const PALETTE_DITHER_ENABLED = true;

/** Directional sun colour (warm white). */
export const SUN_COLOR = 0xfff4d6;

/** Directional sun intensity. */
export const SUN_INTENSITY = 1.0;

/** Ambient colour — sky-tinted so shadowed stone still reads as outdoor light. */
export const AMBIENT_COLOR = 0x9fc8ff;

/** Ambient intensity. High key: this is a bright game. */
export const AMBIENT_INTENSITY = 0.35;

/** Rim light intensity. Prevents flat silhouettes. */
export const RIM_INTENSITY = 0.25;

/** Rim light colour. */
export const RIM_COLOR = 0xffffff;

/** Exponent controlling how tightly the rim hugs the silhouette. */
export const RIM_POWER = 3.0;

/**
 * Hard terminator width. PS1-era lighting had no soft falloff; clamping the
 * diffuse term keeps shadows crisp and period-authentic rather than muddy.
 */
export const LIGHT_TERMINATOR_HARDNESS = 0.15;

/** Fog colour, matched to the sky so depth reads as haze rather than as gloom. */
export const FOG_COLOR = 0xa8d8f0;

/** Fog start distance. */
export const FOG_NEAR_M = 45;

/** Fog far distance. */
export const FOG_FAR_M = 140;

/** Level extent, kept small so float precision stays high (R14 mitigation). */
export const LEVEL_HALF_EXTENT_M = 120;

/** Maximum edge length of any single ground quad, bounding affine warp error (R5). */
export const MAX_QUAD_SIZE_M = 2.0;

// ─────────────────────────────────────────────────────────────────────────────
// SEEDED GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Master world seed.
 *
 * Fixing the seed means "random" rocks, foliage jitter and texture noise are
 * identical across reloads, which is required for reproducible testing and for
 * the player's mental map of the level to remain valid.
 */
export const WORLD_SEED = 0x5eed_1a7e;

/** Texture resolution for procedural generation. Keeps the PS1 look and is cheap. */
export const TEXTURE_SIZE = 64;
