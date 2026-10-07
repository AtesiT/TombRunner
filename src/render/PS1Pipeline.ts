/**
 * The PS1 rendering pipeline.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * PASS STRUCTURE
 * ────────────────────────────────────────────────────────────────────────────────
 *   Pass 1  Scene   -> 480x270 render target     (world shader: snap, affine, light)
 *   Pass 2  Palette -> 480x270 secondary target  (ordered dither + quantisation)
 *   Pass 3  Blit    -> canvas, integer-scaled    (nearest-neighbour, letterboxed)
 *
 * Palette quantisation is a separate pass rather than part of the world shader for
 * three reasons: it runs once over 129,600 fragments instead of once per object with
 * overdraw; it quantises the *composited* frame, which is what period hardware
 * actually did; and it keeps the world shader's responsibilities narrow enough to
 * audit against the TypeScript reference implementation.
 *
 * Pass 3 exists because the canvas must be presented at an integer multiple of the
 * internal resolution. A fractional scale would make some rows and columns thicker
 * than others, destroying the crisp-pixel look that justifies the low-res target.
 *
 * CULLING: static geometry is culled per uniform-grid cell (see `src/world/SpatialGrid`)
 * before the renderer's own per-object frustum test. Occlusion is *authored* through
 * zone portal volumes rather than computed, because a hand-authored level benefits far
 * more from predictable frame times than from clever visibility (risk R1).
 */

import * as THREE from 'three';
import {
  BLIT_FRAGMENT_SHADER,
  FULLSCREEN_VERTEX_SHADER,
  PALETTE_FRAGMENT_SHADER,
} from './shaders/ps1World';
import {
  PALETTE_DITHER_ENABLED,
  PALETTE_LEVELS,
  RENDER_TARGET_HEIGHT,
  RENDER_TARGET_WIDTH,
} from '../core/constants';
import { computeLetterboxRect } from '../core/math/ps1';
import { buildBayerTexture } from '../world/textures';

/** Result of a {@link PS1Pipeline.render} call, used by debug overlays. */
export interface FrameStats {
  /** Internal render target size. */
  internalWidth: number;
  internalHeight: number;
  /** Presented rectangle on the canvas, in CSS pixels. */
  presentedWidth: number;
  presentedHeight: number;
  /** Integer scale factor applied during the blit. */
  scale: number;
}

/**
 * Owns the low-resolution render targets, the full-screen passes and the presentation
 * quad. One instance per game; it is explicitly disposable so that a canvas resize or
 * a device-loss recovery can rebuild the targets without leaking GPU memory.
 */
export class PS1Pipeline {
  /** Internal resolution. Mutable so the options menu can offer 320x240. */
  public internalWidth: number;
  public internalHeight: number;

  private readonly renderer: THREE.WebGLRenderer;

  /** Pass 1 destination: the world at low resolution. */
  private sceneTarget: THREE.WebGLRenderTarget;

  /** Pass 2 destination: the dithered, palette-quantised frame. */
  private paletteTarget: THREE.WebGLRenderTarget;

  /** Reusable full-screen quad geometry. Never rebuilt; only its material changes. */
  private readonly fullscreenGeometry: THREE.BufferGeometry;

  private readonly paletteMaterial: THREE.ShaderMaterial;
  private readonly blitMaterial: THREE.ShaderMaterial;
  private readonly bayerTexture: THREE.DataTexture;

  /**
   * A pair of cameras and a throwaway scene for the full-screen passes.
   *
   * Using a real `THREE.Scene` rather than a manual `renderer.render` call keeps the
   * pipeline inside three.js' normal state management (correct program binding, auto
   * target clearing) instead of fighting it with raw GL calls.
   */
  private readonly fullscreenScene: THREE.Scene;
  private readonly fullscreenCamera: THREE.OrthographicCamera;
  private readonly fullscreenQuad: THREE.Mesh;

  /** Cached canvas size, used to skip redundant resize work. */
  private lastCanvasWidth = 0;
  private lastCanvasHeight = 0;

  /** Statistics from the most recent render, for the debug overlay. */
  private lastStats: FrameStats;

  /**
   * @param renderer - The WebGL renderer. Assumed to already be sized to the canvas.
   * @param options.width - Internal width in pixels.
   * @param options.height - Internal height in pixels.
   */
  constructor(
    renderer: THREE.WebGLRenderer,
    options: { width?: number; height?: number } = {},
  ) {
    this.renderer = renderer;
    this.internalWidth = options.width ?? RENDER_TARGET_WIDTH;
    this.internalHeight = options.height ?? RENDER_TARGET_HEIGHT;

    this.sceneTarget = this.createRenderTarget(this.internalWidth, this.internalHeight, 'SceneTarget');
    this.paletteTarget = this.createRenderTarget(this.internalWidth, this.internalHeight, 'PaletteTarget');

    // The Bayer table is uploaded once and never changes; a texture lookup is used
    // instead of a GLSL const array because GLSL ES 1.00 does not support array
    // constructors, and because it guarantees the shader's matrix is identical to the
    // unit-tested TypeScript version.
    this.bayerTexture = buildBayerTexture();
    this.bayerTexture.needsUpdate = true;

    // A single quad, drawn three times with different materials. Positions are in
    // clip space already, so the fullscreen vertex shader is a pure pass-through and
    // the orthographic camera is only there to satisfy the render call.
    this.fullscreenGeometry = new THREE.BufferGeometry();
    this.fullscreenGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    this.fullscreenGeometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2),
    );
    // A single oversized triangle covers the viewport with three vertices instead of
    // six, and avoids the diagonal seam a two-triangle quad can show under some
    // rasterisers.

    this.paletteMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX_SHADER,
      fragmentShader: PALETTE_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSource: { value: this.sceneTarget.texture },
        uDitherTable: { value: this.bayerTexture },
        uPaletteLevels: { value: PALETTE_LEVELS },
        uDitherAmount: { value: PALETTE_DITHER_ENABLED ? 1 : 0 },
      },
    });

    this.blitMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX_SHADER,
      fragmentShader: BLIT_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uSource: { value: this.paletteTarget.texture },
      },
    });

    this.fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fullscreenScene = new THREE.Scene();
    this.fullscreenQuad = new THREE.Mesh(this.fullscreenGeometry, this.blitMaterial);
    this.fullscreenQuad.frustumCulled = false;
    this.fullscreenScene.add(this.fullscreenQuad);

    this.lastStats = {
      internalWidth: this.internalWidth,
      internalHeight: this.internalHeight,
      presentedWidth: 0,
      presentedHeight: 0,
      scale: 1,
    };
  }

  /**
   * Create a render target configured for the PS1 look.
   *
   * Nearest filtering throughout: any smoothing between texels would undo the crisp
   * low-resolution presentation. Depth is enabled only for the world pass; the
   * full-screen passes run with depth testing disabled so a stale depth buffer can
   * never discard the presentation triangle.
   *
   * @param width - Target width in pixels.
   * @param height - Target height in pixels.
   * @param name - Debug name, surfaced in GPU frame captures.
   * @returns The configured render target.
   */
  private createRenderTarget(width: number, height: number, name: string): THREE.WebGLRenderTarget {
    const target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    target.texture.name = name;
    return target;
  }

  /** The texture holding the rendered world, for post effects or debug display. */
  public get sceneTexture(): THREE.Texture {
    return this.sceneTarget.texture;
  }

  /** Statistics from the most recent {@link render} call. */
  public get stats(): Readonly<FrameStats> {
    return this.lastStats;
  }

  /**
   * Resize the internal render targets.
   *
   * Called when the resolution option changes. Deliberately separate from
   * {@link setCanvasSize} so that a window resize (which changes only the presented
   * scale) does not force a reallocation of the targets.
   *
   * @param width - New internal width in pixels.
   * @param height - New internal height in pixels.
   */
  public setInternalResolution(width: number, height: number): void {
    if (width === this.internalWidth && height === this.internalHeight) {
      return;
    }

    this.internalWidth = width;
    this.internalHeight = height;

    // Dispose before reallocating: `setSize` on an existing target reallocates the
    // GPU texture, but being explicit prevents a leaked attachment if this is ever
    // called after a context loss, where the old handles are already invalid.
    this.sceneTarget.dispose();
    this.paletteTarget.dispose();
    this.sceneTarget = this.createRenderTarget(width, height, 'SceneTarget');
    this.paletteTarget = this.createRenderTarget(width, height, 'PaletteTarget');

    // Rebind the pass materials to the new textures.
    this.paletteMaterial.uniforms.uSource.value = this.sceneTarget.texture;
    this.blitMaterial.uniforms.uSource.value = this.paletteTarget.texture;
  }

  /**
   * Match the renderer's drawing buffer to the canvas's CSS size.
   *
   * Uses integer device pixels and caches the result, because assigning `canvas.width`
   * every frame is a surprisingly expensive way to clear the drawing buffer.
   *
   * @param maxPixelRatio - Upper bound on device pixel ratio, to protect fill rate.
   * @returns True if the canvas size changed on this call.
   */
  public setCanvasSize(maxPixelRatio: number = 2): boolean {
    const canvas = this.renderer.domElement;
    const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));

    if (width === this.lastCanvasWidth && height === this.lastCanvasHeight) {
      return false;
    }

    this.lastCanvasWidth = width;
    this.lastCanvasHeight = height;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width / ratio, height / ratio, false);
    return true;
  }

  /**
   * Render a frame.
   *
   * The world is rendered at the internal resolution and then upscaled as an integer
   * multiple of that resolution, centred and letterboxed. The letterbox comes from the
   * canvas clear colour showing through where the quad does not cover, which is why
   * the presented rectangle is restricted with the scissor test rather than being
   * stretched to fill.
   *
   * @param scene - The world scene.
   * @param camera - The world camera.
   * @returns Statistics for the frame, including the applied integer scale.
   */
  public render(scene: THREE.Scene, camera: THREE.Camera): FrameStats {
    const renderer = this.renderer;
    const canvasWidth = this.lastCanvasWidth || 1;
    const canvasHeight = this.lastCanvasHeight || 1;

    // ---- Pass 1: world into the low-resolution target ----
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    // ---- Pass 2: palette quantisation + dither ----
    this.fullscreenQuad.material = this.paletteMaterial;
    renderer.setRenderTarget(this.paletteTarget);
    renderer.clear(true, false, false);
    renderer.render(this.fullscreenScene, this.fullscreenCamera);

    // ---- Pass 3: integer-scaled blit to the canvas ----
    // The scissor rectangle performs the letterboxing: clearing outside it leaves the
    // canvas clear colour as the letterbox bars, and no sampling ever occurs outside
    // the valid region, which avoids the edge-clamping smear a stretched quad shows.
    const rect = computeLetterboxRect(
      this.internalWidth,
      this.internalHeight,
      canvasWidth,
      canvasHeight,
    );

    renderer.setRenderTarget(null);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, canvasWidth, canvasHeight);
    renderer.clear(true, true, true);

    if (rect.width > 0 && rect.height > 0) {
      renderer.setViewport(rect.x, rect.y, rect.width, rect.height);
      renderer.setScissor(rect.x, rect.y, rect.width, rect.height);
      renderer.setScissorTest(true);

      this.fullscreenQuad.material = this.blitMaterial;
      renderer.render(this.fullscreenScene, this.fullscreenCamera);

      renderer.setScissorTest(false);
    }

    this.lastStats = {
      internalWidth: this.internalWidth,
      internalHeight: this.internalHeight,
      presentedWidth: rect.width,
      presentedHeight: rect.height,
      scale:
        this.internalWidth > 0 && rect.width > 0
          ? Math.round(rect.width / this.internalWidth)
          : 1,
    };

    return this.lastStats;
  }

  /**
   * Read a single pixel from the palette-quantised frame.
   *
   * Used by the (stretch-goal) photo mode to save a screenshot at the authentic
   * internal resolution rather than at the upscaled presentation size.
   *
   * @param x - Pixel X in internal-resolution coordinates.
   * @param y - Pixel Y in internal-resolution coordinates.
   * @param target - A `Uint8Array` of at least 4 bytes to receive RGBA.
   */
  public readPalettePixel(x: number, y: number, target: Uint8Array): void {
    this.renderer.readRenderTargetPixels(this.paletteTarget, x, y, 1, 1, target);
  }

  /**
   * Release every GPU resource owned by the pipeline.
   *
   * Anything that allocates GPU memory must be disposable, or a resolution change or
   * a level reload becomes a leak — the exact class of bug guarded against by risk R9.
   */
  public dispose(): void {
    this.sceneTarget.dispose();
    this.paletteTarget.dispose();
    this.bayerTexture.dispose();
    this.paletteMaterial.dispose();
    this.blitMaterial.dispose();
    this.fullscreenGeometry.dispose();
    this.fullscreenScene.clear();
  }
}
