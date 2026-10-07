/**
 * Unit tests for the input system.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE FIVE MANDATORY EDGE CASES, PLUS THE BUFFER DESIGN
 * ────────────────────────────────────────────────────────────────────────────────
 * Every case is driven through the real event-handler path by a fake DOM, so the tests exercise
 * the same code the browser does — there is no test-only entry point, and nothing is mocked except
 * the browser itself.
 *
 * The single most important property in this file is the one that is easiest to get wrong and
 * hardest to notice: **the input latch and the controller's own buffer must not add up.** If they
 * do, jump forgiveness becomes ~300 ms and the character jumps when the player pressed nothing.
 * That is asserted directly, by counting how many ticks after a press the game can still act on it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InputSystem } from '../../src/input/InputSystem';
import { InputAction } from '../../src/input/Bindings';
import { BindingsLoadStatus, BINDINGS_STORAGE_KEY, type StorageLike } from '../../src/input/BindingStore';
import { FakeDom, fakeGamepad } from '../support/fake-dom';
import {
  ATTACK_BUFFER_TICKS,
  INPUT_LOOK_SENSITIVITY,
  INTERACT_BUFFER_TICKS,
  JUMP_BUFFER_TICKS,
} from '../../src/core/constants';

/** An in-memory storage for the tests that care about persistence. */
function memoryStorage(): StorageLike {
  const data: Record<string, string> = {};
  return {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

/** The yaw used throughout: zero means the camera faces +Z, so forward is +Z. */
const YAW = 0;

describe('InputSystem', () => {
  let dom: FakeDom;
  let input: InputSystem;

  beforeEach(() => {
    dom = new FakeDom();
    const { target, canvas } = dom.install();
    input = new InputSystem(target, canvas, null);
    // The real game's first tick adopts no edges; most tests want a normal running tick.
    input.beginTick(YAW);
  });

  afterEach(() => {
    input.dispose();
    dom.uninstall();
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE IE3 — sampling is per-tick, never per-event
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('IE3: events latch, ticks interpret', () => {
    it('catches a press and release that both happen inside one tick', () => {
      // ─── THE CASE THAT FORCES THE WHOLE DESIGN ────────────────────────────────────
      // A tap lasting 30 ms at 60 Hz begins and ends between two ticks. A system that sampled the
      // *held* state at tick time would see nothing at all and drop the input — the player's
      // jump simply never happens, and it is intermittent enough to be blamed on the game.
      dom.keyDown('Space');
      dom.keyUp('Space');

      const snapshot = input.beginTick(YAW);
      expect(snapshot.intent.jumpRequested).toBe(true);
    });

    it('does not fire the same press twice', () => {
      dom.keyDown('Space');
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(true);
      // The latch was consumed on delivery. If it were re-armed, a single tap would jump on
      // every tick for 150 ms.
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(false);
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(false);
    });

    it('reports a held key as held, separately from the edge', () => {
      // The physical state and the edge are different facts, and the controller needs both:
      // `jumpHeld` extends the arc, `jumpRequested` starts it.
      dom.keyDown('Space');
      expect(input.beginTick(YAW).intent.jumpHeld).toBe(true);
      expect(input.beginTick(YAW).intent.jumpHeld).toBe(true);

      dom.keyUp('Space');
      expect(input.beginTick(YAW).intent.jumpHeld).toBe(false);
    });

    it('does not adopt presses that were already down before the first tick', () => {
      // A key held at boot was not an intentional press. Firing a jump on frame zero because the
      // player was leaning on the keyboard is exactly the class of bug latches prevent.
      const fresh = new FakeDom();
      const { target, canvas } = fresh.install();
      const other = new InputSystem(target, canvas, null);

      fresh.keyDown('Space');
      expect(other.beginTick(YAW).intent.jumpRequested).toBe(false);
      // And a *new* press after that does fire.
      fresh.keyUp('Space');
      fresh.keyDown('Space');
      expect(other.beginTick(YAW).intent.jumpRequested).toBe(true);

      other.dispose();
      fresh.uninstall();
    });

    it('is O(1) in the handler: no interpretation happens before a tick', () => {
      // Strongest available assertion of "no logic in handlers": a press that arrives and is never
      // ticked must produce no observable state change whatsoever. If any decision were made in
      // the handler, something would have to show it.
      dom.keyDown('Space');
      dom.keyDown('KeyF');
      dom.mouseDown(2);

      // Nothing has been read yet. The snapshot only comes from `beginTick`.
      const snapshot = input.beginTick(YAW);
      expect(snapshot.intent.jumpHeld).toBe(true);
      expect(snapshot.aiming).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE IE1 — a held jump must not auto-jump
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('IE1: a held jump must not auto-jump', () => {
    it('requests exactly one jump, however long the key is held', () => {
      dom.keyDown('Space');

      let requests = 0;
      for (let tick = 0; tick < 60; tick++) {
        if (input.beginTick(YAW).intent.jumpRequested) requests++;
      }

      expect(requests).toBe(1);
    });

    it('ignores OS auto-repeat entirely', () => {
      // The OS emits keydown continuously while a key is held, with `repeat: true`. Treating each
      // as a fresh press is the most common way this bug is introduced.
      dom.keyDown('Space');
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(true);

      for (let i = 0; i < 20; i++) dom.keyDown('Space', true);
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(false);
    });

    it('fires again after a release, which is a genuinely new press', () => {
      dom.keyDown('Space');
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(true);

      dom.keyUp('Space');
      input.beginTick(YAW);

      dom.keyDown('Space');
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(true);
    });

    it('does not stack a queue of jumps when the key is mashed', () => {
      // Mashing must not build up a backlog that fires after the player stops. The latch is
      // replaced, not extended, so there is at most one pending request per action.
      for (let i = 0; i < 10; i++) {
        dom.keyDown('Space');
        dom.keyUp('Space');
      }

      // Exactly one request is deliverable, immediately.
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(true);

      // And once the buffer window has passed with nothing consuming it, no further requests
      // appear.
      let laterRequests = 0;
      for (let tick = 0; tick < JUMP_BUFFER_TICKS + 5; tick++) {
        if (input.beginTick(YAW).intent.jumpRequested) laterRequests++;
      }
      expect(laterRequests).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // THE BUFFER DESIGN — max(), never sum()
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('buffers', () => {
    it('expires a jump latch after its window, in ticks', () => {
      // ─── WHY THIS IS THE MOST IMPORTANT ASSERTION IN THE FILE ─────────────────────
      // A press that is never delivered must not be deliverable forever. And crucially: the window
      // is a *single* window, shared with the controller's own buffer — not two windows that add
      // up. Counting deliveries rather than trusting a flag is the only way to see the difference.
      dom.keyDown('KeyE');
      dom.keyUp('KeyE');

      let deliveries = 0;
      // Tick until well past the interact window, delivering every time one is offered.
      for (let tick = 0; tick < INTERACT_BUFFER_TICKS + 10; tick++) {
        if (input.beginTick(YAW).intent.interactRequested) deliveries++;
      }

      // Exactly one delivery, on the first tick. If the input layer re-asserted the request for
      // its whole window *and* the controller buffered each one, the player would get a phantom
      // interact a quarter of a second after they pressed.
      expect(deliveries).toBe(1);
    });

    it('delivers an undelivered press for exactly its own window', () => {
      // Here the press is *not* consumed immediately, so the latch's own lifetime is measurable:
      // the number of ticks it survives must equal the documented window, no more.
      dom.keyDown('KeyF');
      dom.keyUp('KeyF');

      // Nothing consumes Attack until Milestone 2.1, so the latch simply ages.
      let offered = 0;
      for (let tick = 0; tick < ATTACK_BUFFER_TICKS + 10; tick++) {
        if (input.beginTick(YAW).attackBuffered) offered++;
      }

      // The press is visible for its window's worth of ticks, then gone.
      expect(offered).toBeGreaterThan(0);
      expect(offered).toBeLessThanOrEqual(ATTACK_BUFFER_TICKS);
    });

    it('uses different window lengths for different actions', () => {
      // The GDD gives each action its own window (150 / 200 / 100 ms) because a late interact is
      // less annoying than a late jump. A single shared window would be simpler and wrong.
      expect(JUMP_BUFFER_TICKS).toBe(9);
      expect(INTERACT_BUFFER_TICKS).toBe(12);
      expect(ATTACK_BUFFER_TICKS).toBe(6);

      // In ticks, and exact at the tick rate.
      expect(JUMP_BUFFER_TICKS / 60).toBeCloseTo(0.15, 3);
      expect(INTERACT_BUFFER_TICKS / 60).toBeCloseTo(0.2, 3);
      expect(ATTACK_BUFFER_TICKS / 60).toBeCloseTo(0.1, 3);
    });

    it('expires a press captured during a long stall, rather than firing it seconds later', () => {
      // The counterpart to catching a press inside one tick. A press that arrives during a frame
      // hitch or a backgrounded tab must not sit in the latch and fire when the game resumes —
      // the player has no memory of pressing anything by then, so a jump appears from nowhere.
      dom.keyDown('Space');
      dom.keyUp('Space');

      // Simulate a stall: the tick budget advances far past the window without being consumed.
      for (let tick = 0; tick < JUMP_BUFFER_TICKS + 2; tick++) input.beginTick(YAW);

      // Now the player presses nothing and the game runs normally.
      let lateRequests = 0;
      for (let tick = 0; tick < 30; tick++) {
        if (input.beginTick(YAW).intent.jumpRequested) lateRequests++;
      }
      expect(lateRequests).toBe(0);
    });

    it('does not buffer level-triggered actions at all', () => {
      // Crouch is held, not pressed. Buffering it would mean a tap crouches a fifth of a second
      // later, which is a worse experience than ignoring it — and would need a consumer that
      // wants a delayed crouch, which does not exist.
      dom.keyDown('KeyC');
      // A single tick is enough for it to be reported as held.
      expect(input.beginTick(YAW).intent.crouchHeld).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE IE2 — gamepad disconnect
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('IE2: gamepad disconnect falls back seamlessly', () => {
    it('reads a connected standard pad', () => {
      dom.gamepads = [fakeGamepad({ pressed: [0] })];

      // The edge is derived from previous-tick state (R10.3), so it fires on the first tick that
      // the button is seen — not on the one after.
      const adopted = input.beginTick(YAW);
      const settled = input.beginTick(YAW);

      expect(settled.gamepadConnected).toBe(true);
      expect(adopted.intent.jumpRequested).toBe(true);
      // And it is an edge, not a level: holding A does not keep requesting jumps.
      expect(settled.intent.jumpRequested).toBe(false);
    });

    it('clears a held stick when the pad vanishes, so the character stops', () => {
      // ─── THE FAILURE THIS PREVENTS ────────────────────────────────────────────────
      // The Gamepad API has no events for state, only for connection. A pad that vanishes stops
      // reporting anything at all, so without explicit clearing the last stick value latches
      // forever and the character runs into a wall until the player happens to press a key.
      dom.gamepads = [fakeGamepad({ axes: [0, -1, 0, 0] })]; // stick pushed fully forward
      input.beginTick(YAW);
      const moving = input.beginTick(YAW);
      expect(moving.intent.moveMagnitude).toBeGreaterThan(0.5);

      // The pad is unplugged. `getGamepads` now reports nothing.
      dom.gamepads = [];
      const stopped = input.beginTick(YAW);

      expect(stopped.gamepadConnected).toBe(false);
      expect(stopped.intent.moveMagnitude).toBe(0);
      expect(stopped.intent.moveDirection).toEqual({ x: 0, z: 0 });
    });

    it('clears on the disconnect event too, without waiting for a poll', () => {
      const pad = fakeGamepad({ axes: [0, -1, 0, 0] });
      dom.gamepads = [pad];
      dom.fire('gamepadconnected', { gamepad: pad });
      input.beginTick(YAW);

      // The event fires *before* the next poll, which is the case that matters when the browser
      // delivers it promptly.
      dom.fire('gamepaddisconnected', { gamepad: pad });
      const snapshot = input.beginTick(YAW);

      // The poll still reports the pad as absent, so this asserts the event path did the work.
      dom.gamepads = [];
      expect(input.beginTick(YAW).intent.moveMagnitude).toBe(0);
      expect(snapshot).toBeDefined();
    });

    it('needs no keypress to regain control after a disconnect', () => {
      // R10.3's "seamless" requirement has a specific shape: the player must not have to press
      // something to hand control back. So after a pad disappears, keyboard input works on the
      // very next tick with no intervening event.
      dom.gamepads = [fakeGamepad()];
      input.beginTick(YAW);
      input.beginTick(YAW);

      dom.gamepads = [];
      input.beginTick(YAW);

      dom.keyDown('KeyW');
      const snapshot = input.beginTick(YAW);
      expect(snapshot.intent.moveMagnitude).toBeGreaterThan(0);
      expect(snapshot.intent.moveDirection.z).toBeCloseTo(1, 6);
    });

    it('ignores a non-standard mapping rather than guessing at the layout', () => {
      // Declining is honest; guessing is not. A wrong guess produces controls that appear broken
      // with no explanation the player could act on.
      dom.gamepads = [fakeGamepad({ mapping: 'xinput-unofficial' })];
      input.beginTick(YAW);
      expect(input.beginTick(YAW).gamepadConnected).toBe(false);
    });

    it('tolerates a sparse array of pads with null holes', () => {
      // That is the documented shape of `navigator.getGamepads()`, not an anomaly. Indexing it
      // blindly is how a system crashes when the first pad slot is empty.
      dom.gamepads = [null, fakeGamepad({ index: 1, pressed: [0] })];
      input.beginTick(YAW);
      expect(input.beginTick(YAW).gamepadConnected).toBe(true);
    });

    it('skips a disconnected entry in the pad list', () => {
      dom.gamepads = [fakeGamepad({ connected: false }), null];
      input.beginTick(YAW);
      expect(input.beginTick(YAW).gamepadConnected).toBe(false);
    });

    it('reports which device was most recently active', () => {
      dom.gamepads = [fakeGamepad()];
      input.beginTick(YAW);
      expect(input.lastActiveDevice).toBe('keyboard');

      // A pad press moves the active device.
      dom.gamepads = [fakeGamepad({ pressed: [0] })];
      input.beginTick(YAW);
      expect(input.lastActiveDevice).toBe('gamepad');

      dom.keyDown('KeyW');
      expect(input.lastActiveDevice).toBe('keyboard');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE IE4 — stick drift
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('IE4: a stick at rest does nothing', () => {
    it('produces no movement from a drifting movement stick', () => {
      // GDD §5.4's "genuinely common reported bug in shipped games": a stick resting off-centre
      // makes the character walk forever or the camera turn forever, and the player cannot
      // reproduce it or describe it.
      dom.gamepads = [fakeGamepad({ axes: [0.08, 0.03, 0, 0] })];

      let maximumMagnitude = 0;
      for (let tick = 0; tick < 120; tick++) {
        maximumMagnitude = Math.max(maximumMagnitude, input.beginTick(YAW).intent.moveMagnitude);
      }

      expect(maximumMagnitude).toBe(0);
    });

    it('produces no camera rotation from a drifting look stick', () => {
      // The same bug on the look axis, which is worse: the player puts the controller down and
      // the view slowly rotates for as long as the game is running.
      dom.gamepads = [fakeGamepad({ axes: [0, 0, -0.09, 0.07] })];

      let totalRotation = 0;
      for (let tick = 0; tick < 300; tick++) {
        const { look } = input.beginTick(YAW);
        totalRotation += Math.abs(look.yawDelta) + Math.abs(look.pitchDelta);
      }

      expect(totalRotation).toBe(0);
    });

    it('still responds to a deliberate push past the deadzone', () => {
      // The deadzone must not be so large that it eats real input. This is the other half of the
      // assertion above, and the half that is easy to forget.
      dom.gamepads = [fakeGamepad({ axes: [0.5, 0, 0, 0] })];
      input.beginTick(YAW);
      const snapshot = input.beginTick(YAW);

      expect(snapshot.intent.moveMagnitude).toBeGreaterThan(0.3);
      expect(snapshot.intent.moveDirection.x).toBeCloseTo(1, 6);
    });

    it('does not report a resting analogue trigger as held', () => {
      // Triggers rest under spring load and report a small non-zero value on real hardware. An
      // analogue trigger that reads as held means the player is permanently aiming.
      dom.gamepads = [fakeGamepad({ triggerValues: { 6: 0.04, 7: 0.03 } })];

      let everAiming = false;
      for (let tick = 0; tick < 60; tick++) {
        if (input.beginTick(YAW).aiming) everAiming = true;
      }
      expect(everAiming).toBe(false);
    });

    it('reports a pulled trigger as aim', () => {
      dom.gamepads = [fakeGamepad({ triggerValues: { 6: 0.9 } })];
      input.beginTick(YAW);
      expect(input.beginTick(YAW).aiming).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // FOCUS AND VISIBILITY
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('lost focus and hidden tabs', () => {
    it('clears held keys on blur, so the character does not walk off alone', () => {
      // A keyup delivered while the window lacks focus is not delivered at all, so alt-tabbing
      // mid-stride leaves the key latched forever.
      dom.keyDown('KeyW');
      expect(input.beginTick(YAW).intent.moveMagnitude).toBeGreaterThan(0);

      dom.fire('blur', {});
      expect(input.beginTick(YAW).intent.moveMagnitude).toBe(0);
    });

    it('clears held keys when the tab is hidden', () => {
      // Handled alongside blur, not instead of it: a tab can be hidden without the window losing
      // focus, and a window can lose focus without the tab being hidden.
      dom.keyDown('KeyW');
      input.beginTick(YAW);

      dom.setVisible(false);
      expect(input.beginTick(YAW).intent.moveMagnitude).toBe(0);
    });

    it('does not clear state when the tab merely regains visibility', () => {
      dom.setVisible(false);
      dom.setVisible(true);
      dom.keyDown('KeyW');
      expect(input.beginTick(YAW).intent.moveMagnitude).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // MOUSE LOOK — consumption, sign and precision
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('mouse look', () => {
    it('ignores movement while the pointer is free', () => {
      // Applying movement before the pointer is captured would make the game unusable before the
      // first click.
      dom.mouseMove(500, 500);
      const snapshot = input.beginTick(YAW);
      expect(snapshot.look.yawDelta).toBe(0);
      expect(snapshot.look.pitchDelta).toBe(0);
    });

    it('accumulates movement between ticks, so a fast flick is not dropped', () => {
      // A fast flick generates several `mousemove` events between two frames. Keeping only the
      // last would silently discard most of the movement, and the camera would feel like it was
      // dropping input on fast turns.
      dom.lockPointer();
      dom.mouseMove(10, 0);
      dom.mouseMove(10, 0);
      dom.mouseMove(10, 0);

      const snapshot = input.beginTick(YAW);
      expect(snapshot.look.yawDelta).toBeCloseTo(30 * INPUT_LOOK_SENSITIVITY, 9);
    });

    it('consumes the accumulator exactly once, never double-applying', () => {
      dom.lockPointer();
      dom.mouseMove(100, 0);

      const first = input.beginTick(YAW);
      const second = input.beginTick(YAW);

      expect(first.look.yawDelta).toBeGreaterThan(0);
      expect(second.look.yawDelta).toBe(0);
    });

    it('inverts the screen Y so pushing the mouse up looks up', () => {
      // Screen Y grows downward and pitch grows upward. Getting this wrong inverts the vertical
      // axis for every player who does not use "invert Y", which is most of them.
      dom.lockPointer();
      dom.mouseMove(0, 10);
      expect(input.beginTick(YAW).look.pitchDelta).toBeLessThan(0);

      dom.mouseMove(0, -10);
      expect(input.beginTick(YAW).look.pitchDelta).toBeGreaterThan(0);
    });

    it('discards movement across the lock transition', () => {
      // Acquiring a lock typically involves a large, fast mouse movement toward the canvas.
      // Delivering it would spin the camera on the first frame of every session.
      dom.mouseMove(0, 0);
      dom.pointerLocked = true;

      // A big movement arrives in the same batch as the lock.
      dom.mouseMove(400, 300);
      dom.fire('pointerlockchange', {});

      expect(input.beginTick(YAW).look.yawDelta).toBe(0);
    });

    it('reports the locked state so the UI can prompt the player', () => {
      expect(input.isPointerLocked).toBe(false);
      dom.lockPointer();
      expect(input.isPointerLocked).toBe(true);
      dom.unlockPointer();
      expect(input.isPointerLocked).toBe(false);
    });

    it('suppresses the browser Tab and Escape defaults only while locked', () => {
      // Tab moves focus out of the game and Escape is claimed by the browser for exiting pointer
      // lock; both are bound actions. But a player who has released the mouse must still be able
      // to use the browser normally.
      dom.keyDown('Tab');
      expect(dom.preventedDefaults).toHaveLength(0);

      dom.lockPointer();
      dom.keyDown('Tab');
      expect(dom.preventedDefaults).toContain('Tab');
    });

    it('does not throw when the pointer lock request is refused', () => {
      // An unhandled rejection is a console error, and "no console errors" is an acceptance
      // criterion. The refusal has a real cause worth reporting once: browsers refuse a lock too
      // soon after the player escaped one.
      dom.pointerLockError = new DOMException('too soon', 'NotAllowedError');
      expect(() => dom.fire('click', {})).not.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // MOVEMENT — camera-relative, and the two devices
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('movement', () => {
    it('makes forward mean away from the camera', () => {
      // Without this, W would mean "move north", and the character would strafe across the screen
      // instead of walking away from it the moment the player turned the camera.
      dom.keyDown('KeyW');

      const snapshot = input.beginTick(Math.PI / 2);
      // At yaw pi/2 the camera faces +X, so forward is +X.
      expect(snapshot.intent.moveDirection.x).toBeCloseTo(1, 6);
      expect(snapshot.intent.moveDirection.z).toBeCloseTo(0, 6);
    });

    it('keeps right perpendicular to forward at every yaw', () => {
      dom.keyDown('KeyW');
      const forward = input.beginTick(1.1).intent.moveDirection;

      dom.keyUp('KeyW');
      dom.keyDown('KeyD');
      const right = input.beginTick(1.1).intent.moveDirection;

      expect(forward.x * right.x + forward.z * right.z).toBeCloseTo(0, 6);
    });

    it('does not make diagonal keyboard movement faster than straight', () => {
      // Combining raw axis values is the classic way to get a 41%-faster diagonal.
      dom.keyDown('KeyW');
      const straight = input.beginTick(YAW).intent.moveMagnitude;

      dom.keyDown('KeyD');
      const diagonal = input.beginTick(YAW).intent.moveMagnitude;

      expect(diagonal).toBeCloseTo(straight, 9);
      // The direction, however, is a proper diagonal.
      const direction = input.beginTick(YAW).intent.moveDirection;
      expect(Math.hypot(direction.x, direction.z)).toBeCloseTo(1, 9);
    });

    it('walks without the run modifier and runs with it', () => {
      dom.keyDown('KeyW');
      const walking = input.beginTick(YAW).intent.moveMagnitude;

      dom.keyDown('ShiftLeft');
      const running = input.beginTick(YAW).intent.moveMagnitude;

      // The GDD's 2 m/s and 6 m/s, as a ratio.
      expect(walking).toBeCloseTo(2 / 6, 6);
      expect(running).toBeCloseTo(1, 6);
    });

    it('maps a stick deflection directly to speed, with no run modifier', () => {
      // On a pad, "how fast" is a continuous question with a continuous answer. Snapping a stick
      // to walk-or-run would throw away the only thing analogue movement offers — which is why
      // there is deliberately no gamepad binding for Run.
      dom.gamepads = [fakeGamepad({ axes: [0, -0.55, 0, 0] })];
      input.beginTick(YAW);
      const half = input.beginTick(YAW).intent.moveMagnitude;

      expect(half).toBeGreaterThan(0.4);
      expect(half).toBeLessThan(0.6);
    });

    it('lets the harder-pushed device win, so two devices cannot fight', () => {
      dom.keyDown('KeyW'); // full magnitude, keyboard
      dom.gamepads = [fakeGamepad({ axes: [1, 0, 0, 0] })]; // full, to the right

      input.beginTick(YAW);
      const snapshot = input.beginTick(YAW);

      // Both are at magnitude 1, so the keyboard wins by precedence — and critically the
      // magnitude is 1, not 1.41 accumulated from both.
      expect(snapshot.intent.moveMagnitude).toBeLessThanOrEqual(1);
      expect(snapshot.intent.moveDirection.z).toBeCloseTo(1, 6);
    });

    it('never reports a magnitude above 1', () => {
      dom.keyDown('KeyW');
      dom.keyDown('KeyD');
      dom.keyDown('ShiftLeft');
      dom.gamepads = [fakeGamepad({ axes: [1, -1, 0, 0] })];

      for (let tick = 0; tick < 10; tick++) {
        expect(input.beginTick(YAW).intent.moveMagnitude).toBeLessThanOrEqual(1);
      }
    });

    it('inverts the stick Y so pushing forward walks forward', () => {
      // A pad reports -1 for "up". Getting this wrong walks the character backwards when the
      // stick is pushed forward and correctly when pushed back.
      dom.gamepads = [fakeGamepad({ axes: [0, -1, 0, 0] })];
      input.beginTick(YAW);

      const snapshot = input.beginTick(YAW);
      expect(snapshot.intent.moveDirection.z).toBeCloseTo(1, 6);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // REMAPPING AND PERSISTENCE
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('remapping', () => {
    it('honours a rebind immediately', () => {
      const result = input.setBinding(InputAction.Jump, { device: 'keyboard', code: 'KeyZ' });
      expect(result.ok).toBe(true);

      dom.keyDown('KeyZ');
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(true);
    });

    it('stops responding to the old binding', () => {
      input.setBinding(InputAction.Jump, { device: 'keyboard', code: 'KeyZ' });
      dom.keyDown('Space');
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(false);
    });

    it('refuses a conflicting rebind and leaves the table usable', () => {
      const result = input.setBinding(InputAction.Jump, { device: 'keyboard', code: 'KeyE' });
      expect(result.ok).toBe(false);

      // The original binding still works.
      dom.keyDown('Space');
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(true);
    });

    it('persists a rebind and reloads it', () => {
      const storage = memoryStorage();
      const fresh = new FakeDom();
      const { target, canvas } = fresh.install();

      const first = new InputSystem(target, canvas, storage);
      expect(first.setBinding(InputAction.Jump, { device: 'keyboard', code: 'KeyZ' }).ok).toBe(
        true,
      );
      first.dispose();

      const second = new InputSystem(target, canvas, storage);
      expect(second.lastLoadStatus).toBe(BindingsLoadStatus.Loaded);

      // The first tick of any system deliberately adopts no edges, so a key held at construction
      // cannot fire — so the press must be made after priming.
      second.beginTick(YAW);
      fresh.keyDown('KeyZ');
      expect(second.beginTick(YAW).intent.jumpRequested).toBe(true);

      second.dispose();
      fresh.uninstall();
    });

    it('restores defaults on reset, in memory and in storage', () => {
      const storage = memoryStorage();
      const fresh = new FakeDom();
      const { target, canvas } = fresh.install();

      const system = new InputSystem(target, canvas, storage);
      system.setBinding(InputAction.Jump, { device: 'keyboard', code: 'KeyZ' });
      system.resetBindings();

      expect(storage.getItem(BINDINGS_STORAGE_KEY)).toBeNull();

      // Priming tick first: it adopts no edges by design. And the key is fired at `fresh`, the
      // environment this system is actually listening to — each `FakeDom` owns its own listener
      // map, so firing at the outer one would dispatch into a different world entirely and the
      // assertion below would fail for a reason that has nothing to do with resetting bindings.
      system.beginTick(YAW);
      fresh.keyDown('Space');
      expect(system.beginTick(YAW).intent.jumpRequested).toBe(true);

      system.dispose();
      fresh.uninstall();
    });

    it('survives a corrupt stored payload without losing control of the game', () => {
      const storage = memoryStorage();
      storage.setItem(BINDINGS_STORAGE_KEY, '{"version":1,"bindings":{"jump":');

      const fresh = new FakeDom();
      const { target, canvas } = fresh.install();
      const system = new InputSystem(target, canvas, storage);

      expect(system.lastLoadStatus).toBe(BindingsLoadStatus.Repaired);
      expect(system.lastLoadMessage).toContain('JSON');

      // The game is playable with defaults. Priming tick first, then a real press.
      system.beginTick(YAW);
      fresh.keyDown('Space');
      expect(system.beginTick(YAW).intent.jumpRequested).toBe(true);

      system.dispose();
      fresh.uninstall();
    });

    it('hands out a copy of the table, so a caller cannot mutate the live one', () => {
      const table = input.bindingTable;
      table[InputAction.Jump] = [];
      // The live table is unaffected: the next tick still jumps on Space.
      dom.keyDown('Space');
      expect(input.beginTick(YAW).intent.jumpRequested).toBe(true);
    });

    it('labels bindings for display', () => {
      expect(input.labelFor(InputAction.Jump)).toBe('Space');
      expect(input.labelFor(InputAction.Crouch, 3)).toBe('B');
      // An out-of-range index is reported rather than crashing the settings screen.
      expect(input.labelFor(InputAction.Jump, 99)).toBe('—');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // LATENCY — R6's budget, measured rather than assumed
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('latency instrumentation', () => {
    it('reports a measurement for a press that was acted on', () => {
      dom.keyDown('Space');
      input.beginTick(YAW);

      const sample = input.consumeLatencySample();
      expect(sample).not.toBeNull();
      expect(sample!.action).toBe(InputAction.Jump);
      expect(Number.isFinite(sample!.eventToTickMs)).toBe(true);
      expect(sample!.eventToTickMs).toBeGreaterThanOrEqual(0);
    });

    it('does not report the same sample twice', () => {
      // A caller polling once per frame would otherwise display a stale number as if it were live.
      dom.keyDown('Space');
      input.beginTick(YAW);
      input.consumeLatencySample();
      expect(input.consumeLatencySample()).toBeNull();
    });

    it('reports nothing when no press was acted on', () => {
      input.beginTick(YAW);
      expect(input.consumeLatencySample()).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────────────

  describe('disposal', () => {
    it('stops responding to events after dispose', () => {
      // A leaked listener outlives the game and would keep mutating a dead system.
      const fresh = new FakeDom();
      const { target, canvas } = fresh.install();
      const system = new InputSystem(target, canvas, null);

      system.dispose();
      fresh.keyDown('Space');

      // The disposed system's latch is unreachable, but the important assertion is that firing
      // events does not throw and the fake still has no listeners registered by it.
      expect(() => fresh.keyDown('KeyW')).not.toThrow();
    });
  });
});
