/**
 * Persistence for remapped controls.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE FILE FROM `Bindings.ts`
 * ────────────────────────────────────────────────────────────────────────────────────
 * `Bindings.ts` is pure: it takes data and returns data, and it can be tested exhaustively in plain
 * Node. This file touches `localStorage`, which is a browser API that can throw, can be absent, and
 * can contain anything. Keeping the two apart means the *interesting* logic — validation, conflict
 * detection, serialisation — is never behind a browser environment, and the impure part is small
 * enough to audit in one pass.
 *
 * The storage is injected rather than reached for on `window`, so tests supply their own. A test
 * that needs `localStorage` to exist is a test that cannot run in CI.
 */

import {
  type BindingTable,
  BINDINGS_SCHEMA_VERSION,
  cloneDefaultBindings,
  parseBindings,
  serializeBindings,
  type StoredBindings,
} from './Bindings';

/** The storage key. Namespaced, because `localStorage` is shared with everything else on the origin. */
export const BINDINGS_STORAGE_KEY = 'jungleRelic.bindings.v1';

/**
 * The minimum of the `Storage` interface this module needs.
 *
 * Declared structurally rather than importing `Storage` so a test can pass an object literal, and
 * so the module does not require a DOM type environment to type-check.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What happened on load, so the caller can tell the player rather than silently changing controls. */
export enum BindingsLoadStatus {
  /** No stored payload. Defaults are in use, and this is the normal first-run case. */
  Defaults = 'defaults',
  /** A stored payload was found and fully understood. */
  Loaded = 'loaded',
  /** A payload was found but partly or wholly unusable. Defaults are in use where needed. */
  Repaired = 'repaired',
  /** Storage could not be read at all. The game runs on in-memory defaults. */
  Unavailable = 'unavailable',
}

/** The result of a load. */
export interface BindingsLoadResult {
  table: BindingTable;
  status: BindingsLoadStatus;
  /** A message suitable for the console, or null when everything was fine. */
  message: string | null;
}

/**
 * Load the player's bindings, falling back to defaults for anything unusable.
 *
 * ─── THE THREE FAILURE MODES, AND WHY ALL THREE ARE HANDLED ─────────────────────────
 *  1. **Storage throws.** Private browsing, a quota, or a browser configured to block storage.
 *     `getItem` itself throws in some of these, so the call is wrapped rather than merely
 *     null-checked.
 *  2. **The payload is not valid JSON.** Truncated by a crash, or edited by hand.
 *  3. **The payload is valid JSON but wrong.** An action that no longer exists, a code that is not
 *     a control, a list that would leave an action unbound.
 *
 * In every case the game must start and must be playable. Degrading to defaults is a worse
 * experience than honouring the player's bindings and a *much* better one than a game that cannot
 * be controlled — and the status is returned rather than logged and forgotten so the settings
 * screen can say so.
 *
 * @param storage - The storage to read from, or null when storage is unavailable.
 * @returns The table to use, plus how it was obtained.
 */
export function loadBindings(storage: StorageLike | null): BindingsLoadResult {
  if (storage === null) {
    return {
      table: cloneDefaultBindings(),
      status: BindingsLoadStatus.Unavailable,
      message: 'Storage unavailable; controls are session-only',
    };
  }

  let raw: string | null;
  try {
    raw = storage.getItem(BINDINGS_STORAGE_KEY);
  } catch (error) {
    return {
      table: cloneDefaultBindings(),
      status: BindingsLoadStatus.Unavailable,
      message: `Storage threw on read (${describe(error)}); controls are session-only`,
    };
  }

  if (raw === null) {
    return { table: cloneDefaultBindings(), status: BindingsLoadStatus.Defaults, message: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      table: cloneDefaultBindings(),
      status: BindingsLoadStatus.Repaired,
      message: 'Stored controls were not valid JSON; defaults restored',
    };
  }

  const { table, repaired } = parseBindings(parsed);

  return {
    table,
    status: repaired ? BindingsLoadStatus.Repaired : BindingsLoadStatus.Loaded,
    message: repaired ? 'Stored controls were partly unusable; defaults restored where needed' : null,
  };
}

/**
 * Persist the player's bindings.
 *
 * @param storage - The storage to write to, or null when unavailable.
 * @param table - The table to store.
 * @returns True when the write succeeded. A failure is reported rather than thrown: losing a
 *   preference is not worth interrupting play, and the in-memory table is already correct.
 */
export function saveBindings(storage: StorageLike | null, table: BindingTable): boolean {
  if (storage === null) return false;

  try {
    const payload: StoredBindings = serializeBindings(table);
    storage.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    // A full quota or a blocked origin. The player keeps the bindings they just set for this
    // session; only the persistence is lost.
    return false;
  }
}

/**
 * Forget the stored bindings, restoring the shipped defaults on the next load.
 *
 * @param storage - The storage to clear, or null when unavailable.
 * @returns True when the clear succeeded.
 */
export function clearBindings(storage: StorageLike | null): boolean {
  if (storage === null) return false;

  try {
    storage.removeItem(BINDINGS_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * The browser's `localStorage`, if it can be used at all.
 *
 * ─── WHY THIS PROBES RATHER THAN TESTING FOR EXISTENCE ──────────────────────────────
 * `localStorage` can exist and still throw on access — most commonly in private-browsing modes and
 * in pages whose origin is opaque. So the only reliable test is to actually perform a write and a
 * read, which is what this does. A feature-detection check like `typeof localStorage !== 'undefined'`
 * passes in exactly the configurations where it then throws.
 *
 * @returns The storage, or null when it cannot be used.
 */
export function detectStorage(): StorageLike | null {
  try {
    const probe = globalThis.localStorage;
    if (!probe) return null;

    const testKey = `${BINDINGS_STORAGE_KEY}.probe`;
    probe.setItem(testKey, '1');
    probe.removeItem(testKey);
    return probe;
  } catch {
    return null;
  }
}

/** A short description of a thrown value, for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

export { BINDINGS_SCHEMA_VERSION };
