# `src/input` — the input layer

Turns devices into intent, once per fixed simulation tick. Three files, split by what each one is
allowed to touch:

| File | Contains | Touches the browser? | Tested by |
|---|---|---|---|
| `Bindings.ts` | The action enum, the default table, conflict detection, unbind rules, serialisation, validation | **No.** Pure data in, pure data out | `test/unit/bindings.test.ts` (39) |
| `BindingStore.ts` | Reading and writing `localStorage`, and the probes that decide whether it can be used at all | Yes — the only file that does | `test/unit/bindings.test.ts` |
| `InputSystem.ts` | Event handlers, device polling, latches, the per-tick snapshot | Yes | `test/unit/input-system.test.ts` (58) |

The split is not tidiness for its own sake. The *interesting* logic — validation, conflict detection,
what "unbound" means, how a stored payload is repaired — is in the pure file, so it is testable
exhaustively in plain Node with no browser at all. What remains outside is small enough to audit in
one pass, and every part of it that could be wrong is still covered by a fake DOM.

---

## The architectural rule, and why it is worth stating twice

**Events latch. Ticks interpret. No logic in a handler.**

Every handler in `InputSystem` does one of two things: it sets a flag, or it adds to a number.
Anything resembling a decision happens inside `beginTick()`. This is `RISK_ANALYSIS.md` R10.1's
commitment, made in Phase 0.

The payoff is not cleanliness. It is that **the entire input path becomes testable by feeding
synthetic event sequences with exact control over when each event arrives relative to a tick** — and
that timing is the only thing that matters in input code. A press that begins and ends inside a
single tick is *the* central case, and it cannot be produced any other way.

---

## The buffer design

Both layers buffer jump: this one (150 ms, per the brief) and the character controller's own buffer
(also 150 ms, from Milestone 1.2). The failure mode if they are written naively is subtle and
serious: **the windows add up.** A press is held open by the input latch, delivered fresh every tick
while it is open, and then each delivery starts the controller's buffer again — giving ~300 ms of
forgiveness. The player experiences the character jumping when nothing was pressed, and blames the
physics.

So this layer's latch is **consumed on delivery**: handed over exactly once, cleared at that moment.
The two mechanisms then do different jobs:

| Mechanism | Job |
|---|---|
| **Input latch** (here) | Bridges input *events* to simulation *ticks*. A tap that starts and ends between two ticks is not lost; a press captured during a frame hitch is not swallowed |
| **Controller buffer** (`CharacterController`) | Holds an already-delivered press until the game *permits* it — landing, coyote time, cooldown |

Composition is `max()`, never `sum()`, and it is asserted by counting deliveries rather than by
trusting a flag.

Buffers are counted in **ticks**, never milliseconds. A millisecond window compared against
`performance.now()` drifts against simulated time whenever the frame rate differs from the tick rate
— which is exactly the situation the fixed timestep exists to handle.

---

## The five mandatory edge cases

| # | Case | How it is handled | Test |
|---|---|---|---|
| **IE1** | A held jump must not auto-jump | Only one-shot edges are latched (a named `EDGE_TRIGGERED_ACTIONS` set), `event.repeat` is ignored, and a second press *replaces* the pending latch rather than queueing behind it | 60 ticks of a held key produce exactly one request |
| **IE2** | Gamepad disconnect | Cleared on the event **and** on the next poll that reports the pad absent — because a real disconnect during a backgrounded tab may not fire the event at all, and the pad vanishing means the last stick value would otherwise latch forever | The character stops when the pad disappears; keyboard input works on the next tick with no intervening event |
| **IE3** | Sampling is per-tick, never per-event | The rule at the top of this document | A press-and-release inside one tick still produces a jump, end to end through the controller |
| **IE4** | Stick drift at rest | Radial deadzone applied at poll time, before anything reads the axes (GDD §5.4) | 300 ticks of a drifting stick produce zero rotation and zero movement |
| **IE5** | Corrupt or unknown persisted bindings | Versioned payload; unknown actions dropped; malformed entries fall back per-action; an empty list falls back for that action; a non-object payload falls back entirely | A sweep of twelve hostile payloads, each asserting that every action is still bound |

IE4 and IE5 were specified by me rather than named in the brief. The other two candidates — "both
devices used at once" and "focus loss" — are *recoverable* when they go wrong; the player presses
something and carries on. IE4 and IE5 are not: both produce a game that cannot be played and gives no
clue why.

---

## Decisions worth knowing

**Camera-relative movement lives here, not in the controller.** `CharacterIntent.moveDirection` is
world space, and `CharacterController` deliberately does not read the camera. The transform from "the
player pushed forward" to "walk that way in the world" therefore has to happen where both the device
state and the camera yaw are known, which is here. Without it, W would mean "move north" and the
character would strafe across the screen the moment the player turned the camera.

There is a feedback loop in that: movement comes from the camera yaw, and the camera auto-rotates
toward the movement direction. It is stable, it has a fixed point, and
`test/integration/input-camera-loop.test.ts` proves it rather than arguing about it.

**The gamepad has no "run" button, deliberately.** A stick's deflection *is* its speed, so on a pad
"how fast" is a continuous question with a continuous answer. A run button would be a second,
contradictory control over the same quantity. The keyboard is binary, so it needs the modifier; the
pad does not.

**Mouse buttons carry held state as well as edges.** The first draft latched the press and stopped,
which meant `Aim` — read through `isActionHeld` — could never be true, and right-click aiming did
nothing at all. The giveaway was the asymmetry: the release handler already removed the code from
the held set, so the two handlers disagreed about whether mouse buttons *had* held state. A release
that removes something a press never added is a contradiction, and worth noticing as one.

**Mouse look is raw and unsmoothed.** R10.2: "player-imposed smoothing must be a choice, not a
liberty taken on the player's behalf." Deltas accumulate in the handler and are scaled once per tick,
with the accumulator zeroed. No smoothing, no acceleration, no double-application.

---

## What is not here

| Not here | Why |
|---|---|
| A settings **screen** | GDD §10.1 puts settings UI in Phase 5. The system, the persistence and the conflict rules are this milestone; a list UI that will be rebuilt is not. The overlay carries a minimal `F3` capture so remapping is verifiable end-to-end across a real page reload |
| A sensitivity **slider** | Same. Sensitivity is a named constant so the overlay can expose it as a live tunable, which is where it needs to be to be *judged* anyway |
| Gamepad layouts beyond `standard` | Declining is honest; guessing is not. A non-standard pad logs once and is ignored |
| Rumble, touch, mobile | Mobile is declared out of scope in `RISK_ANALYSIS.md` R11; rumble is not in the GDD |
| Rebinding a **gamepad** button | Needs a polling loop watching for a fresh press. That belongs with the settings screen that will need it, not with a devtool |

## What the tests do not cover, honestly

The fake DOM reproduces `addEventListener`, `removeEventListener` and `dispatchEvent`, and nothing
else — no bubbling, no capture phase, no passive listeners. That is deliberate, because the system
listens on one target and never inspects propagation. It does mean that **a bug whose cause is event
propagation would not be caught here**, which is why the overlay's rebind capture documents the one
place this codebase depends on listener phase ordering.

Nothing here has been exercised against a real gamepad. The polling, the deadzones, the trigger
normalisation and the disconnect path are all written against the documented `standard` mapping and
tested against a fake that implements it faithfully — but "faithfully" is my reading of the spec, not
a measurement of a device. The DEV_LOG records this as an open doubt with the checklist that would
close it.
