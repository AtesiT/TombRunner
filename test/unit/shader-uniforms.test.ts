/**
 * Shader / JavaScript uniform consistency.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE FAILURE MODE THIS CATCHES (risk W4, docs/ARCHITECTURE.md §5)
 * ────────────────────────────────────────────────────────────────────────────────
 * Vitest cannot compile GLSL, so a shader bug is normally invisible until a human opens
 * a browser. The uniform *mismatch* class is the most common and the nastiest of those
 * bugs, and it fails in two silent ways:
 *
 *  1. A uniform declared in GLSL but missing from the material's `uniforms` object
 *     reads as its zero value — often presenting as a black scene, an invisible effect,
 *     or an unexplained colour shift, with no error anywhere.
 *  2. A uniform declared in JavaScript but absent from the shader is dead weight that
 *     quietly does nothing while appearing to be wired up.
 *
 * Both are statically detectable by comparing the shader source to the uniform record.
 * That is what this test does, and it is cheap enough to run on every change.
 *
 * What this does NOT prove: that the shader compiles, or that the maths is right. The
 * maths is covered by `ps1-math.test.ts`; compilation remains an honest gap documented
 * in the manual visual checklist.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  PS1_FRAGMENT_SHADER,
  PS1_VERTEX_SHADER,
  FULLSCREEN_VERTEX_SHADER,
  PALETTE_FRAGMENT_SHADER,
  BLIT_FRAGMENT_SHADER,
  PS1_SKY_VERTEX_SHADER,
  PS1_SKY_FRAGMENT_SHADER,
} from '../../src/render/shaders/ps1World';
import {
  createPS1Material,
  PS1_UNIFORM_NAMES,
  sharedUniforms,
  horizontalToVerticalFov,
} from '../../src/render/PS1Material';

/**
 * Extract every uniform name declared in a GLSL source string.
 *
 * Matches `uniform <type> <name>;` including array declarations such as
 * `uniform vec3 uColours[4];`, which must be captured without the bracket suffix.
 *
 * @param source - The GLSL source to scan.
 * @returns A set of declared uniform names.
 */
function extractGlslUniforms(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /\buniform\s+\w+\s+(\w+)\s*(\[[^\]]*\])?\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Collect the uniforms declared across a set of GLSL stages.
 *
 * A varying is declared in both the vertex and fragment stage, so uniforms are unioned
 * here for the same reason: both stages read from one shared uniform record.
 *
 * @param sources - The GLSL sources to scan.
 * @returns A set of declared uniform names.
 */
function extractAllGlslUniforms(sources: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const source of sources) {
    for (const name of extractGlslUniforms(source)) {
      names.add(name);
    }
  }
  return names;
}

/** Build a material with the standard shader pair, for inspection. */
function buildMaterialForInspection(): THREE.ShaderMaterial {
  const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  return createPS1Material({ map: texture });
}


/**
 * Strip GLSL comments so the compatibility lint inspects only executable code.
 *
 * Without this, a lint rule that forbids a construct also forbids *explaining* why it is
 * forbidden — which punishes exactly the comments that stop the mistake recurring.
 *
 * @param source - GLSL source possibly containing comments.
 * @returns The source with comments replaced by whitespace.
 */
function stripGlslComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('PS1 world shader uniform consistency', () => {
  it('every GLSL uniform is supplied by the material', () => {
    // The dangerous direction: GLSL declares it, JavaScript does not provide it, so it
    // silently evaluates to zero.
    const declared = extractAllGlslUniforms([PS1_VERTEX_SHADER, PS1_FRAGMENT_SHADER]);
    const provided = new Set(Object.keys(buildMaterialForInspection().uniforms));

    const missing = [...declared].filter((name) => !provided.has(name));

    expect(
      missing,
      `These uniforms are declared in GLSL but not supplied by createPS1Material(), so ` +
        `they will silently read as zero: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every supplied material uniform is used by the GLSL', () => {
    // The dead-weight direction: wired up in JavaScript, doing nothing. Less dangerous
    // but it indicates the shader and the material factory have drifted apart.
    const declared = extractAllGlslUniforms([PS1_VERTEX_SHADER, PS1_FRAGMENT_SHADER]);
    const provided = Object.keys(buildMaterialForInspection().uniforms);

    const unused = provided.filter((name) => !declared.has(name));

    expect(
      unused,
      `These uniforms are supplied by createPS1Material() but never used in the GLSL, ` +
        `so they are dead weight: ${unused.join(', ')}`,
    ).toEqual([]);
  });

  it('the declared uniform-name list matches the material factory', () => {
    // PS1_UNIFORM_NAMES exists so other modules (the dev overlay, the uniform lint test
    // itself) can iterate the expected set without constructing a material. It must not
    // drift from the factory.
    const provided = new Set(Object.keys(buildMaterialForInspection().uniforms));
    const declaredList = new Set<string>(PS1_UNIFORM_NAMES);

    expect([...provided].sort()).toEqual([...declaredList].sort());
  });

  it('the shared uniform objects are the same references across materials', () => {
    // The whole point of sharedUniforms is that retuning the sun updates every material
    // at once. If a material ever deep-copied a uniform, that guarantee would break
    // silently, and the scene would develop an object lit by a stale sun.
    const first = buildMaterialForInspection();
    const second = buildMaterialForInspection();

    expect(first.uniforms.uSunColor).toBe(sharedUniforms.uSunColor);
    expect(second.uniforms.uSunColor).toBe(sharedUniforms.uSunColor);
    expect(first.uniforms.uSunColor).toBe(second.uniforms.uSunColor);

    // And mutating through the shared record must be visible from a material.
    const original = sharedUniforms.uSunIntensity.value;
    sharedUniforms.uSunIntensity.value = 0.123;
    expect(first.uniforms.uSunIntensity.value).toBe(0.123);
    sharedUniforms.uSunIntensity.value = original;
  });
});

describe('full-screen pass shader uniform consistency', () => {
  it('the palette pass declares exactly the uniforms it is given', () => {
    const declared = extractAllGlslUniforms([FULLSCREEN_VERTEX_SHADER, PALETTE_FRAGMENT_SHADER]);
    // Mirrors the uniform record constructed in PS1Pipeline for the palette material.
    const provided = ['uSource', 'uDitherTable', 'uPaletteLevels', 'uDitherAmount'];

    expect([...declared].sort()).toEqual([...provided].sort());
  });

  it('the blit pass declares exactly the uniforms it is given', () => {
    const declared = extractAllGlslUniforms([FULLSCREEN_VERTEX_SHADER, BLIT_FRAGMENT_SHADER]);
    const provided = ['uSource'];

    expect([...declared].sort()).toEqual([...provided].sort());
  });

  it('the sky shader declares exactly the uniforms it is given', () => {
    const declared = extractAllGlslUniforms([PS1_SKY_VERTEX_SHADER, PS1_SKY_FRAGMENT_SHADER]);
    const provided = [
      'uSkyOffset',
      'uHorizonColor',
      'uZenithColor',
      'uCloudColor',
      'uCloudCoverage',
      'uCloudSoftness',
    ];

    expect([...declared].sort()).toEqual([...provided].sort());
  });
});

describe('horizontalToVerticalFov — composition correctness', () => {
  it('converts a 16:9 horizontal FOV to the correct vertical FOV', () => {
    // three.js PerspectiveCamera takes a VERTICAL fov. The GDD specifies 60 degrees
    // horizontally. At 16:9 these differ by roughly a factor of 1.9, and getting this
    // wrong would silently change every composition in the game.
    const vertical = horizontalToVerticalFov(60, 16 / 9);
    expect(vertical).toBeGreaterThan(30);
    expect(vertical).toBeLessThan(38);
  });

  it('returns the same value for a square viewport', () => {
    expect(horizontalToVerticalFov(60, 1)).toBeCloseTo(60, 6);
  });

  it('gives a narrower vertical FOV as the viewport gets wider', () => {
    // A wide screen shows the same horizontal span with less vertical span.
    const at16x9 = horizontalToVerticalFov(60, 16 / 9);
    const at21x9 = horizontalToVerticalFov(60, 21 / 9);
    expect(at21x9).toBeLessThan(at16x9);
  });

  it('does not divide by zero on a degenerate aspect ratio', () => {
    expect(Number.isFinite(horizontalToVerticalFov(60, 0))).toBe(true);
  });
});

describe('GLSL ES 1.00 compatibility lint', () => {
  /**
   * The shaders are deliberately written in GLSL ES 1.00 (see the header of
   * src/render/shaders/ps1World.ts). ES 1.00 is the lowest-common-denominator dialect
   * that WebGL2 contexts still accept, which maximises the chance the game runs on a
   * device I cannot test on.
   *
   * Because CI cannot compile GLSL (risk W4), the compiler is effectively unavailable —
   * so these checks stand in for it. Each one corresponds to a construct that would be a
   * hard compile error at runtime and would present to the player as a black screen.
   */
  const allSources = [
    ['world vertex', PS1_VERTEX_SHADER],
    ['world fragment', PS1_FRAGMENT_SHADER],
    ['fullscreen vertex', FULLSCREEN_VERTEX_SHADER],
    ['palette fragment', PALETTE_FRAGMENT_SHADER],
    ['blit fragment', BLIT_FRAGMENT_SHADER],
    ['sky vertex', PS1_SKY_VERTEX_SHADER],
    ['sky fragment', PS1_SKY_FRAGMENT_SHADER],
  ].map(([name, source]) => [name, stripGlslComments(source)] as const);

  it('never uses round(), which does not exist in GLSL ES 1.00', () => {
    // round() arrived in GLSL ES 3.00. floor(x + 0.5) is the equivalent form and is what
    // the vertex snap uses. This exact bug was caught by review rather than by CI, which
    // is why the lint now exists.
    for (const [name, source] of allSources) {
      expect(source, `${name} must not call round(); use floor(x + 0.5)`).not.toMatch(
        /\bround\s*\(/,
      );
    }
  });

  it('never uses texture(), which is ES 3.00 syntax', () => {
    for (const [name, source] of allSources) {
      expect(source, `${name} must use texture2D() rather than texture()`).not.toMatch(
        /(?<!texture2D)(?<!textureCube)\btexture\s*\(/,
      );
    }
  });

  it('uses varying rather than in/out for interpolators', () => {
    for (const [name, source] of allSources) {
      // A bare `in`/`out` declaration on a varying is ES 3.00. `in` and `out` are still
      // legal as parameter qualifiers, so the check targets declarations specifically.
      expect(source, `${name} must declare interpolators with "varying"`).not.toMatch(
        /^\s*(in|out)\s+(vec[234]|float|mat[234])\s+\w+\s*;/m,
      );
    }
  });

  it('declares a precision qualifier in every stage', () => {
    // Without an explicit precision the fragment stage fails to compile on some
    // drivers, and vertex-stage precision differs from fragment-stage precision.
    for (const [name, source] of allSources) {
      expect(source, `${name} must declare a precision`).toMatch(/precision\s+(highp|mediump|lowp)\s+float\s*;/);
    }
  });

  it('contains no #version directive, which three.js supplies', () => {
    // three.js prepends its own version and compatibility prefix. A hand-written
    // #version must be the very first line to be legal, and it would not be here — so
    // including one is a guaranteed compile error.
    for (const [name, source] of allSources) {
      expect(source, `${name} must not contain a #version directive`).not.toMatch(/#version/);
    }
  });

  it('never uses a const array constructor', () => {
    // GLSL ES 1.00 does not support array constructors such as float[16](...). The Bayer
    // dither table is supplied as a texture for exactly this reason.
    for (const [name, source] of allSources) {
      expect(source, `${name} must not construct arrays`).not.toMatch(/\b(float|vec2|vec3|vec4|int)\s*\[\s*\d+\s*\]\s*\(/);
    }
  });
});
