# `src/physics` — the Rapier seam

## What this system does

Wraps Rapier3D so that no other module in the codebase ever touches a Rapier type.
Everything above this layer speaks in terms of `KinematicCharacter`, `RaycastHit` and
`CollisionLayer`.

That narrowness is not tidiness for its own sake. It is what makes the character controller
testable in CI, and it is what let the Phase 0 engine bug be characterised and permanently
guarded rather than rediscovered every few weeks.

## ⚠️ The prime step — read before changing anything here

A Rapier `KinematicCharacterController` is **permanently and silently corrupted** if its
first `computeColliderMovement()` call happens before the world has been stepped at least
once. After that single bad call:

- geometry collision is ignored for the lifetime of the controller,
- `computedGrounded()` keeps returning plausible-looking values,
- the character settles ~0.18 m *sunk into* the floor, or falls entirely out of the world
  (observed: `y = −28.52`),
- and **nothing recovers it** — 300 subsequent correct ticks change nothing.

It is also *latent*: it needs a first movement above ~0.04 m, and gravity's first tick at
60 Hz is 0.0027 m, so a normal boot works **by accident**. A player whose first frame is
slow is the one who finds the bug.

`PhysicsWorld.primeAndVerify()` performs the prime step and then asserts that a ground probe
ray actually hits something, converting a silent permanent failure into a loud immediate one.
`createCharacter()` is safe only for worlds that have been primed through that path.

Full analysis: `docs/DEV_LOG.md` → *Deep Debug Session*, and `docs/ARCHITECTURE.md` §4.2 (E1–E1f).
Regression tests: `test/characterisation/character-controller-grounding.test.ts`.

## Collision layers

Ten layers are declared in `Layers.ts` and every collider is created through
`collisionGroupsFor` or `queryGroupsFor`. No other module may construct a group integer.

### Colliders and queries need *different* encodings

Rapier accepts an interaction only if **both** halves of this test pass:

```
(query.membership & collider.filter) !== 0
(collider.membership & query.filter) !== 0
```

A collider's filter lists the layers it collides with — which for the static world notably
does **not** include `StaticWorld` itself. So using `collisionGroupsFor` for a raycast aimed
at the static world produces `{StaticWorld} & {Player, Enemy, …}` = 0 and the ray hits
nothing, with no error and no warning.

This was found the hard way: the boot-time ground assertion failed against a level whose
ground collider demonstrably existed. Queries therefore use `queryGroupsFor`, which claims
membership in every layer and expresses intent through the filter mask alone.

## API notes

| Method | Note |
|---|---|
| `primeAndVerify(from)` | Mandatory after building the level, before any character query. Throws if no ground is found. |
| `castRay(...)` | Rapier's result field is `timeOfImpact`, **not** `toi`. Direction is normalised internally. |
| `sphereOverlaps(...)` | For validating respawn points. `filterGroups` is the **fifth** argument of `intersectionWithShape`, not the seventh — putting it later silently places it in the `filterExcludeRigidBody` slot. |
| `removeCollider(handle)` | Removes the owning rigid body, because removing only the collider leaves an orphaned body holding WASM memory that no JS profiler can see. |
| `dispose()` | WASM allocations are not garbage collected. Dropping the reference leaks the entire simulation. |

## Testing

- `test/characterisation/character-controller-grounding.test.ts` — 20 tests pinning the
  engine's real behaviour (E1, E1b–E1f, E2, E2b, E2c, E12/Q2/Q3).
- `test/integration/level-build.test.ts` — lands a real character on the real generated level.
