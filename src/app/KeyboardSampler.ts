/**
 * A minimal keyboard sampler, and an honest statement of what it is not.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THIS IS A TEMPORARY ADAPTER, NOT MILESTONE 1.4'S INPUT SYSTEM
 * ────────────────────────────────────────────────────────────────────────────────
 * Milestone 1.4 specifies the real input layer: keyboard and mouse primary, gamepad
 * secondary, a 150 ms jump buffer and a 200 ms interact buffer at the *input* level,
 * `localStorage` remapping, and five enumerated edge cases including gamepad disconnect
 * fallback and "a held jump button must not auto-jump".
 *
 * **None of that is here, and it is not pretending to be here.** This file exists for one
 * reason: a character controller that cannot be driven cannot be verified, visually or by
 * feel. The brief's own acceptance criteria require a playable character in the preview, and
 * deferring that until Milestone 1.4 would mean shipping a controller nobody had ever seen
 * move.
 *
 * What it deliberately does NOT do, so the omission is visible rather than implicit:
 *
 *   • **No press-edge detection beyond the frame.** It samples the physical key state once per
 *     fixed tick. Holding jump therefore reports `jumpRequested: true` every tick — which is
 *     harmless *only* because the controller's buffer and cooldown make a held jump fire once.
 *     Milestone 1.4 must own this properly rather than relying on that.
 *   • **No buffers.** Buffering is implemented downstream in the controller for coyote time;
 *     the input-level buffers the GDD specifies are a separate mechanism.
 *   • **No remapping and no gamepad.** Fixed bindings only. Mouse look IS implemented (the
 *     camera in Milestone 1.3 needs it and would otherwise be untestable by feel), but pointer
 *     lock, sensitivity, Y-inversion and zoom are all Milestone 1.4's.
 *   • **No deadzone or analogue handling.** The stick case does not exist yet, so every
 *     magnitude is 0, 0.5 or 1.
 *
 * A reader who finds this file and wonders why input is so thin should read the paragraphs
 * above rather than assume it was an oversight. The DEV_LOG records the deferral too.
 *
 * ─── MOUSE LOOK: WHY IT LIVES HERE, AND WHY IT IS DELIBERATELY CRUDE ────────────────
 * The camera rig consumes a per-tick yaw and pitch DELTA in radians, and it must consume whole
 * deltas rather than a position: accumulating raw pixel counts inside the rig would make the
 * camera's response depend on how the browser batched `mousemove` events, which is exactly the
 * kind of frame-rate coupling the whole camera design rejects.
 *
 * So the deltas are accumulated here, in the sampler, and drained once per tick. Pixel counts
 * become radians with a fixed sensitivity; the deadzone, the sensitivity slider, the invert-Y
 * option and the "ignore motion while pointer lock is being acquired" case are all Milestone
 * 1.4's, and none of them change any interface.
 */

import type { CharacterIntent } from '../gameplay/LocomotionStates';

/** Keys this adapter cares about, by `KeyboardEvent.code` so layout does not matter. */
const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'ControlRight', 'KeyC'],
  interact: ['KeyE'],
} as const;

/**
 * Samples the keyboard once per tick and produces a `CharacterIntent`.
 *
 * Movement is expressed in **world space** here, not camera space, because there is no camera
 * rig until Milestone 1.3. Once the camera exists, the same stick/keys must be interpreted
 * relative to it — that transformation belongs in the input layer, not the controller, which is
 * precisely why the controller takes a world-space direction and does not read the camera.
 */
export class KeyboardSampler {
  private readonly held = new Set<string>();

  /** Bound so it can be removed on dispose; a leaked listener would outlive the game. */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Ignore auto-repeat: the OS will happily emit keydown forever while a key is held, and
    // treating each as a fresh press is exactly the "held jump auto-jumps" bug the GDD lists
    // as an input edge case.
    if (event.repeat) return;
    this.held.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  /**
   * Clear all held keys.
   *
   * Needed on window blur. Without it, alt-tabbing while running leaves the key in the held
   * set forever, and the character walks off on its own when the player returns — a
   * genuinely bewildering bug that is trivial to prevent.
   */
  private readonly onBlur = (): void => {
    this.held.clear();
    // Also drop any pending look. Alt-tabbing away and back must not deliver the mouse movement
    // from the window-switch as a camera swing.
    this.pendingYaw = 0;
    this.pendingPitch = 0;
  };

  /** The most recent key-press tick, per binding, for edge detection. */
  private previousJump = false;
  private previousInteract = false;

  /** Radians of camera rotation per pixel of mouse movement. */
  private static readonly MOUSE_SENSITIVITY = 0.0022;

  /**
   * Accumulated look delta, in radians, drained once per tick.
   *
   * Deliberately accumulated rather than a "latest value": a fast flick generates several
   * `mousemove` events between two frames, and keeping only the last one would silently discard
   * most of the movement, so the camera would feel like it was dropping input on fast turns.
   */
  private pendingYaw = 0;
  private pendingPitch = 0;

  /** Whether the pointer is locked. Look input is ignored until it is. */
  private pointerLocked = false;

  private readonly onMouseMove = (event: MouseEvent): void => {
    // Ignore movement when the pointer is not locked. Without this, merely moving the mouse
    // across the page turns the camera, which makes the preview unusable before the player has
    // clicked anything.
    if (!this.pointerLocked) return;

    this.pendingYaw += event.movementX * KeyboardSampler.MOUSE_SENSITIVITY;
    // Screen Y grows downward and pitch grows upward, so the sign inverts. This is also the point
    // a "invert Y" option would flip, which is why the negation is on its own line.
    this.pendingPitch -= event.movementY * KeyboardSampler.MOUSE_SENSITIVITY;
  };

  private readonly onPointerLockChange = (): void => {
    const wasLocked = this.pointerLocked;
    this.pointerLocked = document.pointerLockElement !== null;

    // Discard whatever accumulated across the lock transition. Without this, the first frame after
    // locking applies every pixel of movement from acquiring the lock — and acquiring a lock
    // typically involves a large, fast mouse movement toward the canvas.
    if (!wasLocked && this.pointerLocked) {
      this.pendingYaw = 0;
      this.pendingPitch = 0;
    }
  };

  private readonly onClick = (): void => {
    // Requesting a lock that is already held is a no-op that some browsers log a warning for.
    if (!this.pointerLocked) {
      void this.canvas.requestPointerLock();
    }
  };

  /**
   * @param target - The element to listen on. Usually `window`.
   */
  /**
   * @param target - The window to listen on for keys.
   * @param canvas - The element pointer lock is requested on. Clicking it captures the mouse.
   */
  constructor(
    private readonly target: Window,
    private readonly canvas: HTMLElement,
  ) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    canvas.addEventListener('click', this.onClick);
  }

  /**
   * Take this tick's camera look delta, in radians, and reset the accumulator.
   *
   * Drained rather than read, so a tick consumes exactly the movement that happened since the
   * previous tick and no movement is applied twice. Two calls in one tick return a zero delta the
   * second time, which is the correct behaviour: there is no new input.
   *
   * @returns The look delta for this tick.
   */
  public drainLookDelta(): { yawDelta: number; pitchDelta: number } {
    const yawDelta = this.pendingYaw;
    const pitchDelta = this.pendingPitch;
    this.pendingYaw = 0;
    this.pendingPitch = 0;
    return { yawDelta, pitchDelta };
  }

  /** Whether the pointer is currently locked, so the UI can prompt the player to click. */
  public get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  /**
   * Produce this tick's intent.
   *
   * @returns The intent, ready for `CharacterController.update`.
   */
  public sample(): CharacterIntent {
    const forward = this.isHeld('forward') ? 1 : 0;
    const back = this.isHeld('back') ? 1 : 0;
    const left = this.isHeld('left') ? 1 : 0;
    const right = this.isHeld('right') ? 1 : 0;

    // Diagonal movement is normalised, so moving north-east is not 41% faster than moving
    // north. Combining raw axis values is the classic way to get exactly that bug.
    let x = right - left;
    let z = forward - back;
    const length = Math.hypot(x, z);
    if (length > 1e-6) {
      x /= length;
      z /= length;
    }

    const jump = this.isHeld('jump');
    const interact = this.isHeld('interact');

    // Edge detection lives here because the controller's `jumpRequested` means "the player
    // asked to jump", not "the key is down". Holding jump must not keep re-requesting: the
    // controller's cooldown would absorb it, but relying on that would be accidental rather
    // than designed, and Milestone 1.4 replaces this anyway.
    const jumpPressed = jump && !this.previousJump;
    const interactPressed = interact && !this.previousInteract;
    this.previousJump = jump;
    this.previousInteract = interact;

    return {
      moveDirection: { x, z },
      // Walk when the run modifier is absent, matching the GDD's 2 m/s walk and 6 m/s run.
      moveMagnitude: length > 1e-6 ? (this.isHeld('run') ? 1 : 0.33) : 0,
      jumpHeld: jump,
      jumpRequested: jumpPressed,
      crouchHeld: this.isHeld('crouch'),
      interactRequested: interactPressed,
    };
  }

  /** Remove every listener. */
  public dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.removeEventListener('click', this.onClick);
    this.held.clear();
  }

  /**
   * Whether any key bound to an action is currently held.
   *
   * @param action - The binding group to test.
   * @returns True when at least one bound key is down.
   */
  private isHeld(action: keyof typeof BINDINGS): boolean {
    for (const code of BINDINGS[action]) {
      if (this.held.has(code)) return true;
    }
    return false;
  }
}
