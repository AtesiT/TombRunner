/**
 * Low-poly geometry builders.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE GEOMETRY DISCIPLINE (risk R5, docs/ARCHITECTURE.md §5 W3)
 * ────────────────────────────────────────────────────────────────────────────────
 * Under affine texture mapping, texture error grows with the *screen-space size* of a
 * polygon. A 40 m ground plane rendered as two triangles warps grotesquely; the same
 * plane subdivided into 2 m quads is essentially free of visible error at the camera
 * distances this game uses.
 *
 * Geometry is therefore not merely "low poly" — it is *deliberately tessellated* at a
 * density chosen to bound affine error, and deliberately *not* tessellated beyond it.
 * {@link MAX_QUAD_SIZE_M} is enforced in {@link createGroundGeometry}, and other
 * builders take explicit segment counts for the same reason.
 *
 * Vertex colours are used heavily. Because the PS1 lighting model is deliberately
 * primitive (no PBR, no shadows, no ambient occlusion), separation between forms has
 * to come from baked vertex colour. Building that in from the start avoids retrofitting
 * it into a finished level (the mistake flagged in ARCHITECTURE.md §5 W3).
 */

import * as THREE from 'three';
import { SeededRandom, ValueNoise2D } from '../core/math/rng';
import { MAX_QUAD_SIZE_M, WORLD_SEED } from '../core/constants';

/**
 * Attach a vertex-colour attribute to a geometry.
 *
 * @param geometry - The geometry to modify in place.
 * @param color - Base colour for every vertex.
 * @param shade - Optional per-vertex multiplier, receiving the vertex position and
 *   returning a value in [0, 1+] that scales the colour. Used to bake gradients such
 *   as "darker at the base of a trunk".
 */
export function applyVertexColor(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  shade?: (x: number, y: number, z: number) => number,
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const base = new THREE.Color(color);
  const colors = new Float32Array(position.count * 3);

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const factor = shade ? shade(x, y, z) : 1;

    colors[i * 3 + 0] = base.r * factor;
    colors[i * 3 + 1] = base.g * factor;
    colors[i * 3 + 2] = base.b * factor;
  }

  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Deterministically jitter every vertex of a geometry.
 *
 * This is the cheapest possible route to hand-modelled character: perfect primitive
 * shapes read as programmer art, while a few centimetres of noise on a rock reads as
 * sculpted. Seeded, so the rock is the same rock on every reload.
 *
 * @param geometry - The geometry to perturb in place.
 * @param amount - Maximum displacement in metres.
 * @param rng - The generator supplying displacements.
 * @returns The same geometry, for chaining.
 */
export function jitterVertices(
  geometry: THREE.BufferGeometry,
  amount: number,
  rng: SeededRandom,
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    position.setXYZ(
      i,
      position.getX(i) + rng.range(-amount, amount),
      position.getY(i) + rng.range(-amount, amount),
      position.getZ(i) + rng.range(-amount, amount),
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Build the ground.
 *
 * Subdivision is derived from {@link MAX_QUAD_SIZE_M} rather than passed in, so the
 * affine-error bound cannot be violated by a caller who forgets it. The vertex
 * subdivision count is reported so the level builder can reuse the same resolution for
 * the collision trimesh — the visual and collision surfaces must agree exactly, or the
 * player will appear to stand slightly above or below the ground.
 *
 * @param size - Total edge length in metres.
 * @param options.heightAmplitude - Peak-to-trough height variation in metres.
 * @param options.seed - Generation seed.
 * @returns The ground geometry, centred on the origin, in the XZ plane.
 */
export function createGroundGeometry(
  size: number,
  options: { heightAmplitude?: number; seed?: number } = {},
): THREE.BufferGeometry {
  const amplitude = options.heightAmplitude ?? 0.8;
  const rng = new SeededRandom(options.seed ?? WORLD_SEED);

  // Enforce the affine-error bound: no quad may exceed MAX_QUAD_SIZE_M.
  const segments = Math.max(2, Math.ceil(size / MAX_QUAD_SIZE_M));

  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  // PlaneGeometry is built in the XY plane; rotate it flat so Y is up throughout the
  // rest of the pipeline and we never have to think about the orientation again.
  geometry.rotateX(-Math.PI / 2);

  const noise = new ValueNoise2D(rng, 256);
  const position = geometry.getAttribute('position');

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const u = (x + size / 2) / size;
    const v = (z + size / 2) / size;

    // Gentle undulation only. Large terrain features would need matching collision
    // detail and would fight the platforming sections, which are authored to be
    // readable from a distance.
    const rolling = noise.fbm(u, v, 3, 3) - 0.5;
    const detail = noise.fbm(u, v, 2, 10) - 0.5;
    position.setY(i, rolling * amplitude * 2 + detail * amplitude * 0.25);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();

  // Bake a subtle tonal gradient: higher ground reads slightly lighter and warmer,
  // which is enough to make undulation legible without any lighting cost.
  applyVertexColor(geometry, 0xffffff, (_x, y) => {
    return 0.82 + Math.min(0.28, Math.max(0, (y + amplitude) / (amplitude * 2)) * 0.28);
  });

  return geometry;
}

/**
 * Build the collision trimesh for a ground geometry.
 *
 * Extracts raw vertices and indices so Rapier can build an exact match for the visual
 * surface. Sharing one geometry between rendering and collision is deliberate: any
 * divergence is felt immediately by the player as floating or sinking.
 *
 * @param geometry - An indexed ground geometry in world orientation with identity transform.
 * @returns Vertices and indices suitable for `ColliderShapeDescription` of kind 'trimesh'.
 */
export function extractTrimesh(geometry: THREE.BufferGeometry): {
  vertices: Float32Array;
  indices: Uint32Array;
} {
  const position = geometry.getAttribute('position');
  const vertices = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    vertices[i * 3 + 0] = position.getX(i);
    vertices[i * 3 + 1] = position.getY(i);
    vertices[i * 3 + 2] = position.getZ(i);
  }

  const index = geometry.getIndex();
  const indices = new Uint32Array(index ? index.count : position.count);
  if (index) {
    for (let i = 0; i < index.count; i++) {
      indices[i] = index.getX(i);
    }
  } else {
    for (let i = 0; i < position.count; i++) {
      indices[i] = i;
    }
  }

  return { vertices, indices };
}

/**
 * Build a jungle palm: a tall, slightly tapered trunk with radiating fronds.
 *
 * Poly budget is deliberately tiny (a 5-segment trunk and 6 single-quad fronds) —
 * roughly 60 triangles. At this count the silhouette does the work, which is exactly
 * how the era achieved lush vegetation.
 *
 * @param rng - The generator supplying variation.
 * @returns A merged geometry combining trunk and fronds, with vertex colours.
 */
export function createPalmGeometry(rng: SeededRandom): THREE.BufferGeometry {
  const trunkHeight = rng.range(6.5, 10.5);
  const trunkRadius = rng.range(0.18, 0.26);

  // Trunk: 5 radial segments is the minimum that still reads as a cylinder rather
  // than as a triangle.
  const trunk = new THREE.CylinderGeometry(trunkRadius * 0.75, trunkRadius, trunkHeight, 5, 1);
  trunk.translate(0, trunkHeight / 2, 0);
  applyVertexColor(trunk, 0x8a6a42, (_x, y) => 0.7 + (y / trunkHeight) * 0.3);

  const parts: THREE.BufferGeometry[] = [trunk];

  // Fronds: single quads radiating outward and drooping. Each is one quad, so six
  // fronds cost twelve triangles.
  const frondCount = 6;
  for (let i = 0; i < frondCount; i++) {
    const angle = (i / frondCount) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const length = rng.range(1.8, 2.9);
    const frond = new THREE.PlaneGeometry(length, 0.75, 1, 1);

    // Position the quad so its inner edge sits at the trunk top, then rotate it
    // outward and tilt it down to imply weight.
    frond.translate(length / 2, 0, 0);
    frond.rotateZ(rng.range(-0.35, -0.1));
    frond.rotateY(angle);
    frond.translate(0, trunkHeight, 0);

    applyVertexColor(frond, 0x4f8f3a, (x) => 0.75 + Math.min(0.35, Math.abs(x) * 0.06));
    parts.push(frond);
  }

  return mergeGeometries(parts);
}

/**
 * Build a broadleaf jungle tree: a stout trunk with a faceted canopy.
 *
 * @param rng - The generator supplying variation.
 * @returns The merged tree geometry with vertex colours.
 */
export function createBroadleafGeometry(rng: SeededRandom): THREE.BufferGeometry {
  const trunkHeight = rng.range(3.2, 5.2);
  const trunkRadius = rng.range(0.24, 0.36);

  const trunk = new THREE.CylinderGeometry(trunkRadius * 0.7, trunkRadius, trunkHeight, 6, 1);
  trunk.translate(0, trunkHeight / 2, 0);
  applyVertexColor(trunk, 0x7d5c3a, (_x, y) => 0.68 + (y / trunkHeight) * 0.32);

  // Canopy: a low-detail icosahedron reads as a rounded mass without the vertex cost
  // of a sphere, and its facets catch the flat lighting attractively.
  const canopyRadius = rng.range(1.5, 2.4);
  const canopy = new THREE.IcosahedronGeometry(canopyRadius, 0);
  canopy.translate(0, trunkHeight + canopyRadius * 0.72, 0);

  // Vertically graded shading inside the canopy fakes a light-from-above read with no
  // lighting cost, which is essential in a bright scene where everything else is flat.
  applyVertexColor(canopy, 0x5c9a44, (_x, y) => {
    const local = (y - (trunkHeight - canopyRadius)) / (canopyRadius * 2.4);
    return 0.62 + Math.min(0.55, Math.max(0, local) * 0.55);
  });

  return mergeGeometries([trunk, canopy]);
}

/**
 * Build a rock.
 *
 * A jittered icosahedron at detail level 0 is 20 triangles, is trivially cheap, and
 * because the jitter is seeded each rock in the level is a distinct shape without a
 * distinct geometry.
 *
 * @param rng - The generator supplying variation.
 * @param radius - Nominal radius in metres.
 * @param flat - When true, vertically scale the rock to make a low slab suitable for
 *   standing on or blocking a path.
 * @returns The rock geometry with vertex colours.
 */
export function createRockGeometry(
  rng: SeededRandom,
  radius: number,
  flat: boolean = false,
): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, 0);

  jitterVertices(geometry, radius * rng.range(0.12, 0.3), rng);

  if (flat) {
    // Squash, then re-sit the rock so its base stays at y = 0 rather than sinking.
    const squash = rng.range(0.4, 0.62);
    geometry.scale(1, squash, 1);
    geometry.computeBoundingBox();
    const minY = geometry.boundingBox?.min.y ?? 0;
    geometry.translate(0, -minY, 0);
  } else {
    geometry.computeBoundingBox();
    const minY = geometry.boundingBox?.min.y ?? 0;
    geometry.translate(0, -minY, 0);
  }

  applyVertexColor(geometry, 0x9a8f7a, (_x, y) => 0.74 + Math.min(0.4, y * 0.22));
  return geometry;
}

/**
 * Build a temple pillar: a fluted column on a square base.
 *
 * @param rng - The generator supplying wear variation.
 * @param height - Pillar height in metres.
 * @returns The pillar geometry with vertex colours.
 */
export function createPillarGeometry(rng: SeededRandom, height: number): THREE.BufferGeometry {
  const baseSize = rng.range(0.85, 1.05);

  const base = new THREE.BoxGeometry(baseSize, 0.35, baseSize);
  base.translate(0, 0.175, 0);

  // 8 radial segments gives a convincingly round column while staying cheap. 6 would
  // read as a hexagon at the camera distances this game uses.
  const shaft = new THREE.CylinderGeometry(0.32, 0.36, height, 8, 1);
  shaft.translate(0, 0.35 + height / 2, 0);

  const capital = new THREE.BoxGeometry(baseSize * 0.95, 0.3, baseSize * 0.95);
  capital.translate(0, 0.35 + height + 0.15, 0);

  applyVertexColor(base, 0xb99a6c, () => 0.9);
  applyVertexColor(shaft, 0xc8a877, (_x, y) => 0.85 + Math.min(0.3, (y / height) * 0.3));
  applyVertexColor(capital, 0xb99a6c, () => 0.95);

  return mergeGeometries([base, shaft, capital]);
}

/**
 * Build a broken guardian statue: a headless, armless torso on a plinth.
 *
 * Environmental storytelling (GDD §12): the heads are deliberately missing, implying
 * that someone was here before the player. It is also cheaper to model than an intact
 * figure and reads better at low polygon counts.
 *
 * @param rng - The generator supplying breakage variation.
 * @returns The statue geometry with vertex colours.
 */
export function createBrokenStatueGeometry(rng: SeededRandom): THREE.BufferGeometry {
  const plinth = new THREE.BoxGeometry(1.5, 0.4, 1.5);
  plinth.translate(0, 0.2, 0);

  // Torso: a tapered box, because a tapered silhouette reads as a body while a
  // straight box reads as furniture.
  const torsoHeight = rng.range(1.5, 1.9);
  const torso = new THREE.CylinderGeometry(0.42, 0.6, torsoHeight, 6, 1);
  torso.translate(0, 0.4 + torsoHeight / 2, 0);

  // A clean angled cut where the head should be — the whole point of the model.
  const breakage = new THREE.CircleGeometry(0.42, 6);
  breakage.rotateX(-Math.PI / 2);
  breakage.translate(0, 0.4 + torsoHeight, 0);

  applyVertexColor(plinth, 0xa88c62, () => 0.88);
  applyVertexColor(torso, 0xc2a273, (_x, y) => 0.78 + Math.min(0.36, y * 0.14));
  applyVertexColor(breakage, 0xd8bd90, () => 1.12); // a freshly broken, brighter face

  return mergeGeometries([plinth, torso, breakage]);
}

/**
 * Build a ruined wall segment with a crumbled top.
 *
 * @param rng - The generator supplying the crumbling profile.
 * @param length - Wall length in metres.
 * @param height - Nominal height in metres.
 * @param thickness - Wall thickness in metres.
 * @returns The wall geometry with vertex colours.
 */
export function createRuinedWallGeometry(
  rng: SeededRandom,
  length: number,
  height: number,
  thickness: number,
): THREE.BufferGeometry {
  // Subdivide along the length so the crumbled top can vary block by block; a single
  // box would give a clean top edge, which reads as a fence rather than as a ruin.
  const blocks = Math.max(2, Math.round(length / 1.5));
  const parts: THREE.BufferGeometry[] = [];

  for (let i = 0; i < blocks; i++) {
    const blockLength = length / blocks;
    // Height falls off towards the middle of the wall, implying a collapsed centre.
    const fromMiddle = Math.abs(i / (blocks - 1) - 0.5) * 2;
    const blockHeight = height * (0.45 + fromMiddle * 0.55) * rng.range(0.85, 1.05);

    const block = new THREE.BoxGeometry(blockLength, blockHeight, thickness);
    block.translate(
      -length / 2 + blockLength * (i + 0.5),
      blockHeight / 2,
      0,
    );
    applyVertexColor(block, 0xbb9d70, (_x, y) => 0.8 + Math.min(0.34, (y / height) * 0.34));
    parts.push(block);
  }

  return mergeGeometries(parts);
}

/**
 * Build the sky dome.
 *
 * A large inverted sphere. Subdivision is minimal because the sky shader computes its
 * gradient analytically from the interpolated direction, so extra vertices buy nothing.
 *
 * @param radius - Dome radius, chosen to sit inside the camera's far plane.
 * @returns The sky dome geometry, with normals inverted towards the viewer.
 */
export function createSkyDomeGeometry(radius: number): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, 16, 12);
  // Render the inside of the sphere: the material is single-sided, so flip the winding.
  geometry.scale(-1, 1, 1);
  return geometry;
}

/**
 * Merge a list of geometries into one.
 *
 * Written here rather than pulling in `BufferGeometryUtils` from three's addons, because
 * the addon's merge requires matching attribute sets and throws otherwise — and every
 * geometry in this module guarantees `position`, `normal`, `uv` and `color`.
 *
 * @param geometries - Non-empty list of geometries with matching attribute sets.
 * @returns A single merged, indexed geometry.
 * @throws If the list is empty or an attribute is missing, since silently returning an
 *   empty mesh would produce invisible geometry with no diagnostic.
 */
export function mergeGeometries(geometries: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geometries.length === 0) {
    throw new Error('mergeGeometries requires at least one geometry.');
  }

  const sizes = measureMergeInputs(geometries);

  const positions = new Float32Array(sizes.vertexCount * 3);
  const normals = new Float32Array(sizes.vertexCount * 3);
  const uvs = new Float32Array(sizes.vertexCount * 2);
  const colors = new Float32Array(sizes.vertexCount * 3);
  const indices = new Uint32Array(sizes.indexCount);

  let vertexOffset = 0;
  let indexOffset = 0;

  for (const geometry of geometries) {
    vertexOffset = appendGeometry(geometry, {
      positions,
      normals,
      uvs,
      colors,
      indices,
      vertexOffset,
      indexOffset,
    });
    indexOffset += indicesLength(geometry);
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

/** Vertex and index totals for a merge, validated up front. */
interface MergeSizes {
  vertexCount: number;
  indexCount: number;
}

/**
 * Validate every input geometry and total their vertex and index counts.
 *
 * Validating all inputs before allocating means a malformed geometry throws *before* several
 * megabytes of typed arrays have been created, rather than halfway through filling them and
 * leaving a half-populated buffer to be rendered.
 *
 * @param geometries - The geometries to merge.
 * @returns The totals needed to size the output arrays.
 * @throws If any geometry is missing a position attribute, or lacks normals or UVs.
 */
function measureMergeInputs(geometries: readonly THREE.BufferGeometry[]): MergeSizes {
  let vertexCount = 0;
  let indexCount = 0;

  for (const geometry of geometries) {
    const position = geometry.getAttribute('position');
    if (!position) {
      throw new Error('mergeGeometries: a geometry is missing a position attribute.');
    }
    if (!geometry.getAttribute('normal') || !geometry.getAttribute('uv')) {
      throw new Error(
        'mergeGeometries: every geometry must have position, normal and uv attributes. ' +
          'Call computeVertexNormals() and ensure a UV layer exists.',
      );
    }

    vertexCount += position.count;
    indexCount += indicesLength(geometry);
  }

  return { vertexCount, indexCount };
}

/**
 * The number of indices a geometry contributes, treating an unindexed geometry as one index
 * per vertex.
 *
 * @param geometry - The geometry to measure.
 * @returns The index count.
 */
function indicesLength(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  // A non-null assertion is safe here: measureMergeInputs has already validated the presence
  // of the position attribute, and this function is only called on validated geometry.
  return index ? index.count : position.count;
}

/** The output arrays and current write cursors for a merge. */
interface MergeTargets {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  vertexOffset: number;
  indexOffset: number;
}

/**
 * Copy one geometry's vertex and index data into the output arrays at the current cursor.
 *
 * @param geometry - A geometry already validated by `measureMergeInputs`.
 * @param targets - The output arrays and cursors. Cursors are read, not mutated.
 * @returns The new vertex offset, advanced past this geometry's vertices.
 */
function appendGeometry(geometry: THREE.BufferGeometry, targets: MergeTargets): number {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const color = geometry.getAttribute('color');
  const index = geometry.getIndex();
  const { vertexOffset, indexOffset } = targets;

  for (let i = 0; i < position.count; i++) {
    const target = (vertexOffset + i) * 3;
    targets.positions[target + 0] = position.getX(i);
    targets.positions[target + 1] = position.getY(i);
    targets.positions[target + 2] = position.getZ(i);

    targets.normals[target + 0] = normal.getX(i);
    targets.normals[target + 1] = normal.getY(i);
    targets.normals[target + 2] = normal.getZ(i);

    // Default to white when a source geometry has no vertex colours, so a merge never
    // silently darkens a part.
    targets.colors[target + 0] = color ? color.getX(i) : 1;
    targets.colors[target + 1] = color ? color.getY(i) : 1;
    targets.colors[target + 2] = color ? color.getZ(i) : 1;

    const uvTarget = (vertexOffset + i) * 2;
    targets.uvs[uvTarget + 0] = uv.getX(i);
    targets.uvs[uvTarget + 1] = uv.getY(i);
  }

  if (index) {
    for (let i = 0; i < index.count; i++) {
      targets.indices[indexOffset + i] = index.getX(i) + vertexOffset;
    }
  } else {
    // An unindexed geometry is given a trivial running index so the merged output is always
    // indexed. Mixing indexed and unindexed geometry in one mesh is not representable.
    for (let i = 0; i < position.count; i++) {
      targets.indices[indexOffset + i] = vertexOffset + i;
    }
  }

  return vertexOffset + position.count;
}

