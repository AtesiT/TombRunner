# Jungle Relic — Risk Analysis & Mitigation Register

**Document owner:** Principal Gameplay Engineer / Technical Director
**Status:** Approved — Phase 0 gate
**Last updated:** 2026-10-07
**Method:** Severity (impact if it happens) × Likelihood (probability it happens), each 1–5. Risk Score = S × L, range 1–25.

---

## How to Read This Register

| Score | Band | Response |
|---|---|---|
| 16–25 | **Critical** | Must have a mitigation *implemented* before the dependent milestone closes |
| 10–15 | **High** | Mitigation designed up-front, implemented at first opportunity |
| 5–9 | **Medium** | Mitigation noted; implement when the system is touched |
| 1–4 | **Low** | Accept and monitor |

Each risk below states the failure *mechanism* (not just the symptom), because symptom-level risk statements produce symptom-level mitigations. Where Phase 0 experiments already produced evidence, that evidence is cited (`ARCHITECTURE.md` §4.2, experiments E1–E11).

**Summary table is at the end (§16).**

---

## R1 — Frame rate collapse in dense scenes

**Severity 5 · Likelihood 3 · Score 15 (High)**

**Mechanism.** This is not one bug but four independent draws on the same 16.6 ms budget: (a) draw-call count, which in a naive Three.js scene scales with object count because each mesh is a draw call; (b) material/shader permutations, where each unique shader forces a pipeline state change; (c) the transparent pass, where tracers, particles, foliage and water all blend and overdraw multiplies fill cost on a 480×270 target that is *cheap in pixels but not free in state changes*; (d) GC pauses from per-frame allocation, which manifest as a 1-in-200-frames hitch that players describe as "laggy" even when average FPS is fine. Averages lie; the 99th percentile frame time is what the player feels.

**Mitigations.**
1. **Instanced rendering + authored occluders + uniform-grid broadphase.** Trees, rocks, foliage, pillars and props become `InstancedMesh` batches (one draw call per material per zone); a uniform spatial grid over the level AABB provides cheap frustum rejection and per-cell culling. Authored occluder volumes at zone portals keep the underground caverns from drawing the jungle canopy above.
2. **Hard object-pooling with fixed capacity and steal-oldest eviction.** Zero allocation in the steady-state frame loop for tracers, particles, sparks, dust, ragdolls and audio voices. Pools never grow — overflow is *counted* and surfaced in a debug overlay, never silently allocated (see R9).
3. **Budget-driven quality scaler.** A `PerformanceGovernor` samples a rolling p95 frame time; if it exceeds 20 ms for 60 consecutive frames it degrades in a fixed, authored order (drop particle budget → reduce far-plane → disable per-vertex rim light → reduce dynamic shadow-caster count), and restores quality only after 5 s of sustained headroom with hysteresis to prevent oscillation.

**Chosen: 1 + 2 as foundation, 3 as safety net.** Evidence (E10) shows physics + queries cost only **1.573 ms/frame** with 6 characters, 40 dynamic bodies and 42 raycasts — a **10.6× headroom**. So the frame budget risk is *rendering*, not simulation. Therefore the load-bearing mitigations are instancing and pooling (both structural), with the governor as insurance against hardware I cannot test on. Chosen because it attacks the actual measured bottleneck rather than a guessed one; the governor alone would be a buck-passing mitigation that lets me ship a scene that is fundamentally too expensive.

---

## R2 — Physics desync makes the player feel "laggy"

**Severity 4 · Likelihood 3 · Score 12 (High)**

**Mechanism.** Three separate causes, frequently conflated: (a) **rendering stale transforms** — the renderer draws the last physics step's position while the camera has already moved, producing visible detachment; (b) **variable-`dt` simulation**, where jump height and dash distance vary with framerate, so the character "sometimes feels floaty"; (c) **input sampled on `mousemove`/`keydown` instead of the tick**, so intent arrives mid-tick and is applied with a variable, unpredictable delay.

**Mitigations.**
1. **Fixed 60 Hz timestep + render-space interpolation** (`ARCHITECTURE.md` §6.2) with a clamped accumulator, camera updated *inside* the sim tick. This makes physics bit-identical at 30/60/144 Hz and removes the floaty variation entirely.
2. **Per-tick input latching** with edge-triggered `pressedThisTick` flags so a press/release inside a single tick is never dropped, feeding the documented jump (150 ms) and interact (200 ms) buffers.
3. **Explicit visual latency budget**: ≤ 1 tick (16.7 ms) from input event to visible displacement, asserted in an integration test that measures input→transform-lag over a scripted input sequence.

**Chosen: 1 + 2, verified by 3.** Determinism is the root fix; interpolation addresses the *perceived* stagger. Chosen because it makes the feel property framerate-independent by construction, rather than compensating with a fudge factor that would need re-tuning on every machine. Note that this is *not* networked multiplayer, so classical "client/server desync" does not apply — the perceived-latency framing is the relevant one, and I have said so rather than importing the wrong mental model.

---

## R3 — Camera clips through walls

**Severity 4 · Likelihood 4 · Score 16 (Critical)**

**Mechanism.** A spring-arm camera is a *position solver*, and every position solver has a geometry-penetration failure mode: the sphere-cast from player to desired camera position resolves against the *previous* frame's geometry, so a fast camera rotation or a fast player movement can place the camera inside a wall for one or more frames before the next cast corrects it. Worse, in a jungle with thin foliage cards and one-sided geometry, casting against *all* colliders makes the camera snap aggressively inward on leaves while still failing on the two-sided geometry it must actually respect. Also: an unconstrained "zoom in on hit" produces disorienting whip-ins as the player brushes a bush.

**Mitigations.**
1. **Dedicated camera-collision layer + sphere-cast with skin width, hysteresis, and a minimum distance floor.** Only `STATIC_WORLD` and a subset of solid props participate; foliage and triggers never push the camera. A 0.25 m sphere probe (not a zero-radius ray) prevents near-plane pop-through. Asymmetric rates: pull in *fast* (avoid penetration — correctness) but push out *slow* (avoid whip — feel), with a 1.5 m hard minimum.
2. **Stuck-detector with forced reset.** If the camera remains within `minDistance + ε` for >2 s, or if the resolved position is inside geometry for >0.5 s, interpolate to a safe authored fallback position over 0.4 s. Guarantees the camera can never be permanently wedged.
3. **Ground clamp + authored corridor volumes.** Camera y is clamped to `groundY + 0.5`. Narrow passages carry authored volumes that lower FOV and reduce arm length, so tight spaces read as *intentional framing* rather than as camera failure.

**Chosen: 1 + 2 together, with 3 for authored spaces.** 1 alone cannot guarantee recovery (penetration can persist), and 2 alone would reset constantly without a good primary solver. Chosen as a pair because they cover mutually exclusive failure modes: 1 prevents penetration, 2 guarantees escape. A zero-radius ray was explicitly rejected — thin-wall pop-through is the single most common cause of "camera went inside the wall" in third-person games.

---

## R4 — Climbing feels floaty or unresponsive (the game-feel killer)

**Severity 5 · Likelihood 4 · Score 20 (Critical)**

**Mechanism.** Climbing is the highest-risk system for *perceived* quality because it is the most state-dense: ledge detection, hang, shimmy, pull-up, drop, jump-between-holds, and cancel-mid-animation are all separate states with transitions that must be *instant* and *predictable*. The failure is rarely "climbing does not work" — it is "climbing works but I do not feel in control". Concretely: (a) state transitions gated behind animation events instead of logic, so input responsiveness is capped by animation length; (b) `computedGrounded()` being unreliable while pressed against a wall, so the controller fights itself; (c) ledge detection using a single ray that misses at grazing angles; (d) pull-up completing into a position that immediately re-triggers a fall.

**Mitigations.**
1. **Logic-first, animation-follows architecture.** Every climb state transition is resolved by a pure, unit-tested state machine on the *same tick* as the input. Animations are *cosmetic* and may be cancelled, blended, or played at 1.5× speed to fit the logic. Any design where a player must wait for an animation to finish to act is a design bug, not a tuning issue.
2. **Multi-sample ledge detection with confidence scoring.** 3 horizontal rays at chest/hip/knee heights against `CLIMB_SURFACE` + a downward head-check for clearance, requiring a majority hit and then solving an explicit *hang anchor point* (not the player's instantaneous position), so the hang is geometrically stable and reproducible.
3. **Empirical characterisation harness.** Extend E1–E9 into a permanent test suite that asserts transition latency in ticks: ledge-grab start ≤ 2 ticks, pull-up input acceptance from tick 0, cancel-mantle ≤ 1 tick, shimmy at 1 m/s ± 5%.

**Chosen: 1 as the architectural commitment, 2 as the detector, 3 as the proof.** Chosen because the root cause of floaty climbing is architectural (logic deferring to animation), not parametric. No amount of tuning fixes an architecture where input is queued behind a 0.8 s pull-up clip. Also documented in `GAME_DESIGN_DOC.md` §7 as a *non-negotiable constraint*, not a goal — goals get traded away under schedule pressure; constraints do not.

---

## R5 — PS1 shaders look muddy instead of charming

**Severity 4 · Likelihood 4 · Score 16 (Critical)**

**Mechanism.** The PS1 aesthetic is a *stack of four artefacts*, and they do not degrade gracefully: (a) vertex snapping produces z-fighting and texture swimming on large, finely-tessellated surfaces; (b) affine mapping produces severe warping on large polygons viewed at oblique angles — the classic "broken PS1 floor" look; (c) the 480×270 target plus nearest-neighbour upscale turns thin geometry into aliased shards; (d) flat vertex lighting makes everything read as a single-value silhouette. Applied at full strength to *bright* content (which this game is, unlike the usual dark horror pastiche), the result is not nostalgic — it is illegible. Bright scenes have nowhere to hide: every artefact is maximally visible in high-key lighting.

**Mitigations.**
1. **Every artefact becomes a tunable parameter with a documented "taste" range, defaulting below the maximum.** `warpAmount` (0–1, default ~0.65), `snapGrid` (virtual pixels; default 1/2 of the vertical target resolution), `paletteSize` (default 32-level quantisation). These are runtime-tweakable in a dev overlay so the look can be dialled by eye *and* asserted by test.
2. **Geometry discipline enforced by the builder.** Subdivide large floors into ~1–2 m tiles so affine error is bounded by tile size; keep triangle density *deliberate* rather than maximal; align texture UVs to the grid so snapping does not cause visible swim. The level builder refuses to emit a floor quad above a configured maximum size.
3. **Lighting model that survives high-key content**: directional sun + ambient + rim term with a *hard-clamped* terminator (period-authentic), plus authored vertex colours to separate forms. Because the palette is bright, contrast must come from *hue* and *value* in vertex colour, not from shadow.
4. **A side-by-side reference render** at each milestone: the same scene at full strength, at tuned settings, and with artefacts off — so "is it charming?" is a comparison, not an opinion.

**Chosen: all four, with 1 as the primary control.** 2 and 3 are the *reason* 1 will succeed: parameters alone cannot rescue geometry that is too coarse or lighting that is too flat. Chosen as a system rather than a setting because R5 is a whole-pipeline risk, and the usual failure is treating it as a post-processing toggle.

---

## R6 — Enemy AI gets stuck on geometry

**Severity 3 · Likelihood 5 · Score 15 (High)**

**Mechanism.** Navigation failure is near-certain, not merely likely, because the enemies use a kinematic character controller over hand-authored level geometry with concave pockets (ruin walls, pillar bases, water edges, rubble). Three distinct failure modes: (a) **wedging** — the controller's slope/step limits reject the only available move, so the enemy oscillates in place; (b) **oscillation** — two goals alternate every tick, so the enemy vibrates between them; (c) **unreachable-goal persistence** — the AI keeps pathing to a player standing on a ledge it cannot climb, forever, rather than repositioning.

**Mitigations.**
1. **Progress watchdog + local recovery ladder.** Track displacement over a 1.0 s window; if it is below a threshold while the agent intends to move, escalate through a fixed ladder: sidestep → reverse → try perpendicular → **teleport to nearest valid nav point**. Each rung is time-boxed. Server-authoritative "is this position legal" checks use a capsule overlap test against `STATIC_WORLD`.
2. **Authored navigation graph over the level, not a runtime navmesh.** Because the level is hand-crafted and static, the builder emits a waypoint/portal graph alongside the geometry. This makes pathing *deterministic*, cheap (graph search, no tiling), and debuggable — and it is immune to the classic navmesh-stale-at-runtime bug class.
3. **Goal validity checking.** Before committing to a path, verify the target is on the same navigable component and within the enemy's traversal envelope (can it step/jump/climb there?); if not, switch to a *tactical* goal (hold position, patrol the nearest reachable point, bark/alert) instead of pathing forever.

**Chosen: 1 + 2, with 3 preventing the worst case.** Teleport is the last rung deliberately — it is invisible when used rarely and behind geometry, and it is strictly better than a permanently broken enemy. Chosen over a full runtime navmesh because the level is static and authored: paying the runtime cost and complexity of a dynamic navmesh to solve a problem that hand-authoring solves better would be engineering theatre.

---

## R7 — Puzzle state becomes unrecoverable (player softlock)

**Severity 5 · Likelihood 3 · Score 15 (High)**

**Mechanism.** A softlock is the worst *player-facing* outcome in the game — worse than a crash, because a crash is understood instantly while a softlock is discovered after 20 minutes of confused searching. Mechanisms: (a) a physics block pushed into a corner or against a wall such that no push angle can extract it; (b) a block pushed off a ledge, out of the playable volume; (c) a combination/light/water puzzle whose *derived* state is not fully serialised, so a save/load mid-puzzle lands in an impossible configuration; (d) two puzzles sharing a mechanism (a plate that gates a door used by another puzzle) forming an unsatisfiable cycle; (e) the player as an unintended *physical participant* — e.g. standing in a spot that permanently blocks a block's only path.

**Mitigations.**
1. **A universal, always-available "Reset Puzzle" affordance** (hold a key) that returns the *current* puzzle's movable objects to authored start transforms and resets its derived state, with a confirm prompt. Non-negotiable, ships in v1, on every puzzle.
2. **Author puzzle geometry against the failure modes.** Builder-time validation: for each puzzle, assert every block's start cell and goal cell are reachable via the block's allowed movement axes, that no goal is adjacent to an "extraction-impossible" corner (a wall on two orthogonal sides with no pull affordance), and that every block's playable region is bounded by a lip or wall so it cannot leave the volume.
3. **Full state serialisation of derived signals.** Puzzle state saves as explicit facts (plate depressed, mirror yaw, water level, door open, combination progress) — never inferred from the runtime world at load. A load reconstructs the world from facts.
4. **Cross-puzzle dependency audit.** Because the levels are hand-authored, a static dependency graph is built at level-build time and checked for cycles and for gating on consumables.
5. **Automatic unstuck watchdog.** If the player has been inside the same 4 m³ region for >90 s while a puzzle is unsolved, surface a non-intrusive hint ("Hold R to reset this puzzle"). This is a *discoverability* fix for the same root cause.

**Chosen: 1 + 3 as mandatory infrastructure, 2 + 4 as prevention, 5 as compassion.** Reset is the *guarantee* — with a working reset, no puzzle can ever hard-lock the run, so the other mitigations improve the experience rather than carry the safety-critical load. Chosen because a guarantee beats a set of probabilities: prevention is never complete, and the player must always have an escape hatch.

---

## R8 — Save-system corruption loses progress

**Severity 4 · Likelihood 3 · Score 12 (High)**

**Mechanism.** `localStorage` is a hostile environment: (a) writes can be *interrupted* by tab closure, leaving a truncated JSON string; (b) private-browsing/quota modes can throw `QuotaExceededError` on write, and a naive save silently fails; (c) schema drift — a save written by an older build lacks fields the newer build dereferences (`undefined.player.health`); (d) a save captured mid-puzzle may encode a *transient* state (player mid-air over a pit, inside a closing door) that is unresumable; (e) multi-tab writes can interleave.

**Mitigations.**
1. **Atomic double-buffer write with checksum.** Saves alternate between slots `A` and `B` with a monotonically increasing sequence number and a checksum. Write to the *inactive* slot, verify by reading back and re-checking, then commit. A torn write can only ever damage the inactive slot, so the previous good save always survives. On load, take the highest sequence number that passes checksum.
2. **Versioned, migrating, validated schema.** Every save carries `schemaVersion`; load runs a migration chain then a **full validation pass** (types, ranges, enum membership, referential integrity of objective/puzzle ids). A save that fails validation is quarantined, not applied, and the loader falls back to the previous slot — plus an explicit, honest message to the player rather than a silent reset.
3. **Checkpoint-anchored saves.** Every save records the last *validated safe transform* produced by the checkpoint system, and resumption always places the player at that anchor rather than at a raw transient position. Removes the "resumed inside geometry" class entirely.
4. **Quota-failure handling with user-visible state.** `try/catch` around all storage access; on failure the game surfaces "saving is unavailable" and continues in a degraded session-only mode rather than pretending to have saved.

**Chosen: 1 + 2 + 3.** 1 guarantees no torn write can destroy the only copy; 2 guarantees a bad-but-valid-checksum save cannot crash the game; 3 guarantees a valid save cannot resume into an invalid world state. These cover the three *independent* corruption pathways (write-time, read-time, semantics), which is why all three are needed. Chosen over a single-blob save with a try/catch because that leaves the highest-severity pathway (torn write destroying the only copy) completely open.

---

## R9 — Memory leak from object pooling crashes long sessions

**Severity 5 · Likelihood 3 · Score 15 (High)**

**Mechanism.** Pools *look* like leak fixes but can hide leaks: (a) a pool that grows on exhaustion is a leak with a friendlier name; (b) pooled objects that retain references to world/entity objects keep whole subgraphs alive; (c) event listeners and subscription callbacks registered per spawn but never removed; (d) physics colliders removed from the world but whose Rapier handles (WASM-side allocations) are never `free()`d — WASM memory is *outside* the JS GC and this leak is invisible to heap profilers; (e) `THREE.BufferGeometry`/`Texture` allocated per effect instead of reused.

**Mitigations.**
1. **Fixed-capacity pools with steal-oldest eviction and an overflow counter.** Pools never allocate in steady state. Overflow is a *metric*, asserted to be 0 in a 10-minute automated soak test.
2. **Explicit lifecycle contract with `dispose()`.** Every pooled/spawned object implements `reset()` and `release()`; the pool calls `release()` on eviction. A debug build tracks live-handle counts per pool and asserts a return to baseline on quiescence.
3. **Rapier handle accounting.** Wrappers around `createCollider`/`createRigidBody`/`removeRigidBody` maintain a live count; a debug HUD shows it. Auto-remove with `removeRigidBody` (which frees attached colliders) is preferred over removal-by-collider to prevent orphaned handles.
4. **Automated soak test in CI.** A headless 10-minute simulated session (spawn/kill 200 enemies, fire 5 000 tracers, complete and reset every puzzle twice) asserting: JS heap growth < 5%, Rapier live-handle count returns to baseline, and pool overflow counters are exactly 0.

**Chosen: 1 + 2 + 4, with 3 because WASM memory is invisible to JS tooling.** 4 is the load-bearing one: leaks are only *provable* by measurement, and the WASM dimension is the one that would otherwise escape `--inspect` entirely. Chosen because "we use pooling" is a claim, whereas a soak test with a heap-growth assertion is evidence.

---

## R10 — Input lag from browser event handling

**Severity 4 · Likelihood 2 · Score 8 (Medium)**

**Mechanism.** Sources, in descending order of typical impact: (a) **pointer-lock sensitivity/smoothing** — applying per-event deltas directly to yaw introduces jitter, so code adds smoothing/acceleration that reads as *sluggish*; (b) **synchronous work in the event handler** (raycasts, DOM writes) delaying the next frame; (c) **compositor-level latency** from unpaced rendering (no `requestAnimationFrame` alignment); (d) gamepad polling on the wrong cadence (the Gamepad API has no events — polling on `rAF` vs. per-tick matters); (e) browser-level sources outside my control (vsync queue depth, compositing).

**Mitigations.**
1. **Events mutate a plain accumulator only; zero logic in handlers.** `mousemove` accumulates raw deltas; `keydown` sets a bit. All interpretation happens at tick start. Handlers become provably O(1), and the input path is unit-testable by feeding synthetic event sequences.
2. **Raw, unaccelerated, unsmoothed mouse look with per-tick consumption.** Yaw/pitch integrate `accumulatedDelta × sensitivity` once per tick and the accumulator is zeroed — no double-application, no smoothing, no acceleration curve. Optional (and off by default) exponential smoothing at the *velocity* level only, because player-imposed smoothing must be a choice, not a liberty taken on the player's behalf.
3. **Gamepad polled exactly once per tick**, with edge detection derived from previous-tick state, and automatic seamless fallback to keyboard/mouse if the pad disconnects mid-game (with the last input source tracked so a *disconnect* does not require the player to press something to recover control).
4. **Latency measurement harness.** A scripted integration test asserts ≤ 1 tick input→transform lag; a dev overlay reports event-to-visible-frame latency.

**Chosen: 1 + 2, measured by 4.** Medium likelihood because browsers are actually quite good here; the realistic risk is *accidentally* introducing lag via well-intentioned smoothing. Chosen because the architectural fix (dumb handlers, per-tick interpretation) makes the whole class of accidental-latency bugs structurally impossible rather than merely rare. Note the deliberate honesty: (e) cannot be mitigated from JavaScript, and I will not pretend otherwise.

---

## R11 — Audio desync from game events

**Severity 3 · Likelihood 3 · Score 9 (Medium)**

**Mechanism.** Audio is the most *asynchronous* subsystem in a browser game: (a) `AudioContext` starts suspended until a user gesture, so early cues are silently dropped or queued into a burst; (b) decode/registration latency means a sound requested on the same tick as its trigger plays tens of milliseconds late; (c) a fixed voice pool with an eviction policy may evict *important* audio (the boss's attack telegraph) in favour of unimportant audio (footstep spam); (d) `currentTime` scheduling drifts from simulation time, so music stingers land off-beat relative to gameplay beats.

**Mitigations.**
1. **Explicit audio clock anchored to the simulation tick, not to `performance.now()`.** All scheduling uses `audioContext.currentTime` + a computed lead offset, so cues are scheduled *ahead* onto the audio thread (sample-accurate) rather than triggered late from the main thread.
2. **Pre-decode into `AudioBuffer`s at zone load; never decode during gameplay.** Decoded buffers are reused from a registry. Procedurally generated audio (see below) is rendered once into a buffer at boot.
3. **Priority-based voice allocation.** Voices carry a priority class (combat-critical > player > enemy > ambience > footstep). Eviction always takes the *lowest* priority voice, never simply the oldest, with a per-class cap (e.g. max 2 concurrent footsteps, dropping rather than stacking).
4. **Gesture-gated unlock with intent preservation.** The title screen's "Start" button unlocks the context and *resumes* it; any cue requested while suspended is either dropped with a counter (for one-shots) or deferred to the next tick after resume (for stateful loops).

**Chosen: 1 + 3 as the core.** 1 removes scheduling drift at the source (the correct fix for "desync"); 3 prevents the audible-artefact class where important cues vanish. 2 is a latency optimisation, and 4 is a correctness prerequisite for any of it to be audible at all. Chosen because desync is a *scheduling* problem and priority loss is an *allocation* problem — the two most common mechanisms are distinct and both need addressing explicitly.

---

## R12 — Mobile browser incompatibility limits audience

**Severity 2 · Likelihood 4 · Score 8 (Medium)**

**Mechanism.** Not one incompatibility but a stack: (a) **touch has no hover/aim affordance** — a mouse-aimed third-person shooter cannot be trivially mapped; (b) **no keyboard** breaks the entire control scheme; (c) **temperature-driven sustained throttling** means a mobile device may pass a 10-second benchmark and still stutter after 3 minutes, because sustained GPU clocks are far below burst clocks; (d) **iOS Safari memory ceilings** terminate tabs that exceed a per-tab budget, which a 3D game can hit; (e) `AudioContext` gesture rules are stricter on mobile.

**Mitigations.**
1. **Desktop-first scope, explicitly declared.** The GDD's control scheme targets keyboard+mouse and gamepad. Mobile is *not* a launch requirement, and saying so is better engineering than shipping a broken mobile experience. This is a scope decision documented in the open, not an omission.
2. **Cheap defensive compatibility, not a port.** Viewport meta, `touch-action: none`, no reliance on `hover`, graceful message on unsupported WebGL2, and a hard "rotate/size" guard. The render target's fixed low internal resolution (480×270) is *catastrophically* friendly to mobile fill rate — the game is accidentally near-optimal for mobile GPUs in a way few 3D web games are, so the option stays open cheaply. A left-stick + drag-look + tap-to-jump touch scheme is noted as a stretch goal (Phase 6), not a commitment.
3. **Sustained-load testing, not burst testing.** Performance acceptance is measured over a 3-minute continuous run, never a 10-second spike, so throttling is detected rather than hidden.

**Chosen: 1 + 2.** Chosen because attempting three input paradigms in one 45-minute authored level would degrade all three; the honest scope statement plus a genuinely cheap technical posture preserves the option without spending the budget. Chosen over "full mobile support" because a half-finished touch port is worse for mobile players than a clear statement.

---

## R13 — Asset loading times make players quit

**Severity 4 · Likelihood 2 · Score 8 (Medium)**

**Mechanism.** (a) A single monolithic bundle containing Three.js + Rapier WASM + all zone data must fully download before *anything* renders, so the player stares at a blank page; (b) progress bars that lie (stuck at 90%) destroy trust more than a slow honest bar; (c) texture decode stalls the main thread; (d) WASM compilation/instantiation is a distinct, blocking cost after download with no intermediate feedback.

**Mitigations.**
1. **Two-phase boot with a genuinely interactive first paint.** Phase A loads only Three.js and renders a live, animated title screen with a procedural skybox and the camera orbiting a small diorama — *no* physics, *no* zone data. Phase B dynamically imports Rapier and zone 1 while the player is still reading the title, surfacing progress subtly.
2. **Zero binary art assets by design.** Every texture is generated procedurally at runtime as `DataTexture` from a **seeded** PRNG; every mesh is built from primitives by the level builder. There is nothing to download but code, so the entire decode-stall class (c) is structurally eliminated, and "random" foliage/rocks remain reproducible across reloads (which testing requires).
3. **Honest, granular progress with a real failure path.** Progress is driven by actual chunk events, weighted by *compiled* size, and any chunk failure surfaces a retry affordance instead of hanging at 90%.
4. **Measure it.** Cold-start time to interactive first paint is recorded in `DEV_LOG.md` per milestone, with a target of **< 2 s** on a mid-range laptop with a warm connection.

**Chosen: 1 + 2, instrumented by 3 + 4.** 2 is the highest-leverage decision here: it does not merely optimise asset loading, it *deletes the asset pipeline*, which removes an entire risk class along with its tools, formats, and failure modes — a major simplification that pays for itself repeatedly. Chosen because it converts a scheduling risk into a non-issue rather than managing it forever.

---

## R14 — Collision detection failures (player falls through the floor)

**Severity 5 · Likelihood 2 · Score 10 (High)**

**Mechanism.** ⚠️ **Not hypothetical — reproduced during Phase 0.** Experiment E1: a kinematic capsule with the naive "apply gravity, then move by the computed delta" loop, with snap-to-ground *disabled*, **sank through the floor within 60 steps** and free-fell to y = −3.56. The mechanism is that the controller's ground test fails once the capsule has crept below the surface, and there is then no collision left to resolve. Enabling `enableSnapToGround(0.4)` fixed it completely (E2: stable at y = 0.970 over 600 steps, zero drift).

Additional mechanisms: (a) very high speeds tunnelling thin geometry — E6 proved character speeds are safe against a 0.5 m wall, but a fast projectile or a launched ragdoll is not; (b) large world coordinates losing float precision far from the origin; (c) geometry with inverted or missing normals letting the character pass through; (d) teleports/respawn placing the capsule partly inside solid geometry with no resolve step.

**Mitigations.**
1. **Ground snapping is mandatory in the character controller, and asserted.** A regression test fails the build if the controller is ever constructed without snap-to-ground, and asserts the capsule stays within 5 cm of the expected ground height over 600 ticks of idle and of running (E2, E3 as permanent tests).
2. **A kill-plane plus a validated-respawn invariant.** An absolute `y = KILL_Y` plane triggers respawn, and *no* respawn transform can be committed without first passing a capsule-overlap validity check against `STATIC_WORLD`. A bad checkpoint therefore cannot be created.
3. **CCD where it is needed and only where it is needed.** Characters at gameplay speeds are proven safe; grenades, launched ragdolls and moving platforms get CCD. Bullets are raycasts, which removes the fastest objects from the solver entirely.
4. **Keep the level near the origin** (design constraint: level AABB within ±250 m) and enable a fixed 1/60 s step, avoiding the two classic precision sinks.
5. **Builder-time geometry validation.** The level builder flags inverted normals, zero-area triangles, non-manifold solids and double-sided thin walls in the *collision* mesh (visual mesh may be double-sided; collision must not).

**Chosen: all five.** This is the one risk where the evidence (E1) justifies maximum defensive spending, because the failure is catastrophic, hard to notice in testing (it manifests as an occasional fall through the world at an unpredictable location), and cheap to defend against. Chosen over "just be careful with the controller" because E1 demonstrates a *silent* failure from a completely reasonable-looking implementation.

---

## R15 — State-management complexity causes bugs from intertwined systems

**Severity 4 · Likelihood 4 · Score 16 (Critical)**

**Mechanism.** ⋆ This is the risk most likely to actually sink the project, because it is diffuse: every individual coupling decision looks reasonable in isolation and the resulting knot is only visible in hindsight. Concrete mechanisms: (a) `CharacterController` accumulating flags for climbing, aiming, water, mantle, hang, in-combat and dead, producing 2ⁿ untested combinations and illegal states (mantling while dead, aiming while climbing); (b) **update-order sensitivity** — a camera reading a character transform that a later system will overwrite, producing one-frame lag that appears intermittently and is nearly impossible to reproduce; (c) puzzles writing directly to doors, doors writing to audio, audio writing to objectives, forming a cycle that is neither debuggable nor saveable; (d) transition logic smeared across several systems so no single place defines "what states are legal"; (e) gameplay code reaching into rendering internals, so a rendering refactor silently breaks gameplay.

**Mitigations.**
1. **Explicit hierarchical state machines for the player, per-domain.** `LocomotionState` (grounded/mantle/hang/climb/water/zipline) as the *top-level* discarding state machine, so exactly one locomotion mode is active and mutually exclusive states are *structurally impossible*. Orthogonal concerns (`AimingState`, `CombatState`, `HealthState`) are *separate* machines, not flags in a bag. Every transition is declared in one table with explicit guards and is exhaustively unit-tested, including the illegal ones.
2. **A single ordered update pipeline, declared in one file, with an invariant test.** Order is fixed and documented: `input → player logic → AI → puzzles → physics step → post-physics resolvers → camera → world/audio/render sync`. Camera scheduled *after* physics resolves means the camera can never read a stale transform. An automated test asserts that no system reads a transform written by a later system.
3. **Event-driven decoupling with a strict rule: events flow *up*, never *sideways or down*.** Puzzles emit `PuzzleSolved`; the zone/objective layer listens. A door never calls the audio system. This keeps the dependency graph acyclic (enforced by an import-direction lint test), and makes puzzle state serialisable because every fact has exactly one owner.
4. **One owner per fact.** Each piece of state is written by exactly one module; others read or request. This is asserted by code review discipline plus narrow, readonly-typed interfaces exposed to consumers.
5. **Layered architecture enforced mechanically**, not by convention: `core → physics → render → world → gameplay → game → app`, with an automated import-direction test failing the build on any upward import (mitigation W1's structural guarantee).

**Chosen: all five, with 1 and 2 as the load-bearing structural fixes.** Chosen because complexity bugs cannot be caught by the tests that this structure exists to make possible — you cannot test your way out of an architecture that permits illegal states. Making illegal states *unrepresentable* (one active locomotion state, one writer per fact, one direction of imports, one declared update order) is the only mitigation that scales as systems are added, which is exactly the trajectory of this project.

---

## 16. Risk Summary Table

| ID | Risk | S | L | Score | Band | Primary mitigation | Status |
|---|---|---|---|---|---|---|---|
| R4 | Climbing feels floaty/unresponsive | 5 | 4 | **20** | Critical | Logic-first state machine; animation is cosmetic | Designed |
| R3 | Camera clips through walls | 4 | 4 | **16** | Critical | Camera layer + sphere probe + stuck-reset | Designed |
| R5 | PS1 shaders look muddy | 4 | 4 | **16** | Critical | Parameterised artefacts + geometry discipline + reference renders | Designed |
| R15 | State-management complexity | 4 | 4 | **16** | Critical | Discarding FSM, ordered pipeline, acyclic events, layered lint | Designed |
| R1 | Frame-rate collapse in dense scenes | 5 | 3 | **15** | High | Instancing + pooling + performance governor | Designed |
| R6 | Enemy AI stuck on geometry | 3 | 5 | **15** | High | Progress watchdog + authored nav graph | Designed |
| R7 | Puzzle softlock | 5 | 3 | **15** | High | Universal reset + fact-based serialisation | Designed |
| R9 | Memory leak from pooling | 5 | 3 | **15** | High | Fixed pools + Rapier handle accounting + soak test | Designed |
| R2 | Physics desync / perceived lag | 4 | 3 | **12** | High | Fixed timestep + latched input + interpolation | Designed |
| R8 | Save corruption | 4 | 3 | **12** | High | Atomic double-buffer + migration + validation | Designed |
| R14 | Falls through floor | 5 | 2 | **10** | High | Snap-to-ground (**reproduced**), kill-plane, validated respawn | **Evidence obtained (E1/E2)** |
| R11 | Audio desync | 3 | 3 | 9 | Medium | Audio-clock scheduling + priority voices | Designed |
| R10 | Input lag | 4 | 2 | 8 | Medium | Dumb handlers, per-tick interpretation, measured | Designed |
| R12 | Mobile incompatibility | 2 | 4 | 8 | Medium | Declared desktop-first; cheap defensive posture | Accepted + scoped |
| R13 | Loading times | 4 | 2 | 8 | Medium | Two-phase boot + zero binary assets | Designed |

**Risks with evidence already in hand:** R14 (reproduced and fixed, E1→E2), R4 and R1 partially characterised (E3–E10 established the achievable envelope and the 10.6× simulation headroom).

**Risks I am explicitly not fully mitigating, stated honestly rather than buried:**
- **R12 (mobile)** — scoped out at launch by decision, not by oversight.
- **R10(e) (browser compositor latency)** — outside JavaScript's reach; mitigated only as far as the application layer allows.
- **R5 (subjective taste)** — parameterised and reference-rendered, but "is it charming?" is ultimately a human judgement that I flag as an open question in `DEV_LOG.md` rather than claiming to have solved.

---

## 17. Risk-Driven Sequencing

The register dictates build order — highest-score risks are retired earliest, because a critical risk discovered in Phase 3 is a rewrite while the same discovery in Phase 1 is a design decision:

1. **R15 (architecture) + R14 (grounding) + R4 (locomotion core)** — Milestone 1.2. Nothing else can be built on unstable locomotion, and E1/E2 mean grounding is already characterised.
2. **R3 (camera)** — Milestone 1.3, because camera feel is inseparable from locomotion feel and both must be tuned together.
3. **R5 (visual identity)** — Milestone 1.1 and continuously thereafter, since art direction must be validated before content is authored against it.
4. **R1/R9/R10/R2 (performance substrate)** — established during Phase 1 while the systems are small enough to restructure cheaply.
5. **R7/R8/R6 (gameplay robustness)** — Phase 2, where the infrastructure (reset, serialisation, nav graph) is built alongside the systems rather than bolted on.
6. **R11/R13/R12 (presentation and reach)** — later, since they degrade gracefully and have low or accepted scores.
