/**
 * Unit tests for the camera mathematics.
 *
 * A camera's bugs are *feel* bugs: nothing crashes, no assertion a naive test would think to write
 * fails, and the game simply becomes subtly unpleasant. That is exactly why every formula here is
 * asserted — these are the values that would otherwise drift silently.
 *
 * The highest-value test in the file is the frame-rate independence one. The GDD specifies its
 * damping as per-frame lerp factors, which are unimplementable as written; the conversion to
 * exponential rates is the fix, and the proof that it is correct is that one 1/30 s step lands in
 * the same place as two 1/60 s steps.
 */

import { describe, it, expect } from 'vitest';
import {
  advanceSpringArm,
  applyGroundClamp,
  applyRadialDeadzone,
  CameraMode,
  clampPitch,
  damp,
  dampAngle,
  dampFraming,
  dampRateFromPerFrameLerp,
  framingForMode,
  lookTarget,
  NO_TRIGGERS,
  orbitDirection,
  orbitPosition,
  resolveCameraMode,
  rightDirection,
  rotateToward,
  shouldAutoRotate,
  shouldForceCameraReset,
  springArmTarget,
  waterWobble,
  wrapAngle,
  type CameraFraming,
} from '../../src/core/math/camera';
import {
  CAMERA_AIM_DISTANCE_M,
  CAMERA_AIM_FOV_DEG,
  CAMERA_AIM_SHOULDER_OFFSET_M,
  CAMERA_AUTO_ROTATE_DELAY_S,
  CAMERA_AUTO_ROTATE_SPEED_RAD,
  CAMERA_CLIMB_DISTANCE_M,
  CAMERA_DISTANCE_M,
  CAMERA_FOLLOW_LERP,
  CAMERA_FOV_DEG,
  CAMERA_GROUND_CLEARANCE_M,
  CAMERA_MIN_DISTANCE_M,
  CAMERA_PENETRATION_TIMEOUT_S,
  CAMERA_PITCH_MAX_DEG,
  CAMERA_PITCH_MIN_DEG,
  CAMERA_PULL_IN_LERP,
  CAMERA_PUSH_OUT_LERP,
  CAMERA_SHOULDER_OFFSET_M,
  CAMERA_SKIN_M,
  CAMERA_STUCK_TIMEOUT_S,
  CAMERA_TUNNEL_DISTANCE_M,
  CAMERA_TUNNEL_FOV_DEG,
  CAMERA_ZIPLINE_DISTANCE_M,
  CAMERA_CLIMB_PITCH_BIAS_DEG,
  CAMERA_MANTLE_RAISE_M,
  CAMERA_MANTLE_PULL_BACK_M,
  CAMERA_ZIPLINE_PITCH_BIAS_DEG,
  TICK_RATE,
} from '../../src/core/constants';

const DEG = Math.PI / 180;

/** The default framing, as the rig assembles it from constants. */
const FRAMING_DEFAULTS = {
  distance: CAMERA_DISTANCE_M,
  fovDeg: CAMERA_FOV_DEG,
  shoulderOffset: CAMERA_SHOULDER_OFFSET_M,
  pitchBias: 0,
  heightOffset: 0,
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

describe('dampRateFromPerFrameLerp — the GDD factor, made frame-rate independent', () => {
  it('reproduces the authored per-frame convergence at the reference rate', () => {
    // The contract: after one reference frame, the gap closed must equal the authored factor.
    // This is what makes the GDD's "lerp 0.10" still mean what it meant.
    for (const factor of [0.05, 0.1, 0.15, 0.35, 0.5]) {
      const rate = dampRateFromPerFrameLerp(factor, 60);
      const closed = 1 - Math.exp(-rate / 60);
      expect(closed, `factor=${factor}`).toBeCloseTo(factor, 9);
    }
  });

  it('produces the derived rate constants for the project constants', () => {
    expect(dampRateFromPerFrameLerp(CAMERA_FOLLOW_LERP, TICK_RATE)).toBeCloseTo(6.3216, 3);
    expect(dampRateFromPerFrameLerp(CAMERA_PULL_IN_LERP, TICK_RATE)).toBeCloseTo(25.847, 3);
    expect(dampRateFromPerFrameLerp(CAMERA_PUSH_OUT_LERP, TICK_RATE)).toBeCloseTo(5.0028, 3);
  });

  it('treats a factor of 1 as instant and 0 as no damping', () => {
    expect(dampRateFromPerFrameLerp(1, 60)).toBe(Number.POSITIVE_INFINITY);
    expect(dampRateFromPerFrameLerp(0, 60)).toBe(0);
    expect(dampRateFromPerFrameLerp(1.5, 60)).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns 0 rather than NaN for degenerate inputs', () => {
    for (const bad of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) {
      expect(dampRateFromPerFrameLerp(bad, 60)).toBe(0);
    }
    for (const bad of [0, -60, Number.NaN]) {
      expect(dampRateFromPerFrameLerp(0.1, bad)).toBe(0);
    }
  });
});

describe('damp — frame-rate independence, the property the whole design exists for', () => {
  it('lands in the same place whether the time is one step or two', () => {
    // ─── THE ASSERTION THAT MATTERS ────────────────────────────────────────────────────
    // This is the difference between a camera that behaves identically at 30 and 60 FPS and one
    // whose damping changes with the frame rate. A naive `current += (target-current)*0.1` per
    // frame fails this badly: two steps close 19% of the gap, one step closes 10%.
    const rate = dampRateFromPerFrameLerp(CAMERA_FOLLOW_LERP, TICK_RATE);

    const oneBigStep = damp(0, 100, rate, 2 / 60);
    const twoSmallSteps = damp(damp(0, 100, rate, 1 / 60), 100, rate, 1 / 60);

    expect(twoSmallSteps).toBeCloseTo(oneBigStep, 9);
  });

  it('holds the same invariant across a wide sweep of rates and durations', () => {
    for (const rate of [1, 5, 6.3216, 25.847]) {
      for (const dt of [1 / 120, 1 / 60, 1 / 30, 1 / 20]) {
        const single = damp(0, 10, rate, dt * 3);
        const split = damp(damp(damp(0, 10, rate, dt), 10, rate, dt), 10, rate, dt);
        expect(split, `rate=${rate} dt=${dt}`).toBeCloseTo(single, 8);
      }
    }
  });

  it('never overshoots the target', () => {
    let value = 0;
    for (let i = 0; i < 500; i++) {
      value = damp(value, 5, 30, 1 / 60);
      expect(value).toBeLessThanOrEqual(5);
    }
    expect(value).toBeCloseTo(5, 6);
  });

  it('moves monotonically toward the target', () => {
    let value = 0;
    let previous = -1;
    for (let i = 0; i < 30; i++) {
      value = damp(value, 1, 6, 1 / 60);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('converges to within 1% of the authored factor behaviour after one reference frame', () => {
    const rate = dampRateFromPerFrameLerp(0.1, 60);
    const afterOneFrame = damp(0, 100, rate, 1 / 60);
    expect(afterOneFrame).toBeCloseTo(10, 6);
  });

  it('snaps exactly for an infinite rate', () => {
    expect(damp(0, 100, Number.POSITIVE_INFINITY, 1 / 60)).toBe(100);
  });

  it('returns the current value unchanged for degenerate inputs rather than NaN', () => {
    // A NaN here would put the camera at a NaN position, which renders nothing at all.
    expect(damp(3, 100, 0, 1 / 60)).toBe(3);
    expect(damp(3, 100, 6, 0)).toBe(3);
    expect(damp(3, 100, 6, -1)).toBe(3);
    expect(damp(3, Number.NaN, 6, 1 / 60)).toBe(3);
    expect(damp(3, 100, Number.NaN, 1 / 60)).toBe(3);
    expect(damp(3, 100, 6, Number.NaN)).toBe(3);
  });
});

describe('dampAngle — damping that takes the short way around', () => {
  it('crosses the ±pi seam the short way, not the long way', () => {
    // Turning from just below +pi to just above -pi is a two-degree turn. A naive damping that
    // ignores wrapping would take the 358-degree route and spin the camera the long way round,
    // which is extremely visible.
    const current = Math.PI - 0.01;
    const target = -Math.PI + 0.01;

    const next = dampAngle(current, target, 6, 1 / 60);

    // The result must be on the far side of the seam, not back toward -3.13.
    expect(next).toBeGreaterThanOrEqual(-Math.PI);
    expect(next).toBeLessThanOrEqual(Math.PI);
    expect(Math.abs(wrapAngle(next - target))).toBeLessThan(Math.abs(wrapAngle(current - target)));
  });

  it('converges across the seam instead of spinning forever', () => {
    let angle = Math.PI - 0.02;
    const target = -Math.PI + 0.02;
    for (let i = 0; i < 300; i++) {
      angle = dampAngle(angle, target, 6, 1 / 60);
    }
    expect(Math.abs(wrapAngle(angle - target))).toBeLessThan(1e-4);
  });

  it('always returns a wrapped value, so the stored angle cannot drift over a long session', () => {
    let angle = 0;
    for (let i = 0; i < 2000; i++) {
      angle = dampAngle(angle, 2.5, 8, 1 / 60);
      expect(Number.isFinite(angle)).toBe(true);
      expect(angle).toBeGreaterThanOrEqual(-Math.PI - 1e-9);
      expect(angle).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('returns the current angle for degenerate inputs', () => {
    expect(dampAngle(1, Number.NaN, 6, 1 / 60)).toBe(1);
    expect(dampAngle(1, 2, 0, 1 / 60)).toBe(1);
    expect(dampAngle(1, 2, 6, 0)).toBe(1);
  });
});

describe('the spring arm', () => {
  it('cannot pull the arm in when nothing is in the way', () => {
    expect(springArmTarget(4.0, Number.POSITIVE_INFINITY, 1.5, 0.15)).toBe(4.0);
  });

  it('has a skin smaller than the minimum distance, or the arm could never reach its floor', () => {
    // A skin comparable to the minimum would mean a camera almost touching a wall is pushed
    // further away than the arm is allowed to be, and the clamp would fight the skin every tick.
    expect(CAMERA_SKIN_M).toBeLessThan(CAMERA_MIN_DISTANCE_M / 4);
    expect(CAMERA_SKIN_M).toBeGreaterThan(0);
  });

  it('has a minimum distance that still frames the character', () => {
    // Too small and the camera ends up inside the player's own model, which is worse than the
    // clipping the minimum exists to bound.
    expect(CAMERA_MIN_DISTANCE_M).toBeGreaterThan(1.0);
    expect(CAMERA_MIN_DISTANCE_M).toBeLessThan(CAMERA_DISTANCE_M);
  });

  it('pulls the arm in to just short of the obstruction', () => {
    // The skin exists because sitting exactly on the surface lets floating-point error and the
    // near plane conspire to show the inside of the wall.
    expect(springArmTarget(4.0, 2.0, 1.5, 0.15)).toBeCloseTo(1.85, 6);
  });

  it('never goes below the hard minimum, even when the obstruction demands it', () => {
    // A camera closer than the minimum is unusable, so a slightly wrong image beats no image.
    expect(springArmTarget(4.0, 0.5, 1.5, 0.15)).toBe(1.5);
    expect(springArmTarget(4.0, 0.0, 1.5, 0.15)).toBe(1.5);
  });

  it('does not lengthen past the authored boom when the obstruction is far away', () => {
    expect(springArmTarget(4.0, 10.0, 1.5, 0.15)).toBe(4.0);
  });

  it('pulls in faster than it pushes out — the asymmetric pair', () => {
    // Pulling in is a correctness problem (every frame is clipping); pushing out is a feel
    // problem (a whip-out is disorienting). Conflating the rates forces a choice between the two.
    const pullInRate = dampRateFromPerFrameLerp(CAMERA_PULL_IN_LERP, TICK_RATE);
    const pushOutRate = dampRateFromPerFrameLerp(CAMERA_PUSH_OUT_LERP, TICK_RATE);

    let pulled = 4.0;
    let pushed = 1.5;

    // Ten frames of each.
    for (let i = 0; i < 10; i++) {
      pulled = advanceSpringArm(pulled, 2.0, pullInRate, pushOutRate, 1 / 60);
      pushed = advanceSpringArm(pushed, 4.0, pullInRate, pushOutRate, 1 / 60);
    }

    // Measured as the FRACTION OF THE GAP REMAINING, not as progress. Progress is capped at 1.0
    // over a finite window, so a "pull in at least twice as fast in progress terms" assertion
    // becomes unsatisfiable as the pull-in approaches its destination — a test that fails for
    // arithmetic reasons rather than behavioural ones. Remaining fraction has no such ceiling.
    const pulledRemaining = (pulled - 2.0) / (4.0 - 2.0);
    const pushedRemaining = (4.0 - pushed) / (4.0 - 1.5);

    expect(pulledRemaining).toBeLessThan(pushedRemaining / 2);

    // And both must actually move, so neither rate is a no-op.
    expect(pulledRemaining).toBeLessThan(0.5);
    expect(pushedRemaining).toBeLessThan(0.9);
  });

  it('chooses the rate from target-versus-current, not from whether an obstruction exists', () => {
    // The subtle half of the asymmetry. Deciding by "is something blocking us" makes an arm that
    // is still easing outward past a now-present obstruction keep switching rates and judder.
    // Here the target is ABOVE current (so: push out, slow) even though a collision is implied.
    const pullInRate = dampRateFromPerFrameLerp(CAMERA_PULL_IN_LERP, TICK_RATE);
    const pushOutRate = dampRateFromPerFrameLerp(CAMERA_PUSH_OUT_LERP, TICK_RATE);

    const expanding = advanceSpringArm(2.0, 3.0, pullInRate, pushOutRate, 1 / 60);
    const contracting = advanceSpringArm(3.0, 2.0, pullInRate, pushOutRate, 1 / 60);

    // Over the same nominal 1 m gap, the expanding (push-out) step must travel LESS far than the
    // contracting (pull-in) step. Expressed as the gap remaining, push-out leaves more.
    const expandingRemaining = 3.0 - expanding;
    const contractingRemaining = contracting - 2.0;

    expect(expandingRemaining).toBeGreaterThan(contractingRemaining);

    // Concretely, after one tick: push-out closes 8% of the gap, pull-in closes 35%.
    expect(expandingRemaining).toBeCloseTo(1 - CAMERA_PUSH_OUT_LERP, 6);
    expect(contractingRemaining).toBeCloseTo(1 - CAMERA_PULL_IN_LERP, 6);
  });

  it('settles at the target without oscillating when pushed against a flat wall', () => {
    // A camera that jitters against a wall is a classic and very visible failure. Damping cannot
    // oscillate, but an asymmetric pair with the wrong direction test can.
    const pullInRate = dampRateFromPerFrameLerp(CAMERA_PULL_IN_LERP, TICK_RATE);
    const pushOutRate = dampRateFromPerFrameLerp(CAMERA_PUSH_OUT_LERP, TICK_RATE);

    let distance = 4.0;
    const target = springArmTarget(4.0, 2.3, 1.5, 0.15);

    for (let i = 0; i < 240; i++) {
      distance = advanceSpringArm(distance, target, pullInRate, pushOutRate, 1 / 60);
      expect(distance).toBeLessThanOrEqual(4.0 + 1e-9);
      expect(distance).toBeGreaterThanOrEqual(1.5 - 1e-9);
    }

    expect(distance).toBeCloseTo(target, 4);
  });
});

describe('pitch clamping — asymmetric, and never flipping over the pole', () => {
  const minPitch = CAMERA_PITCH_MIN_DEG * DEG;
  const maxPitch = CAMERA_PITCH_MAX_DEG * DEG;

  it('allows more down-look than up-look, as specified', () => {
    // The game is about watching your footing, so the range is deliberately lopsided.
    expect(Math.abs(minPitch)).toBeGreaterThan(Math.abs(maxPitch) * 1.3);
  });

  it('clamps at both limits', () => {
    expect(clampPitch(-Math.PI, minPitch, maxPitch)).toBeCloseTo(minPitch, 9);
    expect(clampPitch(Math.PI, minPitch, maxPitch)).toBeCloseTo(maxPitch, 9);
    expect(clampPitch(0, minPitch, maxPitch)).toBeCloseTo(0, 9);
  });

  it('never returns a value outside the range, across a full sweep', () => {
    for (let i = -400; i <= 400; i++) {
      const pitch = clampPitch(i * 0.05, minPitch, maxPitch);
      expect(pitch).toBeGreaterThanOrEqual(minPitch - 1e-9);
      expect(pitch).toBeLessThanOrEqual(maxPitch + 1e-9);
    }
  });

  it('cannot reach the pole, which is where a grazing angle would invert the view', () => {
    // A ±90 degree pitch makes the orbit direction vertical and the yaw meaningless, and the
    // view inverts. The clamp is what makes that unreachable rather than merely unlikely.
    expect(maxPitch).toBeLessThan(Math.PI / 2);
    expect(minPitch).toBeGreaterThan(-Math.PI / 2);
  });

  it('returns 0 rather than NaN for degenerate input', () => {
    expect(clampPitch(Number.NaN, minPitch, maxPitch)).toBe(0);
    expect(clampPitch(0.5, Number.NaN, maxPitch)).toBe(0);
    // A reversed range would clamp everything to one endpoint; a loud neutral is better.
    expect(clampPitch(0.5, maxPitch, minPitch)).toBe(0);
  });
});

describe('orbit geometry — the conventions that are easy to get backwards', () => {
  it('places the camera BEHIND the pivot at zero pitch', () => {
    // Yaw is measured from +Z, matching the character's facing. At yaw 0 the camera looks along
    // +Z, so the camera itself sits at -Z.
    const direction = orbitDirection(0, 0);
    expect(direction.x).toBeCloseTo(0, 9);
    expect(direction.y).toBeCloseTo(0, 9);
    expect(direction.z).toBeCloseTo(-1, 9);
  });

  it('raises the camera for positive pitch, so it looks down', () => {
    const direction = orbitDirection(0, 30 * DEG);
    expect(direction.y).toBeCloseTo(0.5, 6);
    // The horizontal component shrinks to keep the vector unit length.
    expect(Math.hypot(direction.x, direction.z)).toBeCloseTo(Math.cos(30 * DEG), 6);
  });

  it('always returns a unit vector', () => {
    for (let yaw = -4; yaw <= 4; yaw += 0.3) {
      for (let pitch = -1.0; pitch <= 0.7; pitch += 0.2) {
        const d = orbitDirection(yaw, pitch);
        expect(Math.hypot(d.x, d.y, d.z), `yaw=${yaw} pitch=${pitch}`).toBeCloseTo(1, 9);
      }
    }
  });

  it('finds the camera right-hand vector correctly, checked against a known case', () => {
    // Facing -Z (yaw = pi) must give right = +X, which is screen-right for a camera looking into
    // the screen. The opposite sign puts the over-the-shoulder camera on the player's LEFT, which
    // does not look broken — it just looks wrong forever and nobody can say why.
    const right = rightDirection(Math.PI);
    expect(right.x).toBeCloseTo(1, 9);
    expect(right.z).toBeCloseTo(0, 9);
    expect(right.y).toBe(0);
  });

  it('keeps the right vector perpendicular to the facing direction', () => {
    // A shoulder offset that is not perpendicular slides the camera along the view axis, which
    // changes the boom length as a side effect of aiming.
    for (let yaw = -4; yaw <= 4; yaw += 0.25) {
      const right = rightDirection(yaw);
      const forward = { x: Math.sin(yaw), z: Math.cos(yaw) };
      const dot = right.x * forward.x + right.z * forward.z;
      expect(dot, `yaw=${yaw}`).toBeCloseTo(0, 9);
      expect(Math.hypot(right.x, right.z)).toBeCloseTo(1, 9);
    }
  });

  it('offsets the camera to the RIGHT of the character', () => {
    // Facing +Z at yaw 0: right is -X, so a positive shoulder offset moves the camera to -X,
    // which frames the character to the screen's right... which is to say, the camera is over the
    // character's right shoulder. Asserted concretely because sign errors here are invisible.
    const pivot = { x: 0, y: 0, z: 0 };
    const position = orbitPosition(pivot, 0, 0, 4, 0.5);

    expect(position.z).toBeCloseTo(-4, 9);
    // yaw 0 -> rightDirection = (-cos 0, 0, sin 0) = (-1, 0, 0)
    expect(position.x).toBeCloseTo(-0.5, 9);
  });

  it('a zero shoulder offset gives the classic centred third-person position', () => {
    const position = orbitPosition({ x: 1, y: 2, z: 3 }, Math.PI / 2, 0, 4, 0);
    expect(position.x).toBeCloseTo(1 - 4, 6); // yaw pi/2 -> camera at -X of the pivot
    expect(position.y).toBeCloseTo(2, 9);
    expect(position.z).toBeCloseTo(3, 6);
  });

  it('aims the look target along the view direction, NOT at the pivot', () => {
    // ─── WHY THIS IS TESTED EXPLICITLY ─────────────────────────────────────────────────
    // Aiming at the player is the obvious implementation and it is wrong for an over-shoulder
    // camera: because the camera is offset sideways, aiming at the character rotates the view
    // inward and the whole screen yaws every time the shoulder offset changes — which it does
    // whenever the player aims.
    //
    // An over-the-shoulder camera looks forward, parallel to the movement direction, so the
    // world ahead stays centred and the character is offset in frame.
    const pivot = { x: 0, y: 1.45, z: 0 };
    const cameraPosition = orbitPosition(pivot, 0, 0, 4, 0.5);
    const target = lookTarget(cameraPosition, 0, 0, 1);

    // The look target must be directly ahead in +Z, offset by the same lateral amount as the
    // camera, so the view is parallel rather than converging on the pivot.
    expect(target.x).toBeCloseTo(cameraPosition.x, 9);
    expect(target.z).toBeCloseTo(cameraPosition.z + 1, 9);

    // Concretely: it is NOT the pivot, and the difference is the shoulder offset.
    expect(Math.abs(target.x - pivot.x)).toBeCloseTo(0.5, 9);
  });

  it('the look target is always one unit from the camera', () => {
    for (let yaw = -3; yaw <= 3; yaw += 0.4) {
      for (const pitch of [-0.8, 0, 0.6]) {
        const camera = orbitPosition({ x: 0, y: 0, z: 0 }, yaw, pitch, 4, 0.3);
        const target = lookTarget(camera, yaw, pitch, 1);
        const distance = Math.hypot(
          target.x - camera.x,
          target.y - camera.y,
          target.z - camera.z,
        );
        expect(distance, `yaw=${yaw} pitch=${pitch}`).toBeCloseTo(1, 9);
      }
    }
  });

  it('the camera looks at the pivot when yaw is such that the shoulder offset is zero', () => {
    const pivot = { x: 0, y: 0, z: 0 };
    const cameraPosition = orbitPosition(pivot, 0, 0, 4, 0);
    const target = lookTarget(cameraPosition, 0, 0, 4);

    // With no shoulder offset the view axis passes through the pivot, which is the sanity check
    // that the geometry is coherent at all.
    expect(target.x).toBeCloseTo(pivot.x, 9);
    expect(target.y).toBeCloseTo(pivot.y, 9);
    expect(target.z).toBeCloseTo(pivot.z, 9);
  });
});

describe('the ground clamp', () => {
  it('raises a camera that is below the clearance but leaves a higher one alone', () => {
    expect(applyGroundClamp(-3, 0, 0.5)).toBeCloseTo(0.5, 9);
    expect(applyGroundClamp(0.2, 0, 0.5)).toBeCloseTo(0.5, 9);
    expect(applyGroundClamp(2.0, 0, 0.5)).toBeCloseTo(2.0, 9);
  });

  it('leaves the height alone when the ground is unknown', () => {
    expect(applyGroundClamp(2.0, Number.NEGATIVE_INFINITY, 0.5)).toBeCloseTo(2.0, 9);
    expect(applyGroundClamp(2.0, Number.NaN, 0.5)).toBeCloseTo(2.0, 9);
  });

  it('returns 0 rather than NaN for a non-finite camera height', () => {
    expect(applyGroundClamp(Number.NaN, 0, 0.5)).toBe(0);
  });

  it('uses a clearance well above zero, so the camera never grazes the floor', () => {
    expect(CAMERA_GROUND_CLEARANCE_M).toBeGreaterThanOrEqual(0.4);
  });
});

describe('contextual modes — the priority order resolved in one pure function', () => {
  it('resolves to Default when nothing is active', () => {
    expect(resolveCameraMode(NO_TRIGGERS)).toBe(CameraMode.Default);
  });

  it('honours the GDD priority order exactly, highest first', () => {
    // Every trigger active at once: the winner must be Cinematic. Then each trigger is removed in
    // priority order and the winner must follow. This is the test that makes "ties are impossible
    // by construction" a checked claim rather than a comment.
    const order = [
      CameraMode.Cinematic,
      CameraMode.ZipLine,
      CameraMode.Water,
      CameraMode.Mantle,
      CameraMode.Climb,
      CameraMode.Aim,
      CameraMode.Tunnel,
    ];

    const keys = [
      'cinematic',
      'onZipLine',
      'submerged',
      'mantling',
      'climbingOrHanging',
      'aiming',
      'inTunnel',
    ] as const;

    for (let i = 0; i < keys.length; i++) {
      const triggers = { ...NO_TRIGGERS };
      // Activate every trigger from index i onward.
      for (let j = i; j < keys.length; j++) triggers[keys[j]] = true;

      expect(resolveCameraMode(triggers), `starting at ${keys[i]}`).toBe(order[i]);
    }
  });

  it('lets Aim lose to Climb, because you must see where you are going', () => {
    expect(resolveCameraMode({ ...NO_TRIGGERS, aiming: true, climbingOrHanging: true })).toBe(
      CameraMode.Climb,
    );
  });

  it('lets Tunnel lose to everything, being the lowest priority', () => {
    for (const key of ['cinematic', 'onZipLine', 'submerged', 'mantling', 'climbingOrHanging', 'aiming'] as const) {
      expect(resolveCameraMode({ ...NO_TRIGGERS, inTunnel: true, [key]: true }), key).not.toBe(
        CameraMode.Tunnel,
      );
    }
  });
});

describe('mode framing — the GDD §5.3 table', () => {
  it('aims with a shorter boom, narrower FOV and centred shoulder', () => {
    const framing = framingForMode(CameraMode.Aim, FRAMING_DEFAULTS);
    expect(framing.distance).toBe(CAMERA_AIM_DISTANCE_M);
    expect(framing.fovDeg).toBe(CAMERA_AIM_FOV_DEG);
    expect(framing.shoulderOffset).toBe(CAMERA_AIM_SHOULDER_OFFSET_M);

    // The narrowing is what signals "aiming" to the player, so it must be a real change.
    expect(framing.fovDeg).toBeLessThan(FRAMING_DEFAULTS.fovDeg);
    expect(framing.shoulderOffset).toBeLessThan(FRAMING_DEFAULTS.shoulderOffset);
  });

  it('centres and elevates the pitch while climbing', () => {
    const framing = framingForMode(CameraMode.Climb, FRAMING_DEFAULTS);
    expect(framing.distance).toBe(CAMERA_CLIMB_DISTANCE_M);
    expect(framing.shoulderOffset).toBe(0);
    // Biased upward, because you need to see where you are going rather than the wall in your face.
    expect(framing.pitchBias).toBeGreaterThan(0);
  });

  it('pulls back and raises for a mantle, to keep the body in frame', () => {
    const framing = framingForMode(CameraMode.Mantle, FRAMING_DEFAULTS);
    expect(framing.distance).toBeGreaterThan(FRAMING_DEFAULTS.distance);
    expect(framing.heightOffset).toBeGreaterThan(0);
  });

  it('narrows the FOV and shortens the boom in a tunnel', () => {
    const framing = framingForMode(CameraMode.Tunnel, FRAMING_DEFAULTS);
    expect(framing.fovDeg).toBe(CAMERA_TUNNEL_FOV_DEG);
    expect(framing.distance).toBe(CAMERA_TUNNEL_DISTANCE_M);
  });

  it('lengthens the boom and looks down ahead on a zip line', () => {
    const framing = framingForMode(CameraMode.ZipLine, FRAMING_DEFAULTS);
    expect(framing.distance).toBe(CAMERA_ZIPLINE_DISTANCE_M);
    expect(framing.pitchBias).toBeLessThan(0);
  });

  it('leaves the default framing untouched', () => {
    const framing = framingForMode(CameraMode.Default, FRAMING_DEFAULTS);
    expect(framing).toEqual({
      distance: CAMERA_DISTANCE_M,
      fovDeg: CAMERA_FOV_DEG,
      shoulderOffset: CAMERA_SHOULDER_OFFSET_M,
      pitchBias: 0,
      heightOffset: 0,
    });
  });

  it('has a defined framing for every mode, with none falling through', () => {
    // Exhaustive over the enum, so adding a mode without deciding its framing fails here rather
    // than silently inheriting the default.
    for (const mode of Object.values(CameraMode)) {
      const framing = framingForMode(mode, FRAMING_DEFAULTS);
      expect(Number.isFinite(framing.distance), mode).toBe(true);
      expect(framing.distance).toBeGreaterThan(0);
      expect(Number.isFinite(framing.fovDeg), mode).toBe(true);
      expect(framing.fovDeg).toBeGreaterThan(0);
      expect(Number.isFinite(framing.shoulderOffset), mode).toBe(true);
    }
    expect(Object.values(CameraMode)).toHaveLength(8);
  });
});

describe('dampFraming — mode transitions are lerped, never cut', () => {
  it('moves every component toward the target without reaching it in a single tick', () => {
    const current: CameraFraming = {
      distance: CAMERA_DISTANCE_M,
      fovDeg: CAMERA_FOV_DEG,
      shoulderOffset: CAMERA_SHOULDER_OFFSET_M,
      pitchBias: 0,
      heightOffset: 0,
    };
    const target = framingForMode(CameraMode.Aim, FRAMING_DEFAULTS);

    const next = dampFraming(current, target, 10, 1 / 60);

    expect(next.distance).toBeLessThan(current.distance);
    expect(next.distance).toBeGreaterThan(target.distance);
    expect(next.fovDeg).toBeLessThan(current.fovDeg);
    expect(next.fovDeg).toBeGreaterThan(target.fovDeg);
  });

  it('never overshoots, so the FOV cannot pass 45 and come back', () => {
    // An overshoot would be visible as the FOV dipping below the aim value then settling, which
    // reads as the camera "bouncing".
    const target = framingForMode(CameraMode.Aim, FRAMING_DEFAULTS);
    let framing: CameraFraming = { ...FRAMING_DEFAULTS, pitchBias: 0, heightOffset: 0 };

    for (let i = 0; i < 200; i++) {
      framing = dampFraming(framing, target, 25, 1 / 60);
      expect(framing.fovDeg).toBeGreaterThanOrEqual(target.fovDeg - 1e-9);
      expect(framing.distance).toBeGreaterThanOrEqual(target.distance - 1e-9);
    }

    expect(framing.fovDeg).toBeCloseTo(target.fovDeg, 4);
    expect(framing.distance).toBeCloseTo(target.distance, 4);
  });

  it('is reversible mid-transition without a discontinuity', () => {
    // The player presses aim, then releases before the transition completes. The FOV must turn
    // around smoothly rather than jumping or sticking part-way.
    const aim = framingForMode(CameraMode.Aim, FRAMING_DEFAULTS);
    const normal = framingForMode(CameraMode.Default, FRAMING_DEFAULTS);
    let framing: CameraFraming = { ...normal };

    for (let i = 0; i < 5; i++) framing = dampFraming(framing, aim, 25, 1 / 60);
    const midTransition = framing.fovDeg;
    expect(midTransition).toBeLessThan(CAMERA_FOV_DEG);
    expect(midTransition).toBeGreaterThan(CAMERA_AIM_FOV_DEG);

    // Now reverse. The first tick back must be a continuous step — not a jump straight to 60.
    // Continuity here is defined as "the step is a bounded fraction of the gap", because an
    // absolute degree budget would be an arbitrary number that happens to fit today's constants.
    // At a rate of 25/s and dt 1/60 the step is 34% of the gap, which is the correct damping
    // behaviour; a discontinuity would be a step of ~100%.
    const reversed = dampFraming(framing, normal, 25, 1 / 60);
    const gap = CAMERA_FOV_DEG - midTransition;
    const step = reversed.fovDeg - midTransition;

    expect(reversed.fovDeg).toBeGreaterThan(midTransition);
    expect(reversed.fovDeg).toBeLessThan(CAMERA_FOV_DEG);
    expect(step).toBeCloseTo(gap * (1 - Math.exp(-25 / 60)), 6);

    // And it must converge back to the default.
    let settling = reversed;
    for (let i = 0; i < 200; i++) settling = dampFraming(settling, normal, 25, 1 / 60);
    expect(settling.fovDeg).toBeCloseTo(CAMERA_FOV_DEG, 4);
  });

  it('reaches within 90% of the aim transition inside the GDD 0.18 s', () => {
    // The GDD specifies only the Aim transition duration (0.18 s), so it sets the rate the others
    // inherit. At 90% in 0.18 s: 1 - exp(-rate*0.18) = 0.9, so rate ~= 12.8 /s.
    const rate = -Math.log(1 - 0.9) / 0.18;
    const aim = framingForMode(CameraMode.Aim, FRAMING_DEFAULTS);
    let framing: CameraFraming = { ...FRAMING_DEFAULTS, pitchBias: 0, heightOffset: 0 };

    const ticks = Math.round(0.18 * TICK_RATE);
    for (let i = 0; i < ticks; i++) framing = dampFraming(framing, aim, rate, 1 / 60);

    const progress = (CAMERA_FOV_DEG - framing.fovDeg) / (CAMERA_FOV_DEG - aim.fovDeg);
    expect(progress).toBeGreaterThan(0.9);
  });
});

describe('auto-rotation', () => {
  it('waits for the specified delay before starting', () => {
    expect(shouldAutoRotate(CAMERA_AUTO_ROTATE_DELAY_S - 0.01, CAMERA_AUTO_ROTATE_DELAY_S)).toBe(
      false,
    );
    expect(shouldAutoRotate(CAMERA_AUTO_ROTATE_DELAY_S, CAMERA_AUTO_ROTATE_DELAY_S)).toBe(true);
    expect(shouldAutoRotate(5.0, CAMERA_AUTO_ROTATE_DELAY_S)).toBe(true);
  });

  it('never runs while input has just arrived, which is what "never fights the player" means', () => {
    expect(shouldAutoRotate(0, CAMERA_AUTO_ROTATE_DELAY_S)).toBe(false);
    // A negative elapsed time means the input clock and the frame clock disagree; treating it as
    // "just now" is the safe resolution, because auto-rotating over a player's input is worse than
    // not auto-rotating when we should.
    expect(shouldAutoRotate(-1, CAMERA_AUTO_ROTATE_DELAY_S)).toBe(false);
  });

  it('treats a zero delay as "always allowed" rather than never', () => {
    expect(shouldAutoRotate(0, 0)).toBe(true);
  });

  it('does not start for a non-finite elapsed time', () => {
    expect(shouldAutoRotate(Number.NaN, 0.5)).toBe(false);
  });

  it('rotates at exactly the specified rate, and no faster', () => {
    const start = 0;
    const target = Math.PI / 2;

    const afterOneTick = rotateToward(start, target, CAMERA_AUTO_ROTATE_SPEED_RAD, 1 / 60);
    expect(afterOneTick - start).toBeCloseTo(CAMERA_AUTO_ROTATE_RATE_PER_TICK, 9);

    // A rate limit also guarantees the rotation cannot outrun the player's own turning, which a
    // damping factor would not.
    expect(CAMERA_AUTO_ROTATE_SPEED_RAD).toBeCloseTo(1.2, 6);
  });

  it('takes the short way around, and stops exactly on the target', () => {
    const result = rotateToward(-Math.PI + 0.01, Math.PI - 0.01, 1.2, 1 / 60);
    // It must have moved past -pi into positive values, i.e. the two-degree route.
    expect(Math.abs(wrapAngle(result - (Math.PI - 0.01)))).toBeLessThan(1.2 / 60 + 1e-9);

    // And on arrival it snaps to the target rather than asymptotically creeping.
    expect(rotateToward(1.0, 1.005, 1.2, 1 / 60)).toBeCloseTo(1.005, 9);
  });

  it('returns the current yaw for degenerate inputs', () => {
    expect(rotateToward(1, 2, 0, 1 / 60)).toBe(1);
    expect(rotateToward(1, 2, 1.2, 0)).toBe(1);
    expect(rotateToward(1, Number.NaN, 1.2, 1 / 60)).toBe(1);
  });
});

const CAMERA_AUTO_ROTATE_RATE_PER_TICK = CAMERA_AUTO_ROTATE_SPEED_RAD / TICK_RATE;

describe('the stuck detector — the system\'s guarantee of escape', () => {
  it('fires when pinned at minimum distance for long enough', () => {
    expect(shouldForceCameraReset(CAMERA_STUCK_TIMEOUT_S - 0.01, 0, CAMERA_STUCK_TIMEOUT_S, CAMERA_PENETRATION_TIMEOUT_S)).toBe(false);
    expect(shouldForceCameraReset(CAMERA_STUCK_TIMEOUT_S, 0, CAMERA_STUCK_TIMEOUT_S, CAMERA_PENETRATION_TIMEOUT_S)).toBe(true);
  });

  it('fires earlier when the camera is inside geometry', () => {
    // Two independent conditions covering different failures: pinned (blocked in every direction)
    // versus penetrating (not blocked, but inside something anyway — which happens when an
    // obstruction appears between ticks, or when the near plane reaches past the skin).
    expect(CAMERA_PENETRATION_TIMEOUT_S).toBeLessThan(CAMERA_STUCK_TIMEOUT_S);
    expect(shouldForceCameraReset(0, CAMERA_PENETRATION_TIMEOUT_S, CAMERA_STUCK_TIMEOUT_S, CAMERA_PENETRATION_TIMEOUT_S)).toBe(true);
  });

  it('does not fire during normal play', () => {
    expect(shouldForceCameraReset(0, 0, CAMERA_STUCK_TIMEOUT_S, CAMERA_PENETRATION_TIMEOUT_S)).toBe(false);
    expect(shouldForceCameraReset(1.9, 0.4, CAMERA_STUCK_TIMEOUT_S, CAMERA_PENETRATION_TIMEOUT_S)).toBe(false);
  });

  it('does not fire for non-finite counters', () => {
    expect(shouldForceCameraReset(Number.NaN, Number.NaN, CAMERA_STUCK_TIMEOUT_S, CAMERA_PENETRATION_TIMEOUT_S)).toBe(false);
  });
});

describe('stick deadzone — applied before integration, radially, with rescaling', () => {
  it('zeroes everything inside the deadzone', () => {
    const inside = applyRadialDeadzone(0.05, 0.05, 0.2);
    expect(inside.x).toBe(0);
    expect(inside.y).toBe(0);
  });

  it('has NO discontinuity at the deadzone edge', () => {
    // ─── THE BUG THIS PREVENTS ─────────────────────────────────────────────────────────
    // A hard cutoff without rescaling makes the output jump from 0 to `deadzone` the instant the
    // stick crosses the threshold. The stick appears to "catch", and the whole point of a soft
    // region is defeated.
    const deadzone = 0.2;
    const justInside = applyRadialDeadzone(deadzone * 0.999, 0, deadzone);
    const justOutside = applyRadialDeadzone(deadzone * 1.001, 0, deadzone);

    expect(justInside.x).toBe(0);
    expect(justOutside.x).toBeLessThan(0.01);
    expect(Math.abs(justOutside.x - justInside.x)).toBeLessThan(0.01);
  });

  it('reaches full magnitude at the stick limit', () => {
    const full = applyRadialDeadzone(1, 0, 0.2);
    expect(Math.hypot(full.x, full.y)).toBeCloseTo(1, 6);
  });

  it('is RADIAL, so pushing diagonally is not dead while pushing straight is not', () => {
    // A per-axis deadzone creates a cross-shaped dead region: pushing diagonally registers when
    // pushing straight up does not. Players feel this as "the stick is broken in the corners" and
    // cannot describe it. A radial deadzone treats every direction identically.
    const deadzone = 0.3;
    const straight = applyRadialDeadzone(0, deadzone * 1.5, deadzone);
    // Math.SQRT1_2, not the 0.7071 literal: a truncated constant makes the diagonal magnitude
    // 0.45 instead of 0.4500000, and the resulting 6e-6 mismatch would look like a radial-blend
    // bug. The imprecision is in the test input, and it is worth being exact about that rather
    // than loosening the assertion until the symptom disappears.
    const diagonal = applyRadialDeadzone(
      deadzone * 1.5 * Math.SQRT1_2,
      deadzone * 1.5 * Math.SQRT1_2,
      deadzone,
    );

    // Both are outside the deadzone by the same radial amount, so both must be live, and by the
    // same magnitude.
    expect(Math.hypot(straight.x, straight.y)).toBeGreaterThan(0);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(Math.hypot(straight.x, straight.y), 6);
  });

  it('treats a perfectly centred cross of four directions consistently', () => {
    const deadzone = 0.25;
    const distance = 0.5;
    const magnitudes = [
      applyRadialDeadzone(distance, 0, deadzone),
      applyRadialDeadzone(-distance, 0, deadzone),
      applyRadialDeadzone(0, distance, deadzone),
      applyRadialDeadzone(0, -distance, deadzone),
    ].map((v) => Math.hypot(v.x, v.y));

    for (const magnitude of magnitudes) {
      expect(magnitude).toBeCloseTo(magnitudes[0], 9);
    }
  });

  it('preserves direction exactly', () => {
    const filtered = applyRadialDeadzone(0.6, -0.8, 0.2);
    // The input direction is (0.6, -0.8), unit already. It must come back unchanged.
    expect(filtered.x).toBeGreaterThan(0);
    expect(filtered.y).toBeLessThan(0);
    expect(filtered.x / -filtered.y).toBeCloseTo(0.6 / 0.8, 6);
  });

  it('passes the stick through unchanged when there is no deadzone', () => {
    const passthrough = applyRadialDeadzone(0.37, -0.21, 0);
    expect(passthrough.x).toBeCloseTo(0.37, 9);
    expect(passthrough.y).toBeCloseTo(-0.21, 9);
  });

  it('refuses a deadzone at or beyond full deflection rather than deadening the stick entirely', () => {
    // A controller that does nothing is a worse outcome than a controller with no deadzone.
    expect(applyRadialDeadzone(1, 1, 1)).toEqual({ x: 0, y: 0 });
  });

  it('returns zero rather than NaN for a non-finite stick', () => {
    expect(applyRadialDeadzone(Number.NaN, 0, 0.2)).toEqual({ x: 0, y: 0 });
    expect(applyRadialDeadzone(0, Number.POSITIVE_INFINITY, 0.2)).toEqual({ x: 0, y: 0 });
  });

  it('this is what stops a drifting stick from slowly rotating the camera', () => {
    // The GDD calls this out as a genuinely common reported bug in shipped games. A stick that
    // rests at 0.08 of full deflection would, without a deadzone, rotate the camera forever — the
    // player puts the controller down and the view slowly turns.
    const drift = applyRadialDeadzone(0.08, 0.03, 0.15);
    expect(drift.x).toBe(0);
    expect(drift.y).toBe(0);
  });
});

describe('water wobble', () => {
  it('oscillates within the configured amplitude', () => {
    const amplitude = 0.05;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    for (let t = 0; t < 4; t += 0.005) {
      const value = waterWobble(t, 0.6, amplitude, 0);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }

    expect(max).toBeCloseTo(amplitude, 3);
    expect(min).toBeCloseTo(-amplitude, 3);
  });

  it('completes one cycle at the specified frequency', () => {
    const amplitude = 1;
    expect(waterWobble(0, 0.6, amplitude, 0)).toBeCloseTo(0, 9);
    // Quarter cycle at 0.6 Hz is 1/(4*0.6) seconds, where the sine peaks.
    expect(waterWobble(1 / (4 * 0.6), 0.6, amplitude, 0)).toBeCloseTo(1, 6);
    expect(waterWobble(1 / 0.6, 0.6, amplitude, 0)).toBeCloseTo(0, 6);
  });

  it('a phase offset of pi/2 gives a circular motion rather than a line', () => {
    // Two wobbles in quadrature describe a circle, which reads as buoyancy rather than as a
    // pendulum. In phase they would just be a stronger pendulum.
    const a = waterWobble(0.3, 0.6, 1, 0);
    const b = waterWobble(0.3, 0.6, 1, Math.PI / 2);
    expect(a * a + b * b).toBeCloseTo(1, 6);
  });

  it('returns 0 rather than NaN for degenerate inputs', () => {
    expect(waterWobble(Number.NaN, 0.6, 0.05, 0)).toBe(0);
    expect(waterWobble(1, Number.NaN, 0.05, 0)).toBe(0);
    expect(waterWobble(1, 0.6, Number.NaN, 0)).toBe(0);
  });
});
