/**
 * Integration test: the feedback loop between camera-relative movement and camera auto-rotation.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE LOOP NOBODY DESIGNED, WHICH NONETHELESS EXISTS
 * ────────────────────────────────────────────────────────────────────────────────
 * Milestone 1.3 made the camera auto-rotate its yaw toward the character's facing after half a
 * second with no camera input. Milestone 1.4 made movement camera-relative, so the character turns
 * toward *camera-forward*. That closes a loop:
 *
 *     camera yaw → movement direction → character facing → camera yaw
 *
 * Nobody chose to build a feedback loop; it is a consequence of two features that are each
 * obviously correct. Such loops are where third-person games acquire their reputation for cameras
 * that spin, drift, or curve the player's path while they hold forward — and no unit test on either
 * component can see it, because each component is right in isolation.
 *
 * The loop has a fixed point: holding forward settles with the character facing along
 * camera-forward, the auto-rotation satisfied, and the yaw change per tick decaying to zero. This
 * file asserts that the fixed point is reached, and that it is reached *without* the character
 * slowly circling. It is the DEV_LOG's Q6 concern, and its decision 5's own promise: assert the
 * fixed point rather than reason about it in a comment.
 */

import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../../src/physics/PhysicsWorld';
import { CollisionLayer } from '../../src/physics/Layers';
import { CharacterController } from '../../src/gameplay/CharacterController';
import { CameraRig } from '../../src/gameplay/CameraRig';
import { InputSystem } from '../../src/input/InputSystem';
import { NULL_INTENT } from '../../src/gameplay/LocomotionStates';
import { FakeDom } from '../support/fake-dom';
import { FIXED_DT, INPUT_LOOK_SENSITIVITY } from '../../src/core/constants';

const worlds: PhysicsWorld[] = [];

function createWorld(): PhysicsWorld {
  const physics = new PhysicsWorld();
  worlds.push(physics);

  physics.createStaticCollider({
    shape: { kind: 'cuboid', halfExtents: { x: 300, y: 2, z: 300 } },
    translation: { x: 0, y: -2, z: 0 },
    layer: CollisionLayer.StaticWorld,
    surfaceType: 'grass',
  });
  return physics;
}

/** Short-way angular difference, for measuring yaw changes across the ±pi seam. */
function wrap(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  if (wrapped < -Math.PI) wrapped += twoPi;
  return wrapped;
}

describe('camera-relative movement and auto-rotation', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  afterEach(() => {
    while (worlds.length > 0) worlds.pop()?.dispose();
  });

  let dom: FakeDom;
  let input: InputSystem;

  beforeEach(() => {
    dom = new FakeDom();
    const { target, canvas } = dom.install();
    input = new InputSystem(target, canvas, null);
    input.beginTick(0); // priming tick: adopts no edges by design
  });

  afterEach(() => {
    input.dispose();
    dom.uninstall();
  });

  /**
   * One turn of the whole loop: input → camera yaw → movement → controller → camera.
   *
   * The camera yaw is read from the rig's *reported* state before the input is sampled, matching
   * `Game.simulateTick`. That is what makes the loop real rather than an artefact of the test: the
   * transform uses exactly the yaw the camera is actually on.
   */
  function tick(controller: CharacterController, rig: CameraRig, physics: PhysicsWorld): void {
    const snapshot = input.beginTick(rig.current.yaw);
    controller.update(FIXED_DT, snapshot.intent);
    physics.step();
    rig.update(FIXED_DT, controller.report, controller.lastEvents, snapshot.look, {});
  }

  /** Settle a character on the ground with input driven, and return the pair. */
  function createSettled(
    physics: PhysicsWorld,
  ): { controller: CharacterController; rig: CameraRig } {
    const controller = new CharacterController(physics, { x: 0, y: 1, z: 0 });
    physics.step();

    const rig = new CameraRig(physics);
    for (let i = 0; i < 90; i++) {
      input.beginTick(0);
      controller.update(FIXED_DT, NULL_INTENT);
      physics.step();
    }

    rig.snapTo(controller.report.position, controller.report.facingAngle);
    return { controller, rig };
  }

  it('converges: holding forward settles instead of circling or oscillating', () => {
    const physics = createWorld();
    const { controller, rig } = createSettled(physics);

    // ─── THE SETUP THAT MAKES THE TEST MEANINGFUL ─────────────────────────────────────
    // Snap the camera deliberately off the character's facing, so the loop has real work to do and
    // the auto-rotation is genuinely engaged rather than trivially satisfied. Then hold forward:
    // the character turns toward camera-forward, and the camera turns toward the character, and the
    // two must meet rather than chase.
    const offAxisYaw = controller.report.facingAngle + Math.PI / 2;
    rig.snapTo(controller.report.position, offAxisYaw);
    for (let i = 0; i < 30; i++) tick(controller, rig, physics);

    dom.keyDown('KeyW');

    const yawChanges: number[] = [];
    const path: Array<{ x: number; z: number }> = [];
    let previousYaw = rig.current.yaw;

    for (let i = 0; i < 300; i++) {
      tick(controller, rig, physics);

      // The signed change per tick is what distinguishes convergence from oscillation: an
      // oscillating loop alternates sign at a roughly constant magnitude, a converging one decays.
      yawChanges.push(wrap(rig.current.yaw - previousYaw));
      previousYaw = rig.current.yaw;
      path.push({ x: controller.report.position.x, z: controller.report.position.z });
    }

    // ─── 1. THE YAW SETTLES ────────────────────────────────────────────────────────────
    // Over the final second the yaw should barely move. A diverging loop, or two systems chasing
    // each other, would keep this large.
    const tail = yawChanges.slice(-60);
    const tailMotion = tail.reduce((sum, change) => sum + Math.abs(change), 0);
    expect(tailMotion).toBeLessThan(0.25);

    // ─── 2. IT CONVERGED RATHER THAN OSCILLATED ────────────────────────────────────────
    // Sign changes in the tail mean the loop is hunting: the camera correcting, overshooting, and
    // correcting back, which reads on screen as a view that shivers.
    let signChanges = 0;
    for (let i = 1; i < tail.length; i++) {
      if (Math.sign(tail[i]) !== Math.sign(tail[i - 1]) && Math.abs(tail[i]) > 1e-4) signChanges++;
    }
    expect(signChanges).toBeLessThanOrEqual(2);

    // ─── 3. THE PATH IS STRAIGHT, NOT A CIRCLE ─────────────────────────────────────────
    // The visible symptom of a diverging loop: the player holds forward and walks in a slow circle
    // without touching the camera. Measured as the deviation of the settled path from its own
    // chord, so the assertion does not depend on which direction the character happens to face.
    const tailPath = path.slice(-90);
    const start = tailPath[0];
    const end = tailPath[tailPath.length - 1];
    const travel = Math.hypot(end.x - start.x, end.z - start.z);

    // Sanity: the character really did move, or "straight" would be trivially true.
    expect(travel).toBeGreaterThan(1);

    const chordX = (end.x - start.x) / travel;
    const chordZ = (end.z - start.z) / travel;

    let maximumDeviation = 0;
    for (const point of tailPath) {
      const offsetX = point.x - start.x;
      const offsetZ = point.z - start.z;
      // Perpendicular distance from the chord.
      const deviation = Math.abs(offsetX * -chordZ + offsetZ * chordX);
      maximumDeviation = Math.max(maximumDeviation, deviation);
    }

    // Walking at 2 m/s for 1.5 s covers 3 m. A circle tight enough to be visible deviates by tens
    // of centimetres; a settled loop deviates by less than a hand's width.
    expect(maximumDeviation).toBeLessThan(0.25);
  });

  it('does NOT auto-rotate while the player is steering the camera', () => {
    // The gate that stops the loop from engaging during play at all: auto-rotation waits for the
    // player to stop touching the camera. Without it, a player who turns the camera and holds
    // forward would feel the view dragged back under them, curving their path — the
    // most-complained-about third-person camera behaviour there is.
    const physics = createWorld();
    const { controller, rig } = createSettled(physics);

    dom.keyDown('KeyW');
    dom.lockPointer();

    // Hold forward *and* keep the camera turning, every single tick, for four seconds.
    let previousYaw = rig.current.yaw;
    let totalRotation = 0;

    for (let i = 0; i < 240; i++) {
      dom.mouseMove(4, 0);
      tick(controller, rig, physics);

      totalRotation += wrap(rig.current.yaw - previousYaw);
      previousYaw = rig.current.yaw;
    }

    // Every radian of rotation must be one the player asked for. Auto-rotation contributing at all
    // would show as extra rotation beyond the mouse input — and since the camera's idle timer is
    // reset by that very input, the gate and the gesture cannot disagree.
    const requestedFromMouse = 240 * 4 * INPUT_LOOK_SENSITIVITY;
    expect(totalRotation).toBeCloseTo(requestedFromMouse, 1);
  });

  it('holds the character on a stable heading while the camera is untouched', () => {
    // The complement of the first test, stated as the player would experience it: with the camera
    // off-axis and forward held, the character must end up travelling in the camera's forward
    // direction permanently, with the camera behind it. That is the fixed point, described in the
    // terms the GDD uses ("auto-rotate aligns behind the player's facing").
    const physics = createWorld();
    const { controller, rig } = createSettled(physics);

    rig.snapTo(controller.report.position, controller.report.facingAngle + 1.0);
    for (let i = 0; i < 30; i++) tick(controller, rig, physics);

    dom.keyDown('KeyW');
    for (let i = 0; i < 300; i++) tick(controller, rig, physics);

    // The camera has ended up behind the character: its yaw and the character's facing agree.
    const gap = Math.abs(wrap(rig.current.yaw - controller.report.facingAngle));
    expect(gap).toBeLessThan(0.1);

    // And the character is walking in the direction the camera faces.
    const velocity = controller.currentVelocity;
    const heading = Math.atan2(velocity.x, velocity.z);
    expect(Math.abs(wrap(heading - rig.current.yaw))).toBeLessThan(0.2);
  });
});
