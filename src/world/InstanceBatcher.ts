/**
 * Per-cell instanced batching.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE CULLING PROBLEM THIS SOLVES (risk R1, docs/ARCHITECTURE.md §6.6)
 * ────────────────────────────────────────────────────────────────────────────────
 * A `THREE.InstancedMesh` is a single draw call — excellent — but three.js culls it
 * as a *single object* against the whole mesh's bounding sphere. Put two hundred trees
 * in one InstancedMesh and, the moment one tree is on screen, every tree in the level
 * is drawn. That is the classic "instancing made my frame rate worse" trap.
 *
 * The fix is to instance *per spatial cell*. Each cell gets its own InstancedMesh with
 * a tight bounding sphere, so three.js' ordinary per-object frustum test rejects whole
 * cells at once. Draw calls rise slightly (one per visible cell per prop type) while
 * submitted vertex work falls by an order of magnitude in any scene where the player is
 * looking at a fraction of the level.
 *
 * With a 32 m cell covering a 240x240 m level there are at most 64 cells; in practice a
 * 60° camera sees two to four of them. The trade is unambiguously worth it.
 *
 * Occlusion is *not* handled here. It is authored through zone portals and occluder
 * volumes, because predictable frame times matter more than clever visibility for a
 * hand-built level.
 */

import * as THREE from 'three';

/** An instance transform, in the compact form the batcher consumes. */
export interface InstanceTransform {
  position: THREE.Vector3;
  /** Y-axis rotation in radians. Props are never rotated off-axis: it looks wrong. */
  rotationY: number;
  /** Uniform scale. Non-uniform scaling breaks the vertex normals. */
  scale: number;
}

/**
 * Accumulates instances of one geometry and emits per-cell `InstancedMesh` batches.
 *
 * Usage is deliberately two-phase — `add()` everything, then `build()` once — because
 * the cell grouping depends on the full extent of the instances.
 */
export class InstanceBatcher {
  private readonly instances: InstanceTransform[] = [];

  /**
   * @param geometry - The shared geometry every instance uses.
   * @param material - The shared material every instance uses.
   * @param cellSize - Spatial cell edge length in metres. See the class notes for the
   *   reasoning behind the default.
   */
  constructor(
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly cellSize: number = 32,
  ) {}

  /**
   * Register one instance.
   *
   * @param transform - Position, Y rotation and uniform scale.
   */
  add(transform: InstanceTransform): void {
    this.instances.push(transform);
  }

  /** How many instances have been registered. */
  public get count(): number {
    return this.instances.length;
  }

  /**
   * Create the per-cell batches.
   *
   * @returns One `InstancedMesh` per occupied cell. Returns an empty array when no
   *   instances were registered, rather than a mesh with zero instances (which would
   *   still be submitted to the renderer).
   */
  public build(): THREE.InstancedMesh[] {
    if (this.instances.length === 0) {
      return [];
    }

    // Group instances by cell key. A string key is used for Map identity; the grid is
    // small enough that the string allocation is irrelevant at load time.
    const cells = new Map<string, InstanceTransform[]>();
    for (const instance of this.instances) {
      const cellX = Math.floor(instance.position.x / this.cellSize);
      const cellZ = Math.floor(instance.position.z / this.cellSize);
      const key = `${cellX},${cellZ}`;
      const bucket = cells.get(key);
      if (bucket) {
        bucket.push(instance);
      } else {
        cells.set(key, [instance]);
      }
    }

    const meshes: THREE.InstancedMesh[] = [];

    for (const bucket of cells.values()) {
      const mesh = new THREE.InstancedMesh(this.geometry, this.material, bucket.length);
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const scaleVector = new THREE.Vector3();

      for (let i = 0; i < bucket.length; i++) {
        const instance = bucket[i];
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), instance.rotationY);
        scaleVector.setScalar(instance.scale);
        matrix.compose(instance.position, quaternion, scaleVector);
        mesh.setMatrixAt(i, matrix);
      }

      mesh.instanceMatrix.needsUpdate = true;

      // Explicit bounding sphere rather than relying on three's computed value: a
      // wrong or stale bounding sphere silently defeats frustum culling, which is the
      // exact failure this class exists to prevent.
      mesh.computeBoundingSphere();

      // Static geometry: telling three.js this is never re-uploaded saves a per-frame
      // buffer usage hint update.
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;

      meshes.push(mesh);
    }

    return meshes;
  }
}
