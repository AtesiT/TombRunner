# Jungle Relic — Development Log

> Every entry follows the mandated structure: **What I Built · Problems Encountered · Alternatives Considered · Doubts & Uncertainties · Next Steps.**
> Deep-debug analyses are appended as `### Deep Debug Session: [Bug Name]` when a problem survives three fix attempts.
> Workarounds are always logged with a severity rating. Nothing is silently hacked.

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
