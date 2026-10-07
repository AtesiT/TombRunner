/**
 * Integration test: the input→transform latency budget.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * DISCHARGING A PHASE 0 COMMITMENT
 * ────────────────────────────────────────────────────────────────────────────────
 * `RISK_ANALYSIS.md` R6 commits to "**≤ 1 tick (16.7 ms) from input event to visible displacement,
 * asserted in an integration test** that measures input→transform-lag over a scripted input
 * sequence".
 *
 * That is a strong claim and it is worth being precise about what it means, because the sloppy
 * version of it is unfalsifiable. "1 tick" counts from the moment the simulation *could* have known
 * about the press — that is, from the tick boundary at which the event became visible to the
 * system — to the tick at which the character's position has moved. If it counted from the wall
 * clock, the answer would depend on how long before a tick the player happened to click, which is
 * a property of their reflexes rather than of the game.
 *
 * So the measurement is in ticks, and it is taken end to end: real `InputSystem`, real
 * `CharacterController`, real Rapier world, real fixed timestep. Nothing is mocked except the
 * browser's event plumbing, and the assertions are about where the character ended up.
 */

import { describe, it, expect, beforeAll, afterEach, beforeEach } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../../src/physics/PhysicsWorld';
import { CollisionLayer } from '../../src/physics/Layers';
import { CharacterController } from '../../src/gameplay/CharacterController';
import { InputSystem } from '../../src/input/InputSystem';
import { FakeDom } from '../support/fake-dom';
import { FIXED_DT } from '../../src/core/constants';

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

describe('input to transform, end to end', () => {
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
    // The priming tick adopts no edges by design, so it is done here rather than inside each test.
    input.beginTick(0);
  });

  afterEach(() => {
    input.dispose();
    dom.uninstall();
  });

  /**
   * Run one fixed tick, exactly as `Game.simulateTick` does.
   *
   * The order matters and matches the real loop: the controller consumes the intent, the world
   * steps, and only then is the resulting position read.
   */
  function tick(controller: CharacterController, physics: PhysicsWorld): void {
    const snapshot = input.beginTick(0);
    controller.update(FIXED_DT, snapshot.intent);
    physics.step();
  }

  it('moves the character on the very next tick after a movement press', () => {
    // ─── THE BUDGET ─────────────────────────────────────────────────────────────────────
    // A key pressed between two ticks must displace the character on the *first* tick that can see
    // it. Not the second, and not "within a couple of frames" — one tick, because a second tick of
    // delay is a frame of visible unresponsiveness that players describe as "heavy".
    const physics = createWorld();
    const controller = new CharacterController(physics, { x: 0, y: 1, z: 0 });
    physics.step();
    for (let i = 0; i < 90; i++) tick(controller, physics);

    const before = { ...controller.report.position };

    // The press arrives strictly between two ticks, which is the case the latch exists for.
    dom.keyDown('KeyW');

    tick(controller, physics);

    const after = controller.report.position;
    const moved = Math.hypot(after.x - before.x, after.z - before.z);

    // Walking is 2 m/s, so one tick is 3.3 cm — and the acceleration ramp means the first tick
    // moves a fraction of that. Any positive movement proves the intent arrived on this tick.
    expect(moved).toBeGreaterThan(0);
    expect(after.z - before.z).toBeGreaterThan(0);
  });

  it('starts a jump on the next tick after the press', () => {
    const physics = createWorld();
    const controller = new CharacterController(physics, { x: 0, y: 1, z: 0 });
    physics.step();
    for (let i = 0; i < 90; i++) tick(controller, physics);

    const groundedBefore = controller.report.grounded;
    expect(groundedBefore).toBe(true);

    dom.keyDown('Space');
    tick(controller, physics);

    // Vertical velocity is applied on the same tick the press is seen, so the character is already
    // rising — not still grounded waiting for the next tick's buffer check.
    expect(controller.report.velocity.y).toBeGreaterThan(0);
    expect(controller.lastEvents.jumped).toBe(true);
  });

  it('measures event-to-tick latency and finds it within one tick for a scripted sequence', () => {
    // The instrumented version of the budget: R10.4 requires the overlay to *report* this, so the
    // measurement itself is tested rather than assumed.
    const physics = createWorld();
    const controller = new CharacterController(physics, { x: 0, y: 1, z: 0 });
    physics.step();
    for (let i = 0; i < 60; i++) tick(controller, physics);

    const samples: number[] = [];

    // A scripted sequence: press, tick, release, tick — repeated, so the measurement is not a
    // single lucky frame.
    for (let i = 0; i < 20; i++) {
      dom.keyDown('Space');
      tick(controller, physics);

      const sample = input.consumeLatencySample();
      if (sample) samples.push(sample.eventToTickMs);

      dom.keyUp('Space');
      tick(controller, physics);
      // Let the jump land before the next press, so each sample is a fresh takeoff.
      for (let settle = 0; settle < 60; settle++) tick(controller, physics);
    }

    expect(samples.length).toBeGreaterThan(10);

    // In this harness an event is fired and the tick runs immediately afterwards, so the measured
    // latency is the time for one dispatch — effectively zero. The *meaningful* assertion is the
    // one above: the transform moved on the same tick. What this adds is that the instrument
    // works and cannot silently report a number that is not a number.
    for (const sample of samples) {
      expect(Number.isFinite(sample)).toBe(true);
      expect(sample).toBeGreaterThanOrEqual(0);
      // A measurement larger than a tick would mean the event was not acted on when it arrived,
      // which is exactly the regression the budget exists to catch.
      expect(sample).toBeLessThan(1000 * FIXED_DT);
    }
  });

  it('does not drop a press that arrives and is released between two ticks', () => {
    // Reaching the input layer is not enough — the press has to survive all the way to a jump.
    // This is the whole chain: event → latch → intent → controller buffer → takeoff.
    const physics = createWorld();
    const controller = new CharacterController(physics, { x: 0, y: 1, z: 0 });
    physics.step();
    for (let i = 0; i < 90; i++) tick(controller, physics);

    // A 30 ms tap, entirely inside one tick.
    dom.keyDown('Space');
    dom.keyUp('Space');

    tick(controller, physics);

    // The jump fires. If the input layer had sampled held state instead of latching, this would
    // have been silently discarded and the player would experience it as "sometimes jump does not
    // work" — the single most damaging intermittent bug a platformer can have.
    expect(controller.lastEvents.jumped).toBe(true);
  });

  it('applies look input on the same tick it is consumed', () => {
    // The camera is driven by the same snapshot, so a look delta must be available immediately
    // rather than one tick behind the movement it accompanies.
    dom.lockPointer();
    dom.mouseMove(50, 0);

    const snapshot = input.beginTick(0);
    expect(snapshot.look.yawDelta).toBeGreaterThan(0);

    // And it is not offered again: a delta delivered twice would rotate the camera double on
    // every fast flick.
    expect(input.beginTick(0).look.yawDelta).toBe(0);
  });

  it('runs a second identical script to the same result, tick for tick', () => {
    // Determinism at the integration level. If the input layer were applying anything asynchronously
    // — a timer, a promise, an event queue drained outside the tick — two identical runs would
    // diverge, and that divergence would be invisible in every unit test.
    const script = (): number[] => {
      const physics = createWorld();
      const controller = new CharacterController(physics, { x: 0, y: 1, z: 0 });
      physics.step();

      const trace: number[] = [];
      for (let i = 0; i < 120; i++) {
        if (i === 10) dom.keyDown('KeyW');
        if (i === 40) dom.keyDown('ShiftLeft');
        if (i === 60) dom.keyDown('Space');
        if (i === 70) dom.keyUp('Space');
        if (i === 90) dom.keyUp('KeyW');
        tick(controller, physics);
        trace.push(controller.report.position.z);
      }
      return trace;
    };

    const first = script();
    // The system must be reset between runs, or the second script starts with keys already held.
    input.dispose();
    dom.uninstall();

    dom = new FakeDom();
    const { target, canvas } = dom.install();
    input = new InputSystem(target, canvas, null);
    input.beginTick(0);

    const second = script();

    expect(second).toHaveLength(first.length);
    for (let i = 0; i < first.length; i++) {
      expect(second[i], `tick ${i}`).toBeCloseTo(first[i], 9);
    }

    // The script must actually have moved the character, or determinism would be trivially true.
    expect(Math.abs(first[first.length - 1] - first[0])).toBeGreaterThan(1);
  });
});
