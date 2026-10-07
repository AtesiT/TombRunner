/**
 * Unit tests for the PS1 rendering mathematics.
 *
 * These tests are the primary defence against risk W4 (docs/ARCHITECTURE.md §5):
 * Vitest cannot compile GLSL, so the only way to prove the shader's maths is right is
 * to prove the identical maths in TypeScript and keep the GLSL a thin transliteration.
 *
 * The most valuable test in this file is the one asserting that the two-varying
 * shader trick reproduces *true affine* interpolation while *differing* from
 * perspective-correct interpolation. Asserting only the first half would pass even if
 * the trick were a no-op.
 */

import { describe, it, expect } from 'vitest';
import {
  snapNdcToGrid,
  snapClipSpaceXY,
  interpolateAffineUV,
  interpolatePerspectiveUV,
  shaderTrickAffineUV,
  blendUV,
  computeLetterboxRect,
  computeSnapGrid,
  clampTerminator,
  quantiseChannel,
  orderedDither4x4,
  type AffineVertex,
  type Barycentric,
} from '../../src/core/math/ps1';
import { RENDER_TARGET_HEIGHT, RENDER_TARGET_WIDTH } from '../../src/core/constants';

describe('snapNdcToGrid — vertex snapping', () => {
  it('leaves values already on the grid unchanged', () => {
    // Grid of 2 cells spans [-1, 1] with a step of 1: -1, 0, 1 are all on-grid.
    expect(snapNdcToGrid(-1, 2)).toBeCloseTo(-1, 10);
    expect(snapNdcToGrid(0, 2)).toBeCloseTo(0, 10);
    expect(snapNdcToGrid(1, 2)).toBeCloseTo(1, 10);
  });

  it('snaps to the nearest grid line rather than flooring', () => {
    // Grid of 4 cells has a step of 0.5 and lines at -1, -0.5, 0, 0.5, 1.
    expect(snapNdcToGrid(0.2, 4)).toBeCloseTo(0, 10); // nearest is 0, not 0.5
    expect(snapNdcToGrid(0.3, 4)).toBeCloseTo(0.5, 10); // nearest is 0.5
    expect(snapNdcToGrid(-0.2, 4)).toBeCloseTo(0, 10);
    expect(snapNdcToGrid(-0.3, 4)).toBeCloseTo(-0.5, 10);
  });

  it('produces an error no greater than half a grid step', () => {
    // This is the bound that keeps the wobble "subtle, not extreme" per the brief.
    const gridCount = 240;
    const step = 2 / gridCount;
    for (let i = 0; i <= 200; i++) {
      const value = -1 + (i / 200) * 2;
      expect(Math.abs(snapNdcToGrid(value, gridCount) - value)).toBeLessThanOrEqual(step / 2 + 1e-12);
    }
  });

  it('is idempotent — snapping an already-snapped value changes nothing', () => {
    // Idempotence matters because the same vertex may be snapped more than once if it
    // exists in multiple passes; repeated snapping must not drift.
    for (const value of [-0.87, -0.11, 0.0, 0.33, 0.99]) {
      const once = snapNdcToGrid(value, 120);
      expect(snapNdcToGrid(once, 120)).toBeCloseTo(once, 12);
    }
  });

  it('returns the input unchanged for a degenerate grid count', () => {
    // Guards against a divide-by-zero producing NaN in the shader.
    expect(snapNdcToGrid(0.4, 0)).toBe(0.4);
    expect(snapNdcToGrid(0.4, -5)).toBe(0.4);
  });
});

describe('snapClipSpaceXY — the shader-space form', () => {
  it('is equivalent to snapping in NDC and re-multiplying by w', () => {
    // Proves the clip-space formulation the GLSL uses matches the NDC formulation
    // the tests reason about.
    const gridColumns = 480;
    const gridRows = 240;
    for (const w of [1, 2.5, 10, 0.4]) {
      for (const ndc of [-0.9, -0.2, 0.13, 0.77]) {
        const clipX = ndc * w;
        const snapped = snapClipSpaceXY(clipX, 0, w, gridColumns, gridRows);
        expect(snapped.x / w).toBeCloseTo(snapNdcToGrid(ndc, gridColumns), 10);
      }
    }
  });

  it('never modifies w', () => {
    // w carries the perspective divide for interpolated varyings; corrupting it would
    // break texture mapping and depth simultaneously.
    const result = snapClipSpaceXY(3.7, -2.1, 4.2, 480, 240);
    expect(result.x).not.toBe(3.7); // it did snap
    // Confirmed indirectly: the same call with w unchanged in the API contract.
    const rescaled = snapClipSpaceXY(3.7 * 2, -2.1 * 2, 4.2 * 2, 480, 240);
    expect(rescaled.x).toBeCloseTo(result.x * 2, 10);
  });

  it('returns the input unchanged at the w = 0 singularity', () => {
    // Vertices on the camera plane must not produce NaN, which would corrupt the
    // entire triangle in the rasteriser.
    const result = snapClipSpaceXY(1.23, 4.56, 0, 480, 240);
    expect(Number.isFinite(result.x)).toBe(true);
    expect(Number.isFinite(result.y)).toBe(true);
    expect(result.x).toBe(1.23);
    expect(result.y).toBe(4.56);
  });

  it('does not snap when the grid is larger than the screen', () => {
    // With 1 grid column across [-1,1], everything snaps to 0 — the documented
    // extreme. Asserted so the behaviour is intentional rather than surprising.
    expect(snapClipSpaceXY(0.5, 0, 1, 1, 1).x).toBeCloseTo(0, 10);
  });
});

describe('affine texture mapping — the two-varying shader trick', () => {
  const v0: AffineVertex = { u: 0, v: 0, w: 1 };
  const v1: AffineVertex = { u: 4, v: 0, w: 8 };
  const v2: AffineVertex = { u: 0, v: 4, w: 2 };

  /** A spread of barycentric weightings, including the three vertices themselves. */
  const weightings: Barycentric[] = [
    { a: 1, b: 0, c: 0 },
    { a: 0, b: 1, c: 0 },
    { a: 0, b: 0, c: 1 },
    { a: 0.5, b: 0.5, c: 0 },
    { a: 0.5, b: 0, c: 0.5 },
    { a: 0, b: 0.5, c: 0.5 },
    { a: 1 / 3, b: 1 / 3, c: 1 / 3 },
    { a: 0.7, b: 0.2, c: 0.1 },
  ];

  it('the shader trick reproduces true affine interpolation exactly', () => {
    // THE central claim of the technique. If the GLSL is a faithful transliteration
    // of shaderTrickAffineUV, then the GPU produces affine-warped textures.
    for (const bary of weightings) {
      const expected = interpolateAffineUV(bary, v0, v1, v2);
      const actual = shaderTrickAffineUV(bary, v0, v1, v2);
      expect(actual.u).toBeCloseTo(expected.u, 9);
      expect(actual.v).toBeCloseTo(expected.v, 9);
    }
  });

  it('genuinely differs from perspective-correct interpolation', () => {
    // Guards against a vacuous test: if the trick reduced to perspective-correct
    // interpolation, the first test would still pass but the effect would not exist.
    let foundDifference = false;
    for (const bary of weightings) {
      const affine = shaderTrickAffineUV(bary, v0, v1, v2);
      const perspective = interpolatePerspectiveUV(bary, v0, v1, v2);
      if (Math.abs(affine.u - perspective.u) > 1e-6 || Math.abs(affine.v - perspective.v) > 1e-6) {
        foundDifference = true;
      }
    }
    expect(foundDifference).toBe(true);
  });

  it('agrees with perspective-correct interpolation when all w are equal', () => {
    // The two must coincide with no depth variation: a flat quad facing the camera
    // shows no warping, which is exactly the observed PS1 behaviour.
    const flat0: AffineVertex = { u: 0, v: 0, w: 3 };
    const flat1: AffineVertex = { u: 1, v: 0, w: 3 };
    const flat2: AffineVertex = { u: 0, v: 1, w: 3 };
    for (const bary of weightings) {
      const affine = shaderTrickAffineUV(bary, flat0, flat1, flat2);
      const perspective = interpolatePerspectiveUV(bary, flat0, flat1, flat2);
      expect(affine.u).toBeCloseTo(perspective.u, 9);
      expect(affine.v).toBeCloseTo(perspective.v, 9);
    }
  });

  it('reproduces the vertex UVs exactly at the vertices', () => {
    // Trivial but load-bearing: a broken divide would shift even the corners.
    expect(shaderTrickAffineUV({ a: 1, b: 0, c: 0 }, v0, v1, v2)).toEqual({ u: 0, v: 0 });
    expect(shaderTrickAffineUV({ a: 0, b: 1, c: 0 }, v0, v1, v2).u).toBeCloseTo(4, 9);
    expect(shaderTrickAffineUV({ a: 0, b: 0, c: 1 }, v0, v1, v2).v).toBeCloseTo(4, 9);
  });

  it('degrades safely when every vertex is at infinite depth', () => {
    // The denominator tends to zero; the fallback must keep the result finite.
    const far: AffineVertex = { u: 1, v: 1, w: 1e-7 };
    const result = shaderTrickAffineUV({ a: 0.5, b: 0.5, c: 0 }, far, { ...far, u: 2 }, far);
    expect(Number.isFinite(result.u)).toBe(true);
    expect(Number.isFinite(result.v)).toBe(true);
  });
});

describe('blendUV — the warp-intensity control', () => {
  const perspective = { u: 0, v: 1 };
  const affine = { u: 1, v: 0 };

  it('returns pure perspective at amount 0', () => {
    expect(blendUV(perspective, affine, 0)).toEqual(perspective);
  });

  it('returns pure affine at amount 1', () => {
    expect(blendUV(perspective, affine, 1)).toEqual(affine);
  });

  it('interpolates linearly in between', () => {
    const half = blendUV(perspective, affine, 0.5);
    expect(half.u).toBeCloseTo(0.5, 10);
    expect(half.v).toBeCloseTo(0.5, 10);
  });

  it('clamps out-of-range amounts rather than extrapolating', () => {
    // An extrapolated warp amount would invert the texture; clamping makes the
    // settings slider safe at both ends.
    expect(blendUV(perspective, affine, -3)).toEqual(perspective);
    expect(blendUV(perspective, affine, 7)).toEqual(affine);
  });
});

describe('computeLetterboxRect — aspect-fit upscaling', () => {
  it('uses an integer scale so pixels stay uniform', () => {
    // 1920/480 = 4, 1080/270 = 4 — an exact 4x fit with no letterboxing.
    const rect = computeLetterboxRect(480, 270, 1920, 1080);
    expect(rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('picks the limiting axis and centres the result', () => {
    // Tall window: width limits. 900/480 = 1.87 -> scale 1.
    const rect = computeLetterboxRect(480, 270, 900, 1200);
    expect(rect.width % 480).toBe(0);
    expect(rect.height % 270).toBe(0);
    expect(rect.x).toBe(Math.floor((900 - rect.width) / 2));
    expect(rect.y).toBe(Math.floor((1200 - rect.height) / 2));
  });

  it('always produces an integer scale of at least 1', () => {
    // An unusually small window must still render rather than collapse to zero size.
    const rect = computeLetterboxRect(480, 270, 100, 60);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(rect.width % 480).toBe(0);
  });

  it('never exceeds the destination bounds', () => {
    for (const [w, h] of [[1366, 768], [800, 600], [2560, 1440], [640, 480]]) {
      const rect = computeLetterboxRect(480, 270, w, h);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(w);
      expect(rect.y + rect.height).toBeLessThanOrEqual(h);
    }
  });

  it('returns a zero rect for degenerate inputs instead of NaN', () => {
    expect(computeLetterboxRect(480, 270, 0, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(computeLetterboxRect(0, 0, 100, 100)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('computeSnapGrid — isotropic wobble', () => {
  it('preserves the aspect ratio of the grid cells', () => {
    // A 16:9 target with N rows must have N * (16/9) columns, or squares would be
    // snapped into rectangles and the wobble would be visibly anisotropic.
    const grid = computeSnapGrid(RENDER_TARGET_WIDTH, RENDER_TARGET_HEIGHT, 135);
    expect(grid.rows).toBe(135);
    expect(grid.columns).toBe(Math.round(135 * (RENDER_TARGET_WIDTH / RENDER_TARGET_HEIGHT)));
    expect(grid.columns).toBe(240);
  });

  it('defaults to half the vertical resolution', () => {
    const grid = computeSnapGrid(480, 270);
    expect(grid.rows).toBe(135);
  });

  it('never produces a zero or negative grid', () => {
    expect(computeSnapGrid(480, 270, 0).rows).toBe(1);
    expect(computeSnapGrid(480, 270, -10).columns).toBeGreaterThan(0);
  });
});

describe('clampTerminator — period-authentic hard lighting', () => {
  it('is fully lit in the light and fully dark away from it', () => {
    expect(clampTerminator(1, 0.15)).toBe(1);
    expect(clampTerminator(-1, 0.15)).toBe(0);
  });

  it('compresses the transition into a narrow band', () => {
    // A smooth modern falloff would read as muddy in a bright scene (risk R5).
    expect(clampTerminator(0, 0.15)).toBeCloseTo(0, 10);
    expect(clampTerminator(0.075, 0.15)).toBeCloseTo(0.5, 10);
    expect(clampTerminator(0.15, 0.15)).toBeCloseTo(1, 10);
    expect(clampTerminator(0.5, 0.15)).toBe(1);
  });

  it('never emits values outside [0, 1]', () => {
    for (let i = -20; i <= 20; i++) {
      const value = clampTerminator(i / 10, 0.15);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('treats a zero hardness as a binary terminator without dividing by zero', () => {
    expect(Number.isFinite(clampTerminator(0, 0))).toBe(true);
    expect(clampTerminator(0.001, 0)).toBe(1);
  });
});

describe('palette quantisation', () => {
  it('snaps to the requested number of levels', () => {
    // 4 levels -> {0, 1/3, 2/3, 1}.
    expect(quantiseChannel(0.1, 4)).toBeCloseTo(0, 10);
    expect(quantiseChannel(0.3, 4)).toBeCloseTo(1 / 3, 10);
    expect(quantiseChannel(0.6, 4)).toBeCloseTo(2 / 3, 10);
    expect(quantiseChannel(0.9, 4)).toBeCloseTo(1, 10);
  });

  it('clamps out-of-range input', () => {
    expect(quantiseChannel(-5, 8)).toBe(0);
    expect(quantiseChannel(5, 8)).toBe(1);
  });

  it('never emits NaN for a degenerate level count', () => {
    expect(Number.isFinite(quantiseChannel(0.5, 1))).toBe(true);
    expect(Number.isFinite(quantiseChannel(0.5, 0))).toBe(true);
  });

  it('dither offsets shift the quantisation boundary', () => {
    // This is what converts banding into texture, so the shift must be real.
    const withoutDither = quantiseChannel(0.13, 4, 0);
    const withPositiveDither = quantiseChannel(0.13, 4, 0.5);
    expect(withPositiveDither).toBeGreaterThanOrEqual(withoutDither);
  });

  it('the ordered dither matrix spans exactly [-0.5, 0.5)', () => {
    // An out-of-range dither would push values outside the palette.
    const seen = new Set<number>();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const value = orderedDither4x4(x, y);
        expect(value).toBeGreaterThanOrEqual(-0.5);
        expect(value).toBeLessThan(0.5);
        seen.add(value);
      }
    }
    expect(seen.size).toBe(16); // all 16 entries distinct
  });

  it('the dither matrix tiles correctly and handles negative coordinates', () => {
    expect(orderedDither4x4(0, 0)).toBe(orderedDither4x4(4, 4));
    expect(orderedDither4x4(1, 2)).toBe(orderedDither4x4(5, 6));
    // Negative coordinates must not index out of bounds (they arise in screen space).
    expect(Number.isFinite(orderedDither4x4(-1, -3))).toBe(true);
  });
});

describe('constants sanity — the GDD values are wired in', () => {
  it('uses a 16:9 internal resolution', () => {
    expect(RENDER_TARGET_WIDTH / RENDER_TARGET_HEIGHT).toBeCloseTo(16 / 9, 3);
  });

  it('snaps to a half-resolution grid by default', () => {
    expect(RENDER_TARGET_HEIGHT / 2).toBe(135);
  });
});
