/**
 * Pure mathematics for the PS1 rendering artefacts.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS (risk W4, docs/ARCHITECTURE.md §5)
 * ────────────────────────────────────────────────────────────────────────────────
 * Vitest cannot compile GLSL, so a broken shader is invisible to CI and would only
 * fail in a human's browser. The mitigation is to implement every non-trivial piece
 * of shader *math* here, as small pure functions with exhaustive unit tests, and let
 * the GLSL be a thin transliteration. If the maths is correct here, the shader has
 * only transcription errors left to get wrong — and those are caught by the uniform
 * consistency lint test.
 *
 * Every function in this file must remain free of side effects and free of Three.js
 * imports so it can run in bare Node.
 */

/**
 * Snap a single normalised-device-coordinate value to a virtual pixel grid.
 *
 * NDC spans [-1, 1], so a grid of `gridCount` cells across the screen has a step of
 * `2 / gridCount`. Snapping to the *nearest* grid line (rather than flooring) keeps
 * the error symmetric around the true position, which halves the maximum wobble
 * compared to flooring while looking identical.
 *
 * @param ndc - Coordinate in normalised device space, expected in [-1, 1].
 * @param gridCount - Number of grid cells spanning the full [-1, 1] range.
 * @returns The nearest grid line in NDC.
 */
export function snapNdcToGrid(ndc: number, gridCount: number): number {
  if (gridCount <= 0) return ndc;
  const step = 2 / gridCount;
  return Math.round(ndc / step) * step;
}

/**
 * Perform PS1-style vertex snapping in clip space.
 *
 * The snap must happen in clip space (before the perspective divide) because that is
 * where the vertex shader has the projected coordinate; snapping in NDC would require
 * an extra division and a multiply to reconstruct the clip coordinate. Working on
 * `clip.xy / clip.w` and multiplying the result back by `clip.w` is exactly equivalent
 * to snapping in NDC while preserving the correct `w` for the rasteriser.
 *
 * @param clipX - Clip-space X (already multiplied by the projection matrix).
 * @param clipY - Clip-space Y.
 * @param clipW - Clip-space W. Values near zero represent vertices at or behind the
 *   camera and are returned unsnapped, since dividing by them is meaningless and would
 *   produce NaN that propagates into the rasteriser.
 * @param gridColumns - Virtual pixel columns across the viewport width.
 * @param gridRows - Virtual pixel rows across the viewport height.
 * @returns The snapped clip-space X and Y. `w` is never modified.
 */
export function snapClipSpaceXY(
  clipX: number,
  clipY: number,
  clipW: number,
  gridColumns: number,
  gridRows: number,
): { x: number; y: number } {
  // Guard against the singularity at w = 0 (vertex on the camera plane). Returning the
  // input unchanged is the safe degenerate answer: the vertex is about to be clipped
  // anyway, and emitting NaN here would corrupt the whole triangle.
  if (Math.abs(clipW) < 1e-6) {
    return { x: clipX, y: clipY };
  }

  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;

  return {
    x: snapNdcToGrid(ndcX, gridColumns) * clipW,
    y: snapNdcToGrid(ndcY, gridRows) * clipW,
  };
}

/** A vertex carrying a texture coordinate and its clip-space W. */
export interface AffineVertex {
  u: number;
  v: number;
  w: number;
}

/** Screen-space barycentric weights. Must sum to 1. */
export interface Barycentric {
  a: number;
  b: number;
  c: number;
}

/**
 * Interpolate UV affinely — i.e. linearly in *screen space*, ignoring perspective.
 *
 * This is what the PS1 hardware actually did, and it is the source of the era's
 * characteristic texture warping on large, obliquely-viewed polygons.
 *
 * @param bary - Screen-space barycentric weights.
 * @param v0 - First vertex.
 * @param v1 - Second vertex.
 * @param v2 - Third vertex.
 * @returns The affinely interpolated UV.
 */
export function interpolateAffineUV(
  bary: Barycentric,
  v0: AffineVertex,
  v1: AffineVertex,
  v2: AffineVertex,
): { u: number; v: number } {
  return {
    u: bary.a * v0.u + bary.b * v1.u + bary.c * v2.u,
    v: bary.a * v0.v + bary.b * v1.v + bary.c * v2.v,
  };
}

/**
 * Interpolate UV perspective-correctly, as modern hardware does by default.
 *
 * Included so tests can assert that the shader trick reproduces true affine
 * interpolation and that it genuinely *differs* from this — a test that only checked
 * the trick against itself would pass even if the trick were a no-op.
 *
 * @param bary - Screen-space barycentric weights.
 * @param v0 - First vertex.
 * @param v1 - Second vertex.
 * @param v2 - Third vertex.
 * @returns The perspective-correct UV.
 */
export function interpolatePerspectiveUV(
  bary: Barycentric,
  v0: AffineVertex,
  v1: AffineVertex,
  v2: AffineVertex,
): { u: number; v: number } {
  const denom = bary.a / v0.w + bary.b / v1.w + bary.c / v2.w;
  if (Math.abs(denom) < 1e-12) {
    // Degenerate (all vertices at infinite depth); fall back to affine.
    return interpolateAffineUV(bary, v0, v1, v2);
  }
  return {
    u: (bary.a * (v0.u / v0.w) + bary.b * (v1.u / v1.w) + bary.c * (v2.u / v2.w)) / denom,
    v: (bary.a * (v0.v / v0.w) + bary.b * (v1.v / v1.w) + bary.c * (v2.v / v2.w)) / denom,
  };
}

/**
 * Reproduce the shader's affine-UV trick in TypeScript so it can be unit-tested.
 *
 * THE TRICK: the GPU always interpolates varyings perspective-correctly. To defeat
 * that, the vertex shader emits two varyings per vertex — `A = uv * w` and `W = w` —
 * and the fragment shader divides one by the other.
 *
 * DERIVATION. Perspective-correct interpolation of a varying V is
 *     V_pc = (Σ λᵢ Vᵢ / wᵢ) / (Σ λᵢ / wᵢ)
 * with screen-space barycentric weights λ.
 *   • With Vᵢ = uvᵢ·wᵢ, the numerator becomes Σ λᵢ uvᵢ (the wᵢ cancel), leaving
 *         A_pc = (Σ λᵢ uvᵢ) / (Σ λᵢ / wᵢ)
 *   • With Vᵢ = wᵢ, the numerator becomes Σ λᵢ = 1, leaving
 *         W_pc = 1 / (Σ λᵢ / wᵢ)
 *   • Therefore A_pc / W_pc = Σ λᵢ uvᵢ — exactly screen-space-linear (affine) UV.
 *
 * This is why PS1-style warping costs two lines of GLSL and a single divide per
 * fragment, rather than a software rasteriser. See GDD §9.2.
 *
 * @param bary - Screen-space barycentric weights.
 * @param v0 - First vertex.
 * @param v1 - Second vertex.
 * @param v2 - Third vertex.
 * @returns The UV produced by the two-varying shader trick, which must equal
 *   {@link interpolateAffineUV}.
 */
export function shaderTrickAffineUV(
  bary: Barycentric,
  v0: AffineVertex,
  v1: AffineVertex,
  v2: AffineVertex,
): { u: number; v: number } {
  // The "A" varying: uv scaled by w, then interpolated perspective-correctly.
  const aNumU = bary.a * ((v0.u * v0.w) / v0.w) + bary.b * ((v1.u * v1.w) / v1.w) + bary.c * ((v2.u * v2.w) / v2.w);
  const aNumV = bary.a * ((v0.v * v0.w) / v0.w) + bary.b * ((v1.v * v1.w) / v1.w) + bary.c * ((v2.v * v2.w) / v2.w);
  const denom = bary.a / v0.w + bary.b / v1.w + bary.c / v2.w;

  const aW = aNumU / denom;
  const aVw = aNumV / denom;

  // The "W" varying: w itself, interpolated perspective-correctly.
  const wNum = bary.a * (v0.w / v0.w) + bary.b * (v1.w / v1.w) + bary.c * (v2.w / v2.w);
  const wInterpolated = wNum / denom;

  if (Math.abs(wInterpolated) < 1e-12) {
    return interpolateAffineUV(bary, v0, v1, v2);
  }

  return { u: aW / wInterpolated, v: aVw / wInterpolated };
}

/**
 * Blend between perspective-correct and affine UVs.
 *
 * Unrestricted affine mapping makes large surfaces look *broken* rather than *retro*,
 * so the game exposes this as a single tunable scalar (`AFFINE_WARP_AMOUNT`). At
 * `amount = 0` the result is modern and correct; at `amount = 1` it is authentically
 * warped. The default sits below 1 deliberately (risk R5).
 *
 * @param perspective - Perspective-correct UV.
 * @param affine - Affine UV.
 * @param amount - Blend factor, clamped to [0, 1].
 * @returns The blended UV.
 */
export function blendUV(
  perspective: { u: number; v: number },
  affine: { u: number; v: number },
  amount: number,
): { u: number; v: number } {
  const t = Math.min(1, Math.max(0, amount));
  return {
    u: perspective.u + (affine.u - perspective.u) * t,
    v: perspective.v + (affine.v - perspective.v) * t,
  };
}

/** An integer pixel rectangle. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compute the largest integer-scaled, centred, letterboxed rectangle that fits the
 * source resolution inside the destination while preserving aspect ratio exactly.
 *
 * Integer scaling is a requirement, not a nicety: a fractional scale makes the
 * nearest-neighbour upscale produce rows and columns of inconsistent thickness, which
 * destroys the crisp-pixel look that is the entire point of the low-res target.
 *
 * @param sourceWidth - Internal render target width in pixels.
 * @param sourceHeight - Internal render target height in pixels.
 * @param destWidth - Canvas width in CSS pixels.
 * @param destHeight - Canvas height in CSS pixels.
 * @returns The destination rectangle, at an integer scale of at least 1.
 */
export function computeLetterboxRect(
  sourceWidth: number,
  sourceHeight: number,
  destWidth: number,
  destHeight: number,
): PixelRect {
  if (sourceWidth <= 0 || sourceHeight <= 0 || destWidth <= 0 || destHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  // The largest integer scale that still fits in both axes. Clamped to >= 1 so an
  // unusually small window still renders something rather than a zero-sized quad.
  const scale = Math.max(
    1,
    Math.floor(Math.min(destWidth / sourceWidth, destHeight / sourceHeight)),
  );

  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    x: Math.floor((destWidth - width) / 2),
    y: Math.floor((destHeight - height) / 2),
    width,
    height,
  };
}

/**
 * Derive the vertex snap grid dimensions from a target resolution.
 *
 * Expressing the grid in *virtual pixels* rather than world units is what makes the
 * wobble isotropic and resolution-correct: a grid defined in world units would
 * wobble inconsistently with distance from the camera.
 *
 * @param targetWidth - Internal render target width in pixels.
 * @param targetHeight - Internal render target height in pixels.
 * @param rows - Grid rows to quantise to, defaulting to half the vertical resolution.
 * @returns Grid column and row counts for {@link snapClipSpaceXY}.
 */
export function computeSnapGrid(
  targetWidth: number,
  targetHeight: number,
  rows: number = targetHeight / 2,
): { columns: number; rows: number } {
  // Preserve the pixel aspect: if the grid is N rows tall it must be
  // N * (width / height) columns wide, or squares would be snapped into rectangles.
  const aspect = targetHeight > 0 ? targetWidth / targetHeight : 1;
  return { columns: Math.max(1, Math.round(rows * aspect)), rows: Math.max(1, rows) };
}

/**
 * Clamp a diffuse lighting term to produce a hard, period-authentic terminator.
 *
 * PS1-era lighting had no soft penumbra; the diffuse term saturated abruptly. A smooth
 * modern falloff reads as "muddy" in a bright scene (risk R5), so the ramp is
 * compressed into a narrow band around zero and clamped to [0, 1].
 *
 * @param nDotL - Normalised dot product of surface normal and light direction.
 * @param hardness - Width of the transition band. 0 produces a binary terminator.
 * @returns A value in [0, 1] suitable for multiplying into the diffuse colour.
 */
export function clampTerminator(nDotL: number, hardness: number): number {
  const band = Math.max(1e-4, hardness);
  const t = nDotL / band;
  return Math.min(1, Math.max(0, t));
}

/**
 * Quantise a single colour channel to a limited palette with optional 4x4 ordered
 * dithering.
 *
 * Dithering before quantisation is what turns banding into an authentic texture and
 * is the difference between "limited palette" and "broken gradient".
 *
 * @param value - Channel value in [0, 1].
 * @param levels - Number of quantisation levels. 32 gives the era's characteristic
 *   subtle stepping without visibly destroying gradients.
 * @param dither - Dither offset in [-0.5, 0.5]; pass 0 to disable.
 * @returns The quantised channel value in [0, 1].
 */
export function quantiseChannel(value: number, levels: number, dither: number = 0): number {
  const safeLevels = Math.max(2, Math.floor(levels));
  const stepped = Math.min(1, Math.max(0, value)) + dither / safeLevels;
  return Math.round(Math.min(1, Math.max(0, stepped)) * (safeLevels - 1)) / (safeLevels - 1);
}

/**
 * Compute the standard 4x4 ordered dither matrix entry for a pixel.
 *
 * @param x - Integer pixel X.
 * @param y - Integer pixel Y.
 * @returns Dither offset in [-0.5, 0.5).
 */
export function orderedDither4x4(x: number, y: number): number {
  // The classic Bayer 4x4 matrix, normalised to [-0.5, 0.5).
  const matrix = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const index = (Math.abs(y) % 4) * 4 + (Math.abs(x) % 4);
  return matrix[index] / 16 - 0.5;
}
