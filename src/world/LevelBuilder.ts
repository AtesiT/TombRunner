/**
 * Level assembly for Zone 1 — Jungle Entrance.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * DESIGN AND ENGINEERING NOTES
 * ────────────────────────────────────────────────────────────────────────────────
 * Milestone 1.1 delivers the rendering pipeline and the environment. Zones 2-5 and the
 * gameplay geometry (puzzle sockets, climb surfaces, triggers) belong to Phase 3 and are
 * deliberately NOT stubbed — a half-built placeholder zone is worse than no zone, because
 * it silently passes as content.
 *
 * What this builder establishes, and must keep doing as content grows:
 *  1. **Determinism.** Every placement derives from a seeded generator, so the level is
 *     identical on every reload. The player's mental map stays valid and a visual
 *     regression is reproducible rather than a rumour.
 *  2. **Visual/collision agreement.** The ground's collision trimesh is extracted from
 *     the *same* BufferGeometry that is rendered. Any divergence is felt immediately as
 *     floating or sinking.
 *  3. **Culling-ready structure.** Props are batched per spatial cell (InstanceBatcher)
 *     so frustum culling actually rejects geometry instead of submitting all of it.
 *  4. **Playable composition.** The layout is arranged around a sightline: the player
 *     starts in open jungle, sees the ruined temple through a gap in the trees, and has
 *     a clear route towards it. Composition is a gameplay concern, not decoration.
 *
 * STRUCTURE: the builder is decomposed into one function per feature, each well under
 * the 50-line limit imposed by the code review protocol, and each taking a shared
 * {@link BuildContext}. A single 300-line function would be faster to write and much
 * harder to change, which is the wrong trade for the file every later milestone edits.
 */

import * as THREE from 'three';
import { SeededRandom, ValueNoise2D } from '../core/math/rng';
import { FOG_FAR_M, LEVEL_HALF_EXTENT_M, WORLD_SEED } from '../core/constants';
import { CollisionLayer } from '../physics/Layers';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { createPS1Material } from '../render/PS1Material';
import { PS1_SKY_FRAGMENT_SHADER, PS1_SKY_VERTEX_SHADER } from '../render/shaders/ps1World';
import {
  applyVertexColor,
  createBroadleafGeometry,
  createBrokenStatueGeometry,
  createGroundGeometry,
  createPalmGeometry,
  createPillarGeometry,
  createRockGeometry,
  createRuinedWallGeometry,
  createSkyDomeGeometry,
  extractTrimesh,
  mergeGeometries,
} from './geometry';
import { InstanceBatcher } from './InstanceBatcher';
import { createTextureLibrary, disposeTextureLibrary, type TextureLibrary } from './textures';

/** Ground plane edge length in metres. */
const GROUND_SIZE = LEVEL_HALF_EXTENT_M * 2;

/** Ground height variation amplitude in metres. Kept gentle for readable platforming. */
const GROUND_AMPLITUDE = 0.8;

/** Spatial cell size for prop batching. See InstanceBatcher for the reasoning. */
const CELL_SIZE = 32;

/** Centre of the temple platform, in world Z. Negative Z is "towards the goal". */
const TEMPLE_Z = -34;

/** Height of the temple platform's top surface. */
const PLATFORM_HEIGHT = 1.4;

/** Summary of what the builder produced, used for logging and tests. */
export interface LevelSummary {
  staticColliderCount: number;
  treeCount: number;
  rockCount: number;
  pillarCount: number;
  statueCount: number;
  wallCount: number;
  drawCallEstimate: number;
  triangleCount: number;
  /** Where the player begins. Always above solid ground, verified by the prime step. */
  spawnPoint: THREE.Vector3;
  /** Level extents, for spatial partitioning and diagnostics. */
  bounds: THREE.Box3;
}

/** The built level: a scene, plus the handles needed to update and release it. */
export interface BuiltLevel {
  scene: THREE.Scene;
  summary: LevelSummary;
  /**
   * The woven-cloth texture, shared with the character rig.
   *
   * Exposed rather than recreated so the character passes through exactly the same PS1 shader
   * path as the environment. It is owned by the level, so the rig must NOT dispose it — it
   * would be disposed twice, and the second disposal would be a no-op that silently leaves a
   * dangling reference in any material still using it.
   */
  clothTexture: THREE.Texture;
  /**
   * Keep the sky dome centred on the camera.
   *
   * @param cameraPosition - The world camera's current position.
   */
  updateSky(cameraPosition: THREE.Vector3): void;
  dispose(): void;
}

/**
 * Shared state threaded through the per-feature builders.
 *
 * Passing one context object keeps each builder's signature short and makes the
 * ownership of disposables and the summary explicit rather than relying on closures.
 */
interface BuildContext {
  scene: THREE.Scene;
  physics: PhysicsWorld;
  textures: TextureLibrary;
  rng: SeededRandom;
  /** Everything that allocates GPU memory and must be released on teardown. */
  disposables: Array<{ dispose(): void }>;
  summary: LevelSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
// TERRAIN SAMPLING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Noise field used for the ground height, cached per seed.
 *
 * The cache matters for correctness as much as speed: the noise lattice must be the
 * *same instance* the geometry was built from, or prop placement would sample a
 * different field and props would hover or sink.
 */
const groundNoiseCache = new Map<number, ValueNoise2D>();

/**
 * Fetch (or build) the ground noise field for a seed.
 *
 * @param seed - Generation seed.
 * @returns The noise sampler, identical to the one the geometry used.
 */
function groundNoise(seed: number): ValueNoise2D {
  const cached = groundNoiseCache.get(seed);
  if (cached) return cached;
  const noise = new ValueNoise2D(new SeededRandom(seed), 256);
  groundNoiseCache.set(seed, noise);
  return noise;
}

/**
 * Sample the deterministic ground surface height at a world position.
 *
 * The two noise terms here mirror `createGroundGeometry` exactly. If either is edited
 * the other must follow, or props will float — which is why both use the shared
 * {@link groundNoise} cache rather than constructing their own generator.
 *
 * @param x - World X.
 * @param z - World Z.
 * @returns Ground surface height in metres.
 */
export function sampleGroundHeight(x: number, z: number): number {
  const noise = groundNoise(WORLD_SEED);
  const u = (x + GROUND_SIZE / 2) / GROUND_SIZE;
  const v = (z + GROUND_SIZE / 2) / GROUND_SIZE;
  const rolling = noise.fbm(u, v, 3, 3) - 0.5;
  const detail = noise.fbm(u, v, 2, 10) - 0.5;
  return rolling * GROUND_AMPLITUDE * 2 + detail * GROUND_AMPLITUDE * 0.25;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Zone 1 jungle environment.
 *
 * @param physics - The primed physics world. Colliders are registered directly.
 * @returns The built scene plus update and disposal handles.
 */
export function buildJungleLevel(physics: PhysicsWorld): BuiltLevel {
  const scene = new THREE.Scene();
  scene.name = 'Zone1_JungleEntrance';

  // Fog matched to the sky, starting far out. It softens the world's edge; it is never
  // used to hide draw distance, which is what authored occluders are for (GDD §9.3).
  scene.fog = new THREE.Fog(0xa8d8f0, FOG_FAR_M * 0.32, FOG_FAR_M);

  const textures = createTextureLibrary();

  const context: BuildContext = {
    scene,
    physics,
    textures,
    rng: new SeededRandom(WORLD_SEED),
    // The library is a bag of textures, not a disposable itself; adapt it so the
    // teardown loop has a single uniform contract.
    disposables: [{ dispose: () => disposeTextureLibrary(textures) }],
    summary: {
      staticColliderCount: 0,
      treeCount: 0,
      rockCount: 0,
      pillarCount: 0,
      statueCount: 0,
      wallCount: 0,
      drawCallEstimate: 0,
      triangleCount: 0,
      spawnPoint: new THREE.Vector3(0, 0, 42),
      bounds: new THREE.Box3(
        new THREE.Vector3(-LEVEL_HALF_EXTENT_M, -4, -LEVEL_HALF_EXTENT_M),
        new THREE.Vector3(LEVEL_HALF_EXTENT_M, 34, LEVEL_HALF_EXTENT_M),
      ),
    },
  };

  const skyUniforms = buildSky(context);
  buildGround(context);
  buildTrees(context);
  buildRocks(context);
  buildTemple(context);
  buildWater(context);
  placeSpawn(context);

  return {
    scene,
    summary: context.summary,
    clothTexture: context.textures.cloth,
    updateSky(cameraPosition: THREE.Vector3): void {
      // Moving the dome with the camera is what makes it read as infinitely distant
      // rather than as a nearby sphere the player can walk towards.
      (skyUniforms.uSkyOffset.value as THREE.Vector3).copy(cameraPosition);
    },
    dispose(): void {
      // Reverse order so dependants release before the resources they reference.
      for (let i = context.disposables.length - 1; i >= 0; i--) {
        context.disposables[i].dispose();
      }
      groundNoiseCache.delete(WORLD_SEED);
      scene.clear();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the sky dome.
 *
 * @param context - Shared build state.
 * @returns The sky material's uniforms, so the dome can follow the camera.
 */
function buildSky(context: BuildContext): Record<string, THREE.IUniform> {
  const geometry = createSkyDomeGeometry(FOG_FAR_M * 0.92);
  const material = new THREE.ShaderMaterial({
    vertexShader: PS1_SKY_VERTEX_SHADER,
    fragmentShader: PS1_SKY_FRAGMENT_SHADER,
    side: THREE.FrontSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uSkyOffset: { value: new THREE.Vector3() },
      uHorizonColor: { value: new THREE.Color(0xb0e0f4) },
      uZenithColor: { value: new THREE.Color(0x589ee2) },
      uCloudColor: { value: new THREE.Color(0xfcfcf8) },
      uCloudCoverage: { value: 0.46 },
      uCloudSoftness: { value: 0.22 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'SkyDome';
  // Never culled (it surrounds everything) and never depth-writing (it would occlude
  // the world). Drawn first because it is pure background.
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.matrixAutoUpdate = false;
  context.scene.add(mesh);

  context.disposables.push(geometry, material);
  return material.uniforms;
}

/**
 * Build the ground and its exact-match collision trimesh.
 *
 * @param context - Shared build state.
 */
function buildGround(context: BuildContext): void {
  const geometry = createGroundGeometry(GROUND_SIZE, {
    heightAmplitude: GROUND_AMPLITUDE,
    seed: WORLD_SEED,
  });

  const material = createPS1Material({ map: context.textures.grass });

  // One 64 px tile per ~4 m: large enough to read as terrain rather than wallpaper,
  // small enough that the tile detail survives the affine warp.
  context.textures.grass.repeat.set(GROUND_SIZE / 4, GROUND_SIZE / 4);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Ground';
  mesh.matrixAutoUpdate = false;
  context.scene.add(mesh);
  context.disposables.push(geometry, material);

  // Extracted from the rendered geometry itself, so the visual and collision surfaces
  // are guaranteed identical (see extractTrimesh in ./geometry).
  const { vertices, indices } = extractTrimesh(geometry);

  context.physics.createStaticCollider({
    shape: { kind: 'trimesh', vertices, indices },
    translation: { x: 0, y: 0, z: 0 },
    layer: CollisionLayer.StaticWorld,
    surfaceType: 'grass',
  });

  context.summary.staticColliderCount++;
  context.summary.drawCallEstimate++;
  context.summary.triangleCount += indices.length / 3;
}

/**
 * Plant the tree ring.
 *
 * Trees are biased outward to preserve a central clearing, and a corridor towards the
 * temple is explicitly left open so the player can see the goal from the spawn point.
 *
 * @param context - Shared build state.
 */
function buildTrees(context: BuildContext): void {
  const { rng } = context;

  // Two species x three geometry variants gives six source geometries for the whole
  // canopy, so variety costs no per-tree uniqueness.
  const barkMaterial = createPS1Material({ map: context.textures.bark, doubleSided: true });
  const foliageMaterial = createPS1Material({
    map: context.textures.foliage,
    alphaTest: 0.5,
    doubleSided: true,
  });
  context.disposables.push(barkMaterial, foliageMaterial);

  const palmBatchers: InstanceBatcher[] = [];
  const broadleafBatchers: InstanceBatcher[] = [];
  for (let variant = 0; variant < 3; variant++) {
    palmBatchers.push(new InstanceBatcher(createPalmGeometry(rng), barkMaterial, CELL_SIZE));
    broadleafBatchers.push(
      new InstanceBatcher(createBroadleafGeometry(rng), foliageMaterial, CELL_SIZE),
    );
  }

  const treeCount = 34;
  for (let i = 0; i < treeCount; i++) {
    const angle = rng.range(0, Math.PI * 2);
    const radius = rng.range(12, LEVEL_HALF_EXTENT_M * 0.82);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    // Leave the approach corridor towards the temple open.
    if (z < -8 && Math.abs(x) < 11) continue;

    const y = sampleGroundHeight(x, z);
    const variant = rng.intRange(0, 2);
    const isPalm = rng.chance(0.45);

    (isPalm ? palmBatchers : broadleafBatchers)[variant].add({
      position: new THREE.Vector3(x, y, z),
      rotationY: rng.range(0, Math.PI * 2),
      scale: rng.range(0.8, 1.35),
    });
    context.summary.treeCount++;
  }

  for (const batcher of [...palmBatchers, ...broadleafBatchers]) {
    for (const mesh of batcher.build()) {
      context.scene.add(mesh);
      context.disposables.push(mesh.material as THREE.Material, mesh.geometry);
      context.summary.drawCallEstimate++;
      const index = mesh.geometry.getIndex();
      context.summary.triangleCount +=
        ((index ? index.count : mesh.geometry.getAttribute('position').count) / 3) *
        mesh.count;
    }
  }
}

/**
 * Scatter rocks.
 *
 * Only the large variants receive colliders. Small scatter rocks are decoration;
 * giving them collision would litter the ground with invisible snags, which players
 * read as broken collision rather than as detail.
 *
 * @param context - Shared build state.
 */
function buildRocks(context: BuildContext): void {
  const { rng } = context;
  const stoneMaterial = createPS1Material({ map: context.textures.stone });

  const variants = [
    { batcher: new InstanceBatcher(createRockGeometry(rng, 1.6, true), stoneMaterial, CELL_SIZE), radius: 1.6, collides: true, lift: 0.25 },
    { batcher: new InstanceBatcher(createRockGeometry(rng, 2.4, false), stoneMaterial, CELL_SIZE), radius: 2.4, collides: true, lift: 1.35 },
    { batcher: new InstanceBatcher(createRockGeometry(rng, 0.9, false), stoneMaterial, CELL_SIZE), radius: 0.9, collides: false, lift: 0 },
  ];

  context.disposables.push(stoneMaterial);

  for (let i = 0; i < 22; i++) {
    const angle = rng.range(0, Math.PI * 2);
    const radius = rng.range(8, LEVEL_HALF_EXTENT_M * 0.75);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const y = sampleGroundHeight(x, z);
    const scale = rng.range(0.6, 1.4);
    const variant = variants[rng.intRange(0, 2)];

    variant.batcher.add({
      position: new THREE.Vector3(x, y - 0.15, z),
      rotationY: rng.range(0, Math.PI * 2),
      scale,
    });

    if (variant.collides) {
      context.physics.createStaticCollider({
        shape: { kind: 'ball', radius: variant.radius * scale * 0.82 },
        translation: { x, y: y + variant.lift * scale, z },
        layer: CollisionLayer.StaticWorld,
        surfaceType: 'stone',
      });
      context.summary.staticColliderCount++;
    }
    context.summary.rockCount++;
  }

  for (const variant of variants) {
    for (const mesh of variant.batcher.build()) {
      context.scene.add(mesh);
      context.summary.drawCallEstimate++;
    }
  }
}

/**
 * Build the ruined temple: a stepped platform, six pillars, crumbling walls and broken
 * guardian statues.
 *
 * @param context - Shared build state.
 */
function buildTemple(context: BuildContext): void {
  buildTemplePlatform(context);
  buildTemplePillars(context);
  buildTempleWalls(context);
  buildTempleStatues(context);
}

/**
 * Build the temple's stepped stone platform.
 *
 * @param context - Shared build state.
 */
function buildTemplePlatform(context: BuildContext): void {
  const halfSize = 13;

  // Two stacked slabs give the silhouette a stepped edge instead of one extruded block.
  const lower = new THREE.BoxGeometry(halfSize * 2 + 2, PLATFORM_HEIGHT, halfSize * 2 + 2);
  lower.translate(0, PLATFORM_HEIGHT / 2, TEMPLE_Z);
  applyVertexColor(lower, 0xc0a273, (_x, y) => 0.82 + Math.min(0.3, y * 0.12));

  const upper = new THREE.BoxGeometry(halfSize * 2, 0.35, halfSize * 2);
  upper.translate(0, PLATFORM_HEIGHT + 0.175, TEMPLE_Z);
  applyVertexColor(upper, 0xd0b183, () => 0.98);

  const material = createPS1Material({ map: context.textures.stone });
  const mesh = new THREE.Mesh(mergeGeometries([lower, upper]), material);
  mesh.name = 'TemplePlatform';
  mesh.matrixAutoUpdate = false;
  context.scene.add(mesh);

  lower.dispose();
  upper.dispose();
  context.disposables.push(mesh.geometry, material);
  context.summary.drawCallEstimate++;

  const totalHeight = PLATFORM_HEIGHT + 0.35;
  context.physics.createStaticCollider({
    shape: {
      kind: 'cuboid',
      halfExtents: { x: halfSize + 1, y: totalHeight / 2, z: halfSize + 1 },
    },
    translation: { x: 0, y: totalHeight / 2, z: TEMPLE_Z },
    layer: CollisionLayer.StaticWorld,
    surfaceType: 'stone',
  });
  context.summary.staticColliderCount++;
}

/**
 * Build the two colonnades of pillars, with deliberately uneven heights so the ruin
 * reads as damaged rather than as a fence.
 *
 * @param context - Shared build state.
 */
function buildTemplePillars(context: BuildContext): void {
  const { rng } = context;
  const pillarHeight = 6.4;
  const material = createPS1Material({ map: context.textures.stone });
  const batcher = new InstanceBatcher(createPillarGeometry(rng, pillarHeight), material, 64);
  context.disposables.push(material);

  const heightScales = [1, 0.86, 0.72];

  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? -1 : 1;
    const index = i % 3;
    const x = side * 9.5;
    const z = TEMPLE_Z - 9 + index * 9;
    const scale = heightScales[(i + index) % 3];
    const baseY = PLATFORM_HEIGHT + 0.35;

    batcher.add({
      position: new THREE.Vector3(x, baseY, z),
      rotationY: rng.range(-0.05, 0.05),
      scale,
    });

    context.physics.createStaticCollider({
      shape: { kind: 'cylinder', halfHeight: (pillarHeight * scale) / 2, radius: 0.38 },
      translation: { x, y: baseY + (pillarHeight * scale) / 2, z },
      layer: CollisionLayer.StaticWorld,
      surfaceType: 'stone',
    });
    context.summary.staticColliderCount++;
    context.summary.pillarCount++;
  }

  for (const mesh of batcher.build()) {
    context.scene.add(mesh);
    context.summary.drawCallEstimate++;
  }
}

/**
 * Build the crumbling perimeter walls.
 *
 * @param context - Shared build state.
 */
function buildTempleWalls(context: BuildContext): void {
  const material = createPS1Material({ map: context.textures.stone });
  const wallBatcher = new InstanceBatcher(
    createRuinedWallGeometry(context.rng, 14, 4.2, 0.7),
    material,
    64,
  );
  context.disposables.push(material);

  const placements = [
    { x: -11.5, z: TEMPLE_Z + 11, rot: 0 },
    { x: 11.5, z: TEMPLE_Z + 11, rot: 0 },
    { x: -13, z: TEMPLE_Z - 2, rot: Math.PI / 2 },
    { x: 13, z: TEMPLE_Z - 2, rot: Math.PI / 2 },
    { x: 0, z: TEMPLE_Z - 13.5, rot: 0 },
  ];

  const baseY = PLATFORM_HEIGHT + 0.35;

  for (const placement of placements) {
    wallBatcher.add({
      position: new THREE.Vector3(placement.x, baseY, placement.z),
      rotationY: placement.rot,
      scale: 1,
    });

    // Axis-aligned boxes sized to the wall's length along its rotated axis.
    const alongX = Math.abs(Math.cos(placement.rot)) > 0.5;
    context.physics.createStaticCollider({
      shape: {
        kind: 'cuboid',
        halfExtents: alongX ? { x: 7, y: 1.7, z: 0.4 } : { x: 0.4, y: 1.7, z: 7 },
      },
      translation: { x: placement.x, y: baseY + 1.7, z: placement.z },
      layer: CollisionLayer.StaticWorld,
      surfaceType: 'stone',
    });
    context.summary.staticColliderCount++;
    context.summary.wallCount++;
  }

  for (const mesh of wallBatcher.build()) {
    context.scene.add(mesh);
    context.summary.drawCallEstimate++;
  }
}

/**
 * Place the headless guardian statues flanking the temple approach.
 *
 * Environmental storytelling (GDD §12): the missing heads imply a previous visitor.
 *
 * @param context - Shared build state.
 */
function buildTempleStatues(context: BuildContext): void {
  const material = createPS1Material({ map: context.textures.stone });
  const batcher = new InstanceBatcher(createBrokenStatueGeometry(context.rng), material, 64);
  context.disposables.push(material);

  for (let i = 0; i < 4; i++) {
    const side = i < 2 ? -1 : 1;
    const index = i % 2;
    const x = side * (5.5 + index * 3.5);
    const z = TEMPLE_Z + 15 + index * 3;
    const y = sampleGroundHeight(x, z);

    batcher.add({
      position: new THREE.Vector3(x, y, z),
      rotationY: side > 0 ? Math.PI : 0,
      scale: context.rng.range(0.9, 1.15),
    });

    context.physics.createStaticCollider({
      shape: { kind: 'cylinder', halfHeight: 1.1, radius: 0.6 },
      translation: { x, y: y + 1.0, z },
      layer: CollisionLayer.StaticWorld,
      surfaceType: 'stone',
    });
    context.summary.staticColliderCount++;
    context.summary.statueCount++;
  }

  for (const mesh of batcher.build()) {
    context.scene.add(mesh);
    context.summary.drawCallEstimate++;
  }
}

/**
 * Build the water pool.
 *
 * Visual only in Milestone 1.1. The buoyancy volume, air meter and the valve mechanic
 * arrive with the Zone 3 puzzle system, and stubbing them here would imply a
 * completeness this milestone does not have.
 *
 * @param context - Shared build state.
 */
function buildWater(context: BuildContext): void {
  const geometry = new THREE.PlaneGeometry(26, 18, 8, 6);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(26, -0.45, -6);
  applyVertexColor(geometry, 0xffffff, () => 1);

  const material = createPS1Material({ map: context.textures.water });
  context.textures.water.repeat.set(6, 4);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'WaterPool';
  mesh.matrixAutoUpdate = false;
  // Drawn after opaque geometry so the transparent-looking surface sorts predictably,
  // even though the material itself is opaque.
  mesh.renderOrder = 10;
  context.scene.add(mesh);
  context.disposables.push(geometry, material);
  context.summary.drawCallEstimate++;
}

/**
 * Choose the player's spawn point on the temple's approach line, so the goal is visible
 * from the very first frame.
 *
 * @param context - Shared build state.
 */
function placeSpawn(context: BuildContext): void {
  const x = 0;
  const z = 42;
  // Lifted clear of the surface: the character controller is what places the player on
  // the ground, and spawning flush would risk the first tick resolving inside geometry.
  context.summary.spawnPoint.set(x, sampleGroundHeight(x, z) + 1.2, z);
}
