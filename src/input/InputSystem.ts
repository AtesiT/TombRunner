/**
 * The input system: device state in, per-tick intent out.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 * THE ONE ARCHITECTURAL RULE THIS FILE EXISTS TO ENFORCE
 * ────────────────────────────────────────────────────────────────────────────────────
 * **Events latch. Ticks interpret. No logic in a handler.**
 *
 * This is `RISK_ANALYSIS.md` R10.1's commitment, made in Phase 0 and implemented here. A handler
 * that raycasts, or reads the DOM, or decides anything, does two bad things at once: it delays the
 * next frame, and it moves the input path somewhere it cannot be tested. So every handler in this
 * file does one of two things — set a flag, or add to a number — and returns. Anything that looks
 * like a decision happens inside `beginTick()`, which is called exactly once per fixed simulation
 * tick.
 *
 * The payoff is not tidiness. It is that the entire input path becomes testable by feeding
 * synthetic event sequences with exact control over *when* each event arrives relative to a tick,
 * which is the only way to test the buffer semantics honestly. A press that begins and ends inside
 * a single tick is the central case, and it cannot be produced any other way.
 *
 * ─── THE BUFFER DESIGN, WHICH IS THE SUBTLEST THING HERE ────────────────────────────
 * Both layers buffer jump: this one (150 ms, per the brief) and the character controller's own
 * state machine (also 150 ms, from Milestone 1.2). If a buffer re-asserts its request every tick
 * while it is open, the two *add up* and the player gets ~300 ms of forgiveness, which manifests as
 * the character jumping when nothing was pressed. That reads as the game acting on its own, and it
 * is the kind of bug that gets blamed on the physics.
 *
 * So the buffer here is a **latch consumed on delivery**: a press is handed over exactly once, and
 * cleared at that moment. The two mechanisms then do different jobs:
 *
 *   • **this latch** bridges the gap between input *events* and simulation *ticks*, so a tap that
 *     starts and ends between two ticks is never lost, and a press captured during a frame hitch
 *     cannot be swallowed;
 *   • **the controller's buffer** holds an already-delivered press until the game *permits* it —
 *     landing, coyote time, cooldown.
 *
 * Composition is `max()`, not `sum()`, and the tests assert the difference.
 */

import {
  ALL_ACTIONS,
  bindingLabel,
  type Binding,
  type BindingResult,
  type BindingTable,
  cloneDefaultBindings,
  InputAction,
  rebind,
  unbind,
} from './Bindings';
import {
  type BindingsLoadResult,
  type BindingsLoadStatus,
  clearBindings,
  detectStorage,
  loadBindings,
  saveBindings,
  type StorageLike,
} from './BindingStore';
import {
  applyRadialDeadzone,
  normalizeTrigger,
  resolveMovement,
  stickToWorldDirection,
  type Analog2D,
  type WorldDirection,
} from '../core/math/analog';
import {
  ATTACK_BUFFER_TICKS,
  GAMEPAD_LOOK_DEADZONE,
  GAMEPAD_MOVE_DEADZONE,
  GAMEPAD_TRIGGER_REST,
  INPUT_LOOK_SENSITIVITY,
  INTERACT_BUFFER_TICKS,
  JUMP_BUFFER_TICKS,
} from '../core/constants';
import type { CharacterIntent } from '../gameplay/LocomotionStates';

/** What the player is asking the camera to do this tick, in radians. */
export interface LookDelta {
  yawDelta: number;
  pitchDelta: number;
}

/** Everything gameplay needs from input for one tick. */
export interface InputSnapshot {
  /** Ready to hand to `CharacterController.update` — world-space, camera-relative. */
  intent: CharacterIntent;
  /** Camera rotation to apply this tick, already scaled and deadzoned. */
  look: LookDelta;
  /** True while the aim control is held. */
  aiming: boolean;
  /** True on the tick the inventory control is pressed. */
  inventoryPressed: boolean;
  /** True on the tick the pause control is pressed. */
  pausePressed: boolean;
  /**
   * An attack press that has not yet been consumed, if any.
   *
   * Nothing consumes this until Milestone 2.1. It is exposed now so the buffer's behaviour is real
   * and testable rather than an assumption about a system that does not exist yet.
   */
  attackBuffered: boolean;
  /** Which device most recently produced input, for the overlay and for disconnect fallback. */
  activeDevice: 'keyboard' | 'gamepad';
  /** True when a `standard`-mapping gamepad is connected. */
  gamepadConnected: boolean;
}

/**
 * The latency a tick observed between an input event and the simulation consuming it.
 *
 * Tracked so R6's "≤ 1 tick" budget has an instrument rather than a wish. See
 * `InputSystem.consumeLatencySample`.
 */
export interface LatencySample {
  /** Milliseconds from the input event to the tick that acted on it. */
  eventToTickMs: number;
  /** Which action the measurement came from, for the overlay. */
  action: InputAction;
}

/** An internal latch: a pending press with a tick deadline. */
interface Latch {
  ticksRemaining: number;
}

/**
 * The input system.
 *
 * Constructed with the window and the canvas, because pointer lock is requested on the canvas and
 * keyboard state is global to the window.
 */
export class InputSystem {
  private readonly heldKeys = new Set<string>();

  /**
   * Latched presses, keyed by action.
   *
   * A `Map` rather than per-action fields: the set of actions is data, and adding one must not
   * require adding a field, a handler branch and a clear-site. Missing one of the three is exactly
   * how an action ends up permanently latched.
   */
  private readonly latches = new Map<InputAction, Latch>();

  /** Accumulated mouse movement in raw device units, drained once per tick. */
  private pendingMouseX = 0;
  private pendingMouseY = 0;

  /** The gamepad's fully-sampled state for this tick, reused so polling allocates nothing. */
  private readonly padMove: Analog2D = { x: 0, y: 0 };
  private readonly padLook: Analog2D = { x: 0, y: 0 };
  private padButtons: boolean[] = [];
  private padTriggers: number[] = [];
  private gamepadIndex: number | null = null;
  private padMappingWarned = false;

  /** The pad's per-action state at the end of the previous tick, for edge derivation (R10.3). */
  private readonly padPrevious = new Map<InputAction, boolean>();

  /** The most recent device to produce input. Drives seamless disconnect fallback (R10.3). */
  private activeDevice: 'keyboard' | 'gamepad' = 'keyboard';

  /** True while a `standard`-mapping pad is connected and being read. */
  private padConnected = false;

  /** The current binding table, owned here and replaced wholesale on a rebind. */
  private bindings: BindingTable;

  /** Where bindings are persisted, or null when storage is unavailable. */
  private readonly storage: StorageLike | null;

  /** When the most recent input event was observed, in milliseconds, for the latency budget. */
  private lastEventTimeMs: number | null = null;

  /** Which action that event belonged to. */
  private lastEventAction: InputAction | null = null;

  /** The most recent latency measurement, or null before anything has been measured. */
  private latency: LatencySample | null = null;

  /** Whether the pointer is locked. Look input is ignored until it is. */
  private pointerLocked = false;

  /** Reported once, so a rejected lock request does not spam the console every click. */
  private pointerLockWarned = false;

  /** True until the first `beginTick`, so the buffers do not fire on frame zero. */
  private firstTickPending = true;

  /**
   * @param target - The window carrying keyboard, mouse and pointer-lock events.
   * @param canvas - The element pointer lock is requested on.
   * @param storage - Where to persist bindings. Injected so tests can supply their own; defaults
   *   to the browser's `localStorage` when it is usable.
   */
  constructor(
    private readonly target: Window,
    private readonly canvas: HTMLElement,
    storage?: StorageLike | null,
  ) {
    this.storage = storage === undefined ? detectStorage() : storage;
    const loaded: BindingsLoadResult = loadBindings(this.storage);
    this.bindings = loaded.table;
    this.lastLoadStatus = loaded.status;
    this.lastLoadMessage = loaded.message;

    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('mousedown', this.onMouseDown);
    target.addEventListener('mouseup', this.onMouseUp);
    target.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('blur', this.onBlur);
    target.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    // Bound on the injected target rather than the global `window`: the real call site passes the
    // window anyway, and going through the same object the keys arrive on means a test can supply
    // one object for all of it instead of stubbing a global.
    target.addEventListener('gamepadconnected', this.onGamepadConnected);
    target.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);
    canvas.addEventListener('click', this.onCanvasClick);
  }

  /** How the bindings were obtained at construction, for the overlay and the settings screen. */
  public readonly lastLoadStatus: BindingsLoadStatus;

  /** A message about the load, when there was something to say. */
  public readonly lastLoadMessage: string | null;

  /**
   * The most recent latency measurement.
   *
   * Returned once and cleared, so a caller polling it does not report the same sample twice — the
   * overlay samples once per frame and would otherwise show a stale number as if it were live.
   */
  public consumeLatencySample(): LatencySample | null {
    const sample = this.latency;
    this.latency = null;
    return sample;
  }

  /** The current binding table. A copy; the caller cannot mutate the live one. */
  public get bindingTable(): BindingTable {
    const copy = {} as BindingTable;
    for (const action of ALL_ACTIONS) {
      copy[action] = this.bindings[action].map((binding) => ({ ...binding }));
    }
    return copy;
  }

  /** Whether the pointer is locked, so the UI can prompt the player to click. */
  public get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  /** The most recent device to produce input. */
  public get lastActiveDevice(): 'keyboard' | 'gamepad' {
    return this.activeDevice;
  }

  /** True when a usable gamepad is being read. */
  public get isGamepadConnected(): boolean {
    return this.padConnected;
  }

  /**
   * Change one binding and persist it.
   *
   * @param action - The action to rebind.
   * @param binding - The control to assign to it.
   * @returns The outcome, so the caller can explain a refusal.
   */
  public setBinding(action: InputAction, binding: Binding): BindingResult {
    const result = rebind(this.bindings, action, binding);
    if (result.ok) this.adoptBindings(result.table);
    return result;
  }

  /**
   * Remove one binding from an action, if the action would keep at least one.
   *
   * @param action - The action to remove a control from.
   * @param binding - The control to remove.
   * @returns The outcome, so the caller can explain a refusal.
   */
  public clearBinding(action: InputAction, binding: Binding): BindingResult {
    const result = unbind(this.bindings, action, binding);
    if (result.ok) this.adoptBindings(result.table);
    return result;
  }

  /** Restore the shipped bindings, in memory and on disk. */
  public resetBindings(): void {
    this.bindings = cloneDefaultBindings();
    clearBindings(this.storage);
    // Deliberately *not* saved afterwards: clearing the key and writing an empty payload are the
    // same thing on the next load, and clear-then-save would leave a payload representing the
    // defaults rather than no payload at all.
  }

  /** A label for one of an action's bindings, for display. */
  public labelFor(action: InputAction, index = 0): string {
    const binding = this.bindings[action][index];
    return binding ? bindingLabel(binding) : '—';
  }

  /**
   * Latch the current device state and produce this tick's intent.
   *
   * ─── THE ORDER INSIDE THIS METHOD IS THE DESIGN ─────────────────────────────────────
   *  1. poll the devices, so the gamepad is read exactly once per tick and at no other time;
   *  2. expire latches, so a press captured during a long stall cannot fire seconds later;
   *  3. adopt this tick's pressed edges into latches;
   *  4. drain the latches into the snapshot, consuming each one;
   *  5. measure the latency of anything that was consumed.
   *
   * Called exactly once per fixed tick. Calling it twice in a tick would consume the latches on the
   * first call and report nothing on the second, which is correct — there is no new input — and is
   * asserted by a test rather than left as folklore.
   *
   * @param cameraYaw - The camera's yaw in radians, used to make movement camera-relative.
   * @returns This tick's snapshot.
   */
  public beginTick(cameraYaw: number): InputSnapshot {
    this.pollGamepad();

    if (this.firstTickPending) {
      // The first tick adopts no edges: whatever was down before the game started was not an
      // intentional press, and firing a jump on frame zero because a key happened to be held is
      // exactly the class of bug the latch design exists to prevent.
      this.firstTickPending = false;
      this.latches.clear();
      return this.buildSnapshot(cameraYaw, false);
    }

    this.expireLatches();
    this.adoptEdges();
    return this.buildSnapshot(cameraYaw, true);
  }

  /** Remove every listener and drop all captured state. */
  public dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('mousedown', this.onMouseDown);
    this.target.removeEventListener('mouseup', this.onMouseUp);
    this.target.removeEventListener('mousemove', this.onMouseMove);
    this.target.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.target.removeEventListener('gamepadconnected', this.onGamepadConnected);
    this.target.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected);
    this.canvas.removeEventListener('click', this.onCanvasClick);
    this.clearTransientState();
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // EVENT HANDLERS — every one sets a flag or adds a number, and nothing else
  // ─────────────────────────────────────────────────────────────────────────────────

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Auto-repeat must not re-latch. The OS emits keydown continuously while a key is held, and
    // treating each as a fresh press is precisely edge case IE1 — a held jump auto-jumping.
    if (event.repeat) return;

    // Tab would move focus out of the game and Escape is claimed by the browser for pointer-lock
    // exit. Both are bound actions, so their default behaviour is suppressed while the game has
    // the pointer — but only then, so a player who has released the mouse can still use the
    // browser normally.
    if (this.pointerLocked && (event.code === 'Tab' || event.code === 'Escape')) {
      event.preventDefault();
    }

    if (this.heldKeys.has(event.code)) return; // already down; not a new edge
    this.heldKeys.add(event.code);

    for (const action of this.actionsFor('keyboard', event.code)) {
      this.latch(action);
    }
    this.noteActivity('keyboard');
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.heldKeys.delete(event.code);
  };

  /**
   * Mouse buttons are held state as well as edges, and both matter.
   *
   * ─── THE BUG THIS FIXES ──────────────────────────────────────────────────────────────
   * The first draft of this handler latched the press and stopped. But latching only produces
   * *edges*, and `Aim` is a level-triggered action read through `isActionHeld` — which consults
   * the held set that this handler never wrote to. Aiming with the right mouse button therefore
   * did nothing at all, and the only symptom was an FOV that never changed.
   *
   * The giveaway was the asymmetry: `onMouseUp` already removed the code from the held set, so the
   * two handlers disagreed about whether mouse buttons *had* held state. A release that removes
   * something a press never added is a contradiction, and it is worth noticing as one.
   *
   * The repeat guard matches `onKeyDown`: a button already down is not a new press, so holding it
   * cannot produce a stream of edges.
   */
  private readonly onMouseDown = (event: MouseEvent): void => {
    const code = MOUSE_BUTTON_CODES[event.button];
    if (code === undefined) return;
    if (this.heldKeys.has(code)) return;

    this.heldKeys.add(code);

    for (const action of this.actionsFor('keyboard', code)) {
      this.latch(action);
    }
    this.noteActivity('keyboard');
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    const code = MOUSE_BUTTON_CODES[event.button];
    if (code === undefined) return;
    // Mouse buttons are tracked in the same set as keys, so "held" is one concept.
    this.heldKeys.delete(code);
  };

  /**
   * Pointer lock is requested on click, and the request can fail.
   *
   * Newer browsers return a promise from `requestPointerLock`, and an unhandled rejection is a
   * console error — which is an acceptance-criteria violation, not a warning. The rejection has a
   * real cause worth reporting once: the browser refuses a lock too soon after the player escaped
   * one, which is a normal thing for a player to do.
   */
  private readonly onCanvasClick = (): void => {
    if (this.pointerLocked) return;

    try {
      const result = this.canvas.requestPointerLock() as unknown;
      if (result instanceof Promise) {
        result.catch((error: unknown) => this.reportPointerLockFailure(error));
      }
    } catch (error) {
      this.reportPointerLockFailure(error);
    }
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    // Movement while the pointer is free is the player moving the mouse across the page, not
    // aiming. Applying it would make the game unusable before the first click.
    if (!this.pointerLocked) return;

    this.pendingMouseX += event.movementX;
    this.pendingMouseY += event.movementY;

    if (event.movementX !== 0 || event.movementY !== 0) this.noteActivity('keyboard');
  };

  private readonly onPointerLockChange = (): void => {
    const wasLocked = this.pointerLocked;
    this.pointerLocked = document.pointerLockElement !== null;

    // Drop whatever accumulated across the transition. Acquiring a lock involves a large, fast
    // movement toward the canvas, and delivering it would spin the camera on the first frame of
    // every session.
    if (!wasLocked && this.pointerLocked) {
      this.pendingMouseX = 0;
      this.pendingMouseY = 0;
    }
  };

  /**
   * Clear held state when the window loses focus.
   *
   * ─── THE BUG THIS PREVENTS, WHICH IS NOT HYPOTHETICAL ───────────────────────────────
   * A keyup delivered while the window does not have focus is not delivered at all. Alt-tabbing
   * mid-stride therefore leaves the key in the held set *forever*, and the character walks off on
   * its own the moment the player comes back — a genuinely bewildering bug that costs one line to
   * prevent.
   */
  private readonly onBlur = (): void => {
    this.clearTransientState();
  };

  /**
   * Clear input state when the tab is hidden.
   *
   * Handled alongside `blur` because they cover different cases rather than the same one: a tab can
   * be hidden without the window losing focus, and a window can lose focus without the tab being
   * hidden. A browser that fires one and not the other is a real configuration, and both leave the
   * same debris.
   */
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.clearTransientState();
  };

  /** Suppress the context menu on right-click while the pointer is locked — aim, not a menu. */
  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.pointerLocked) event.preventDefault();
  };

  private readonly onGamepadConnected = (event: Event): void => {
    const pad = (event as GamepadEvent).gamepad;
    if (!pad) return;
    this.adoptGamepad(pad);
  };

  /**
   * Clear the pad's state on disconnect.
   *
   * ─── EDGE CASE IE2 ──────────────────────────────────────────────────────────────────
   * The Gamepad API has no events for *state*, only for connection. A pad that vanishes stops
   * reporting anything at all, so a stick that was held at the moment of disconnect would stay
   * latched at its last value forever — and the character would run into a wall until the player
   * pressed a key. Clearing on the event is the first half of the fix; `pollGamepad` detecting a
   * vanished pad is the second, because a disconnect while the tab is backgrounded may not fire
   * the event at all.
   *
   * The second half of "seamless" (R10.3) is that the *last active device* is remembered, so a
   * disconnect while the pad was in charge falls back to keyboard and mouse without requiring the
   * player to press something to hand control back.
   */
  private readonly onGamepadDisconnected = (event: Event): void => {
    const pad = (event as GamepadEvent).gamepad;
    if (pad && this.gamepadIndex !== null && pad.index !== this.gamepadIndex) return;
    this.dropGamepad();
  };

  // ─────────────────────────────────────────────────────────────────────────────────
  // DEVICE POLLING
  // ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Read the gamepad exactly once per tick.
   *
   * Polling rather than reacting is forced by the API: `gamepadconnected` fires when the device
   * appears, but the buttons and axes it exposes are only ever *state*, never events. Polling on
   * `rAF` instead would be a different cadence from the simulation as soon as the frame rate
   * differs from the tick rate (R10.3), and the edge detection would then disagree with everything
   * else in the game about how long a tick is.
   */
  private pollGamepad(): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : null;

    if (!pads) {
      if (this.padConnected) this.dropGamepad();
      return;
    }

    // The array is sparse and contains `null` holes — that is the documented shape, not an
    // anomaly. It is scanned rather than indexed by a remembered position, because the index is
    // not stable across a reconnect.
    let chosen: Gamepad | null = null;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      if (this.gamepadIndex !== null && pad.index === this.gamepadIndex) {
        chosen = pad;
        break;
      }
      if (chosen === null) chosen = pad;
    }

    // A pad that was being read and is no longer present. This is the detection that catches a
    // disconnect the event never reported.
    if (chosen === null) {
      if (this.padConnected) this.dropGamepad();
      return;
    }

    this.adoptGamepad(chosen);
    this.readGamepadState(chosen);
  }

  /** Accept a pad if it reports the standard layout, and remember it. */
  private adoptGamepad(pad: Gamepad): void {
    if (pad.mapping !== 'standard') {
      // Declining is honest; guessing is not. A non-standard layout would need a lookup table per
      // device, and a wrong guess produces binds that appear broken with no explanation.
      if (!this.padMappingWarned) {
        this.padMappingWarned = true;
        console.info(
          `[JungleRelic] Ignoring gamepad "${pad.id}": mapping is "${pad.mapping}", not "standard".`,
        );
      }
      return;
    }

    this.gamepadIndex = pad.index;
    this.padConnected = true;
  }

  /** Clear every trace of the pad's state. */
  private dropGamepad(): void {
    this.gamepadIndex = null;
    this.padConnected = false;
    this.padMove.x = 0;
    this.padMove.y = 0;
    this.padLook.x = 0;
    this.padLook.y = 0;
    this.padButtons.length = 0;
    this.padTriggers.length = 0;
  }

  /** Copy the pad's raw state into this tick's buffers, shaped but not yet interpreted. */
  private readGamepadState(pad: Gamepad): void {
    const left = applyRadialDeadzone(
      pad.axes[0] ?? 0,
      pad.axes[1] ?? 0,
      GAMEPAD_MOVE_DEADZONE,
    );
    const right = applyRadialDeadzone(
      pad.axes[2] ?? 0,
      pad.axes[3] ?? 0,
      GAMEPAD_LOOK_DEADZONE,
    );

    this.padMove.x = left.x;
    // The stick's Y is inverted: pushing up reports -1, and forward must be positive. Getting this
    // wrong produces a character that walks backwards when the stick is pushed forward and
    // *correctly* when it is pushed back, which is confusing enough that it is worth its own line.
    this.padMove.y = -left.y;
    this.padLook.x = right.x;
    this.padLook.y = -right.y;

    const buttonCount = pad.buttons.length;
    this.padButtons.length = buttonCount;
    this.padTriggers.length = buttonCount;

    for (let i = 0; i < buttonCount; i++) {
      const button = pad.buttons[i];
      // Triggers report an analogue value; other buttons report a boolean. `pressed` for a trigger
      // is only true near the end of its travel, so it cannot be used for "aim held" — the value
      // has to be shaped by `normalizeTrigger` instead.
      const isTrigger = i === 6 || i === 7;
      this.padTriggers[i] = isTrigger ? normalizeTrigger(button.value, GAMEPAD_TRIGGER_REST) : 0;
      this.padButtons[i] = isTrigger
        ? this.padTriggers[i] > 0
        : button.pressed || button.value > 0.5;
    }
  }

  /** True when a bound control on the pad is currently active. */
  private padActionActive(action: InputAction): boolean {
    for (const binding of this.bindings[action]) {
      if (binding.device !== 'gamepad') continue;
      const index = Number.parseInt(binding.code, 10);
      if (this.padButtons[index]) return true;
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // LATCHES
  // ─────────────────────────────────────────────────────────────────────────────────

  /** The actions a keyboard or mouse control is bound to. */
  private actionsFor(device: 'keyboard' | 'gamepad', code: string): InputAction[] {
    const matches: InputAction[] = [];
    for (const action of ALL_ACTIONS) {
      for (const binding of this.bindings[action]) {
        if (binding.device === device && binding.code === code) {
          matches.push(action);
          break;
        }
      }
    }
    return matches;
  }

  /**
   * Arm an action's latch, replacing any existing one.
   *
   * Replacing rather than extending: a second press must not stack onto the first, or a player
   * mashing a key would build up a queue of jumps that fire after they stop.
   */
  private latch(action: InputAction): void {
    if (!EDGE_TRIGGERED_ACTIONS.has(action)) return;

    this.latches.set(action, { ticksRemaining: bufferTicksFor(action) });
    // Recorded for the latency budget. The *first* event is what matters, so this does not
    // overwrite a newer timestamp with an older one when several arrive in the same tick.
    if (this.lastEventTimeMs === null) {
      this.lastEventTimeMs = now();
      this.lastEventAction = action;
    }
  }

  /** Decrement every latch, dropping the expired ones. */
  private expireLatches(): void {
    for (const [action, latch] of this.latches) {
      latch.ticksRemaining -= 1;
      if (latch.ticksRemaining < 0) this.latches.delete(action);
    }
  }

  /** True when the action has an open latch. */
  private isLatched(action: InputAction): boolean {
    return this.latches.has(action);
  }

  /** Take an action's latch, consuming it so it cannot fire twice. */
  private consume(action: InputAction): boolean {
    return this.latches.delete(action);
  }

  /**
   * Adopt this tick's gamepad pressed-edges into latches.
   *
   * Keyboard edges are latched in the handler, because a keypress is an event and cannot be
   * recovered later. Gamepad edges do not exist as events, so they are derived here by comparing
   * this tick's button state against the previous one — which is R10.3's "edge detection derived
   * from previous-tick state".
   */
  private adoptEdges(): void {
    if (!this.padConnected) return;

    for (const action of ALL_ACTIONS) {
      const active = this.padActionActive(action);
      const wasActive = this.padPrevious.get(action) ?? false;
      if (active && !wasActive) {
        this.latch(action);
        this.noteActivity('gamepad');
      }
      this.padPrevious.set(action, active);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // SNAPSHOT
  // ─────────────────────────────────────────────────────────────────────────────────

  /** Build the tick's snapshot, consuming the latches that are being delivered. */
  private buildSnapshot(cameraYaw: number, adopt: boolean): InputSnapshot {
    const keyboardMove = this.keyboardMoveAxis();
    const padMove = { x: this.padMove.x, y: this.padMove.y };

    // The larger magnitude wins, so a half-pushed stick cannot add to a held key and produce a
    // magnitude the controller would have to clamp.
    // Used for its *direction* only: `resolveSpeed` below owns the magnitude, because the two
    // devices reach it differently (the pad's deflection versus the keyboard's walk/run modifier).
    const movement = resolveMovement(keyboardMove, padMove);
    const world: WorldDirection = stickToWorldDirection(movement.direction, cameraYaw);

    const jumpRequested = adopt ? this.consume(InputAction.Jump) : false;
    const interactRequested = adopt ? this.consume(InputAction.Interact) : false;
    const attackBuffered = this.isLatched(InputAction.Attack);

    if (adopt && jumpRequested && this.lastEventTimeMs !== null) this.measureLatency();

    return {
      intent: {
        moveDirection: { x: world.x, z: world.z },
        moveMagnitude: this.resolveSpeed(keyboardMove, padMove, this.isKeyboardMoving()),
        jumpHeld: this.isActionHeld(InputAction.Jump),
        // Deliberately the *consumed* latch, not the held state: a held jump must not re-request
        // (edge case IE1). The controller's own buffer covers a request that arrived too early.
        jumpRequested,
        crouchHeld: this.isActionHeld(InputAction.Crouch),
        interactRequested,
      },
      look: this.buildLookDelta(),
      aiming: this.isActionHeld(InputAction.Aim),
      inventoryPressed: adopt ? this.consume(InputAction.Inventory) : false,
      pausePressed: adopt ? this.consume(InputAction.Pause) : false,
      attackBuffered,
      activeDevice: this.activeDevice,
      gamepadConnected: this.padConnected,
    };
  }

  /**
   * The keyboard's movement axis, normalised so diagonals are not faster.
   *
   * The stick is normalised by `resolveMovement` and the deadzone; this must match, or keyboard
   * diagonal movement would be 41% faster than a straight line — the classic bug that a
   * combination of raw axis values produces.
   */
  private keyboardMoveAxis(): Analog2D {
    let x = 0;
    let y = 0;

    if (this.isActionHeld(InputAction.MoveForward)) y += 1;
    if (this.isActionHeld(InputAction.MoveBack)) y -= 1;
    if (this.isActionHeld(InputAction.MoveRight)) x += 1;
    if (this.isActionHeld(InputAction.MoveLeft)) x -= 1;

    const magnitude = Math.hypot(x, y);
    if (magnitude <= 1e-6) return { x: 0, y: 0 };

    return { x: x / magnitude, y: y / magnitude };
  }

  /**
   * Convert a movement direction into the controller's documented [0, 1] magnitude.
   *
   * ─── TWO DEVICES, TWO DIFFERENT SPEED MODELS ────────────────────────────────────────
   * The keyboard is binary: a key is down or it is not, so its speed comes from the run modifier —
   * 2 m/s walking or 6 m/s running, the GDD's numbers. A stick is analogue, so *deflection is the
   * speed*: pushing it halfway walks, pushing it fully runs, and the run modifier has nothing to
   * do with it. That is what analogue movement is for, and snapping a stick to walk-or-run would
   * throw away the only thing it offers.
   *
   * The winner is decided by magnitude, matching `resolveMovement`, so the two devices cannot
   * fight and the magnitude can never exceed the 1 the controller documents. This is why gamepad
   * button 7 (right trigger) is deliberately NOT bound to Run: on a pad, "how fast" is a
   * continuous question with a continuous answer, and a run button would be a second, contradictory
   * control over the same thing.
   */
  private resolveSpeed(
    keyboardAxis: Analog2D,
    padAxis: Analog2D,
    keyboardMoving: boolean,
  ): number {
    const padMagnitude = Math.hypot(padAxis.x, padAxis.y);
    const padWins = padMagnitude > Math.hypot(keyboardAxis.x, keyboardAxis.y);

    if (padWins) return Math.min(1, padMagnitude);
    if (!keyboardMoving) return 0;

    return this.isActionHeld(InputAction.Run) ? 1 : WALK_MAGNITUDE;
  }

  /** Is the player moving via the keyboard? */
  private isKeyboardMoving(): boolean {
    for (const action of [
      InputAction.MoveForward,
      InputAction.MoveBack,
      InputAction.MoveLeft,
      InputAction.MoveRight,
    ]) {
      if (this.isActionHeld(action)) return true;
    }
    return false;
  }

  /** True while any control bound to the action is active on either device. */
  private isActionHeld(action: InputAction): boolean {
    for (const binding of this.bindings[action]) {
      if (binding.device === 'keyboard') {
        if (this.heldKeys.has(binding.code)) return true;
      } else if (this.padButtons[Number.parseInt(binding.code, 10)]) {
        return true;
      }
    }
    return false;
  }

  /**
   * This tick's camera rotation.
   *
   * ─── RAW, UNSMOOTHED, CONSUMED ONCE ─────────────────────────────────────────────────
   * R10.2's commitment: deltas accumulate in the handler and are scaled once per tick, with no
   * smoothing and no acceleration, because "player-imposed smoothing must be a choice, not a
   * liberty taken on the player's behalf". The accumulator is zeroed here so movement can never be
   * applied twice — the bug where a fast flick rotates the camera double and then appears to
   * stutter.
   */
  private buildLookDelta(): LookDelta {
    let yawDelta = 0;
    let pitchDelta = 0;

    if (this.pointerLocked) {
      yawDelta = this.pendingMouseX * INPUT_LOOK_SENSITIVITY;
      pitchDelta = -this.pendingMouseY * INPUT_LOOK_SENSITIVITY;
    }

    // The stick's look rate is per second, not per tick, and is scaled by the same sensitivity so
    // the two devices feel like the same speed.
    if (this.padConnected) {
      yawDelta += this.padLook.x * INPUT_LOOK_SENSITIVITY * STICK_LOOK_RATE;
      pitchDelta += this.padLook.y * INPUT_LOOK_SENSITIVITY * STICK_LOOK_RATE;
    }

    this.pendingMouseX = 0;
    this.pendingMouseY = 0;

    return { yawDelta, pitchDelta };
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // LATENCY (R6 / R10.4)
  // ─────────────────────────────────────────────────────────────────────────────────

  /** Record how long the press that was just consumed spent waiting to be acted on. */
  private measureLatency(): void {
    if (this.lastEventTimeMs === null || this.lastEventAction === null) return;

    this.latency = {
      eventToTickMs: now() - this.lastEventTimeMs,
      action: this.lastEventAction,
    };
    this.lastEventTimeMs = null;
    this.lastEventAction = null;
  }

  /** Note that a device produced input, so disconnect fallback knows who was in charge. */
  private noteActivity(device: 'keyboard' | 'gamepad'): void {
    this.activeDevice = device;
  }

  /** Report a pointer-lock failure once. */
  private reportPointerLockFailure(error: unknown): void {
    if (this.pointerLockWarned) return;
    this.pointerLockWarned = true;
    const name = error instanceof Error ? error.name : 'unknown';
    console.info(
      `[JungleRelic] Pointer lock unavailable (${name}); the game is still playable with the camera fixed.`,
    );
  }

  /** Drop everything transient. Held keys survive a device change but not a focus loss. */
  private clearTransientState(): void {
    this.heldKeys.clear();
    this.latches.clear();
    this.padPrevious.clear();
    this.pendingMouseX = 0;
    this.pendingMouseY = 0;
    this.lastEventTimeMs = null;
    this.lastEventAction = null;
  }

  /** Adopt a new binding table and persist it. */
  private adoptBindings(table: BindingTable): void {
    this.bindings = table;
    saveBindings(this.storage, table);
  }
}

/**
 * The actions that are edge-triggered, and therefore latched.
 *
 * Movement, run, crouch and aim are *level* inputs: the game asks "is the player pushing forward"
 * every tick, and a latch would add nothing. Latching them would also mean a Map entry per
 * movement keypress per press, which is work done to no effect. Naming the edge-triggered set
 * makes the distinction visible rather than leaving a reader to infer it from the buffer table.
 */
const EDGE_TRIGGERED_ACTIONS: ReadonlySet<InputAction> = new Set([
  InputAction.Jump,
  InputAction.Interact,
  InputAction.Attack,
  InputAction.Inventory,
  InputAction.Pause,
]);

/** How many ticks a press may wait to be delivered, per action. */
function bufferTicksFor(action: InputAction): number {
  switch (action) {
    case InputAction.Jump:
      return JUMP_BUFFER_TICKS;
    case InputAction.Interact:
      return INTERACT_BUFFER_TICKS;
    case InputAction.Attack:
      return ATTACK_BUFFER_TICKS;
    default:
      // Everything else is delivered immediately or not at all. Buffering "crouch" would mean a
      // tap crouches a fifth of a second later, which is a worse experience than ignoring it.
      return 1;
  }
}

/** Mouse button numbers to the code names used in the binding table. */
const MOUSE_BUTTON_CODES: Record<number, string> = {
  0: 'MouseLeft',
  1: 'MouseMiddle',
  2: 'MouseRight',
};

/** Scale applied to keyboard movement when run is not held: the GDD's 2 m/s of 6 m/s. */
const WALK_MAGNITUDE = 2 / 6;

/** Radians per second a fully-deflected look stick turns, before sensitivity scaling. */
const STICK_LOOK_RATE = 60;

/** The current time in milliseconds. Isolated so the module has one clock dependency. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
