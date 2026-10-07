/**
 * CHARACTERISATION REGRESSION TESTS — Rapier kinematic character controller.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ────────────────────────────────────────────────────────────────────────────────
 * During Phase 0 I discovered (docs/ARCHITECTURE.md §4.2, E1) that a
 * KinematicCharacterController is **permanently and silently corrupted** if its
 * first `computeColliderMovement()` call happens before the world has ever been
 * stepped. After that single bad call, geometry collision is ignored for the
 * lifetime of the controller, while `computedGrounded()` continues to return
 * plausible-looking values. The capsule ends up in free-fall beneath the level.
 *
 * Critically, my FIRST explanation of this bug was wrong, and it reached the
 * architecture document before these tests caught it. Bisection (E1b) proved that
 * the collider offset, the controller's creation order, `setUp()` and
 * `enableSnapToGround` are all IRRELEVANT — only the missing world step matters.
 *
 * These tests therefore pin the *observed behaviour of the engine* rather than
 * asserting what the documentation claims. They exist so that risk R14 ("player
 * falls through the floor") — and the whole Q1 entry in the DEV_LOG's Known Engine
 * Quirks register — fails loudly in CI if a Rapier upgrade changes this contract.
 *
 * They are written against the raw Rapier API, deliberately NOT against our own
 * CharacterController wrapper, so they can detect a regression in the engine seam
 * independently of the abstraction built on top of it.
 *
 * Sources: docs/ARCHITECTURE.md §4.2 (E1–E2c, E12), docs/RISK_ANALYSIS.md R14,
 *          docs/DEV_LOG.md "Known Engine Quirks" Q1–Q5.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';

/** Physics tick rate. Must match FIXED_DT in src/core/constants.ts once it exists. */
const FIXED_DT = 1 / 60;

/** Player proxy capsule: half-height 0.6 m + radius 0.35 m. */
const CAPSULE_HALF_HEIGHT = 0.6;
const CAPSULE_RADIUS = 0.35;

/** Controller offset — the small skin width the controller keeps above surfaces. */
const CONTROLLER_OFFSET = 0.02;

/**
 * Resting height of the body origin on flat ground at y = 0.
 *
 * NOTE: the measured value is 0.9701, i.e. half-height + radius + the controller's
 * own offset. Getting this wrong by exactly the offset is what made the first
 * version of these tests fail — worth stating explicitly, because assuming a resting
 * height that ignores the controller offset would also corrupt the camera's ground
 * clamp and the foot-IK targets in Milestone 1.2.
 */
const EXPECTED_RESTING_Y = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS + CONTROLLER_OFFSET; // 0.97

/** Tolerance for a *correct* rest. Measured drift over 1800 ticks is 4.5e-8 m, so this is generous. */
const RESTING_TOLERANCE = 0.01;

/** Tolerance used to classify a result as clearly-corrupted (sunk well below the correct rest). */
const CORRUPTION_TOLERANCE = 0.1;

const GRAVITY = -9.81;

interface Harness {
  world: RAPIER.World;
  controller: RAPIER.KinematicCharacterController;
  collider: RAPIER.ColliderDesc | RAPIER.Collider;
  body: RAPIER.RigidBody;
}

/**
 * Build a minimal test world: a ground slab whose top surface is exactly at y = 0,
 * plus one kinematic capsule starting at `startY`.
 *
 * @param options.warmUp - When true, performs the prime `world.step()` that E1b
 *   proved is required. When false, reproduces the corrupting configuration.
 * @param options.snapToGround - Enables Rapier ground snapping. E1b proved this is
 *   irrelevant to the corruption; it is exposed here so the test can assert that
 *   irrelevance rather than merely claim it.
 * @param options.offset - Controller offset. Also exposed to assert irrelevance.
 * @param options.controllerFirst - Creates the controller before the colliders
 *   exist. The third variable proven irrelevant by bisection.
 * @param options.startY - Initial capsule height above the ground.
 * @returns The constructed harness.
 */
function buildHarness(options: {
  warmUp: boolean;
  snapToGround?: boolean;
  offset?: number;
  controllerFirst?: boolean;
  startY?: number;
}): Harness {
  const {
    warmUp,
    snapToGround = true,
    offset = CONTROLLER_OFFSET,
    controllerFirst = false,
    startY = 1,
  } = options;

  const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });

  // The controller may be created before the geometry; E1b proved this is harmless.
  const earlyController = controllerFirst ? world.createCharacterController(offset) : undefined;

  // Ground slab: 100 x 100 m, top surface exactly at y = 0.
  const groundBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50), groundBody);

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, startY, 0),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.capsule(CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS),
    body,
  );

  const controller = earlyController ?? world.createCharacterController(offset);
  controller.setUp({ x: 0, y: 1, z: 0 });
  if (snapToGround) {
    controller.enableSnapToGround(0.4);
  }

  // THE PRIME STEP. This single line is the difference between a working game and a
  // permanently broken one. See Q1 in docs/DEV_LOG.md.
  if (warmUp) {
    world.step();
  }

  return { world, controller, collider: collider as unknown as RAPIER.Collider, body };
}

/**
 * Apply one movement request through the controller and commit the result.
 *
 * @param h - The harness to advance.
 * @param requestedY - The requested vertical movement in metres.
 * @returns The controller's reported grounded state *before* the step was applied.
 */
function applyMovement(h: Harness, requestedY: number): boolean {
  h.controller.computeColliderMovement(h.collider as RAPIER.Collider, {
    x: 0,
    y: requestedY,
    z: 0,
  });
  const movement = h.controller.computedMovement();
  const wasGrounded = h.controller.computedGrounded();

  const position = h.body.translation();
  h.body.setNextKinematicTranslation({
    x: position.x + movement.x,
    y: position.y + movement.y,
    z: position.z + movement.z,
  });
  h.world.step();

  return wasGrounded;
}

/**
 * Run a gravity-driven character simulation, which is the shipped integration loop.
 *
 * @param h - The harness to advance.
 * @param ticks - Number of fixed ticks.
 * @param initialVelocityY - Starting vertical velocity (default 0).
 * @returns The final body position and the final grounded flag.
 */
function simulateGravity(
  h: Harness,
  ticks: number,
  initialVelocityY = 0,
): { finalY: number; grounded: boolean } {
  let verticalVelocity = initialVelocityY;

  for (let i = 0; i < ticks; i++) {
    verticalVelocity = Math.max(verticalVelocity + GRAVITY * FIXED_DT, -40);
    const grounded = applyMovement(h, verticalVelocity * FIXED_DT);
    if (grounded) {
      verticalVelocity = 0;
    }
  }

  return {
    finalY: h.body.translation().y,
    grounded: h.controller.computedGrounded(),
  };
}

/** Assert that a final Y value represents a correctly grounded capsule. */
function expectRestsOnGround(finalY: number): void {
  expect(finalY).toBeGreaterThan(EXPECTED_RESTING_Y - RESTING_TOLERANCE);
  expect(finalY).toBeLessThan(EXPECTED_RESTING_Y + RESTING_TOLERANCE);
}

describe('E1/Q1 — the prime-step contract (risk R14)', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it('E1: settles sunk into the floor when the first query precedes any world step', () => {
    // A 0.1 m first movement is used because E1c established that magnitudes below
    // ~0.04 m do NOT trigger the corruption.
    //
    // Observed behaviour with subsequent gravity-sized movements: the capsule does
    // not free-fall; it comes to a stable but WRONG rest, sunk roughly 0.18 m below
    // the correct height. This is arguably more dangerous than an obvious fall --
    // the player is slightly inside the floor, which reads as a visual glitch or a
    // collision oddity rather than as a physics failure.
    const harness = buildHarness({ warmUp: false });
    applyMovement(harness, -0.1);
    const { finalY } = simulateGravity(harness, 60);

    expect(Math.abs(finalY - EXPECTED_RESTING_Y)).toBeGreaterThan(CORRUPTION_TOLERANCE);
    expect(finalY).toBeLessThan(EXPECTED_RESTING_Y);
    harness.world.free();
  });

  it('E1 (sustained): falls completely out of the world under continuous large movement', () => {
    // The same corruption, driven harder: when every tick requests a movement larger
    // than the corrupted controller's (wrong) penetration recovery, nothing stops it.
    // This is the y = -3.56 result from the original Phase 0 experiment.
    const harness = buildHarness({ warmUp: false });

    for (let i = 0; i < 60; i++) {
      applyMovement(harness, -0.1);
    }

    expect(harness.body.translation().y).toBeLessThan(-3);
    harness.world.free();
  });

  it('Q2: computedGrounded() can report true while the capsule is below the floor', () => {
    // This is why `computedGrounded()` may only be a cross-check, never the source
    // of truth for ground state. The 5-ray cone probe in GDD §4.4 supplies it.
    const harness = buildHarness({ warmUp: false });
    applyMovement(harness, -0.1);

    let sawGroundedBelowFloor = false;
    for (let i = 0; i < 60; i++) {
      const grounded = applyMovement(harness, -0.1);
      const y = harness.body.translation().y;
      // Below the ground surface (y < 0) yet still claiming to be grounded.
      if (grounded && y < 0) {
        sawGroundedBelowFloor = true;
      }
    }

    expect(sawGroundedBelowFloor).toBe(true);
    harness.world.free();
  });

  it('E1d: the corruption is PERMANENT — 300 correct ticks do not recover it', () => {
    // Observed: y = -28.52 after one corrupting call followed by 300 otherwise
    // flawless ticks. There is no self-healing path, which is what justifies the
    // boot assertion in the architecture's frame loop.
    const harness = buildHarness({ warmUp: false });
    applyMovement(harness, -0.1); // the single corrupting call

    for (let i = 0; i < 300; i++) {
      applyMovement(harness, -0.1);
    }

    expect(harness.body.translation().y).toBeLessThan(-20);
    harness.world.free();
  });

  it('E1b: NO other configuration variable causes the corruption', () => {
    // Bisection proof: offset, creation order, setUp() and snap-to-ground were all
    // shown irrelevant. Any of these sinking would indicate the contract changed and
    // that our documentation's reasoning is stale.
    const variants: Array<[string, ReturnType<typeof buildHarness>]> = [
      ['offset 0.01', buildHarness({ warmUp: true, offset: 0.01 })],
      ['offset 0.05', buildHarness({ warmUp: true, offset: 0.05 })],
      ['controller created first', buildHarness({ warmUp: true, controllerFirst: true })],
      ['snap-to-ground disabled', buildHarness({ warmUp: true, snapToGround: false })],
    ];

    for (const [label, harness] of variants) {
      const { finalY } = simulateGravity(harness, 200);
      expect(finalY, `variant "${label}" should rest on the ground`).toBeGreaterThan(0.9);
      expect(finalY, `variant "${label}" should rest on the ground`).toBeLessThan(1.5);
      harness.world.free();
    }
  });
});

describe('E1c — the magnitude threshold that makes Q1 latent', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it.each([0.003, 0.01, 0.02, 0.03])(
    'stays stable with an un-primed first movement of %s m (below threshold)',
    (magnitude) => {
      // Gravity's first tick at 60 Hz is 0.0027 m, which is why a normal boot
      // accidentally works and the bug can ship undetected.
      const harness = buildHarness({ warmUp: false });
      applyMovement(harness, -magnitude);
      const { finalY } = simulateGravity(harness, 400);
      expectRestsOnGround(finalY);
      harness.world.free();
    },
  );

  // Measured settlements for these magnitudes: 0.8096 and (higher) sunk values,
  // versus the correct 0.9701. The sink depth varies with the trigger magnitude,
  // which is itself worth knowing: there is no single "wrong resting height" to
  // pattern-match against, so the assertion must be a tolerance, not an equality.
  it.each([0.08, 0.2, 0.5])(
    'breaks with an un-primed first movement of %s m (above threshold)',
    (magnitude) => {
      const harness = buildHarness({ warmUp: false });
      applyMovement(harness, -magnitude);
      const { finalY } = simulateGravity(harness, 400);
      expect(Math.abs(finalY - EXPECTED_RESTING_Y)).toBeGreaterThan(CORRUPTION_TOLERANCE);
      harness.world.free();
    },
  );
});

describe('E1f/E2 — the prime step is sufficient and the loop is long-run stable', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it.each([0.1, 0.5, 2.0])(
    'fully protects against a pathological %s m first movement when primed',
    (magnitude) => {
      const harness = buildHarness({ warmUp: true });
      applyMovement(harness, -magnitude);
      const { finalY } = simulateGravity(harness, 400);
      expectRestsOnGround(finalY);
      harness.world.free();
    },
  );

  it('E1e: recovers from any single hitch-sized movement once primed', () => {
    for (const hitch of [0.3, 0.5, 1.0, 3.0]) {
      const harness = buildHarness({ warmUp: true });
      simulateGravity(harness, 120); // land normally first
      applyMovement(harness, -hitch); // one abnormal downward tick
      const { finalY } = simulateGravity(harness, 400);

      expect(finalY, `should recover from a ${hitch} m hitch`).toBeGreaterThan(
        EXPECTED_RESTING_Y - RESTING_TOLERANCE,
      );
      expect(finalY, `should recover from a ${hitch} m hitch`).toBeLessThan(
        EXPECTED_RESTING_Y + RESTING_TOLERANCE,
      );
      harness.world.free();
    }
  });

  it('E2: holds position for 600 ticks (10 s) with zero drift', () => {
    const harness = buildHarness({ warmUp: true });
    const { finalY, grounded } = simulateGravity(harness, 600);

    expect(grounded).toBe(true);
    expectRestsOnGround(finalY);
    harness.world.free();
  });

  it('E2b: cumulative drift stays negligible across 1800 ticks (30 s)', () => {
    // A slow monotonic drift would be invisible in a short test and would manifest
    // as a player gradually sinking through floors late in a 45-60 minute session.
    const harness = buildHarness({ warmUp: true });
    const afterTenSeconds = simulateGravity(harness, 600).finalY;
    const afterTwentySeconds = simulateGravity(harness, 600).finalY;
    const afterThirtySeconds = simulateGravity(harness, 600).finalY;

    expect(Math.abs(afterTwentySeconds - afterTenSeconds)).toBeLessThan(CONTROLLER_OFFSET);
    expect(Math.abs(afterThirtySeconds - afterTwentySeconds)).toBeLessThan(CONTROLLER_OFFSET);
    expectRestsOnGround(afterThirtySeconds);
    harness.world.free();
  });

  it('E2c: snap-to-ground suppresses idle jitter but is not required for stability', () => {
    const withSnap = buildHarness({ warmUp: true, snapToGround: true });
    const withoutSnap = buildHarness({ warmUp: true, snapToGround: false });

    simulateGravity(withSnap, 120);
    simulateGravity(withoutSnap, 120);

    // Both configurations are stable — snap-to-ground is a feel setting (Q4), not a
    // correctness fix. This assertion guards against the false claim I originally
    // published in the architecture document.
    expectRestsOnGround(withSnap.body.translation().y);
    expectRestsOnGround(withoutSnap.body.translation().y);

    withSnap.world.free();
    withoutSnap.world.free();
  });
});

describe('E12/Q3 — capsule characters can stand on one another', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it('a second character spawned above the first comes to rest on its head', () => {
    const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(50, 0.5, 50),
      world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0)),
    );
    world.step(); // primed

    const makeCharacter = (startY: number): Harness => {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, startY, 0),
      );
      const collider = world.createCollider(
        RAPIER.ColliderDesc.capsule(CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS),
        body,
      );
      const controller = world.createCharacterController(CONTROLLER_OFFSET);
      controller.setUp({ x: 0, y: 1, z: 0 });
      controller.enableSnapToGround(0.4);
      return { world, controller, collider: collider as unknown as RAPIER.Collider, body };
    };

    const lower = makeCharacter(1);
    simulateGravity(lower, 200);
    expectRestsOnGround(lower.body.translation().y);

    // Spawn directly above the lower character.
    const upper = makeCharacter(5);
    simulateGravity(upper, 400);

    // Two stacked capsules: the upper one rests on the lower one's head.
    const stackedY = EXPECTED_RESTING_Y + (CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS) * 2;
    expect(upper.body.translation().y).toBeGreaterThan(stackedY - 0.1);
    expect(upper.body.translation().y).toBeLessThan(stackedY + 0.1);

    // This is why the GDD requires an explicit non-standable-character rule in BOTH
    // directions: an enemy standing on the player's head is otherwise a permanent,
    // absurd position that the engine will happily maintain forever.
    world.free();
  });
});
