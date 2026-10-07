# Jungle Relic — Development Log

> Every entry follows the mandated structure: **What I Built · Problems Encountered · Alternatives Considered · Doubts & Uncertainties · Next Steps.**
> Deep-debug analyses are appended as `### Deep Debug Session: [Bug Name]` when a problem survives three fix attempts.
> Workarounds are always logged with a severity rating. Nothing is silently hacked.

---

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
