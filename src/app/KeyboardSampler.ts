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
 *   • **No remapping, no gamepad, no mouse aim.** Fixed bindings only.
 *   • **No deadzone or analogue handling.** The stick case does not exist yet, so every
 *     magnitude is 0, 0.5 or 1.
 *
 * A reader who finds this file and wonders why input is so thin should read the paragraphs
 * above rather than assume it was an oversight. The DEV_LOG records the deferral too.
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
  };

  /** The most recent key-press tick, per binding, for edge detection. */
  private previousJump = false;
  private previousInteract = false;

  /**
   * @param target - The element to listen on. Usually `window`.
   */
  constructor(private readonly target: Window) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
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
