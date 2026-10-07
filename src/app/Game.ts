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
import { createWorldCamera, sharedUniforms } from '../render/PS1Material';
import { CharacterController } from '../gameplay/CharacterController';
import { CharacterRig } from '../gameplay/CharacterRig';
import { DebugOverlay, type OverlaySample } from './DebugOverlay';
import { InputSystem, type InputSnapshot } from '../input/InputSystem';
import { InputAction } from '../input/Bindings';
import { CameraRig } from '../gameplay/CameraRig';
import type { CameraModeTriggers } from '../core/math/camera';
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

  /** Camera orbit state for the title-screen preview, before a character exists. */
  private orbitAngle = 0;

  /**
   * The camera rig, once a character exists.
   *
   * Named `cameraRig` rather than `rig` because `rig` is already the character's visual rig, and
   * two fields called "the rig" in one class is a genuinely dangerous kind of ambiguity.
   */
  private cameraRig: CameraRig | null = null;

  /** The player, once a level exists. */
  private character: CharacterController | null = null;
  private rig: CharacterRig | null = null;
  private input: InputSystem | null = null;

  /**
   * This tick's input, produced once at the top of `simulateTick` and read by everything after it.
   *
   * Produced once because `beginTick` *consumes* the latches: calling it again within a tick would
   * report no input at all, and calling it from two systems would give the second one nothing. One
   * production per tick, one place to look when asking "what did the player press".
   */
  private snapshot: InputSnapshot | null = null;
  private overlay: DebugOverlay | null = null;

  /**
   * Live shader tunables, shared by reference with the overlay so a nudge applies on the very
   * next frame with no rebuild. This is what turns "is warpAmount 0.65 right?" from a guess
   * into a value that can be found by looking.
   */
  private readonly tunables = {
    warpAmount: sharedUniforms.uWarpAmount.value as number,
    // `uSnapGrid` is a Vec2 of (columns, rows) because the snap grid must be matched to the
    // render target's aspect. Only the row count is exposed: the column count is derived from
    // it and the target resolution in the pipeline, so tuning rows alone keeps the grid square.
    snapGrid: (sharedUniforms.uSnapGrid.value as THREE.Vector2).y,
  };

  /** The debug overlay's key handler, retained so it can be unbound on dispose. */
  private debugKeyHandler: ((event: KeyboardEvent) => void) | null = null;

  /**
   * The action awaiting a keypress, while the developer is rebinding it.
   *
   * ─── A DELIBERATELY MINIMAL REBIND, AND WHY IT IS NOT THE SETTINGS SCREEN ──────────
   * GDD §10.1 puts settings UI in Phase 5, and that screen will be built properly then: a list of
   * actions, a conflict prompt, unbind buttons. What this is instead is the smallest thing that
   * makes remapping *verifiable end to end* — press F3, press a key, reload the page, check that
   * the new key still works.
   *
   * Without it, persistence would be proven only by unit tests that construct a fake `storage`.
   * That proves the code paths agree with each other; it does not prove that a real browser wrote
   * a real `localStorage` entry that a real page reload can read back. Those are different claims
   * and only one of them is worth a milestone acceptance criterion.
   */
  private rebindCapture: InputAction | null = null;

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

    // ── The player ─────────────────────────────────────────────────────────────
    // Created AFTER the prime step, because a character whose controller queries an unprimed
    // world is corrupted permanently and silently (Phase 0, Q2). The spawn is raised slightly
    // so the first tick is a short settle rather than a resolved overlap.
    this.character = new CharacterController(physics, {
      x: spawn.x,
      y: spawn.y + 0.5,
      z: spawn.z,
    });

    this.rig = new CharacterRig(this.level.scene, this.level.clothTexture);

    // The canvas is where pointer lock is requested, so the input system needs it. Passing
    // `window` for keys and the canvas for the lock is the whole of the input surface.
    this.input = new InputSystem(window, this.renderer.domElement);

    this.cameraRig = new CameraRig(physics);
    // Snap rather than ease into position: the character spawns at a fixed point and a camera that
    // flies in from wherever the constructor left it is a one-off flourish that only ever looks
    // like a bug on reload.
    this.cameraRig.snapTo(this.character.report.position, this.character.report.facingAngle);

    // The overlay is created last so its constructor cannot be blamed for a boot failure in
    // the character or the rig.
    this.overlay = new DebugOverlay(document.body, this.tunables);
    this.installDebugKeyBindings();

    this.applyCameraToRenderer();

    return this.level.summary;
  }

  /**
   * Install the overlay's key bindings.
   *
   * Bound with `capture: true` and prevented from reaching the document so that the browser's
   * own Ctrl-based shortcuts cannot fire while the developer is tuning — pressing Ctrl to
   * crouch should not be interpreted as a browser command.
   *
   * @returns Nothing. Binding is a side effect; unbinding happens in {@link dispose}.
   */
  private installDebugKeyBindings(): void {
    const warpStep = 0.05;
    const snapStep = 8;

    this.debugKeyHandler = (event: KeyboardEvent): void => {
      switch (event.code) {
        case 'F1':
          this.overlay?.toggle();
          event.preventDefault();
          break;
        case 'BracketLeft':
          this.overlay?.nudgeTunable('warpAmount', -warpStep, 0, 1);
          break;
        case 'BracketRight':
          this.overlay?.nudgeTunable('warpAmount', warpStep, 0, 1);
          break;
        case 'Minus':
          this.overlay?.nudgeTunable('snapGrid', -snapStep, 16, 640);
          break;
        case 'Equal':
          this.overlay?.nudgeTunable('snapGrid', snapStep, 16, 640);
          break;
        case 'F3':
          // Begin a rebind of Jump, the action whose loss is most immediately obvious.
          this.rebindCapture = InputAction.Jump;
          break;
        default:
          if (this.rebindCapture !== null) {
            this.completeRebind(event.code);
            event.preventDefault();
            event.stopPropagation();
          }
          return;
      }
      this.applyTunables();
    };

    window.addEventListener('keydown', this.debugKeyHandler, { capture: true });
  }

  /**
   * Complete a rebind with the key the developer just pressed.
   *
   * ─── TWO HONEST LIMITATIONS, STATED RATHER THAN DISCOVERED ──────────────────────────
   *  1. `stopPropagation` is called, but the `InputSystem` listens in the **bubble** phase on the
   *     window while this handler runs in the **capture** phase, so the press that performs the
   *     rebind also reaches the input system and may act on its *old* binding for one tick. That is
   *     harmless for a developer binding — the next tick uses the new one — and it is not worth
   *     restructuring the input path to avoid for a devtool.
   *  2. The binding is always taken on the **keyboard**, never the gamepad. Capturing a pad button
   *     needs a polling loop that watches for a fresh press, which is real work and belongs with
   *     the settings screen that will need it.
   *
   * @param code - The `KeyboardEvent.code` of the key that finished the rebind.
   */
  private completeRebind(code: string): void {
    const action = this.rebindCapture;
    this.rebindCapture = null;
    if (!action || !this.input) return;

    const result = this.input.setBinding(action, { device: 'keyboard', code });

    if (!result.ok) {
      // Report refusals instead of swallowing them: a rebind that silently does nothing is
      // indistinguishable from a rebind that failed to persist, and the two need different fixes.
      console.info(`[JungleRelic] Rebind refused: ${result.detail}`);
      return;
    }

    console.info(`[JungleRelic] ${action} bound to ${code} (saved; reload to confirm it persists)`);
  }

  /**
   * Push the live tunables into the shared shader uniforms.
   *
   * Mutating the shared uniform objects updates every material that references them, so a
   * change here costs nothing and needs no recompile.
   */
  private applyTunables(): void {
    (sharedUniforms.uWarpAmount.value as number) = this.tunables.warpAmount;

    const snapGrid = sharedUniforms.uSnapGrid.value as THREE.Vector2;
    snapGrid.y = this.tunables.snapGrid;
    // Keep the grid square in internal-target space: a grid that is not square in proportion to
    // the target makes the snap wobble further horizontally than vertically, which reads as the
    // image shearing rather than wobbling.
    snapGrid.x = Math.round(this.tunables.snapGrid * (this.pipeline.internalWidth / this.pipeline.internalHeight));
  }

  /**
   * Drive the camera rig for one tick and push the result onto the render camera.
   *
   * Replaces the Milestone 1.1 placeholder, which positioned the camera behind the player with no
   * occlusion test, no ground handling and no way for the player to look around. Everything the
   * rig needs about the world — the probe radius, the layer list — it already holds; what it needs
   * from gameplay is the set of situational flags that select the camera mode, and those are
   * gathered here rather than inside the rig so the rig never has to reach into systems that do
   * not exist yet.
   */
  private updateCamera(): void {
    if (!this.cameraRig || !this.character || !this.input) return;

    const report = this.character.report;

    this.cameraRig.update(
      FIXED_DT,
      report,
      this.character.lastEvents,
      this.snapshot ? this.snapshot.look : { yawDelta: 0, pitchDelta: 0 },
      this.cameraModeTriggers(),
    );

    this.applyCameraToRenderer();
  }

  /**
   * The situational flags that select a camera mode.
   *
   * ─── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────────────
   * Two of the four GDD conditions cannot be answered yet and are not guessed:
   *
   *   • **Submerged** needs the water volume system (Milestone 2.2). A `WaterVolume` layer exists
   *     and nothing populates it, so there is no honest way to answer "is the camera underwater".
   *   • **In a tunnel** needs a corridor volume, which is level-design data that does not exist
   *     until the zones are built in Phase 3.
   *   • **Cinematic** and **zipline** need their systems (Phases 2 and 3).
   *
   * They are omitted rather than stubbed with a plausible-looking distance test, because a wrong
   * probe is worse than an absent one: it would switch the camera mode in ordinary play and there
   * would be no reason to suspect the cause. The rig handles `undefined` for all of them and falls
   * through to the correct lower-priority mode.
   *
   * `aiming` IS answerable — the aim button is a real key — but aiming itself is Milestone 2.1, and
   * a mode that narrows the FOV with nothing to shoot is a worse preview than no mode at all. It
   * is wired to the input binding and simply unreachable until the key exists.
   */
  private cameraModeTriggers(): Partial<CameraModeTriggers> {
    return {
      // Aiming became answerable this milestone: the aim control is bound and sampled, so the FOV
      // transition from 60 to 45 degrees is now a real behaviour rather than an unreachable branch.
      aiming: this.snapshot?.aiming ?? false,
    };
  }

  /**
   * Copy the rig's decision onto the renderer's camera.
   *
   * The FOV is set here rather than by the rig, because the rig deliberately knows nothing about
   * THREE — it reports a number in degrees and the renderer decides what to do with it. That
   * separation is what keeps the rig unit-testable without a WebGL context.
   */
  private applyCameraToRenderer(): void {
    if (!this.cameraRig) return;

    const state = this.cameraRig.current;
    const target = this.cameraRig.lookTarget();

    this.worldCamera.position.set(state.position.x, state.position.y, state.position.z);
    this.worldCamera.lookAt(target.x, target.y, target.z);

    if (Math.abs(this.worldCamera.fov - state.fovDeg) > 1e-3) {
      this.worldCamera.fov = state.fovDeg;
      this.worldCamera.updateProjectionMatrix();
    }
  }

  /**
   * Gather the overlay's sample from the live systems.
   *
   * @returns The sample, or a zeroed one before the character exists.
   */
  private buildOverlaySample(): OverlaySample {
    return {
      fps: this.currentFps,
      frameTimeP95Ms: this.percentileFrameTime(0.95),
      frameTimeMeanMs: this.meanFrameTime(),
      ticksPerSecond: this.ticksPerSecond,
      frameStats: this.pipeline.stats,
      character: this.character ? this.character.report : null,
      camera: this.cameraRig ? this.cameraRig.current : null,
      rebindCapture: this.rebindCapture,
      input: this.input
        ? {
            activeDevice: this.input.lastActiveDevice,
            gamepadConnected: this.input.isGamepadConnected,
            pointerLocked: this.input.isPointerLocked,
            loadStatus: this.input.lastLoadStatus,
            latency: this.input.consumeLatencySample(),
          }
        : null,
      rescues: this.character ? this.character.rescues : 0,
      lastRescueReason: this.character ? this.character.lastRescueReason : '',
    };
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
    // The controller reads its ground probe BEFORE the physics step, so it sees the world as
    // it was at the end of the previous tick. Stepping first would mean the character acted on
    // a world one tick ahead of the state its own position was computed against.
    // ─── ONE PRODUCTION PER TICK, AT THE TOP ─────────────────────────────────────────
    // The look delta is camera-relative input, so the input system needs to know where the camera
    // is pointing before it can turn a stick reading into a world direction. It is read from the
    // rig's *reported* state rather than from the renderer, so the transform uses exactly the yaw
    // the camera is actually on.
    const cameraYaw = this.cameraRig ? this.cameraRig.current.yaw : 0;
    this.snapshot = this.input ? this.input.beginTick(cameraYaw) : null;

    if (this.character && this.snapshot) {
      this.character.update(dt, this.snapshot.intent);
    }

    this.physics?.step();

    // ─── THE CAMERA TICKS HERE, NOT IN `render` ─────────────────────────────────────────
    // This is the single most important placement decision in the camera's integration, and it is
    // the opposite of where a camera "obviously" belongs. The camera advances its damping by `dt`
    // and consumes a look delta that the input layer drains, so updating it once per *frame*
    // would make both frame-rate dependent: at 144 Hz it would damp 2.4 times as fast as at 60,
    // and every accumulated mouse delta would be split across a different number of ticks. The
    // frame-rate independence proved in the camera tests would be quietly destroyed by the call
    // site — the tests drive the rig directly and would still pass.
    //
    // It also has to run AFTER the physics step, so the pivot is the character's post-move
    // position rather than the one it occupied when the tick began.
    this.updateCamera();
  }

  /**
   * Render a frame.
   *
   * @param alpha - Interpolation factor for the next tick. Unused, because every moving object
   *   is either stepped at a fixed rate and read directly (the camera, the character) or is a
   *   rigid body the physics step has already advanced. Threaded through so a future
   *   render-interpolated pass can use it without restructuring this method's signature.
   */
  private render(alpha: number): void {
    if (!this.level) return;

    void alpha;

    if (this.character && this.rig) {
      this.rig.update(
        this.character.report,
        FIXED_DT,
        // No per-foot ground raycasts yet: proper foot IK belongs with the animation pass.
        // Passing nulls means the IK is skipped rather than fed fabricated numbers.
        { left: null, right: null },
      );
      this.overlay?.update(this.buildOverlaySample(), FIXED_DT);
    } else {
      // No character yet: orbit the scene so the PS1 artefacts (vertex wobble, affine
      // warping) remain visible in motion, which a static camera would hide.
      this.orbitAngle += 0.0016;
      const orbitRadius = 30;
      this.worldCamera.position.set(
        Math.sin(this.orbitAngle) * orbitRadius,
        9.5,
        Math.cos(this.orbitAngle) * orbitRadius + 6,
      );
      this.worldCamera.lookAt(0, 2.2, -22);
    }

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
    return this.percentileFrameTime(0.99);
  }

  /**
   * Compute a percentile frame time from the rolling buffer.
   *
   * @param fraction - The percentile as a fraction, e.g. 0.95 for p95.
   * @returns The frame time at that percentile, in milliseconds, or 0 with no samples.
   */
  private percentileFrameTime(fraction: number): number {
    if (this.frameTimes.length === 0) return 0;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)));
    return sorted[index];
  }

  /**
   * Mean frame time from the rolling buffer.
   *
   * @returns The mean in milliseconds, or 0 with no samples.
   */
  private meanFrameTime(): number {
    if (this.frameTimes.length === 0) return 0;
    return this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length;
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

    // Every one of these owns a resource that would outlive the game object otherwise: DOM
    // nodes, window listeners, geometry and materials. Leaking any of them makes a hot reload
    // accumulate duplicates, which then all run on the same input.
    if (this.debugKeyHandler) {
      window.removeEventListener('keydown', this.debugKeyHandler, { capture: true });
      this.debugKeyHandler = null;
    }
    this.overlay?.dispose();
    this.overlay = null;
    this.input?.dispose();
    this.input = null;
    this.rig?.dispose();
    this.rig = null;
    this.character = null;

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
