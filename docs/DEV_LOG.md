# Jungle Relic — Development Log

> Every entry follows the mandated structure: **What I Built · Problems Encountered · Alternatives Considered · Doubts & Uncertainties · Next Steps.**
> Deep-debug analyses are appended as `### Deep Debug Session: [Bug Name]` when a problem survives three fix attempts.
> Workarounds are always logged with a severity rating. Nothing is silently hacked.

---

## 2026-10-07 (commit 5) — Milestone 1.3: The Camera Rig (IN PROGRESS)

*Written before the code, per RULE #2. What I built, what broke, what I rejected and what I
doubt will be filled in before the commit.*

### Scope

The GDD's camera section (5.1–5.4) is substantially richer than my earlier summary of it. It
specifies not just a spring arm but a **contextual mode system with an explicit priority order**,
a stuck detector, an asymmetric smoothing pair, a ground clamp with re-solve, and ten enumerated
edge cases. I am implementing the mechanism in full, including modes whose triggers cannot fire
yet, because the resolver is pure and testable regardless.

| GDD §5.1 | Value |
|---|---|
| Shoulder offset | +0.50 m right (0.15 m while aiming) |
| Distance | 4.0 m default |
| Height | +1.45 m above the player origin |
| Pitch range | −60° … +45°, asymmetric — the game is about looking *down* at footing |
| FOV | 60° default → 45° aiming → 52° in corridors |
| Follow damping | 0.10 positional, 0.15 rotational |
| Auto-rotate | After 0.5 s idle, align behind the player's facing at 1.2 rad/s |

| GDD §5.2 | Behaviour |
|---|---|
| Cast | Sphere of radius 0.25 from the head pivot, `STATIC_WORLD` only |
| On hit | Place at `hit − skin(0.15)`, clamped to a 1.5 m minimum |
| Asymmetric smoothing | Pull in at 0.35 (**correctness**), push out at 0.08 (**feel**) |
| Ground clamp | `y ≥ groundY + 0.5`, then re-solve the arm |
| Stuck detector | 2.0 s pinned at minimum, or 0.5 s inside geometry → 0.4 s interpolate to the fallback |

### Implementation decisions

**1. All camera mathematics goes in `src/core/math/camera.ts` and is unit-tested.**

Same mandate as Milestone 1.1's shader maths and 1.2's jump maths: if it is a formula, it lives in
a tested pure module and the class is glue. The camera particularly benefits, because its bugs are
*feel* bugs — an off-by-one in a damping factor produces a camera that is subtly wrong rather than
visibly broken, and nothing catches that except an assertion.

**2. Two of the GDD's damping constants are specified as per-frame lerps, and per-frame lerps are
frame-rate dependent. They will be converted to exponential rates.**

The GDD says "lerp 0.10" and "pull-in at lerp 0.35". Read literally, that means
`current += (target − current) × 0.10` once per frame. That produces a *different camera* at 144 Hz
than at 60 Hz — a faster pull-in, a snappier follow — and on a machine that dips between the two
it produces a camera whose damping changes mid-motion.

The fix is the standard exponential form: `current += (target − current) × (1 − exp(−λ·dt))`, with
λ derived from the authored per-frame factor at a reference rate so the GDD's *numbers* are still
what a 60 Hz player experiences. The authored figures are honoured; only the interpretation becomes
rate-independent. This is exactly the kind of quiet, unglamorous correctness that RULE #5's 60 FPS
target actually depends on, and it is worth a dedicated test.

**3. Asymmetric smoothing is not a nicety — the two directions have different jobs.**

Pulling in must be *immediate*, because a frame spent clipping through a wall is a visible defect.
Pushing out must be *slow*, because a camera that whips back the instant an obstruction clears is
disorienting. Conflating them into one rate means either visible clipping (if tuned for feel) or a
nauseating whip (if tuned for correctness). The GDD's 0.35/0.08 split is right and I am keeping it,
translated into exponential rates.

**4. The spring arm casts a sphere, not a ray.**

`CAMERA_PROBE_RADIUS_M = 0.25` and the constant's own comment says why: a ray can pass through a
gap that the near plane cannot, and the result is geometry popping through the lens. A sphere cast
is the correct primitive. I will use Rapier's shape cast — with the argument-order trap from Phase 0
in mind and the alternative (cast several rays through a disc) available if the semantics are not
what I expect.

**5. Mode transitions are lerped, never cut, and the priority order is resolved in one pure
function.**

`resolveCameraMode(triggers)` returns exactly one mode, so "ties are impossible by construction" as
the GDD claims. Testing that claim means enumerating trigger combinations and asserting the winner,
which is only possible because the resolver is pure.

**6. Teleport detection comes from the controller's existing rescue event, not a distance
heuristic.**

The GDD requires that respawn *snaps* the camera rather than interpolating 60 m across the level. I
already have an authoritative signal — `CharacterController.lastEvents.rescued` — which is set for
exactly the cases that teleport the player (kill plane, NaN position, stuck watchdog). Using it
rather than "position jumped more than N metres" means the two systems cannot disagree about what
counted as a teleport, which is P1 from the last milestone in a different costume.

The `setSpawnPoint` path can also move the player, so the rig *also* keeps a large-delta guard as a
backstop — but the event is the primary signal, and the guard exists so that a future teleport path
that forgets to raise the event degrades to a snap rather than to a nausea-inducing fly-through.

### The eight edge cases this milestone must handle

The GDD lists ten; two depend on systems that do not exist yet (a cutscene driver, and a death
sequence from the combat milestone). I am implementing and testing the eight that are reachable,
and recording the two deferrals explicitly rather than silently passing over them.

1. **Camera never clips through geometry.** A wall between the player and the camera.
2. **Camera never goes below the floor**, and the arm is re-solved after the clamp. Steep
   down-look near the ground.
3. **Teleport and respawn snap, never lerp.** A lerp across the level is genuinely nauseating.
4. **A corner wedge forces a reset after 2.0 s.** The contained case where the arm is pinned and no
   amount of smoothing gets the player out.
5. **The asymmetric spring arm**, tested in both directions on the same obstruction appearing and
   then clearing: fast in, slow out, and no oscillation against a flat wall.
6. **The aim transition** — 60°→45° over 0.18 s, reversible mid-flight, interruptible, never
   overshooting and never sticking part-way.
7. **Pitch clamping** — never exceeds the asymmetric limits, and never flips over the pole where a
   grazing angle would otherwise invert the view.
8. **Auto-rotate never fights the player** — suspended while input arrives, beginning after exactly
   0.5 s of idleness, and never rotating while a manual input is held.

Plus one the GDD calls out as "a genuinely common reported bug in shipped games" and which is cheap
to get right now: **9. the right-stick deadzone is applied before integration**, so a drifting
stick cannot slowly rotate the camera. I am including it because "cheap now, impossible to debug
later" is the whole argument for doing it here.

### Deferred, and stated rather than glossed

- **Cinematic mode** (GDD 5.3, 5.4 case 4) needs a story-beat driver, which is Milestone 3. The
  *mode* and its priority are implemented and tested; only the trigger is absent.
- **Death orbit** (GDD 5.4 case 9) needs a death sequence, which is Milestone 2's combat work.
- **Water mode's screen tint** and the **narrow-corridor authored volumes** need the level to carry
  those volumes, which is Milestone 3's level-and-narrative pass. The mode transitions themselves
  are implemented; the triggers light up when the volumes exist.

### Doubts carried in

1. **I still cannot see this.** A camera is the single most *feel*-critical system in the project and
   the least verifiable by assertion. I can prove it does not clip, does not flip and does not fight
   the player. I cannot prove it feels good. This is now the fifth commit with that caveat and it is
   the same caveat each time, which is itself information: the risk is not shrinking.
2. **`CAMERA_PROBE_RADIUS_M = 0.25` is a guess.** Too small and geometry pokes through the near
   plane; too large and the camera pulls in constantly in tight spaces, which feels claustrophobic.
   Untested against real geometry.
3. **Mouse sensitivity is unspecified in absolute terms** ("radians per pixel, raw"). I will pick a
   value that corresponds to a plausible 360°-per-mouse-sweep and note it as unvalidated.
4. **Mode transition durations are only specified for Aim (0.18 s).** The others will get the same
   duration by default, which may be wrong for the larger climbs and zip-line framings — a 4 m to
   5.5 m boom change in 0.18 s is fast.
5. **The `lerp 0.10` conversion to λ is a judgement call about the reference rate.** I will use 60 Hz
   because that is the simulation rate, and note that a player on a 144 Hz display with the naive
   reading would have had a measurably different camera — the bug this decision avoids.

### What I Built

**1. `src/core/math/camera.ts` — the pure camera mathematics (83 unit tests).**

Frame-rate-independent damping, the asymmetric spring arm, the pitch clamp, the orbit geometry,
the mode-priority resolver, the mode framing table, auto-rotation, the stuck detector, the radial
deadzone and the water wobble. Every one of these is a formula, so every one lives here rather than
in the rig. The rig ended up thin as a result, which is the point.

The single most valuable test in the file is the frame-rate one:

```ts
const oneBigStep   = damp(0, 100, rate, 2 / 60);
const twoSmallSteps = damp(damp(0, 100, rate, 1 / 60), 100, rate, 1 / 60);
expect(twoSmallSteps).toBeCloseTo(oneBigStep, 9);   // passes
```

The GDD's "lerp 0.10" read literally fails this badly: two frames close 19% of the gap, one closes
10%. `dampRateFromPerFrameLerp(lerp, hz) = −hz·ln(1−lerp)` makes the authored number mean what a
60 Hz player experiences while removing the frame-rate coupling entirely. `damp` also holds up over
a sweep of rates and durations, so it is genuinely a semigroup rather than coincidentally right at
one ratio.

**2. `PhysicsWorld.castSphere()` — the swept-sphere query, and a characterisation test for it.**

`castShape` takes `filterGroups` as its **9th** argument, not the 5th as `intersectionWithShape`
does, and passing collider-encoded groups matches *nothing* — silently, with no error. Phase 0
identified this trap and predicted it would be hit again. It very nearly was. So
`test/characterisation/shape-cast-semantics.test.ts` (8 tests) pins the semantics by measurement
before anything depends on them: the radius is honoured (a 0.25 m sphere stops at 2.75 m where a ray
from the same origin stops at 3.00), the direction is a velocity so a unit vector makes
`time_of_impact` metres, a miss past `maxDistance` returns `null` rather than clamping, and the two
group encodings differ in their high 16 bits.

`castSphere` normalises internally and calls `queryGroupsFor` itself, so it *cannot* be called
wrongly — the encoding mistake is designed out rather than documented away.

**3. `src/gameplay/CameraRig.ts` — the rig itself.**

A 0.25 m sphere swept from a chest-height pivot. The boom shortens at 0.35/frame and lengthens at
0.08/frame, chosen from target-versus-current rather than from "is something blocking us" (which
judders). Ground correction re-solves the boom instead of lifting vertically. Auto-rotation gated on
0.5 s of no camera input. Mode changes damped, never cut. Teleport snapping driven by
`CharacterEvents.rescued`, with a distance backstop. A stuck detector with two independent
conditions and an escape that provably converges.

**4. Integration: `Game.updateCamera()` replaces the placeholder, and the camera ticks in
`simulateTick`, not in `render`.**

That placement is the least obvious decision in this commit and the most important. The camera
advances damping by `dt` and drains a mouse delta the input layer accumulated. Updating it once per
*frame* would make both frame-rate dependent — at 144 Hz it would damp 2.4× as fast as at 60, and
every accumulated delta would be split across a different number of ticks. The frame-rate
independence proved in the unit tests would be quietly destroyed by the call site, and **the tests
would still pass**, because they drive the rig directly. The camera belongs where the simulation
lives.

**5. Mouse look in `KeyboardSampler`, and the camera line in the overlay.**

Pointer lock on click, deltas accumulated and drained once per tick, discarded across the lock
transition and on blur. The overlay now reports the camera's mode, FOV, boom, yaw, pitch and idle
timer — because camera quality is impossible to judge from a screenshot and trivial to judge from
those numbers while playing.

### Problems Encountered

Six real bugs in the production code, all found by tests, all fixed. Plus five errors in the tests
themselves, which I am recording because a test that is wrong is worse than no test — it certifies
the bug.

**B1 — `damp()` froze the camera when asked to snap.** An unreachable defence clause:

```ts
if (!Number.isFinite(rate) || rate <= 0) return current;   // Infinity fails this; returned early
...
if (rate === Number.POSITIVE_INFINITY) return target;      // therefore unreachable, always was
```

`isFinite(Infinity)` is `false`, so the guard on the left caught the infinite rate first and the
clause that handled it never ran. The published contract is that a lerp of 1.0 means "instant", so
this is a real defect and not a theoretical one: any tunable set to instant would freeze the camera
instead of snapping it. The fix moves the infinite test *above* the guard, which is where it must
be, with a comment explaining that the ordering is load-bearing rather than stylistic. Found by a
one-line unit test asserting "snaps exactly for an infinite rate".

**B2 — the rig's look direction pointed backwards.** `lookTarget()` was reimplemented locally and
used `orbitDirection` — which points from the pivot *out* to the camera — where the view direction
requires its negation. The camera stared away from the player into the void.

What makes this worth writing down is that **the test agreed with the bug.** I hand-expanded the
expected vector in the test and made the same sign error, so rig and test were wrong together and
the suite passed. The pure module was right the whole time. Two changes: the rig now *calls*
`camera.ts`'s `lookTarget` rather than reimplementing it, and the test asserts against the module's
own `orbitDirection` instead of a retyped formula, so the two have no room to be wrong in a matching
way. My hand-expansion was also wrong in the *vertical* component, in the opposite direction, so the
two errors partially cancelled — which is precisely why it survived.

**B3 — the ground-clamp ray started a metre above the camera and found ceilings.** The `+1.0` was
added on the reasoning that starting above an overhang would stop it hiding the floor. It did the
opposite: the ray's origin landed *inside* the overhang, and Rapier reports a hit at zero distance
for a solid ray starting inside a shape. So the ceiling became "the ground", the clamp lifted the
camera into the ceiling, and the next tick found the ceiling's top face and lifted it further. In the
sealed-pocket test the camera climbed to y = 4.52 and stayed inside the slab. Fix: cast downward from
the camera's own height, which makes an overhang *structurally* unreachable because the ray never
goes up.

**B4 — the ground re-solve collapsed the boom to zero.** The re-solve fired whenever the camera was
within the GDD's 0.5 m clearance of the surface below, and then searched for the boom length that
satisfied it. At level pitch the camera's height does not depend on the boom length at all, so no
distance satisfied it, the bisection returned the pivot itself, and the boom went to zero: a crate
behind the player became a first-person view.

Two problems with one line. First, 0.5 m is the *visual* clearance and far too strict a trigger for
a framing correction — 0.42 m above a ledge is neither underground nor clipping, and 0.42 > 0.25 (the
near-plane sphere) so nothing is wrong at all. Second, and more fundamentally, **re-solving the boom
can only raise the camera when the arm points downward.** Fix: attempt the re-solve only when
`pitch < 0`, decline a result that would cost more than half the boom, and let the absolute clamp
guarantee the clearance. The re-solve is now a framing nicety rather than the safety mechanism, which
is the reverse of the first draft's arrangement and the reason the first draft could place the camera
underground.

**B5 — the escape hatch drove the camera deeper into the wall.** The reset drove the boom to a
"fallback" of 60% of the full distance, on the reasoning that the obstruction cast could not be
trusted while stuck. Wrong twice over: the cast was never the problem, and pushing the boom *out* is
the wrong direction in a tight space. The pocket test caught it — the camera ended up penetrating
geometry *after* the escape had run, which is the one outcome the escape exists to prevent.

The real obstacle is the 1.5 m minimum. It exists so the player never sees the back of their own
head, which is a *bad view*; in a pocket smaller than the minimum there is no legal position at all,
so enforcing it produces **no** view. The escape now relaxes the minimum to 4% and lets the arm
collapse toward the pivot — which is the one point guaranteed to be inside free space, because the
character is standing there. That makes the escape provably convergent rather than hopeful.

**B6 — the escape ended on a countdown instead of on relief, and the camera juddered forever.** With
`CAMERA_RESET_S` as a duration and a countdown that expired regardless, the escape ended while the
camera was *still* inside geometry, restoring the normal minimum, pushing the camera straight back
into the wall and re-arming the detector. A ~2.5 s cycle, forever. 0.4 s is how long the arm takes to
*collapse*, not how long the escape lasts. The escape is now a state that ends when its cause is
gone. If the geometry admits no valid position it stays active permanently, and that is correct.

**B7 — `springArmTarget`'s minimum could override an obstruction, putting the camera inside the
wall.** Against a wall 1.25 m away the arm resolved to the 1.5 m minimum and the camera was placed a
quarter of a metre *inside* the wall. The minimum is a framing *preference*; not being inside geometry
is a *constraint*, and a preference must never override one. The rig now caps the floor it hands the
resolver at what the geometry actually permits, and lets the pinned detector bring in the escape when
the resulting view has fallen below spec.

**B8 — `snapTo`'s pivot had two meanings for two callers.** The public path passed feet height; the
teleport path passed chest height. The result was a first-frame-only bug: the very first solve ran at
the character's knees, sailed through a wall, and then behaved correctly forever after. Fixing the ray
origin in B3 exposed it. One entry point, one meaning, and `snapTo` now takes the character's own
position and applies the lift itself.

**Five test errors, recorded because a wrong test certifies its bug.**

| # | Error | Why it certified nothing |
|---|---|---|
| T1 | Compared *progress* on the spring-arm asymmetry and demanded pull-in be 2× faster | Progress is capped at 1.0, and pull-in saturates in 10 ticks, so the assertion became unsatisfiable arithmetically. Fixed by measuring the gap *remaining* |
| T2 | Asserted `expandingRemaining < contractingRemaining` | Inverted. The quantity compared was the gap *remaining*, so push-out — the slower direction — legitimately leaves more of it. Fixed by asserting the direction the maths actually supports |
| T3 | Bounded the reversing FOV step at 2° | An arbitrary budget that fitted today's constants. Replaced with the property that actually holds: the step is the authored fraction of the gap |
| T4 | Used the literal `0.7071` for `SQRT1_2` | Left the diagonal magnitude at 0.44999, and the resulting 6e-5 mismatch looked like a radial-blend bug. Fixed with `Math.SQRT1_2`, keeping the assertion tight rather than loosening it until the symptom vanished |
| T5 | Required "not penetrating" inside a *sealed* pocket | Unachievable — a 3 m box with 0.5 m walls admits no camera position that satisfies a 1.5 m minimum. The test was demanding something impossible and would have passed only if the camera escaped into the void. Rewritten to assert the guarantee that *can* be made: no NaN, still on a legal boom, not inside geometry |

**A process error I want on the record.** While planning this milestone I computed the required
launch speeds for a 3 m and 6 m jump, concluded the constants were mistuned in both directions, and
began writing an entry about it before checking the file. The constants were already correct and
already documented — `JUMP_STANDING_SPEED_MPS = 3.913`, `JUMP_RUNNING_SPEED_MPS = 7.0588`, solved
against the hold-scaled and discrete-compensated arc during Milestone 1.2. I had invented the numbers
I was reasoning about and nearly logged a fix for a bug that did not exist. **Read the file before
asserting the file is wrong.** Since this same class of mistake — asserting on remembered rather than
read values — has now appeared three times in this project, it goes in the register as a named
failure mode rather than a shrug.

### Alternatives Considered and Rejected

| Alternative | Why rejected |
|---|---|
| A raycast instead of a sphere cast | A ray threads gaps the near plane cannot, and geometry pops through the lens. The 0.25 m sphere stops the boom where the near plane is — measured at 2.75 m against a face a ray calls 3.00 m |
| One damping rate for both directions | Forces a choice between visible clipping on the way in and a nauseating whip on the way out. Two genuinely different requirements on the same number |
| Lifting the camera's Y when the ground is too close | The camera leaves the boom axis, so the framing shifts sideways and the view drifts for as long as the player walks downhill |
| Detecting teleports by distance alone | Makes a legitimate fast fall — or a zip line, or a launched platform — snap the camera mid-parkour. `rescued` is authoritative; the distance is only a backstop |
| Damping the pivot so the camera eases toward the character | The camera would visibly lag the character's *own body*, so a player who stops would watch the camera keep sliding toward them |
| A wall-clock phase for the water wobble | A stalled tab would teleport the phase, and the oscillation would run at a rate that depends on when the tab was resumed |
| Folding the water wobble into the stored yaw | It *accumulates*. The camera drifts by whatever the oscillation summed to and surfaces pointing somewhere subtly random — unreproducible and undescribable |
| Skipping the obstruction cast entirely during a reset | B5. The cast was never the problem; the minimum distance was |
| Relaxing the minimum only, without raising the pivot | Fixes penetration but does nothing for a camera merely *pinned* against a wall. Pulling such a camera in further just buries it in the character's back |
| Stubbing the submerged and tunnel probes with a plausible distance test | A wrong probe switches camera modes in ordinary play and gives no reason to suspect the cause. Absent is better than wrong; the rig handles `undefined` and falls through to the correct lower-priority mode |

### Doubts

| # | Doubt | How it gets resolved |
|---|---|---|
| Q1 | **Nothing has been rendered in five commits.** The probe radius, the mouse sensitivity, the 0.18 s mode transition and whether 0.35/0.08 reads as smooth or as sluggish are all unvalidated | Manual checklist in the live preview. This is the honest answer and it has been the honest answer since commit 1 — but it is now the *only* thing standing between the camera and "done" |
| Q2 | `CAMERA_MODE_TRANSITION_RATE = 12.8` /s is derived from 90% of the Aim transition in 0.18 s, and the GDD specifies 0.18 s only for Aim. Climb, mantle and zip-line inherit it | Judge in motion. A single rate for every mode is almost certainly wrong for at least one of them, but the GDD gives no basis for four separate ones |
| Q3 | The escape can stay *permanently* active in geometry that admits no spec-compliant camera, and the player sees a raised pivot with no explanation for why | Playtest. Alternatives are worse — the state it replaces is a 2.5 s judder loop |
| Q4 | `pinned` is compared against the *normal* minimum, so any boom legitimately below 1.5 m keeps the escape on indefinitely | Playtest a corridor network. Requires level geometry that does not exist until Phase 3 |
| Q5 | Mouse sensitivity 0.0022 rad/px is a guess with no basis whatsoever | Feel. It is one constant in one place, chosen so it can be changed once rather than argued about now |
| Q6 | The re-solve's "decline a result costing more than half the boom" threshold is 0.5 because it looks reasonable | Playtest against slopes. A principled threshold would come from screen-space framing error, which needs a renderer |
| Q7 | `snapTo` ticks the rig with `dt = 0`, which skips damping entirely by design. It is exercised on boot and on every rescue, and both paths are tested — but the teleport *backstop* has never fired in real play | Artificial test (`injectPositionForTest`). Real play produces no teleports |

### Next Steps

1. **Manual feel checklist in the live preview** — the eight edge cases where they are observable
   (back into a wall, walk downhill, back into a rising ledge, aim, get pinned), plus the draw call
   and frame-time numbers the overlay now reports.
2. **Milestone 1.4: the real input layer** — gamepad, the input-level 150/200/100 ms buffers,
   `localStorage` remapping, sensitivity as a tunable, and `KeyboardSampler` retired as the
   temporary adapter it declares itself to be. `drainLookDelta()` is already the interface it needs.
3. **Then Phase 2**, starting with combat, which is the first system that needs the camera's aim
   mode to actually mean something.



## 2026-10-07 (commit 4) — Milestone 1.2: Procedural Rig, Dev Overlay, and a Playable Preview

**Milestone 1.2 is complete.** The character is now visible, driveable and instrumented in the
live preview.

### What I Built

**`src/gameplay/CharacterRig.ts` — a procedural character, zero binary assets**

The rig is thirteen primitives assembled at boot and animated by evaluating pose functions,
because the project ships no `.glb`, no skeleton and no clips — and because there is no DCC tool
in this environment, so a rig that cannot be authored also cannot be maintained.

A conventional blend tree interpolates between *clips*; without clips the equivalent is to
interpolate between *functions that write a pose*. Two things fall out of this that a clip-based
system cannot give for free:

- **Transitions are free and correct.** Walk-to-run is a weight change, not a scheduled
  crossfade. There is no blend duration to tune and no pop when a transition is interrupted.
- **The pose continuously reflects the world.** The slope lean is a function of the ground
  normal, so the character leans into a 17° ramp that nobody authored a clip for.

Details worth recording: the gait phase advances with **distance travelled, not time**, which is
what stops the feet skating; knee bend is gated to the back-swing so the legs do not scissor; arms
counter-swing the legs, which is what sells a walk from any angle; and the model's feet are
placed `halfHeight + radius` below the capsule *centre* (the constant is derived, not a literal,
so it cannot drift out of step with the collision shape).

**`src/app/DebugOverlay.ts` — a production overlay, not a debug hack**

F1 toggles it; `[`/`]` tune affine warping and `-`/`=` tune the vertex snap grid, live, through
the shared uniform objects so a change costs nothing and needs no recompile.

This exists because three Milestone 1.1 questions are genuinely unanswerable in a sandbox: *is
`warpAmount = 0.65` right? is the snap grid too aggressive? does the scene read as lush jungle?*
They are judgements about appearance, and the overlay cannot make them — but it removes every
*numerical* uncertainty around them, so the remaining decision is about taste, which is the part a
human should be making anyway. It is also the instrument panel for this milestone's own doubts:
the turn rate, steer weight and coyote/buffer windows are all visible while playing, so "feels
unresponsive" becomes "the turn rate is 220°/s and that is too slow" at a glance.

Two decisions worth noting. It is **DOM, not WebGL**: drawing it through the PS1 pipeline would
quantise the text to the 480×270 palette and make the numbers unreadable, and would make the
overlay part of the thing it measures. And it **costs nothing when hidden**: one boolean test per
frame, with DOM writes at 4 Hz rather than 60, because `textContent` writes force layout and doing
that every frame is measurable.

Also added: `FrameStats.drawCalls` and `triangles`, read from the renderer rather than estimated.
The Milestone 1.1 log records that the draw-call *estimate* was wrong by an order of magnitude,
which is precisely why R1 insists on measurement.

**`src/world/textures.ts` — a cloth texture**

Near-flat by design, and starting from neutral grey rather than a colour so the per-part vertex
colour supplies the hue. One texture therefore serves a shirt, trousers and boots without tinting
any of them wrongly. Its real job is to keep the character subject to the same affine warping,
vertex snapping and palette quantisation as the environment: a character on a plain white texture
among quantised geometry looks pasted on top of the scene.

**`src/app/KeyboardSampler.ts` — and an honest statement of what it is not**

This is a **temporary adapter, not Milestone 1.4's input system**. It has no remapping, no
gamepad, no mouse aim, no input-level buffers and no deadzone handling. It exists for one reason: a
controller that cannot be driven cannot be verified, by test or by eye, and the brief's own
acceptance criteria require a playable character.

The file says all of this in its header, and the deferral is recorded here rather than left for a
reader to discover. Milestone 1.4 must replace it *and* own the two things it deliberately
fakes: press-edge detection (it samples physical key state once per tick, so holding jump reports
`jumpRequested` every tick, which is harmless only because the controller's buffer and cooldown
make a held jump fire once — that is accidental, not designed) and the camera-relative
transformation of stick input, which does not exist yet because there is no camera rig until 1.3.

It does handle one real edge case properly: **clearing all held keys on window blur.** Without it,
alt-tabbing while running leaves the key stuck in the held set forever and the character walks off
on its own when the player returns.

### Problems

**Q1 — several scripted edits silently failed to apply, twice, in one session.**

Two separate patches — the platform-momentum inheritance (P8) and the `torso.position.y` lift —
reported success while matching nothing, because the search strings had the wrong indentation and
the edit was unasserted. The first was caught only because a test measured the character's actual
position; the second was caught by a grep for a magic number that should no longer have been
there.

The rule adopted from here on: **every scripted edit asserts that it matched.** A patch that
silently does nothing is worse than one that fails loudly, because the code then reads as though
the feature exists.

**Q2 — a texture is mandatory, and that was the right call to discover late.**

`createPS1Material` requires a `map` and its documentation says untextured surfaces break the
aesthetic. My first rig passed `map: null`, which failed typecheck. The temptation was to relax the
type; the correct answer was that the constraint was right — a character on a white texture would
not receive the affine warping and quantisation the environment has. So a cloth texture was added
instead, starting from neutral grey so vertex colours still supply the hue.

**Q3 — six bugs in `CharacterRig` found by review before it ever ran.**

Worth listing because each is a distinct failure mode:

1. A **stray non-English word** in a comment, from a slip in generation. Caught by reading.
2. A **dead aliasing statement** (`void mergeGeometries;`) — the exact anti-pattern already
   rejected in Milestone 1.1. Removing the import is the fix; the "unused import guard" idiom is
   banned in this codebase.
3. **Swapped `width`/`height`/`depth`** between the public `box()` helper and the private
   `ownedBox()`. Every part would have been built with the wrong axis.
4. `buildLimb` passed `(length, radius, radius)` into a `(width, height, depth)` helper, producing
   limbs `length` wide and `radius` tall — visible as a character made of flat plates.
5. A **shared material with per-part colours applied to the geometry** would have been fine, but
   `restRotation` was declared and never read, and `restPosition` was captured before the geometry
   shift, which is only correct because the shift is applied to the geometry rather than the mesh.
   Recorded so the subtlety is not lost.
6. A **`size_of_thread` identifier** in the texture generator — a value-named count, violating the
   review rule on unclear names. Renamed `CLOTH_THREAD_COUNT`.

**Q4 — `uSnapGrid` is a `Vector2`, not a number.**

Caught by typecheck. The uniform holds `(columns, rows)` because the grid must be square *in
internal-target space*, not in raw pixel counts. Exposing only the row count keeps the grid square
by construction: the column count is derived from it and the target aspect. A grid that is not
square in proportion to the target makes the snap wobble further horizontally than vertically,
which reads as the image shearing rather than wobbling.

**Q5 — `update()` was 101 lines, `mergeGeometries` 70, `probe()` 64, `buildRig()` 108.**

The review protocol requires functions under 50 lines. My first measurement tool counted leading
doc comments as body, which reported fifteen violations; a corrected tool that counts only
non-comment body lines reported four. All four were decomposed into named phases —
`update()` into `readGroundProbe` / `updatePlatformVelocity` / `sampleInputWindows` /
`isJumpWindowOpen` / `buildContext` / `advanceState` / `projectInheritedVelocity` /
`integrateForState` / `applyMovement` / `resolveVerticalCollision`.

`update()` is now legible as the tick's *shape* rather than its mechanics, which is the actual
benefit: the per-tick ordering is the load-bearing part and it is now visible at a glance.

### Alternatives Considered and Rejected

**Loading a `.glb` model with a skeletal animation system.** Rejected, and not only because zero
binary assets is a constraint. There is no DCC tool in this environment, so an authored rig could
not be edited, inspected or repaired — the project would depend on an artefact nobody could
maintain. The procedural approach is also period-authentic: PS1 characters were often rigid parts
rotated about joints, because 1997 hardware had no budget for skinning.

**A WebGL-rendered overlay.** Rejected. It would be quantised to the 480×270 palette and become
unreadable, and it would be rendered *by* the pipeline it is supposed to be measuring.

**Relaxing `PS1MaterialOptions.map` to optional so the character could be untextured.** Rejected —
see Q2. The type was encoding a real aesthetic constraint.

**A dither array inside the character shader.** Already rejected in Milestone 1.1 for the world
shader; the same reasoning applies and the character shares the world material rather than
introducing a second shader path.

**Building the character as one merged geometry, one draw call.** Considered and deferred rather
than rejected. Thirteen draw calls for one character is acceptable now, and merging would prevent
per-part rotation, which is the entire animation mechanism. If characters become numerous in
Milestone 2, the dynamic ones will need a different approach — noted as a future concern rather
than solved prematurely.

**Making `KeyboardSampler` do press-edge detection properly.** Rejected *for this commit*,
deliberately. Doing it here would mean writing the input system twice, and Milestone 1.4 specifies
a genuinely different design (input-level buffers, remapping, gamepad fallback). The deferral is
documented in the file header and here.

**Per-foot ground raycasts for the foot IK.** Rejected for now. `CharacterRig.update` accepts the
offsets and skips the IK when they are null, and the caller passes nulls rather than fabricating
plausible numbers. Fabricating them would have made the IK look implemented while doing nothing.

### Doubts

1. **Still nothing has been seen running.** This is now the fourth commit with no visual
   verification, and it is the largest single risk to the project. I can prove the character's
   *numbers* are right — jump distances to three decimal places, no NaN, determinism across
   replays — but whether it reads as a person running through a jungle is unknown. The overlay
   and the playable preview exist specifically to let the user answer that in one session.

2. **The gait is uncalibrated.** `STRIDE_LENGTH_M = 1.9` sets the phase rate, and the swing and
   knee amplitudes (0.25 + speed×0.55, 0.15 + speed×0.65) are plausible numbers rather than
   tuned ones. Skating — feet sliding because the phase rate does not match the ground speed —
   is the classic failure and the most likely thing to need adjusting.

3. **The arms may read as too straight.** `elbowBend` starts at 0.25 rad and does not go negative,
   so the arms never fully straighten or fully fold. If it looks stiff, the fix is a wider range,
   and the overlay makes that a live decision.

4. **Thirteen draw calls for one character is more than the aesthetic needs.** It is well inside
   budget now, but it does not scale. Deferred with reasoning rather than ignored.

5. **The overlay's percentile readout duplicates `PerformanceSnapshot`.** Both compute from the
   same rolling buffer, through one shared `percentileFrameTime` helper — but the overlay wants
   p95 and the snapshot wants p99, so there are two callers of one function rather than one. If a
   third consumer appears, the sample itself should carry both.

6. **The debug key bindings are installed unconditionally, including in a production build.**
   `-`/`=`/`[`/`]` are harmless and F1 is the conventional toggle, but a release build arguably
   should not ship them. Milestone 5 is where build configuration exists to gate this, and the
   deferral is recorded rather than forgotten.

7. **`KeyboardSampler` listens on `window` and is constructed inside `Game.loadLevel`.** A second
   `Game` instance (a hot reload that did not dispose, for instance) would produce two samplers
   both writing to the same character. `dispose()` removes them, and `beforeunload` calls it, but
   the ownership is slightly awkward — the input layer arguably should not be owned by the level
   loader. Noted for Milestone 1.4, which restructures this anyway.

### Next Steps

1. **Milestone 1.3: the camera rig**, which replaces the placeholder follow camera in `Game.ts`.
   The GDD specifies a spring arm with a raycast (minimum 1.5 m), follow lerp 0.1, auto-rotate
   after 0.5 s, and an aim FOV transition from 60° to 45° (and 4°→5° for climbing). Eight edge
   cases are required, including camera-through-geometry and the auto-rotate-vs-input conflict.
2. **Milestone 1.4: the real input system**, which replaces `KeyboardSampler` entirely and must
   own the press-edge detection this commit deliberately left thin, plus the 150 ms jump and
   200 ms interact input buffers, `localStorage` remapping, gamepad support, and the five
   enumerated edge cases.
3. **READMEs for `src/core`, `src/world` and `src/app`**, still owed from the Milestone 1.1 review.
4. **Manual visual checklist** — M1.1 rendering, the character rig and the overlay all remain
   unverified visually. This must appear in the milestone report rather than being glossed over.
5. **A screenshot-capable environment would change this project's risk profile more than any code
   change.** Recorded as a standing concern.

## 2026-10-07 (commit 3) — Milestone 1.2: Character Controller

**Status: controller complete and tested; procedural rig and dev overlay deferred to commit 4.**

I split Milestone 1.2 across two commits because the controller turned out to contain six
genuine bugs (two of them structural) and a large amount of derived mathematics. Committing a
verified, tested controller separately from the cosmetic rig keeps the diff reviewable and means
the interesting failures are recorded while they are still fresh.

### What I Built

**New pure mathematics — `src/core/math/locomotion.ts` (52 tests)**

| Function | Purpose |
|---|---|
| `solveJumpArc` | Continuous trajectory from a target peak height |
| `solveHorizontalSpeedForDistance` | Inverts the arc for a distance target |
| `predictJumpDistance` | Forward prediction, used to prove the GDD's 6 m is unreachable |
| `effectiveRiseGravity` | The rise gravity after hold-scaling — **the fix for P1** |
| `discreteTakeoffVelocity` | Compensates semi-implicit Euler's peak overshoot |
| `solveJumpLaunch` | The single source of truth for jump takeoff |
| `slopeAngleFromNormalY` / `classifySlope` | The four GDD slope bands, NaN-safe |
| `canJumpFromBand` / `hasGroundFriction` | Band capability queries |
| `downslopeAcceleration` / `projectVelocityOntoSurface` | Slide physics |
| `TickWindow` / `millisecondsToTicks` | Coyote time and jump buffering, in ticks |
| `approachSpeed` / `speedDeltaForTransition` | Frame-rate-independent acceleration |
| `approachAngle` / `wrapAngle` | Shortest-path turning |

This file deliberately imports nothing, so it is usable anywhere and testable in isolation.

**The discarding state machine — `src/gameplay/LocomotionStates.ts` (33 tests)**

Seven mutually exclusive states (grounded, airborne, mantle, ledge-hang, climb, water,
zip-line) in a single discarding enum. This is the R15 mitigation made structural: illegal
combinations such as "climbing while mantling" are *unrepresentable*, not merely forbidden by
discipline. Transitions are a pure function of `(state, context, intent)`, so every boundary and
every illegal input can be asserted without a physics world.

The transition priority is explicit and documented top-to-bottom, because "what wins when
several conditions are true at once" is otherwise the source of subtle bugs:

```
1. Zip line   (committed traversal)
2. Water      (physical override)
3. Mantle     (in progress unless jump-cancelled)
4. Ledge hang (airborne grab, then hold)
5. Climb      (authored surface + intent)
6/7. Airborne / Grounded
```

Also: **logic first, animation follows.** No transition waits for an animation. A jump during a
mantle cancels it on the same tick; the animation is cosmetic and is cut short.

**The ground probe — `src/gameplay/GroundProbe.ts`**

Five rays in a cone: a centre ray plus four at 0.3 m. A majority vote (≥3) declares ground, the
averaged normal drives slope handling, and the per-ray hit pattern gives edge proximity. Layer
selection is explicit (`StaticWorld` + `PropDynamic`); trigger volumes and water sensors are
excluded because including them would let the player stand on a checkpoint or on the surface of
water.

**The controller — `src/gameplay/CharacterController.ts` (25 integration tests)**

Mostly glue: probe, resolve state, integrate velocity, hand the result to Rapier. The interesting
decisions live in the tested modules above it. Responsibilities are separated specifically so
this split is possible.

### The Ten Mandatory Edge Cases — All Implemented and Tested

| # | Case | How it is handled | Test asserts |
|---|---|---|---|
| 1 | Jump + crouch on a ledge edge | Crouch wins: `tryConsumeJump` returns early when `crouchHeld`. The buffer is **not** cleared, so releasing crouch inside the window still jumps. | y does not rise; a control run without crouch *does* jump, proving the test is not vacuous |
| 2 | Land on a slope mid-jump | Ground-normal projection **before** gravity, plus `hasGroundFriction` gating. 25° is walkable, so no slide force exists. | Position drift < 5 cm over a full second of no input |
| 3 | Run into a wall airborne | Blocked upward movement zeroes `velocity.y`; slide velocity is applied along the surface. | Comes to rest at 0.97 m pressed against the wall, never above it, never inside |
| 4 | Jump from a moving platform | Surface velocity derived from the ground collider's per-tick translation delta, applied to the move **and** inherited at takeoff | Carried 1.5 m+; airborne travel after the platform vanishes > 0.2 m |
| 5 | Fall from extreme height | Kill plane at y = −30 plus a non-finite-position guard, both routing to a positional-only respawn | Respawns < 1 m from spawn, then settles and jumps normally; health untouched |
| 6 | Jump during a mantle | `Mantle` + `jumpRequested` → `Airborne` immediately, even at 99% completion | No longer in `Mantle` on the same tick; never inside the wall |
| 7 | Climb a non-climbable surface | No `Climb` entry without an authored surface; `rejectedGrab` is emitted **once per press** as the explicit feedback signal | Never enters `Climb`, never hangs, and the refusal is observable |
| 8 | Release a ledge during a pull-up | `hangingInputReleased` → `Airborne`; the state machine can never return `LedgeHang` on the same tick | Never ends in `LedgeHang`; 10 s of no input always resolves to grounded or airborne |
| 9 | Jump from a ledge hang | Directed along the wall's *outward normal*, independent of facing | Dot product with the normal > 0.5 for all four cardinal walls |
| 10 | Land on an enemy | `deflectOffCharacter` grants outward + upward velocity, with a stable fallback for exactly coincident positions | Bounces up and out; the reverse (enemy on the player's head) also escapes |

### Problems

**P1 — the jump arc was solved against the wrong gravity. (Structural.)**

*Symptom:* a held standing jump measured 3.92 m instead of 3.0 m, and 0.900 s of airtime
instead of 0.701 s.

*Root cause:* `applyJump` solved the trajectory with the nominal rise gravity (26 m/s²), but
`integrateAirborne` multiplied that gravity by `JUMP_HOLD_GRAVITY_SCALE` (0.75) while the
control was held. The two disagreed. The peak became `2.0 / 0.75 = 2.67 m`, the airtime became
0.879 s, and because the launch speed had been derived from the nominal airtime the distance
overshot by 26%.

*Fix:* `effectiveRiseGravity()` is now the single place the scaling happens, called by both the
solver and the integrator. They cannot disagree again.

*Lesson worth recording:* the bug was not "a multiply in the wrong place". It was that two
call sites each computed the same physical quantity independently. Any quantity computed in two
places will eventually disagree, and the fix is to make it computable in one.

**P2 — the ground probe could never touch the ground. (Structural, would have shipped.)**

*Symptom:* `grounded` was `false` on every tick, forever.

*Root cause:* `GROUND_PROBE_LENGTH_M` was 0.45 m. The capsule body origin rests
`halfHeight + radius + offset = 0.97 m` above the surface, and the probe origin sits 0.1 m above
that, so the ray needs ~1.17 m of reach to see the floor it is standing on. At 0.45 m the ray
ended 1.32 m above the ground.

**The GDD's own formula was wrong too.** GDD §4.4 specifies `capsuleHalfHeight + 0.45`, which
omits the capsule *radius* and is still 2 cm short.

*Why it was so hard to see:* the character did not fall through the floor. Rapier's solver caught
it, `computedGrounded()` reported `true` throughout, and the player could walk and run normally.
The controller was simply never *told* they were standing on anything, so the state machine
stayed in `Airborne` and jumps could never fire. A running "jump" measured 20 m because the
character spent the entire test airborne at run speed.

The generalisable trap: **a probe that silently fails to hit anything produces no error, only
wrong answers.** The fix is now derived from the capsule geometry rather than written as a
literal, so it cannot drift out of step again, and there is a test that compares the ray's reach
against the capsule's actual dimensions — because no assertion about "is the character on the
ground" can catch this (the character *was* on the ground).

**P3 — the jump was cancelling its own momentum.**

*Symptom:* a running jump measured 20.0 m of horizontal travel.

*Root cause:* `applyJump` *replaced* the horizontal velocity with `direction × launchSpeed`.
Direction came from raw input (camera frame) while the velocity being replaced had been built
along the character's *facing*, and the turn rate had not yet caught up — so the two were up to
24° apart and the difference was silently discarded. Worse, the resulting speed was below run
speed, so the character never landed during the test window.

*Fix:* rotate the existing velocity rather than replace it. The launch speed only ever *raises*
the magnitude, which is what "a jump preserves momentum" actually means. A quarter-weight steer
toward the requested direction allows aim correction without erasing a committed run-up.

**P4 — air control was scrubbing the jump boost.**

*Symptom:* a running jump travelled 5.04 m instead of 6.0 m, after P3 was fixed.

*Root cause:* `integrateAirborne` approached a horizontal target of `RUN_SPEED_MPS` (6.0)
unconditionally. But a full-momentum jump launches at 7.05 m/s, so air control *decelerated*
every running jump from 7.05 back to 6.0 during flight, cancelling the very boost that exists to
make 6 m reachable. The feature was working against itself.

*Fix:* when already faster than run speed, air control steers the direction but leaves the
magnitude alone. Steering has no business imposing a speed ceiling on a body that is already
moving faster than a run.

**P5 — semi-implicit Euler overshot the documented peak by 4%.**

*Symptom:* a 2.0 m jump peaked at 2.086 m; a 2.5 m jump at 2.598 m.

*Root cause:* `v0 = sqrt(2gh)` is exact for continuous motion but overshoots on a discrete
integrator by `v0·dt/2` — 7.4 cm at 60 Hz, and 8.6 cm measured (the extra comes from the one
tick the probe still reports contact). Predicted analytically, then confirmed by measurement.

*Why it was worth fixing rather than accepting:* the GDD specifies the peak height and level
gaps are authored against it. A documented number that quietly runs 4% high is exactly the drift
that eventually makes a jump that "should" clear a gap fail. `discreteTakeoffVelocity` solves
`v²/(2g) + v·dt/2 = h` for `v`, which is three lines and makes the specification literally true.

Related, in the same fix: airtime is now counted in **whole ticks**. A continuous airtime of
0.7533 s is not reachable — the character lands on tick 46, not tick 45.19 — so dividing the
distance target by a fractional airtime missed by the discarded fraction. Counting rise ticks
plus fall ticks and dividing out over the whole-tick total makes the distance exact on the
simulation grid.

**P6 — `JUMP_RELEASE_CUT` compounded once per tick instead of once per release.**

*Symptom:* a tapped jump peaked far lower than the 45% cut implies.

*Root cause:* the cut was applied every tick the control was unheld while rising. At 45% per
tick, twelve ticks of rising became a `0.55¹² = 0.08` multiplier — a 92% cut rather than 45%, and
a result that depended on how many ticks the rise happened to last.

*Fix:* edge-triggered on the release transition, tracked via `jumpHeldLastTick`. The reduction is
now exactly the configured fraction.

**P7 — NaN slipped through a `<= 0` guard.** *(Found by the degenerate-input test.)*

`NaN <= 0` is `false`, so `if (peakHeight <= 0) return zeroArc` let NaN straight through and
produced a NaN takeoff velocity. A NaN velocity propagates into the character's position, and a
NaN position is **unrecoverable**: every subsequent collision query fails, so the character can
neither move nor land. Fixed with `/!Number.isFinite(x) || x <= 0/` throughout, plus a swept test
across a wide range of finite inputs and a guard on `horizontalDistance` (found the same way,
when a NaN distance target divided through into the launch speed).

The generalisable rule: **every comparison against NaN is false, so every guard must be written
as a positive test for what is acceptable, never a negative test for what is not.**

**P8 — the platform-momentum patch silently failed to apply.**

The scripted edit that was supposed to add platform inheritance in `applyJump` matched nothing —
the search string had the wrong indentation — and, because the edit was unasserted, it reported
success. The feature simply did not exist while the code read as though it did.

The only reason it was caught is that the test asserted an **observable outcome** (the character's
position) rather than trusting that the feature was present. Two lessons, both now applied: every
scripted edit asserts that it matched, and tests measure behaviour rather than re-reading the code
back to itself.

### Alternatives Considered and Rejected

**A hierarchical state machine (grounded → moving/crouching/jumping) instead of a flat discarding
enum.** Rejected. A hierarchy genuinely models "a jumping state that can be entered from walking
or crouching", but it multiplies the states the player can be in, and the extra expressiveness
buys nothing here because the derived state (walking vs running) is a *speed*, not a state. R15
explicitly warns about state-space growth, and a flat seven-state enum with the speed carried as
data is smaller and just as expressive.

**A separate `isCrouching` boolean alongside the state.** Rejected. Crouch is orthogonal to
locomotion — a player can crouch while grounded, airborne, or idle — so it belongs in the intent,
not the state. Putting it in the enum would have doubled the state count for no benefit and
proven the point of R15 by creating the very combinatorial explosion it warns about.

**An animation-event-driven controller** (accept the mantle only when the animation reports a
window). Rejected in favour of the "logic first, animation follows" rule. Animation-driven
windows feel correct in a demo and terrible in play: the player presses jump, nothing happens for
200 ms, and the game feels broken. Every transition here is decided from input and world state
alone.

**Impulse-driven platform motion** (a Rapier kinematic-velocity body). Rejected. It is stepped by
the solver, so the platform's position on a given tick depends on solver internals rather than on
the fixed-step loop — which would make edge case 4 untestable. Setting the translation directly
from our loop makes the platform's motion exactly reproducible.

**Accepting the 4% peak overshoot as "close enough".** Rejected, and recorded here as a
deliberate rejection rather than an oversight. Small, bounded, systematic errors in a specification
are how "the jump that should work" stops working three milestones later.

**Solving the arc numerically with a fixed-step simulation at load time.** Considered as an
alternative to the closed-form discrete compensation. Rejected: the closed form is exact,
three lines, and testable in isolation, whereas a load-time simulation would be a second
implementation of the integrator that could disagree with the real one — which is P1 all over
again.

### Doubts

1. **I have never seen this run.** There is still no browser or headless-render tooling in this
   sandbox, so the controller is verified numerically and behaviourally but not *felt*. Coyote
   time, the 150 ms buffer and the 0.25 steer weight are all plausible numbers from the
   literature; whether they feel right is unknowable from here. This is the honest biggest gap
   in the milestone and it is why the manual checklist exists.

2. **`TURN_RATE_GROUND_DEG` may be too slow to read as responsive.** Turning at a bounded rate
   and moving along the *facing* (rather than along the input) is the single biggest contributor
   to the feeling of mass — and also the fastest way to make a character feel like a boat. I have
   no way to calibrate this without playing it. It is the first number I would change.

3. **The mantle geometry is untested against real level geometry.** `detectMantleLedge` probes
   0.35–0.9 m ahead and accepts ledges between 0.4 m and 1.2 m. On Zone 1's actual temple
   platforms no mantle was produced in the integration test, and the test documents that rather
   than pretending otherwise. I do not yet know whether that is correct behaviour (autostep
   handling the 0.8 m steps) or a detection failure.

4. **`GROUND_PROBE_RADIUS_M = 0.3` is asserted but not validated.** The majority vote needs three
   of five rays, so a 0.6 m-wide cone on a 0.35 m-radius capsule is a guess about how narrow a
   ledge the player should be able to stand on. Too narrow and the player falls off invisible
   edges; too wide and they stand on air. Untested against real geometry.

5. **Edge case 9 is tested at the rule level, not end-to-end.** Ledge hanging needs authored climb
   surfaces (Milestone 2.3), so `ledgeAvailable` is currently always false and the controller
   cannot enter `LedgeHang`. The *direction rule* is tested exhaustively, but the integration path
   is not. I have chosen to test the part that exists rather than skip the case, and to say so
   plainly.

6. **`rescue()` logs with `console.warn`.** RULE #5 and the review protocol both require no stray
   console output, and there is an argument that a safety net firing is worth surfacing in the
   debug overlay instead. I kept the warning because a rescue means something went wrong and
   silence would hide it; it fires once per rescue, never per tick. Flagged for review at the
   milestone gate.

7. **The stuck watchdog is belt-and-braces, not a fix.** Thirty seconds in a precarious state
   teleports the player to spawn. If it ever fires, there is a real bug elsewhere and the watchdog
   has merely hidden it. It is instrumented (`rescues`, `lastRescueReason`) so a future
   play-test can tell whether it is ever reached.

### Deep Debug Sessions

**`### Deep Debug Session: The Probe That Never Hit the Ground`**

*Exact error:* no error. `grounded` was `false` on every tick, `currentState` stayed `airborne`,
and jumps never fired. A "running jump" test measured 20 m of travel.

*Attempt 1 — suspect the probe origin.* Hypothesised the rays were starting inside the capsule
and hitting a self-collision. **Failed:** rays exclude the player's own layer, and the origin was
already inside the capsule by design.

*Attempt 2 — suspect the layer filter.* Hypothesised the two-way group check (the trap already
documented for `intersectWithShape`) was biting again. **Failed:** `queryGroupsFor` was being used
correctly and manual raycasts from the same position hit the ground fine.

*Attempt 3 — suspect the physics was not primed.* **Failed:** the world was primed and
`castRay` worked when called directly.

*Hypothesis (correct):* the ray simply is not long enough, and the arithmetic has never been
checked end-to-end. Computed it explicitly: body origin rests at `0.6 + 0.35 + 0.02 = 0.97 m`,
probe origin is at `position.y + 0.1`, and the ray extends 0.45 m down, reaching
`position.y − 0.35` — which is 0.72 m *above* the ground at `position.y − 0.97`. The GDD's own
formula (`halfHeight + 0.45 = 1.05`) is also 2 cm short, because it omits the capsule radius.

*Untried alternatives:* (a) temporarily log every raycast's origin, direction and toi to confirm
the geometry empirically rather than arithmetically; (b) build a two-line diagnostic that casts a
single 1.5 m ray straight down from the body origin and reports the hit distance.

*Chosen next approach:* fix it by **deriving** the constant from the capsule geometry instead of
writing a literal, add a regression test that compares the ray's reach against the capsule's
dimensions, and record that the GDD formula was wrong. Adopted immediately — it works, and the
derivation means the class of bug cannot recur.

*Why this one is worth the space:* the character was on the ground the entire time. Rapier caught
it, `computedGrounded()` said so, and the player could run around. Every "is the character on the
ground?" assertion passes while the feature is completely broken. Only comparing the probe's
reach against the capsule's geometry — or noticing that a jump never fires — reveals it.

**`### Deep Debug Session: The Running Jump That Measured Twenty Metres`**

*Exact error:* no assertion failure initially. A running jump reported 20.0 m of horizontal
travel, which was obviously wrong but not obviously *which* wrong.

*Attempt 1 — suspect the launch speed derivation.* Computed the expected speeds by hand (standing
3.913, running 7.059). **Failed:** the solver produced exactly those numbers; the launch velocity
was correct.

*Attempt 2 — suspect the jump never landing.* Hypothesised the character was airborne for the
whole measurement window. **Confirmed as a symptom, not the cause:** airtime measured 1.000 s
against a predicted 0.784 s, so the flight was too long, but that alone does not produce 20 m.

*Attempt 3 — suspect the arc gravity (P1).* **Partially confirmed:** the arc was indeed solved
against the wrong gravity, and fixing that brought the airtime from 1.000 s to 0.783 s and the
distance from 20.0 m to 6.236 m. But 6.236 m is still 4% over the 6.0 m target.

*Hypothesis (correct, for the remaining 4%):* the airtime is longer than the arc predicts because
the character floats above the ground for one tick after takeoff, while the probe still reports
contact — 1.17 m of reach against a 0.12 m ground tolerance. Combined with semi-implicit
Euler's `v0·dt/2` overshoot, this accounts for the residual exactly.

*Untried alternatives:* (a) instrument the controller to record `velocity` and `position` on
every tick of a jump and plot the trajectory against the analytic arc, to see precisely where the
two diverge; (b) shorten the probe so it loses contact sooner and measure whether the overshoot
shrinks accordingly.

*Next occurrence protocol:* if a jump figure is wrong again, the first diagnostic is no longer
guesswork — dump `solveJumpLaunch`'s output alongside the measured trajectory and compare
`riseTicks`/`fallTicks` against the observed tick counts. The two must match exactly, and a
mismatch localises the fault to either the solver or the integrator immediately.

### Next Steps

1. **Procedural character rig** (`src/gameplay/CharacterRig.ts`). Zero binary assets is a
   constraint, so the character is built from low-poly primitives with a weighted blend of pose
   generators rather than clips. Procedural slope adjustment from the ground normal, and per-foot
   IK via a raycast from each hip.
2. **Dev overlay** — live shader and tuning values, `rescues`/`lastRescueReason`, probe state,
   tick time. Needed to resolve the M1.1 open questions about shader appearance, which cannot be
   answered without a screen.
3. **READMEs** for `src/core`, `src/world`, `src/app`, plus a `src/gameplay/README.md` covering
   the discarding-state decision and the derived-jump reasoning.
4. **Manual visual checklist** entry — M1.1 rendering and the M1.2 character both remain visually
   unverified. This must be stated in the milestone report rather than glossed.
5. Carry the `detectMantleLedge` question (doubt 3) into Milestone 2.3 when authored climb
   surfaces exist and it can be validated against real geometry.

## 2026-10-07 (commit 2) — Milestone 1.1: Scene & Rendering Pipeline

**Commit scope:** the PS1 rendering pipeline, procedural texturing, low-poly geometry, the Zone 1 jungle environment, the physics seam with its prime-step guard, project scaffolding (Vite/TypeScript config, `index.html`), 22 new tests (80 total), and three READMEs. No gameplay code — the character controller is Milestone 1.2.

### What I Built

- **`src/core/constants.ts`** — every GDD tunable in one place, with units encoded in the identifiers (`RUN_SPEED_MPS`, `COYOTE_TICKS`, `FIXED_DT`, `CONTROLLER_OFFSET_M`). The review protocol forbids magic numbers elsewhere, so this file is the single place a number may live.
- **`src/core/math/ps1.ts`** — the PS1 shader mathematics as pure functions: clip-space vertex snapping, affine vs perspective UV interpolation, the shader-trick identity, warp blending, integer-scale letterboxing, hard terminator clamping, and palette quantisation with an ordered dither table. **This exists because Vitest cannot compile GLSL** (risk W4): proving the maths in TypeScript makes the GLSL a transliteration rather than an act of faith.
- **`src/core/math/rng.ts`** — SplitMix32 seeded PRNG and a 2D value-noise / fBm sampler, so every generated artefact is byte-identical on every reload.
- **`src/render/shaders/ps1World.ts`** — all GLSL. World shader (vertex snap, affine-UV pair, flat lighting with rim, fog), palette pass, blit pass, and the sky dome shader. Written in GLSL ES 1.00 deliberately: it is the lowest common denominator that WebGL2 contexts still accept.
- **`src/render/PS1Material.ts`** — one material factory, plus **shared uniform objects** so retuning the sun updates every material in a single write rather than by walking the scene and inevitably missing one.
- **`src/render/PS1Pipeline.ts`** — 480×270 scene target → palette-quantisation pass → integer-scaled, letterboxed, nearest-neighbour blit. Full disposal, cached canvas sizing, and frame statistics.
- **`src/world/textures.ts`** — six procedural textures (grass, stone, bark, foliage with binary alpha, dirt, water) plus the Bayer dither table. **The game ships zero binary image assets.**
- **`src/world/geometry.ts`** — palm, broadleaf, rock, pillar, broken statue, ruined wall, ground and sky-dome builders, all with baked vertex colours; plus a merging utility that validates its inputs rather than silently producing an empty mesh.
- **`src/world/InstanceBatcher.ts`** — per-cell instanced batching. A single `InstancedMesh` is one draw call but is culled as one object, so all-two-hundred-trees are drawn the moment one is visible. Batching per 32 m cell makes three.js' ordinary frustum culling do real work.
- **`src/world/LevelBuilder.ts`** — the Zone 1 environment: sky dome, undulating ground, 34 trees across two species, 22 rocks, a stepped temple platform with six uneven pillars, five crumbling walls, four headless guardian statues, and a water pool. Decomposed into one function per feature, each under the 50-line review limit.
- **`src/physics/Layers.ts` + `src/physics/PhysicsWorld.ts`** — the Rapier seam, including `KinematicCharacter`, the mandatory prime step, and the boot assertion.
- **`src/app/Game.ts` + `src/app/main.ts`** — the clamped fixed-timestep loop, resize handling, teardown, and a two-phase boot with an animated no-dependency loading screen.
- **Tests: 80 passing** across four suites (characterisation, PS1 maths, shader lint, level integration).

### Problems Encountered

**P1 — My own integration test caught a real bug that would have looked like "there is no ground here".**
The boot assertion in `PhysicsWorld.primeAndVerify` failed with *"no ground beneath the spawn point"* — against a level whose ground collider provably existed (the collider count was right, the trimesh extraction was right, the ray direction was right). The cause was a Rapier interaction-group trap I did not know about:

Rapier accepts an interaction only if **both** halves pass: `(query.membership & collider.filter) !== 0` **and** `(collider.membership & query.filter) !== 0`. A collider's filter lists the layers it collides with — and for the static world that list notably does **not** include `StaticWorld` itself. So passing `collisionGroupsFor([StaticWorld])` for the raycast produced membership `{StaticWorld}` against a collider filter of `{Player, Enemy, PropDynamic, PuzzleBlock, Projectile}`, the first half evaluated to zero, and the ray hit nothing — with no error, no warning, and a result indistinguishable from an empty level.

**Fix:** a separate `queryGroupsFor()` that claims membership in *every* layer and expresses intent through the filter mask alone. Worth noting how this was caught: not by reasoning, but by an assertion that *had* to hold if my understanding were correct. That is the second time in two milestones that a test has caught an error in my own head, and it is becoming the clearest argument for this project's testing discipline.

**P2 — GLSL ES 1.00 has no `round()`, and CI would never have told me.**
The vertex-snap shader used `round(ndc / gridStep)`, which is GLSL ES 3.00 syntax. In an ES 1.00 shader it is a hard compile error — presenting to a player as a black screen, with the only diagnostic in a browser console I cannot open from this environment. `floor(x + 0.5)` is exactly equivalent to JavaScript's `Math.round` for every input (both round a `.5` toward +Infinity), so the GLSL and the tested TypeScript stay in perfect agreement.
**Fix:** replaced the call, added a comment explaining why, and wrote a **GLSL ES 1.00 compatibility lint** that now statically forbids `round()`, `texture()`, ES 3.00 `in`/`out` declarations, missing precision qualifiers, `#version` directives, and array constructors. I also replaced `mat3(instanceMatrix)` with three explicit column vectors, because matrix-from-matrix construction has patchy ES 1.00 driver support — and instancing is precisely where a driver-dependent failure would be hardest to diagnose.
**Amusing sub-bug:** the new lint immediately failed on *my own explanatory comment*, which contained the forbidden word. Fixed by stripping comments before linting; a rule that forbids a construct should not also forbid explaining why it is forbidden.

**P3 — `intersectionWithShape`'s `filterGroups` is the fifth argument, not the seventh.**
TypeScript caught this one, which is exactly why `strict` plus `noUnusedLocals` are on. Passing the groups positionally into the `filterExcludeRigidBody` slot is a type error under strict mode but would be a silent, confusing no-op in looser code. The correct signature is now recorded in a comment at the call site and in `src/physics/README.md`.

**P4 — Two of my own code-quality rules were broken by my first draft of `LevelBuilder.ts`.**
The initial version had a 300-line `buildJungleLevel`, a `require()` call inside an ESM module (which would have failed under Vite), statements after a `return`, and a duplicated trimesh-extraction routine copied from `geometry.ts` instead of reused. I rewrote it as a `BuildContext` threaded through seven small per-feature functions. **I am recording this because the review protocol exists precisely to catch it, and it caught it: the rule "no function over 50 lines" is the reason the rewrite happened before the commit rather than during Milestone 3.**

**P5 — Unused-import and dead-code errors, twelve of them.** `noUnusedLocals` and `noUnusedParameters` turned these into build failures rather than lint warnings that accumulate. One was a genuine unused constructor parameter (`KinematicCharacter` took a Rapier `World` it never read), which I removed rather than silenced.

### Alternatives Considered

**Palette quantisation in the world shader vs. as a separate post pass.**
*World shader:* one fewer pass and no second render target. *Post pass:* runs once over 129,600 fragments instead of once per object with overdraw, quantises the composited frame (which is what period hardware actually did), and keeps the world shader narrow enough to audit against the tested TypeScript. **Chose the post pass**, and it also made the dither table straightforward — the palette pass samples the Bayer matrix by `gl_FragCoord`, which sidesteps GLSL ES 1.00's lack of array constructors entirely.

**Dither matrix as a GLSL const array vs. a 4×4 texture.**
*Const array:* no texture bind. *Texture:* GLSL ES 1.00 does not support array constructors, and a texture guarantees the values are bit-identical to the unit-tested TypeScript table. **Chose the texture**, which was also the era-appropriate technique — period hardware used lookup tables for exactly this.

**One `InstancedMesh` per prop type vs. per spatial cell.**
*Per type:* fewest draw calls. *Per cell:* three.js culls an `InstancedMesh` as a **single object** against its whole bounding sphere, so one visible tree means every tree in the level is drawn — the classic "instancing made my frame rate worse" trap. **Chose per cell** (32 m), which gives 1–4 visible batches for a 60° camera in a 240 m level. Draw calls rise slightly; submitted vertex work falls by an order of magnitude.

**Vertex snap via `round()` vs. `floor(x + 0.5)`.** Forced by the ES 1.00 constraint (P2), and the equivalence is exact, so there was no real trade — but it is worth recording that the *tested* TypeScript uses `Math.round` and the GLSL uses `floor(x + 0.5)`, and they agree for all inputs including negatives. A test asserts the error bound and idempotence, so a future divergence fails CI.

**Ground as a heightfield collider vs. a trimesh extracted from the rendered geometry.**
*Heightfield:* cheaper to collide. *Trimesh:* the collision surface is *literally the same buffer* as the visual surface, so the player can never float above or sink into terrain. **Chose the trimesh.** The cost is a few thousand triangles in the collision mesh, which E10's 10.6× headroom comfortably absorbs.

**Authoring the level as a data file vs. code.**
Punted, deliberately: the level is currently code, and Phase 3 will introduce a declarative DSL when there is enough content to justify the abstraction. Inventing a format for one zone would be speculative generality.

### Doubts & Uncertainties

1. **I still cannot see the game.** There is no browser in this environment, so Milestone 1.1's actual deliverable — *"working jungle scene with PS1 shaders"* — is verified only by construction and by headless tests, not by looking at it. Everything that *can* be checked without a GPU has been: the maths is tested, uniforms are cross-checked in both directions, GLSL ES 1.00 compatibility is linted, and a real character lands on the real generated terrain. **What remains unverified is genuinely unverifiable here:** whether the shaders compile on a real driver, whether the scene composes attractively, and whether `warpAmount = 0.65` is the right default. These are recorded as open questions rather than quietly assumed to be fine, and the first task of the next milestone is a manual visual checklist.
2. **`warpAmount` and the snap grid are still reasoned guesses.** The thinking is sound — bright scenes expose artefacts maximally, so default below maximum — but "is it charming?" is a human judgement that no test in this suite can make. The dev overlay for live tuning is not built yet, and it is the first thing I want once there is a browser to tune against.
3. **The scene draws ~40–120 draw calls, not the 6 I originally estimated.** Per-cell batching plus one batcher per species per variant means more batches than I assumed. It is comfortably within budget, but it is a real number rather than the optimistic one I had in my head, and I would rather record that than pretend the estimate held.
4. **`polygonOffset` is a hypothesis, not a measurement.** Vertex snapping *can* cause z-fighting between coplanar polygons, and a negative polygon offset is the standard remedy — but I have not been able to observe the z-fighting it prevents, or confirm it does not over-bias distant geometry. Flagged for the visual checklist.
5. **The Rapier chunk is 1.67 MB gzipped** — larger than hoped, though it is correctly lazy-loaded behind the loading screen so it does not block the first paint. If mobile ever becomes a target (it is explicitly scoped out, R12), this is the single largest obstacle.
6. **Two milestones, two bugs found by tests rather than by reasoning.** Phase 0's E1 corruption, and now the query-groups trap. Both were invisible to careful reading and obvious to an assertion. I am treating this as a signal about which activities actually de-risk this project.

### Next Steps

**Milestone 1.2 — the character controller (critical path).** This is the heart of the game and everything else depends on it.
1. **A manual visual checklist first**, on a machine with a browser, before building more systems on top of an unverified renderer.
2. `src/core/math/locomotion.ts` — coyote time, jump buffering, slope-band classification, and the jump-arc solver, as pure tested functions *before* they touch Rapier.
3. `src/gameplay/CharacterController.ts` — the hierarchical, discarding locomotion state machine (grounded / mantle / hang / climb / water / zip line) so mutually exclusive states are structurally impossible (risk R15), driven by the 5-ray ground cone probe.
4. The ten mandated movement edge cases, each with a test.
5. A dev overlay for live shader and tuning values, since Doubt #2 needs one.

**Then** Milestone 1.3 (camera) and 1.4 (input), after which the game is genuinely controllable and the feel can be assessed properly.

### Deep Debug Sessions

Two entries now. The second — *"Raycasts silently match nothing when handed collider-style interaction groups"* — qualified under the rule on attempt count once the boot assertion had failed and two incorrect hypotheses (a missing collider, then a wrong ray direction) had been eliminated by inspecting the world. The full analysis is in P1 above.

The earlier entry stands: *"Rapier character controller permanently ignores geometry when queried before the first world step"*.

---

## 2026-10-07 (commit 1) — Phase 0: Documentation, Doubt & One Important Mistake

**Commit scope:** the four Phase 0 documents, project scaffolding (`.gitignore`, `package.json`, pinned dependencies), and the first real test suite. No game logic. Rule #1 satisfied: `docs/` contains all four required documents before any game code exists.

### What I Built

Phase 0 is complete. No game code has been written, in accordance with Rule #1.

- `docs/ARCHITECTURE.md` — engine selection across five candidates (Three.js+Rapier, Babylon.js, PlayCanvas, Cocos Creator, and Godot 4's web export as an honest outside option), a weighted scoring matrix, the decision, and a five-point self-criticism of my own choice.
- `docs/RISK_ANALYSIS.md` — 15 risks scored by severity × likelihood, each with a described failure *mechanism*, 2–3 mitigations, an explicit chosen mitigation and a justification, plus an honest list of the three risks I am *not* fully mitigating.
- `docs/GAME_DESIGN_DOC.md` — the full spec: movement (every constant), camera, combat, six puzzle families, climbing, inventory, skills, five zones, visual style, narrative, audio, accessibility, and scope exclusions.
- `docs/DEV_LOG.md` — this file.
- **Project scaffolding** (`package.json`, pinned dependencies) and a working test harness. Two smoke tests pass, including one that runs **Rapier's WASM physics inside Vitest** — the finding that most directly shaped the architecture.

**Documentation is not busywork here.** Writing the GDD forced me to discover that several brief requirements are mutually inconsistent, and writing the architecture forced me to confront the fact that I did not actually know whether my chosen physics engine would hold a character on the ground. That question had a surprising answer.

### Problems Encountered

**P1 — I did not know my tools, so I measured them first (this was the right call).**
Rather than trusting my priors about library versions and APIs, I installed the real packages and ran twelve experiments (E1–E12, tabulated in `ARCHITECTURE.md` §4.2) before writing a single line of architecture prose. Three results changed the plan materially:

- **E1 — the character controller walks through the floor, permanently, and my first explanation of *why* was wrong.** A naive integration loop (accumulate gravity → `computeColliderMovement` → `setNextKinematicTranslation`) sank the capsule through the ground and left it in free-fall at y = −3.56, while `computedGrounded()` cheerfully reported `true`. My initial diagnosis — documented in the first draft of `ARCHITECTURE.md` — was that snap-to-ground was mandatory and that enabling it "fixed it completely". **That diagnosis was wrong.** When I converted the experiment into a permanent regression test (`test/characterisation/character-controller-grounding.test.ts`), the test failed, which forced a proper bisection over the five differences between my failing and passing scripts (E1b). Only one variable mattered: **whether `world.step()` had ever run before the first `computeColliderMovement`**. The collider offset, the order of controller creation, `setUp()` and snap-to-ground are all irrelevant. Further characterisation established that (E1c) the failure needs a first movement above ~0.03–0.04 m — and gravity's first tick at 60 Hz is −0.0027 m, so **a normal boot accidentally works**, making this a latent landmine; (E1d) the corruption **never self-heals**, and its severity depends on how the game plays afterwards — with gravity-sized ticks the capsule comes to a stable but *wrong* rest sunk ~0.18 m into the floor (y = 0.78 against a correct 0.97), while with sustained 0.1 m ticks it falls **completely out of the world** to y = −28.52; (E1e) once primed, even a 3.0 m hitch-sized movement recovers perfectly; and (E1f) a prime step plus a 2.0 m first movement is stable, so the prime step is *fully* protective. The "sunk" variant is the one that worries me most in retrospect: a player standing slightly inside the floor reads as a visual glitch or an odd collision, not as a broken character controller, so it is exactly the kind of defect that survives casual playtesting and ships.
  **Consequences (three, all now enforced):** (1) `physics.step()` runs once at world init as a **prime step**, documented as non-negotiable; (2) a **boot assertion** verifies a ground probe ray actually hits, converting a silent permanent failure into a loud immediate one, because E1c proves an unprimed world can pass casual testing; (3) snap-to-ground is retained but re-justified honestly on *feel* grounds (E2c: it removes ±0.0001 m of per-tick jitter and gives slope adhesion), not as a crash fix. The false explanation has been corrected in `ARCHITECTURE.md`, and the correction is itself recorded there rather than quietly patched, because this is the single most instructive thing that happened today.
- **E9 — impulse-based block pushing is non-deterministic.** A 50 kg box pushed by the character slid from 3.0 to 6.90 with visibly non-linear speed well below walk speed. For a puzzle whose entire success condition is "the block ends up in a 1 m³ socket", that is unacceptable: the player would be fighting friction rather than solving a puzzle. **Consequence:** the GDD now specifies a kinematic "grip mode" for puzzle blocks (fixed 0.8 m/s on the facing axis, with a per-step overlap check). This is a *design change driven by an engineering measurement*, which is exactly the kind of thing Phase 0 exists to produce.
- **E12 — capsule-on-capsule standing is real, in both directions.** A second character spawned above the first settled stably *on its head* (y = 2.89, matching the arithmetic of two stacked capsules). Milestone 1.2's edge case #10 is written as "player lands on enemy → bounce off", but the engine permits the reverse too. **Consequence:** the character controller needs an explicit non-standable-character rule in both directions, otherwise a wolf standing on the player's head becomes a permanent, absurd, and very confusing position. New edge case logged in the GDD's movement set.

**P2 — Two versions of reality.** My training priors said Vite 5, Vitest 2, TypeScript 5. The registry serves Vite **8.3.3**, Vitest **5.0.3**, and TypeScript **7.0.2** (the native-compiler line). I verified the whole toolchain end-to-end rather than assuming: `npm install` → `tsc --version` → `vitest run` → 2 passing tests. I also found that three.js r186 ships **no bundled type definitions** (the `types` field is absent and there are zero `.d.ts` files in the package), so `@types/three@0.186.0` is a required explicit dependency rather than an optional nicety. A build that type-checks is a build I can trust.

**P3 — A false alarm worth recording.** My first ramp-climbing test (E3, initial version) reported FAIL. I nearly concluded that Rapier could not climb a 25° slope. Before touching the engine, I verified the *test geometry* by raycasting surface heights (0.48 → 6.07 over x 0→12, a genuine 25° rise) and re-read the results: the character had climbed to maxY 7.16 — it had traversed the entire ramp, walked off the top, and descended. **My assertion was wrong, not the engine.** The lesson is recorded because the reflex to blame the library is exactly the reflex that leads to wasted days and unnecessary rewrites.

**P4 — Cost of the chosen stack, stated plainly.** Babylon.js unpacks to ~72 MB and PlayCanvas to ~90 MB (measured via npm metadata); Three.js plus Rapier's WASM is ~2.7 MB unpacked. We take the smaller stack and accept the consequence: **Three.js is a renderer, not an engine**, so the loop, pooling, resource lifecycle and collision-layer management are mine to write. That is W1 in the architecture self-criticism, and it is the largest honest schedule risk in this plan.

### Alternatives Considered

**Engine — chose Three.js + Rapier3D (weighted 4.60/5.00) over Babylon.js (3.45), Godot 4 web export (4.05), PlayCanvas (2.95), Cocos Creator (2.60).**
- *Babylon.js* — genuinely the better *engine*: most mature WebGPU backend, excellent docs, batteries included. Rejected on two criteria I weighted deliberately high: **headless testability** (Babylon is coupled to a live WebGL/DOM context, so my character controller could not be unit- or integration-tested in CI) and **bundle size** (~72 MB unpacked). Buying a whole engine to use ~10% of it, and paying for it in testability, is the wrong trade for a browser game whose entire value proposition is *feel*.
- *Godot 4 web export* — the honest answer to "what would I ship a 3D action-adventure in?" Its `CharacterBody3D` decomposition (`floor_max_angle` / `floor_snap_length` / `move_and_slide`) is the best mental model available, and I adopted that decomposition even while rejecting the engine. Rejected on a **30–50 MB WASM payload** and a web target that the Godot project itself treats as best-effort. Making my biggest risk (cold start, R13) my foundation is backwards.
- *PlayCanvas* — value lives in its cloud editor; a local-first, headless-tested workflow is a second-class path there.
- *Cocos Creator* — 2D-first physics and editor-generated type bindings; wrong tool for 3D PS1-style work.
- **Why Three.js won:** the two criteria I weighted highest — full shader control (affine mapping and clip-space snapping are ~8 lines of GLSL when I own the shader) and character-controller physics quality (`setMaxSlopeClimbAngle`, `enableAutostep`, `enableSnapToGround`, per-collision normals — mapping 1:1 onto the GDD's slope bands and mantle) — are precisely where it is strongest. And its headless testability is *proven*, not assumed: Rapier initialises and steps inside Vitest.

**Feel parameters — rejected symmetric gravity.** The obvious implementation of a 2 m jump is symmetric gravity, which produces a floaty moon-jump with unpredictable timing. Chose **26 m/s² rising / 42 m/s² falling** with a held-jump multiplier, because asymmetric gravity gives the player two distinct mental models (a controllable ascent, a committed descent) and compresses total airtime so more decisions happen *on the ground*, where platforming is actually decided. Chose 0.30 s acceleration over instant start/stop for the same reason: instant response removes all sense of mass, and mass is what makes a 6 m running jump feel earned rather than assisted.

**Puzzle blocks — chose kinematic grip mode over impulse pushing.** Impulse pushing (E9) is physical, emergent and *wrong for a puzzle*, because its outcome depends on friction, approach angle and frame timing. Grip mode (fixed-speed, facing-axis, overlap-checked) is deterministic, readable, and matches the 2013-era source material, where the player visibly grips and heaves a block. Verdict: continuity of *feedback* matters more than simulation purity.

**Risk register — chose to state the chosen mitigation, not just a list.** A mitigation list without a decision is a hedge that transfers the problem to implementation time. Every risk above names the mitigation I will actually build and why the others were rejected.

**Small decisions, logged so they are not re-litigated:** bullets are raycasts, not physics bodies (tunnelling class removed entirely by `ARCHITECTURE.md` §6.4); the level is a declarative TypeScript DSL rather than a binary scene format (diffable, type-checked, build-time-validated); occlusion is *authored* via zone portals rather than computed (predictable 60 FPS beats clever); and the game ships **zero binary art assets** — every texture is a seeded procedural `DataTexture` — which deletes an entire risk class (R13) along with its tooling, rather than managing it forever.

### Doubts & Uncertainties

Stated honestly, because an unrecorded doubt becomes an undetected defect.

1. **"Does it feel good?" cannot be proven by a test.** My automated tests can assert the numerical envelope (a running jump travels 6.0 m ± 0.3 m; coyote time is 120 ms ± 1 tick) but not the *perception*. I am deliberately treating the numbers as a starting point and the human verdict as the authority, and I flag this as an unhedged risk rather than claiming test coverage I do not have. The symmetric counter-risk is that I over-tune against my own taste, so every milestone's feel checklist will be explicit and dated.
2. **Rendering is invisible to CI.** Vitest cannot compile GLSL, so a broken shader fails only in a browser. My three-layer defence (extract shader math into unit-tested TypeScript; lint every GLSL uniform against its JS counterpart; keep manual visual checklists) reduces this but does not eliminate it. **This is a real hole in "test everything" and I am not pretending otherwise.**
3. **`warpAmount = 0.65` and the 480×270 target are guesses.** They are reasoned guesses (bright scenes expose artefacts maximally, so I default *below* maximum), and I have a dev overlay and a three-way reference render (full strength / tuned / off) planned to dial them. But the honest answer is that the aesthetic is unvalidated until I see it on screen.
4. **Twelve months of assumptions about three.js r186 and Rapier 0.21 APIs.** Both are newer than my priors and I have verified only the surface I touched. I expect to hit changed signatures — particularly in the `three/webgpu` and `BufferGeometry` areas — and will document each as I find it rather than fighting it silently.
5. **The 45–60 minute target with five zones is ambitious for the content contract** (each zone needs one puzzle, one combat encounter, one platforming challenge and one secret). If content density and code quality conflict, **content is what I cut**, because Rule #3 and Rule #4 make robustness and testing non-negotiable while the playtime target is a goal. I would rather ship four dense, correct zones than five where two are broken.
6. **The self-criticism in `ARCHITECTURE.md` §5 is genuine, not ceremonial.** W1 (Three.js gives no engine) is the one most likely to cost real time, and W3 (affine mapping means abandoning the entire PBR lighting pipeline) means level lighting must be authored as geometry plus vertex colours from the very first commit — a design constraint I must honour immediately, because retrofitting vertex-tint support into a finished level builder would be painful.
7. **NEW, and the most important lesson of Phase 0: a correlation observed across two hand-written scripts is not a root cause.** I published a confident, detailed, and *false* explanation of E1 into the architecture document because snap-to-ground happened to differ between a failing script and a passing one. Nothing about the reasoning felt uncertain at the time — that is the danger. What caught it was mechanical rather than intellectual: converting the experiment into an assertion that *had to be true* if my explanation were true, and watching it fail. **Consequence for how I work from here:** any claim of the form "X is why Y happens" must be accompanied by an experiment that varies X alone, and any such claim that reaches a document must reach a test at the same time. Bisection over the *complete* set of differences between two states — not just the interesting ones — is now my default for any discrepancy that is hard to explain.
8. **A modelling error worth flagging early.** My first characterisation test asserted a correct resting height of 0.95 m (half-height + radius) and failed, because the true value is **0.9701 m** — the controller's own 0.02 m offset is part of the resting position. This is not a curiosity: the same mistake would corrupt the camera's ground clamp (`groundY + 0.5`), foot-IK raycast targets, and ledge-height thresholds in Milestone 1.2. The offset is now a named constant, and the true resting height is documented in both the test and the GDD's movement section.

### Next Steps

**Milestone 1.1 — Scene & Rendering Pipeline.**
0. `src/physics/PhysicsWorld.ts` — the Rapier seam, whose **init performs the mandatory prime step and the boot ground-probe assertion** (Q1). E1 was discovered before this file existed and is now bounded by both a documented call site and the 20-test characterisation suite, so the fix is structural rather than a note to self.
1. `src/core/constants.ts` — every GDD constant in one place, typed, with units in the names (`RUN_SPEED_MPS`, `COYOTE_TICKS`, `FIXED_DT`, `CONTROLLER_OFFSET`, `PLAYER_RESTING_HEIGHT_M`). No magic numbers anywhere else, per the review protocol.
2. `src/core/math/ps1.ts` — clip-space vertex snapping, the affine UV solve, and aspect-fit letterboxing as **pure functions with exhaustive unit tests first**, since these are the shader math and are the only part of the rendering path CI can see (`ARCHITECTURE.md` §W4).
3. `src/render/PS1Pipeline.ts` — 480×270 `WebGLRenderTarget` + nearest-neighbour blit + letterboxed resize handling, plus the `ShaderSource` uniform-consistency lint test.
4. `src/render/PS1Material.ts` — the unified vertex/fragment shader pair: snapping, affine/blended UVs, flat Lambert + ambient + rim with a hard terminator, palette quantisation.
5. `src/world/LevelBuilder.ts` + procedural `DataTexture` generator (seeded PRNG) — 12–15 instanced trees, rocks, temple walls/pillars/broken statues, grass ground, procedural skybox.
6. **Then** the Milestone 1.1 manual visual checklist and the first three-way reference render, so the aesthetic question in Doubt #3 gets answered early rather than at the end.

I will only move to the character controller (Milestone 1.2, the critical path) once 1.1 renders a bright, vibrant, correctly-framed jungle I am not embarrassed by.

**Sequencing discipline:** the risk register dictates order. R15 (state architecture), R14 (grounding, already characterised) and R4 (locomotion) come first because a critical risk discovered in Phase 3 is a rewrite while the same discovery in Phase 1 is a design decision. R5 (visual identity) is validated now because content must not be authored against an unvalidated art direction.

### Deep Debug Session: Rapier character controller permanently ignores geometry when queried before the first world step

**Status:** Resolved and characterised. Root cause confirmed by bisection. Permanent regression tests written. **Documentation corrected** (my first explanation was wrong).

**Exact unexpected behaviour.**
A kinematic capsule (half-height 0.6 m, radius 0.35 m, expected resting height 0.95 m) placed 1 m above a static ground slab did not rest on it. It sank, and after 60 ticks of 60 Hz simulation sat at **y = −3.5642**, in free-fall beneath the world. The most alarming detail: `controller.computedGrounded()` returned **`true`** for much of the descent (see trace: `t10 y=0.4360 grounded=true`, `t20 y=−0.0634 grounded=true`). There is no exception, no warning, and no error code. The failure is completely silent.

**Attempt 1 — misattribution to snap-to-ground (WRONG, and it made it into the docs).**
I had two scripts: one that failed, and one that passed. The most *conceptually* interesting difference between them was `enableSnapToGround(0.4)`, and the second script's stability had a plausible mechanism (ground snapping keeps the capsule glued to the surface). I concluded that snap-to-ground was mandatory, wrote that into `ARCHITECTURE.md` §4.2, and moved on. **Why it failed:** I reasoned from the difference that was most *interesting* rather than the difference that was most *likely*, and I validated it against the same two scripts that had produced the hypothesis — a circular confirmation. A correlation seen across two hand-written scripts is not a root cause.

**Attempt 2 — the regression test contradicted me.**
When I converted the experiment into a proper test asserting that the snap-off configuration sinks, the test **failed**: with snap-to-ground disabled the capsule rested correctly at y = 0.9701. My documented mechanism was therefore disproven by my own test suite. This is the single most valuable thing that has happened in the project so far, and it is precisely the argument for Rule #4: *the act of writing the test is what exposed the error in the reasoning that produced the code.* Had I skipped the test, I would have shipped a document that every future reader (including me) would have trusted, containing a confident and false explanation.

**Attempt 3 — bisection over the five real differences.**
I enumerated the genuine differences between the failing and passing scripts: (V1) controller offset 0.01 vs 0.02; (V2) controller created before vs after the colliders; (V3) `setUp()` present or absent; (V4) a `world.step()` warm-up before the loop; (V5) snap-to-ground on or off. Testing each in isolation gave: V1 **stable**, V2 **stable**, V3 **stable**, V5 **stable**, and **V4 — no warm-up step — SANK (y = −3.7156)**. The combination reproduced the original exactly. **Root cause identified: a `computeColliderMovement` call made before the world's broadphase has ever been populated by `world.step()`.**

**Attempt 4 — characterising the boundary rather than stopping at the cause.**
Finding the trigger was not enough to act on, because "always prime the world" is only a safe rule if I know *how* it fails. More experiments:
- **Magnitude threshold (E1c):** with no prime step, first movements of 0.003 / 0.01 / 0.02 / 0.03 m are **stable**; 0.05 / 0.08 / 0.10 m are **broken** (y settles at 0.72 / 0.81 / 0.79 — sunk, not fallen through). The threshold (~0.03–0.04 m) sits just above gravity's first tick (−0.0027 m at 60 Hz). **This is why the bug is latent:** a normal boot works by luck, and only a slow first frame breaks the session.
- **Permanence and severity (E1d):** one bad pre-step call, then 300 further ticks → **never recovers**, but *how* it fails depends on the ticks that follow. Gravity-sized movements produce a stable but wrong rest sunk ~0.18 m into the floor (y = 0.78); sustained 0.1 m movements fall clean out of the world (y = −28.52). Two severities, one cause, no self-healing.
- **Post-prime robustness (E1e):** after a prime step, single movements of 0.3 / 0.5 / 1.0 / **3.0 m** all recovered to y = 0.9701.
- **Prime-step sufficiency (E1f):** prime step + first movement of 2.0 m → stable.
- **Long-run stability (E2b):** prime step, 1800 ticks (30 s), production tick order (query → step) → cumulative drift **4.52 × 10⁻⁸ m**.

**Final hypothesis (confirmed):** `KinematicCharacterController` depends on broadphase/query state that is only populated during a world step. Its first query against an unpopulated world corrupts internal state **irreversibly**, after which geometry collision is silently ignored for the lifetime of the controller. The `grounded` flag continues to report stale-but-plausible values, which is why the failure produces no diagnostic signal at all. The corruption is triggered only when the first movement is large enough to resolve a different (wrong) collision result — hence the magnitude threshold and the latency of the bug.

**Alternatives I could have tried but did not, and why:**
1. *Read the Rapier source / file an upstream issue.* Legitimate, and I may still do it, but it would not have changed the mitigation, and a mitigation I can verify with tests is worth more than a bug report I cannot.
2. *Reject Rapier and switch to a hand-rolled AABB sweep-and-slide controller.* This would have removed the dependency risk entirely (the W2 self-criticism), but the cost is very high: I would lose autostep, slope-band enforcement, per-collision normals, and 10.6× measured headroom (E10), all of which are load-bearing for the GDD. **Rejected** — one characterised and guarded quirk does not justify reimplementing a physics engine.
3. *Wrap the controller so the first call is implicitly preceded by a step.* Rejected as too clever and too implicit: it hides a hard engine requirement behind surprising behaviour, and it would break for any code path that builds its own controller (enemies).

**Approach chosen and why:** an **explicit prime step in `PhysicsWorld` initialisation**, documented at the call site with the experiment reference, plus a **boot assertion** that a ground probe ray hits something. Chosen because it makes the requirement *visible and testable* rather than implicit, because the assertion converts E1c's silent latent failure into an immediate loud one, and because the characterisation tests (E1/E1c/E1d/E1f/E2/E2b) will fail in CI if a future Rapier version changes any part of this contract. The mitigation costs one line and one assertion.

**Severity of the workaround:** none — this is a correct fix, not a hack. No `TODO` was written.

---

### Known Engine Quirks (cumulative register)

> **Process register — added commit 5.** "Asserting on remembered rather than read values."
> Observed three times: the platform-momentum patch (searched for a string that had already changed),
> the README controls table, and the jump constants above. In all three cases the *fix* was described
> in detail before the file was opened. The rule that comes out of it: **when a claim is about a value,
> quote the value from the file in the same command that acts on it.** Reasoning about numbers you
> did not read is not reasoning, it is guessing with confidence.

Required by `ARCHITECTURE.md` §W2. Every entry cites the experiment that justifies the guard.

| # | Quirk | Guard | Evidence |
|---|---|---|---|
| Q1 | `computeColliderMovement` before the first `world.step()` **permanently** breaks geometry collision for that controller, silently. Needs a first movement >0.03–0.04 m to trigger, so a normal boot hides it. | Prime step at world init + boot assertion | E1, E1b, E1c, E1d, E1f |
| Q2 | `computedGrounded()` can report `true` while the body is in free-fall. It is **necessary but not sufficient** for ground state. | 5-ray cone ground probe supplies `grounded`, `normal`, `slopeAngle` and `edgeProximity`; `computedGrounded()` is only a cross-check | E1 trace, E7 |
| Q3 | Two capsule characters can rest on one another stably, in both directions. | Explicit non-standable-character rule + bounce-off | E12 |
| Q4 | Without snap-to-ground, the idle capsule exhibits ±0.0001 m per-tick jitter. | `enableSnapToGround(0.4)` retained for feel and slope adhesion (not as a correctness fix) | E2c |
| Q5 | Neither snap-to-ground nor offset tuning affects Q1 — both were proven irrelevant by bisection. | Documented to stop a future reader from re-trying the same false fix | E1b |

---

### Deep Debug Sessions

One so far: *Rapier character controller permanently ignores geometry when queried before the first world step* (above). It qualified under the three-attempt rule, having taken four attempts plus a documented wrong diagnosis that reached the architecture document before being caught by a test.
