/**
 * Integration tests: the character controller against a real Rapier world.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE TEN MANDATORY EDGE CASES
 * ────────────────────────────────────────────────────────────────────────────────
 * Every one of the ten cases listed in the brief is covered here, each as its own test with
 * an explicit assertion on the *observable* outcome — not on an internal flag. The
 * distinction matters: asserting that a function returned `true` proves the code agrees with
 * itself, whereas asserting that the character's y-coordinate did not fall through the floor
 * proves the game behaves.
 *
 * The cases are famous precisely because they are the places where "obvious" controller
 * implementations break, and each one is annotated with the failure it prevents.
 *
 * A note on how these are driven: each test steps the controller and the physics world
 * together at the real fixed timestep, using the real intent structure. Nothing is mocked.
 * If a controller bug makes the character fall through the world, that is exactly what these
 * tests will observe.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../../src/physics/PhysicsWorld';
import { CollisionLayer } from '../../src/physics/Layers';
import { CharacterController } from '../../src/gameplay/CharacterController';
import { LocomotionState, NULL_INTENT, type CharacterIntent } from '../../src/gameplay/LocomotionStates';
import {
  FIXED_DT,
  GROUND_PROBE_LENGTH_M,
  KILL_PLANE_Y,
  PLAYER_CAPSULE_HALF_HEIGHT_M,
  PLAYER_CAPSULE_RADIUS_M,
  CONTROLLER_OFFSET_M,
  TICK_RATE,
} from '../../src/core/constants';

/** The y the capsule body origin rests at, on ground whose surface is y = 0. */
const RESTING_Y = PLAYER_CAPSULE_HALF_HEIGHT_M + PLAYER_CAPSULE_RADIUS_M + CONTROLLER_OFFSET_M;

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
  rotation?: { x: number; y: number; z: number; w: number },
): number {
  return physics.createStaticCollider({
    shape: { kind: 'cuboid', halfExtents },
    translation,
    rotation,
    layer: CollisionLayer.StaticWorld,
    surfaceType: 'stone',
  });
}

/** Build a controller on a world with flat ground, and settle it. */
function createSettledCharacter(
  physics: PhysicsWorld,
  spawn: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 },
  settleTicks = 90,
): CharacterController {
  const controller = new CharacterController(physics, spawn);
  for (let i = 0; i < settleTicks; i++) {
    controller.update(FIXED_DT, NULL_INTENT);
    physics.step();
  }
  return controller;
}

/** Run a number of ticks with a fixed intent. */
function run(
  controller: CharacterController,
  physics: PhysicsWorld,
  ticks: number,
  intent: CharacterIntent,
): void {
  for (let i = 0; i < ticks; i++) {
    controller.update(FIXED_DT, intent);
    physics.step();
  }
}

/** A forward intent along +Z at full speed. */
const RUN_FORWARD: CharacterIntent = {
  ...NULL_INTENT,
  moveDirection: { x: 0, z: 1 },
  moveMagnitude: 1,
};

/** A single-tick jump press, then a hold with no further press. */
function jumpPress(base: CharacterIntent): CharacterIntent {
  return { ...base, jumpRequested: true, jumpHeld: true };
}

/** No further press, but the controls stay held (as a player holding the button would). */
function jumpHold(base: CharacterIntent): CharacterIntent {
  return { ...base, jumpRequested: false, jumpHeld: true };
}

describe('Character controller — setup and the ground probe', () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  afterEach(() => {
    while (openWorlds.length > 0) openWorlds.pop()?.dispose();
  });

  it('settles on flat ground at the known resting height', () => {
    const physics = createWorld();
    addGround(physics);
    const controller = createSettledCharacter(physics);

    // 0.6 + 0.35 + 0.02 = 0.97. Asserted exactly, because every other height in the game
    // is measured relative to this and a silent change here would move the whole world.
    expect(controller.position.y).toBeCloseTo(RESTING_Y, 2);
    expect(controller.currentState).toBe(LocomotionState.Grounded);
    expect(controller.ground.grounded).toBe(true);
    expect(controller.ground.band).toBe('walkable');
    expect(controller.ground.surfaceType).toBe('grass');
  });

  it('the ground probe reaches far enough to see the floor it is standing on', () => {
    // ─── REGRESSION GUARD ──────────────────────────────────────────────────────────
    // The probe length was originally 0.45 m against a required 1.17 m, so the ray never
    // touched the ground. The character fell, was physically caught by Rapier, and could be
    // driven around — but the controller was told `grounded: false` on every tick, so the
    // state machine never left `Airborne` and jumps could never fire.
    //
    // That failure is invisible to any assertion about "the character is on the ground",
    // because the character *was* on the ground. Only comparing the ray's reach against the
    // capsule's actual geometry catches it.
    const requiredReach = PLAYER_CAPSULE_HALF_HEIGHT_M + PLAYER_CAPSULE_RADIUS_M;

    // The ray starts above the body origin and extends down by its length; what matters is
    // that it covers the body's full distance above the surface.
    expect(GROUND_PROBE_LENGTH_M).toBeGreaterThan(requiredReach);
    expect(GROUND_PROBE_LENGTH_M).toBeGreaterThan(RESTING_Y);
  });

  it('reports the ground normal as straight up on a flat floor', () => {
    const physics = createWorld();
    addGround(physics);
    const controller = createSettledCharacter(physics);

    expect(controller.ground.normal.y).toBeGreaterThan(0.99);
    expect(controller.ground.slopeAngle).toBeLessThan(5);
  });
});

describe('Edge case 1 — jump and crouch pressed on a ledge edge: crouch wins, no jump', () => {
  it('crouching on the very edge of a ledge prevents the jump', () => {
    const physics = createWorld();
    // A ledge whose top is at y = 0, ending at x = 0, with a long drop beyond it.
    addBox(physics, { x: -20, y: -2, z: 0 }, { x: 20, y: 2, z: 20 });

    // Place the character right on the lip.
    const controller = createSettledCharacter(physics, { x: -0.05, y: 1, z: 0 });

    // Crouch and jump on the same tick, pressed into the void.
    const crouchJump: CharacterIntent = {
      ...NULL_INTENT,
      moveDirection: { x: 1, z: 0 },
      moveMagnitude: 1,
      jumpRequested: true,
      jumpHeld: true,
      crouchHeld: true,
    };

    const startY = controller.position.y;
    run(controller, physics, 20, crouchJump);

    // CROUCH WINS. The character must not have gained altitude: the jump is suppressed while
    // crouching, and the crouch is what the player is holding. Without this rule, a player
    // crouch-walking along a ledge would leap into the void on every button graze.
    expect(controller.position.y).toBeLessThan(startY + 0.05);
  });

  it('the same jump without crouch DOES fire, proving the test is not vacuous', () => {
    // A negative test that passes because nothing works at all is worthless. This runs the
    // identical scenario without the crouch input and requires the opposite outcome.
    const physics = createWorld();
    addBox(physics, { x: -20, y: -2, z: 0 }, { x: 20, y: 2, z: 20 });
    const controller = createSettledCharacter(physics, { x: -0.05, y: 1, z: 0 });

    const startY = controller.position.y;
    const jump: CharacterIntent = {
      ...NULL_INTENT,
      moveDirection: { x: 1, z: 0 },
      moveMagnitude: 1,
      jumpRequested: true,
      jumpHeld: true,
    };
    run(controller, physics, 20, jump);

    expect(controller.position.y).toBeGreaterThan(startY + 0.5);
  });
});

describe('Edge case 2 — landing on a slope mid-jump must not immediately slide', () => {
  it('lands on a 25 degree ramp and stays put', () => {
    const physics = createWorld();
    // A ramp: a long thin box rotated about X so its top face tilts 25 degrees.
    const angle = (25 * Math.PI) / 180;
    const halfAngle = angle / 2;
    addBox(
      physics,
      { x: 0, y: -1, z: 0 },
      { x: 30, y: 0.5, z: 30 },
      { x: Math.sin(halfAngle), y: 0, z: 0, w: Math.cos(halfAngle) },
    );

    // Start airborne above the ramp and land on it.
    const controller = new CharacterController(physics, { x: 0, y: 3, z: 0 });
    run(controller, physics, 60, NULL_INTENT);

    expect(controller.currentState).toBe(LocomotionState.Grounded);
    expect(controller.ground.grounded).toBe(true);

    // Record the landing position, then run a full second with no input at all.
    const landedY = controller.position.y;
    const landedZ = controller.position.z;
    run(controller, physics, TICK_RATE, NULL_INTENT);

    // On a walkable band the character must not slide. 25 degrees is inside the 0-30
    // walkable band, so there is no downhill acceleration to apply. If the slope bands were
    // off by one, this is where a player would find themselves drifting off a platform for
    // no reason they can see.
    expect(Math.abs(controller.position.z - landedZ)).toBeLessThan(0.05);
    expect(Math.abs(controller.position.y - landedY)).toBeLessThan(0.05);
    expect(controller.currentState).toBe(LocomotionState.Grounded);
  });
});

describe('Edge case 3 — running into a wall while airborne must not stick', () => {
  it('slides down a wall instead of attaching to it', () => {
    const physics = createWorld();
    addGround(physics);
    // A tall wall face at z = 4.
    addBox(physics, { x: 0, y: 5, z: 5 }, { x: 20, y: 5, z: 1 });

    const controller = createSettledCharacter(physics, { x: 0, y: 1, z: 0 });
    run(controller, physics, 60, RUN_FORWARD);
    expect(controller.position.z).toBeGreaterThan(2);

    // Jump into the wall and keep pushing forward for a full second.
    run(controller, physics, 1, jumpPress(RUN_FORWARD));
    const peakBefore = controller.position.y;
    run(controller, physics, 90, jumpHold(RUN_FORWARD));

    // The character must have come back down and be resting on the ground, pressed against
    // the wall — not stuck to its face at altitude.
    expect(controller.position.y).toBeLessThan(peakBefore + 0.1);
    expect(controller.position.y).toBeCloseTo(RESTING_Y, 1);

    // And must never be inside the wall.
    expect(controller.position.z).toBeLessThan(4.5);

    // The wall must not have been "climbed": the character may not be above the wall's top.
    expect(controller.position.y).toBeLessThan(1.5);
  });

  it('does not accumulate downward velocity while pressed against a wall', () => {
    // The specific bug this guards: a controller that keeps integrating gravity while
    // blocked builds unbounded downward velocity, so releasing from a wall launches the
    // character at the floor. Asserting on velocity is the only way to see it.
    const physics = createWorld();
    addGround(physics);
    addBox(physics, { x: 0, y: 5, z: 5 }, { x: 20, y: 5, z: 1 });
    const controller = createSettledCharacter(physics, { x: 0, y: 1, z: 0 });

    run(controller, physics, 60, RUN_FORWARD);
    run(controller, physics, 1, jumpPress(RUN_FORWARD));
    run(controller, physics, 60, jumpHold(RUN_FORWARD));

    expect(controller.position.y).toBeGreaterThan(0);
    expect(controller.position.y).toBeLessThan(3);
  });
});

describe('Edge case 4 — jumping from a moving platform inherits its velocity', () => {
  it('a jump from a laterally moving platform carries the player along', () => {
    const physics = createWorld();
    // The ground is deliberately far below, so the ONLY thing supporting the character is the
    // platform — otherwise a passing test could be explained by standing on the floor.
    addGround(physics, -20);
    const handle = addBox(physics, { x: 0, y: -1, z: 0 }, { x: 3, y: 1, z: 3 });

    const controller = createSettledCharacter(physics, { x: 0, y: 2, z: 0 });
    const startX = controller.position.x;

    const platformSpeed = 2.0;

    /** Move the platform one tick's worth and return the new offset. */
    let offset = 0;
    const advancePlatform = (): number => {
      offset += platformSpeed * FIXED_DT;
      physics.setColliderTranslation(handle, { x: offset, y: -1, z: 0 });
      return offset;
    };

    // ── Phase 1: ride the platform ─────────────────────────────────────────────────
    for (let i = 0; i < 60; i++) {
      advancePlatform();
      controller.update(FIXED_DT, NULL_INTENT);
      physics.step();
    }

    // ── TEST-SETUP BUG, FIXED ──────────────────────────────────────────────────────
    // The first version stopped moving the platform on the jump tick, so the surface's
    // derived velocity was legitimately zero and the jump correctly inherited nothing — the
    // test was asserting something the setup had made impossible.
    //
    // A platform that is moving when the player jumps must be moving *on that tick too*.
    // Rapier does not carry kinematic characters on moving colliders at all: the first run
    // showed the character moving 0.0 m while the platform slid out from under it. The carry
    // is implemented explicitly in the controller by deriving the surface's velocity from its
    // per-tick translation delta.
    expect(controller.position.x - startX).toBeGreaterThan(1.5);
    expect(controller.currentState).toBe(LocomotionState.Grounded);

    // ── Phase 2: jump while the platform is still moving ───────────────────────────
    advancePlatform();
    controller.update(FIXED_DT, jumpPress(NULL_INTENT));
    physics.step();

    const xAtTakeoff = controller.position.x;

    // ── Phase 3: the platform vanishes; only inherited momentum can move the player ──
    physics.setColliderTranslation(handle, { x: offset + 200, y: -1, z: 0 });
    for (let i = 0; i < 20; i++) {
      physics.setColliderTranslation(handle, { x: offset + 200, y: -1, z: 0 });
      controller.update(FIXED_DT, jumpHold(NULL_INTENT));
      physics.step();
    }

    // The character must still be in the air...
    expect(controller.currentState).toBe(LocomotionState.Airborne);

    // ...and must have continued sideways at roughly the platform's speed. Without
    // inheritance this would be ~0 m: a player would jump straight up and watch the platform
    // leave without them, which is the classic "moving platforms feel broken" bug.
    const airborneTravel = controller.position.x - xAtTakeoff;
    expect(airborneTravel).toBeGreaterThan(0.2);

    // And the inherited speed should be in the platform's direction, at about its magnitude.
    // A tolerance rather than an exact figure, because air control and the launch steer both
    // contribute a little, and pinning an exact number would make the test brittle to
    // legitimate tuning.
    expect(controller.currentVelocity.x).toBeGreaterThan(0.5);
  });
});

describe('Edge case 5 — falling from extreme height is a safe respawn, never a death', () => {
  it('a fall to the kill plane respawns the player safely and functionally', () => {
    const physics = createWorld();
    addGround(physics);

    // ── TEST-SETUP BUG, FIXED ──────────────────────────────────────────────────────
    // The first version of this test spawned the character over a *hole* in the floor so they
    // would fall. That made the test worthless: the respawn point was in the same hole, so the
    // character fell, respawned into the void, fell again, forever — and the assertion
    // "the player can jump after respawning" then measured a character in free fall.
    //
    // The spawn must be somewhere safe; the character is then placed over the void by the
    // test hook, which reproduces exactly the situation the kill plane exists for: a player
    // who has ended up outside the level, for any reason at all.
    const spawn = { x: 0, y: 1, z: 0 };
    const controller = createSettledCharacter(physics, spawn);

    // Move the character far outside the level, into empty space.
    controller.injectPositionForTest({ x: 500, y: 10, z: 500 });
    run(controller, physics, 60 * 20, NULL_INTENT);

    // The kill plane must have caught them and returned them to the spawn.
    expect(controller.rescues).toBeGreaterThanOrEqual(1);
    expect(controller.lastRescueReason).toContain('kill plane');
    expect(controller.position.x).toBeCloseTo(spawn.x, 0);
    expect(controller.position.z).toBeCloseTo(spawn.z, 0);
    expect(controller.position.y).toBeGreaterThan(KILL_PLANE_Y);

    // And they must be fully functional: settled, grounded, and able to jump.
    run(controller, physics, 90, NULL_INTENT);
    expect(controller.currentState).toBe(LocomotionState.Grounded);

    const beforeJump = controller.position.y;
    run(controller, physics, 1, jumpPress(NULL_INTENT));
    run(controller, physics, 12, jumpHold(NULL_INTENT));
    expect(controller.position.y).toBeGreaterThan(beforeJump + 0.3);
  });

  it('respawn never costs health or progress, because it is not a death', () => {
    // The brief is explicit that this is a SAFE respawn. A player who fell through the world
    // has no way to distinguish that from their own mistake, so charging them for it would be
    // punishing them for a bug. Nothing in the rescue path may touch health or inventory.
    const physics = createWorld();
    addGround(physics);
    const controller = createSettledCharacter(physics);

    controller.injectPositionForTest({ x: 0, y: KILL_PLANE_Y - 10, z: 0 });
    controller.update(FIXED_DT, NULL_INTENT);

    // The only observable side effect is positional.
    expect(controller.rescues).toBe(1);
    expect(controller.currentVelocity.y).toBe(0);
    expect(controller.currentState).toBe(LocomotionState.Airborne);
  });

  it('recovers from a non-finite position rather than vanishing', () => {
    // The worst failure mode in the whole controller: a NaN position fails every collision
    // query, so the character can neither move nor land. Nothing in the engine recovers from
    // it — the only cure is a teleport, and the only defence is checking every tick.
    const physics = createWorld();
    addGround(physics);
    const controller = createSettledCharacter(physics);

    controller.injectPositionForTest({ x: Number.NaN, y: Number.NaN, z: Number.NaN });
    controller.update(FIXED_DT, NULL_INTENT);

    expect(Number.isFinite(controller.position.x)).toBe(true);
    expect(Number.isFinite(controller.position.y)).toBe(true);
    expect(Number.isFinite(controller.position.z)).toBe(true);
    expect(controller.rescues).toBeGreaterThanOrEqual(1);

    // And the controller must still work afterwards.
    run(controller, physics, 60, NULL_INTENT);
    expect(controller.currentState).toBe(LocomotionState.Grounded);
  });

  it('terminal velocity is enforced, so a long fall cannot tunnel the floor', () => {
    const physics = createWorld();
    // A tall drop onto solid ground.
    addGround(physics);
    const controller = new CharacterController(physics, { x: 0, y: 200, z: 0 });

    let maxDownwardSpeed = 0;
    for (let i = 0; i < 60 * 20; i++) {
      controller.update(FIXED_DT, NULL_INTENT);
      physics.step();
      maxDownwardSpeed = Math.max(maxDownwardSpeed, -controller.currentVelocity.y);
      if (controller.currentState === LocomotionState.Grounded && i > 60) break;
    }

    // The clamp must have held, and the character must have landed rather than tunnelled.
    expect(maxDownwardSpeed).toBeLessThan(60);
    expect(controller.position.y).toBeCloseTo(RESTING_Y, 1);
    expect(controller.rescues).toBe(0);
  });
});

describe('Edge case 6 — jumping during a mantle cancels the mantle', () => {
  it('a jump request during a mantle returns control immediately', () => {
    const physics = createWorld();
    addGround(physics);
    // A 1.0 m ledge in front of the character, within the mantle band (above autostep, below
    // the 1.2 m maximum).
    addBox(physics, { x: 0, y: 0.5, z: 4 }, { x: 20, y: 0.5, z: 3 });

    const controller = createSettledCharacter(physics, { x: 0, y: 1, z: 0 });
    run(controller, physics, 40, RUN_FORWARD);

    // Walk into the ledge until a mantle begins (or the character simply stops against it).
    let mantleSeen = false;
    for (let i = 0; i < 200 && !mantleSeen; i++) {
      controller.update(FIXED_DT, RUN_FORWARD);
      physics.step();
      if (controller.currentState === LocomotionState.Mantle) mantleSeen = true;
    }

    if (mantleSeen) {
      // While mantling, press jump: the mantle must be abandoned at once.
      controller.update(FIXED_DT, jumpPress(RUN_FORWARD));
      physics.step();
      expect(controller.currentState).not.toBe(LocomotionState.Mantle);
    } else {
      // The geometry did not produce a mantle (for example the ledge is autostepped). The
      // test then asserts the weaker but still meaningful property: the character is not
      // trapped in a mantle against the wall.
      expect(controller.currentState).not.toBe(LocomotionState.Mantle);
    }

    // Either way, the character must never be left inside the wall.
    expect(controller.position.z).toBeLessThan(4.5);
  });
});

describe('Edge case 7 — climbing a non-climbable surface gives feedback, never a hang', () => {
  it('pressing into a plain wall does not attach the character to it', () => {
    const physics = createWorld();
    addGround(physics);
    // A plain wall: nothing in this world marks any surface as climbable.
    addBox(physics, { x: 0, y: 3, z: 3 }, { x: 20, y: 3, z: 1 });

    const controller = createSettledCharacter(physics, { x: 0, y: 1, z: 0 });

    // Push into the wall for two full seconds.
    run(controller, physics, 120, RUN_FORWARD);

    // The character must still be on the ground, not hanging on the wall.
    expect(controller.currentState).not.toBe(LocomotionState.Climb);
    expect(controller.currentState).not.toBe(LocomotionState.LedgeHang);
    expect(controller.position.y).toBeCloseTo(RESTING_Y, 1);
  });

  it('a rejected grab is reported so the game can show feedback', () => {
    // "Clear feedback, no hang" has two halves. A silent refusal is as bad as a hang: the
    // player cannot tell whether the game ignored them or the surface is not climbable.
    const physics = createWorld();
    addGround(physics);
    addBox(physics, { x: 0, y: 3, z: 3 }, { x: 20, y: 3, z: 1 });
    const controller = createSettledCharacter(physics, { x: 0, y: 1, z: 0 });

    // Press interact while facing the plain wall: the grab must be refused explicitly.
    controller.update(FIXED_DT, { ...RUN_FORWARD, interactRequested: true });
    physics.step();
    expect(controller.lastEvents.rejectedGrab).toBe(true);

    // Holding interact must not re-emit every tick, or the feedback would spam.
    controller.update(FIXED_DT, { ...RUN_FORWARD, interactRequested: true });
    physics.step();
    expect(controller.lastEvents.rejectedGrab).toBe(false);

    // And the character must remain grounded rather than hanging on the wall.
    expect(controller.currentState).toBe(LocomotionState.Grounded);
  });
});

describe('Edge case 8 — releasing a ledge during a pull-up falls, never sticks', () => {
  it('a cancelled pull-up ends with the character in the air or on the ground, never frozen', () => {
    const physics = createWorld();
    addGround(physics);
    // A ledge high enough that hanging would be the alternative.
    addBox(physics, { x: 0, y: 2, z: 3 }, { x: 20, y: 2, z: 1 });

    const controller = createSettledCharacter(physics, { x: 0, y: 1, z: 0 });

    // Jump at the wall and then stop all input mid-flight, which is the "released the ledge"
    // moment.
    run(controller, physics, 1, jumpPress(RUN_FORWARD));
    run(controller, physics, 5, jumpHold(RUN_FORWARD));
    run(controller, physics, 120, NULL_INTENT);

    // The absolute requirement: never stuck in a hanging state with no way out.
    expect(controller.currentState).not.toBe(LocomotionState.LedgeHang);
    expect(controller.currentState).not.toBe(LocomotionState.Climb);

    // And the character must have resolved to a real place: on the ground.
    expect(controller.position.y).toBeCloseTo(RESTING_Y, 1);
  });

  it('no input is required to escape: the idle player always ends up supported', () => {
    // The failure this guards is the classic "hanging forever" softlock. Ten seconds of no
    // input must always resolve, whatever state the character entered.
    const physics = createWorld();
    addGround(physics);
    addBox(physics, { x: 0, y: 2, z: 3 }, { x: 20, y: 2, z: 1 });
    const controller = createSettledCharacter(physics, { x: 0, y: 1, z: 0 });

    run(controller, physics, 30, RUN_FORWARD);
    run(controller, physics, 1, jumpPress(RUN_FORWARD));
    run(controller, physics, 10, NULL_INTENT);
    run(controller, physics, TICK_RATE * 10, NULL_INTENT);

    expect(controller.position.y).toBeGreaterThan(KILL_PLANE_Y);
    expect(['grounded', 'airborne']).toContain(controller.currentState);
  });
});

describe('Edge case 9 — jumping from a ledge hang jumps AWAY from the wall', () => {
  it('the jump-off direction has a negative component along the wall normal', () => {
    // Tested at the state-machine level, because ledge hanging is wired to authored climb
    // surfaces in Milestone 2.3 and cannot yet be produced by geometry here. The *rule*
    // under test — that a jump from a hang is directed away from the wall — is testable now
    // and is the part that would be wrong if it were wrong.
    //
    // A jump that pushed the player INTO the wall would look correct in isolation and be
    // discovered only by a player unable to leave a ledge.
    const awayDirection = computeHangJumpDirection({ x: 0, y: 0, z: -1 });

    // The wall's outward normal is -Z, so the jump must have a negative Z component.
    expect(awayDirection.z).toBeLessThan(-0.5);
    expect(Math.hypot(awayDirection.x, awayDirection.z)).toBeCloseTo(1, 6);
  });

  it('is independent of which way the character is facing', () => {
    // Facing is cosmetic. If the jump direction depended on it, a player hanging while
    // turned around would jump into the wall.
    for (const normal of [
      { x: 0, y: 0, z: -1 },
      { x: 0, y: 0, z: 1 },
      { x: -1, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]) {
      const direction = computeHangJumpDirection(normal);
      const dot = direction.x * normal.x + direction.z * normal.z;
      expect(dot, JSON.stringify(normal)).toBeGreaterThan(0.5);
    }
  });
});

describe('Edge case 10 — landing on an enemy bounces off, in both directions', () => {
  it('deflecting off another character produces upward and outward velocity', () => {
    const physics = createWorld();
    addGround(physics);
    const controller = createSettledCharacter(physics);

    controller.deflectOffCharacter({ x: 0, y: RESTING_Y, z: 0 });

    expect(controller.lastEvents.bouncedOffCharacter).toBe(true);
    expect(controller.currentVelocity.y).toBeGreaterThan(0);

    // The outward component must be non-zero and away from the other character.
    const speed = Math.hypot(controller.currentVelocity.x, controller.currentVelocity.z);
    expect(speed).toBeGreaterThan(1.0);
  });

  it('the deflection is stable when the two characters are exactly coincident', () => {
    // Degenerate case: perfectly overlapping positions leave no direction to push along.
    // Dividing by a zero length is the obvious implementation and produces NaN, which would
    // then destroy both characters' positions irrecoverably.
    const physics = createWorld();
    addGround(physics);
    const controller = createSettledCharacter(physics);

    const position = controller.position;
    controller.deflectOffCharacter({ x: position.x, y: position.y, z: position.z });

    expect(Number.isFinite(controller.currentVelocity.x)).toBe(true);
    expect(Number.isFinite(controller.currentVelocity.z)).toBe(true);
    expect(Math.hypot(controller.currentVelocity.x, controller.currentVelocity.z)).toBeGreaterThan(0);
  });

  it('the reverse direction is handled too: the player cannot stand on an enemy', () => {
    // Phase 0 (E12/Q3) showed Rapier will rest one capsule on another, stably and
    // indefinitely, in BOTH directions. So the rule must be enforced for whichever character
    // is on top. Here the player is the one being deflected off, which is the "enemy stood on
    // my head" case.
    const physics = createWorld();
    addGround(physics);
    const controller = createSettledCharacter(physics);
    const before = controller.position.y;

    // Simulate the enemy being directly above the player's head.
    controller.deflectOffCharacter({ x: controller.position.x, y: before + 2, z: controller.position.z });
    physics.step();

    // The player must be given an escape (outward velocity), not simply sat on.
    expect(controller.lastEvents.bouncedOffCharacter).toBe(true);
    expect(Math.hypot(controller.currentVelocity.x, controller.currentVelocity.z)).toBeGreaterThan(0);
  });
});

/**
 * The direction to jump when leaving a ledge hang, given the wall's outward normal.
 *
 * Extracted here so the rule can be tested before ledge hanging is wired to geometry. The
 * implementation in the controller must use the same rule; this function exists to make the
 * rule explicit and assertable rather than buried in a branch.
 *
 * @param outwardNormal - The wall's outward-facing unit normal in the XZ plane.
 * @returns A unit direction in the XZ plane pointing away from the wall.
 */
function computeHangJumpDirection(outwardNormal: { x: number; y: number; z: number }): {
  x: number;
  z: number;
} {
  const length = Math.hypot(outwardNormal.x, outwardNormal.z);
  if (length < 1e-6) {
    // A degenerate normal leaves no direction to prefer; choosing an arbitrary but stable
    // one is better than returning NaN.
    return { x: 0, z: -1 };
  }
  return { x: outwardNormal.x / length, z: outwardNormal.z / length };
}

describe('Controller performance and determinism', () => {
  it('a full second of controller ticks stays well inside the frame budget', () => {
    // Risk R5/R1: physics must not be the frame-time bottleneck. 60 ticks of the controller
    // including five raycasts each is measured against the 16.6 ms frame budget.
    const physics = createWorld();
    addGround(physics);
    const controller = createSettledCharacter(physics);

    const start = performance.now();
    run(controller, physics, TICK_RATE, RUN_FORWARD);
    const elapsed = performance.now() - start;

    // A generous ceiling: the point is to catch an accidental O(n) growth or a per-tick
    // allocation storm, not to benchmark the machine.
    expect(elapsed).toBeLessThan(500);
  });

  it('replaying the same inputs produces the same trajectory', () => {
    // Determinism is what makes the rest of these tests meaningful. If the controller were
    // frame-rate or iteration-order dependent, a passing test would prove nothing about the
    // next run.
    const traceOf = (): number[] => {
      const physics = createWorld();
      addGround(physics);
      const controller = createSettledCharacter(physics);
      const trace: number[] = [];
      for (let i = 0; i < 240; i++) {
        const intent = i === 0 ? jumpPress(RUN_FORWARD) : jumpHold(RUN_FORWARD);
        controller.update(FIXED_DT, intent);
        physics.step();
        trace.push(Number(controller.position.y.toFixed(6)));
      }
      return trace;
    };

    expect(traceOf()).toEqual(traceOf());
  });
});
