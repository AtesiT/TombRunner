/**
 * Unit tests for analogue signal shaping.
 *
 * The deadzone's tests moved here with the function when it left `camera.ts` in Milestone 1.4. The
 * camera's test file no longer tests it, so this file is the only place it is verified — which is
 * the point of moving it: two systems depend on the same behaviour, so there should be exactly one
 * place to look and one place to break.
 *
 * Everything here is a formula, so everything here is asserted rather than eyeballed.
 */

import { describe, it, expect } from 'vitest';
import {
  applyRadialDeadzone,
  normalizeTrigger,
  resolveMovement,
  stickToWorldDirection,
} from '../../src/core/math/analog';

describe('applyRadialDeadzone', () => {
  it('zeroes everything inside the deadzone', () => {
    const inside = applyRadialDeadzone(0.05, 0.05, 0.2);
    expect(inside.x).toBe(0);
    expect(inside.y).toBe(0);
  });

  it('has no discontinuity at the deadzone edge', () => {
    // A hard cutoff without rescaling makes the output jump from 0 to `deadzone` the instant the
    // stick crosses the threshold, so the stick appears to catch.
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

  it('is RADIAL, so a diagonal push is not dead while a straight push is not', () => {
    // A per-axis deadzone creates a cross-shaped dead region: pushing diagonally registers when
    // pushing straight up does not. Players feel this as "the stick is broken in the corners".
    const deadzone = 0.3;
    const straight = applyRadialDeadzone(0, deadzone * 1.5, deadzone);
    const diagonal = applyRadialDeadzone(
      deadzone * 1.5 * Math.SQRT1_2,
      deadzone * 1.5 * Math.SQRT1_2,
      deadzone,
    );

    expect(Math.hypot(straight.x, straight.y)).toBeGreaterThan(0);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(Math.hypot(straight.x, straight.y), 6);
  });

  it('preserves direction exactly', () => {
    const filtered = applyRadialDeadzone(0.6, -0.8, 0.2);
    expect(filtered.x / -filtered.y).toBeCloseTo(0.6 / 0.8, 6);
  });

  it('passes the input through unchanged when there is no deadzone', () => {
    const passthrough = applyRadialDeadzone(0.37, -0.21, 0);
    expect(passthrough.x).toBeCloseTo(0.37, 9);
    expect(passthrough.y).toBeCloseTo(-0.21, 9);
  });

  it('refuses a deadzone beyond full deflection rather than deadening the stick entirely', () => {
    expect(applyRadialDeadzone(1, 1, 1)).toEqual({ x: 0, y: 0 });
  });

  it('returns zero rather than NaN for a non-finite input', () => {
    expect(applyRadialDeadzone(Number.NaN, 0, 0.2)).toEqual({ x: 0, y: 0 });
    expect(applyRadialDeadzone(0, Number.POSITIVE_INFINITY, 0.2)).toEqual({ x: 0, y: 0 });
  });
});

describe('normalizeTrigger', () => {
  it('discards the rest offset of an analogue trigger', () => {
    // Real hardware rests under its own spring load and reports a small non-zero value. Without
    // this, a controller sitting untouched on a desk reads as "aim held permanently".
    expect(normalizeTrigger(0.04, 0.06)).toBe(0);
    expect(normalizeTrigger(0.06, 0.06)).toBe(0);
  });

  it('rescales so a fully-pulled trigger reaches exactly 1', () => {
    expect(normalizeTrigger(1.0, 0.06)).toBeCloseTo(1, 9);
  });

  it('is continuous at the threshold', () => {
    const below = normalizeTrigger(0.059, 0.06);
    const above = normalizeTrigger(0.061, 0.06);
    expect(below).toBe(0);
    expect(above).toBeLessThan(0.01);
  });

  it('reports half-travel as roughly half', () => {
    // 0.53 raw with a 0.06 rest is halfway through the usable travel.
    expect(normalizeTrigger(0.53, 0.06)).toBeCloseTo(0.5, 2);
  });

  it('treats a digital trigger as 0 or 1', () => {
    expect(normalizeTrigger(0, 0.06)).toBe(0);
    expect(normalizeTrigger(1, 0.06)).toBe(1);
  });

  it('returns 0 rather than NaN for a non-finite value', () => {
    expect(normalizeTrigger(Number.NaN, 0.06)).toBe(0);
    // Infinity is *refused* rather than clamped to 1. A trigger reporting Infinity is a broken
    // device or a broken driver, and "held" is the one answer that makes it worse: the player
    // would be permanently aiming with no way to stop. (A real trigger reports a value.)
    expect(normalizeTrigger(Number.POSITIVE_INFINITY, 0.06)).toBe(0);
    expect(normalizeTrigger(Number.NEGATIVE_INFINITY, 0.06)).toBe(0);
  });

  it('never reports a resting trigger as held, at any plausible rest value', () => {
    // Swept, because the failure mode is a device whose resting value lands just above whatever
    // threshold was chosen — and that is exactly what a single hard-coded number gets wrong.
    for (const rest of [0.02, 0.05, 0.06, 0.1, 0.15]) {
      expect(normalizeTrigger(rest, rest), `rest=${rest}`).toBe(0);
      expect(normalizeTrigger(rest * 0.5, rest), `rest=${rest}`).toBe(0);
    }
  });
});

describe('resolveMovement', () => {
  it('prefers the larger magnitude, so two devices cannot add up', () => {
    // Adding the two vectors lets a half-deflected stick add to a full-magnitude key and produce a
    // magnitude above 1, which the character controller would then have to clamp — moving the
    // arbitration into a system with no business knowing two devices exist.
    const resolved = resolveMovement({ x: 0, y: 1 }, { x: 0.5, y: 0 });
    expect(resolved.magnitude).toBeCloseTo(1, 6);
    expect(resolved.direction.y).toBeCloseTo(1, 6);
    expect(resolved.direction.x).toBeCloseTo(0, 6);
  });

  it('lets the stick win when it is pushed harder', () => {
    const resolved = resolveMovement({ x: 0, y: 0.4 }, { x: 1, y: 0 });
    expect(resolved.magnitude).toBeCloseTo(1, 6);
    expect(resolved.direction.x).toBeCloseTo(1, 6);
  });

  it('reports zero when neither device is moving', () => {
    const resolved = resolveMovement({ x: 0, y: 0 }, { x: 0, y: 0 });
    expect(resolved.magnitude).toBe(0);
    expect(resolved.direction).toEqual({ x: 0, y: 0 });
  });

  it('caps the magnitude at 1', () => {
    const resolved = resolveMovement({ x: 1, y: 1 }, { x: 0, y: 0 });
    expect(resolved.magnitude).toBeLessThanOrEqual(1);
  });

  it('returns a unit direction, so a caller cannot apply the magnitude twice', () => {
    for (const push of [0.2, 0.5, 0.9, 1.0]) {
      const resolved = resolveMovement({ x: 0, y: push }, { x: 0, y: 0 });
      expect(Math.hypot(resolved.direction.x, resolved.direction.y), `push=${push}`).toBeCloseTo(
        1,
        6,
      );
    }
  });

  it('survives a non-finite source', () => {
    const resolved = resolveMovement({ x: Number.NaN, y: 0 }, { x: 0, y: 0 });
    expect(resolved.magnitude).toBe(0);
  });
});

describe('stickToWorldDirection — the camera-relative transform', () => {
  it('maps forward to the camera forward, whatever the camera yaw', () => {
    // The whole point: W must move the character away from the camera, which is what every
    // third-person game since the N64 era does and what the player's hands already expect.
    for (const yaw of [-2, -1, 0, 0.5, 1.3, 2.9]) {
      const world = stickToWorldDirection({ x: 0, y: 1 }, yaw);
      const cameraForwardX = Math.sin(yaw);
      const cameraForwardZ = Math.cos(yaw);
      const dot = world.x * cameraForwardX + world.z * cameraForwardZ;
      expect(dot, `yaw=${yaw}`).toBeCloseTo(1, 6);
    }
  });

  it('maps right to the camera right', () => {
    // The z sign here is the one that is easy to get backwards, and getting it backwards does not
    // produce an obvious bug: the character walks correctly forward and backwards and
    // sideways-inverted, which players report as "strafing feels wrong".
    for (const yaw of [-2, 0, 0.7, 2.1]) {
      const world = stickToWorldDirection({ x: 1, y: 0 }, yaw);
      const cameraRightX = Math.cos(yaw);
      const cameraRightZ = -Math.sin(yaw);
      const dot = world.x * cameraRightX + world.z * cameraRightZ;
      expect(dot, `yaw=${yaw}`).toBeCloseTo(1, 6);
    }
  });

  it('keeps right perpendicular to forward at every yaw', () => {
    for (let yaw = -3; yaw <= 3; yaw += 0.25) {
      const forward = stickToWorldDirection({ x: 0, y: 1 }, yaw);
      const right = stickToWorldDirection({ x: 1, y: 0 }, yaw);
      const dot = forward.x * right.x + forward.z * right.z;
      expect(dot, `yaw=${yaw}`).toBeCloseTo(0, 9);
    }
  });

  it('returns a unit direction for any input', () => {
    for (const stick of [
      { x: 0, y: 1 },
      { x: 0.6, y: 0.8 },
      { x: -0.5, y: -0.5 },
      { x: 0.1, y: 0.01 },
    ]) {
      const world = stickToWorldDirection(stick, 1.1);
      expect(Math.hypot(world.x, world.z)).toBeCloseTo(1, 9);
    }
  });

  it('returns zero for no input rather than a direction', () => {
    expect(stickToWorldDirection({ x: 0, y: 0 }, 1.2)).toEqual({ x: 0, z: 0 });
  });

  it('treats a non-finite yaw as zero rather than producing NaN', () => {
    // A NaN world direction would be integrated straight into the character's position, which is a
    // silent permanent corruption rather than a visible bug.
    const world = stickToWorldDirection({ x: 0, y: 1 }, Number.NaN);
    expect(Number.isFinite(world.x)).toBe(true);
    expect(Number.isFinite(world.z)).toBe(true);
    expect(world.z).toBeCloseTo(1, 6);
  });

  it('at zero yaw, forward is +Z and right is +X', () => {
    // The concrete case, spelled out so a sign inversion is caught by reading rather than by
    // reasoning: the camera faces +Z at yaw 0, so forward is +Z and the player's right is +X.
    const forward = stickToWorldDirection({ x: 0, y: 1 }, 0);
    const right = stickToWorldDirection({ x: 1, y: 0 }, 0);
    expect(forward.z).toBeCloseTo(1, 9);
    expect(forward.x).toBeCloseTo(0, 9);
    expect(right.x).toBeCloseTo(1, 9);
    expect(right.z).toBeCloseTo(0, 9);
  });

  it('at 180 degrees of yaw, forward is -Z and right is -X', () => {
    const forward = stickToWorldDirection({ x: 0, y: 1 }, Math.PI);
    const right = stickToWorldDirection({ x: 1, y: 0 }, Math.PI);
    expect(forward.z).toBeCloseTo(-1, 6);
    expect(right.x).toBeCloseTo(-1, 6);
  });
});
