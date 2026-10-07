/**
 * The game shell: renderer, frame loop, resize handling, and lifecycle.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE FRAME LOOP (docs/ARCHITECTURE.md §6.2)
 * ────────────────────────────────────────────────────────────────────────────────
 * Simulation is decoupled from presentation with a clamped accumulator:
 *
 *     accumulator += min(frameDelta, MAX_FRAME_DELTA)
 *     while (accumulator >= FIXED_DT) { ...simulate one tick...; accumulator -= FIXED_DT }
 *     render(accumulator / FIXED_DT)
 *
 * Why each part exists:
 *  • **Fixed 1/60 s ticks** make physics bit-identical at 30, 60 and 144 Hz. Variable-dt
 *    physics is the classic cause of "sometimes I fall through the floor" and of jump
 *    height varying with framerate.
 *  • **The clamp** prevents a post-alt-tab accumulator from queueing hundreds of ticks
 *    and fast-forwarding the player through walls at 40x speed.
 *  • **Interpolation alpha** is computed but currently unused, because the camera is the
 *    only moving thing this milestone. It is threaded through rendering anyway so that
 *    Milestone 1.2 does not require restructuring the loop.
 *
 * Milestone 1.1 renders the environment with an orbiting camera. The character
 * controller (Milestone 1.2) and the real camera rig (Milestone 1.3) replace the orbit
 * camera without touching this file's structure.
 */

import * as THREE from 'three';
import {
  FIXED_DT,
  MAX_FRAME_DELTA_S,
  RENDER_TARGET_HEIGHT,
  RENDER_TARGET_WIDTH,
} from '../core/constants';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { PS1Pipeline } from '../render/PS1Pipeline';
import { createWorldCamera } from '../render/PS1Material';
import { buildJungleLevel, type BuiltLevel, type LevelSummary } from '../world/LevelBuilder';

/** Live performance counters, surfaced by the debug overlay. */
export interface PerformanceSnapshot {
  fps: number;
  /** 99th-percentile frame time in milliseconds. Averages hide hitches. */
  p99FrameTimeMs: number;
  averageFrameTimeMs: number;
  fixedTicksPerSecond: number;
  drawCalls: number;
  triangles: number;
  colliderCount: number;
}

/**
 * Owns the renderer, the level, the pipeline and the frame loop.
 *
 * Construction is cheap and synchronous; {@link initialise} performs the work. This
 * split exists so the boot sequence can render a title screen before physics exists
 * (the two-phase boot described in ARCHITECTURE.md §W5).
 */
export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly pipeline: PS1Pipeline;
  private readonly worldCamera: THREE.PerspectiveCamera;

  private level: BuiltLevel | null = null;
  private physics: PhysicsWorld | null = null;

  /** Camera orbit state for the Milestone 1.1 preview. Replaced in Milestone 1.2. */
  private orbitAngle = 0;

  private accumulator = 0;
  private lastFrameTime = 0;
  private running = false;
  private animationHandle = 0;

  /** Rolling frame-time samples for percentile reporting. */
  private readonly frameTimes: number[] = [];
  private frameTimesCursor = 0;
  private readonly frameTimeSampleCount = 240;

  private fpsAccumulator = 0;
  private fpsFrameCount = 0;
  private currentFps = 0;

  /** Fixed ticks executed since the last snapshot, used to report simulation rate. */
  private ticksThisSecond = 0;
  private ticksPerSecond = 0;

  /**
   * @param canvas - The canvas element to render into.
   * @throws If a WebGL context cannot be created, with a message a player can act on.
   */
  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // Aliasing is part of the aesthetic; MSAA would fight it.
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });

    this.renderer.setClearColor(0x2a3f52, 1);
    // sRGB output: textures are authored in sRGB and the palette pass works in that
    // space, so telling the renderer the output is sRGB keeps colours as authored
    // rather than double-converting them into something washed out.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = false; // No shadows: period-inaccurate and costly.

    this.pipeline = new PS1Pipeline(this.renderer, {
      width: RENDER_TARGET_WIDTH,
      height: RENDER_TARGET_HEIGHT,
    });

    this.worldCamera = createWorldCamera(this.pipeline.internalWidth / this.pipeline.internalHeight);

    this.pipeline.setCanvasSize();
    this.handleResize();
  }

  /**
   * Load the level and bring the world up.
   *
   * @param physics - An already-primed physics world. Priming is the caller's
   *   responsibility because it must happen after the level's colliders exist; see
   *   `PhysicsWorld.primeAndVerify`.
   * @returns The level summary, for logging and assertions.
   */
  public loadLevel(physics: PhysicsWorld): LevelSummary {
    this.physics = physics;
    this.level = buildJungleLevel(physics);

    const spawn = this.level.summary.spawnPoint;

    // Verify the world is queryable before anything depends on it. E1c proved an
    // unprimed world behaves correctly by accident, so this check converts a silent
    // permanent physics failure into an immediate, loud one.
    physics.primeAndVerify({ x: spawn.x, y: spawn.y + 8, z: spawn.z });

    // Position the preview camera to overlook the temple approach.
    this.worldCamera.position.set(spawn.x, spawn.y + 3.4, spawn.z + 9);
    this.worldCamera.lookAt(0, 1.5, -20);

    return this.level.summary;
  }

  /** The loaded scene, or null before {@link loadLevel}. */
  public get scene(): THREE.Scene | null {
    return this.level?.scene ?? null;
  }

  /**
   * Begin the frame loop.
   *
   * @throws If called before a level is loaded, because rendering an empty scene would
   *   silently look like a rendering bug.
   */
  public start(): void {
    if (!this.level) {
      throw new Error('Game.start() called before loadLevel().');
    }
    if (this.running) {
      return;
    }

    this.running = true;
    this.lastFrameTime = performance.now();
    this.accumulator = 0;
    this.animationHandle = requestAnimationFrame(this.frame);
  }

  /** Stop the frame loop. Safe to call when already stopped. */
  public stop(): void {
    this.running = false;
    if (this.animationHandle !== 0) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = 0;
    }
  }

  /**
   * The frame callback.
   *
   * Bound as an arrow property so `requestAnimationFrame` receives a stable reference
   * and `this` is correct without a per-frame `.bind()` allocation (which would show up
   * as steady GC pressure — see risk R1's allocation concern).
   */
  private readonly frame = (now: number): void => {
    if (!this.running) return;

    // Frame timing, clamped so a debugger pause or a background tab does not produce a
    // single enormous sample that pollutes the percentile statistics.
    const rawDelta = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    const frameDelta = Math.min(Math.max(rawDelta, 0), MAX_FRAME_DELTA_S);
    this.recordFrameTime(frameDelta);

    // ---- Fixed-timestep simulation ----
    this.accumulator += frameDelta;
    let ticks = 0;

    // The guard bounds the loop in the pathological case where the delta clamp is
    // defeated (for example a breakpoint inside the loop itself), so the game can never
    // hang trying to catch up.
    while (this.accumulator >= FIXED_DT && ticks < 8) {
      this.simulateTick(FIXED_DT);
      this.accumulator -= FIXED_DT;
      ticks++;
      this.ticksThisSecond++;
    }

    // If we hit the guard, discard the remaining backlog rather than carrying a debt
    // that can never be repaid. Losing simulation time is strictly better than
    // spiralling into an ever-growing catch-up loop.
    if (ticks === 8 && this.accumulator >= FIXED_DT) {
      this.accumulator = 0;
    }

    // ---- Presentation ----
    this.render(ticks > 0 ? this.accumulator / FIXED_DT : 0);

    // ---- Rolling statistics ----
    this.fpsAccumulator += frameDelta;
    this.fpsFrameCount++;
    if (this.fpsAccumulator >= 0.5) {
      this.currentFps = this.fpsFrameCount / this.fpsAccumulator;
      this.ticksPerSecond = this.ticksThisSecond / this.fpsAccumulator;
      this.fpsAccumulator = 0;
      this.fpsFrameCount = 0;
      this.ticksThisSecond = 0;
    }

    this.animationHandle = requestAnimationFrame(this.frame);
  };

  /**
   * Advance the simulation by exactly one fixed tick.
   *
   * Milestone 1.1 has no simulated entities, so this only advances the physics world.
   * The character controller, AI, puzzles and camera rig all slot in here in dependency
   * order (see ARCHITECTURE.md §6.2).
   *
   * @param dt - The fixed timestep, always FIXED_DT. Passed explicitly so that a future
   *   system cannot accidentally read a real-time delta and reintroduce non-determinism.
   */
  private simulateTick(dt: number): void {
    void dt;
    this.physics?.step();
  }

  /**
   * Render a frame.
   *
   * @param alpha - Interpolation factor for the next tick, currently unused because the
   *   only moving object is the camera. Threaded through so Milestone 1.2 can interpolate
   *   without restructuring.
   */
  private render(alpha: number): void {
    if (!this.level) return;

    void alpha;

    // Milestone 1.1 preview: orbit the camera slowly around the scene so the PS1
    // artefacts (vertex wobble, affine warping) are visible in motion. A static camera
    // hides the two most important things this milestone exists to demonstrate.
    this.orbitAngle += 0.0016;
    const orbitRadius = 30;
    this.worldCamera.position.set(
      Math.sin(this.orbitAngle) * orbitRadius,
      9.5,
      Math.cos(this.orbitAngle) * orbitRadius + 6,
    );
    this.worldCamera.lookAt(0, 2.2, -22);

    // Keep the sky dome centred on the camera so it reads as infinitely distant.
    this.level.updateSky(this.worldCamera.position);

    this.pipeline.render(this.level.scene, this.worldCamera);
  }

  /**
   * Record a frame time into the rolling percentile buffer.
   *
   * @param frameDelta - Frame duration in seconds.
   */
  private recordFrameTime(frameDelta: number): void {
    const milliseconds = frameDelta * 1000;
    if (this.frameTimes.length < this.frameTimeSampleCount) {
      this.frameTimes.push(milliseconds);
    } else {
      this.frameTimes[this.frameTimesCursor] = milliseconds;
      this.frameTimesCursor = (this.frameTimesCursor + 1) % this.frameTimeSampleCount;
    }
  }

  /**
   * Compute the p99 frame time from the rolling buffer.
   *
   * Averages hide the only thing that matters: a 1-in-200-frames hitch is what a player
   * perceives as stutter, and it is invisible in an average.
   *
   * @returns The 99th-percentile frame time in milliseconds.
   */
  private computeP99FrameTime(): number {
    if (this.frameTimes.length === 0) return 0;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
    return sorted[index];
  }

  /** Current performance counters. */
  public get performance(): PerformanceSnapshot {
    const average =
      this.frameTimes.length > 0
        ? this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length
        : 0;

    return {
      fps: this.currentFps,
      p99FrameTimeMs: this.computeP99FrameTime(),
      averageFrameTimeMs: average,
      fixedTicksPerSecond: this.ticksPerSecond,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      colliderCount: this.physics?.colliderCount ?? 0,
    };
  }

  /**
   * Handle a canvas or window resize.
   *
   * Intentionally does NOT resize the internal render targets: the whole point of a
   * fixed 480x270 internal resolution is that it stays fixed. Only the presented scale
   * changes, and it snaps to an integer multiple to preserve uniform pixel sizes.
   */
  private handleResize(): void {
    this.pipeline.setCanvasSize();
  }

  /**
   * Release every GPU and WASM resource owned by the game.
   *
   * Explicit teardown matters because the physics world lives outside the JS heap:
   * dropping the reference would leak the entire Rapier simulation (risk R9).
   */
  public dispose(): void {
    this.stop();
    this.level?.dispose();
    this.level = null;

    this.pipeline.dispose();
    this.physics?.dispose();
    this.physics = null;

    // Force the context to be released so a hot reload does not accumulate contexts
    // until the browser refuses to create any more.
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
