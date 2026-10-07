/**
 * Procedural texture generation.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE REPLACES AN ASSET PIPELINE (risk R13, docs/ARCHITECTURE.md §W5)
 * ────────────────────────────────────────────────────────────────────────────────
 * The game ships **no binary image files at all**. Every texture is synthesised at
 * start-up into a `DataTexture` from a seeded PRNG.
 *
 * This deletes an entire risk class rather than managing it:
 *   • Nothing to download, so load time is code-only.
 *   • Nothing to decode, so there is no main-thread decode stall.
 *   • Nothing to version, cache-bust, or 404.
 *   • Deterministic output, so a texture regression is reproducible and could be
 *     golden-tested if it ever became worthwhile.
 *   • 64x64 is genuinely period-correct, not a compromise: PS1 texture pages were
 *     typically 256x256 holding many small textures, and per-texture resolutions of
 *     32-64 px were normal.
 *
 * The cost is CPU time at boot. A 64x64 RGBA texture is 16 KB, and generating a dozen
 * of them takes single-digit milliseconds, so this is not a meaningful trade.
 */

import * as THREE from 'three';
import { SeededRandom, ValueNoise2D } from '../core/math/rng';
import { TEXTURE_SIZE, WORLD_SEED } from '../core/constants';

/** An RGB colour with components in [0, 255], to keep generators readable. */
type Rgb255 = readonly [number, number, number];

/**
 * Build a `DataTexture` from a per-pixel generator function.
 *
 * @param size - Texture edge length in pixels (square).
 * @param generator - Called for each pixel with normalised coordinates and the
 *   accumulated noise value, returning an RGB triple in [0, 255].
 * @param options.repeat - Texture wrap repeat factor applied to UVs.
 * @param options.magFilter - Override the magnification filter (nearest is default).
 * @returns The uploaded texture, ready to assign to a material.
 */
function buildTexture(
  size: number,
  generator: (x: number, y: number, rng: SeededRandom, noise: ValueNoise2D, index: number) => Rgb255,
  options: { repeat?: number; magFilter?: THREE.MagnificationTextureFilter } = {},
): THREE.DataTexture {
  const rng = new SeededRandom(WORLD_SEED);
  const noise = new ValueNoise2D(rng, 256);

  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      // Normalised coordinates with a half-texel offset, so the first and last
      // texels are sampled exactly once at their centres and the pattern tiles.
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      const [r, g, b] = generator(u, v, rng, noise, index);

      data[index + 0] = clampByte(r);
      data[index + 1] = clampByte(g);
      data[index + 2] = clampByte(b);
      data[index + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = 'ProceduralTexture';
  texture.magFilter = options.magFilter ?? THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  if (options.repeat !== undefined) {
    texture.repeat.set(options.repeat, options.repeat);
  }
  texture.needsUpdate = true;
  return texture;
}

/**
 * Clamp a float to a valid byte value.
 *
 * @param value - Any number.
 * @returns An integer in [0, 255].
 */
function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Linearly interpolate between two RGB triples.
 *
 * @param a - Colour at t = 0.
 * @param b - Colour at t = 1.
 * @param t - Blend factor, clamped to [0, 1].
 * @returns The interpolated colour.
 */
function mixRgb(a: Rgb255, b: Rgb255, t: number): Rgb255 {
  const clamped = Math.min(1, Math.max(0, t));
  return [
    a[0] + (b[0] - a[0]) * clamped,
    a[1] + (b[1] - a[1]) * clamped,
    a[2] + (b[2] - a[2]) * clamped,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// PALETTES — bright, saturated, adventure (GDD §9.3). Never muddy, never desaturated.
// ─────────────────────────────────────────────────────────────────────────────

const PALETTE = {
  /** Lush jungle greens. Three distinct hues so foliage does not read as one flat tone. */
  grassDark: [46, 92, 40] as Rgb255,
  grassMid: [86, 142, 58] as Rgb255,
  grassLight: [134, 176, 72] as Rgb255,
  grassHighlight: [176, 200, 96] as Rgb255,

  /** Warm ochre earth. */
  earthDark: [104, 74, 42] as Rgb255,
  earthMid: [150, 112, 62] as Rgb255,
  earthLight: [186, 148, 92] as Rgb255,

  /** Warm sandstone temple stone. */
  stoneDark: [122, 96, 70] as Rgb255,
  stoneMid: [176, 146, 108] as Rgb255,
  stoneLight: [214, 186, 142] as Rgb255,
  stoneShadow: [90, 74, 58] as Rgb255,

  /** Bark. */
  barkDark: [72, 50, 32] as Rgb255,
  barkMid: [110, 78, 46] as Rgb255,
  barkLight: [146, 108, 66] as Rgb255,

  /** Foliage canopy. */
  leafDark: [38, 88, 46] as Rgb255,
  leafMid: [70, 130, 62] as Rgb255,
  leafLight: [122, 172, 74] as Rgb255,

  /** Sky. */
  skyHorizon: [176, 224, 244] as Rgb255,
  skyZenith: [88, 158, 226] as Rgb255,
  cloud: [252, 252, 248] as Rgb255,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// TEXTURE GENERATORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grass ground texture with tonal variation and sparse detail speckles.
 *
 * The variation is deliberately *macro-scale* (low frequency) so that large ground
 * planes read as several patches of green rather than as uniform lawn, which is what
 * makes a big flat surface look hand-painted at low resolution.
 *
 * @returns The grass texture.
 */
export function createGrassTexture(): THREE.DataTexture {
  return buildTexture(TEXTURE_SIZE, (u, v, rng, noise) => {
    const macro = noise.fbm(u, v, 3, 2.5);
    const micro = noise.fbm(u, v, 2, 12);

    let color = mixRgb(PALETTE.grassDark, PALETTE.grassMid, macro);
    color = mixRgb(color, PALETTE.grassLight, micro * 0.55);

    // Scattered brighter blades. Sparse by design: over-populating turns the ground
    // into visual noise that fights the character silhouette.
    if (rng.chance(0.05)) {
      color = mixRgb(color, PALETTE.grassHighlight, 0.7);
    }

    return color;
  });
}

/**
 * Temple stone: warm sandstone blocks with mortar lines and weathering.
 *
 * Blocks are generated on a fixed grid with a running-bond offset, because an
 * irregular layout becomes illegible once affine warping is applied.
 *
 * @returns The stone texture.
 */
export function createStoneTexture(): THREE.DataTexture {
  const blockHeight = 16; // 4 rows across a 64 px texture
  const blockWidth = 32; // 2 columns, offset on alternate rows

  return buildTexture(TEXTURE_SIZE, (u, v, rng, noise) => {
    const px = u * TEXTURE_SIZE;
    const py = v * TEXTURE_SIZE;

    const row = Math.floor(py / blockHeight);
    // Running bond: shift every other row by half a block so the joints do not line
    // up into continuous vertical seams.
    const rowOffset = (row % 2) * (blockWidth / 2);
    const inBlockX = (px + rowOffset) % blockWidth;
    const inBlockY = py % blockHeight;

    // A 2 px mortar gap reads as a joint without consuming so much of the tile that
    // the stone itself is hard to see at 480x270.
    const edgeDistance = Math.min(
      inBlockX,
      blockWidth - 1 - inBlockX,
      inBlockY,
      blockHeight - 1 - inBlockY,
    );
    const isMortar = edgeDistance < 2;

    // Per-block tonal variation, keyed on the block's grid identity so all pixels of
    // one block share a tint. This is what stops the wall reading as a flat plane.
    const blockId = ((row * 31 + Math.floor((px + rowOffset) / blockWidth)) % 7) / 7;
    const wear = noise.fbm(u, v, 3, 6);

    if (isMortar) {
      return mixRgb(PALETTE.stoneShadow, PALETTE.stoneDark, wear * 0.5);
    }

    const base = mixRgb(PALETTE.stoneDark, PALETTE.stoneLight, 0.35 + blockId * 0.4);
    let color = mixRgb(base, PALETTE.stoneMid, wear * 0.6);

    // Occasional warmer patches suggest sun-bleached and rain-streaked stone.
    if (rng.chance(0.03)) {
      color = mixRgb(color, PALETTE.earthLight, 0.35);
    }

    return color;
  });
}

/**
 * Bark: vertical fibrous striations.
 *
 * @returns The bark texture.
 */
export function createBarkTexture(): THREE.DataTexture {
  return buildTexture(TEXTURE_SIZE, (u, v, rng, noise) => {
    // Stretch the noise vertically so features run along the trunk, not across it.
    const fibres = noise.fbm(u * 4, v * 0.5, 3, 4);
    const ridge = noise.fbm(u * 8, v * 1.5, 2, 6);

    let color = mixRgb(PALETTE.barkDark, PALETTE.barkMid, fibres);
    color = mixRgb(color, PALETTE.barkLight, ridge * 0.45);

    if (rng.chance(0.04)) {
      color = mixRgb(color, PALETTE.barkDark, 0.6);
    }

    return color;
  });
}

/**
 * Foliage canopy card: clustered leaf blobs on a transparent background.
 *
 * The alpha channel is generated as part of the same pass and is why this generator
 * cannot use {@link buildTexture} (which always writes opaque alpha). Foliage uses a
 * hard alpha test, so the alpha values are pushed to the extremes rather than being a
 * soft gradient — a soft edge would show a hard cut anyway under alpha testing, and
 * would look like a halo.
 *
 * @returns The foliage texture with meaningful alpha.
 */
export function createFoliageTexture(): THREE.DataTexture {
  const size = TEXTURE_SIZE;
  const rng = new SeededRandom(WORLD_SEED ^ 0x1eaf);
  const noise = new ValueNoise2D(rng, 256);
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      // Leaf clusters: high-frequency noise thresholded into blobs. The threshold
      // controls leaf density; the frequency controls leaf size.
      const blobs = noise.fbm(u, v, 4, 7);
      const detail = noise.fbm(u, v, 2, 20);

      // Fade the card's edges to transparent so overlapping foliage planes do not
      // reveal their rectangular boundaries — the single most common giveaway of
      // card-based foliage.
      const edgeFade = Math.min(
        Math.min(u, 1 - u) * 6,
        Math.min(v, 1 - v) * 6,
      );

      const leafMask = Math.max(0, blobs * 1.35 - 0.42) * edgeFade;

      if (leafMask < 0.08) {
        data[index + 0] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
        continue;
      }

      // Darker leaves lower on the card, lighter on top: fakes light coming from above
      // without needing a second lighting term.
      const heightShade = 0.35 + v * 0.65;
      let color = mixRgb(PALETTE.leafDark, PALETTE.leafMid, heightShade);
      color = mixRgb(color, PALETTE.leafLight, detail * 0.5 * heightShade);

      data[index + 0] = clampByte(color[0]);
      data[index + 1] = clampByte(color[1]);
      data[index + 2] = clampByte(color[2]);
      // Hard binary alpha: foliage is alpha-tested, never blended.
      data[index + 3] = leafMask > 0.35 ? 255 : 0;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = 'FoliageTexture';
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Dirt path texture: compacted earth with pebbles.
 *
 * @returns The dirt texture.
 */
export function createDirtTexture(): THREE.DataTexture {
  return buildTexture(TEXTURE_SIZE, (u, v, rng, noise) => {
    const base = noise.fbm(u, v, 3, 3);
    const grit = noise.fbm(u, v, 2, 16);

    let color = mixRgb(PALETTE.earthDark, PALETTE.earthMid, base);
    color = mixRgb(color, PALETTE.earthLight, grit * 0.4);

    if (rng.chance(0.02)) {
      color = mixRgb(color, PALETTE.stoneLight, 0.6); // a pebble
    }

    return color;
  });
}

/**
 * Water surface: layered sinusoidal ripples in tropical cyan.
 *
 * Water is animated by scrolling two UV layers against each other (see the level
 * builder), so the texture only needs to be seamless and directional-free.
 *
 * @returns The water texture.
 */
export function createWaterTexture(): THREE.DataTexture {
  return buildTexture(TEXTURE_SIZE, (u, v) => {
    // Two crossing sine waves produce a caustic-like interference pattern that tiles
    // exactly because both frequencies are integers over the unit square.
    const wave1 = Math.sin(u * Math.PI * 4) * Math.cos(v * Math.PI * 4);
    const wave2 = Math.sin(u * Math.PI * 8 + 1.7) * 0.5 + 0.5;
    const ripple = wave1 * 0.5 + wave2 * 0.5;

    const deep = [26, 108, 150] as Rgb255;
    const shallow = [96, 196, 214] as Rgb255;
    const foam = [186, 236, 240] as Rgb255;

    let color = mixRgb(deep, shallow, ripple * 0.5 + 0.5);
    if (ripple > 0.55) {
      color = mixRgb(color, foam, (ripple - 0.55) * 1.6);
    }
    return color;
  });
}

/**
 * Build the 4x4 Bayer dither table as a texture.
 *
 * Values are stored as `index / 16`, matching `orderedDither4x4()` in
 * src/core/math/ps1.ts, which the shader then shifts by -0.5. Keeping the table in a
 * texture (rather than a GLSL const array) means GLSL ES 1.00 compatibility and an
 * exact match with the tested TypeScript implementation.
 *
 * @returns A 4x4 single-channel-as-RGBA texture.
 */
export function buildBayerTexture(): THREE.DataTexture {
  // The classic Bayer 4x4 matrix, ordered left-to-right, top-to-bottom.
  const matrix = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const size = 4;
  const data = new Uint8Array(size * size * 4);

  for (let i = 0; i < matrix.length; i++) {
    const value = Math.round((matrix[i] / 16) * 255);
    data[i * 4 + 0] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = 'BayerDitherTable';
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  // Clamp rather than repeat: the shader indexes within [0, 1) and wrapping would
  // silently sample the opposite edge for a coordinate that rounds to 1.0.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  // Data, not colour: must not be sRGB-decoded or the dither magnitude shifts.
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Every procedural texture the world needs, generated once and shared.
 *
 * Centralised so that all ground tiles reference the same GPU texture (one upload, one
 * binding) rather than each mesh generating its own copy — a subtle way to waste
 * tens of megabytes and dozens of texture binds.
 */
export interface TextureLibrary {
  grass: THREE.DataTexture;
  stone: THREE.DataTexture;
  bark: THREE.DataTexture;
  foliage: THREE.DataTexture;
  dirt: THREE.DataTexture;
  water: THREE.DataTexture;
}

/**
 * Generate the full texture library.
 *
 * @returns The library. Call {@link disposeTextureLibrary} when tearing down.
 */
export function createTextureLibrary(): TextureLibrary {
  return {
    grass: createGrassTexture(),
    stone: createStoneTexture(),
    bark: createBarkTexture(),
    foliage: createFoliageTexture(),
    dirt: createDirtTexture(),
    water: createWaterTexture(),
  };
}

/**
 * Dispose every texture in a library.
 *
 * @param library - The library to release.
 */
export function disposeTextureLibrary(library: TextureLibrary): void {
  for (const texture of Object.values(library)) {
    texture.dispose();
  }
}
