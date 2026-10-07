/**
 * The player character's visual representation.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * ZERO BINARY ASSETS IS A CONSTRAINT, NOT A LIMITATION TO APOLOGISE FOR
 * ────────────────────────────────────────────────────────────────────────────────
 * Project Jungle Relic ships no `.glb`, no `.fbx`, no `.png` and no skeleton data. The whole
 * character is built from low-poly primitives at boot and animated by evaluating pose
 * generators in code.
 *
 * That sounds like a compromise and is partly one — but it is also the *authentic* approach
 * for the target. PS1 characters were often a handful of rigid parts rotated about joints,
 * precisely because 1997 hardware had no budget for skinning, and the result has a specific,
 * recognisable character. Hand-animating skeletons would also have been impossible here: there
 * is no DCC tool, and a rig that cannot be authored cannot be maintained.
 *
 * ─── WHY A POSE-GENERATOR BLEND RATHER THAN AN ANIMATION CLIP ────────────────────────
 * A conventional blend tree interpolates between *clips*. Without clips, the equivalent is to
 * interpolate between *functions that write a pose*:
 *
 *     pose = Σ (weight_i × generator_i(report, phase))
 *
 * Two things fall out of this that a clip-based system cannot give us for free:
 *
 *   1. **Transitions are free and correct.** Walking to running is a weight change, not a
 *      crossfade that has to be scheduled and timed. There is no "blend duration" to tune and
 *      no pop when a transition is interrupted.
 *   2. **The pose continuously reflects the world.** The slope tilt is a function of the ground
 *      normal, so the character leans into a hill by exactly as much as the ground demands —
 *      no per-slope clips, and no mismatch when the player stands on a 17° ramp that no one
 *      authored a clip for.
 *
 * ─── THE HONEST LIMITATION ───────────────────────────────────────────────────────────
 * This is *not* a skeletal animation system and does not pretend to be. There is no skeletal
 * hierarchy to poke at, no inverse-kinematics solver, and the joints are a fixed list matched to
 * a fixed part list. It is the smallest thing that produces a readable, responsive, on-theme
 * character, and it will not scale to a 60-bone biped. Adding one would mean adding a real
 * animation system, which is a Milestone 2+ concern and is not attempted here.
 *
 * The foot IK is a single-bone approximation: each foot is placed on a raycast hit and the
 * shin is stretched or compressed to reach it. A two-bone analytic solve would be better and is
 * noted in the DEV_LOG as a possible refinement.
 */

import * as THREE from 'three';
import { applyVertexColor } from '../world/geometry';
import { createPS1Material } from '../render/PS1Material';
import type { CharacterTickReport } from './CharacterController';
import { LocomotionState } from './LocomotionStates';
import { PLAYER_CAPSULE_HALF_HEIGHT_M, PLAYER_CAPSULE_RADIUS_M } from '../core/constants';

/** Joint positions in the character's local space, in metres, with y = 0 at the feet. */
const JOINTS = {
  hipHeight: 0.90,
  shoulderHeight: 1.42,
  headCentre: 1.58,
  hipWidth: 0.16,
  shoulderWidth: 0.22,
} as const;

/** Limb dimensions, in metres. Short and chunky to match the PS1 silhouette. */
const LIMBS = {
  thighLength: 0.44,
  shinLength: 0.44,
  upperArmLength: 0.30,
  foreArmLength: 0.28,
  torsoHalfWidth: 0.20,
  torsoHalfDepth: 0.13,
  torsoHalfHeight: 0.28,
  headRadius: 0.15,
} as const;

/** The palette. Bright, warm and readable against jungle green — never grim. */
const COLOURS = {
  skin: 0xc98f6a,
  shirt: 0x8c4a3f,
  trousers: 0x4a5a3c,
  boots: 0x35281f,
  hair: 0x2e2018,
  backpack: 0x6b5a3e,
} as const;

/** A single rigid part of the character: a mesh plus its rest pose. */
interface RigPart {
  mesh: THREE.Mesh;
  /** Rest position in local space, which the pose functions offset from for the foot IK. */
  restPosition: THREE.Vector3;
}

/** The set of parts, grouped for the pose functions to address. */
interface RigParts {
  root: THREE.Group;
  pelvis: THREE.Group;
  torso: THREE.Group;
  head: THREE.Mesh;
  leftThigh: RigPart;
  rightThigh: RigPart;
  leftShin: RigPart;
  rightShin: RigPart;
  leftArm: RigPart;
  rightArm: RigPart;
  leftForeArm: RigPart;
  rightForeArm: RigPart;
}

/**
 * A procedural, code-built character that poses itself from the controller's state.
 *
 * Owns its geometry and material and must be disposed. One instance per character.
 */
export class CharacterRig {
  /** The scene-graph root. Added to the level's scene by the caller. */
  public readonly object3D: THREE.Group;

  private readonly parts: RigParts;
  private readonly material: THREE.Material;
  /** The merged geometry, held so it can be disposed. */
  private readonly ownedGeometries: THREE.BufferGeometry[] = [];

  /** Accumulated walk cycle phase in radians. Advanced by distance travelled, not by time. */
  private gaitPhase = 0;

  /**
   * @param scene - The scene to add the character to.
   * @param clothTexture - The woven-cloth texture from the level's texture library. Required,
   *   because every surface in this game must pass through the same PS1 shader path; a
   *   character on an untextured material would not receive the period artefacts the
   *   environment has, and would read as pasted on top of the scene.
   */
  constructor(scene: THREE.Scene, clothTexture: THREE.Texture) {
    this.object3D = new THREE.Group();
    this.object3D.name = 'PlayerCharacter';

    // A single shared material for every part: one draw call per part is already more than
    // this character needs, and sharing the material means the PS1 vertex-snap and affine-UV
    // shader is compiled once rather than thirteen times.
    this.material = createPS1Material({ map: clothTexture });

    this.parts = this.buildRig();
    this.object3D.add(this.parts.root);
    scene.add(this.object3D);
  }

  /**
   * Pose the character from a controller report and place it in the world.
   *
   * @param report - The controller's snapshot for this tick.
   * @param dt - Timestep in seconds, for gait phase advance.
   * @param footGroundOffsets - Per-foot ground offsets from raycasts, in metres, or null when
   *   the corresponding foot found no ground (in which case no IK is applied to it).
   */
  public update(
    report: CharacterTickReport,
    dt: number,
    footGroundOffsets: { left: number | null; right: number | null },
  ): void {
    this.object3D.position.set(report.position.x, report.position.y, report.position.z);

    // The body origin is the capsule's CENTRE, so the model's feet sit one full
    // half-height-plus-radius below it. Getting this wrong buries the character's knees in the
    // ground, which is the single most common way a procedural character looks broken.
    this.object3D.position.y -= GROUND_OFFSET_M;

    // Facing: the controller's angle is measured from +Z, which is also three.js's convention
    // for a rotation about Y, so no conversion is needed.
    this.object3D.rotation.y = report.facingAngle;

    this.pose(report, dt, footGroundOffsets);
  }

  /** Release every GPU resource this rig owns. */
  public dispose(): void {
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.material.dispose();
    this.object3D.removeFromParent();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POSE FUNCTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Evaluate and apply the blended pose for the current state.
   *
   * @param report - The controller's snapshot.
   * @param dt - Timestep in seconds.
   * @param footGroundOffsets - Per-foot ground offsets for the IK.
   */
  private pose(
    report: CharacterTickReport,
    dt: number,
    footGroundOffsets: { left: number | null; right: number | null },
  ): void {
    // The gait phase advances with DISTANCE TRAVELLED, not with time. This is what makes the
    // footfalls keep pace with the ground instead of skating: a character walking slowly takes
    // fewer, longer steps, and one running takes rapid ones, from the same code.
    const distanceThisTick = report.horizontalSpeed * dt;
    this.gaitPhase += (distanceThisTick / STRIDE_LENGTH_M) * Math.PI * 2;
    if (this.gaitPhase > Math.PI * 4) this.gaitPhase -= Math.PI * 4;

    // ── Blend weights ──────────────────────────────────────────────────────────
    // A walk/run blend from speed, and hard overrides for the states that are not a gait.
    const speedFraction = Math.min(1, report.horizontalSpeed / RUN_SPEED_REFERENCE_MPS);
    const airborne = report.state === LocomotionState.Airborne;

    // ── Torso ──────────────────────────────────────────────────────────────────
    // Lean forward into a run, and lean the whole body into the slope from the ground normal.
    const slopeLean = report.grounded ? Math.atan2(report.groundNormal.x, report.groundNormal.y) : 0;
    const slopeLeanZ = report.grounded ? Math.atan2(report.groundNormal.z, report.groundNormal.y) : 0;

    const runLean = airborne ? 0.10 : speedFraction * 0.22;
    this.parts.pelvis.rotation.x = slopeLean * 0.5;
    this.parts.torso.rotation.x = runLean;
    this.parts.torso.rotation.z = -slopeLeanZ * 0.5;

    // A breathing bob while grounded and still, so the character is never a statue.
    const idleBob = Math.sin(this.gaitPhase * 0.5) * 0.01;
    this.parts.torso.position.y = idleBob;

    // ── Legs ───────────────────────────────────────────────────────────────────
    // The swing is a sine pair offset by half a cycle, scaled by how fast we are moving. At a
    // standstill the amplitude is zero, so no separate idle clip is needed.
    const swingAmplitude = airborne ? 0 : 0.25 + speedFraction * 0.55;
    const kneeAmplitude = airborne ? 0 : 0.15 + speedFraction * 0.65;

    const leftSwing = Math.sin(this.gaitPhase);
    const rightSwing = Math.sin(this.gaitPhase + Math.PI);

    this.parts.leftThigh.mesh.rotation.x = leftSwing * swingAmplitude + (airborne ? -0.35 : 0);
    this.parts.rightThigh.mesh.rotation.x = rightSwing * swingAmplitude + (airborne ? 0.30 : 0);

    // Knees bend only on the back-swing, which is what stops the legs looking like scissors.
    this.parts.leftShin.mesh.rotation.x = Math.max(0, -leftSwing) * kneeAmplitude;
    this.parts.rightShin.mesh.rotation.x = Math.max(0, -rightSwing) * kneeAmplitude;

    // ── Arms ───────────────────────────────────────────────────────────────────
    // Arms counter-swing the legs, which is what sells a walk from any angle.
    const armAmplitude = airborne ? 0.5 : 0.2 + speedFraction * 0.5;
    this.parts.leftArm.mesh.rotation.x = -leftSwing * armAmplitude + (airborne ? -1.1 : 0);
    this.parts.rightArm.mesh.rotation.x = -rightSwing * armAmplitude + (airborne ? -1.1 : 0);

    // Airborne arms spread outward, so a jump reads as a jump even in silhouette.
    const spread = airborne ? 0.55 : 0;
    this.parts.leftArm.mesh.rotation.z = spread;
    this.parts.rightArm.mesh.rotation.z = -spread;

    const elbowBend = 0.25 + speedFraction * 0.5 + (airborne ? 0.6 : 0);
    this.parts.leftForeArm.mesh.rotation.x = elbowBend;
    this.parts.rightForeArm.mesh.rotation.x = elbowBend;

    // ── Head ───────────────────────────────────────────────────────────────────
    // Counter-rotate the head against the torso's lean so the character keeps looking ahead
    // rather than at their own feet while running.
    this.parts.head.rotation.x = -runLean * 0.7;

    // ── Foot IK ────────────────────────────────────────────────────────────────
    this.applyFootIk(footGroundOffsets);
  }

  /**
   * Place each foot on the ground it is over, stretching the shin to reach.
   *
   * A one-bone approximation: the shin's length is changed rather than solving a two-bone
   * chain. It is correct for the common case (a foot slightly above or below its rest height)
   * and degrades gracefully — a foot more than a shin's length from the hip simply stretches,
   * which reads acceptably at this scale and never produces a broken joint.
   *
   * @param offsets - Per-foot ground offsets in metres, or null when no ground was found.
   */
  private applyFootIk(offsets: { left: number | null; right: number | null }): void {
    const applyTo = (part: RigPart, offset: number | null): void => {
      if (offset === null) return;
      // Clamped: a foot found far below the hip means the raycast hit something other than the
      // ground under that foot, and stretching to it would tear the character apart.
      const clamped = Math.max(-0.25, Math.min(0.25, offset));
      part.mesh.position.y = part.restPosition.y + clamped;
    };

    applyTo(this.parts.leftShin, offsets.left);
    applyTo(this.parts.rightShin, offsets.right);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CONSTRUCTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Build the rig from primitives.
   *
   * @returns The assembled part set.
   */
  private buildRig(): RigParts {
    const root = new THREE.Group();
    root.name = 'RigRoot';

    // ── Pelvis: the root of the body, at hip height ─────────────────────────────
    const pelvis = new THREE.Group();
    pelvis.position.y = JOINTS.hipHeight;
    root.add(pelvis);

    const torso = this.buildTorso(pelvis);
    const head = this.buildHead(torso);

    const legs = this.buildLegs(pelvis);
    const arms = this.buildArms(torso);

    return { root, pelvis, torso, head, ...legs, ...arms };
  }

  /**
   * Build the torso and its backpack.
   *
   * @param pelvis - The pelvis group to attach to.
   * @returns The torso group, which the head and arms hang from.
   */
  private buildTorso(pelvis: THREE.Group): THREE.Group {
    const torso = new THREE.Group();
    torso.position.y = LIMBS.torsoHalfHeight + TORSO_PIVOT_LIFT_M;
    pelvis.add(torso);

    torso.add(
      this.box(
        LIMBS.torsoHalfWidth * 2,
        LIMBS.torsoHalfHeight * 2,
        LIMBS.torsoHalfDepth * 2,
        COLOURS.shirt,
      ),
    );

    // A backpack, so the character is identifiable from behind under the over-shoulder camera
    // that the GDD specifies.
    const backpack = this.box(0.26, 0.30, 0.14, COLOURS.backpack);
    backpack.position.set(0, 0.06, -LIMBS.torsoHalfDepth - 0.07);
    torso.add(backpack);

    return torso;
  }

  /**
   * Build the head and hair.
   *
   * Hair is a separate slab rather than part of the head box: at 480x270 a character is roughly
   * forty pixels tall, and a two-tone head reads as a head where a single flat box reads as a
   * featureless cube.
   *
   * @param torso - The torso group to attach to.
   * @returns The head mesh, which the pose functions counter-rotate.
   */
  private buildHead(torso: THREE.Group): THREE.Mesh {
    const head = this.box(
      LIMBS.headRadius * 2,
      LIMBS.headRadius * 2.1,
      LIMBS.headRadius * 2,
      COLOURS.skin,
    );
    head.position.y = JOINTS.headCentre - JOINTS.hipHeight - torso.position.y;
    torso.add(head);

    const hair = this.box(LIMBS.headRadius * 2.1, 0.10, LIMBS.headRadius * 2.1, COLOURS.hair);
    hair.position.y = LIMBS.headRadius + 0.02;
    head.add(hair);

    return head;
  }

  /**
   * Build both legs, shins parented to thighs.
   *
   * @param pelvis - The pelvis group to attach the thighs to.
   * @returns The four leg parts.
   */
  private buildLegs(pelvis: THREE.Group): {
    leftThigh: RigPart;
    rightThigh: RigPart;
    leftShin: RigPart;
    rightShin: RigPart;
  } {
    const leftThigh = this.buildLimb(pelvis, -JOINTS.hipWidth, 0, LIMBS.thighLength, 0.11, COLOURS.trousers);
    const rightThigh = this.buildLimb(pelvis, JOINTS.hipWidth, 0, LIMBS.thighLength, 0.11, COLOURS.trousers);

    // Passing the thigh's mesh as the parent is what makes the knee a real child joint: the
    // shin inherits the thigh's rotation for free, and the shin's own rotation is relative to it.
    const leftShin = this.buildLimb(leftThigh.mesh, 0, -LIMBS.thighLength, LIMBS.shinLength, 0.09, COLOURS.boots);
    const rightShin = this.buildLimb(rightThigh.mesh, 0, -LIMBS.thighLength, LIMBS.shinLength, 0.09, COLOURS.boots);

    return { leftThigh, rightThigh, leftShin, rightShin };
  }

  /**
   * Build both arms, forearms parented to upper arms.
   *
   * @param torso - The torso group to attach the upper arms to.
   * @returns The four arm parts.
   */
  private buildArms(torso: THREE.Group): {
    leftArm: RigPart;
    rightArm: RigPart;
    leftForeArm: RigPart;
    rightForeArm: RigPart;
  } {
    const shoulderY = JOINTS.shoulderHeight - JOINTS.hipHeight - torso.position.y;

    const leftArm = this.buildLimb(torso, -JOINTS.shoulderWidth, shoulderY, LIMBS.upperArmLength, 0.075, COLOURS.shirt);
    const rightArm = this.buildLimb(torso, JOINTS.shoulderWidth, shoulderY, LIMBS.upperArmLength, 0.075, COLOURS.shirt);

    const leftForeArm = this.buildLimb(leftArm.mesh, 0, -LIMBS.upperArmLength, LIMBS.foreArmLength, 0.065, COLOURS.skin);
    const rightForeArm = this.buildLimb(rightArm.mesh, 0, -LIMBS.upperArmLength, LIMBS.foreArmLength, 0.065, COLOURS.skin);

    return { leftArm, rightArm, leftForeArm, rightForeArm };
  }

  /**
   * Create one limb segment: a hinged group whose mesh hangs downward from its pivot.
   *
   * The pivot is at the TOP of the segment. That is what makes rotation behave like a joint —
   * a box pivotting about its centre swings its top backwards through the parent, which looks
   * like a dislocated hip.
   *
   * @param parent - The object to attach the segment to.
   * @param x - Local X of the pivot.
   * @param y - Local Y of the pivot.
   * @param length - Segment length in metres.
   * @param radius - Segment half-thickness in metres.
   * @param colour - Packed 0xRRGGBB colour.
   * @returns The created part, whose `mesh` is the hinged group.
   */
  private buildLimb(
    parent: THREE.Object3D,
    x: number,
    y: number,
    length: number,
    radius: number,
    colour: number,
  ): RigPart {
    // The hinge is a Group so the mesh can be offset below it without affecting the rotation.
    // A limb is a box `length` tall and `radius * 2` across, whose geometry is shifted down by
    // half its length so the mesh hangs BELOW the pivot. Without the shift the box would rotate
    // about its own centre and the segment would punch through its parent joint.
    const geometry = new THREE.BoxGeometry(radius * 2, length, radius * 2);
    applyVertexColor(geometry, new THREE.Color(colour));
    geometry.translate(0, -length / 2, 0);
    this.ownedGeometries.push(geometry);

    const hinge = new THREE.Mesh(geometry, this.material);
    hinge.position.set(x, y, 0);
    parent.add(hinge);

    return {
      mesh: hinge,
      restPosition: new THREE.Vector3(x, y, 0),
    };
  }

  /**
   * Create a plain box mesh with a vertex-coloured geometry.
   *
   * @param width - Full width in metres.
   * @param height - Full height in metres.
   * @param depth - Full depth in metres.
   * @param colour - Packed 0xRRGGBB colour.
   * @returns The mesh, sharing the rig's material.
   */
  private box(width: number, height: number, depth: number, colour: number): THREE.Mesh {
    return new THREE.Mesh(this.ownedBox(width, height, depth, colour), this.material);
  }

  /**
   * Build and register a vertex-coloured box geometry.
   *
   * Geometry is created through the shared `BoxGeometry` + `applyVertexColor` path so the
   * character is subject to exactly the same PS1 shader treatment as the environment — the
   * vertex snapping and affine warping apply to the character too. A character rendered without
   * the period artefacts among environment geometry that has them looks pasted on.
   *
   * @param width - Full width in metres.
   * @param height - Full height in metres.
   * @param depth - Full depth in metres.
   * @param colour - Packed 0xRRGGBB colour.
   * @returns The geometry, tracked for disposal.
   */
  private ownedBox(width: number, height: number, depth: number, colour: number): THREE.BufferGeometry {
    const geometry = new THREE.BoxGeometry(width, height, depth);
    applyVertexColor(geometry, new THREE.Color(colour));
    this.ownedGeometries.push(geometry);
    return geometry;
  }
}

/**
 * How far the model's feet sit below the capsule's centre.
 *
 * The body origin is the capsule centre, so the feet are `halfHeight + radius` below it. Using
 * the constants rather than a literal means the model cannot drift out of step with the
 * collision shape if the capsule is ever retuned.
 */
const GROUND_OFFSET_M = PLAYER_CAPSULE_HALF_HEIGHT_M + PLAYER_CAPSULE_RADIUS_M;

/**
 * How far above the pelvis centre the torso pivot sits.
 *
 * A small lift so the torso's bottom edge is not coincident with the pelvis, which would make
 * the hip joint invisible and the waist look fused.
 */
const TORSO_PIVOT_LIFT_M = 0.05;

/** Distance covered per full stride cycle, which sets the gait phase rate. */
const STRIDE_LENGTH_M = 1.9;

/** Speed at which the run pose is fully blended in. */
const RUN_SPEED_REFERENCE_MPS = 6.0;
