/**
 * The developer overlay.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A PRODUCTION FEATURE AND NOT A DEBUG HACK
 * ────────────────────────────────────────────────────────────────────────────────
 * Three of the open questions from Milestone 1.1 cannot be answered without a screen:
 *
 *   • Is `warpAmount = 0.65` the right default for the affine texture warping?
 *   • Is the vertex snap grid too aggressive or too subtle at 480x270?
 *   • Does the scene actually read as "lush bright jungle" rather than "muddy green"?
 *
 * Those are judgement calls about *appearance*, and no amount of reasoning in a sandbox
 * settles them. What the overlay can do is remove every *numerical* uncertainty around them —
 * live sliders for the shader uniforms, so a value can be found by looking rather than by
 * guessing and rebuilding. The remaining judgement is then about taste, which is the part a
 * human should be making anyway.
 *
 * It is also the instrument panel for Milestone 1.2's own doubts: the turn rate, the steer
 * weight and the coyote/buffer windows are all visible here while playing, so "feels
 * unresponsive" can be turned into "the turn rate is 220 deg/s and that is too slow" in one
 * glance.
 *
 * ─── DESIGN CONSTRAINTS ─────────────────────────────────────────────────────────────
 *  • Toggled with a key, off by default in a release build, and it must not steal keyboard
 *    focus from the game.
 *  • It reports the *renderer's* draw-call and triangle counts, because the whole point of
 *    risk R1 is that the frame budget has to be measured rather than assumed.
 *  • It must cost nothing when hidden: every update short-circuits on the visibility flag, and
 *    the DOM text is written at 4 Hz rather than every frame, because `textContent` writes
 *    force layout and doing that 60 times a second is measurable.
 */

import type { CharacterTickReport } from '../gameplay/CharacterController';
import type { FrameStats } from '../render/PS1Pipeline';

/** Everything the overlay can display. Gathered by the caller and formatted here. */
export interface OverlaySample {
  /** Frames per second, as a rolling average. */
  fps: number;
  /** 95th-percentile frame time in milliseconds — the number R1 is actually about. */
  frameTimeP95Ms: number;
  /** Mean frame time in milliseconds. */
  frameTimeMeanMs: number;
  /** Fixed simulation ticks per second, which should hold at 60. */
  ticksPerSecond: number;
  /** Renderer statistics from the most recent presented frame. */
  frameStats: FrameStats;
  /** The character's state, or null before a character exists. */
  character: CharacterTickReport | null;
  /** Safety-net rescue count, which should be zero in normal play. */
  rescues: number;
  /** Why the safety net last fired. */
  lastRescueReason: string;
}

/** Live-editable values, so tuning happens by looking rather than by guessing. */
export interface OverlayTunables {
  /** Affine-warp strength passed to the world shader. */
  warpAmount: number;
  /** Vertex snap grid resolution. Larger means a finer grid and less wobble. */
  snapGrid: number;
}

/**
 * A fixed-position DOM overlay reporting performance and simulation state.
 *
 * Deliberately not rendered in WebGL: drawing the overlay through the PS1 pipeline would
 * quantise the text to the 480x270 palette and make the numbers unreadable, and would also
 * make the overlay part of the thing it is measuring.
 */
export class DebugOverlay {
  private readonly root: HTMLDivElement;
  private readonly perfLine: HTMLDivElement;
  private readonly renderLine: HTMLDivElement;
  private readonly characterLine: HTMLDivElement;
  private readonly tuningLine: HTMLDivElement;

  private visible = false;

  /** Time accumulator, so DOM writes happen at 4 Hz rather than per frame. */
  private sinceLastWrite = 0;

  /** The staleness threshold in seconds. See the class note on layout cost. */
  private static readonly WRITE_INTERVAL_S = 0.25;

  /**
   * @param parent - The element to attach to. Usually `document.body`.
   * @param tunables - Live tunable values, shared with the renderer. Mutated in place by the
   *   overlay so the shader sees a new value on the next frame with no rebuild.
   */
  constructor(parent: HTMLElement, private readonly tunables: OverlayTunables) {
    this.root = document.createElement('div');
    this.root.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'z-index:1000',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#d8f0c8',
      'background:rgba(8,16,10,0.78)',
      'padding:8px 10px',
      'border-radius:4px',
      'border:1px solid rgba(150,200,120,0.35)',
      'pointer-events:none',
      'white-space:pre',
      'display:none',
    ].join(';');

    this.perfLine = document.createElement('div');
    this.renderLine = document.createElement('div');
    this.characterLine = document.createElement('div');
    this.tuningLine = document.createElement('div');
    this.tuningLine.style.cssText = 'color:#f0d8a0;margin-top:4px';

    this.root.append(this.perfLine, this.renderLine, this.characterLine, this.tuningLine);
    parent.appendChild(this.root);
  }

  /** Whether the overlay is currently displayed. */
  public get isVisible(): boolean {
    return this.visible;
  }

  /**
   * Show or hide the overlay.
   *
   * @param visible - The new visibility.
   */
  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.style.display = visible ? 'block' : 'none';
    // Force an immediate refresh so the first visible frame is populated rather than blank.
    if (visible) this.sinceLastWrite = DebugOverlay.WRITE_INTERVAL_S;
  }

  /** Toggle visibility, for a key binding. */
  public toggle(): void {
    this.setVisible(!this.visible);
  }

  /**
   * Adjust a tunable and return the updated set.
   *
   * @param key - Which tunable to change.
   * @param delta - Signed amount to add.
   * @param min - Lower clamp.
   * @param max - Upper clamp.
   */
  public nudgeTunable(key: keyof OverlayTunables, delta: number, min: number, max: number): void {
    const next = Math.min(max, Math.max(min, this.tunables[key] + delta));
    this.tunables[key] = next;
  }

  /**
   * Update the displayed values.
   *
   * @param sample - The current sample.
   * @param dt - Seconds since the previous call.
   */
  public update(sample: OverlaySample, dt: number): void {
    // The whole overlay costs nothing when hidden: one boolean test per frame.
    if (!this.visible) return;

    this.sinceLastWrite += dt;
    if (this.sinceLastWrite < DebugOverlay.WRITE_INTERVAL_S) return;
    this.sinceLastWrite = 0;

    this.writePerf(sample);
    this.writeRender(sample.frameStats);
    this.writeCharacter(sample.character, sample.rescues, sample.lastRescueReason);
    this.writeTuning();
  }

  /**
   * Write the performance block.
   *
   * @param sample - The current sample.
   */
  private writePerf(sample: OverlaySample): void {
    // The 95th percentile leads, because an average of 60 FPS with a stutter every few seconds
    // is a worse experience than a steady 55, and only the percentile shows it. This is the
    // measurement R1 is written about.
    this.perfLine.textContent =
      `FPS ${sample.fps.toFixed(1)}   ` +
      `frame mean ${sample.frameTimeMeanMs.toFixed(2)}ms  p95 ${sample.frameTimeP95Ms.toFixed(2)}ms\n` +
      `sim ${sample.ticksPerSecond.toFixed(1)} ticks/s`;
  }

  /**
   * Write the renderer block.
   *
   * @param stats - The pipeline's frame statistics.
   */
  private writeRender(stats: FrameStats): void {
    this.renderLine.textContent =
      `draws ${stats.drawCalls}  tris ${stats.triangles.toLocaleString()}  ` +
      `internal ${stats.internalWidth}x${stats.internalHeight}`;
  }

  /**
   * Write the character block.
   *
   * @param report - The character snapshot, or null.
   * @param rescues - Safety-net rescue count.
   * @param lastRescueReason - Why the safety net last fired.
   */
  private writeCharacter(
    report: CharacterTickReport | null,
    rescues: number,
    lastRescueReason: string,
  ): void {
    if (!report) {
      this.characterLine.textContent = 'character: none';
      return;
    }

    const position = report.position;
    const coyote = report.coyoteTicksRemaining;
    const buffer = report.jumpBufferTicksRemaining;

    this.characterLine.textContent =
      `state ${report.state}` +
      `${report.previousState !== report.state ? ` (from ${report.previousState})` : ''}\n` +
      `pos ${position.x.toFixed(2)} ${position.y.toFixed(2)} ${position.z.toFixed(2)}   ` +
      `speed ${report.horizontalSpeed.toFixed(2)} m/s\n` +
      `slope ${report.slopeAngle.toFixed(1)}deg (${report.slopeBand})  ` +
      `edge ${report.edgeProximity.toFixed(2)}\n` +
      `ground ${report.grounded ? report.surfaceType ?? 'yes' : 'air'}   ` +
      `coyote ${coyote > 0 ? `${coyote}t` : '-'}  buffer ${buffer > 0 ? `${buffer}t` : '-'}` +
      // Rescues should be zero in normal play. A non-zero count with a reason is the clearest
      // possible signal that something is wrong with the level or the controller.
      `${rescues > 0 ? `\nRESCUES ${rescues}  last: ${lastRescueReason}` : ''}`;
  }

  /** Write the live-tunable block. */
  private writeTuning(): void {
    this.tuningLine.textContent =
      `[ warp ${this.tunables.warpAmount.toFixed(2)} [ ]      ` +
      `snap ${this.tunables.snapGrid.toFixed(0)} - = ]  (F1 hides)`;
  }

  /** Remove the overlay from the DOM. */
  public dispose(): void {
    this.root.remove();
  }
}
