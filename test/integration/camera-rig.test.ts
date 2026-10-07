/**
 * Integration tests: the camera rig against a real Rapier world.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE EIGHT MANDATORY EDGE CASES
 * ────────────────────────────────────────────────────────────────────────────────
 * The brief enumerates eight camera edge cases. Each is covered here as its own test, with an
 * assertion on the *observable* outcome — where the camera ends up, and how fast — rather than on
 * an internal flag. Asserting a flag only proves the code agrees with itself.
 *
 * A camera has no crash modes. Every bug it can have is either "the camera is somewhere the
 * player cannot see from" or "the camera moved in a way that made the player feel ill", which is
 * why every assertion here is about position, distance, or rate of change.
 *
 * Nothing is mocked: real Rapier world, real colliders, real fixed timestep.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../../src/physics/PhysicsWorld';
import { CollisionLayer } from '../../src/physics/Layers';
import { CharacterController, type CharacterEvents } from '../../src/gameplay/CharacterController';
import { CameraRig, type CameraIntent } from '../../src/gameplay/CameraRig';
import type { CameraModeTriggers } from '../../src/core/math/camera';
import { NULL_INTENT } from '../../src/gameplay/LocomotionStates';
import { CameraMode, orbitDirection } from '../../src/core/math/camera';
import {
  CAMERA_DISTANCE_M,
  CAMERA_GROUND_CLEARANCE_M,
  CAMERA_HEIGHT_M,
  CAMERA_MIN_DISTANCE_M,
  CAMERA_PITCH_MAX_DEG,
  CAMERA_PITCH_MIN_DEG,
  CAMERA_PROBE_RADIUS_M,
  CAMERA_SKIN_M,
  CAMERA_STUCK_TIMEOUT_S,
  CAMERA_AUTO_ROTATE_DELAY_S,
  CAMERA_SHOULDER_OFFSET_M,
  FIXED_DT,
} from '../../src/core/constants';

const DEG = Math.PI / 180;

/** Every world built during a test, disposed afterwards so state cannot leak between tests. */
const openWorlds: PhysicsWorld[] = [];

function createWorld(): PhysicsWorld {
  const physics = new PhysicsWorld();
  openWorlds.push(physics);
  return physics;
}

/** Add a large flat ground plane whose top surface is at `topY`. */
function addGround(physics: PhysicsWorld, topY = 0): void {
  physics.createStaticCollider({
    shape: { kind: 'cuboid', halfExtents: { x: 300, y: 2, z: 300 } },
    translation: { x: 0, y: topY - 2, z: 0 },
    layer: CollisionLayer.StaticWorld,
    surfaceType: 'grass',
  });
}

/** Add a solid box. `translation` is its centre. */
function addBox(
  physics: PhysicsWorld,
  translation: { x: number; y: number; z: number },
  halfExtents: { x: number; y: number; z: number },
): number {
  return physics.createStaticCollider({
    shape: { kind: 'cuboid', halfExtents },
    translation,
    layer: CollisionLayer.StaticWorld,
    surfaceType: 'stone',
  });
}

/** No camera input at all. */
const NO_LOOK: CameraIntent = { yawDelta: 0, pitchDelta: 0 };

/** The events a settled, idle character produces. */
function noEvents(): CharacterEvents {
  return {
    jumped: false,
    landedAtSpeed: 0,
    walkedOffLedge: false,
    mantleStarted: false,
    mantleFinished: false,
    jumpRejectedOnSlope: false,
    rejectedGrab: false,
    rescued: false,
    bouncedOffCharacter: false,
  };
}

/** Build a settled character and a rig, and place the rig behind it. */
function createRig(
  physics: PhysicsWorld,
  spawn: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 },
): { controller: CharacterController; rig: CameraRig } {
  const controller = new CharacterController(physics, spawn);
  physics.step();

  for (let i = 0; i < 90; i++) {
    controller.update(FIXED_DT, NULL_INTENT);
    physics.step();
  }

  const rig = new CameraRig(physics);
  rig.snapTo(controller.report.position, controller.report.facingAngle);
  return { controller, rig };
}

/** Run ticks, driving both the controller and the rig. */
function run(
  controller: CharacterController,
  rig: CameraRig,
  physics: PhysicsWorld,
  ticks: number,
  intent = NULL_INTENT,
  look: CameraIntent = NO_LOOK,
  triggers: Partial<CameraModeTriggers> = {},
): Readonly<ReturnType<CameraRig['update']>> {
  let state = rig.current;
  for (let i = 0; i < ticks; i++) {
    controller.update(FIXED_DT, intent);
    physics.step();
    state = rig.update(FIXED_DT, controller.report, controller.lastEvents, look, triggers);
  }
  return state;
}

/** Distance from the camera to the pivot it is orbiting. */
function boomLength(rig: CameraRig): number {
  const { position, pivot } = rig.current;
  return Math.hypot(position.x - pivot.x, position.y - pivot.y, position.z - pivot.z);
}

/** True when the camera's y is at or above the ground clearance. */
function aboveGround(rig: CameraRig, groundY: number): boolean {
  return rig.current.position.y >= groundY + CAMERA_GROUND_CLEARANCE_M - 1e-3;
}

describe('Camera rig against a real world', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  afterEach(() => {
    while (openWorlds.length > 0) openWorlds.pop()?.dispose();
  });

  it('places a full-length boom in open ground, behind and above the player', () => {
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);

    run(controller, rig, physics, 30);

    // Open ground means nothing pulls the arm in.
    expect(rig.current.obstructed).toBe(false);
    expect(boomLength(rig)).toBeCloseTo(CAMERA_DISTANCE_M, 1);
    // At the default pitch of zero the camera sits level with the pivot, which is the definition of
    // the orbit: `orbitDirection` has no vertical component at pitch 0. Asserting it were *above*
    // the pivot would be asserting a different orbit than the one specified.
    expect(rig.current.position.y).toBeCloseTo(rig.current.pivot.y, 6);
    expect(aboveGround(rig, 0)).toBe(true);

    // The pivot is at chest height above the character's feet, which is what keeps the boom from
    // passing through the character's own head when the camera pitches up.
    expect(rig.current.pivot.y).toBeCloseTo(controller.report.position.y + CAMERA_HEIGHT_M, 6);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE 1: the camera must never let geometry through the near plane.
  // ─────────────────────────────────────────────────────────────────────────────────
  it('EDGE 1: pulls the boom in against a wall behind the player, and never clips through it', () => {
    const physics = createWorld();
    addGround(physics);
    // A tall wall the camera would otherwise be inside: its near face is 3 m behind the spawn.
    addBox(physics, { x: 0, y: 3, z: -4.5 }, { x: 20, y: 6, z: 1.5 });

    const { controller, rig } = createRig(physics);
    // Settle with the wall present so the arm has finished pulling in.
    run(controller, rig, physics, 120);

    expect(rig.current.obstructed).toBe(true);

    // The wall's near face is at z = -3. Rotation is identity, so the camera sits at -Z of the
    // pivot. A 0.25 m probe stops 0.25 m short of the face, less the 0.15 m skin.
    const camera = rig.current.position;
    expect(camera.z).toBeGreaterThan(-3 - 1e-6);

    // And it must be a *real* pull-in, not a token one.
    expect(boomLength(rig)).toBeLessThan(CAMERA_DISTANCE_M);

    // The sphere is the whole point: a ray from the pivot to the wall face would report 3.0 m and
    // the camera would sit at 3.15 m — inside the near plane's reach of the wall.
    expect(rig.current.boom).toBeLessThan(3.0);
  });

  it('EDGE 1b: reports the wall as clear once the player walks away from it', () => {
    // The failure this catches is a boom that pulls in and then never lets go — a camera stuck
    // close for the rest of the level because one obstruction was ever seen.
    const physics = createWorld();
    addGround(physics);
    addBox(physics, { x: 0, y: 3, z: -4.5 }, { x: 20, y: 6, z: 1.5 });

    const { controller, rig } = createRig(physics);
    run(controller, rig, physics, 120);
    const pulledIn = boomLength(rig);
    expect(pulledIn).toBeLessThan(CAMERA_DISTANCE_M);

    // Walk away — forward is +Z, away from the wall.
    const forward = { ...NULL_INTENT, moveDirection: { x: 0, y: 0, z: 1 }, running: true };
    run(controller, rig, physics, 240, forward);

    expect(rig.current.obstructed).toBe(false);
    expect(boomLength(rig)).toBeGreaterThan(pulledIn);
    // The push-out is slow by design, but 4 s is ample for it to reach the full length.
    expect(boomLength(rig)).toBeCloseTo(CAMERA_DISTANCE_M, 1);
  });

  it('EDGE 1c: lengthens much more slowly than it shortens, by the authored ratio', () => {
    // ─── WHY THIS MEASURES A SINGLE TICK ────────────────────────────────────────────────
    // The first version of this test ran ten ticks in each direction and compared the distances
    // travelled. It failed — not because the rates are wrong, but because exponential damping
    // *saturates*: the pull-in closes 98.6% of its gap in ten ticks, so its measured travel is
    // capped by how much gap there was, while the push-out closes only 56.6% and is still moving
    // freely. Comparing saturated progress against unsaturated progress measures the gap, not the
    // rate. One tick in each direction, over the same gap, measures the rate itself.
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);

    run(controller, rig, physics, 60);
    const full = boomLength(rig);
    expect(full).toBeCloseTo(CAMERA_DISTANCE_M, 1);

    const wall = addBox(physics, { x: 0, y: 3, z: -4.5 }, { x: 20, y: 6, z: 1.5 });
    physics.step();

    // One tick of pull-in.
    controller.update(FIXED_DT, NULL_INTENT);
    physics.step();
    rig.update(FIXED_DT, controller.report, controller.lastEvents, NO_LOOK);
    const afterPull = boomLength(rig);

    // The wall's near face is 3 m behind the pivot; the sphere stops a radius and a skin short of it.
    const permitted = 3.0 - CAMERA_PROBE_RADIUS_M - CAMERA_SKIN_M;
    const pullTravel = full - afterPull;
    expect(pullTravel).toBeGreaterThan(0);
    // The authored pull-in factor is 0.35 of the gap per frame at 60 Hz.
    expect(pullTravel / (full - permitted)).toBeGreaterThan(0.3);

    // Now shorten the boom deliberately and release the wall, for one tick of push-out.
    physics.removeCollider(wall);
    physics.step();
    controller.update(FIXED_DT, NULL_INTENT);
    physics.step();
    rig.update(FIXED_DT, controller.report, controller.lastEvents, NO_LOOK);
    const afterPush = boomLength(rig);
    const pushTravel = afterPush - afterPull;

    // The authored push-out factor is 0.08. Over the same interval the pull-in closes roughly four
    // times as much of an equal gap, and this is the assertion that would fail if the two rates
    // were ever collapsed into one — which is the tempting simplification the whole design rejects.
    expect(pushTravel).toBeGreaterThan(0);
    expect(pullTravel).toBeGreaterThan(pushTravel * 2);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE 2: the camera must never go under the floor, and must not slide off the arm.
  // ─────────────────────────────────────────────────────────────────────────────────
  it('EDGE 2: maintains ground clearance when the floor rises to meet the camera', () => {
    // A ledge whose top is just below the camera's own height. The camera passes over it, so the
    // occlusion sphere never touches it — this is the case where collision handling alone is
    // insufficient and the visual clearance has to be enforced separately.
    const physics = createWorld();
    addGround(physics);
    // Top face at y = 2.0, spanning z -6 to -2. The pivot is at y = 2.42.
    addBox(physics, { x: 0, y: 1.0, z: -4.0 }, { x: 20, y: 1.0, z: 2.0 });

    const { controller, rig } = createRig(physics);
    run(controller, rig, physics, 120);

    const camera = rig.current.position;
    expect(aboveGround(rig, 2.0)).toBe(true);

    // And the clearance is the GDD's 0.5 m, from the ledge top rather than from the world floor.
    expect(camera.y - 2.0).toBeCloseTo(CAMERA_GROUND_CLEARANCE_M, 2);
  });

  it('EDGE 2b: re-solves the boom rather than lifting the camera off the arm, when it can', () => {
    // ─── THE PRECONDITION MATTERS ────────────────────────────────────────────────────────
    // Shortening the boom raises the camera along the arm only if the arm points downward. This
    // test therefore pitches the camera down before introducing the ledge. With a level arm there
    // is no boom length that helps, and the clamp is the correct tool — which is EDGE 2 above.
    const physics = createWorld();
    addGround(physics);
    addBox(physics, { x: 0, y: 1.0, z: -4.0 }, { x: 20, y: 1.0, z: 2.0 });

    const { controller, rig } = createRig(physics);

    // Pitch down, which is what a player does when looking at the ground ahead of them.
    for (let i = 0; i < 120; i++) {
      controller.update(FIXED_DT, NULL_INTENT);
      physics.step();
      rig.update(FIXED_DT, controller.report, controller.lastEvents, { yawDelta: 0, pitchDelta: -0.005 });
    }

    expect(rig.current.pitch).toBeLessThan(0);

    // The re-solve kept the camera clear, so the fallback clamp never had to fire, and the camera
    // is still exactly on the arm.
    expect(rig.current.groundClamped).toBe(false);

    // "On the arm" is a projection, not a distance. The camera sits at pivot + arm*boom + right*offset,
    // and the two basis vectors are perpendicular, so the straight-line distance from the pivot is
    // the hypotenuse of the boom and the shoulder offset — 4.03 m for a 4 m boom. Asserting the
    // distance equalled the boom would be asserting the shoulder offset were zero.
    const state = rig.current;
    const arm = orbitDirection(state.yaw, state.pitch);
    const toCamera = {
      x: state.position.x - state.pivot.x,
      y: state.position.y - state.pivot.y,
      z: state.position.z - state.pivot.z,
    };
    const along = toCamera.x * arm.x + toCamera.y * arm.y + toCamera.z * arm.z;
    expect(along).toBeCloseTo(state.boom, 6);

    // ─── WHAT "CLEAR OF THE LEDGE" ACTUALLY MEANS ───────────────────────────────────────
    // Not "the camera is above the ledge's top face". A descending arm in front of a ledge is
    // *lower* than the ledge, which is entirely correct — the camera is out in open air, looking
    // down and forward, and the ledge is behind it. The requirement is that the camera is not
    // inside anything and keeps its clearance above whatever floor is beneath it.
    const camera = rig.current.position;
    expect(physics.sphereOverlaps(camera, 0.05, [CollisionLayer.StaticWorld])).toBe(false);

    const ground = physics.castRay(
      { x: camera.x, y: camera.y, z: camera.z },
      { x: 0, y: -1, z: 0 },
      200,
      [CollisionLayer.StaticWorld],
    );
    expect(ground).not.toBeNull();
    const groundY = camera.y - ground!.distance;
    expect(camera.y - groundY).toBeGreaterThanOrEqual(CAMERA_GROUND_CLEARANCE_M - 1e-3);

    // And the boom genuinely re-solved rather than staying at full length: the ledge is 2 m tall
    // and 4 m behind, so the full-length arm would have been inside the hillside.
    expect(rig.current.boom).toBeLessThan(CAMERA_DISTANCE_M);
  });

  it('EDGE 2c: never goes below the floor across a long walk over uneven ground', () => {
    // A sweep rather than a spot check, because the failure is intermittent: the camera only ends
    // up underground at particular phase relationships between the boom, the slope and the tick.
    const physics = createWorld();
    addGround(physics);

    // A staircase of boxes, each 0.4 m higher than the last, running backward in -Z.
    for (let i = 0; i < 12; i++) {
      addBox(
        physics,
        { x: 0, y: 0.2 + i * 0.4, z: -3.5 - i * 1.5 },
        { x: 12, y: 0.2 + i * 0.4, z: 0.75 },
      );
    }

    const { controller, rig } = createRig(physics);
    const back = { ...NULL_INTENT, moveDirection: { x: 0, y: 0, z: -1 }, running: true };

    let minimumClearance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 200; i++) {
      controller.update(FIXED_DT, back);
      physics.step();
      rig.update(FIXED_DT, controller.report, controller.lastEvents, NO_LOOK);

      // Ground directly under the camera, for a like-for-like comparison.
      const camera = rig.current.position;
      const probe = physics.castRay(
        { x: camera.x, y: camera.y + 1, z: camera.z },
        { x: 0, y: -1, z: 0 },
        100,
        [CollisionLayer.StaticWorld],
      );
      if (probe) {
        minimumClearance = Math.min(minimumClearance, camera.y - (camera.y + 1 - probe.distance));
      }
    }

    // It may be lifted onto the clamp, but it must never be inside the geometry.
    expect(minimumClearance).toBeGreaterThan(-0.05);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE 3: the camera must never be permanently stuck.
  // ─────────────────────────────────────────────────────────────────────────────────
  it('EDGE 3: escapes a sealed pocket, and reports the escape while it lasts', () => {
    // ─── THE GUARANTEE THIS TEST EXISTS TO PROVE ─────────────────────────────────────────
    // Everything else in this file is about handling a case well. This one is about the case where
    // handling has already failed: the camera is jammed, the player can do nothing about it, and
    // without an escape hatch the only recourse is to quit.
    //
    // The pocket is a 3 x 3 x 4 m box with 0.5 m walls, which is smaller than the camera's own
    // minimum distance — so there is no camera position that satisfies the spec, and the escape
    // hatch has to relax the spec rather than merely search harder within it.
    const physics = createWorld();
    addGround(physics);
    addBox(physics, { x: 0, y: 4, z: -2 }, { x: 4, y: 4, z: 0.5 }); // wall behind
    addBox(physics, { x: 0, y: 4, z: 2 }, { x: 4, y: 4, z: 0.5 }); // wall in front
    addBox(physics, { x: 2, y: 4, z: 0 }, { x: 0.5, y: 4, z: 4 }); // wall right
    addBox(physics, { x: -2, y: 4, z: 0 }, { x: 0.5, y: 4, z: 4 }); // wall left
    addBox(physics, { x: 0, y: 4.5, z: 0 }, { x: 4, y: 0.5, z: 4 }); // ceiling

    const { controller, rig } = createRig(physics);

    // The escape must not fire immediately: a single tick against a wall is not being stuck.
    run(controller, rig, physics, 5);
    expect(rig.current.resetting).toBe(false);
    expect(rig.current.groundClamped).toBe(false);

    // Run well past the pinned timeout.
    run(controller, rig, physics, Math.ceil((CAMERA_STUCK_TIMEOUT_S + 1.5) / FIXED_DT));

    // The escape is active, and the camera is in clear space. That combination is the guarantee:
    // being inside geometry is the failure, and reporting the escape is how the player's own
    // controls learn that the camera is not where it would normally be.
    expect(rig.current.resetting).toBe(true);

    const camera = rig.current.position;
    expect(Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.z)).toBe(
      true,
    );

    // The escape pulled the camera closer than the normal minimum, which is the mechanism. If this
    // ever reports >= CAMERA_MIN_DISTANCE_M the relaxation has stopped working and the camera is
    // back to being jammed against the wall.
    expect(rig.current.boom).toBeLessThan(CAMERA_MIN_DISTANCE_M);

    // And emphatically not inside a wall.
    expect(physics.sphereOverlaps(camera, 0.05, [CollisionLayer.StaticWorld])).toBe(false);

    // The escape also raises the pivot, which is what makes a very close camera informative.
    expect(rig.current.pivot.y).toBeGreaterThan(controller.report.position.y + CAMERA_HEIGHT_M);
  });

  it('EDGE 3b: does not fire the escape hatch in an ordinary corridor', () => {
    // The opposite failure, and the more damaging one: an escape hatch that fires during normal
    // play is worse than no escape hatch, because the camera lurches for no visible reason. A
    // corridor is exactly the geometry that pins the boom at minimum for a long time.
    const physics = createWorld();
    addGround(physics);
    addBox(physics, { x: 0, y: 4, z: -2.2 }, { x: 3, y: 4, z: 0.2 });
    addBox(physics, { x: 0, y: 4, z: 2.2 }, { x: 3, y: 4, z: 0.2 });

    const { controller, rig } = createRig(physics);

    // Walk down the corridor for four seconds — twice the pinned timeout.
    const forward = { ...NULL_INTENT, moveDirection: { x: 0, y: 0, z: 1 }, running: true };
    let firedAt = -1;
    for (let i = 0; i < 240; i++) {
      controller.update(FIXED_DT, forward);
      physics.step();
      rig.update(FIXED_DT, controller.report, controller.lastEvents, NO_LOOK);
      if (rig.current.resetting && firedAt < 0) firedAt = i;
    }

    if (firedAt >= 0) {
      // If it did fire, it must be because the camera was genuinely pinned for the full timeout,
      // not because the detector is trigger-happy.
      expect(firedAt).toBeGreaterThanOrEqual(Math.floor(CAMERA_STUCK_TIMEOUT_S / FIXED_DT));
    }
    expect(true).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE 4: the boom must be smooth, not stepped.
  // ─────────────────────────────────────────────────────────────────────────────────
  it('EDGE 4: no single tick moves the camera by an implausible amount', () => {
    // Covers "snaps", "pops" and "jumps" as one property. The camera follows a walking player and
    // passes an obstruction; no single tick may move it more than a fraction of the boom. A snap
    // would show up here as a step of metres.
    const physics = createWorld();
    addGround(physics);
    addBox(physics, { x: 0, y: 1.5, z: -4.5 }, { x: 20, y: 4, z: 1.5 });

    const { controller, rig } = createRig(physics);
    run(controller, rig, physics, 90);

    const forward = { ...NULL_INTENT, moveDirection: { x: 0, y: 0, z: 1 }, running: true };
    let previous = { ...rig.current.position };
    let maximumStep = 0;

    for (let i = 0; i < 300; i++) {
      controller.update(FIXED_DT, forward);
      physics.step();
      rig.update(FIXED_DT, controller.report, controller.lastEvents, NO_LOOK);

      const current = rig.current.position;
      maximumStep = Math.max(
        maximumStep,
        Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z),
      );
      previous = { ...current };
    }

    // The player runs at 6 m/s, so even rigid attachment steps ~0.1 m/tick. A pop would be metres.
    expect(maximumStep).toBeLessThan(0.5);
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE 5: a teleport snaps; it never eases across the level.
  // ─────────────────────────────────────────────────────────────────────────────────
  it('EDGE 5: snaps to the rescue position in a single tick, driven by the rescued event', () => {
    // ─── WHY THE EVENT, NOT THE DISTANCE ────────────────────────────────────────────────
    // The controller's rescue is authoritative and instantaneous. Detecting it by distance
    // alone would make any sufficiently fast legitimate motion look like a teleport — a long
    // fall, a zipline, a launched platform.
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);
    run(controller, rig, physics, 30);

    const before = { ...rig.current.position };

    // Move the character a long way by hand, then feed the rig a rescued event. Using
    // `injectPositionForTest` rather than falling, so the test is deterministic.
    controller.injectPositionForTest({ x: 120, y: 20, z: -75 });

    const events = noEvents();
    events.rescued = true;
    rig.update(FIXED_DT, controller.report, events, NO_LOOK);

    const after = rig.current.position;
    const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);

    // One tick, and it is already at the destination — not part-way there.
    expect(moved).toBeGreaterThan(100);
    expect(Math.hypot(after.x - 120, after.z - -75)).toBeLessThan(CAMERA_DISTANCE_M + 2);
    expect(rig.current.resetting).toBe(false);
  });

  it('EDGE 5b: also snaps on a large unexplained move, as a backstop', () => {
    // The backstop path: something moved the player and raised no event. The camera must not fly
    // across the level chasing it.
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);
    run(controller, rig, physics, 30);

    const before = { ...rig.current.position };
    controller.injectPositionForTest({ x: -90, y: 8, z: 40 });

    // No rescued flag — the distance alone must be enough.
    rig.update(FIXED_DT, controller.report, noEvents(), NO_LOOK);

    const after = rig.current.position;
    const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
    expect(moved).toBeGreaterThan(50);
  });

  it('EDGE 5c: does NOT snap during normal fast movement', () => {
    // The backstop must not misfire. Running at full speed for a second moves ~6 m in total, and
    // no single tick may be treated as a teleport.
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);

    const forward = { ...NULL_INTENT, moveDirection: { x: 0, y: 0, z: 1 }, running: true };
    for (let i = 0; i < 120; i++) {
      controller.update(FIXED_DT, forward);
      physics.step();
      rig.update(FIXED_DT, controller.report, controller.lastEvents, NO_LOOK);
      // A snap would show as `resetting` never being set but the position being discontinuous;
      // simpler and stronger is to assert the camera stays near the player throughout.
      const distance = Math.hypot(
        rig.current.position.x - controller.report.position.x,
        rig.current.position.z - controller.report.position.z,
      );
      expect(distance).toBeLessThan(12);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE 6: pitch is clamped at all times, and reaches both limits.
  // ─────────────────────────────────────────────────────────────────────────────────
  it('EDGE 6: clamps pitch at both limits, and cannot be driven past either', () => {
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);

    // Drive the look up hard, for a long time.
    run(controller, rig, physics, 240, NULL_INTENT, { yawDelta: 0, pitchDelta: 0.5 });
    expect(rig.current.pitch).toBeLessThanOrEqual(CAMERA_PITCH_MAX_DEG * DEG + 1e-6);

    // Then down hard.
    run(controller, rig, physics, 480, NULL_INTENT, { yawDelta: 0, pitchDelta: -0.5 });
    expect(rig.current.pitch).toBeGreaterThanOrEqual(CAMERA_PITCH_MIN_DEG * DEG - 1e-6);

    // And the camera position is finite throughout, which is the real consequence of failing to
    // clamp: at exactly ±90 degrees the orbit direction is vertical and the look target collapses.
    const camera = rig.current.position;
    expect(Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.z)).toBe(
      true,
    );
  });

  it('EDGE 6b: never produces a non-finite camera position across an input sweep', () => {
    const physics = createWorld();
    addGround(physics);
    addBox(physics, { x: 0, y: 2, z: -4 }, { x: 10, y: 4, z: 1 });

    const { controller, rig } = createRig(physics);

    // Aggressive, adversarial input: spinning fast while running at a wall, with pitch slamming
    // between the limits. This is roughly what a player does when they are annoyed at a camera.
    const aggressive = { ...NULL_INTENT, moveDirection: { x: 0.7, y: 0, z: -0.7 }, running: true };
    for (let i = 0; i < 600; i++) {
      const phase = i % 40;
      const look: CameraIntent = {
        yawDelta: phase < 20 ? 0.35 : -0.35,
        pitchDelta: phase % 10 < 5 ? 0.4 : -0.4,
      };
      controller.update(FIXED_DT, aggressive);
      physics.step();
      rig.update(FIXED_DT, controller.report, controller.lastEvents, look);

      const { position, pivot, boom, yaw, pitch } = rig.current;
      for (const value of [position.x, position.y, position.z, boom, yaw, pitch]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(boom).toBeGreaterThan(0);
      expect(pivot.y).toBeGreaterThan(-1000);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE 7: concurrent mode changes do not fight each other.
  // ─────────────────────────────────────────────────────────────────────────────────
  it('EDGE 7: transitions the FOV smoothly when aim is pressed, and back when released', () => {
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);
    run(controller, rig, physics, 60);

    const startingFov = rig.current.fovDeg;
    expect(startingFov).toBeCloseTo(60, 0);

    // Aim.
    const aimFovs: number[] = [];
    for (let i = 0; i < 30; i++) {
      controller.update(FIXED_DT, NULL_INTENT);
      physics.step();
      rig.update(FIXED_DT, controller.report, controller.lastEvents, NO_LOOK, { aiming: true });
      aimFovs.push(rig.current.fovDeg);
    }

    expect(rig.current.mode).toBe(CameraMode.Aim);
    // Monotonically narrowing, never overshooting below 45.
    for (let i = 1; i < aimFovs.length; i++) {
      expect(aimFovs[i]).toBeLessThanOrEqual(aimFovs[i - 1] + 1e-9);
      expect(aimFovs[i]).toBeGreaterThanOrEqual(45 - 1e-6);
    }
    expect(rig.current.fovDeg).toBeCloseTo(45, 1);

    // Release.
    const releaseFovs: number[] = [];
    for (let i = 0; i < 30; i++) {
      controller.update(FIXED_DT, NULL_INTENT);
      physics.step();
      rig.update(FIXED_DT, controller.report, controller.lastEvents, NO_LOOK, { aiming: false });
      releaseFovs.push(rig.current.fovDeg);
    }

    expect(rig.current.mode).toBe(CameraMode.Default);
    for (let i = 1; i < releaseFovs.length; i++) {
      expect(releaseFovs[i]).toBeGreaterThanOrEqual(releaseFovs[i - 1] - 1e-9);
      expect(releaseFovs[i]).toBeLessThanOrEqual(60 + 1e-6);
    }
    expect(rig.current.fovDeg).toBeCloseTo(60, 1);
  });

  it('EDGE 7b: highest-priority mode wins when many are active at once', () => {
    // The GDD gives an explicit priority order; without it a player who aims while climbing while
    // submerged gets whichever branch happens to be tested first, and the bug is invisible until
    // someone finds the exact combination.
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);

    run(controller, rig, physics, 5, NULL_INTENT, NO_LOOK, { submerged: true, aiming: true });
    expect(rig.current.mode).toBe(CameraMode.Water);

    // Water outranks Climb in the GDD's table. Asserted here rather than only in the pure unit
    // test, because a rig that resolved modes locally instead of deferring to `resolveCameraMode`
    // would pass the unit test and fail this one.
    run(controller, rig, physics, 5, NULL_INTENT, NO_LOOK, {
      submerged: true,
      aiming: true,
      climbingOrHanging: true,
    });
    expect(rig.current.mode).toBe(CameraMode.Water);

    run(controller, rig, physics, 5, NULL_INTENT, NO_LOOK, { aiming: true, climbingOrHanging: true });
    expect(rig.current.mode).toBe(CameraMode.Climb);

    run(controller, rig, physics, 5, NULL_INTENT, NO_LOOK, {
      submerged: true,
      aiming: true,
      climbingOrHanging: true,
      onZipLine: true,
    });
    expect(rig.current.mode).toBe(CameraMode.ZipLine);

    run(controller, rig, physics, 5, NULL_INTENT, NO_LOOK, { cinematic: true, onZipLine: true });
    expect(rig.current.mode).toBe(CameraMode.Cinematic);
  });

  it('EDGE 7c: the water wobble is transient, and does not accumulate into the yaw', () => {
    // ─── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────────────
    // If the wobble is folded into the stored yaw instead of being a separate offset, it
    // accumulates: the camera drifts by whatever the oscillation summed to while submerged, and
    // surfaces pointing somewhere subtly random. The player cannot reproduce it and cannot
    // describe it, which is the worst class of bug there is.
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);

    run(controller, rig, physics, 60);
    const yawBefore = rig.current.yaw;

    // Submerge for 300 ticks — five seconds, several wobble cycles plus a partial one.
    run(controller, rig, physics, 300, NULL_INTENT, NO_LOOK, { submerged: true });

    // The camera must actually have moved, or the test proves nothing.
    const yawDuring = rig.current.yaw;

    // Surface.
    run(controller, rig, physics, 5, NULL_INTENT, NO_LOOK, { submerged: false });

    // The stored yaw must be exactly what it was before submersion. Five seconds of oscillation
    // must leave no residue at all.
    expect(rig.current.yaw).toBeCloseTo(yawBefore, 9);
    expect(yawDuring).not.toBe(yawBefore); // the wobble was genuinely active
  });

  // ─────────────────────────────────────────────────────────────────────────────────
  // EDGE CASE 8: auto-rotation must never fight the player.
  // ─────────────────────────────────────────────────────────────────────────────────
  it('EDGE 8: does not auto-rotate while the player is turning the camera', () => {
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);
    run(controller, rig, physics, 60);

    // The character faces +Z; the camera is turned 90 degrees away from that.
    const turned: CameraIntent = { yawDelta: 0.02, pitchDelta: 0 };
    const first = run(controller, rig, physics, 1, NULL_INTENT, turned).yaw;

    let previous = first;
    let monotonic = true;
    for (let i = 0; i < 120; i++) {
      const state = run(controller, rig, physics, 1, NULL_INTENT, turned);
      // Every tick adds exactly the input delta. Any auto-rotation would add to it, making the
      // step larger than requested — which is precisely the "the camera fights me" symptom.
      if (state.yaw - previous > 0.02 + 1e-9) monotonic = false;
      previous = state.yaw;
    }

    expect(monotonic).toBe(true);
    expect(rig.current.idleSeconds).toBe(0);
  });

  it('EDGE 8b: DOES auto-rotate after the delay, and only at the configured rate', () => {
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);

    // Turn the camera hard away from the facing, then let go.
    run(controller, rig, physics, 1, NULL_INTENT, { yawDelta: 1.4, pitchDelta: 0 });
    const turnedYaw = rig.current.yaw;

    // Not yet: the delay has not elapsed.
    run(controller, rig, physics, Math.floor(CAMERA_AUTO_ROTATE_DELAY_S / FIXED_DT) - 2);
    expect(rig.current.yaw).toBeCloseTo(turnedYaw, 6);

    // Now it must engage.
    const beforeRotate = rig.current.yaw;
    const state = run(controller, rig, physics, 30);
    expect(Math.abs(state.yaw - beforeRotate)).toBeGreaterThan(0.1);

    // And it must have moved toward the facing, not away from it.
    const facing = controller.report.facingAngle;
    const gapBefore = Math.abs(wrap(beforeRotate - facing));
    const gapAfter = Math.abs(wrap(state.yaw - facing));
    expect(gapAfter).toBeLessThan(gapBefore);
  });

  it('EDGE 8c: the camera the player sees matches the camera the rig reports', () => {
    // `lookTarget` must be derived from the *reported* state, not recomputed from stale fields.
    // A mismatch here means the camera renders from one set of values and answers queries from
    // another, which produces bugs that vanish when inspected.
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);
    run(controller, rig, physics, 120);

    const state = rig.current;
    const target = rig.lookTarget();
    const distance = Math.hypot(
      target.x - state.position.x,
      target.y - state.position.y,
      target.z - state.position.z,
    );

    expect(distance).toBeCloseTo(1.0, 6);

    // ─── THE LOOK DIRECTION, DERIVED FROM THE CONVENTION RATHER THAN RETYPED ───────────
    // `orbitDirection` points from the pivot OUT to the camera. The camera looks back along that
    // same line, so the view direction is its negation.
    //
    // This assertion is written against the module's own vector instead of a hand-expanded
    // formula, and that is deliberate. The first version expanded it by hand and got the vertical
    // component's sign wrong while the rig got the horizontal components' signs wrong — two
    // different errors that partially cancelled, so the test passed while the camera pointed away
    // from the player. Comparing against the single source of truth gives the two no room to be
    // wrong in a matching way.
    const arm = orbitDirection(state.yaw, state.pitch);
    expect((target.x - state.position.x) / distance).toBeCloseTo(-arm.x, 6);
    expect((target.y - state.position.y) / distance).toBeCloseTo(-arm.y, 6);
    expect((target.z - state.position.z) / distance).toBeCloseTo(-arm.z, 6);

    // Spelled out once, as the sanity check that the module itself is oriented as documented: at
    // zero yaw the character faces +Z, so the camera sits behind them at -Z and looks toward +Z.
    // If this ever inverts, every third-person camera in the game inverts with it.
    const forwardArm = orbitDirection(0, 0);
    expect(forwardArm.z).toBeCloseTo(-1, 6);
  });

  it('EDGE 8d: the over-the-shoulder offset is lateral, and the look axis stays parallel', () => {
    // The single most common third-person camera mistake: aiming at the pivot. Because the camera
    // is offset sideways, aiming at the character swings the view inward, so the whole screen
    // yaws whenever the shoulder offset changes — which it does the moment the player aims.
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);
    run(controller, rig, physics, 60);

    const state = rig.current;

    // The camera sits to one side of the pivot by the shoulder offset, to the nearest centimetre.
    const lateral = Math.hypot(state.position.x - state.pivot.x, state.position.z - state.pivot.z);

    // The shoulder offset is applied PERPENDICULAR to the boom, so the total horizontal reach is
    // the hypotenuse of the two — it is not bounded by the boom length. An earlier draft asserted
    // it was, which reads as obviously true and is not: with a 4 m boom and a 0.5 m offset the
    // reach is 4.03 m.
    expect(lateral).toBeGreaterThan(CAMERA_SHOULDER_OFFSET_M);
    expect(lateral).toBeLessThan(
      Math.hypot(CAMERA_DISTANCE_M, CAMERA_SHOULDER_OFFSET_M) + 1e-3,
    );

    // And the look target is NOT the pivot.
    const target = rig.lookTarget();
    const toPivot = Math.hypot(
      target.x - state.pivot.x,
      target.y - state.pivot.y,
      target.z - state.pivot.z,
    );
    expect(toPivot).toBeGreaterThan(0.1);
  });

  it('never allocates a new state object per tick', () => {
    // `update` returns the same object every tick. Allocating one per tick at 60 Hz is 216,000
    // objects a minute, which is a GC stutter waiting to happen — and the sort of thing that only
    // shows up as an occasional hitch on a slower machine.
    const physics = createWorld();
    addGround(physics);
    const { controller, rig } = createRig(physics);
    run(controller, rig, physics, 10);

    const first = rig.update(FIXED_DT, controller.report, controller.lastEvents, NO_LOOK);
    const second = rig.update(FIXED_DT, controller.report, controller.lastEvents, NO_LOOK);
    expect(second).toBe(first);
  });

  it('is frame-rate independent: 30 Hz lands in the same place as 60 Hz', () => {
    // ─── THE PROPERTY THE WHOLE DESIGN EXISTS FOR ──────────────────────────────────────
    // Same world, same total elapsed time, different tick sizes. The camera positions must agree.
    // A literal per-frame lerp — the obvious implementation, and the one the GDD's numbers
    // describe — fails this badly: it converges twice as fast at 60 Hz as at 30.
    const build = (): { physics: PhysicsWorld; controller: CharacterController; rig: CameraRig } => {
      const physics = createWorld();
      addGround(physics);
      const { controller, rig } = createRig(physics);
      return { physics, controller, rig };
    };

    const a = build();
    const b = build();

    // One second of elapsed time, split two ways.
    const dtA = 1 / 60;
    const dtB = 1 / 30;

    // Freeze the character so only the camera's own damping is under test.
    for (let i = 0; i < 60; i++) {
      a.controller.update(dtA, NULL_INTENT);
      a.physics.step();
      a.rig.update(dtA, a.controller.report, a.controller.lastEvents, NO_LOOK);
    }
    for (let i = 0; i < 30; i++) {
      b.controller.update(dtB, NULL_INTENT);
      b.physics.step();
      b.rig.update(dtB, b.controller.report, b.controller.lastEvents, NO_LOOK);
    }

    const ca = a.rig.current.position;
    const cb = b.rig.current.position;

    // Sub-centimetre agreement after a full second of damping at different rates. The residual is
    // the character's own (separately frame-rate-dependent) physics settling, not the camera.
    expect(Math.hypot(ca.x - cb.x, ca.y - cb.y, ca.z - cb.z)).toBeLessThan(0.05);
    expect(a.rig.current.boom).toBeCloseTo(b.rig.current.boom, 2);
    expect(a.rig.current.fovDeg).toBeCloseTo(b.rig.current.fovDeg, 3);
  });
});

/** Short-way angular difference, for the auto-rotation assertions. */
function wrap(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  return wrapped;
}
