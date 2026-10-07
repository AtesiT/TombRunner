# `src/gameplay` — the character controller and the player's moment-to-moment movement

This directory turns *input* into *motion*. It is where the game either feels like a person
running through a jungle or like a cursor being dragged over terrain, and almost all of that
difference lives in about six numbers and one structural decision.

---

## The one structural decision: a discarding state machine

`LocomotionStates.ts` defines exactly **seven** mutually exclusive states:

```
grounded · airborne · mantle · ledge-hang · climb · water · zip-line
```

The obvious alternative — a handful of independent booleans (`isGrounded`, `isClimbing`,
`isAiming`, `isMantling`) — is how controllers are usually written and why they are usually
buggy. Four booleans express sixteen combinations, most of which are nonsense, and every
consumer must then reason about all of them. The bugs that result ("the player is occasionally
stuck in a corner doing nothing") are the worst kind: rare, unreproducible, and impossible to
write a regression test for.

With one discarding state, **illegal combinations are not prevented — they are unrepresentable.**
There is no way to express "climbing while mantling" because there is only one slot.

Two rules keep this honest:

1. **One discarding machine per axis of exclusivity, and no more.** Crouch, aiming and health are
   *not* in this enum, because a player can genuinely crouch while grounded, airborne or idle.
   Folding them in would double the state count and recreate the very explosion the design avoids.
   They live in the intent and in separate machines.
2. **Transitions are a pure function** — `resolveLocomotionState(state, context, intent)`. It
   touches nothing, which is why every boundary and every illegal input can be asserted without a
   physics world, a renderer, or a game loop.

### Logic first, animation follows

No transition waits for an animation. A jump pressed during a mantle cancels it on that same
tick; the animation is cosmetic and is cut short. Animation-driven windows demo well and play
badly: the player presses a button, nothing happens for 200 ms, and the game feels broken.
Every transition is decided from input and world state alone.

### Transition priority

Read top to bottom — this answers "what wins when several conditions are true at once", which is
otherwise a reliable source of subtle bugs:

| Priority | State | Rationale |
|---|---|---|
| 1 | Zip line | The player has committed to a scripted traversal |
| 2 | Water | Submersion overrides land locomotion physically |
| 3 | Mantle | In progress unless jump-cancelled (edge case 6) |
| 4 | Ledge hang | Airborne grab, then hold until the player chooses |
| 5 | Climb | Authored surface plus deliberate input |
| 6 | Airborne | Whenever not supported |
| 7 | Grounded | The default |

---

## The second decision: an arc is solved against the gravity that will actually be applied

`src/core/math/locomotion.ts` is the only place jump numbers are computed, and
`effectiveRiseGravity()` is the only place the hold-scaling is applied.

This exists because of a real bug. The controller originally solved the trajectory with the
nominal rise gravity (26 m/s²) while the integrator applied a hold-scaled one (26 × 0.75). A held
jump therefore peaked at 2.67 m instead of the documented 2.0 m and overshot its distance target
by 26%. The lesson is not "multiply in the right place" — it is that **any physical quantity
computed in two places will eventually disagree, and the fix is to make it computable in one.**

### Derived, not hand-picked

The controller does not read a table of jump speeds. It calls `solveJumpLaunch()`, which derives
both the vertical takeoff velocity and the horizontal speed from the GDD's target peak height and
target distance — under the gravity profile that will actually be applied.

The consequence worth knowing: **the GDD's 6 m running jump is unreachable at the documented 6 m/s
run speed.** With 26 m/s² rise and 42 m/s² fall gravity, a 2.5 m peak gives 0.85 s of airtime, so
6 m/s covers only 4.70 m. Three options were considered:

- *Weaken gravity* — rejected: it makes the jump floaty and undoes the whole point of asymmetric
  gravity, which is the single largest contributor to the TR2013 feel.
- *Raise run speed* — rejected: it makes ground movement frantic and contradicts the GDD's own
  walk/run numbers.
- **A forward impulse at takeoff** — chosen. A running jump thrusts forward, which is what
  momentum-based platformers do and what "a running jump goes further than a standing one" is
  actually describing.

Two discretisation corrections follow from the same principle — the specification should be
literally true, not true up to a few percent:

- `discreteTakeoffVelocity()` compensates semi-implicit Euler, which peaks `v0·dt/2` above the
  target (8.6 cm on a 2.0 m jump, measured).
- Airtime is counted in **whole ticks**, because a continuous airtime of 0.7533 s is not
  reachable. Dividing a distance target by a fractional airtime misses by the discarded fraction.

### The reference numbers

| Jump | Peak | Airtime | Launch speed | Horizontal |
|---|---|---|---|---|
| Standing (held) | 2.0 m | 0.767 s (46 ticks) | 3.913 m/s | 3.0 m |
| Running (held) | 2.5 m | 0.850 s (51 ticks) | 7.059 m/s | 6.0 m |

Measured end-to-end on the real controller: **2.997 m / 2.000 m** standing, **6.109 m / 2.498 m**
running (the extra 0.109 m is one tick of post-landing running).

---

## The third decision: raycasts are the ground truth, not `computedGrounded()`

`GroundProbe.ts` casts five rays — a centre plus four at 0.3 m — and takes a **majority vote**.
One stray ray must not claim ground, or a player could stand on the lip of a ledge and float.

The probe is ground truth rather than `computedGrounded()` because the engine's report cannot
supply the slope angle, the surface type, or the edge proximity that ledge detection and animation
need. Phase 0 also showed `computedGrounded()` can report `true` while a corrupted capsule is in
free fall.

Layer selection is explicit — `StaticWorld` and `PropDynamic` only. Trigger volumes and water
sensors are excluded because including them would let the player stand on a checkpoint volume or on
the surface of water. That is not a hypothetical; it is the natural consequence of querying
everything.

### The probe length is derived from the capsule, and this mattered enormously

`GROUND_PROBE_LENGTH_M` is computed as `halfHeight + radius + controllerOffset + margin = 1.17 m`,
not written as a literal.

It was originally 0.45 m, which meant the ray could **never** reach the floor. The failure was
almost invisible: the character did not fall through the world, Rapier caught it,
`computedGrounded()` returned `true` throughout, and the player could walk and run normally. The
controller was simply never told they were standing on anything, so the state machine stayed in
`Airborne` and **jumps could never fire**.

The GDD's own formula (`capsuleHalfHeight + 0.45`) is also wrong, because it omits the capsule
radius and ends up 2 cm short.

The trap generalises: **a probe that silently fails to hit anything produces no error, only wrong
answers.** No assertion of the form "is the character on the ground" can catch it, because the
character *was* on the ground. The regression test compares the ray's reach against the capsule's
actual dimensions instead.

---

## Files

| File | Contains | Tested by |
|---|---|---|
| `LocomotionStates.ts` | The seven-state enum, the pure transition function, `canJump` | `test/unit/locomotion-states.test.ts` (33) |
| `GroundProbe.ts` | The five-ray cone, majority vote, averaged normal, edge proximity | `test/integration/character-controller.test.ts` |
| `CharacterController.ts` | Owns velocity and state, integrates, drives the Rapier body | `test/integration/character-controller.test.ts` (25) |
| `../core/math/locomotion.ts` | All jump, slope, turning and window mathematics | `test/unit/locomotion.test.ts` (52) |

`CharacterController` is deliberately mostly **glue**: probe, resolve, integrate, hand the result
to Rapier. The decisions live in the modules above it, which is precisely what makes them testable
without an engine.

---

## The per-tick order, and why it is this order

```
1. Guard non-finite position     a NaN position is unrecoverable
2. Probe the ground              before deciding anything
3. Sample input windows          coyote/buffer, before resolving state
4. Resolve the locomotion state  pure function of 1-3
5. Project inherited velocity    BEFORE jump integration
6. Integrate velocity per state  including jump impulses
7. Move and collide              the single Rapier call
8. Post-move bookkeeping         landing, safety nets, window advance
```

Three orderings are load-bearing, and two of them were wrong in the first draft:

- **Probing precedes state resolution.** `computedGrounded()` is only valid *after* a move, so
  reading the engine's opinion and reacting to it would make every decision one tick stale.
- **Slope projection precedes jump integration.** Projecting velocity onto the ground plane
  removes the component pointing into the surface — which, applied *after* a jump, also removes the
  jump's upward impulse. Running uphill and jumping would silently do nothing. The projection only
  cleans up velocity the character *inherited*, so it must run before any new impulse.
- **Windows advance last**, so every consumer reads them at their current value. Advancing a
  window before its consumers would silently shorten every forgiveness window by one tick.

---

## Platform carry

Rapier's kinematic character controller does **not** carry a character along with a moving
collider: `moveAndSlide({0,0,0})` leaves the character exactly where it was while the platform
slides out from under it. Measured, not assumed — the first version of the test showed the
character moving 0.0 m.

So the controller derives the surface's velocity itself: remember where the ground collider was
last tick, and treat the difference as its velocity. That velocity is then (a) added to the
character's movement so they ride the platform, and (b) preserved at jump takeoff so the jump
inherits the platform's momentum.

Two traps handled:

- **Only compare against the same collider.** Otherwise stepping from one platform to an adjacent
  one registers a phantom velocity equal to the distance between them and flings the player.
- **A teleported surface must not become a catapult.** A platform moved 200 m between ticks reads
  as 12,000 m/s. A delta beyond a plausible platform speed is treated as "the surface was not
  really moving".

Note that the platform's velocity is **not** folded into the character's own velocity — a player
standing still on a moving platform has no horizontal velocity, and giving them one would make
them slide off when the platform stops.

---

## Testing

```bash
npx vitest run test/unit/locomotion.test.ts          # 52 — the mathematics
npx vitest run test/unit/locomotion-states.test.ts   # 33 — transitions, no engine needed
npx vitest run test/integration/character-controller.test.ts  # 25 — real Rapier, ten edge cases
```

The integration suite covers all ten mandatory edge cases from the brief, each asserting an
**observable outcome** rather than an internal flag. Asserting that a function returned `true`
proves only that the code agrees with itself; asserting that the character's y-coordinate did not
fall through the floor proves the game behaves — and it is how the silently-failed
platform-inheritance patch was caught.

### What is not tested, honestly

- **Feel.** Whether coyote time, the 150 ms buffer and the 0.25 steer weight *feel* right is
  unknowable without playing it. There is no browser or headless-render tooling in this
  environment.
- **`TURN_RATE_GROUND_DEG` and the 0.25 steer weight** are plausible numbers from the literature,
  not calibrated ones. Moving along the *facing* rather than along the input is the single biggest
  contributor to the feeling of mass and also the fastest way to make a character feel like a boat.
- **Ledge hanging (edge case 9) is tested at the rule level only**, because it needs authored climb
  surfaces from Milestone 2.3. The direction rule is tested exhaustively; the integration path is
  not. Testing the part that exists and saying so beats skipping the case.
- **The mantle geometry** is unvalidated against real level geometry — see doubt 3 in the DEV_LOG.
