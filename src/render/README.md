# `src/render` — the PS1 rendering pipeline

## What this system does

Renders the world into a 480×270 target using hand-written GLSL that reproduces the
PlayStation's characteristic artefacts, then presents it to the canvas crisp and
integer-scaled.

## Pass structure

```
Pass 1  Scene   -> 480x270 RGBA target     world shader: vertex snap, affine UV, flat lighting, fog
Pass 2  Palette -> 480x270 RGBA target     ordered 4x4 dither + palette quantisation
Pass 3  Blit    -> canvas                  nearest-neighbour, integer scale, letterboxed
```

### Why quantisation is a separate pass

It runs once over 129,600 fragments instead of once per object with overdraw, it quantises
the *composited* frame (which is what period hardware actually did), and it keeps the world
shader small enough to audit against the tested TypeScript reference.

### Why the blit is integer-scaled

A fractional upscale makes some output rows and columns thicker than others. That destroys
the uniform pixel grid which is the entire point of rendering at low resolution.
`computeLetterboxRect` in `src/core/math/ps1.ts` picks the largest integer scale that fits,
and the scissor test restricts the draw so no sampling happens outside the valid region.

## The three artefacts

### Vertex snapping

In the vertex shader, on `clipPosition.xy / clipPosition.w`, then multiplied back by `w`.
Equivalent to snapping in NDC while preserving `w` for the rasteriser. Uses
`floor(x + 0.5)` rather than `round(x)` because **GLSL ES 1.00 has no `round()`** — this is
linted in `test/unit/shader-uniforms.test.ts`.

The grid is expressed in *virtual pixels*, not world units. A world-space grid would wobble
inconsistently with distance from the camera.

### Affine texture mapping

The GPU always interpolates varyings perspective-correctly. To defeat that, the vertex
shader emits `uv * w` and `w` as two separate varyings, and the fragment shader divides one
by the other. The perspective correction cancels exactly:

```
A = interpolate(uv * w) = (Σ λᵢ uvᵢ) / (Σ λᵢ / wᵢ)
W = interpolate(w)      = 1 / (Σ λᵢ / wᵢ)
A / W                   = Σ λᵢ uvᵢ   <- screen-space-linear, i.e. affine
```

Proven in `src/core/math/ps1.ts` (`shaderTrickAffineUV`) and tested against true affine
interpolation *and* against perspective-correct interpolation, so the test cannot pass
vacuously if the trick were a no-op.

The result is blended with the perspective-correct UV by `uWarpAmount`. Unrestricted affine
mapping makes large surfaces look broken rather than retro, so the default is 0.65.

### Flat, hard-terminated lighting

`clamp(nDotL / hardness)` plus ambient plus a silhouette rim term. The rim exists because
without it, flat-shaded low-poly geometry collapses into single flat values and forms become
unreadable — especially in a *bright* scene, where there is no shadow contrast to compensate.
That is why the level builder bakes hue and value separation into vertex colours.

## Key files

| File | Responsibility |
|---|---|
| `shaders/ps1World.ts` | All GLSL sources. Every maths operation cites its tested TypeScript counterpart. |
| `PS1Material.ts` | The single material factory, plus the **shared uniform objects** that let global lighting be retuned in one write. |
| `PS1Pipeline.ts` | Render targets, the full-screen passes, resize handling, disposal, frame statistics. |

## Gotchas

- **Uniforms are shared by reference.** `sharedUniforms` entries are the same objects across
  every material, so `sharedUniforms.uSunIntensity.value = 0.5` updates everything at once.
  Deep-copying one would silently create an object lit by a stale sun. Asserted by a test.
- **Palette quantisation uses a texture, not a const array**, because GLSL ES 1.00 does not
  support array constructors.
- **Everything must be disposable.** `PS1Pipeline.dispose()` releases both targets, the
  Bayer table and the pass materials. A resolution change that did not release the old
  targets would leak GPU memory — see risk R9.
- **`polygonOffset` is deliberate.** Vertex snapping can push two coplanar polygons onto
  opposite sides of the depth comparison. The offset removes that z-fighting.

## Testing

- `test/unit/ps1-math.test.ts` — 38 tests over the shader mathematics.
- `test/unit/shader-uniforms.test.ts` — uniform agreement in both directions, GLSL ES 1.00
  compatibility lint, FOV conversion.
- Manual visual checklist per milestone, recorded in `docs/DEV_LOG.md`. **CI cannot compile
  GLSL**; this is a known and documented gap, not an oversight.
