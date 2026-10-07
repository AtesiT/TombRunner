# Jungle Relic — Technical Architecture

**Document owner:** Principal Gameplay Engineer / Technical Director
**Status:** Approved — Phase 0 gate
**Last updated:** 2026-10-07

---

## 1. Executive Summary

Jungle Relic is a browser-native, 3D, PS1-styled action-adventure targeting **60 FPS on a mid-range 2020 laptop** and a **45–60 minute authored play session**. The technical pillars, in priority order, are:

1. **Game feel** — the character controller and camera must feel like a 2013-era AAA action-adventure, not a browser tech demo.
2. **Determinism & testability** — every physics-critical system must be verifiable headlessly in CI.
3. **Authentic-but-bright presentation** — genuine PS1 rendering artifacts (vertex wobble, affine warping, 480×270 internal resolution) applied to a *vibrant* jungle palette, never a horror palette.
4. **Robustness** — a softlock is worse than a crash. Every puzzle, save, and traversal state must be recoverable.

The chosen stack is **TypeScript + Three.js (r186) + Rapier3D (WASM, 0.21) + Vite 8 + Vitest 5**.

This document is deliberately written *after* empirical validation rather than before it. Sections 4.2 and 7 contain measurements taken from the real dependency versions on a real machine, including a **character-controller failure I reproduced in the chosen physics engine**, which materially changed the implementation plan in `docs/GAME_DESIGN_DOC.md`.

---

## 2. Evaluation Criteria & Weighting

| # | Criterion | Weight | Why it matters for *this* game |
|---|-----------|--------|-------------------------------|
| C1 | PS1 shader authoring freedom | 25% | Affine mapping + vertex snapping + low-res target are the *entire* art direction. If the engine fights custom shaders, the game has no identity. |
| C2 | Physics quality for a *character* | 25% | Climbing, ledge grabs, mantle, precise 6 m running jumps, buoyancy. A generic rigidbody solver is not enough; we need a kinematic character controller with autostep, ground snapping, and slope limits. |
| C3 | Headless testability | 15% | Our own rules mandate automated tests. A physics engine that cannot run in Node makes the controller untestable and turns game feel into guesswork. |
| C4 | Bundle size / cold start | 10% | Browser games lose players at the loading screen. Physics WASM is the dominant cost. |
| C5 | WebGPU future-proofing | 10% | Not required today; required to not be a dead end in 2 years. |
| C6 | Community, docs, AI-friendliness | 10% | Determines how fast I can resolve novel problems without a human mentor. |
| C7 | ECS / architecture ergonomics | 5% | Clean layering; must not *force* a heavy framework on a 1-level game. |

Note the deliberate inversion of a common ranking: **testability (C3) outranks bundle size (C4)**. A 1 MB larger download is a one-time cost; shipping an untestable controller is a permanent velocity and quality tax.

---

## 3. Candidate Analysis

### 3.1 Three.js + Rapier3D (CHOSEN)

- **Rendering (C1) — Excellent.** Three.js is a *renderer*; `ShaderMaterial`, `RawShaderMaterial`, `WebGLRenderTarget` and `DataTexture` give byte-level control over GLSL. Affine mapping and clip-space vertex snapping are ~8 lines of GLSL each, because I own the whole shader. No material-graph abstraction stands between me and the hardware.
- **Physics (C2) — Excellent, with caveats.** Rapier 0.21 ships `KinematicCharacterController` with exactly the primitives this game needs: `setMaxSlopeClimbAngle`, `setMinSlopeSlideAngle`, `enableAutostep`, `enableSnapToGround`, `setApplyImpulsesToDynamicBodies`, `computedGrounded()`, and per-collision `normal1` reporting. This maps 1:1 onto the GDD's slope bands, mantle, and block-pushing requirements.
- **Testability (C3) — Excellent and *verified*.** `@dimforge/rapier3d-compat` is a JS+WASM bundle that initialises in Node. I confirmed `RAPIER.init()` → 120-step character simulation → `computedGrounded() === true` passes inside **Vitest** (see `test/unit/rapier-smoke.test.ts`). This is the decisive criterion.
- **Bundle (C4) — Moderate.** `three` ~700 KB min, `rapier3d-compat` ~2.0 MB unpacked (WASM ~1.4 MB, gzip ~500 KB). Both code-split and lazy-loadable.
- **WebGPU (C5) — Good.** `three/webgpu` exports a real `WebGPURenderer` in r186 (verified by import). The PS1 pipeline will be authored so the upgrade is a renderer swap, not a rewrite.
- **Community (C6) — Best in class.** Largest 3D-web corpus; every shader question I can ask has a prior answer.
- **ECS (C7) — Bring your own.** Three.js has no ECS. For a single 45-minute authored level, a bespoke, explicit, well-typed system registry is *simpler and faster* than a generic ECS framework. I treat this as neutral-to-positive.

### 3.2 Babylon.js + Ammo/Havok/Cannon

- **Rendering (C1) — Good.** `ShaderMaterial` and `NodeMaterial` both exist; PS1 effects are achievable.
- **Physics (C2) — Split.** Babylon's physics abstraction is plugin-based: **Havok (WASM)** is excellent but the browser distribution adds a separate ~1 MB WASM with a less ergonomic character-controller surface; **Cannon-es** is pure JS and *too weak* for precise ledge/mantle work; **Ammo.js** is a 2011-era asm.js port with poor maintenance. The engine is superb; the *physics* is the weak link for our specific needs.
- **Testability (C3) — Poor.** Babylon is deeply coupled to a DOM/WebGL context. Engine-level headless testing requires a canvas shim; physics-only tests are possible but awkward. 
- **Bundle (C4) — Poor.** `@babylonjs/core` unpacks to **~72 MB** (measured via npm metadata); even treeshaken, a realistic build is several times Three.js.
- **WebGPU (C5) — Excellent.** Babylon has the most mature production WebGPU backend of any JS engine, plus native Node WebGPU paths.
- **Community (C6) — Excellent**, with an unusually active official forum.
- **Verdict:** The strongest *engine*, but we are buying a full engine to use ~10% of it, and we pay in bundle size and testability. Rejected primarily on **C3 + C4**.

### 3.3 PlayCanvas

- **Rendering (C1) — Good.** Push-based forward renderer with shader chunk overrides; PS1 effects demonstrated by the community.
- **Physics (C2) — Weak for our needs.** PlayCanvas' own engine is basic; serious use means Ammo.js. Same character-controller deficit as Babylon/Ammo.
- **Testability (C3) — Poor.** Editor-centric workflow; the *editor* is where the value lives, and it is a cloud product. Local development without the editor is a second-class path.
- **Bundle (C4) — Poor.** ~90 MB unpacked (measured); runtime is leaner (~1.5 MB min) but the workflow assumes the hosted editor.
- **WebGPU (C5) — Good**, and it is the engine's stated direction.
- **Community (C6) — Moderate.** Smaller corpus, heavily editor-oriented tutorials.
- **Verdict:** Optimised for teams that want an editor and a managed pipeline. We need *shader control and testability*. Rejected.

### 3.4 Cocos Creator

- **Rendering (C1) — Fair.** Custom materials are possible, but a full PS1 fragment pipeline fights the built-in 2D-first material system and its type generation.
- **Physics (C2) — Weak.** Built-in physics is 2D-focused (Box2D); 3D requires a Cannon/Bullet binding that is comparatively immature.
- **Testability (C3) — Poor.** Editor-generated type bindings and a component lifecycle tied to the editor make headless testing genuinely unpleasant.
- **Bundle (C4) — Good.**
- **WebGPU (C5) — Fair.**
- **Community (C6) — Moderate**, largely Chinese-language and 2D/mobile-gaming oriented.
- **Verdict:** A strong product for 2D/casual mobile. Wrong tool for a 3D PS1 action-adventure. Rejected.

### 3.5 Godot 4 (Web Export) — the "outer" option

Included because it is the honest answer to "what would I actually ship a 3D action-adventure in?" Godot's `CharacterBody3D` is arguably the best-engineered kinematic character controller in any open-source engine, and its editor would make 5 zones trivially authorable.

- **Rejected on:** Web export is a **~30–50 MB WASM payload** with a slow cold start and a well-documented history of browser audio/threading compromises; the web build is explicitly a "best-effort" target, not a first-class one. For a browser-first game, shipping our biggest risk (C4) as our foundation is backwards.
- **Salvageable insight:** Godot's `move_and_slide` + `floor_max_angle` + `floor_snap_length` decomposition is the *correct* mental model for a character controller, and I adopt that decomposition (`docs/GAME_DESIGN_DOC.md` §4) even though I reject the engine.

---

## 4. Decision

### 4.1 Scoring Matrix

Scores 1–5, weighted by §2.

| Criterion (weight) | Three+Rapier | Babylon | PlayCanvas | Cocos | Godot-Web |
|---|---|---|---|---|---|
| C1 Shaders (25%) | **5** | 4 | 4 | 3 | 5 |
| C2 Physics (25%) | **5** | 3 | 2 | 2 | 5 |
| C3 Testability (15%) | **5** | 2 | 2 | 2 | 3 |
| C4 Bundle (10%) | 3 | 2 | 2 | 4 | **1** |
| C5 WebGPU (10%) | 4 | **5** | 4 | 3 | 3 |
| C6 Community (10%) | **5** | **5** | 3 | 3 | 5 |
| C7 ECS/Arch (5%) | 4 | 4 | 4 | 3 | 4 |
| **Weighted total** | **4.60** | 3.45 | 2.95 | 2.60 | 4.05 |

**Three.js + Rapier3D wins at 4.60/5.00.** It wins because the two criteria I weighted highest — shader control and character physics quality — are precisely where it is strongest, and because its headless testability is *empirically proven*, not assumed.

### 4.2 Empirical Validation (run before committing to this stack)

All figures measured on the development machine (Node 22.22.3, x86-64) against the exact pinned versions.

| Experiment | Result | Architectural consequence |
|---|---|---|
| **E1** Character capsule, **no `world.step()` before the first controller query**, first movement −0.1 m, then 60 further ticks | Character **sank through the floor** and free-fell to y = −3.56. `computedGrounded()` still reported `true` while free-falling. | **A prime `world.step()` is mandatory after building the world.** See E1b/E1c for the bisected root cause. |
| **E1b** Bisection over the five differences between the failing and passing scripts | **Only one variable matters:** whether `world.step()` ran before the first `computeColliderMovement`. Offset, controller-creation order, `setUp()` and snap-to-ground are all irrelevant. | The bug is *state corruption from an unpopulated broadphase*, not a tuning problem. |
| **E1c** First-movement magnitude sweep, **no** prime step: 0.003 / 0.01 / 0.02 / 0.03 / 0.05 / 0.08 / 0.10 m | Stable at ≤0.03 m; **broken at ≥0.05 m** (settles sunk at y = 0.72 / 0.81 / 0.79). | The threshold sits right above gravity's first tick (−0.0027 m at 60 Hz), which is why the bug is **latent**: a normal boot looks fine and only a large first frame breaks it. |
| **E1d** Corruption persistence and severity: one bad pre-step call, then 300 further ticks | **Never recovers.** Severity depends on subsequent movement magnitude: with gravity-sized ticks the capsule comes to a stable but **wrong** rest, sunk ~0.18 m into the floor (y = 0.78 vs the correct 0.97); with sustained 0.1 m ticks it falls **completely out of the world** to y = **−28.52**. | There is no self-healing. The "sunk" variant is the more insidious of the two — a player standing slightly inside the floor reads as a visual glitch or a collision oddity rather than as a physics failure, so it could survive casual testing. |
| **E1e** Large movements (0.3 / 0.5 / 1.0 / 3.0 m) **after** a prime step | All **recovered** to y = 0.9701. | Post-prime, the controller is robust to arbitrary hitch-sized movements. |
| **E1f** Prime step + first movement of 0.1 / 0.5 / 2.0 m | All **stable**. | The prime step is *fully* protective, even against a pathological first frame. |
| **E2** Prime step, then 600 ticks (10 s) | y stabilised at **0.970** (capsule half-height 0.6 + radius 0.35 = 0.95 + 0.02 offset), **zero drift**. | Snap-to-ground is a *separate, independently valuable* setting (jitter suppression, slope stickiness) — it is **not** the fix for E1. |
| **E2b** Prime step, 1800 ticks (30 s), production tick order (query → step) | y = 0.9701, cumulative drift **4.52 × 10⁻⁸ m**. | The architecture's fixed-tick order is numerically sound over a whole play session. |
| **E2c** Prime step, `enableSnapToGround(0.4)` off vs on, 200 ticks each | Both stable at 0.970; snap-on removes sub-millimetre per-tick jitter (Δy oscillating ±0.0001 vs exactly 0.0000). | Snap-to-ground is kept for feel and slope adhesion, and is justified on those grounds — not as a crash fix. |
| **E3** Walk up a verified 25° ramp (raycast-confirmed surface heights 0.48 → 6.07 over x 0→12) | Climbed to maxY **7.16**, traversed the top, descended correctly | Slope bands in the GDD are achievable with `setMaxSlopeClimbAngle(50°)`. |
| **E4** 55° ramp, `maxSlopeClimbAngle = 50°` | Character **blocked at x = 4.71** (ramp base) | The GDD's ">45° slide, 60°+ climb-only" rule is enforceable by the engine, not by bespoke code. |
| **E5** 0.3 m stair, `enableAutostep(0.4, 0.25, true)` | Stepped over cleanly, continued to x = 11.90 | **Free mantle at ≤0.4 m.** Bespoke mantle code is required only for the 0.4–1.2 m band. This substantially de-risks Milestone 1.2. |
| **E6** 0.5 m-thick wall at 6 m/s, no CCD | Stopped cleanly at x = 2.380 | Character controller does not tunnel at gameplay speeds. |
| **E7** Ground normal reporting via `computedCollision(i).normal1` | `{x:0, y:1, z:0}` → 0.0° | Per-collision normals give slope angle and surface type without extra raycasts. |
| **E8** `world.castRay` / `castRayAndGetNormal` | `toi = 2.000` for a ray from y=2 to the ground | Raycasts are exact; the GDD's 5-ray ground probe is straightforward. |
| **E9** Push a 50 kg dynamic box with `setApplyImpulsesToDynamicBodies(true)` | Box moved 3.0 → **6.90**; pair advanced at **~1.2 m/s**, well below the 2 m/s walk speed and visibly non-linear | **Design-changing.** Impulse-based block pushing is slow and non-deterministic. A puzzle block that must land in a 1 m³ hole cannot be at the mercy of friction. → GDD mandates a **kinematic "grip" mode** for puzzle blocks. |
| **E10** Physics + query throughput: 160 static colliders, 40 dynamic bodies, 6 character controllers, 42 raycasts/frame, 600 frames | **1.573 ms/frame** → **10.6× headroom** against a 16.6 ms budget | Physics is ~9% of frame budget at 10× the realistic enemy/prop load. The 60 FPS target is *not* physics-bound. |
| **E11** `three/webgpu` import | Exports a real `WebGPURenderer` function in r186 | WebGPU is a genuine migration path, not marketing. |

| **E12** Runtime-spawned second character, spawned directly above the first | Settled at y = 2.8901 — **standing on the first character's head** (expected 2.87 + 0.02 offset). Perfectly stable. | A new controller created **after** the world has stepped is safe. But capsule-on-capsule standing is real, in **both** directions: Milestone 1.2 edge case #10 ("player lands on enemy → bounce off") must also handle *enemy lands on player*; this is a deliberate design decision, not an engine bug. |

**E1 (and its bisected root cause) and E9 are the two findings that changed the plan.** Both were found by *doubting the happy path* before writing game code, which is precisely what Phase 0 exists to do.

**Corrective note on intellectual honesty.** The first version of this document attributed E1 to snap-to-ground, because that was the parameter that differed between the failing and passing scripts I had written. That attribution was **wrong**, and the error was caught only when I converted the experiment into a permanent regression test and the test failed. Bisection (E1b) then showed the true cause. The lesson is recorded deliberately: *a correlation observed across two hand-written scripts is not a root cause*, and the act of turning an experiment into a test is what exposed the difference. This is exactly why Rule #4 requires tests for every milestone rather than trusting the reasoning that produced the code.

---

## 5. Self-Criticism: Five Weaknesses of My Own Choice

A stack choice without a self-audit is a liability. Here are five real weaknesses and the concrete mitigation for each.

### W1 — "Three.js is a renderer, not an engine." I must build the game loop, resource lifecycle, object pooling, collision-layer management, and scene streaming myself.

**Impact:** This is the largest hidden schedule cost of the decision. Frameworks like Babylon give these away; I will write them, and my versions will initially be worse.
**Mitigation:** Keep the substrate *deliberately small and boring*. One fixed-timestep loop; one explicit `SystemRegistry` (ordered `update(dt)` calls, no reflection); one `Pool` class (~80 lines) reused by bullets, particles, and ragdolls; one `Layers` constant module instead of ad-hoc group masks. Every one of these is small enough to unit-test completely. I explicitly reject building a generic ECS — a bespoke registry for ~40 entity types is faster to write, faster to run, and far easier to debug.

### W2 — Rapier's character controller is a behavioural black box with genuinely surprising edge cases (see E1: it is **permanently** corrupted by a first call made before the world has ever stepped, and reports `grounded = true` while free-falling).

**Impact:** Game feel is not a documented property of the library; it emerges from `maxSlopeClimbAngle` × `snapToGround` × `autostep` × character mass × the collider offset, and these interact non-obviously. Without characterisation, I would be tuning blind. E1 is the proof: it took a bisection over five variables to establish that none of them was the cause, and that the real trigger was an *ordering* property of the initialisation sequence.**
**Mitigation:** Convert every experiment E1–E12 into a **permanent regression test** in `test/characterisation/` and `test/integration/`. Any engine upgrade that changes slope-climbing, autostep height, ground-snap behaviour or initialisation ordering will fail CI loudly rather than silently degrading game feel three milestones later. I also maintain an explicit, cumulative **"Known Engine Quirks"** list in `DEV_LOG.md`, and every wrapper in `physics/` carries a comment citing the experiment that justifies its guard clause.

### W3 — Affine texture mapping means abandoning Three.js' lighting and PBR material pipeline entirely.

**Impact:** No `MeshStandardMaterial`, no shadow maps without custom work, no image-based lighting. I must hand-write one unified PS1 vertex/fragment shader pair and a matching lighting model. Anything the shader does not implement, the game does not have.
**Mitigation:** Embrace it — this is the art direction, and the PS1 era had no PBR. Use a flat, bright **Lambert + ambient + rim** model with a hard-clamped terminator (period-authentic), and bake detail into vertex colours and low-poly geometry rather than lighting. Keeps the shader small (better for mobile GPUs) and the look deliberately stylised. Design consequence: *level lighting must be authored as geometry + vertex colour*, so the level builder must support per-vertex tinting from the start.

### W4 — Rendering regressions are invisible to headless CI. Vitest cannot compile GLSL.

**Impact:** A broken shader or a mis-scaled render target fails only in a human's browser. This is a genuine hole in Rule #4 ("test everything") and I should not pretend otherwise.
**Mitigation:** Three-layer defence. **(a)** Extract all shader *math* (clip-space snapping, affine UV solve, aspect-fit letterboxing, the warp-intensity blend) into pure TypeScript functions in `src/core/math/`, unit-tested exhaustively; the GLSL is then a thin transliteration of tested logic. **(b)** Add a `ShaderSource` lint test asserting every uniform declared in JS exists in the GLSL and vice-versa — the single most common silent shader failure. **(c)** Maintain an explicit *manual* visual checklist in each DEV_LOG milestone entry, per Rule #4's "manual test checklists for game feel". Documented honest gaps beat undetected ones.

### W5 — Cold start: Three.js + ~1.4 MB of WASM before the first frame.

**Impact:** Directly threatens the "players quit at the loading screen" risk (R13). A 2 MB+ synchronous download on a mid-range connection is several seconds of a black rectangle.
**Mitigation:** **Split the boot sequence in two.** Phase A renders an *interactive* title screen using zero physics and a procedural skybox (Three.js only, ~700 KB). Phase B dynamically `import()`s Rapier while the player is still reading the title, then unlocks "Start". This converts a blocking wait into a hidden one. Additionally: all textures are procedurally generated at runtime as `DataTexture` from a seeded PRNG — **the game ships no image assets at all**, which eliminates the entire asset-loading risk class and keeps the repo lean.

---

## 6. System Architecture

### 6.1 Layering (strictly one-directional; no upward imports ever)

```
┌──────────────────────────────────────────────────────────────┐
│ app/            Boot, title screen, loading, main loop        │
├──────────────────────────────────────────────────────────────┤
│ game/           Zones, objectives, save, progression, story   │
├──────────────────────────────────────────────────────────────┤
│ gameplay/       Character, camera, combat, AI, puzzles,       │
│                 climbing, inventory, skills, pickups          │
├──────────────────────────────────────────────────────────────┤
│ world/          Level builder, geometry, materials, props,    │
│                 collision registry, lighting, culling         │
├──────────────────────────────────────────────────────────────┤
│ render/         PS1 pipeline: low-res RT, snap/affine shader, │
│                 post blit, palette, debug overlays            │
├──────────────────────────────────────────────────────────────┤
│ physics/        Rapier adapter: world, layers, raycasts,      │
│                 shape casts, kinematic bridges, queries       │
├──────────────────────────────────────────────────────────────┤
│ core/           Math, timing, PRNG, pooling, events, input,   │
│                 assets, constants, assertions, test harness   │
└──────────────────────────────────────────────────────────────┘
```

`core/` must not import `three` except in `core/geometry/` (deliberately isolated so the pure-math majority stays testable in bare Node). `physics/` is the **only** module permitted to touch the Rapier global namespace; everything above it uses our own typed facade (`PhysicsWorld`, `RaycastQuery`, `ColliderHandle`). This is what makes W2's mitigation possible: one seam to characterise.

### 6.2 Frame Loop (deterministic, fixed-timestep physics)

Variable-`dt` physics is the classic cause of "sometimes I fall through the floor" and of jump heights varying with framerate. The loop therefore decouples simulation from presentation:

```
// ---- WORLD INITIALISATION (mandatory, see E1) ----
// Rapier's KinematicCharacterController is permanently corrupted if its first
// computeColliderMovement() happens before the world's broadphase has ever been
// populated. The corruption is silent: computedGrounded() still returns values,
// but geometry collision is ignored for the rest of the session (E1d: y=-28.52
// after 300 otherwise-correct ticks). One prime step makes the controller immune
// even to a pathological 2.0 m first frame (E1f).
physics.step()                     // ← PRIME STEP. Non-negotiable.
assert(groundProbeHits(), 'physics world primed incorrectly');   // fail loudly at boot

accumulator += min(frameDelta, MAX_FRAME_DELTA)   // clamp spiral-of-death
while (accumulator >= FIXED_DT) {                 // FIXED_DT = 1/60 s
    input.beginTick()                             // latch edge-triggered intents
    character.update(FIXED_DT)                    // intent → velocity → move → collisions
    ai.update(FIXED_DT); puzzles.update(FIXED_DT)
    physics.step()                                // always exactly one Rapier step
    camera.update(FIXED_DT)                       // camera in sim space = no jitter
    accumulator -= FIXED_DT
    tick++
}
alpha = accumulator / FIXED_DT
render(alpha)                                     // visual-only interpolation
```

Four decisions inside this loop deserve justification:

- **The prime step, and a boot assertion for it.** Because E1d proved the failure is permanent and E1c proved it is *latent* (a normal boot happens to work), an unprimed world could ship and pass casual testing, then break for a player whose first frame was slow. The assertion converts a silent, permanent, unrecoverable corruption into an immediate, loud, at-boot failure.
- **`MAX_FRAME_DELTA` clamp (0.25 s).** After an alt-tab or a GC hitch, an unclamped accumulator queues hundreds of ticks and the game "fast-forwards" — the player clips through walls at 40× speed. Clamping trades a lost half-second of simulation for a guaranteed-correct one. E1e confirms that large single-tick movements are safe *once primed*, so the clamp is a gameplay-correctness measure rather than a physics-stability one.
- **Camera updated *inside* the fixed tick.** Tempting to smooth it on render delta, but then the camera samples a stale player transform and the whole image shimmers during strafing. Sim-space camera + render-space interpolation keeps motion coherent.
- **Input edges latched per tick.** A jump pressed and released between two ticks must never be dropped. `InputState` latches `pressedThisTick` flags and clears them at tick end, feeding the jump buffer (Rule: 150 ms).

### 6.3 Fixed Timestep & Interpolation Rationale

Simulation at 60 Hz with a 60 Hz display yields `alpha ≈ 0`, so interpolation is effectively a pass-through; on a 144 Hz display it smoothly interpolates. Critically, **physics behaviour is bit-identical across all three of 30/60/144 Hz**, which is what makes the E2–E9 evidence above valid for the shipped game and not just for the test harness.

### 6.4 Collision Layer Model

16 Rapier groups, two 16-bit masks, allocation centralised in `physics/Layers.ts` so a layer can never be silently mis-targeted:

| Layer | Members | Collides with |
|---|---|---|
| `STATIC_WORLD` | ground, walls, ruins, terrain | all dynamic characters + props |
| `PLAYER` | player capsule | static, enemies, props, triggers, puzzle volumes |
| `ENEMY` | wolves, jaguars, cultists, boss | static, player, props, other enemies |
| `PROP_DYNAMIC` | debris, ragdolls, dropped items | static, characters |
| `PUZZLE_BLOCK` | pushable blocks, platforms | static, player, enemies, plates |
| `TRIGGER` | volumes, checkpoints, objectives | player, enemies (sensor only, no forces) |
| `WATER_VOLUME` | buoyancy regions | player, props (sensor; forces applied by our code) |
| `PROJECTILE_PROXY` | grenade bodies only | static, characters, props |
| `CLIMB_SURFACE` | climbable geometry | player (sensor) |
| `HITBOX` | damageable volumes | raycasts only, never resolves forces |

**Bullets are not physics bodies.** They are raycasts plus a pooled tracer sprite. A 40 m/s projectile spanning 0.67 m per tick against a 0.1 m-thick pillar is a textbook tunnelling case (E6 only proved *character* speeds are safe). Raycasting removes the class of bug entirely and is cheaper. Grenades, which must bounce and arc, *are* real bodies — with CCD enabled, which they can afford because there are at most a handful alive.

### 6.5 Rendering Pipeline (PS1 emulation)

```
world-space verts
  → MVP → clip space
  → vertex snap: floor(clip.xy / clip.w * GRID + 0.5) / GRID * clip.w
  → pass affine pair: vUvW = uv * w ;  vW = w
  → rasterise (low-res render target, 480×270)
  → fragment: uv = mix(uvPerspectiveCorrect, vUvW / vW, warpAmount)
  → flat vertex lighting (Lambert + ambient + rim), hard terminator
  → colour quantisation to a limited palette
  → nearest-neighbour blit to canvas, aspect-fit letterboxed
```

Two subtleties that must be implemented carefully:

- **Grid snapping must be aspect-aware and depth-safe.** The grid is expressed in *virtual pixels* (`vec2(GRID_W, GRID_H * FIXED_ASPECT)`), not square world units, otherwise the wobble is anisotropic. XY is snapped while Z is left exact; coplanar z-fighting is then handled with polygon offset rather than by snapping Z, which would corrupt depth ordering.
- **Affine warping is a blendable parameter, not a binary.** The correct affine UV is `vUvW / vW` (the divide by `w` in the vertex shader cancels the hardware's perspective correction — see `docs/GAME_DESIGN_DOC.md` §9.2 for the derivation). Because unrestricted affine mapping makes large surfaces look *broken* rather than *retro*, a `warpAmount` uniform lerps between true affine and perspective-correct. This is the "limit warp amount" requirement turned into a single, tunable, unit-testable scalar.

### 6.6 Object Pooling & Culling

- **Pooling** for tracers, muzzle flashes, impact sparks, dust puffs, blood/leaf bursts, ragdolls, floating damage numbers, and audio voices. Pools are **fixed-capacity with steal-oldest eviction** — never growing. An ever-growing pool is a disguised memory leak (risk R9), so capacity is a hard constant and overflow is counted, not allocated.
- **Spatial partitioning** via a uniform grid over the level AABB, rebuilt only when static geometry changes. Frustum culling per grid cell for static meshes, then per-object.
- **Occlusion** is authored, not computed: zone portals + hand-placed occluder volumes. Real-time occlusion culling is not worth its cost at this level's scale, and hand-authoring gives predictable performance — which is what a 60 FPS target actually needs.

---

## 7. Testing Strategy

| Tier | Scope | Tool | Example |
|---|---|---|---|
| Unit | Pure math/logic | Vitest (Node) | clip-space snap, affine UV solve, slope bands, coyote time, jump buffer, puzzle state machines, save serialisation |
| Integration | System pairs, **real Rapier** | Vitest (Node + WASM) | character + physics, camera + collision, combat + damage, puzzle + block physics |
| Characterisation | Engine behaviour pinned | Vitest (Node + WASM) | E1–E9 as permanent regression tests |
| Static | Shader/uniform consistency | Vitest, source analysis | every GLSL uniform ↔ every JS uniform |
| Manual | *Feel* | Checklist per milestone | jump distances vs GDD, camera smoothness, climb responsiveness |

**Honest limitation:** "does it feel good" is not automatable, and I will not claim it is. Automated tests enforce the *numerical envelope* (a running jump travels 6.0 m ± 0.3 m; coyote time is 120 ms ± 1 tick); the checklists verify the *perceptual* result. When the two disagree, the numbers are a starting point and the human verdict wins — documented in `DEV_LOG.md` under Doubts.

---

## 8. Build, Bundle & Deployment

- **Vite 8** dev server (`0.0.0.0`, permissive `allowedHosts`) for the in-browser live preview; `vite build` for production.
- **Manual chunking:** `three` in one vendor chunk, Rapier in a *lazy* chunk loaded post-title-screen (mitigation W5). This is the single highest-leverage performance decision in the build config.
- **Code-splitting by zone:** zones 3–5 geometry data is loaded on demand; zone 1 must be interactive as fast as possible.
- **No binary art assets.** Every texture is a procedural `DataTexture` from a seeded PRNG, and every mesh is built from primitives, so the build output is code only. Deterministic seeds mean "random" rocks and foliage vary but are *reproducible* across reloads — essential for testing.
- Target: **initial interactive paint < 2 s on a mid-range laptop over a warm connection**, measured and recorded in `DEV_LOG.md`.

---

## 9. Summary of Architectural Commitments

1. TypeScript + Three.js r186 + Rapier3D 0.21 + Vite 8 + Vitest 5, versions pinned, all **empirically verified working together in CI on 2026-10-07**.
2. Fixed 60 Hz deterministic simulation with clamped accumulator and render-only interpolation.
3. `physics/` is the sole Rapier seam; all engine quirks are characterised by permanent regression tests.
4. Kinematic character controller with a **mandatory prime step at world init** (E1 — a silent, permanent corruption otherwise), plus ground snapping justified on feel grounds (E2c), plus a boot assertion so an unprimed world fails loudly rather than silently.
5. Puzzle blocks use kinematic grip-mode movement, not impulse shoving (E9).
6. Bullets are raycasts; grenades are CCD rigidbodies.
7. One unified PS1 shader, hand-written, with shader math extracted to unit-tested TypeScript.
8. Boot split into a no-physics title screen and a lazily-loaded physics phase.
9. Authored occlusion and a uniform-grid broadphase; no real-time occlusion culling.
10. Every system has ≥5 documented edge cases and an automated test envelope before its milestone closes.
