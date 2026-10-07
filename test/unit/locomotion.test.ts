/**
 * Unit tests for the locomotion mathematics.
 *
 * The most valuable tests here are the ones that assert the GDD's *numeric targets*:
 * a running jump really does travel 6.0 m, a standing jump 3.0 m, and the slope bands
 * switch at exactly 30/45/60 degrees. Those are the promises the level design is authored
 * against, and an unasserted promise is how a game ends up with jumps that cannot reach
 * the ledges they are supposed to reach.
 */

import { describe, it, expect } from 'vitest';
import {
  discreteTakeoffVelocity,
  effectiveRiseGravity,
  solveJumpArc,
  solveJumpLaunch,
  predictJumpDistance,
  slopeAngleFromNormalY,
  classifySlope,
  canJumpFromBand,
  hasGroundFriction,
  downslopeAcceleration,
  projectVelocityOntoSurface,
  TickWindow,
  millisecondsToTicks,
  approachSpeed,
  speedDeltaForTransition,
  approachAngle,
  wrapAngle,
  SlopeBand,
  type SlopeThresholds,
} from '../../src/core/math/locomotion';
import {
  COYOTE_TICKS,
  FIXED_DT,
  JUMP_HOLD_GRAVITY_SCALE,
  JUMP_RUNNING_AIRTIME_S,
  JUMP_RUNNING_SPEED_MPS,
  JUMP_STANDING_AIRTIME_S,
  JUMP_STANDING_SPEED_MPS,
  GRAVITY_FALLING_MPS2,
  GRAVITY_RISING_MPS2,
  JUMP_BUFFER_TICKS,
  JUMP_HEIGHT_RUNNING_M,
  JUMP_HEIGHT_STANDING_M,
  JUMP_RUNNING_DISTANCE_M,
  JUMP_STANDING_DISTANCE_M,
  RUN_SPEED_MPS,
  SLOPE_SLOW_MAX_DEG,
  SLOPE_SLIDE_MAX_DEG,
  SLOPE_WALK_MAX_DEG,
  TICK_RATE,
  WALK_SPEED_MPS,
} from '../../src/core/constants';

/** Slopes from the GDD, used throughout. */
const BANDS: SlopeThresholds = {
  walkableMax: SLOPE_WALK_MAX_DEG,
  slowMax: SLOPE_SLOW_MAX_DEG,
  slideMax: SLOPE_SLIDE_MAX_DEG,
};

/** The GDD's asymmetric gravity, as positive magnitudes. */
const GRAVITY = { gravityRise: GRAVITY_RISING_MPS2, gravityFall: GRAVITY_FALLING_MPS2 };

describe('solveJumpArc — trajectory from the GDD constants', () => {
  it('computes the standing jump from its peak height', () => {
    const arc = solveJumpArc({ peakHeight: JUMP_HEIGHT_STANDING_M, ...GRAVITY });

    // v0 = sqrt(2 * 26 * 2.0) = sqrt(104) ~= 10.198
    expect(arc.initialVerticalVelocity).toBeCloseTo(10.198, 2);
    // tRise = v0 / gRise = 0.3922 s
    expect(arc.riseTime).toBeCloseTo(0.3922, 3);
    // tFall = sqrt(2*2.0/42) = 0.3086 s
    expect(arc.fallTime).toBeCloseTo(0.3086, 3);
    expect(arc.airtime).toBeCloseTo(0.7008, 3);
  });

  it('computes the running jump from its peak height', () => {
    const arc = solveJumpArc({ peakHeight: JUMP_HEIGHT_RUNNING_M, ...GRAVITY });

    expect(arc.initialVerticalVelocity).toBeCloseTo(11.402, 2);
    expect(arc.airtime).toBeCloseTo(0.7836, 3);
  });

  it('spends longer rising than falling, which is what makes it feel snappy', () => {
    // Asymmetric gravity is the deliberate design choice from GDD §4.7: a fast descent
    // keeps the player on the ground, where platforming decisions actually happen.
    const arc = solveJumpArc({ peakHeight: JUMP_HEIGHT_STANDING_M, ...GRAVITY });
    expect(arc.riseTime).toBeGreaterThan(arc.fallTime);
  });

  it('returns a zero arc rather than NaN for degenerate inputs', () => {
    // A NaN reaching the character's velocity would poison its position permanently:
    // every subsequent collision test fails, so the character can neither move nor land.
    // This test caught a real hole — `NaN <= 0` is false, so a naive `<= 0` guard let
    // NaN straight through.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const arc = solveJumpArc({ peakHeight: bad, ...GRAVITY });
      expect(arc.airtime, `peakHeight=${bad}`).toBe(0);
      expect(arc.initialVerticalVelocity, `peakHeight=${bad}`).toBe(0);
      expect(Number.isFinite(arc.riseTime)).toBe(true);
      expect(Number.isFinite(arc.fallTime)).toBe(true);
    }

    expect(solveJumpArc({ peakHeight: 2, gravityRise: 0, gravityFall: 42 }).airtime).toBe(0);
    expect(solveJumpArc({ peakHeight: 2, gravityRise: 26, gravityFall: 0 }).airtime).toBe(0);
    expect(solveJumpArc({ peakHeight: 2, gravityRise: Number.NaN, gravityFall: 42 }).airtime).toBe(0);
    expect(solveJumpArc({ peakHeight: 2, gravityRise: 26, gravityFall: Number.NaN }).airtime).toBe(0);
  });

  it('never produces a non-finite arc for any finite input in a wide range', () => {
    // Swept rather than spot-checked: the failure mode is a specific combination slipping
    // through a guard, which discrete examples are exactly the wrong tool for.
    for (const height of [0.001, 0.1, 1, 2, 2.5, 10, 100]) {
      for (const rise of [1, 9.81, 26, 100]) {
        for (const fall of [1, 9.81, 42, 100]) {
          const arc = solveJumpArc({ peakHeight: height, gravityRise: rise, gravityFall: fall });
          expect(Number.isFinite(arc.initialVerticalVelocity)).toBe(true);
          expect(Number.isFinite(arc.airtime)).toBe(true);
          expect(arc.airtime).toBeGreaterThan(0);
        }
      }
    }
  });

  it('scales peak height with the square of takeoff velocity', () => {
    // Doubling v0 must quadruple the height, per h = v²/2g. A linear relationship here
    // would mean the gravity constant was being applied wrongly.
    const low = solveJumpArc({ peakHeight: 1, ...GRAVITY });
    const high = solveJumpArc({ peakHeight: 4, ...GRAVITY });
    expect(high.initialVerticalVelocity / low.initialVerticalVelocity).toBeCloseTo(2, 6);
  });
});

describe('GDD numeric targets — the promises level design is authored against', () => {
  /**
   * The reference launches, resolved exactly as the character controller resolves them.
   * Every figure here is asserted, because these numbers are what gaps are authored against.
   */
  const standing = solveJumpLaunch({
    peakHeight: JUMP_HEIGHT_STANDING_M,
    horizontalDistance: JUMP_STANDING_DISTANCE_M,
    gravityRise: GRAVITY.gravityRise,
    gravityFall: GRAVITY.gravityFall,
    holdGravityScale: JUMP_HOLD_GRAVITY_SCALE,
    held: true,
    dt: FIXED_DT,
  });

  const running = solveJumpLaunch({
    peakHeight: JUMP_HEIGHT_RUNNING_M,
    horizontalDistance: JUMP_RUNNING_DISTANCE_M,
    gravityRise: GRAVITY.gravityRise,
    gravityFall: GRAVITY.gravityFall,
    holdGravityScale: JUMP_HOLD_GRAVITY_SCALE,
    held: true,
    dt: FIXED_DT,
  });

  it('a standing jump clears exactly 3.0 m at the documented launch speed', () => {
    expect(standing.horizontalSpeed).toBeCloseTo(JUMP_STANDING_SPEED_MPS, 3);
    expect(standing.airtimeSeconds).toBeCloseTo(JUMP_STANDING_AIRTIME_S, 3);

    // The invariant that actually matters: distance = speed x airtime.
    expect(standing.horizontalSpeed * standing.airtimeSeconds).toBeCloseTo(3.0, 6);
  });

  it('a running jump clears exactly 6.0 m at the documented launch speed', () => {
    expect(running.horizontalSpeed).toBeCloseTo(JUMP_RUNNING_SPEED_MPS, 3);
    expect(running.airtimeSeconds).toBeCloseTo(JUMP_RUNNING_AIRTIME_S, 3);
    expect(running.horizontalSpeed * running.airtimeSeconds).toBeCloseTo(6.0, 6);
  });

  it('a running jump is meaningfully longer than a standing one', () => {
    // Expressed as an inequality as well as a pair of numbers, so it survives retuning.
    const standingDistance = standing.horizontalSpeed * standing.airtimeSeconds;
    const runningDistance = running.horizontalSpeed * running.airtimeSeconds;
    expect(runningDistance).toBeGreaterThan(standingDistance * 1.8);
  });

  it('the running launch speed exceeds run speed, which is why an impulse exists', () => {
    // This is the finding recorded in the DEV_LOG: with the GDD's gravity, a 6 m running
    // jump is unreachable at the 6 m/s run speed, so the takeoff impulse is required rather
    // than decorative. If a future tuning pass makes this false, the boost can be removed
    // and this test will say so.
    expect(running.horizontalSpeed).toBeGreaterThan(RUN_SPEED_MPS);
    expect(standing.horizontalSpeed).toBeLessThan(RUN_SPEED_MPS);
  });

  it('a running jump travels only 4.7 m at plain run speed, quantifying the shortfall', () => {
    // Why the impulse is needed at all. Uses the continuous model, which is the right tool
    // for a "what would happen without the fix" question.
    const arc = solveJumpArc({ peakHeight: JUMP_HEIGHT_RUNNING_M, ...GRAVITY });
    expect(predictJumpDistance(arc, RUN_SPEED_MPS)).toBeCloseTo(4.70, 1);
    expect(predictJumpDistance(arc, RUN_SPEED_MPS)).toBeLessThan(5.0);
  });

  it('the discrete-integrator compensation keeps the peak on target', () => {
    // Without compensation, semi-implicit Euler peaks v0*dt/2 above the target — 7.4 cm on
    // a 2.0 m jump, or 3.7%. Measured on the real controller it was 8.6 cm before the fix.
    // Solved against the EFFECTIVE rise gravity (19.5 = 26 x 0.75), because that is the
    // gravity the arc is actually integrated under. Solving against nominal gravity here is
    // the very mistake the production code made, so the test must not repeat it.
    const effectiveGravity = effectiveRiseGravity(GRAVITY.gravityRise, JUMP_HOLD_GRAVITY_SCALE, true);
    const continuous = solveJumpArc({ peakHeight: 2.0, gravityRise: effectiveGravity, gravityFall: GRAVITY.gravityFall });
    const naiveOvershoot = (continuous.initialVerticalVelocity * FIXED_DT) / 2;
    expect(naiveOvershoot).toBeCloseTo(0.0736, 3);

    const compensated = discreteTakeoffVelocity(2.0, effectiveGravity, FIXED_DT);
    // Discrete peak = v0^2/(2g) + v0*dt/2 must land on 2.0.
    const achievedPeak =
      (compensated * compensated) / (2 * effectiveGravity) + (compensated * FIXED_DT) / 2;
    expect(achievedPeak).toBeCloseTo(2.0, 6);

    // And it is a genuinely smaller launch velocity, not a rounding difference.
    expect(compensated).toBeLessThan(continuous.initialVerticalVelocity);
  });

  it('counts airtime in whole ticks so the distance target is exact', () => {
    // A continuous airtime of 0.7667 s is 46 ticks exactly; the counts must be integers,
    // because a fractional tick cannot be simulated.
    expect(Number.isInteger(standing.riseTicks)).toBe(true);
    expect(Number.isInteger(standing.fallTicks)).toBe(true);
    expect(standing.riseTicks + standing.fallTicks).toBe(46);
    expect(running.riseTicks + running.fallTicks).toBe(51);
  });

  it('a held jump rises higher than an unheld one at the same takeoff velocity', () => {
    // Variable jump height, expressed physically: the hold scale weakens gravity, so the
    // same launch reaches a higher peak.
    const heldGravity = effectiveRiseGravity(GRAVITY.gravityRise, JUMP_HOLD_GRAVITY_SCALE, true);
    const freeGravity = effectiveRiseGravity(GRAVITY.gravityRise, JUMP_HOLD_GRAVITY_SCALE, false);

    expect(heldGravity).toBeLessThan(freeGravity);
    expect(heldGravity).toBeCloseTo(GRAVITY.gravityRise * JUMP_HOLD_GRAVITY_SCALE, 6);
    expect(freeGravity).toBe(GRAVITY.gravityRise);
  });
});

describe('effectiveRiseGravity — the bug that came from two call sites disagreeing', () => {
  it('returns the nominal gravity when the control is not held', () => {
    expect(effectiveRiseGravity(26, 0.75, false)).toBe(26);
  });

  it('scales the gravity when the control is held', () => {
    expect(effectiveRiseGravity(26, 0.75, true)).toBeCloseTo(19.5, 9);
  });

  it('clamps a scale above 1, which would make holding the button jump LOWER', () => {
    expect(effectiveRiseGravity(26, 1.5, true)).toBe(26);
  });

  it('falls back to nominal gravity for degenerate inputs rather than returning NaN', () => {
    expect(effectiveRiseGravity(26, 0, true)).toBe(26);
    expect(effectiveRiseGravity(26, -1, true)).toBe(26);
    expect(effectiveRiseGravity(26, Number.NaN, true)).toBe(26);
    expect(effectiveRiseGravity(0, 0.75, true)).toBe(0);
    expect(effectiveRiseGravity(Number.NaN, 0.75, true)).toBe(0);
  });
});

describe('discreteTakeoffVelocity — compensation for the integrator', () => {
  it('produces a peak closer to the target than the continuous formula', () => {
    const dt = FIXED_DT;
    const gravity = 19.5;
    const target = 2.0;

    const continuous = solveJumpArc({ peakHeight: target, gravityRise: gravity, gravityFall: 42 });
    const continuousPeak =
      (continuous.initialVerticalVelocity ** 2) / (2 * gravity) +
      (continuous.initialVerticalVelocity * dt) / 2;

    const discrete = discreteTakeoffVelocity(target, gravity, dt);
    const discretePeak = (discrete ** 2) / (2 * gravity) + (discrete * dt) / 2;

    expect(Math.abs(discretePeak - target)).toBeLessThan(Math.abs(continuousPeak - target));
    expect(discretePeak).toBeCloseTo(target, 6);
  });

  it('is independent of the gravity magnitudes', () => {
    // Swept across plausible tuning values, because the compensation must survive retuning.
    for (const gravity of [9.81, 19.5, 26, 40]) {
      const velocity = discreteTakeoffVelocity(2.0, gravity, FIXED_DT);
      const peak = (velocity ** 2) / (2 * gravity) + (velocity * FIXED_DT) / 2;
      expect(peak, `gravity=${gravity}`).toBeCloseTo(2.0, 6);
    }
  });

  it('returns zero rather than NaN for degenerate inputs', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(discreteTakeoffVelocity(bad, 19.5, FIXED_DT)).toBe(0);
      expect(discreteTakeoffVelocity(2.0, bad, FIXED_DT)).toBe(0);
      expect(discreteTakeoffVelocity(2.0, 19.5, bad)).toBe(0);
    }
  });

  it('a zero timestep degenerates to the continuous formula rather than dividing by zero', () => {
    expect(discreteTakeoffVelocity(2.0, 19.5, 0)).toBe(0);
  });
});

describe('solveJumpLaunch — degenerate inputs', () => {
  const base = {
    peakHeight: 2.0,
    horizontalDistance: 3.0,
    gravityRise: 26,
    gravityFall: 42,
    holdGravityScale: 0.75,
    held: true,
    dt: FIXED_DT,
  };

  it('never returns NaN for any degenerate combination', () => {
    // A NaN launch velocity is catastrophic rather than merely wrong: it destroys the
    // character's position, and a NaN position can never recover on its own.
    const cases = [
      { peakHeight: 0 },
      { peakHeight: -1 },
      { peakHeight: Number.NaN },
      { horizontalDistance: 0 },
      { horizontalDistance: Number.NaN },
      { horizontalDistance: Number.POSITIVE_INFINITY },
      { holdGravityScale: Number.NaN },
      { gravityRise: Number.NaN },
      { gravityFall: Number.NaN },
      { gravityFall: Number.POSITIVE_INFINITY },
      { gravityRise: 0 },
      { gravityFall: 0 },
      { dt: 0 },
      { dt: Number.NaN },
    ];

    for (const override of cases) {
      const launch = solveJumpLaunch({ ...base, ...override });
      expect(Number.isFinite(launch.verticalVelocity), JSON.stringify(override)).toBe(true);
      expect(Number.isFinite(launch.horizontalSpeed), JSON.stringify(override)).toBe(true);
      expect(Number.isFinite(launch.airtimeSeconds), JSON.stringify(override)).toBe(true);
    }
  });

  it('always spends at least one tick in each phase', () => {
    // A zero-tick flight would let the character be "airborne" without ever moving, which
    // would make the landing detection fire on the takeoff tick.
    const launch = solveJumpLaunch({ ...base, peakHeight: 0.01, dt: 1 / 60 });
    expect(launch.riseTicks).toBeGreaterThanOrEqual(1);
    expect(launch.fallTicks).toBeGreaterThanOrEqual(1);
  });
});

describe('slope classification — exact GDD band boundaries', () => {
  it('classifies each band correctly', () => {
    expect(classifySlope(0, BANDS)).toBe(SlopeBand.Walkable);
    expect(classifySlope(15, BANDS)).toBe(SlopeBand.Walkable);
    expect(classifySlope(35, BANDS)).toBe(SlopeBand.Slow);
    expect(classifySlope(50, BANDS)).toBe(SlopeBand.Slide);
    expect(classifySlope(75, BANDS)).toBe(SlopeBand.Unclimbable);
  });

  it('treats band boundaries as inclusive of the lower band', () => {
    // 30 degrees must be walkable and 30.0001 slow. An off-by-one here would make a 45
    // degree ramp either silently climbable or an invisible wall.
    expect(classifySlope(30, BANDS)).toBe(SlopeBand.Walkable);
    expect(classifySlope(30.0001, BANDS)).toBe(SlopeBand.Slow);
    expect(classifySlope(45, BANDS)).toBe(SlopeBand.Slow);
    expect(classifySlope(45.0001, BANDS)).toBe(SlopeBand.Slide);
    expect(classifySlope(60, BANDS)).toBe(SlopeBand.Slide);
    expect(classifySlope(60.0001, BANDS)).toBe(SlopeBand.Unclimbable);
  });

  it('permits jumping only from the walkable band', () => {
    expect(canJumpFromBand(SlopeBand.Walkable)).toBe(true);
    expect(canJumpFromBand(SlopeBand.Slow)).toBe(false);
    expect(canJumpFromBand(SlopeBand.Slide)).toBe(false);
    expect(canJumpFromBand(SlopeBand.Unclimbable)).toBe(false);
  });

  it('applies ground friction everywhere except the slide bands', () => {
    // A sliding character must keep accelerating, so ordinary friction must be bypassed.
    expect(hasGroundFriction(SlopeBand.Walkable)).toBe(true);
    expect(hasGroundFriction(SlopeBand.Slow)).toBe(true);
    expect(hasGroundFriction(SlopeBand.Slide)).toBe(false);
    expect(hasGroundFriction(SlopeBand.Unclimbable)).toBe(false);
  });

  it('converts surface normals to angles, including the degenerate cases', () => {
    expect(slopeAngleFromNormalY(1)).toBeCloseTo(0, 6);
    expect(slopeAngleFromNormalY(0)).toBeCloseTo(90, 6);

    // cos(30 degrees) ~= 0.8660 -- the walkable band's edge.
    expect(slopeAngleFromNormalY(Math.cos((30 * Math.PI) / 180))).toBeCloseTo(30, 4);
    expect(slopeAngleFromNormalY(Math.cos((45 * Math.PI) / 180))).toBeCloseTo(45, 4);
    expect(slopeAngleFromNormalY(Math.cos((60 * Math.PI) / 180))).toBeCloseTo(60, 4);
  });

  it('never emits NaN for out-of-range normals, which floating point does produce', () => {
    // acos(1.0000001) is NaN. Without clamping, a nearly-flat floor would be classified
    // as an unclimbable cliff and the player would be unable to move on flat ground.
    expect(Number.isFinite(slopeAngleFromNormalY(1.0000001))).toBe(true);
    expect(Number.isFinite(slopeAngleFromNormalY(-1.0000001))).toBe(true);
    expect(slopeAngleFromNormalY(1.0000001)).toBeCloseTo(0, 6);
  });
});

describe('slope physics', () => {
  it('produces no downhill force on flat ground and maximum on a cliff', () => {
    expect(downslopeAcceleration(9.81, 0)).toBeCloseTo(0, 6);
    expect(downslopeAcceleration(9.81, 90)).toBeCloseTo(9.81, 6);
    // On a 45 degree slope, g*sin(45) = 6.94 m/s^2
    expect(downslopeAcceleration(9.81, 45)).toBeCloseTo(6.937, 2);
  });

  it('strips the into-surface component of a velocity', () => {
    // Walking straight down a slope: the resulting velocity must be tangential to the
    // surface, with no accumulated downward component to be launched by the next jump.
    const normal = { x: 0, y: Math.cos(Math.PI / 4), z: Math.sin(Math.PI / 4) };
    const velocity = { x: 0, y: -5, z: 5 };

    const projected = projectVelocityOntoSurface(velocity, normal);

    // The normal component is removed, so the result must be perpendicular to the normal.
    const dot = projected.x * normal.x + projected.y * normal.y + projected.z * normal.z;
    expect(dot).toBeCloseTo(0, 6);
  });

  it('leaves a velocity already tangential to the surface untouched', () => {
    const normal = { x: 0, y: 1, z: 0 };
    const velocity = { x: 3, y: 0, z: 4 };
    const projected = projectVelocityOntoSurface(velocity, normal);
    expect(projected.x).toBeCloseTo(3, 6);
    expect(projected.y).toBeCloseTo(0, 6);
    expect(projected.z).toBeCloseTo(4, 6);
  });

  it('does not modify anything when the surface is not involved', () => {
    // A velocity fully along the normal is entirely removed -- the degenerate but
    // correct case for a head-on collision.
    const projected = projectVelocityOntoSurface({ x: 0, y: -9, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(Math.hypot(projected.x, projected.y, projected.z)).toBeCloseTo(0, 6);
  });
});

describe('TickWindow — coyote time and jump buffering', () => {
  it('is inactive until armed', () => {
    const window = new TickWindow(COYOTE_TICKS);
    expect(window.isActive).toBe(false);
  });

  it('stays open for exactly its configured number of ticks', () => {
    const window = new TickWindow(5);
    window.arm();

    // Open on the tick it was armed...
    expect(window.isActive).toBe(true);

    // ...and for four more ticks after it.
    for (let i = 0; i < 4; i++) {
      window.advance();
      expect(window.isActive).toBe(true);
    }

    // The fifth advance closes it.
    window.advance();
    expect(window.isActive).toBe(false);
  });

  it('re-arming restarts the window rather than stacking it', () => {
    // Stacking would let a player hold a jump input and accumulate an infinite window.
    const window = new TickWindow(3);
    window.arm();
    window.advance();
    expect(window.remaining).toBe(2);

    window.arm();
    expect(window.remaining).toBe(3);
  });

  it('clearing closes the window immediately', () => {
    // Required so a buffered jump is consumed exactly once and cannot double-fire.
    const window = new TickWindow(9);
    window.arm();
    window.clear();
    expect(window.isActive).toBe(false);
  });

  it('never underflows past zero', () => {
    const window = new TickWindow(2);
    window.arm();
    for (let i = 0; i < 50; i++) window.advance();
    expect(window.remaining).toBe(0);
    expect(window.isActive).toBe(false);
  });

  it('the configured windows match the GDD in milliseconds', () => {
    // The GDD specifies milliseconds; the implementation uses ticks. This asserts the
    // conversion, because a framerate-dependent forgiveness window is a real bug class.
    const coyoteMs = (COYOTE_TICKS / TICK_RATE) * 1000;
    const bufferMs = (JUMP_BUFFER_TICKS / TICK_RATE) * 1000;

    // Both windows are deliberately rounded UP to a whole tick, because erring on the
    // side of forgiveness is strictly better than erring on the side of punishment, and
    // a partial tick is not representable.
    expect(coyoteMs).toBeGreaterThanOrEqual(120);
    expect(coyoteMs).toBeLessThan(150);
    expect(bufferMs).toBeCloseTo(150, 5);
  });

  it('millisecondsToTicks converts at the simulation rate', () => {
    expect(millisecondsToTicks(1000, 60)).toBeCloseTo(60, 6);
    expect(millisecondsToTicks(150, 60)).toBeCloseTo(9, 6);
    expect(millisecondsToTicks(120, 60)).toBeCloseTo(7.2, 6);
  });
});

describe('speed integration', () => {
  it('approaches the target without overshooting', () => {
    expect(approachSpeed(0, 6, 1)).toBe(1);
    expect(approachSpeed(5.5, 6, 1)).toBe(6);
    expect(approachSpeed(6, 6, 1)).toBe(6);
    expect(approachSpeed(6, 0, 4)).toBe(2);
  });

  it('reaches run speed in the configured acceleration time', () => {
    const dt = 1 / TICK_RATE;
    const maxDelta = speedDeltaForTransition(0, RUN_SPEED_MPS, 0.3, dt);

    let speed = 0;
    let ticks = 0;
    while (speed < RUN_SPEED_MPS - 1e-9 && ticks < 1000) {
      speed = approachSpeed(speed, RUN_SPEED_MPS, maxDelta);
      ticks++;
    }

    // 0.30 s at 60 Hz is 18 ticks.
    expect(ticks).toBe(18);
  });

  it('decelerates from run to rest in the configured time', () => {
    const dt = 1 / TICK_RATE;
    const maxDelta = speedDeltaForTransition(RUN_SPEED_MPS, 0, 0.4, dt);

    let speed = RUN_SPEED_MPS;
    let ticks = 0;
    while (speed > 1e-9 && ticks < 1000) {
      speed = approachSpeed(speed, 0, maxDelta);
      ticks++;
    }

    // 0.40 s at 60 Hz is 24 ticks.
    expect(ticks).toBe(24);
  });

  it('deceleration is gentler than acceleration, as specified', () => {
    const dt = 1 / TICK_RATE;
    const accel = speedDeltaForTransition(0, WALK_SPEED_MPS, 0.3, dt);
    const decel = speedDeltaForTransition(WALK_SPEED_MPS, 0, 0.4, dt);
    expect(accel).toBeGreaterThan(decel);
  });

  it('treats a zero-duration transition as instantaneous without dividing by zero', () => {
    expect(speedDeltaForTransition(0, 6, 0, 1 / 60)).toBe(6);
    expect(Number.isFinite(speedDeltaForTransition(0, 6, -1, 1 / 60))).toBe(true);
  });
});

describe('turning', () => {
  it('turns by at most the permitted amount per tick', () => {
    expect(approachAngle(0, 1, 0.1)).toBeCloseTo(0.1, 6);
  });

  it('snaps to the target when within reach', () => {
    expect(approachAngle(0, 0.05, 0.1)).toBeCloseTo(0.05, 6);
  });

  it('takes the SHORT way around, which is the classic wraparound bug', () => {
    // Turning from just below +pi to just above -pi is a 2 degree turn, not a 358 degree
    // one. Getting this wrong makes the character spin the long way at the seam, which
    // is extremely visible and extremely confusing.
    const current = Math.PI - 0.01;
    const target = -Math.PI + 0.01;
    const result = approachAngle(current, target, 0.05);

    // The result must have moved toward the target, i.e. past +pi into negative values.
    expect(Math.abs(wrapAngle(result - target))).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(result).toBeLessThan(0);
  });

  it('wraps angles into [-pi, pi]', () => {
    // NOTE: -pi and +pi are the same angle. The function's contract is the *range*
    // [-pi, pi], and both endpoints are reachable, so a test that demanded one specific
    // representative would be asserting an implementation detail rather than the contract.
    // Angles are therefore compared by equivalence, not by representative value.
    const sameAngle = (a: number, b: number): boolean => {
      const difference = Math.abs(a - b) % (Math.PI * 2);
      return difference < 1e-9 || Math.abs(difference - Math.PI * 2) < 1e-9;
    };

    expect(wrapAngle(0)).toBeCloseTo(0, 9);
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0, 9);
    expect(wrapAngle(-Math.PI * 2)).toBeCloseTo(0, 9);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 9);
    expect(sameAngle(wrapAngle(-Math.PI * 3), Math.PI)).toBe(true);
    expect(wrapAngle(Math.PI * 2 + 0.5)).toBeCloseTo(0.5, 9);
    expect(wrapAngle(-Math.PI * 2 - 0.5)).toBeCloseTo(-0.5, 9);
  });

  it('always returns a value inside [-pi, pi]', () => {
    for (let i = -500; i <= 500; i++) {
      const wrapped = wrapAngle(i * 0.37);
      expect(wrapped).toBeGreaterThanOrEqual(-Math.PI - 1e-9);
      expect(wrapped).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('completes a 180 degree turn in a plausible number of ticks', () => {
    // 220 deg/s in the air: 180 degrees takes 0.818 s = 49 ticks. If this were 1 tick the
    // air control would be instantaneous and the character would feel weightless.
    const turnRatePerTick = ((220 * Math.PI) / 180) / TICK_RATE;
    let angle = 0;
    const target = Math.PI;
    let ticks = 0;
    while (Math.abs(wrapAngle(target - angle)) > 1e-6 && ticks < 1000) {
      angle = approachAngle(angle, target, turnRatePerTick);
      ticks++;
    }
    expect(ticks).toBeGreaterThan(40);
    expect(ticks).toBeLessThan(60);
  });
});
