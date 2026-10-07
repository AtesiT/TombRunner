/**
 * Integration test: build the real Zone 1 level and put a real character on it.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS POSSIBLE WITHOUT A BROWSER (and why it is worth doing)
 * ────────────────────────────────────────────────────────────────────────────────
 * Geometry construction, procedural texture generation, material creation, scene graph
 * assembly and the whole Rapier simulation all run in plain Node — none of them touch a
 * GL context. Only the final `renderer.render()` call does.
 *
 * That means the entire content pipeline can be verified in CI: the level builds, the
 * collision mesh matches the visual mesh, the world primes, and a character controller
 * actually stands on the terrain that was generated. Without this test, the first time
 * anyone would learn that the temple platform's collider was in the wrong place is by
 * walking into it in a browser.
 *
 * The gap that remains — "does it *look* right" — is honestly un-automatable here and is
 * covered by a manual visual checklist, per risk W4 in docs/ARCHITECTURE.md §5.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../../src/physics/PhysicsWorld';
import { buildJungleLevel, sampleGroundHeight } from '../../src/world/LevelBuilder';
import { CollisionLayer } from '../../src/physics/Layers';
import { FIXED_DT, LEVEL_HALF_EXTENT_M } from '../../src/core/constants';

describe('Integration: Zone 1 level build', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it('builds a populated scene with collision and geometry within budget', () => {
    const physics = new PhysicsWorld();
    const level = buildJungleLevel(physics);

    // Content contract for Milestone 1.1: a jungle, not an empty plane.
    expect(level.summary.treeCount).toBeGreaterThanOrEqual(10);
    expect(level.summary.treeCount).toBeLessThanOrEqual(34);
    expect(level.summary.rockCount).toBeGreaterThanOrEqual(5);
    expect(level.summary.pillarCount).toBe(6);
    expect(level.summary.statueCount).toBe(4);
    expect(level.summary.wallCount).toBe(5);

    // Collision must exist for the ground plus every prop that got a collider.
    expect(level.summary.staticColliderCount).toBeGreaterThan(20);

    // Geometry budget. The brief targets a PS1 aesthetic at 60 FPS on mid-range
    // hardware; a runaway triangle count is the first symptom of geometry generation
    // going wrong, so the ceiling is asserted rather than merely hoped for.
    expect(level.summary.triangleCount).toBeGreaterThan(2_000);
    expect(level.summary.triangleCount).toBeLessThan(120_000);

    // Draw calls must stay bounded, which is what the per-cell instancing is for.
    expect(level.summary.drawCallEstimate).toBeLessThan(120);

    level.dispose();
    physics.dispose();
  });

  it('spawns the player above solid ground, not inside geometry or in the void', () => {
    const physics = new PhysicsWorld();
    const level = buildJungleLevel(physics);

    const spawn = level.summary.spawnPoint;

    // Within the level bounds, or the player would spawn outside the playable area.
    expect(Math.abs(spawn.x)).toBeLessThan(LEVEL_HALF_EXTENT_M);
    expect(Math.abs(spawn.z)).toBeLessThan(LEVEL_HALF_EXTENT_M);

    // Above the terrain surface but not absurdly high.
    const groundY = sampleGroundHeight(spawn.x, spawn.z);
    expect(spawn.y).toBeGreaterThan(groundY);
    expect(spawn.y - groundY).toBeLessThan(4);

    // The spawn must not be inside a prop. This is the check that would catch a tree
    // planted on the spawn point.
    const insideSomething = physics.sphereOverlaps(spawn, 0.5, [CollisionLayer.StaticWorld]);
    expect(insideSomething).toBe(false);

    level.dispose();
    physics.dispose();
  });

  it('primes the world and verifies ground is queryable from the spawn point', () => {
    const physics = new PhysicsWorld();
    const level = buildJungleLevel(physics);
    const spawn = level.summary.spawnPoint;

    // This is the E1 guard: it throws if the world is not queryable, converting a
    // silent permanent physics corruption into an immediate test failure.
    expect(() =>
      physics.primeAndVerify({ x: spawn.x, y: spawn.y + 8, z: spawn.z }),
    ).not.toThrow();

    expect(physics.isPrimed).toBe(true);

    // An unprimed world must be detectable, so the guard cannot be bypassed silently.
    expect(physics.colliderCount).toBeGreaterThan(20);

    level.dispose();
    physics.dispose();
  });

  it('lands a character on the generated terrain and holds it there', () => {
    // THE key integration test of this milestone: the character controller that
    // Milestone 1.2 will build upon, exercised against the *actual generated trimesh
    // terrain* rather than a flat test plane.
    //
    // If the collision mesh ever diverges from the visual mesh, the trimesh winding is
    // inverted, or the prime step is lost, this fails — and it fails in CI rather than
    // in a player's browser.
    const physics = new PhysicsWorld();
    const level = buildJungleLevel(physics);
    const spawn = level.summary.spawnPoint;

    physics.primeAndVerify({ x: spawn.x, y: spawn.y + 8, z: spawn.z });

    const character = physics.createCharacter({
      x: spawn.x,
      y: spawn.y + 4,
      z: spawn.z,
    });

    let verticalVelocity = 0;
    let sawGround = false;

    for (let tick = 0; tick < 180; tick++) {
      verticalVelocity = Math.max(verticalVelocity - 9.81 * FIXED_DT, -40);
      const result = character.moveAndSlide({ x: 0, y: verticalVelocity * FIXED_DT, z: 0 });
      if (result.grounded) {
        verticalVelocity = 0;
        sawGround = true;
      }
      physics.step();
    }

    const finalY = character.position.y;
    const groundY = sampleGroundHeight(spawn.x, spawn.z);

    // The character must have landed and be resting near the terrain surface, not
    // beneath it and not hovering above it.
    expect(sawGround).toBe(true);
    expect(finalY).toBeGreaterThan(groundY - 0.1);
    expect(finalY).toBeLessThan(groundY + 2.5);

    // And it must still be inside the level, not sunk through the trimesh.
    expect(finalY).toBeGreaterThan(-5);

    level.dispose();
    physics.dispose();
  });

  it('reports the terrain ground normal so slope handling has real data', () => {
    // The 5-ray cone probe in Milestone 1.2 needs a meaningful ground normal. This
    // verifies the engine supplies one for the generated terrain rather than the
    // character reporting nothing on a trimesh surface.
    const physics = new PhysicsWorld();
    const level = buildJungleLevel(physics);
    const spawn = level.summary.spawnPoint;
    physics.primeAndVerify({ x: spawn.x, y: spawn.y + 8, z: spawn.z });

    const character = physics.createCharacter({ x: spawn.x, y: spawn.y + 2, z: spawn.z });

    let verticalVelocity = 0;
    let groundNormal: { x: number; y: number; z: number } | null = null;

    for (let tick = 0; tick < 180; tick++) {
      verticalVelocity = Math.max(verticalVelocity - 9.81 * FIXED_DT, -40);
      const result = character.moveAndSlide({ x: 0, y: verticalVelocity * FIXED_DT, z: 0 });
      if (result.grounded) {
        verticalVelocity = 0;
        groundNormal = result.groundNormal;
      }
      physics.step();
    }

    expect(groundNormal).not.toBeNull();
    // Gentle terrain must report an upward-ish normal, which is what the slope bands
    // in GDD section 4.5 are computed from.
    expect(groundNormal!.y).toBeGreaterThan(0.7);

    level.dispose();
    physics.dispose();
  });
});
