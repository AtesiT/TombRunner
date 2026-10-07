# Jungle Relic — Game Design Document

**Document owner:** Principal Gameplay Engineer / Technical Director / Game Designer
**Status:** Approved — Phase 0 gate
**Last updated:** 2026-10-07
**Target:** 45–60 minute authored single-player campaign, 5 zones, browser (keyboard+mouse primary, gamepad secondary)

---

## 1. High Concept

**Jungle Relic** is a bright, vibrant, low-poly action-adventure in the spirit of a 1998 PS1 tomb-raiding classic, rendered with authentic period artefacts (vertex wobble, affine texture warping, 480×270 internal resolution) but *modern* game feel (2013-era AAA character control, coyote time, jump buffering, spring-arm camera).

**The one-line pitch:** *You are an expedition archaeologist racing a cult to a jungle relic. The temple is bright, the jungle is lush, and the jumps are precise.*

**Tone directive (load-bearing, not flavour text):** This is an **adventure**, not a horror game. Strong sun, saturated greens, warm stone, blue sky, warm lantern light in caves. No fog-as-dread, no desaturated palette, no jump-scares. Every art and lighting decision is subject to this constraint. Dark content is *forbidden*, not merely discouraged, because the chosen rendering style is maximally unforgiving in bright scenes and the usual "moody darkness" crutch is unavailable — see `RISK_ANALYSIS.md` R5.

---

## 2. Design Pillars

1. **Feel first.** A player describes this game with the word "smooth" or not at all. Locomotion and camera outrank content volume and outrank visual fidelity.
2. **Never stuck.** Every puzzle is resettable, every fall is survivable, every state is recoverable. A softlock is the single worst outcome the game can produce.
3. **Bright is a feature.** The whole market renders dark brown; we render vivid green and warm ochre and trust the player to enjoy it.
4. **Authored, not generated.** One dense hand-crafted level beats ten procedural ones. Every jump distance is authored against measured capability.
5. **Teach by level, not by text.** Movement is taught by terrain that safely requires it; puzzles are taught by safe demonstrations of their mechanic before they gate progress.

---

## 3. Core Loop

```
        ┌───────────────────────────────────────────────┐
        │                                               │
        ▼                                               │
   EXPLORE ──► SOLVE PUZZLE ──► FIGHT ──► PROGRESS ─────┘
   (traverse,   (physics,        (fauna or   (new zone,
    read,        light, water,    cultists,   item, relic,
    discover)    weight, combi,   boss)       skill,
                 timing)                      objective)
```

Each of the five zones delivers exactly one of each of: **a major puzzle, a combat encounter, a platforming challenge, and a secret area.** This is a hard content contract, checked as an authoring checklist per zone, so no zone can ship as filler.

---

## 4. Movement & Locomotion System (CRITICAL PATH)

This is the heart of the game. Every number below is a *tunable constant* living in `src/core/constants.ts`, and every one has a corresponding automated test in the numerical-envelope tier (`ARCHITECTURE.md` §7).

### 4.1 Speed and Acceleration

| Property | Target | Notes |
|---|---|---|
| Walk speed | 2.0 m/s | Exploration / delicate platforming |
| Run speed | 6.0 m/s | Default traversal |
| Sprint | *none* | Run **is** the top speed; no stamina, no sprint modifier |
| Acceleration time (0 → run) | 0.30 s | ≈ 20 m/s² |
| Deceleration time (run → 0) | 0.40 s | ≈ 15 m/s²; slightly stronger than accel so stopping feels deliberate |
| Air control | 0.55 × ground accel | Enough to adjust a jump, not enough to redirect one |
| Turn rate (grounded) | 540 °/s | Fast but not instant; retains momentum weight |
| Turn rate (airborne) | 220 °/s | Airborne turning costs commitment |
| Turn rate (movement while aiming) | 300 °/s | Deliberately restricted — aiming is a commitment |

**No stamina system.** Per the brief and by design: stamina systems make the player *afraid* of exploring, which is the opposite of a bright adventure game. The constraint on verticality comes from level design (climb surfaces are marked and finite), not from a resource bar.

### 4.2 Jumping

| Property | Standing | Running |
|---|---|---|
| Horizontal distance | 3.0 m | 6.0 m |
| Peak height | 2.0 m | 2.5 m |
| Jump cooldown | 0.20 s | 0.20 s |
| Gravity while ascending | 26 m/s² | Held-jump multiplier 0.75 (floatier rise) |
| Gravity while descending | 42 m/s² | Deliberately much heavier — "snappy" feel comes from fast falls |
| Terminal velocity | 45 m/s | Prevents tunnelling and unrecoverable falls |
| Variable jump height | 2.5 m held → 1.4 m tapped | Releasing jump cuts upward velocity by 45% |

Momentum-based by construction: the jump adds a *fixed impulse* to the existing horizontal velocity rather than setting a velocity, so a running jump naturally travels ~2× a standing one, and jumping off a moving platform inherits the platform's velocity (`MovementEdgeCases.PLATFORM_INHERIT`).

The asymmetric gravity (26 up / 42 down) is the single most important trick for a satisfying platformer and is justified in §4.7.

### 4.3 Input Assistance (the "forgiveness layer")

These exist because humans are not frame-accurate and because a missed input reads as **broken**, not as **difficult**:

- **Coyote time — 120 ms (≈7 ticks).** Jump remains legal after leaving a ledge. Expressed in ticks (`COYOTE_TICKS = 8`) so it is framerate-independent. Any input in that window produces a full-strength jump, not a weakened one.
- **Jump buffering — 150 ms (≈9 ticks).** A jump pressed before landing fires on the first grounded tick. Buffered jumps fire at full strength.
- **Corner-correction / edge nudge:** when the rising capsule's top edge would clip a ledge lip within 0.25 m, the character is nudged horizontally to clear it rather than killed. This alone removes most "I definitely made that jump" failures.
- **Ledge-assist grab:** if a jump falls short by ≤0.3 m at a ledge, snap to the ledge-hang instead of falling. Converts a frustrating failure into a reward.

**Explicitly rejected:** auto-jump-on-hold (a held button must not produce a second jump — `InputEdgeCases.HOLD_JUMP`), input prediction/rollback (no netcode, pure complexity), and "forgiving" jumps that violate the authored distance envelope (they would invalidate level design).

### 4.4 Ground Detection — 5-Ray Cone

Not collision events (`computedGrounded()` is necessary but *not sufficient*: it cannot tell me slope angle, surface type, or edge proximity). Every tick:

- **Ray 0 (centre)**, origin `pos + (0, 0.1, 0)`, direction `-up`, length `capsuleHalfHeight + 0.45`.
- **Rays 1–4** at `±0.30 m` forward/back and `±0.30 m` left/right from the centre origin, same direction, slightly shorter length (avoids snagging on distant geometry).
- Derived values:
  - `grounded` = majority of rays hit within snap distance.
  - `groundNormal` = average of hit normals (E7 confirms Rapier reports accurate per-collision normals).
  - `slopeAngle` = `acos(clamp(normal.y, 0, 1))`.
  - `edgeProximity` = `0` (all 4 outer rays hit) … `1` (none hit) — drives ledge-grab and animation.
  - `surfaceType` = looked up from the hit collider's user data (`grass`, `stone`, `wood`, `sand`, `water-shallow`) — feeds footstep audio, dust colour, and slide behaviour.

Rays read the `STATIC_WORLD` and `PROP_DYNAMIC` layers only; `TRIGGER` and `WATER_VOLUME` are excluded from *ground* queries (they are sensor geometry and would otherwise report phantom floors) — a real bug that would otherwise manifest as the player "standing on water".

### 4.5 Slope Handling

| Angle | Behaviour | Rationale |
|---|---|---|
| 0–30° | Walk normally | Full speed, full jump |
| 30–45° | Walk at 0.6× speed; **cannot jump** | Reads as "scrambling up"; jumping off a slope would be physically incoherent |
| 45–60° | Slide down at 4 m/s; no jump; slide is steerable | Punishes overreach without being lethal |
| 60°+ | Not traversable on foot; climbable only if authored as a climb surface | Verticality is gated by authored content |

Implemented with `setMaxSlopeClimbAngle(50°)` and `setMinSlopeSlideAngle(38°)` (E4 proves the block is enforced by the engine at 55°), with our own slope reading used for *presentation* and for the jump-eligibility rule. The engine handles collision; we handle feel.

### 4.6 Mantle, Ledge Hang & Vault

| Mechanic | Trigger | Behaviour |
|---|---|---|
| **Autostep** | Obstacle ≤0.40 m while moving | Handled natively by `enableAutostep(0.4, 0.25, true)` (E5: verified stepping 0.3 m stairs cleanly) |
| **Mantle (low)** | 0.40–0.80 m ledge, jumping or running into it | 0.35 s committed climb-up; input can cancel; no hang state |
| **Mantle (high)** | 0.80–1.20 m ledge | 0.30 s hang → player chooses pull-up (hold forward) or drop (back) — *never* automatic |
| **Ledge hang** | Airborne, falling (vy < 1.0), ledge within 0.55 m | Snap to solved hang anchor; stable, reproducible position |
| **Ledge shimmy** | While hanging, lateral input | 1.0 m/s lateral movement along the ledge; stops at ends/corners |
| **Ledge jump** | Jump while hanging | Jump **away from the wall** (never into it) with 4.5 m arc, +0.8 m rise |
| **Vault** | ≤0.6 m obstacle while running fast (>4 m/s) | Fast 0.25 s traversal, preserves momentum — the "parkour" flourish |

**Design rule:** a high mantle *always* offers a hang first. Automatic pull-up would take the decision away from the player at exactly the moment they want to look around, and would make the ledge the first thing they can't control.

**Fail-hard rule:** climbing and hanging are *surfaces-driven*. `CLIMB_SURFACE` colliders tagged in the level builder; everything else refuses — with an explicit, readable rejection (a small "no grip" dust puff + audio cue), never silence. `MovementEdgeCases.CLIMB_NON_CLIMBABLE` requires the feedback be *visible*, because unexplained non-response reads as a bug.

**Characters are not standable surfaces (both directions).** Experiment E12 (`ARCHITECTURE.md` §4.2) proved that Rapier will happily rest a kinematic capsule on top of another kinematic capsule, indefinitely and stably. So the Milestone 1.2 edge case "player lands on enemy → bounce off" is only half the problem: **an enemy can also come to rest on the player's head**, producing a stable, permanent, and very confusing position. The controller therefore applies an explicit rule in both directions: any character-to-character contact in which one capsule's contact normal points upward from the other's head (or vice versa) resolves as a lateral deflection plus a small bounce, never as a resting contact. Because Q3 in the DEV_LOG's Known Engine Quirks register says the engine permits it, this must be enforced by our code rather than assumed away — and it is covered by both a characterisation test and a Milestone 1.2 integration test.

### 4.7 Justification of the Feel Parameters

The single most common amateur mistake is symmetric gravity with a high jump. It produces a floaty "moon jump" and destroys precision, because the player's brain cannot predict the arc's *timing*. Asymmetric gravity — a slow, controllable rise and a heavy, decisive fall — gives the player two different mental models for the same jump (a deliberate ascent and an immediate commitment to landing), and it compresses the total airtime so the player spends more time *in control on the ground*, which is where platforming decisions are actually made.

Likewise, the 0.30 s acceleration is fast enough to feel responsive but slow enough to be felt: instant acceleration removes all sense of mass, and mass is what makes a 6 m running jump feel *earned* rather than *assisted*.

---

## 5. Camera System

### 5.1 Configuration

| Property | Value |
|---|---|
| Mode | Third-person, over-the-shoulder, **right** offset |
| Shoulder offset | +0.50 m right |
| Distance | 4.0 m (default) |
| Height | +1.45 m above player origin (head-ish) |
| Pitch range | −60° … +45° (asymmetric: more down-look than up-look, as the game is about looking *down* at footing) |
| FOV | 60° (default) → 45° (aim) |
| Follow damping | `lerp 0.10` positional, `0.15` rotational |
| Auto-rotate | After **0.5 s** of no camera input, the camera aligns behind the player's facing at 1.2 rad/s |
| Mouse sensitivity | Radians per pixel, raw, unaccelerated, direction-agnostic |

### 5.2 Spring Arm with Collision

Sphere-cast (radius 0.25) from the player's head pivot to the desired camera position against `STATIC_WORLD` only (foliage and triggers never move the camera — `RISK_ANALYSIS.md` R3):

- On hit: place the camera at `hit.distance - skin(0.15)`, clamped to a **1.5 m minimum**.
- **Asymmetric smoothing**: pull-in at lerp 0.35 (fast, correctness-driven), push-out at lerp 0.08 (slow, feel-driven). Snapping inward prevents wall penetration; easing outward prevents disorienting whip-out.
- **Ground clamp:** camera `y ≥ groundY + 0.5`.
- **Stuck detector:** if the arm sits at minimum distance for >2.0 s, or the camera is inside geometry for >0.5 s, smoothly interpolate to the authored fallback position over 0.4 s. This is the *guarantee* of escape.

### 5.3 Contextual Modes (all transitions lerped, never cut)

| Mode | Trigger | Change |
|---|---|---|
| Default | — | Distance 4.0 m, FOV 60° |
| **Aim** | Aim held | Camera centres behind the weapon (shoulder offset → 0.15 m), distance 3.0 m, FOV 45°, sensitivity × 0.65. Transition 0.18 s. |
| **Climb / Hang** | Climbing or hanging | Distance 5.0 m, pitch biased +10° (look up the wall), shoulder offset → 0 — you need to see *where you are going* |
| **Mantle** | Mantle playing | Pull back +0.8 m and raise +0.3 m to keep the full body in frame |
| **Water** | Submerged | Add a 0.6 Hz, 0.05 rad positional wobble plus a subtle FOV breath; reduces readability *very* slightly to signal being submerged |
| **Tunnel / Narrow** | Inside an authored corridor volume | Reduce FOV to 52°, distance to 2.4 m — authored framing instead of an emergent mess |
| **Cinematic** | Story beats | Scripted spline interpolation to an authored transform, input-camera disabled, 0.6 s ease-in |
| **Zip line** | Riding | Distance 5.5 m, pitch −8° (look ahead and down at the destination) |

Transition priority order (highest wins, so the system is deterministic): Cinematic > Zip line > Water > Mantle > Climb/Hang > Aim > Tunnel > Default. Ties are impossible by construction.

### 5.4 Edge Cases

1. Corner wedge → forced reset after 2.0 s (see above).
2. Below ground → clamp to `groundY + 0.5`, then re-solve.
3. Player teleports/respawns → camera *snaps* (does not lerp across the level) and resets its damping history; a lerp across 60 m of level is nauseating.
4. Cutscene → spline interpolation with input suppressed.
5. Mantle → dedicated framing (table above).
6. Ledge hang → 5.0 m + upward pitch so the drop below is visible.
7. Narrow corridor → authored volume lowers FOV.
8. Water → wobble, plus a snorkel-style near-plane tint at depth.
9. **New:** player dies → slow orbit around the death point for 1.2 s before the respawn fade (reads as intentional).
10. **New:** gamepad right-stick deadzone applied *before* integration, so a drifting stick cannot slowly rotate the camera (a genuinely common reported bug in shipped games).

---

## 6. Combat System

### 6.1 Player Weapons

| Weapon | Mag | Fire mode | Rate | Damage | Reload | Spread | Acquired |
|---|---|---|---|---|---|---|---|
| **Pistol** | 12 | Semi-auto | 0.30 s | 20 | 1.50 s | 95% accuracy (≤2° cone) | Zone 1 (start) |
| **Shotgun** | 6 | Pump-action | 1.00 s | 80 total (8 × 10 pellets) | 2.50 s (shell-by-shell, cancellable) | 70% (12° cone) | Zone 3 |
| **Melee** | — | — | 0.60 s | 10 | — | 60% (1.5 m reach) | Always (fallback when out of ammo) |

- **Max carry:** 60 pistol rounds, 30 shotgun shells. Scavenging is deliberate, never punishing; combat arenas always contain ≥1 ammo spawn.
- **Reload is cancellable** by firing, aiming, or swapping — but a cancelled reload keeps no partial progress on the shotgun (shell-by-shell reload *does* retain loaded shells, which rewards tactical timing).
- **Melee fallback** is mandatory (`CombatEdgeCases.NO_AMMO`) so that being out of ammo is a difficulty spike, never a dead end.
- **Bullets are raycasts with pooled tracers**, never physics bodies (`ARCHITECTURE.md` §6.4). Hitscan with a visible tracer; the tracer is a cosmetic quad that never affects hit registration.
- **Hit resolution:** single ray to the crosshair with a cone-sampled offset derived from spread; on hit, apply damage scaled by the hit region (head 2.0×, torso 1.0×, limbs 0.7×) via dedicated `HITBOX` colliders that never resolve forces.
- **Cover does not grant crosshair lock** (`CombatEdgeCases.COVER_LOCK`) — if the ray is blocked, the crosshair grays out and the shot is *not* fired into the wall uselessly; instead the muzzle is raised slightly (weapon-up) so the player gets honest feedback.
- **Ray penetration:** one thin surface (≤0.3 m) may be penetrated at 10% damage, resolved by continuing the ray from the exit point. Deeper geometry absorbs the shot entirely.

### 6.2 Player Health

- 100 HP. Medkit restores **+50 HP**, takes 1.2 s, and is **interruptible** by damage (the item is not consumed if interrupted — the player is never punished twice).
- Regen: **none.** Regenerating health would erase the tension that makes exploration meaningful and would let the player brute-force combat encounters.
- Max medkits 3 (5 with the skill). Death → respawn at the last checkpoint with full health, retaining inventory; enemies in the failed encounter reset to their spawn state.

### 6.3 Enemies

| Enemy | HP | Detection | Attack | Damage | Behaviour |
|---|---|---|---|---|---|
| **Wolf** | 30 | Sight 120°/15 m; sound 25 m | Pounce (1.2 s telegraph) | 15 | Pack of 3–5; 2 flank on arcs while others bracket and distract |
| **Jaguar** | 50 | Sight 90°/20 m; sound 30 m | Leap from above (0.7 s telegraph) | 30 | Solo ambusher; holds high ground, strikes on crossing, retreats on damage |
| **Cultist** | 40 | Sight 120°/25 m; sound 40 m | Pistol 15 / grenade 40 (3 m radius) | varies | Cover-seeking, suppressive fire, flanks in pairs, grenade every 6 s |
| **Cultist Leader** | 200 | Always aware | All weapons + grenades | varies | Three-phase boss, see §6.5 |

**Telegraphs are mandatory.** Every enemy attack has a readable, audio-supported wind-up of ≥0.5 s (wolf 1.2 s, jaguar 0.7 s, cultist 0.5 s). Damage without a telegraph is unfair; this is a feel requirement, not a nicety. The wind-up is *also* the player's window to interrupt, dodge, or reposition — and interrupting a pounce (with a shot) staggers the attacker, rewarding precision.

**Grenades in water do not explode** (`CombatEdgeCases.GRENADE_WATER`) — they splash, audibly fizzle, and sink. This is both a hard-coded rule and a readable player tactic: lure enemies to the water's edge.

### 6.4 Enemy AI — Layered State Machine

**Layer 1 — Awareness** (per-enemy, drives the state below):

```
IDLE ──alert(sight|sound)──► ALERT ──confirmed──► COMBAT ──hp<25%──► FLEE
  ▲                             │                    │                │
  └──────── timeout ────────────┘◄── lost contact ───┘◄── rallied ────┘
```

- `IDLE`: patrols authored waypoints, scans; periodic "look around" at waypoints (not a robotic ping-pong).
- `ALERT`: investigates the *sound's estimated position* (not the sound's source object), sweeping a widening arc; gives up after 8 s. This is what makes silenced approaches possible.
- `COMBAT`: full tactical layer (§6.5).
- `FLEE`: retreats to cover, calls for help (alerting allies within 25 m — *tactical depth*: a wounded enemy left alive is a liability), and rallies if it reaches an ally with >50% HP.

**Detection model:**
- **Sight** = cone test (angle + range) **then** a raycast against `STATIC_WORLD` for occlusion, plus a visibility scalar from distance, target crouch state, and target motion. Crouching and standing still reduce effective range substantially (the "Quieter Step" skill multiplies the effective detection *time*, not the range — see §10).
- **Sound** = event-driven, not polled. Gunshots, footsteps (running 20 m, walking 10 m, crouching 4 m), impacts, explosions, and player voice all emit `NoiseEvent{position, radius, intensity}` into a spatial bucket. Enemies subscribe to buckets, not to a global bus, so cost stays proportional to local activity.

**Layer 2 — Group tactics** (4s decision cadence, changes are rate-limited so behaviour cannot oscillate):
- `SUPPRESS` — one enemy keeps firing while others move (fire rate ×1.2, deliberately inaccurate, so suppression is *threatening* but not lethal).
- `FLANK` — 2 agents path via the authored nav graph around the player's flanks; requires a reachable path on the correct side and is abandoned if the path breaks.
- `REGROUP` — when reduced to one survivor, retreat toward allies or an authored "safe" waypoint.
- **Role assignment is exclusive:** each agent holds exactly one role per decision window, so two agents cannot both "suppress" the same arc and stand in each other's line of fire.

**Anti-stuck:** the progress watchdog + local recovery ladder + authored nav graph from `RISK_ANALYSIS.md` R6. Every agent's stuck-events are counted and exposed in the debug overlay.

### 6.5 Boss — Cultist Leader (Zone 4)

Arena with pillars at three heights, a water channel, and destructible cover. Phases are *health-gated* with an enforced 1.5 s transition (a readable stagger, an audible roar, an arena-wide re-light) so the phase change is an event, not a silent stat swap.

| Phase | HP | Behaviour |
|---|---|---|
| **I — Measured** | 200–100 | Pistol, 2-round bursts from cover; repositions between bursts; teaches the player the arena |
| **II — Aggressive** | 100–50 | Shotgun; advances between cover, denies the water channel, breaks destructible cover |
| **III — Desperate** | 50–0 | Grenades every 5 s + rapid pistol; flushes the player out of cover; arena starts visibly collapsing (debris, dust) |

**Death is a scripted cutscene**, not a ragdoll: he staggers to the altar, the artifact is revealed, and the temple's collapse sequence is *caused* by the fight (cause and effect, not coincidence).

**Boss edge cases:** cannot be damaged during transitions (prevents skipping a phase); grenades cannot spawn inside geometry (validated spawn points); the arena has no permanent-cover position that trivialises the fight (verified by a level-build check that every cover point is flankable from at least one other cover point).

---

## 7. Climbing & Parkour

**Non-negotiable architectural constraint (from `RISK_ANALYSIS.md` R4): all climb transitions are resolved by logic on the input tick. Animations are cosmetic and may be cancelled, blended, or time-scaled. No player action is ever gated behind an animation completing.**

### 7.1 Climbable Surfaces

Climbable geometry is **authored and marked**, never emergent:
- Visual language: **bright orange-tinted stone edges**, a subtle emissive rim, and vines rendered at edges. Unambiguous at a glance, and *bright* (consistent with §1's tone directive).
- A 0.35 m proximity pulse + faint audio hum when the player is within grab range of a legal surface.
- Non-climbable surfaces give explicit rejection feedback (dust puff + dull thud) and never silently swallow input.

### 7.2 Climb Mechanics

| Action | Behaviour |
|---|---|
| Climb | 1.0 m/s vertical, 1.2 m/s lateral (`Faster Climb` skill: ×1.2) |
| Grab | ≤2 ticks from input to state change |
| Jump between holds | 200 ms window; 5.5 m arc between anchors with a visible arc preview from the second frame |
| Pull up | Auto at top ledge, 0.35 s, cancellable |
| Drop | Instant; drop is *always* available, with no "are you sure" friction |
| Exhaustion | **None.** The player can climb indefinitely (no stamina, per §4.1) |

### 7.3 Traversal Set

- **Ropes:** hold jump to grip; movement input swings with pendulum physics; release carries momentum (a released swing is *not* damped — this is the reward for good timing). Release direction is the swing direction, not the input direction, or the momentum logic would be defeated.
- **Beams:** 0.25 m wide balance beams; walk speed only; running on a beam causes a stumble (0.4 s, recoverable) rather than a fall, since a fall is a much worse punishment than a stumble for the same mistake. Lateral wind and enemy hits knock the player off.
- **Zip lines:** press interact; auto-travel at 12 m/s with easing at both ends; the player is invulnerable **and cannot shoot** while riding (`ClimbEdgeCases.ZIPLINE_SAFETY`), which keeps it a traversal tool rather than a combat escape tool — otherwise players would kite enemies endlessly.
- **Water:** swim at 2.5 m/s; buoyancy applied as a spring toward neutral depth with heavy damping (E9's lesson: direct force application oscillates); an air meter of **25 s** with a 5 s warning, and drowning respawns the player at the nearest safe ledge rather than killing them.
- **Moving platforms:** velocity inheritance on jump-off (`MovementEdgeCases.PLATFORM_INHERIT`); a `PLAYER_ON_PLATFORM` parent link so the player is carried without jitter.

### 7.4 Climbing Edge Cases (all 10 from the brief, resolved)

Non-climbable feedback · let-go-mid-climb falls with an animation · 200 ms cross-jump window · climbing moving surfaces moves the player with the surface · **cannot fight while climbing** (input is redirected, not dropped, so releasing one hand is a deliberate action) · running out of climb surface ends in a fall, never a lock · rope release preserves momentum · beam hit → fall · zip line invulnerable but disarmed · **upside-down climbing impossible by construction** (climb state requires the surface normal to be within 30° of horizontal).

---

## 8. Puzzle Systems

Six puzzle families, all built on one shared, serialisable, resettable `Puzzle` contract:

```ts
interface Puzzle {
  readonly id: PuzzleId;
  readonly solved: boolean;
  update(dt: number): void;      // pure state evaluation
  isSolved(): boolean;
  reset(): void;                 // restores authored start state — NEVER partial
  serialize(): PuzzleSaveData;   // explicit facts, never inferred from the world
  deserialize(data: PuzzleSaveData): void;
}
```

Sharing this contract is what makes the universal reset (R7) and fact-based saving (R8) possible for *every* puzzle without per-puzzle special-casing.

| Family | Mechanic | Zone | Failure mode defended against |
|---|---|---|---|
| **Physics blocks** | Push 1 m³ blocks into floor sockets to open doors. Uses **kinematic grip mode**: on interact, the block becomes kinematic and moves at a fixed 0.8 m/s on the player's facing axis, with an overlap check before each step. | 1 | E9 proved impulse pushing is non-deterministic (block slid 3.9 m unpredictably). Grip mode makes the *solution* deterministic and the *feel* weighty. |
| **Light** | Rotate mirrors to route a sunbeam onto a sensor. The beam is a multi-bounce raycast (≤8 bounces). **The beam passes through the player** (a character is not a mirror) and through enemies. | 3 | Player standing in the beam must not block a puzzle. |
| **Water** | Valve raises/lowers the level in discrete 0.5 m steps; buoyancy carries the player and floats puzzle blocks. | 3 | Rising water traps the player → air meter + the water can always be lowered. |
| **Weight** | Pressure plate holds a gate open while loaded. **Enemy corpses count** (and visibly slump onto the plate), and blocks can substitute for the player. | 2 | Corpse-counting is a deliberate anti-frustration choice: the player who killed an enemy *before* discovering the plate must not be stuck. |
| **Combination** | Find 3 sigils in the environment; enter them on a door mechanism in the correct order. Murals hint the order. Wrong input resets after 3 attempts with a clear "reset" flourish. | 2 | Partial progress is saved explicitly, and the hint mural is *always* re-readable, so the puzzle cannot become unsolvable-by-forgetting. |
| **Timing** | 3 staggered moving platforms; 2 ceiling blades on opposed phase. | 5 | Platform glow indicates the safe window; falling respawns at the last checkpoint (never death). |

**Every puzzle additionally ships with:**
1. A **Reset affordance** (hold R) restoring authored start transforms and derived state — the hard guarantee against softlock.
2. **Build-time validation:** blocks must be able to reach their sockets; sockets must not be against a corner without a pull direction; no puzzle may be gated on a consumable; the cross-puzzle dependency graph must be acyclic.
3. **A teaching instantiation:** every mechanic appears once in a zero-risk context (a plate that opens a shortcut, a mirror that lights a decorative alcove) *before* it gates progress. Teaching by level, never by a text popup.
4. **An out-of-order tolerance:** solving puzzles in unexpected order is allowed and tracked for achievements; nothing assumes a linear solve order.

---

## 9. Visual Style — Bright PS1 Retro

### 9.1 The Rendering Recipe

```
3D world → [vertex snap] → [affine UV] → [flat vertex lighting]
         → 480×270 render target → [palette quantise] → nearest-neighbour upscale → canvas
```

| Effect | Implementation | Tuned default |
|---|---|---|
| **Vertex snapping** | Clip-space XY quantise to a virtual pixel grid, aspect-aware; Z untouched | Grid = half the vertical target resolution (240 virtual pixels tall) |
| **Affine texture mapping** | `vUvW = uv * w; vW = w;` then `uv = mix(uvPersp, vUvW / vW, warpAmount)` | `warpAmount = 0.65` |
| **Low-res target** | `WebGLRenderTarget(480, 270)` with `NearestFilter`, aspect-fit letterboxed on resize | 480×270 (320×240 selectable in options) |
| **Flat lighting** | Directional sun + ambient + rim, hard-clamped terminator, vertex-coloured | Sun 1.0 warm-white; ambient 0.35 sky-tinted; rim 0.25 |
| **Palette** | Post-pass quantisation to a limited palette, with dithering | 32 levels/channel, ordered 4×4 dither |

### 9.2 Deriving Correct Affine Mapping (why the divide-by-`w` trick works)

The GPU interpolates a varying `V` perspective-correctly as
`V_pc = (Σ λᵢ Vᵢ / wᵢ) / (Σ λᵢ / wᵢ)`, where `λᵢ` are screen-space barycentric weights.

If the vertex shader emits `A = V·w` and `Wᵥ = w`, then:
- `A` interpolates to `(Σ λᵢ Vᵢ wᵢ / wᵢ) / (Σ λᵢ / wᵢ) = (Σ λᵢ Vᵢ) / (Σ λᵢ / wᵢ)`
- `Wᵥ` interpolates to `(Σ λᵢ wᵢ / wᵢ) / (Σ λᵢ / wᵢ) = 1 / (Σ λᵢ / wᵢ)`
- Therefore `A / Wᵥ = Σ λᵢ Vᵢ` — **exactly screen-space-linear (affine) interpolation.**

This is why the implementation is a two-line shader trick and not an expensive per-triangle software rasteriser. The `warpAmount` blend between true affine and perspective-correct is then a single `mix()`; the *math* is unit-tested in TypeScript (`src/core/math/ps1.ts`) so the GLSL is a thin, verified transliteration (`RISK_ANALYSIS.md` W4).

### 9.3 Composition & Palette Directives

- **Jungle:** saturated greens (3–4 distinct hues, not one green), warm ochre earth, bright cyan sky, high-key lighting. Silhouettes read as *shapes*, not as textures.
- **Temple:** warm sandstone/terracotta, jade accents, deep blue shadow gaps — contrast comes from *hue*, since shadow contrast is unavailable in high-key lighting (R5).
- **Caves:** warm lantern pools with actual magenta/amber light spilling onto walls; visible airy entrances; **no dark corridor = dread**. Caves are *mysterious and inviting*.
- **Forbidden:** bloom, SSAO, motion blur, DoF, chromatic aberration, film grain, vignettes, colour grading toward desaturated/teal-orange, **any fog used to hide draw distance**. Draw distance is hidden by authored occluders and terrain, never by fog.

---

## 10. Inventory & Progression

### 10.1 Inventory (Tab — pauses the game)

- **Weapon slot** (pistol | shotgun) — two weapons, instant swap with a 0.35 s animation *during which the player is not frozen*.
- **Medkit slot** (3, or 5 with the skill) — consumed with a 1.2 s interruptible animation.
- **Key items** (artifact, sigils, valve handle, rope) — non-consumable, auto-used contextually.
- **Journals** (5) — readable, re-readable, stored with an unread indicator. Reading is *never* required and never gates progress.
- **Pickup feedback:** an icon card slides in, the world pauses for 120 ms only for *relics* (a deliberate punctuation beat), plus a distinct audio sting per item class. No pause for ammo.

### 10.2 Skill Tree — 4 Skills from 3 Relics

| Skill | Effect | Relic cost | Why it exists |
|---|---|---|---|
| **Faster Climb** | +20 % climb speed | 1 | Rewards vertical exploration directly |
| **Quieter Step** | Enemies take 50 % longer to detect you (applied to detection *time*, not range — range reduction is invisible to the player and feels like a bug) | 1 | Enables stealth-adjacent play without a stealth system |
| **Extra Medkit Slot** | 3 → 5 | 1 | A safety valve for struggling players, chosen freely |
| **Faster Reload** | −30 % reload time | Beat the game | Retroactive mastery reward / NG+ hook |

Relics are placed in the **secret area** of Zones 2, 3 and 4, so the skill system is a direct incentive to hunt secrets. The 4th skill unlocking after completion is an explicit New-Game-Plus hook and a reward for finishing, not a tax on finishing.

### 10.3 HUD (minimal, diegetic where possible)

- Health bar (bottom-left), ammo (bottom-right) — both fade to 35 % opacity after 4 s of no change.
- Interaction prompt (centre, contextual verb: "Press E to push", "Hold R to reset puzzle").
- **Compass** (top-centre) showing the objective marker with a distance readout; never a full minimap, so exploration stays the player's job.
- Objective text appears for 4 s on change, then fades to the compass line.
- **Additions:** air meter (only while submerged), damage direction arcs (brief, 1 s, 4 quadrants), boss health bar (only in Phase 4 arena), and pooled floating damage numbers (off by default in options; on in dev).

### 10.4 Save System

- **3 slots** + an autosave slot. Manual save at authored save points (carved stone markers, clearly lit); autosave at every zone entry and every puzzle completion.
- **Saves:** player transform (anchored to the last *validated* checkpoint transform), health, inventory, skills, all puzzle facts, objective state, discovered journals, relics, playtime, and a `schemaVersion`.
- **Robustness (R8):** atomic double-buffered write with read-back verification and checksum; migration chain plus full validation on load; quarantine-and-fallback on failure; honest UI messaging; graceful degradation to session-only mode if storage is unavailable.
- **Edge cases:** corrupted save → fall back to the other slot; quit during write → the other slot is intact; load mid-puzzle → puzzle facts restore exactly, including a partially-entered combination; death → respawn at the last checkpoint with inventory intact; version mismatch → migrate or, failing that, refuse honestly with an explanation rather than crashing.

---

## 11. Level Structure

One dense, hand-crafted level, 5 zones, ~45–60 minutes. Level data is authored as a **declarative TypeScript level DSL** (not a binary format, not a scene file) so it is diffable, reviewable, type-checked, and validated at build time.

| Zone | Time | Content contract ✓ Puzzle / Combat / Platforming / Secret | Beats |
|---|---|---|---|
| **1. Jungle Entrance** | 5 min | Block-push puzzle (sockets into a gate) / none (safe learning space) / fallen-log traversal and a 3 m gap / a vine alcove behind the waterfall with ammo | Movement teaching by terrain: walk → run → jump → crouch. First medkit. Journal 1. First climbable edge, taught on a 1.2 m ledge over *safe* ground. |
| **2. Temple Ruins** | 10 min | Combination lock (3 sigils, 2 found in the zone and 1 visible from a ledge you must climb to) / **2 wolves** (the pack is introduced as *two*, so the player learns the telegraph before meeting four) / ledge-hang shimmy across a broken wall, then a vault chain / a collapsed stairwell with a **Relic** and Journal 2 | Climbing tutorial escalates: mantle → hang → shimmy → jump-between-holds. Pistol ammo. The weight plate is taught on a shortcut before it gates anything. |
| **3. Underground Caverns** | 15 min | **Water** (raise the level to reach a high ledge, then lower it to open a valve route) **and Light** (route the sunbeam through 3 mirrors) — two puzzles whose *interaction* is the real puzzle / **3 cultists** in a dry gallery with cover, a water channel, and destructible crates / moving platforms over a water pit, plus rope swings / an air pocket behind a submerged passage with a **Relic**, shotgun, and Journal 3 | The zone escalates from "one mechanic" to "mechanics composing". The shotgun's shell-by-shell reload is taught by an ambush where retreating while reloading is the correct play. |
| **4. Inner Sanctum** | 10 min | Weight plate + timed door (holds a gate open for 6 s) / **Boss: Cultist Leader** (3 phases) / the altar climb — a vertical ascent under falling debris / a cracked wall behind the altar with a **Relic** and Journal 4 | Artifact pickup → **temple begins collapsing** (dust, progressive geometry swaps, a rising rumble, lighting shifts warmer/redder). The player's own action causes the climax. |
| **5. Escape** | 5 min | Timing puzzle (3 staggered platforms + 2 blades, under a collapsing ceiling) / fleeing cultists (non-blocking, purely atmospheric) / the full traversal kit back-to-back: sprint → slide → vault → swing → zip line / a hidden side passage with **Journal 5** | Timed sequence starts on artifact grab. Reach the **helicopter** extraction pad. Final cutscene: the temple collapses behind, the player boards, the helicopter lifts, credits. |

**Pacing rules:** a combat encounter is never adjacent to a puzzle (the player needs a breath between cognitive loads); every 90 s of tension has a 20 s decompression (a vista, a journal, a waterfall); and the player always has a *visible* goal within 30 s of entering a zone.

---

## 12. Narrative

**Premise.** Archaeologist **Maya Okonkwo** is airlifted into an undocumented jungle valley to reach the **Sun Relic** of a vanished civilization before the **Ash Cult** — who believe it will let them command the storms. The temple was built *by* that civilization to *guard* the relic, and its traps are not defenses against intruders but a test of intent: the murals show that the relic answers only to those who understand why it was sealed.

**Narrative delivery — 3 channels, none mandatory:**
1. **5 journals** (optional, re-readable): 1. the mission begins · 2. the temple was built to guard it · 3. the cultists seek it for power · 4. it must not fall into their hands · 5. secured, time to go. Each is ≤120 words, first-person, and each ends on an image rather than a plot beat.
2. **Environmental storytelling:** broken guardian statues with their heads deliberately removed (someone was here before), murals whose panels *depict the puzzles you are solving* (the puzzle solution is also the lore), cultist camps with crates and lamps (their presence is felt before they are seen), and a progressive collapse that narrates urgency without dialogue.
3. **Final cutscene (~25 s):** the temple folds inward behind a running Maya, the rotor wash kicks dust into the air, she boards, the helicopter lifts as the valley floor sinks — then a beat: she opens her hand and the relic glows once, warm. Cut to black. Credits.

**No cutscene interrupts gameplay.** Only the intro card, the post-boss moment, and the ending are non-interactive; everything else is delivered in-world while the player retains control. The player's attention is a resource and stolen attention is expensive.

---

## 13. Audio Design (stretch, but planned into the architecture)

- **Ambient:** layered jungle (birds, insects, canopy wind, distant water) with per-zone mixes; cross-faded on zone transition with no hard cut.
- **Dynamic music:** calm exploration pad → tension layer on `ALERT` → percussion layer on `COMBAT` → a triumphant variant on `PuzzleSolved` → stripped-down percussion for the escape. Layers are stem-synchronised to a shared tempo so transitions never sound like a stutter.
- **Footsteps:** per `surfaceType` from the ground probe (§4.4), with per-surface volume *and* pitch variation and a per-surface concurrency cap of 2.
- **Enemy audio is gameplay information:** detection growls, attack telegraphs, and death sounds carry *directionality* (stereo panning by relative angle) because audio is a core combat-fairness channel.
- All audio is procedurally synthesised into `AudioBuffer`s at boot, consistent with the zero-binary-asset policy (R13), and scheduled on the audio clock (R11).

---

## 14. Accessibility & Options

- **Remappable controls** with localStorage persistence, applied live, including gamepad rebinding.
- **Colourblind modes** (protanopia/deuteranopia/tritanopia) that re-tune the *hue* separation of gameplay-critical signals (climb surfaces are already distinguishable by brightness, not hue alone — so the marking survives every colourblind mode by construction).
- **Shader intensity sliders:** vertex snap, affine warp, palette quantisation — a player who finds the artefacts unpleasant can dial them back without leaving the game.
- **Subtitles/captions** for all audio cues, with direction indicators.
- **Camera shake toggle**, **sensitivity curves**, **FOV slider**, **invert-Y**, and **difficulty modifiers** (enemy damage taken ×0.6 / ×1.0 / ×1.4 — a single honest multiplier rather than a maze of separate toggles).

---

## 15. Scope Discipline — What This Game Deliberately Is Not

Stating exclusions is how a 45-minute game actually ships:

- **Not open-world.** One authored level, five zones.
- **No crafting** (beyond the stretch "herbs → medkit"), **no RPG dialogue**, **no side quests**, **no procedural generation**, **no multiplayer**, **no netcode**.
- **No mobile launch target** (scoped, `RISK_ANALYSIS.md` R12).
- **No more than 4 enemy archetypes**, each with genuinely distinct AI rather than five reskins of one behaviour.
- **No new puzzle families beyond the six defined in §8.** Depth comes from composition and authoring, not from adding a seventh mechanic.

---

## 16. Definition of Done (per the mission's final checklist)

A milestone is complete only when: all its documented edge cases are handled; its automated tests pass; its numerical envelope matches this GDD; its manual feel checklist is signed off in `DEV_LOG.md`; the code has passed the review protocol (no magic numbers, no stray `console.log`, no function >50 lines, JSDoc on all public functions); and `DEV_LOG.md` records the reasoning, the doubts, and any workarounds with severity ratings.
