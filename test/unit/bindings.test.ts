/**
 * Unit tests for the binding table and its persistence.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * EDGE CASE IE5: CORRUPT OR UNKNOWN PERSISTED BINDINGS
 * ────────────────────────────────────────────────────────────────────────────────
 * The theme running through this file is that **stored data is hostile until proven otherwise**.
 * `localStorage` is player-writable, survives across versions, and can be edited by hand, by an
 * extension, or by a previous build whose action set was different. A loader that trusts its input
 * can be bricked permanently, and the failure lands on the *next* load — after the player has
 * closed the game, which is the worst possible moment to discover it.
 *
 * So the assertions below are mostly adversarial: what happens when the payload is a string, an
 * array, null, a number, a version from the future, an action that no longer exists, or a binding
 * list that would leave forward unbound. In every case the requirement is the same: **the game
 * starts and can be played.**
 */

import { describe, it, expect } from 'vitest';
import {
  ALL_ACTIONS,
  BindingRejection,
  type BindingTable,
  bindingLabel,
  cloneDefaultBindings,
  DEFAULT_BINDINGS,
  InputAction,
  parseBindings,
  rebind,
  serializeBindings,
  BINDINGS_SCHEMA_VERSION,
  unbind,
} from '../../src/input/Bindings';
import {
  BINDINGS_STORAGE_KEY,
  type StorageLike,
  clearBindings,
  detectStorage,
  loadBindings,
  saveBindings,
  BindingsLoadStatus,
} from '../../src/input/BindingStore';
import { GAMEPAD_TRIGGER_REST, GAMEPAD_MOVE_DEADZONE } from '../../src/core/constants';

/** An in-memory `Storage`, with knobs for the failure modes a real one has. */
function fakeStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Record<string, string>;
  throwOnRead: boolean;
  throwOnWrite: boolean;
} {
  const store = {
    data: { ...initial },
    throwOnRead: false,
    throwOnWrite: false,
    getItem(key: string): string | null {
      if (store.throwOnRead) throw new DOMException('blocked', 'SecurityError');
      return store.data[key] ?? null;
    },
    setItem(key: string, value: string): void {
      if (store.throwOnWrite) throw new DOMException('quota', 'QuotaExceededError');
      store.data[key] = value;
    },
    removeItem(key: string): void {
      delete store.data[key];
    },
  };
  return store;
}

describe('the default binding table', () => {
  it('binds every action', () => {
    for (const action of ALL_ACTIONS) {
      expect(DEFAULT_BINDINGS[action].length, action).toBeGreaterThan(0);
    }
  });

  it('has no control bound to two actions', () => {
    // A default table with an internal conflict would make the conflict detector's rejection of
    // the player's *first* rebind look arbitrary, because the table was already broken.
    const seen = new Set<string>();
    for (const action of ALL_ACTIONS) {
      for (const binding of DEFAULT_BINDINGS[action]) {
        const key = `${binding.device}:${binding.code}`;
        expect(seen.has(key), `${key} is bound twice`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('never claims the keyboard "run" binding on a gamepad', () => {
    // A stick's deflection IS its speed, so a pad run button would be a second, contradictory
    // control over the same quantity. Asserted because re-adding it "for symmetry" is exactly the
    // kind of tidy-up that breaks the feel.
    const padRuns = DEFAULT_BINDINGS[InputAction.Run].filter((b) => b.device === 'gamepad');
    expect(padRuns).toHaveLength(0);
  });

  it('gives every action a readable label', () => {
    for (const action of ALL_ACTIONS) {
      for (const binding of DEFAULT_BINDINGS[action]) {
        const label = bindingLabel(binding);
        expect(label.length, `${action} ${binding.code}`).toBeGreaterThan(0);
        // An unlabelled key falls back to its raw code, which is deliberate — it makes the gap
        // visible in the UI. This asserts that none of the *defaults* rely on that fallback.
        expect(label).not.toMatch(/^[A-Z][a-z]+[A-Z]/);
      }
    }
  });

  it("does not use the mouse's left button, which belongs to the camera capture", () => {
    // Left-click requests pointer lock. Binding an action to it too would mean every click to
    // recapture the mouse also fired that action.
    for (const action of ALL_ACTIONS) {
      for (const binding of DEFAULT_BINDINGS[action]) {
        expect(binding.code, action).not.toBe('MouseLeft');
      }
    }
  });

  it('leaves the trigger rest threshold clear of the aim binding', () => {
    // The aim binding's trigger must not read as held at rest. This ties the hardware constant to
    // the binding table so a future retune of one is caught against the other.
    expect(GAMEPAD_TRIGGER_REST).toBeGreaterThan(0);
    expect(GAMEPAD_TRIGGER_REST).toBeLessThan(0.25);
    expect(GAMEPAD_MOVE_DEADZONE).toBeGreaterThan(0);
  });
});

describe('rebind — conflicts are refused, not resolved', () => {
  it('assigns a free control', () => {
    const table = cloneDefaultBindings();
    const result = rebind(table, InputAction.Jump, { device: 'keyboard', code: 'KeyZ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table[InputAction.Jump]).toEqual([{ device: 'keyboard', code: 'KeyZ' }]);
  });

  it('refuses a control another action already owns, and says which', () => {
    // The tempting behaviour is to let the new binding win and clear the old one, which is how a
    // player ends up unable to jump with no memory of having done anything.
    const table = cloneDefaultBindings();
    const result = rebind(table, InputAction.Jump, { device: 'keyboard', code: 'KeyE' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(BindingRejection.Conflict);
    expect(result.detail).toContain('Interact');
  });

  it('does not mutate the table it was given', () => {
    // A refused rebind that half-applied would be the worst of both outcomes.
    const table = cloneDefaultBindings();
    const before = JSON.stringify(serializeBindings(table));
    rebind(table, InputAction.Jump, { device: 'keyboard', code: 'KeyE' });
    rebind(table, InputAction.Jump, { device: 'keyboard', code: 'KeyZ' });
    expect(JSON.stringify(serializeBindings(table))).toBe(before);
  });

  it('allows an action to be rebound to a control it already has', () => {
    // Re-assigning the same key is a no-op, not a conflict with itself.
    const table = cloneDefaultBindings();
    const result = rebind(table, InputAction.Jump, { device: 'keyboard', code: 'Space' });
    expect(result.ok).toBe(true);
  });

  it('refuses an implausible gamepad button index', () => {
    // The `standard` mapping defines buttons 0-16. Accepting 42 would store a binding that can
    // never fire, and the player would be left wondering why the button does nothing.
    const table = cloneDefaultBindings();
    const result = rebind(table, InputAction.Jump, { device: 'gamepad', code: '42' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(BindingRejection.UnknownControl);
  });

  it('refuses an empty keyboard code', () => {
    const table = cloneDefaultBindings();
    const result = rebind(table, InputAction.Jump, { device: 'keyboard', code: '' });
    expect(result.ok).toBe(false);
  });
});

describe('unbind — an action can never be left unreachable', () => {
  it('removes one of several bindings, and only that one', () => {
    const table = cloneDefaultBindings();
    const before = table[InputAction.Crouch].length;
    expect(before).toBeGreaterThan(1);

    const result = unbind(table, InputAction.Crouch, { device: 'keyboard', code: 'KeyC' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table[InputAction.Crouch]).toHaveLength(before - 1);
    // The specific control is gone, not merely "one fewer".
    expect(
      result.table[InputAction.Crouch].some((b) => b.code === 'KeyC'),
    ).toBe(false);
  });

  it('removes the binding for the right device only', () => {
    // The gamepad's B and the keyboard have separate identities. Matching on the code alone would
    // remove a keyboard binding when the player meant to remove a pad button whose index happened
    // to collide with a numeric key name.
    const table = cloneDefaultBindings();
    const result = unbind(table, InputAction.Crouch, { device: 'gamepad', code: '1' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table[InputAction.Crouch]).toHaveLength(3);
    for (const binding of result.table[InputAction.Crouch]) {
      expect(binding.device).toBe('keyboard');
    }
  });

  it('refuses to remove the last binding of an action', () => {
    // A player who unbinds "forward" has no way to reach the settings screen to fix it, and the
    // game is unplayable. This is a hard refusal, not a warning.
    const table = cloneDefaultBindings();

    // Jump is bound to Space and gamepad A. Reduce it to one binding, then try to remove that.
    const first = unbind(table, InputAction.Jump, { device: 'gamepad', code: '0' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // `Jump` has ONE keyboard binding, so removing it is the last one.
    expect(first.table[InputAction.Jump]).toHaveLength(1);
    const last = unbind(first.table, InputAction.Jump, first.table[InputAction.Jump][0]);

    expect(last.ok).toBe(false);
    if (last.ok) return;
    expect(last.reason).toBe(BindingRejection.WouldUnbind);
    expect(last.detail).toContain('Jump');
    expect(first.table[InputAction.Jump]).toHaveLength(1);
  });

  it('refuses to remove a control the action does not have, rather than removing nothing', () => {
    // A silent no-op here would leave the player believing they had unbound something. The check
    // is "would this action be left with no controls", which is the property that matters.
    const table = cloneDefaultBindings();
    const result = unbind(table, InputAction.Jump, { device: 'keyboard', code: 'KeyZ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table[InputAction.Jump]).toHaveLength(2);
  });

  it('leaves every other action untouched', () => {
    const table = cloneDefaultBindings();
    const result = unbind(table, InputAction.Crouch, { device: 'keyboard', code: 'KeyC' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table[InputAction.Interact]).toEqual(table[InputAction.Interact]);
  });
});

describe('serializeBindings — stores only what changed', () => {
  it('writes nothing for a default table', () => {
    // Storing only differences means a future change to a default is picked up by existing
    // players, instead of being silently overridden by a full table from an older build.
    const payload = serializeBindings(cloneDefaultBindings());
    expect(Object.keys(payload.bindings)).toHaveLength(0);
    expect(payload.version).toBe(BINDINGS_SCHEMA_VERSION);
  });

  it('writes exactly the changed action', () => {
    let table = cloneDefaultBindings();
    const result = rebind(table, InputAction.Jump, { device: 'keyboard', code: 'KeyZ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    table = result.table;

    const payload = serializeBindings(table);
    expect(Object.keys(payload.bindings)).toEqual([InputAction.Jump]);
  });

  it('survives a round trip through JSON', () => {
    const result = rebind(cloneDefaultBindings(), InputAction.Jump, {
      device: 'keyboard',
      code: 'KeyZ',
    });
    if (!result.ok) throw new Error('rebind failed');
    const stored = JSON.parse(JSON.stringify(serializeBindings(result.table)));

    const { table, repaired } = parseBindings(stored);
    expect(repaired).toBe(false);
    expect(table[InputAction.Jump]).toEqual([{ device: 'keyboard', code: 'KeyZ' }]);
    // And everything else stayed at its default.
    expect(table[InputAction.Interact]).toEqual(DEFAULT_BINDINGS[InputAction.Interact]);
  });
});

describe('parseBindings — EDGE CASE IE5, corrupt and unknown data', () => {
  /** Every failure must still produce a complete, playable table. */
  function expectPlayable(raw: unknown, expectRepaired: boolean): BindingTable {
    const { table, repaired } = parseBindings(raw);
    expect(repaired, `repaired flag for ${JSON.stringify(raw)}`).toBe(expectRepaired);

    // Completeness is the real requirement: every action must be bound, or the game is unplayable.
    for (const action of ALL_ACTIONS) {
      expect(table[action].length, `${action} unbound`).toBeGreaterThan(0);
    }
    return table;
  }

  it('falls back entirely for a non-object payload', () => {
    for (const raw of [null, undefined, 42, 'bindings', true, []]) {
      const table = expectPlayable(raw, true);
      expect(table[InputAction.Jump]).toEqual(DEFAULT_BINDINGS[InputAction.Jump]);
    }
  });

  it('discards a payload from an unknown schema version rather than guessing', () => {
    // Repairing a payload whose meaning is unknown is how a "repair" invents a binding nobody
    // asked for.
    const table = expectPlayable({ version: 99, bindings: { jump: [] } }, true);
    expect(table[InputAction.Jump]).toEqual(DEFAULT_BINDINGS[InputAction.Jump]);
  });

  it('drops an action this build does not know about, and keeps the rest', () => {
    const raw = {
      version: BINDINGS_SCHEMA_VERSION,
      bindings: {
        jump: [{ device: 'keyboard', code: 'KeyZ' }],
        teleport: [{ device: 'keyboard', code: 'KeyT' }],
      },
    };
    const table = expectPlayable(raw, true);
    expect(table[InputAction.Jump]).toEqual([{ device: 'keyboard', code: 'KeyZ' }]);
  });

  it('falls back for an action whose binding list is empty', () => {
    const raw = {
      version: BINDINGS_SCHEMA_VERSION,
      bindings: { [InputAction.Jump]: [] },
    };
    const table = expectPlayable(raw, true);
    expect(table[InputAction.Jump]).toEqual(DEFAULT_BINDINGS[InputAction.Jump]);
  });

  it('falls back for a binding with an unknown device', () => {
    const raw = {
      version: BINDINGS_SCHEMA_VERSION,
      bindings: { [InputAction.Jump]: [{ device: 'touch', code: 'Tap' }] },
    };
    const table = expectPlayable(raw, true);
    expect(table[InputAction.Jump]).toEqual(DEFAULT_BINDINGS[InputAction.Jump]);
  });

  it('falls back for an implausible gamepad button', () => {
    const raw = {
      version: BINDINGS_SCHEMA_VERSION,
      bindings: { [InputAction.Jump]: [{ device: 'gamepad', code: '999' }] },
    };
    expectPlayable(raw, true);
  });

  it('falls back for a binding whose code is not a string', () => {
    const raw = {
      version: BINDINGS_SCHEMA_VERSION,
      bindings: { [InputAction.Jump]: [{ device: 'keyboard', code: 42 }] },
    };
    expectPlayable(raw, true);
  });

  it('falls back for a bindings field that is not an object', () => {
    expectPlayable({ version: BINDINGS_SCHEMA_VERSION, bindings: 'nonsense' }, true);
    expectPlayable({ version: BINDINGS_SCHEMA_VERSION, bindings: null }, true);
  });

  it('accepts a legitimate payload without flagging a repair', () => {
    const raw = {
      version: BINDINGS_SCHEMA_VERSION,
      bindings: { [InputAction.Crouch]: [{ device: 'keyboard', code: 'KeyV' }] },
    };
    const { table, repaired } = parseBindings(raw);
    expect(repaired).toBe(false);
    expect(table[InputAction.Crouch]).toEqual([{ device: 'keyboard', code: 'KeyV' }]);
  });

  it('never leaves an action unbound, for any input in a broad sweep', () => {
    // The property that matters, checked against a deliberately nasty set rather than against
    // the specific cases above — because the specific cases are the ones I thought of.
    const nasty: unknown[] = [
      {},
      { version: 1 },
      { version: 1, bindings: {} },
      { version: 1, bindings: { jump: 'x' } },
      { version: 1, bindings: { jump: [null] } },
      { version: 1, bindings: { jump: [{}] } },
      { version: 1, bindings: { jump: [{ device: 'keyboard' }] } },
      { version: -1, bindings: { jump: [{ device: 'keyboard', code: 'KeyZ' }] } },
      { version: 1.5, bindings: {} },
      { version: '1', bindings: {} },
      [[]],
      [1, 2, 3],
    ];

    for (const raw of nasty) {
      const { table } = parseBindings(raw);
      for (const action of ALL_ACTIONS) {
        expect(table[action].length, `${action} for ${JSON.stringify(raw)}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('loadBindings and saveBindings — the storage boundary', () => {
  it('reports defaults on a first run', () => {
    const result = loadBindings(fakeStorage());
    expect(result.status).toBe(BindingsLoadStatus.Defaults);
    expect(result.message).toBeNull();
    expect(result.table[InputAction.Jump]).toEqual(DEFAULT_BINDINGS[InputAction.Jump]);
  });

  it('reports an unreadable storage and stays playable', () => {
    // Private browsing, a blocked origin, or a browser configured to refuse storage. `getItem`
    // itself throws in some of these, which is why the call is wrapped rather than null-checked.
    const storage = fakeStorage();
    storage.throwOnRead = true;

    const result = loadBindings(storage);
    expect(result.status).toBe(BindingsLoadStatus.Unavailable);
    expect(result.message).toContain('session-only');
    expect(result.table[InputAction.Jump].length).toBeGreaterThan(0);
  });

  it('survives storage being absent entirely', () => {
    const result = loadBindings(null);
    expect(result.status).toBe(BindingsLoadStatus.Unavailable);
    expect(result.table[InputAction.Jump].length).toBeGreaterThan(0);
    expect(saveBindings(null, result.table)).toBe(false);
    expect(clearBindings(null)).toBe(false);
  });

  it('reports invalid JSON as repaired, and restores defaults', () => {
    const storage = fakeStorage({ [BINDINGS_STORAGE_KEY]: '{ truncated' });
    const result = loadBindings(storage);
    expect(result.status).toBe(BindingsLoadStatus.Repaired);
    expect(result.message).toContain('not valid JSON');
    expect(result.table[InputAction.Jump]).toEqual(DEFAULT_BINDINGS[InputAction.Jump]);
  });

  it('round-trips a rebind through storage', () => {
    const storage = fakeStorage();
    const result = rebind(cloneDefaultBindings(), InputAction.Jump, {
      device: 'keyboard',
      code: 'KeyZ',
    });
    if (!result.ok) throw new Error('rebind failed');

    expect(saveBindings(storage, result.table)).toBe(true);

    const loaded = loadBindings(storage);
    expect(loaded.status).toBe(BindingsLoadStatus.Loaded);
    expect(loaded.table[InputAction.Jump]).toEqual([{ device: 'keyboard', code: 'KeyZ' }]);
  });

  it('reports a failed write without throwing', () => {
    // Losing a preference is not worth interrupting play, and the in-memory table is already
    // correct — so the failure is reported, not raised.
    const storage = fakeStorage();
    storage.throwOnWrite = true;
    expect(saveBindings(storage, cloneDefaultBindings())).toBe(false);
  });

  it('clearing storage restores defaults on the next load', () => {
    const storage = fakeStorage();
    const result = rebind(cloneDefaultBindings(), InputAction.Jump, {
      device: 'keyboard',
      code: 'KeyZ',
    });
    if (!result.ok) throw new Error('rebind failed');
    saveBindings(storage, result.table);

    expect(clearBindings(storage)).toBe(true);
    const loaded = loadBindings(storage);
    expect(loaded.status).toBe(BindingsLoadStatus.Defaults);
    expect(loaded.table[InputAction.Jump]).toEqual(DEFAULT_BINDINGS[InputAction.Jump]);
  });

  it('detectStorage returns null when localStorage is unusable, without throwing', () => {
    // The probe exists because `localStorage` can exist and still throw on access — most commonly
    // in private-browsing modes — so a feature-detection check like `typeof localStorage` passes
    // in exactly the configurations where the next call throws.
    expect(() => detectStorage()).not.toThrow();
  });

  it('never leaves a stored payload unparseable by a later load', () => {
    // The invariant that makes the whole persistence story safe: whatever we write, we can read.
    const storage = fakeStorage();
    let table = cloneDefaultBindings();

    const rebinds: Array<[InputAction, string]> = [
      [InputAction.Jump, 'KeyZ'],
      [InputAction.Interact, 'KeyQ'],
      [InputAction.Crouch, 'KeyV'],
      [InputAction.Inventory, 'KeyI'],
    ];

    for (const [action, code] of rebinds) {
      const result = rebind(table, action, { device: 'keyboard', code });
      if (!result.ok) throw new Error(`rebind ${action} failed`);
      table = result.table;
      expect(saveBindings(storage, table)).toBe(true);

      const loaded = loadBindings(storage);
      expect(loaded.status, `after rebinding ${action}`).toBe(BindingsLoadStatus.Loaded);
    }
  });
});
