/**
 * Input actions, their default bindings, and the persistence of changes to them.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS PURE. IT KNOWS NOTHING ABOUT EVENTS, DOM OR TIMING.
 * ────────────────────────────────────────────────────────────────────────────────────
 * Everything here takes data and returns data. The three things that make input code
 * untestable — event handlers, browser APIs and wall-clock time — are all absent, which is why
 * remapping, validation and persistence can be tested exhaustively in plain Node.
 *
 * ─── WHY BINDINGS ARE DATA RATHER THAN `if (key === 'KeyW')` ────────────────────────
 * Because the GDD requires remapping with `localStorage` persistence (GDD §14), and a hard-coded
 * key check cannot be remapped, persisted, validated, displayed, or tested. The binding table is a
 * data structure, the defaults are one instance of it, and everything else — the loader, the
 * conflict detector, the serialiser — operates on the structure rather than on special cases.
 */

/**
 * Every action the game can bind.
 *
 * Named after the *intent*, never the key. `run` rather than `shift`, because a player who rebinds
 * shift to something else has not changed what running is.
 */
export enum InputAction {
  MoveForward = 'moveForward',
  MoveBack = 'moveBack',
  MoveLeft = 'moveLeft',
  MoveRight = 'moveRight',
  Run = 'run',
  Jump = 'jump',
  Crouch = 'crouch',
  Interact = 'interact',
  Attack = 'attack',
  Aim = 'aim',
  Inventory = 'inventory',
  Pause = 'pause',
}

/**
 * A single binding: which device, and which control on it.
 *
 * `code` is a `KeyboardEvent.code` for the keyboard and a `GamepadButton` index (as a string) for
 * the gamepad. `code` is used rather than `key` because it is layout-independent: on an AZERTY
 * keyboard, `KeyW` is physically where a QWERTY player's W is, which is where the player's hand
 * already is.
 */
export interface Binding {
  device: 'keyboard' | 'gamepad';
  code: string;
}

/** A complete binding table: every action, each with an ordered list of controls that trigger it. */
export type BindingTable = Record<InputAction, readonly Binding[]>;

/**
 * The shipped bindings.
 *
 * ─── WHY SOME ACTIONS HAVE TWO BINDINGS AND OTHERS HAVE ONE ─────────────────────────
 * Aliases are added where the *physical* alternative is conventional and costs nothing: two
 * crouch keys, two run keys (left and right shift, because a player's hand is on one or the other
 * depending on wasd or arrow usage), and arrow keys alongside wasd for the players who use them.
 * They are not added for taste — every alias is another key that can conflict.
 */
export const DEFAULT_BINDINGS: BindingTable = {
  [InputAction.MoveForward]: [
    { device: 'keyboard', code: 'KeyW' },
    { device: 'keyboard', code: 'ArrowUp' },
    { device: 'gamepad', code: '12' },
  ],
  [InputAction.MoveBack]: [
    { device: 'keyboard', code: 'KeyS' },
    { device: 'keyboard', code: 'ArrowDown' },
    { device: 'gamepad', code: '13' },
  ],
  [InputAction.MoveLeft]: [
    { device: 'keyboard', code: 'KeyA' },
    { device: 'keyboard', code: 'ArrowLeft' },
    { device: 'gamepad', code: '14' },
  ],
  [InputAction.MoveRight]: [
    { device: 'keyboard', code: 'KeyD' },
    { device: 'keyboard', code: 'ArrowRight' },
    { device: 'gamepad', code: '15' },
  ],
  [InputAction.Run]: [
    { device: 'keyboard', code: 'ShiftLeft' },
    { device: 'keyboard', code: 'ShiftRight' },
    // No gamepad binding, deliberately. A stick's *deflection* is its speed, so on a pad "run" is
    // a continuous question with a continuous answer, and a run button would be a second,
    // contradictory control over the same thing. Documented again in `InputSystem.resolveSpeed`,
    // where the asymmetry is implemented.
  ],
  [InputAction.Jump]: [
    { device: 'keyboard', code: 'Space' },
    { device: 'gamepad', code: '0' }, // A / cross
  ],
  [InputAction.Crouch]: [
    { device: 'keyboard', code: 'ControlLeft' },
    { device: 'keyboard', code: 'ControlRight' },
    { device: 'keyboard', code: 'KeyC' },
    { device: 'gamepad', code: '1' }, // B / circle
  ],
  [InputAction.Interact]: [
    { device: 'keyboard', code: 'KeyE' },
    { device: 'gamepad', code: '2' }, // X / square
  ],
  [InputAction.Attack]: [
    { device: 'keyboard', code: 'KeyF' },
    { device: 'gamepad', code: '5' }, // right bumper
  ],
  [InputAction.Aim]: [
    { device: 'keyboard', code: 'MouseRight' },
    // Left trigger.
    { device: 'gamepad', code: '6' },
  ],
  [InputAction.Inventory]: [
    { device: 'keyboard', code: 'Tab' },
    { device: 'gamepad', code: '8' }, // back / select
  ],
  [InputAction.Pause]: [
    { device: 'keyboard', code: 'Escape' },
    { device: 'gamepad', code: '9' }, // start
  ],
};

/**
 * Human-readable labels for keys, for the settings screen and the overlay.
 *
 * A binding with no label falls back to its raw code, which is deliberately ugly: it makes an
 * unlabelled key visible in the UI rather than silently rendering as blank, and it is the kind of
 * thing that gets noticed and fixed.
 */
const KEY_LABELS: Record<string, string> = {
  KeyW: 'W',
  KeyA: 'A',
  KeyS: 'S',
  KeyD: 'D',
  KeyE: 'E',
  KeyC: 'C',
  KeyF: 'F',
  Space: 'Space',
  ShiftLeft: 'L-Shift',
  ShiftRight: 'R-Shift',
  ControlLeft: 'L-Ctrl',
  ControlRight: 'R-Ctrl',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Tab: 'Tab',
  Escape: 'Esc',
  MouseRight: 'RMB',
};

/** Gamepad button indices, for `standard`-mapping pads (see `InputSystem` for the mapping check). */
const GAMEPAD_LABELS: Record<string, string> = {
  '0': 'A',
  '1': 'B',
  '2': 'X',
  '3': 'Y',
  '4': 'LB',
  '5': 'RB',
  '6': 'LT',
  '7': 'RT',
  '8': 'Back',
  '9': 'Start',
  '12': 'D-Up',
  '13': 'D-Down',
  '14': 'D-Left',
  '15': 'D-Right',
};

/**
 * A display label for a binding.
 *
 * @param binding - The binding to label.
 * @returns A short human-readable label such as `W`, `RB` or `D-Up`.
 */
export function bindingLabel(binding: Binding): string {
  const table = binding.device === 'gamepad' ? GAMEPAD_LABELS : KEY_LABELS;
  return table[binding.code] ?? binding.code;
}

/** Every action, in a stable order, for iteration in UI and tests. */
export const ALL_ACTIONS: readonly InputAction[] = Object.freeze(
  Object.values(InputAction),
) as readonly InputAction[];

/** A deep copy of the defaults. Callers mutate their own copy, never the shipped table. */
export function cloneDefaultBindings(): BindingTable {
  const copy = {} as BindingTable;
  for (const action of ALL_ACTIONS) {
    copy[action] = DEFAULT_BINDINGS[action].map((binding) => ({ ...binding }));
  }
  return copy;
}

/**
 * Why a proposed binding was rejected.
 *
 * Returned as data rather than as a thrown error: a conflict is an ordinary, expected player
 * action, not an exceptional condition, and the settings UI needs to explain it.
 */
export enum BindingRejection {
  /** Another action already uses this control. */
  Conflict = 'conflict',
  /** The action would be left with no bindings at all. */
  WouldUnbind = 'wouldUnbind',
  /** The control code is not one this device reports. */
  UnknownControl = 'unknownControl',
}

/** The outcome of proposing a new binding. */
export type BindingResult =
  | { ok: true; table: BindingTable }
  | { ok: false; reason: BindingRejection; detail: string };

/** Does this control already appear in the table, and if so for which action? */
function findConflict(
  table: BindingTable,
  binding: Binding,
  ignore: InputAction,
): InputAction | null {
  for (const action of ALL_ACTIONS) {
    if (action === ignore) continue;
    for (const existing of table[action]) {
      if (existing.device === binding.device && existing.code === binding.code) return action;
    }
  }
  return null;
}

/** Human-readable name for an action, for messages and the overlay. */
export function actionLabel(action: InputAction): string {
  // Splits camelCase into words: "moveForward" -> "Move forward".
  const spaced = action.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Is this a control the given device could plausibly report? */
function isPlausibleControl(binding: Binding): boolean {
  if (binding.device === 'gamepad') {
    const index = Number.parseInt(binding.code, 10);
    // The Gamepad `standard` mapping defines 17 buttons (0–16). Anything outside that is not a
    // button any pad will ever report, so accepting it would store a binding that can never fire.
    return Number.isInteger(index) && index >= 0 && index <= 16;
  }

  // Keyboard codes are DOM strings. Accepting an empty one would store a binding that fires on
  // every event; a length bound rules out both that and obvious garbage without needing the
  // complete W3C code list, which would be a large table that still would not catch typos.
  return binding.code.length > 0 && binding.code.length <= 32;
}

/**
 * Assign a control to an action, replacing that action's bindings.
 *
 * ─── WHY CONFLICTS ARE REJECTED RATHER THAN RESOLVED ────────────────────────────────
 * The tempting behaviour is to let the new binding win and clear the old one. That is how a player
 * ends up unable to jump, with no memory of having done anything to cause it, and no way to work
 * out which action lost its binding — because the settings screen still shows the key they just
 * pressed, attached to the action they just changed. Rejecting with a reason costs one extra
 * attempt and never produces a state the player did not intend.
 *
 * @param table - The table to modify. Not mutated; a new table is returned.
 * @param action - The action to rebind.
 * @param binding - The control to assign.
 * @returns The new table, or the reason the assignment was refused.
 */
export function rebind(
  table: BindingTable,
  action: InputAction,
  binding: Binding,
): BindingResult {
  if (!isPlausibleControl(binding)) {
    return { ok: false, reason: BindingRejection.UnknownControl, detail: binding.code };
  }

  const conflict = findConflict(table, binding, action);
  if (conflict !== null) {
    return {
      ok: false,
      reason: BindingRejection.Conflict,
      detail: `${bindingLabel(binding)} is already bound to ${actionLabel(conflict)}`,
    };
  }

  const next = {} as BindingTable;
  for (const key of ALL_ACTIONS) next[key] = table[key].map((existing) => ({ ...existing }));
  next[action] = [{ ...binding }];
  return { ok: true, table: next };
}

/**
 * Remove one binding from an action.
 *
 * @param table - The table to modify. Not mutated.
 * @param action - The action to unbind from.
 * @param binding - The specific binding to remove.
 * @returns The new table, or the reason the removal was refused.
 */
export function unbind(table: BindingTable, action: InputAction, binding: Binding): BindingResult {
  const remaining = table[action].filter(
    (existing) => !(existing.device === binding.device && existing.code === binding.code),
  );

  if (remaining.length === 0) {
    // Refused, not merely risky: an action with no bindings cannot be reconsidered by the player
    // from inside the game if that action is the one that opens the settings screen.
    return {
      ok: false,
      reason: BindingRejection.WouldUnbind,
      detail: `${actionLabel(action)} would have no controls left`,
    };
  }

  const next = {} as BindingTable;
  for (const key of ALL_ACTIONS) next[key] = table[key].map((existing) => ({ ...existing }));
  next[action] = remaining;
  return { ok: true, table: next };
}

/**
 * The stored representation of a remapped table.
 *
 * `version` exists so a future change to the action set or the code vocabulary can migrate rather
 * than guess. Without it, a stored payload is uninterpretable a release later.
 */
export interface StoredBindings {
  version: number;
  /** Only actions the player actually changed. Absent actions keep their defaults. */
  bindings: Partial<Record<string, Binding[]>>;
}

/** Bumped whenever the shape below changes. Unknown versions are discarded rather than migrated. */
export const BINDINGS_SCHEMA_VERSION = 1;

/**
 * Serialise a table, storing only the actions that differ from the defaults.
 *
 * Storing only differences means a player who has changed nothing writes nothing, and — more
 * importantly — a future change to a default is picked up by existing players instead of being
 * silently overridden by a full table written by an older build.
 *
 * @param table - The current binding table.
 * @returns A payload ready for `JSON.stringify`.
 */
export function serializeBindings(table: BindingTable): StoredBindings {
  const bindings: Partial<Record<string, Binding[]>> = {};

  for (const action of ALL_ACTIONS) {
    const current = table[action];
    const defaults = DEFAULT_BINDINGS[action];
    const same =
      current.length === defaults.length &&
      current.every(
        (binding, index) =>
          binding.device === defaults[index].device && binding.code === defaults[index].code,
      );
    if (!same) bindings[action] = current.map((binding) => ({ ...binding }));
  }

  return { version: BINDINGS_SCHEMA_VERSION, bindings };
}

/**
 * Parse and validate a stored table.
 *
 * ─── EVERY FIELD IS HOSTILE UNTIL PROVEN OTHERWISE ──────────────────────────────────
 * `localStorage` is player-writable, survives across versions, and can be edited by hand, by a
 * browser extension, or by a previous build with a different action set. A loader that trusts its
 * input can be bricked permanently — and the failure lands on the *next* load, after the player has
 * already closed the game, which is the worst possible time to discover it.
 *
 * So: anything unrecognised is dropped, anything malformed falls back to the default for that
 * action, and a failure to parse at all falls back to the entire default table. The game is always
 * playable, at worst with controls the player did not choose.
 *
 * @param raw - The parsed value from storage, or anything else that was in that slot.
 * @returns A complete, valid binding table — always.
 */
export function parseBindings(raw: unknown): { table: BindingTable; repaired: boolean } {
  const table = cloneDefaultBindings();

  if (typeof raw !== 'object' || raw === null) return { table, repaired: true };

  const candidate = raw as Partial<StoredBindings>;

  // A different schema version is not repaired, it is *discarded*. Guessing at the meaning of a
  // payload written by a version that may have had different actions is how a "repair" invents a
  // binding nobody asked for.
  if (candidate.version !== BINDINGS_SCHEMA_VERSION) return { table, repaired: true };
  if (typeof candidate.bindings !== 'object' || candidate.bindings === null) {
    return { table, repaired: true };
  }

  let repaired = false;

  for (const [key, value] of Object.entries(candidate.bindings)) {
    // An action this build does not know about: from a newer build, or a hand-edited payload.
    const action = key as InputAction;
    if (!ALL_ACTIONS.includes(action)) {
      repaired = true;
      continue;
    }

    const parsed = parseBindingList(value);
    if (parsed === null) {
      repaired = true;
      continue;
    }
    table[action] = parsed;
  }

  return { table, repaired };
}

/**
 * Validate one action's binding list.
 *
 * @returns The bindings, or null when the list is unusable — in which case the caller keeps the
 *   default for that action rather than accepting a partial list.
 */
function parseBindingList(value: unknown): Binding[] | null {
  if (!Array.isArray(value)) return null;

  // An empty list is refused for the same reason `unbind` refuses: an action with no controls is
  // unreachable, and if it is a movement action the game is unplayable.
  if (value.length === 0) return null;

  const bindings: Binding[] = [];

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;

    const candidate = entry as Partial<Binding>;
    if (candidate.device !== 'keyboard' && candidate.device !== 'gamepad') return null;
    if (typeof candidate.code !== 'string') return null;
    if (!isPlausibleControl({ device: candidate.device, code: candidate.code })) return null;

    bindings.push({ device: candidate.device, code: candidate.code });
  }

  return bindings;
}
