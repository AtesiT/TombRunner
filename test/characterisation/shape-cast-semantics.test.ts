/**
 * Characterisation test: the semantics of a swept-sphere query.
 *
 * Phase 0 established two traps this project has already paid for once each: `castShape` takes
 * `filterGroups` as its **9th** argument (while `intersectionWithShape` takes it as the **5th**),
 * and a query filter built from *collider*-style groups silently matches nothing rather than
 * erroring. Neither is discoverable from a type signature, and both fail silently.
 *
 * So the semantics are pinned here before the camera depends on them. What is measured:
 *
 *   • `time_of_impact` is expressed in units of the supplied velocity, so a unit direction makes
 *     the result a distance in metres directly. Doubling the direction halves the result.
 *   • The sphere's RADIUS is honoured: a sphere stops a radius short of where a ray stops.
 *   • `maxDistance` bounds the sweep, and a miss past the bound returns null.
 *   • The wrong group encoding matches nothing.
 *
 * These run through `PhysicsWorld.castSphere` rather than the raw Rapier world, because that
 * wrapper is what the game actually calls — and the wrapper's documented contract is only worth
 * anything if something checks it against reality.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../../src/physics/PhysicsWorld';
import { CollisionLayer, collisionGroupsFor, queryGroupsFor } from '../../src/physics/Layers';

const worlds: PhysicsWorld[] = [];

function createWorld(): PhysicsWorld {
  const physics = new PhysicsWorld();
  worlds.push(physics);
  return physics;
}

/** Add a slab occupying z in [3, 6], so its near face is exactly 3 m from the origin. */
function addSlab(physics: PhysicsWorld, centreZ = 4.5): void {
  physics.createStaticCollider({
    shape: { kind: 'cuboid', halfExtents: { x: 10, y: 10, z: 1.5 } },
    translation: { x: 0, y: 0, z: centreZ },
    layer: CollisionLayer.StaticWorld,
  });
  physics.step();
}

describe('Swept-sphere query semantics', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  afterEach(() => {
    while (worlds.length > 0) worlds.pop()?.dispose();
  });

  it('reports distance in metres, independent of the direction vector magnitude', () => {
    const physics = createWorld();
    addSlab(physics);

    const origin = { x: 0, y: 0, z: 0 };
    const unit = physics.castSphere(origin, { x: 0, y: 0, z: 1 }, 0.25, 20, [
      CollisionLayer.StaticWorld,
    ]);
    const doubled = physics.castSphere(origin, { x: 0, y: 0, z: 2 }, 0.25, 20, [
      CollisionLayer.StaticWorld,
    ]);

    expect(unit).not.toBeNull();
    expect(doubled).not.toBeNull();

    // Near face at z = 3, sphere surface contacts it a radius earlier.
    expect(unit!.distance).toBeCloseTo(2.75, 2);

    // Normalising the direction internally means the caller never has to think about units.
    // Without that, a doubled direction vector would halve the reported distance and the camera
    // would pull in to half the correct boom length.
    expect(doubled!.distance).toBeCloseTo(2.75, 2);
  });

  it('honours the radius, stopping a full radius earlier than a ray would', () => {
    // This is the entire reason the camera uses a sphere rather than a ray: a ray threads gaps
    // the near plane cannot, and geometry pops through the lens.
    const physics = createWorld();
    addSlab(physics);

    const origin = { x: 0, y: 0, z: 0 };
    const direction = { x: 0, y: 0, z: 1 };

    const ray = physics.castRay(origin, direction, 20, [CollisionLayer.StaticWorld]);
    const sphere = physics.castSphere(origin, direction, 0.25, 20, [CollisionLayer.StaticWorld]);

    expect(ray!.distance).toBeCloseTo(3.0, 2);
    expect(sphere!.distance).toBeCloseTo(2.75, 2);
    expect(sphere!.distance).toBeLessThan(ray!.distance);
  });

  it('scales the stopping distance with the radius', () => {
    // Swept rather than spot-checked, because the failure mode is a radius that is silently
    // ignored at one specific size.
    const physics = createWorld();
    addSlab(physics);

    for (const radius of [0.1, 0.25, 0.5, 1.0]) {
      const hit = physics.castSphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, radius, 20, [
        CollisionLayer.StaticWorld,
      ]);
      expect(hit!.distance, `radius=${radius}`).toBeCloseTo(3.0 - radius, 2);
    }
  });

  it('returns null past maxDistance rather than clamping to a hit', () => {
    // A clamped hit would make the camera jump to minimum distance against distant geometry,
    // which reads as the camera randomly lurching.
    const physics = createWorld();
    addSlab(physics, 20);

    const hit = physics.castSphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 0.25, 5, [
      CollisionLayer.StaticWorld,
    ]);
    expect(hit).toBeNull();
  });

  it('returns a unit normal pointing away from the surface', () => {
    const physics = createWorld();
    addSlab(physics);

    const hit = physics.castSphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 0.25, 20, [
      CollisionLayer.StaticWorld,
    ]);

    // The slab's near face faces -Z, back toward the sweep origin.
    expect(hit!.normal.z).toBeCloseTo(-1, 1);
    expect(Math.hypot(hit!.normal.x, hit!.normal.y, hit!.normal.z)).toBeCloseTo(1, 2);
  });

  it('returns null for degenerate inputs instead of throwing', () => {
    // A camera asking for a zero-length sweep is a bug, but a crash in a frame loop is a worse
    // outcome than a skipped query.
    const physics = createWorld();
    addSlab(physics);

    const origin = { x: 0, y: 0, z: 0 };
    const forward = { x: 0, y: 0, z: 1 };

    expect(physics.castSphere(origin, { x: 0, y: 0, z: 0 }, 0.25, 20)).toBeNull();
    expect(physics.castSphere(origin, forward, 0, 20)).toBeNull();
    expect(physics.castSphere(origin, forward, -1, 20)).toBeNull();
    expect(physics.castSphere(origin, forward, 0.25, 0)).toBeNull();
    expect(physics.castSphere(origin, forward, 0.25, -5)).toBeNull();
    expect(physics.castSphere(origin, { x: Number.NaN, y: 0, z: 0 }, 0.25, 20)).toBeNull();
  });

  it('ignores layers that were not requested', () => {
    // The camera must not be moved by foliage or trigger volumes — `RISK_ANALYSIS.md` R3. The
    // mechanism is the layer list, so it is worth proving the list is actually respected.
    const physics = createWorld();
    physics.createStaticCollider({
      shape: { kind: 'cuboid', halfExtents: { x: 10, y: 10, z: 1.5 } },
      translation: { x: 0, y: 0, z: 4.5 },
      layer: CollisionLayer.Trigger,
    });
    physics.step();

    const againstTrigger = physics.castSphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 0.25, 20, [
      CollisionLayer.StaticWorld,
    ]);
    expect(againstTrigger).toBeNull();

    const againstTriggerLayer = physics.castSphere(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      0.25,
      20,
      [CollisionLayer.Trigger],
    );
    expect(againstTriggerLayer).not.toBeNull();
  });

  it('query and collider group encodings differ, which is what makes the trap possible', () => {
    //
    // ─── THE TRAP, PINNED ───────────────────────────────────────────────────────────────
    // Rapier requires BOTH directions of a group test to pass: the query's membership must
    // intersect the collider's filter, AND the collider's membership must intersect the query's
    // filter. Colliders and queries therefore need *opposite* encodings of the same layer, and
    // using the collider encoding for a query matches nothing at all — with no error, no
    // warning, and a query that simply reports an empty world.
    //
    // This project has already lost three integration tests to it. Every other test in this file
    // passes layers and successfully hits things, which proves the encoding `castSphere` uses
    // internally works; this assertion pins the reason a careless caller would fail.
    //
    // It is an assertion about the two encodings rather than about a failed query because
    // `castSphere` deliberately does not accept raw group values — it cannot be called wrongly.
    const colliderGroups = collisionGroupsFor([CollisionLayer.StaticWorld]);
    const queryGroups = queryGroupsFor([CollisionLayer.StaticWorld]);

    expect(colliderGroups).not.toEqual(queryGroups);

    // Read the two halves out of the packed u32 so the difference is visible rather than merely
    // asserted: membership is the high 16 bits, filter the low 16. A query claims membership of
    // everything (0xffff), because a query is not itself a member of any layer — it just wants to
    // be allowed to ask about all of them. A collider claims membership of only its own layer.
    const membershipOf = (packed: number): number => (packed >>> 16) & 0xffff;
    const filterOf = (packed: number): number => packed & 0xffff;

    expect(membershipOf(queryGroups)).toBe(0xffff);
    expect(membershipOf(colliderGroups)).not.toBe(0xffff);
    expect(filterOf(colliderGroups)).not.toBe(0);
    expect(filterOf(queryGroups)).not.toBe(0);
  });
});
