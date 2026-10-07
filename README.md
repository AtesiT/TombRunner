# Jungle Relic

A bright, PS1-styled 3D action-adventure that runs in the browser. You are an expedition
archaeologist racing a cult to a jungle relic — through a lush canopy, warm stone temples
and lantern-lit caverns.

> **Status: Milestone 1.1 complete.** The rendering pipeline and the Zone 1 environment are
> playable to look at. The character controller (1.2), camera (1.3) and input (1.4) are next.
> See `docs/DEV_LOG.md` for a full, honest account of what exists and what does not.

---

## Running it

**Requirements:** Node 20+ (developed on Node 22) and a browser with **WebGL 2**.

```bash
npm install     # install dependencies
npm run dev     # start the dev server, then open http://localhost:5173
```

The dev server binds to `0.0.0.0` and accepts any host, so it also works behind a proxy
or in a container.

### All commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with hot module replacement |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the full test suite (Vitest) |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`) |

### Controls

| Input | Action |
|---|---|
| **Click the canvas** | Capture the mouse. Camera look is ignored until you do. |
| Mouse | Look. Left/right orbits, up/down pitches within −60°…+45° |
| **Right mouse** | Aim — narrows the FOV from 60° to 45° and centres the shoulder offset |
| `Esc` | Release the mouse |
| `W` `A` `S` `D` | Move, **relative to the camera** — W walks away from the camera, not north |
| `Shift` | Run (6 m/s) instead of walk (2 m/s) |
| `Space` | Jump — tap for a low hop, hold for the full height |
| `Ctrl` / `C` | Crouch. **Crouch beats jump**: pressing both on a ledge edge will not launch you |
| `E` | Interact |
| `F` | Attack *(buffered; nothing consumes it until combat lands)* |
| `Tab` | Inventory *(bound; no screen yet)* |
| `F1` | Toggle the developer overlay |
| `F3` | **Rebind Jump** — press `F3`, then any key. Saved to `localStorage`; reload to confirm |
| `[` `]` | Tune affine texture warping, live |
| `-` `=` | Tune the vertex snap grid, live |

A **gamepad** works alongside the keyboard, on `standard`-mapping devices only. Left stick moves,
right stick looks, A jumps, B crouches, X interacts, RT/RB attack, LT aims, Back opens the
inventory. There is deliberately **no run button**: a stick's deflection *is* its speed, so pushing
it halfway walks and pushing it fully runs. A non-standard pad is ignored rather than guessed at, and
unplugging one mid-run falls back to the keyboard without your having to press anything.

The character is a procedural rig built entirely in code — no model file, no skeleton, no
animation clips. The gait actually advances by **distance travelled** rather than by time, which
is what stops the feet skating, and the slope lean is driven by the ground normal, so the
character leans correctly into a 17° ramp no one authored a clip for.

The camera is a full over-the-shoulder **spring-arm rig**. A 0.25 m sphere is swept from a
chest-height pivot outward every tick, so the boom shortens against walls faster than it
lengthens back (0.35 vs 0.08 per frame) — pulling in is a correctness problem, pushing out is
only a feel problem, and conflating the two forces a choice between visible clipping and a
nauseating whip. The camera re-solves its boom against rising ground rather than lifting
vertically, which keeps it on the arm and stops the framing shifting sideways as you walk
downhill. If it is ever pinned or inside geometry for long enough it enters an **escape**: the
boom is allowed below its normal 1.5 m minimum and the pivot is raised 0.6 m, which converges on
a close downward view, because the one place guaranteed to be free of geometry is where the
character is standing.

Two of the camera's design decisions are worth knowing while playing:

* **Auto-rotation waits 0.5 s of no camera input** before easing the yaw back behind you. This is
  the single most-complained-about third-person camera behaviour there is — the camera rotating
  while you hold forward, so your path curves and you cannot tell why — and the only thing that
  reliably distinguishes "idle" from "being steered" is a duration.
* **Aiming narrows the FOV from 60° to 45° over about 0.18 s** and centres the shoulder offset.
  The transition is damped, never cut, so the horizon never jumps.

Input is sampled **once per fixed tick**, never inside an event handler. Every handler does one of
two things — sets a flag, or adds to a number — and all interpretation happens at tick start. That is
what makes a 30 ms tap that begins and ends *between* two ticks survive to become a jump, which
sounds like a detail and is in fact the difference between a platformer that feels broken
intermittently and one that does not.

The forgiveness windows the GDD asks for are counted in ticks, not milliseconds, so they cannot drift
against simulated time: **150 ms for jump, 200 ms for interact, 100 ms for attack**. They deliberately
do *not* stack with the character controller's own jump buffer — the input latch is consumed the
moment it is delivered, so the two mechanisms compose as `max()` rather than adding up into a
quarter-second of phantom jumps.

The overlay reports the input device, whether the mouse is captured, how the bindings were loaded, and
the measured event-to-tick latency, because those are the four things that make input look broken
while being entirely correct.

The overlay exists because appearance cannot be judged from a test suite. It reports frame time
mean and p95, draw calls, triangle count, the full controller state, and live shader tunables —
and it costs nothing when hidden.

---

## What is actually here

### The look

Every PS1 artefact is real, not a post-processing filter:

- **480×270 internal render target**, upscaled with nearest-neighbour sampling at an
  **integer** scale and letterboxed, so pixels stay crisp and uniform.
- **Vertex snapping** in clip space to a virtual pixel grid, which produces the
  characteristic wobble as the camera moves.
- **Affine texture mapping** via the two-varying shader trick, with a `warpAmount` control
  (default 0.65) because unrestricted affine warping makes large surfaces look broken
  rather than retro.
- **Palette quantisation with 4×4 ordered dithering** in a dedicated post pass.
- **Flat vertex lighting** — direction sun + ambient + rim with a hard terminator. No PBR,
  no shadows, no bloom, no SSAO, no motion blur, no depth of field, no chromatic
  aberration. Those are excluded by design, not by omission.

It is deliberately **bright**: saturated greens, warm ochre stone, a blue sky with clouds.
This is an adventure, not a horror game.

### The engineering

- **No binary art assets.** Every texture is generated procedurally at start-up as a
  `DataTexture` from a seeded PRNG. There is nothing to download, decode or 404, and the
  world is byte-identical on every reload.
- **Deterministic 60 Hz fixed-timestep simulation** with a clamped accumulator, so physics
  behaves identically at 30, 60 and 144 Hz.
- **Two-phase boot:** an animated loading screen with no dependencies, then Three.js and
  Rapier (a ~1.7 MB gzipped WASM chunk) loaded lazily behind it.
- **Per-cell instanced batching**, so frustum culling actually rejects geometry instead of
  drawing every tree in the level the moment one is visible.

---

## Tests

```bash
npm test
```

Fifteen suites, 440 tests, all running headlessly in Node:

| Suite | Covers | Count |
|---|---|---:|
| `test/characterisation/` | Pins the observed behaviour of Rapier's character controller, including a permanent-corruption bug discovered in Phase 0 | 20 |
| `test/unit/ps1-math.test.ts` | Vertex snapping, the affine-UV derivation, letterboxing, terminator clamping, palette quantisation | 38 |
| `test/unit/locomotion.test.ts` | The jump-arc solver, the derived GDD jump constants, slope bands, coyote/buffer windows, turning | 52 |
| `test/unit/locomotion-states.test.ts` | The discarding state machine: transition priority, jump rules per state, illegal combinations | 33 |
| `test/unit/shader-uniforms.test.ts` | Shader/JS uniform agreement, GLSL ES 1.00 compatibility lint, FOV conversion | 17 |
| `test/integration/character-controller.test.ts` | Real Rapier: the **ten mandatory edge cases**, moving-platform carry, safety nets, determinism | 25 |
| `test/integration/level-build.test.ts` | Builds the real level and lands a real character on the generated terrain | 5 |
| `test/characterisation/shape-cast-semantics.test.ts` | Pins Rapier's swept-sphere semantics: radius honoured, direction normalised, `filterGroups` is the **9th** argument | 8 |
| `test/unit/camera.test.ts` | Camera maths: frame-rate independence, the asymmetric spring arm, mode priority, the deadzone's continuity at its threshold | 83 |
| `test/integration/camera-rig.test.ts` | Real Rapier: the **eight mandatory camera edge cases**, plus 30 Hz landing where 60 Hz lands | 24 |
| `test/unit/analog.test.ts` | Deadzone continuity, radial symmetry, trigger rest offsets, the camera-relative transform | 29 |
| `test/unit/bindings.test.ts` | Conflict refusal, unbind rules, serialisation, and **twelve hostile stored payloads** | 39 |
| `test/unit/input-system.test.ts` | The **five mandatory input edge cases**, the buffer design, remapping, device fallback | 58 |
| `test/integration/input-latency.test.ts` | R6's budget: a press moves the character on the **same tick**, end to end through real Rapier | 6 |
| `test/integration/input-camera-loop.test.ts` | The camera↔movement feedback loop converges instead of circling | 3 |
| **Total** | | **440** |

The jump distances the level design is authored against are asserted numerically: a standing
jump clears **2.997 m** at a **2.000 m** peak, and a full-speed running jump clears **6.109 m**
at a **2.498 m** peak (the extra 0.109 m is one tick of post-landing running).

See `src/gameplay/README.md` for what the controller tests verify and — just as importantly —
what they cannot.

**Honest gap:** Vitest cannot compile GLSL or run WebGL, so "does it look right" is not
covered by CI. The mitigation is that all shader *mathematics* lives in unit-tested
TypeScript (`src/core/math/ps1.ts`), that every uniform is checked to exist in both
languages, and that GLSL ES 1.00 compatibility is linted. Compilation and appearance are
covered by manual checklists recorded in `docs/DEV_LOG.md`.

---

## Project layout

```
src/
  app/        Boot sequence, frame loop, DOM wiring
  core/       Constants, PS1 shader mathematics, seeded PRNG   <- no Three.js dependency
  physics/    The only module that touches Rapier
  render/     PS1 pipeline, material factory, GLSL sources
  world/      Procedural textures, low-poly geometry, level builder
test/
  characterisation/   Engine behaviour pinned as regression tests
  unit/               Pure logic
  integration/        Systems together, with real physics
docs/         Architecture, risk register, game design document, dev log
```

The dependency direction is one-way (`app → world → render → physics → core`) and is
enforced by convention and review; `core/math/` imports nothing but itself, which is what
lets the shader maths run in bare Node.

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Engine selection with 5 candidates scored, self-criticism of the choice, and 12 empirical experiments run against the real libraries |
| [`docs/RISK_ANALYSIS.md`](docs/RISK_ANALYSIS.md) | 15 risks, scored and with a chosen mitigation each |
| [`docs/GAME_DESIGN_DOC.md`](docs/GAME_DESIGN_DOC.md) | Full design: movement, camera, combat, puzzles, climbing, zones, visual style |
| [`docs/DEV_LOG.md`](docs/DEV_LOG.md) | Build log, including a deep-debug session on a physics bug and a documented wrong turn |

## Licence

Not yet specified.
