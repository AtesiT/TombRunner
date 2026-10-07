/**
 * Deterministic, seedable pseudo-random number generation.
 *
 * WHY NOT `Math.random()`?
 * -----------------------
 * Three reasons, all of which matter for this project:
 *  1. **Reproducible tests.** Procedural texture and level generation must produce
 *     byte-identical output on every machine and every run, or a golden-value test
 *     is impossible and a visual regression cannot be bisected.
 *  2. **Stable player mental maps.** If rock and foliage placement changed on every
 *     reload, the player could not learn the level, which breaks a game whose value
 *     is authored level design.
 *  3. **Debuggable worlds.** A bug reproducible only under a specific generator
 *     sequence can be reproduced exactly by replaying the seed.
 *
 * The algorithm is SplitMix32: a well-distributed, fast, counter-based generator that
 * is trivial to reimplement identically in shader code if that ever becomes necessary.
 */

/**
 * A deterministic random number generator.
 *
 * Instances are cheap; prefer creating one per subsystem with a derived seed so that
 * adding a texture does not shift the sequence used to place trees.
 */
export class SeededRandom {
  /** Current internal state. Never read outside this class. */
  private state: number;

  /**
   * @param seed - Any 32-bit integer. The same seed always yields the same sequence.
   */
  constructor(seed: number) {
    // Force to uint32 and avoid the degenerate all-zero state.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /**
   * Generate the next 32-bit unsigned integer in the sequence.
   *
   * @returns An integer in [0, 2^32).
   */
  nextUint32(): number {
    // SplitMix32. The constants are the standard odd multipliers chosen for good
    // bit mixing; changing them silently changes every generated world.
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  }

  /**
   * Generate a float in [0, 1).
   *
   * @returns A uniformly distributed float.
   */
  nextFloat(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  /**
   * Generate a float in [min, max).
   *
   * @param min - Inclusive lower bound.
   * @param max - Exclusive upper bound.
   * @returns A uniformly distributed float in the range.
   */
  range(min: number, max: number): number {
    return min + this.nextFloat() * (max - min);
  }

  /**
   * Generate an integer in [min, max] inclusive.
   *
   * @param min - Inclusive lower bound.
   * @param max - Inclusive upper bound.
   * @returns A uniformly distributed integer.
   */
  intRange(min: number, max: number): number {
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  /**
   * Return true with the given probability.
   *
   * @param probability - Chance of returning true, in [0, 1].
   * @returns The boolean outcome.
   */
  chance(probability: number): boolean {
    return this.nextFloat() < probability;
  }

  /**
   * Derive a new independent generator from a labelled child seed.
   *
   * This is how subsystems stay decoupled: `derive('textures.grass')` produces a
   * sequence that does not shift when another subsystem consumes a different number
   * of values.
   *
   * @param label - A stable string label for the child stream.
   * @returns A new generator with a deterministic, label-dependent seed.
   */
  derive(label: string): SeededRandom {
    return new SeededRandom(this.hashString(label) ^ this.nextUint32());
  }

  /**
   * FNV-1a string hash, used to turn human-readable labels into seeds.
   *
   * @param value - The string to hash.
   * @returns A 32-bit unsigned hash.
   */
  private hashString(value: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }
}

/**
 * A tiny 2D value-noise sampler with fractal Brownian motion accumulation.
 *
 * Used for procedural textures. Deliberately written in plain TypeScript rather than
 * as a shader because the result is baked into a `DataTexture` once at start-up, which
 * makes it free at runtime and, more importantly, testable in CI.
 */
export class ValueNoise2D {
  /** Permutation-free lattice values, indexed by hashed lattice coordinate. */
  private readonly lattice: Float32Array;

  /**
   * @param rng - The generator supplying the lattice values.
   * @param size - Lattice resolution. Powers of two make the wrap cheap.
   */
  constructor(rng: SeededRandom, private readonly size: number = 256) {
    this.lattice = new Float32Array(size * size);
    for (let i = 0; i < this.lattice.length; i++) {
      this.lattice[i] = rng.nextFloat();
    }
  }

  /**
   * Sample the lattice with bilinear interpolation.
   *
   * @param x - Sample X, in lattice units.
   * @param y - Sample Y, in lattice units.
   * @returns A value in [0, 1].
   */
  private sampleLattice(x: number, y: number): number {
    const size = this.size;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    // Wrap with a positive modulo so negative coordinates stay valid.
    const xa = ((x0 % size) + size) % size;
    const ya = ((y0 % size) + size) % size;
    const xb = (xa + 1) % size;
    const yb = (ya + 1) % size;

    // Smoothstep the interpolation weights so cell boundaries are not visible.
    const tx = x - x0;
    const ty = y - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);

    const v00 = this.lattice[ya * size + xa];
    const v10 = this.lattice[ya * size + xb];
    const v01 = this.lattice[yb * size + xa];
    const v11 = this.lattice[yb * size + xb];

    const top = v00 + (v10 - v00) * sx;
    const bottom = v01 + (v11 - v01) * sx;
    return top + (bottom - top) * sy;
  }

  /**
   * Fractal Brownian motion: sum octaves of value noise at increasing frequency and
   * decreasing amplitude.
   *
   * @param x - Sample X in normalised [0, 1) texture space.
   * @param y - Sample Y in normalised [0, 1) texture space.
   * @param octaves - Number of octaves to accumulate.
   * @param frequency - Base frequency in lattice cells across the unit square.
   * @returns A value in [0, 1].
   */
  fbm(x: number, y: number, octaves: number = 4, frequency: number = 4): number {
    let total = 0;
    let amplitude = 1;
    let normalisation = 0;
    let freq = frequency;

    for (let octave = 0; octave < octaves; octave++) {
      total += this.sampleLattice(x * freq, y * freq) * amplitude;
      normalisation += amplitude;
      amplitude *= 0.5;
      freq *= 2;
    }

    return normalisation > 0 ? total / normalisation : 0;
  }
}
