/**
 * PS1 material factory.
 *
 * Owns the single shader pair used by every world object, plus the *shared* uniform
 * objects that let global lighting and fog be tuned in one place.
 *
 * WHY SHARED UNIFORM OBJECTS
 * --------------------------
 * three.js materials each hold their own `uniforms` record. If every material
 * constructed its own `THREE.Color` for the sun, then retuning the sun at runtime
 * would mean walking every material — and it would be trivially easy to miss one,
 * producing a scene where some objects are lit by yesterday's sun.
 *
 * Instead, all materials receive references to the *same* uniform value objects.
 * Writing `sharedUniforms.uSunColor.value.set(...)` updates every material that
 * references it, because they all point at the same object. This is the pattern that
 * makes the dev overlay's live shader tuning possible.
 */

import * as THREE from 'three';
import { PS1_FRAGMENT_SHADER, PS1_VERTEX_SHADER } from './shaders/ps1World';
import {
  AFFINE_WARP_AMOUNT,
  AMBIENT_COLOR,
  AMBIENT_INTENSITY,
  CAMERA_FOV_DEG,
  FOG_COLOR,
  FOG_FAR_M,
  FOG_NEAR_M,
  LIGHT_TERMINATOR_HARDNESS,
  RIM_COLOR,
  RIM_INTENSITY,
  RIM_POWER,
  RENDER_TARGET_HEIGHT,
  SUN_COLOR,
  SUN_INTENSITY,
  VERTEX_SNAP_GRID_ROWS,
} from '../core/constants';
import { computeSnapGrid } from '../core/math/ps1';

/**
 * Globally shared shader uniforms.
 *
 * Exported so the game loop, the dev overlay and the sky can all write to the same
 * values. Treat this as the single source of truth for the look of the world.
 */
export const sharedUniforms = {
  /** Virtual pixel grid the vertex snap quantises to, in (columns, rows). */
  uSnapGrid: { value: new THREE.Vector2(240, VERTEX_SNAP_GRID_ROWS) },

  /** Direction *towards* the sun, in world space. Normalised in the shader. */
  uSunDirection: { value: new THREE.Vector3(0.55, 0.72, 0.42).normalize() },

  /** Warm white sun, high intensity: this is a bright game (GDD §1). */
  uSunColor: { value: new THREE.Color(SUN_COLOR) },
  uSunIntensity: { value: SUN_INTENSITY },

  /** Sky-tinted ambient so surfaces in shadow still read as outdoor daylight. */
  uAmbientColor: { value: new THREE.Color(AMBIENT_COLOR) },
  uAmbientIntensity: { value: AMBIENT_INTENSITY },

  /** Silhouette rim light, without which flat-shaded forms go unreadable. */
  uRimColor: { value: new THREE.Color(RIM_COLOR) },
  uRimIntensity: { value: RIM_INTENSITY },
  uRimPower: { value: RIM_POWER },

  /** Width of the diffuse transition band. Narrow = crisp, period-authentic. */
  uTerminatorHardness: { value: LIGHT_TERMINATOR_HARDNESS },

  /** Affine warp intensity. See blendUV() in src/core/math/ps1.ts. */
  uWarpAmount: { value: AFFINE_WARP_AMOUNT },

  /** Fog matched to the sky so distance reads as haze, never as gloom. */
  uFogColor: { value: new THREE.Color(FOG_COLOR) },
  uFogNear: { value: FOG_NEAR_M },
  uFogFar: { value: FOG_FAR_M },
};

/** Options accepted by {@link createPS1Material}. */
export interface PS1MaterialOptions {
  /** Diffuse texture. Required — untextured surfaces break the aesthetic. */
  map: THREE.Texture;
  /** Multiplied with the vertex tint. Use for per-object colour variation. */
  tint?: THREE.ColorRepresentation;
  /**
   * Alpha cut-out threshold. Use > 0 for foliage cards so leaves are cut out rather
   * than blended. The PS1 had no worthwhile alpha blending, and hard cut-outs are the
   * period-correct look.
   */
  alphaTest?: number;
  /** Enables `color` attribute tinting from the geometry. Default true. */
  vertexColors?: boolean;
  /** Render both faces. Collision geometry never uses this (see R14). */
  doubleSided?: boolean;
  /** Render order hint, used to keep foliage predictable. */
  renderOrder?: number;
}

/**
 * Create a material using the shared PS1 shader.
 *
 * @param options - Material configuration.
 * @returns A configured `ShaderMaterial` sharing the global lighting uniforms.
 */
export function createPS1Material(options: PS1MaterialOptions): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader: PS1_VERTEX_SHADER,
    fragmentShader: PS1_FRAGMENT_SHADER,
    vertexColors: options.vertexColors ?? true,
    side: options.doubleSided ? THREE.DoubleSide : THREE.FrontSide,

    // The low-resolution target makes the standard depth function insufficient for
    // coplanar surfaces — vertex snapping can push two coincident polygons onto
    // opposite sides of the depth comparison, producing z-fighting. A small polygon
    // offset biases fragments towards the camera and removes it. This addresses the
    // "vertex snapping causing z-fighting" edge case from the milestone brief.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,

    uniforms: {
      // Per-material uniforms.
      uMap: { value: options.map },
      uTint: { value: new THREE.Color(options.tint ?? 0xffffff) },
      uAlphaTest: { value: options.alphaTest ?? 0 },

      // Shared global uniforms. These are REFERENCES, not copies: writing through
      // sharedUniforms updates every material at once.
      uSnapGrid: sharedUniforms.uSnapGrid,
      uSunDirection: sharedUniforms.uSunDirection,
      uSunColor: sharedUniforms.uSunColor,
      uSunIntensity: sharedUniforms.uSunIntensity,
      uAmbientColor: sharedUniforms.uAmbientColor,
      uAmbientIntensity: sharedUniforms.uAmbientIntensity,
      uRimColor: sharedUniforms.uRimColor,
      uRimIntensity: sharedUniforms.uRimIntensity,
      uRimPower: sharedUniforms.uRimPower,
      uTerminatorHardness: sharedUniforms.uTerminatorHardness,
      uWarpAmount: sharedUniforms.uWarpAmount,
      uFogColor: sharedUniforms.uFogColor,
      uFogNear: sharedUniforms.uFogNear,
      uFogFar: sharedUniforms.uFogFar,
    },
  });

  material.name = 'PS1Material';
  return material;
}

/**
 * The set of uniform names the PS1 shader pair expects to receive from JavaScript.
 *
 * Declared as an explicit list so the uniform-consistency test can assert that the
 * GLSL and the JavaScript agree in *both* directions. A uniform declared only in GLSL
 * silently reads as zero (often invisible until a distant scene renders black), and
 * one declared only in JavaScript is dead weight.
 *
 * Keep in sync with {@link createPS1Material} and the shader sources.
 */
export const PS1_UNIFORM_NAMES = [
  // Per-material
  'uMap',
  'uTint',
  'uAlphaTest',
  // Shared lighting / look
  'uSnapGrid',
  'uSunDirection',
  'uSunColor',
  'uSunIntensity',
  'uAmbientColor',
  'uAmbientIntensity',
  'uRimColor',
  'uRimIntensity',
  'uRimPower',
  'uTerminatorHardness',
  'uWarpAmount',
  'uFogColor',
  'uFogNear',
  'uFogFar',
] as const;

/**
 * Apply a change to the vertex snap grid.
 *
 * Called by the options menu and the dev overlay. Centralised here so the aspect
 * correction (see `computeSnapGrid`) can never be bypassed by a caller setting the
 * uniform directly.
 *
 * @param rows - Grid rows to quantise to.
 * @param targetWidth - Render target width in pixels.
 * @param targetHeight - Render target height in pixels.
 */
export function setSnapGridRows(
  rows: number,
  targetWidth: number = 480,
  targetHeight: number = RENDER_TARGET_HEIGHT,
): void {
  const grid = computeSnapGrid(targetWidth, targetHeight, rows);
  sharedUniforms.uSnapGrid.value.set(grid.columns, grid.rows);
}

/**
 * Set the affine warp intensity.
 *
 * @param amount - Blend factor, clamped to [0, 1] by the shader's `mix` semantics and
 *   additionally pre-clamped here so the UI cannot store a nonsensical value.
 */
export function setWarpAmount(amount: number): void {
  sharedUniforms.uWarpAmount.value = Math.min(1, Math.max(0, amount));
}

/**
 * Compute the vertical field of view in degrees for a given render target aspect.
 *
 * three.js `PerspectiveCamera` takes a *vertical* FOV, while the GDD specifies FOV in
 * horizontal terms (60°). At 16:9 these differ by a factor of ~1.9, and getting this
 * wrong silently changes every composition in the game — so the conversion lives in
 * one tested place rather than being inlined at each call site.
 *
 * @param horizontalFovDeg - Horizontal field of view in degrees.
 * @param aspect - Viewport aspect ratio (width / height).
 * @returns The equivalent vertical field of view in degrees.
 */
export function horizontalToVerticalFov(horizontalFovDeg: number, aspect: number): number {
  const horizontalRad = (horizontalFovDeg * Math.PI) / 180;
  const verticalRad = 2 * Math.atan(Math.tan(horizontalRad / 2) / Math.max(aspect, 1e-6));
  return (verticalRad * 180) / Math.PI;
}

/**
 * Build the camera used for the low-resolution world pass.
 *
 * @param aspect - Render target aspect ratio.
 * @returns A perspective camera configured with the GDD's default field of view.
 */
export function createWorldCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    horizontalToVerticalFov(CAMERA_FOV_DEG, aspect),
    aspect,
    0.1,
    FOG_FAR_M + 40,
  );
  camera.name = 'WorldCamera';
  return camera;
}
