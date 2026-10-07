/**
 * The locomotion state machine — pure transition logic, no engine, fully testable.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE DISCARDING DESIGN (risk R15, docs/RISK_ANALYSIS.md)
 * ────────────────────────────────────────────────────────────────────────────────
 * This is the single most important structural decision in the character controller.
 *
 * The obvious implementation accumulates independent booleans — `isGrounded`,
 * `isClimbing`, `isAiming`, `isMantling`, `isInWater` — and then every consumer has to
 * reason about all 2ⁿ combinations. That design guarantees illegal states (aiming while
 * climbing, mantling while dead, hanging while swimming) and makes the bug "the player
 * occasionally gets stuck in a corner doing nothing" impossible to reproduce.
 *
 * The alternative implemented here is a **discarding state**: exactly one locomotion state
 * is active at any moment, and moving to a new state *discards* the previous one. Wildly
 * illegal combinations are therefore not merely prevented by discipline — they are
 * unrepresentable. There is no way to express "climbing while mantling" because there is
 * only one slot.
 *
 * Orthogonal concerns (health, aiming, inventory) are deliberately NOT part of this enum.
 * They are separate machines that can each be in any state independently, because they
 * genuinely are independent. The rule is: one discarding machine per axis of exclusivity.
 *
 * ─── WHY THE TRANSITION FUNCTION IS PURE ────────────────────────────────────────────
 * `resolveLocomotionState` takes the current state and a snapshot of the world and returns
 * the next state. It touches nothing. That means every transition — including the illegal
 * ones and the exact boundary conditions — can be tested by constructing a context object,
 * with no game loop, no physics world, and no flakiness.
 */

import { SlopeBand } from '../core/math/locomotion';

/** The seven mutually exclusive locomotion states. */
export enum LocomotionState {
  /** Standing or moving on ground. Includes sliding and slow-slope traversal. */
  Grounded = 'grounded',

  /** Airborne: rising, falling, or mid-jump. */
  Airborne = 'airborne',

  /** Committed climb-up over a low ledge. Cancellable by player input. */
  Mantle = 'mantle',

  /** Hanging from a ledge. Capacity for shimmy, pull-up, drop and jump-away. */
  LedgeHang = 'ledge-hang',

  /** Free-climbing a marked surface. Vertical and lateral movement. */
  Climb = 'climb',

  /** Floating or swimming in a water volume. */
  Water = 'water',

  /** Riding a zip line. Movement is driven by the line, not by input. */
  ZipLine = 'zip-line',
}

/** Player intent for the tick, already resolved from raw input. */
export interface CharacterIntent {
  /** Desired horizontal direction, world space, already normalised or zero. */
  moveDirection: { x: number; z: number };
  /** Magnitude of movement desire in [0, 1]: 0 for none, 0.5 for walk, 1 for run. */
  moveMagnitude: number;
  /** Whether the jump control is held this tick. */
  jumpHeld: boolean;
  /** Whether a jump is *requested* — including from a still-open buffer window. */
  jumpRequested: boolean;
  /** Whether crouch is held. */
  crouchHeld: boolean;
  /** Whether interact is requested (grab a ledge-adjacent climbable, mount a zip line). */
  interactRequested: boolean;
}

/** An intent representing no input at all. Useful for tests and for cutscenes. */
export const NULL_INTENT: CharacterIntent = {
  moveDirection: { x: 0, z: 0 },
  moveMagnitude: 0,
  jumpHeld: false,
  jumpRequested: false,
  crouchHeld: false,
  interactRequested: false,
};

/** A snapshot of everything the transition function needs to know about the world. */
export interface LocomotionContext {
  /** Ground probe result: is there ground under us, and what does it look like? */
  grounded: boolean;
  /** Behavioural band of the ground slope. `Walkable` when airborne. */
  slopeBand: SlopeBand;
  /** Vertical velocity in m/s. Positive is up. */
  verticalVelocity: number;
  /** True when a ledge grab anchor was found within reach while airborne. */
  ledgeAvailable: boolean;
  /** True when the surface in front is an authored climbable wall. */
  climbSurfaceAvailable: boolean;
  /**
   * Height of a detected ledge directly in front, in metres above the player's feet.
   * 0 or negative means nothing mantleable was found.
   */
  mantleLedgeHeight: number;
  /** True while the player's capsule overlaps a water volume above a depth threshold. */
  inWater: boolean;
  /** True when the player is standing on a zip line anchor and pressed interact. */
  zipLineAvailable: boolean;
  /** True when a jump request exists (raw press, or a still-open buffer window). */
  jumpRequested: boolean;
  /** True when the current mantle's animation has finished its work. */
  mantleComplete: boolean;
  /** True when the player has released all input while hanging. */
  hangingInputReleased: boolean;
  /** Speed magnitude in the horizontal plane, m/s. */
  horizontalSpeed: number;
}

/**
 * Resolve the next locomotion state.
 *
 * ─── COMMANDMENT: LOGIC FIRST, ANIMATION FOLLOWS ────────────────────────────────────
 * No transition here waits for an animation. A player who presses jump during a mantle
 * gets a jump *this tick*; the mantle's animation is cosmetic and is cut short. Every
 * transition is decided from input and world state alone, which is what keeps the
 * controller responsive rather than feeling like it is buffering commands.
 *
 * The priority order below is deliberate. Reading it top to bottom answers "what wins when
 * several conditions are true at once", which is otherwise the source of subtle and
 * unreproducible bugs:
 *
 *   1. Zip line  — the player has committed to a scripted traversal
 *   2. Water     — submersion overrides everything else physically
 *   3. Mantle    — in progress unless cancelled by a jump (edge case 6)
 *   4. Ledge hang— airborne grab, or holding on
 *   5. Climb     — attach when input and a surface are both present
 *   6. Airborne  — whenever not on the ground
 *   7. Grounded  — the default
 *
 * @param current - The active state.
 * @param context - The world snapshot.
 * @param intent - The resolved player intent.
 * @returns The state for the next tick.
 */
export function resolveLocomotionState(
  current: LocomotionState,
  context: LocomotionContext,
  intent: CharacterIntent,
): LocomotionState {
  // ── 1. Zip line. Entered on interaction; left only when the line ends. ──────────
  if (current === LocomotionState.ZipLine) {
    return context.mantleComplete ? LocomotionState.Airborne : LocomotionState.ZipLine;
  }
  if (context.zipLineAvailable && intent.interactRequested && current !== LocomotionState.Climb) {
    return LocomotionState.ZipLine;
  }

  // ── 2. Water. Submersion physically overrides land locomotion. ──────────────────
  if (context.inWater) {
    return LocomotionState.Water;
  }
  if (current === LocomotionState.Water) {
    // Leaving water: grounded if there is ground underfoot, otherwise airborne.
    return context.grounded ? LocomotionState.Grounded : LocomotionState.Airborne;
  }

  // ── 3. Mantle. Committed, but cancellable — edge case 6. ────────────────────────
  if (current === LocomotionState.Mantle) {
    // A jump during a mantle cancels it immediately and hands control back to the air.
    // The player is never trapped in an animation waiting for it to finish; this is the
    // "logic first, animation follows" constraint made concrete.
    if (context.jumpRequested) {
      return LocomotionState.Airborne;
    }
    if (context.mantleComplete) {
      return context.grounded ? LocomotionState.Grounded : LocomotionState.Airborne;
    }
    return LocomotionState.Mantle;
  }

  // ── 4. Ledge hang. Airborne grab, then hold until the player chooses. ───────────
  if (current === LocomotionState.LedgeHang) {
    // Jump away from the wall — edge case 9.
    if (context.jumpRequested) {
      return LocomotionState.Airborne;
    }
    // Dismissing the grab (releasing all input) is how the player drops — edge case 8.
    // A partial pull-up that is abandoned must fall, never freeze.
    if (context.hangingInputReleased) {
      return LocomotionState.Airborne;
    }
    if (context.mantleComplete) {
      return LocomotionState.Grounded;
    }
    return LocomotionState.LedgeHang;
  }

  // Airborne grab: only while descending slowly enough to be plausibly caught.
  // The fall-speed limit is what stops a player snatching a ledge at terminal velocity,
  // which looks absurd and trivialises long drops.
  if (
    !context.grounded &&
    context.ledgeAvailable &&
    context.verticalVelocity <= 0 &&
    Math.abs(context.verticalVelocity) <= 1.0
  ) {
    return LocomotionState.LedgeHang;
  }

  // ── 5. Climb. Requires an authored surface plus intent to engage. ───────────────
  if (current === LocomotionState.Climb) {
    if (context.jumpRequested) {
      // Jumping off a climbable surface launches away from it.
      return LocomotionState.Airborne;
    }
    if (!context.climbSurfaceAvailable) {
      // Ran out of surface — fall rather than hang in place (GDD climb edge case 6).
      return LocomotionState.Airborne;
    }
    if (intent.moveDirection.x === 0 && intent.moveDirection.z === 0 && context.grounded) {
      // Reached the top of the wall and stepped onto ground.
      return LocomotionState.Grounded;
    }
    return LocomotionState.Climb;
  }

  // Engaging a climb requires holding toward the surface while pressing into it. The
  // `moveMagnitude` requirement stops a player from being captured by a climbable wall
  // merely by brushing past it.
  if (
    context.climbSurfaceAvailable &&
    !context.grounded &&
    intent.moveMagnitude > 0.1 &&
    current === LocomotionState.Airborne
  ) {
    return LocomotionState.Climb;
  }

  // ── 3b. Mantle initiation from the ground or air, when a low ledge is ahead. ────
  // Only when grounded or moving into the ledge; a mantle triggered by walking past a
  // ledge sideways would feel like a loss of control.
  if (
    context.mantleLedgeHeight > 0 &&
    intent.moveMagnitude > 0.1 &&
    (context.grounded || context.verticalVelocity <= 0)
  ) {
    return LocomotionState.Mantle;
  }

  // ── 6/7. Airborne versus grounded. ─────────────────────────────────────────────
  return context.grounded ? LocomotionState.Grounded : LocomotionState.Airborne;
}

/**
 * Whether the given state permits the player to initiate a jump.
 *
 * Exposed as a function rather than left implicit so that "can I jump right now?" has
 * exactly one answer in the codebase. Two places disagreeing about this is precisely how
 * a jump input gets silently swallowed.
 *
 * @param state - The active locomotion state.
 * @param slopeBand - The ground's slope band, which forbids jumping on steep ground.
 * @returns True when a jump may start.
 */
export function canJump(state: LocomotionState, slopeBand: SlopeBand): boolean {
  switch (state) {
    case LocomotionState.Grounded:
      // GDD §4.5: jumping is forbidden on the 30-45 degree band. On a slide band the
      // player is already falling, so a jump would be indistinguishable from a step.
      return slopeBand === SlopeBand.Walkable;
    case LocomotionState.Airborne:
      return false; // no double jumps
    case LocomotionState.Mantle:
      return true; // cancels the mantle (edge case 6)
    case LocomotionState.LedgeHang:
      return true; // leaps away from the wall (edge case 9)
    case LocomotionState.Climb:
      return true; // jumps off the surface
    case LocomotionState.Water:
      return false; // surface swimming is a separate mechanic, not a jump
    case LocomotionState.ZipLine:
      return false; // disarmed by design: the zip line must not be a combat escape
  }
}

/**
 * Whether the player may control horizontal movement in the given state.
 *
 * @param state - The active locomotion state.
 * @returns True when movement input applies normally. Climb and zip line are excluded
 *   because they interpret input in their own frame of reference.
 */
export function hasFreeMovement(state: LocomotionState): boolean {
  return (
    state === LocomotionState.Grounded ||
    state === LocomotionState.Airborne ||
    state === LocomotionState.Water
  );
}

/**
 * Whether the player is in a state from which a fall is possible.
 *
 * Used by the respawn safety net to decide whether a large fall is expected behaviour.
 *
 * @param state - The active locomotion state.
 * @returns True when the state is supported only by the player's grip or momentum.
 */
export function isPrecarious(state: LocomotionState): boolean {
  return (
    state === LocomotionState.LedgeHang ||
    state === LocomotionState.Climb ||
    state === LocomotionState.ZipLine
  );
}
