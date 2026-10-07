/**
 * Unit tests for the discarding locomotion state machine.
 *
 * These run without a physics world, a renderer, or a game loop — which is the whole point
 * of keeping the transition function pure. Every illegal combination and every boundary can be
 * constructed directly, so "I think the player cannot aim while climbing" becomes an assertion
 * instead of a hope.
 *
 * The risk this addresses is R15 from docs/RISK_ANALYSIS.md: independent state booleans grow
 * into 2ⁿ combinations, illegal states become representable, and the resulting bugs ("the
 * player is occasionally stuck in a corner doing nothing") are unreproducible. With one
 * discarding state, an illegal combination cannot be expressed at all — and these tests prove
 * the transitions that *can* be expressed behave.
 */

import { describe, it, expect } from 'vitest';
import {
  canJump,
  hasFreeMovement,
  isPrecarious,
  LocomotionState,
  NULL_INTENT,
  resolveLocomotionState,
  type CharacterIntent,
  type LocomotionContext,
} from '../../src/gameplay/LocomotionStates';
import { SlopeBand } from '../../src/core/math/locomotion';

/** A neutral context: standing on flat ground, still, nothing special nearby. */
function context(overrides: Partial<LocomotionContext> = {}): LocomotionContext {
  return {
    grounded: true,
    slopeBand: SlopeBand.Walkable,
    verticalVelocity: 0,
    ledgeAvailable: false,
    climbSurfaceAvailable: false,
    mantleLedgeHeight: 0,
    inWater: false,
    zipLineAvailable: false,
    jumpRequested: false,
    mantleComplete: false,
    hangingInputReleased: false,
    horizontalSpeed: 0,
    ...overrides,
  };
}

/** An intent that is pushing forward at full speed. */
const FORWARD: CharacterIntent = {
  ...NULL_INTENT,
  moveDirection: { x: 0, z: 1 },
  moveMagnitude: 1,
};

/** An intent with jump pressed this tick. */
const JUMP: CharacterIntent = { ...NULL_INTENT, jumpRequested: true, jumpHeld: true };

describe('resolveLocomotionState — the default transitions', () => {
  it('stays grounded on flat ground with no input', () => {
    expect(resolveLocomotionState(LocomotionState.Grounded, context(), NULL_INTENT)).toBe(
      LocomotionState.Grounded,
    );
  });

  it('goes airborne when the ground disappears', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.Grounded,
        context({ grounded: false, verticalVelocity: -1 }),
        NULL_INTENT,
      ),
    ).toBe(LocomotionState.Airborne);
  });

  it('returns to the ground on landing', () => {
    expect(
      resolveLocomotionState(LocomotionState.Airborne, context({ grounded: true }), NULL_INTENT),
    ).toBe(LocomotionState.Grounded);
  });

  it('stays airborne while falling with no ground underfoot', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.Airborne,
        context({ grounded: false, verticalVelocity: -5 }),
        NULL_INTENT,
      ),
    ).toBe(LocomotionState.Airborne);
  });
});

describe('priority — which state wins when several conditions are true at once', () => {
  it('water overrides everything except the zip line', () => {
    // Submersion is a physical override. If a swimmer could still be "grounded", the
    // controller would fight the water volume every tick.
    expect(
      resolveLocomotionState(
        LocomotionState.Airborne,
        context({ inWater: true, grounded: true, mantleLedgeHeight: 1.0 }),
        FORWARD,
      ),
    ).toBe(LocomotionState.Water);
  });

  it('the zip line wins over water, because the player is gripping a cable', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.ZipLine,
        context({ inWater: true }),
        NULL_INTENT,
      ),
    ).toBe(LocomotionState.ZipLine);
  });

  it('leaving water resolves to the ground or the air, never to water forever', () => {
    expect(
      resolveLocomotionState(LocomotionState.Water, context({ inWater: false, grounded: true }), NULL_INTENT),
    ).toBe(LocomotionState.Grounded);
    expect(
      resolveLocomotionState(
        LocomotionState.Water,
        context({ inWater: false, grounded: false }),
        NULL_INTENT,
      ),
    ).toBe(LocomotionState.Airborne);
  });

  it('a mantle in progress is not interrupted by walking input', () => {
    // Only a jump cancels a mantle. If forward movement cancelled it too, a player who held
    // forward while climbing a ledge would never finish the climb and would be stuck bouncing
    // off the lip.
    expect(
      resolveLocomotionState(
        LocomotionState.Mantle,
        context({ grounded: false, mantleLedgeHeight: 1.0 }),
        FORWARD,
      ),
    ).toBe(LocomotionState.Mantle);
  });

  it('a completed mantle hands control to the ground or air', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.Mantle,
        context({ grounded: true, mantleComplete: true }),
        NULL_INTENT,
      ),
    ).toBe(LocomotionState.Grounded);
    expect(
      resolveLocomotionState(
        LocomotionState.Mantle,
        context({ grounded: false, mantleComplete: true }),
        NULL_INTENT,
      ),
    ).toBe(LocomotionState.Airborne);
  });
});

describe('Edge case 6 at the state level — a jump cancels a mantle', () => {
  it('cancels immediately and hands control to the air', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.Mantle,
        context({ jumpRequested: true, grounded: false }),
        JUMP,
      ),
    ).toBe(LocomotionState.Airborne);
  });

  it('cancels even when the mantle was nearly finished', () => {
    // The "logic first, animation follows" constraint: the player is never trapped waiting for
    // an animation to complete. A mantle 99% done still yields to a jump.
    expect(
      resolveLocomotionState(
        LocomotionState.Mantle,
        context({ jumpRequested: true, mantleComplete: true }),
        JUMP,
      ),
    ).toBe(LocomotionState.Airborne);
  });
});

describe('Edge case 9 at the state level — a jump leaves a ledge hang', () => {
  it('leaves the hang for the air', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.LedgeHang,
        context({ jumpRequested: true, grounded: false, verticalVelocity: 0 }),
        JUMP,
      ),
    ).toBe(LocomotionState.Airborne);
  });

  it('does not immediately re-grab the ledge it just jumped from', () => {
    // The classic failure: jumping away from a ledge and being instantly recaptured by the
    // same ledge detection on the next tick, so the player cannot let go and cannot climb.
    // The jump is requested with a downward-then-upward velocity, and the state machine must
    // prefer the jump.
    const justJumped = context({
      ledgeAvailable: true,
      jumpRequested: true,
      grounded: false,
      verticalVelocity: 2.0,
    });
    expect(resolveLocomotionState(LocomotionState.LedgeHang, justJumped, JUMP)).toBe(
      LocomotionState.Airborne,
    );
  });
});

describe('Edge case 8 at the state level — releasing a hang always resolves', () => {
  it('drops when the hanging input is released', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.LedgeHang,
        context({ hangingInputReleased: true, grounded: false }),
        NULL_INTENT,
      ),
    ).toBe(LocomotionState.Airborne);
  });

  it('never returns LedgeHang once the input has been released', () => {
    // The softlock this prevents: a player releases the controls expecting to fall, the ledge
    // detection immediately re-grabs on the same tick, and they hang forever with no input.
    const released = context({ ledgeAvailable: true, hangingInputReleased: true, grounded: false });
    const next = resolveLocomotionState(LocomotionState.LedgeHang, released, NULL_INTENT);
    expect(next).not.toBe(LocomotionState.LedgeHang);
  });

  it('a completed pull-up from a hang lands on the ground', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.LedgeHang,
        context({ mantleComplete: true, grounded: true }),
        NULL_INTENT,
      ),
    ).toBe(LocomotionState.Grounded);
  });
});

describe('Edge case 7 at the state level — a non-climbable surface never traps', () => {
  it('does not enter Climb when no climbable surface is present', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.Airborne,
        context({ climbSurfaceAvailable: false, grounded: false, verticalVelocity: -2 }),
        FORWARD,
      ),
    ).toBe(LocomotionState.Airborne);
  });

  it('falls out of Climb when the surface ends', () => {
    // GDD climb edge case 6: reaching the top of a climbable surface, or losing contact with
    // it, must drop the player rather than leave them attached to nothing.
    expect(
      resolveLocomotionState(
        LocomotionState.Climb,
        context({ climbSurfaceAvailable: false, grounded: false }),
        FORWARD,
      ),
    ).toBe(LocomotionState.Airborne);
  });

  it('requires deliberate input to attach, so brushing past a wall does not capture', () => {
    // A climb that engages on contact reads as the game taking control away from the player.
    expect(
      resolveLocomotionState(
        LocomotionState.Airborne,
        context({ climbSurfaceAvailable: true, grounded: false, verticalVelocity: -1 }),
        NULL_INTENT,
      ),
    ).toBe(LocomotionState.Airborne);
  });

  it('attaches when the player pushes into the surface', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.Airborne,
        context({ climbSurfaceAvailable: true, grounded: false, verticalVelocity: -1 }),
        FORWARD,
      ),
    ).toBe(LocomotionState.Climb);
  });
});

describe('ledge grab reachability', () => {
  it('grabs a ledge while falling slowly', () => {
    expect(
      resolveLocomotionState(
        LocomotionState.Airborne,
        context({ ledgeAvailable: true, grounded: false, verticalVelocity: -0.5 }),
        FORWARD,
      ),
    ).toBe(LocomotionState.LedgeHang);
  });

  it('refuses to grab while travelling upward', () => {
    // Rising past a ledge should not snag it: the player intended to jump over, not hang.
    expect(
      resolveLocomotionState(
        LocomotionState.Airborne,
        context({ ledgeAvailable: true, grounded: false, verticalVelocity: 4 }),
        FORWARD,
      ),
    ).toBe(LocomotionState.Airborne);
  });

  it('refuses to grab while falling fast', () => {
    // Snatching a ledge at terminal velocity looks absurd and would trivialise long drops.
    expect(
      resolveLocomotionState(
        LocomotionState.Airborne,
        context({ ledgeAvailable: true, grounded: false, verticalVelocity: -20 }),
        FORWARD,
      ),
    ).toBe(LocomotionState.Airborne);
  });
});

describe('canJump — one answer per question', () => {
  it('allows a jump only from the walkable ground band', () => {
    expect(canJump(LocomotionState.Grounded, SlopeBand.Walkable)).toBe(true);
    expect(canJump(LocomotionState.Grounded, SlopeBand.Slow)).toBe(false);
    expect(canJump(LocomotionState.Grounded, SlopeBand.Slide)).toBe(false);
    expect(canJump(LocomotionState.Grounded, SlopeBand.Unclimbable)).toBe(false);
  });

  it('forbids a double jump', () => {
    expect(canJump(LocomotionState.Airborne, SlopeBand.Walkable)).toBe(false);
  });

  it('allows jumping out of a mantle, a hang, or a climb', () => {
    // All three are deliberate escapes: the player must always be able to leave.
    expect(canJump(LocomotionState.Mantle, SlopeBand.Walkable)).toBe(true);
    expect(canJump(LocomotionState.LedgeHang, SlopeBand.Walkable)).toBe(true);
    expect(canJump(LocomotionState.Climb, SlopeBand.Walkable)).toBe(true);
  });

  it('disarms the jump on a zip line, so it is not a combat escape', () => {
    expect(canJump(LocomotionState.ZipLine, SlopeBand.Walkable)).toBe(false);
  });

  it('has an answer for every state, with none falling through', () => {
    // Exhaustive over the enum, so adding a state without deciding its jump rule fails here
    // rather than silently defaulting.
    for (const state of Object.values(LocomotionState)) {
      const result = canJump(state, SlopeBand.Walkable);
      expect(typeof result, state).toBe('boolean');
    }
    expect(Object.values(LocomotionState)).toHaveLength(7);
  });
});

describe('hasFreeMovement and isPrecarious', () => {
  it('permits free movement in exactly the three supported states', () => {
    expect(hasFreeMovement(LocomotionState.Grounded)).toBe(true);
    expect(hasFreeMovement(LocomotionState.Airborne)).toBe(true);
    expect(hasFreeMovement(LocomotionState.Water)).toBe(true);

    expect(hasFreeMovement(LocomotionState.Mantle)).toBe(false);
    expect(hasFreeMovement(LocomotionState.LedgeHang)).toBe(false);
    expect(hasFreeMovement(LocomotionState.Climb)).toBe(false);
    expect(hasFreeMovement(LocomotionState.ZipLine)).toBe(false);
  });

  it('flags the three grip-dependent states as precarious', () => {
    // The stuck watchdog keys off this, so getting the membership wrong either misses a
    // genuine softlock or rescues a player who is simply standing still.
    expect(isPrecarious(LocomotionState.LedgeHang)).toBe(true);
    expect(isPrecarious(LocomotionState.Climb)).toBe(true);
    expect(isPrecarious(LocomotionState.ZipLine)).toBe(true);

    expect(isPrecarious(LocomotionState.Grounded)).toBe(false);
    expect(isPrecarious(LocomotionState.Airborne)).toBe(false);
    expect(isPrecarious(LocomotionState.Mantle)).toBe(false);
    expect(isPrecarious(LocomotionState.Water)).toBe(false);
  });
});

describe('R15 — illegal states are structurally unrepresentable', () => {
  it('the state is a single value, not a set of flags', () => {
    // The risk R15 mitigation, asserted directly. If this ever became a bitmask or an object
    // of booleans, "climbing while mantling while swimming" would become expressible and the
    // whole class of unreproducible softlocks would come back.
    const result = resolveLocomotionState(LocomotionState.Grounded, context(), NULL_INTENT);
    expect(typeof result).toBe('string');
    expect(Object.values(LocomotionState)).toContain(result);
  });

  it('every state resolves to exactly one successor, whatever the context', () => {
    // Exhaustive: 7 states x a matrix of context combinations. There is no input that produces
    // two simultaneous states, because there is only one slot.
    const contexts = [
      context(),
      context({ grounded: false, verticalVelocity: -5 }),
      context({ inWater: true }),
      context({ jumpRequested: true }),
      context({ mantleComplete: true, grounded: false }),
      context({ ledgeAvailable: true, grounded: false, verticalVelocity: -0.5 }),
      context({ climbSurfaceAvailable: true, grounded: false, verticalVelocity: -1 }),
      context({ hangingInputReleased: true, grounded: false }),
      context({ zipLineAvailable: true }),
      context({ mantleLedgeHeight: 1.0, grounded: false, verticalVelocity: -1 }),
    ];

    for (const state of Object.values(LocomotionState)) {
      for (const ctx of contexts) {
        for (const intent of [NULL_INTENT, FORWARD, JUMP]) {
          const next = resolveLocomotionState(state, ctx, intent);
          expect(Object.values(LocomotionState), `${state} + ${intent.moveMagnitude}`).toContain(
            next,
          );
        }
      }
    }
  });

  it('never emits NaN or undefined from any combination', () => {
    // A transition function that returns undefined would make the controller's `switch` fall
    // through to the default branch, silently freezing horizontal movement. Worth an explicit
    // sweep given how quiet that failure would be.
    for (const state of Object.values(LocomotionState)) {
      for (const ctx of [context(), context({ inWater: true, grounded: false })]) {
        const next = resolveLocomotionState(state, ctx, NULL_INTENT);
        expect(next).toBeDefined();
        expect(typeof next).toBe('string');
      }
    }
  });
});
