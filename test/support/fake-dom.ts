/**
 * A small hand-rolled fake of the browser surface `InputSystem` touches.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY NOT `jsdom`
 * ────────────────────────────────────────────────────────────────────────────────
 * Every edge case this milestone has to prove is about **when an event arrives relative to a
 * tick** — a press that begins and ends inside one tick, a press captured during a frame hitch, a
 * pad that vanishes between polls. Those are statements about ordering, and a synthetic target
 * lets a test say exactly "fire this event, then tick twice" with no timers involved.
 *
 * A real DOM runs on real timers, would make these tests slower and *less* precise, and would add
 * a dependency to assert something the fake proves more directly. The fake is deliberately tiny:
 * it implements `addEventListener`, `removeEventListener` and `dispatchEvent`, and nothing else.
 *
 * The one thing it does not reproduce is the browser's own event semantics — bubbling, capture,
 * passive listeners. Those are irrelevant here: the system listens on one target and never
 * inspects an event's propagation, which is itself a property worth having.
 */

/** A listener as the fake stores it. */
type Listener = (event: unknown) => void;

/**
 * A fake `EventTarget` plus the handful of globals `InputSystem` reads.
 *
 * The globals are *set* rather than stubbed globally so tests can construct several independent
 * environments and cannot leak state into one another — a global `document` shared between tests
 * is how an input suite becomes order-dependent.
 */
export class FakeDom {
  /** Registered listeners, by event type. */
  private readonly listeners = new Map<string, Set<Listener>>();

  /** Whether the fake pointer is currently locked. */
  public pointerLocked = false;

  /** When set, `requestPointerLock` rejects with this instead of locking. */
  public pointerLockError: Error | null = null;

  /** Every call to `preventDefault`, so tests can assert on suppression. */
  public readonly preventedDefaults: string[] = [];

  /** The globals as they were before this environment was installed. */
  private restore: Array<() => void> = [];

  /**
   * Install the fake globals and return the target and canvas to hand to `InputSystem`.
   *
   * ─── HOW `navigator` IS REPLACED, AND WHY IT IS NOT A PLAIN ASSIGNMENT ──────────────
   * On modern Node, `globalThis.navigator` is an accessor with a getter and no setter, so a plain
   * assignment throws in strict mode. The first version of this fake wrapped that assignment in a
   * `try`/`catch` and carried on — which was worse than useless: the tests then silently ran
   * against the *real* navigator, whose `getGamepads` is undefined, so eleven gamepad assertions
   * passed a system that had never seen a gamepad. They were measuring nothing.
   *
   * `Object.defineProperty` replaces an accessor outright, so the substitution actually happens.
   * The lesson is in the swallowed error: a `try`/`catch` around environment setup converts "the
   * environment is wrong" into "the tests pass", which is the most expensive kind of green there is.
   *
   * @returns The window-like target and the canvas-like element.
   */
  public install(): { target: Window; canvas: HTMLElement } {
    const target = this.makeTarget();
    const canvas = this.makeCanvas();

    const fakeDocument = {
      pointerLockElement: null as unknown,
      visibilityState: 'visible' as string,
      addEventListener: (type: string, listener: Listener) => this.add(type, listener),
      removeEventListener: (type: string, listener: Listener) => this.remove(type, listener),
      dispatchEvent: (event: { type: string }) => this.dispatch(event),
    };

    this.defineGlobal('document', fakeDocument);
    this.defineGlobal('navigator', this.makeNavigator());

    this.fakeDocument = fakeDocument;
    return { target, canvas };
  }

  /**
   * Replace a global, refusing to continue when that is impossible.
   *
   * @param name - The global to replace.
   * @param value - What to put there.
   * @throws When the property cannot be redefined. Loudly, because the alternative is a suite of
   *   tests that pass without exercising anything.
   */
  private defineGlobal(name: string, value: unknown): void {
    const g = globalThis as unknown as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    const hadValue = descriptor !== undefined;

    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
    });

    this.restore.push(() => {
      if (hadValue && descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete g[name];
    });
  }

  /** The fake document, available after `install` for driving visibility and lock changes. */
  public fakeDocument: { visibilityState: string; pointerLockElement: unknown } | null = null;

  /** Remove every installed global. */
  public uninstall(): void {
    for (const undo of this.restore.reverse()) undo();
    this.restore = [];
    this.listeners.clear();
  }

  /**
   * Fire an event at the target.
   *
   * @param type - The event type, e.g. `keydown`.
   * @param properties - Properties to place on the event object.
   */
  public fire(type: string, properties: Record<string, unknown> = {}): void {
    this.dispatch({ type, ...properties });
  }

  /**
   * Fire a keydown, with the fields the system reads.
   *
   * @param code - The `KeyboardEvent.code` value.
   * @param repeat - Whether this is an OS auto-repeat.
   */
  public keyDown(code: string, repeat = false): void {
    this.fire('keydown', {
      code,
      repeat,
      preventDefault: () => this.preventedDefaults.push(code),
    });
  }

  /** Fire a keyup. */
  public keyUp(code: string): void {
    this.fire('keyup', { code });
  }

  /** Fire a mouse button press. */
  public mouseDown(button: number): void {
    this.fire('mousedown', { button });
  }

  /** Fire a mouse button release. */
  public mouseUp(button: number): void {
    this.fire('mouseup', { button });
  }

  /** Fire a mouse movement, in raw device pixels. */
  public mouseMove(movementX: number, movementY: number): void {
    this.fire('mousemove', { movementX, movementY });
  }

  /**
   * Acquire the pointer lock, as the browser does after a successful request.
   *
   * Fires `pointerlockchange`, because that is the only way the system learns about the lock — it
   * never infers it from the click.
   */
  public lockPointer(): void {
    this.pointerLocked = true;
    if (this.fakeDocument) this.fakeDocument.pointerLockElement = {};
    this.fire('pointerlockchange', {});
  }

  /** Release the pointer lock, as Escape does. */
  public unlockPointer(): void {
    this.pointerLocked = false;
    if (this.fakeDocument) this.fakeDocument.pointerLockElement = null;
    this.fire('pointerlockchange', {});
  }

  /** Change the tab's visibility and notify. */
  public setVisible(visible: boolean): void {
    if (this.fakeDocument) this.fakeDocument.visibilityState = visible ? 'visible' : 'hidden';
    this.fire('visibilitychange', {});
  }

  /** Register a listener on either the target or the document, whichever handles this type. */
  private add(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  private remove(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(event: { type: string }): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    // Copied before iterating: a listener that unregisters itself (which `dispose` does) would
    // otherwise mutate the set mid-iteration.
    for (const listener of [...set]) listener(event);
  }

  /** The window-like object handed to `InputSystem`. */
  private makeTarget(): Window {
    return {
      addEventListener: (type: string, listener: Listener) => this.add(type, listener),
      removeEventListener: (type: string, listener: Listener) => this.remove(type, listener),
    } as unknown as Window;
  }

  /** The canvas-like object pointer lock is requested on. */
  private makeCanvas(): HTMLElement {
    return {
      addEventListener: (type: string, listener: Listener) => this.add(type, listener),
      removeEventListener: (type: string, listener: Listener) => this.remove(type, listener),
      requestPointerLock: () => {
        if (this.pointerLockError) {
          return Promise.reject(this.pointerLockError);
        }
        this.lockPointer();
        return Promise.resolve();
      },
    } as unknown as HTMLElement;
  }

  /** A navigator whose `getGamepads` returns whatever the test has queued. */
  private makeNavigator(): { getGamepads: () => Array<Gamepad | null> } {
    const dom = this;
    return {
      getGamepads: () => dom.gamepads.slice(),
    };
  }

  /** The pads `getGamepads` should report. Tests mutate this between ticks. */
  public gamepads: Array<Gamepad | null> = [];
}

/**
 * A fake `standard`-mapping gamepad.
 *
 * Built fresh per test so a test cannot accidentally share pad state with another, which is the
 * kind of thing that makes an input suite pass in isolation and fail in a full run.
 */
export function fakeGamepad(
  options: {
    index?: number;
    connected?: boolean;
    mapping?: string;
    buttons?: number;
    axes?: [number, number, number, number];
    pressed?: number[];
    triggerValues?: Record<number, number>;
  } = {},
): Gamepad {
  const {
    index = 0,
    connected = true,
    mapping = 'standard',
    buttons = 17,
    axes = [0, 0, 0, 0],
    pressed = [],
    triggerValues = {},
  } = options;

  const buttonList = Array.from({ length: buttons }, (_, i) => ({
    pressed: pressed.includes(i),
    touched: pressed.includes(i),
    value: triggerValues[i] ?? (pressed.includes(i) ? 1 : 0),
  }));

  return {
    id: 'Fake Pad',
    index,
    connected,
    mapping,
    timestamp: 0,
    axes: [...axes],
    buttons: buttonList,
    vibrationActuator: null,
    hapticActuators: [],
  } as unknown as Gamepad;
}
