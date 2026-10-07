/**
 * GLSL source for the PS1 world shader.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * TRANSLITERATION CONTRACT (docs/ARCHITECTURE.md §5, risk W4)
 * ────────────────────────────────────────────────────────────────────────────────
 * Every mathematical operation in these shaders is a line-by-line transliteration of
 * a *unit-tested* TypeScript function in `src/core/math/ps1.ts`:
 *
 *   `snapClipSpaceXY`        <-> the `uSnapGrid` block in `main()`
 *   `shaderTrickAffineUV`    <-> `vUvAffine` / `vW` and the divide in the fragment shader
 *   `blendUV`                <-> `mix(uvPerspective, uvAffine, uWarpAmount)`
 *   `clampTerminator`        <-> `clamp(nDotL / uTerminatorHardness, 0.0, 1.0)`
 *
 * If a line here diverges from its TypeScript counterpart, the tests are no longer
 * protecting this code. The uniform-consistency test (`test/unit/shader-uniforms`)
 * covers the other silent failure mode: a uniform declared in one language and not
 * the other.
 *
 * Fragments deliberately use GLSL ES 1.00 syntax (`varying`, `texture2D`,
 * `gl_FragColor`). three.js applies a WebGL2 compatibility prefix, so this compiles on
 * both WebGL1 and WebGL2 contexts — the lowest-risk path for code that CI cannot
 * compile-check.
 */

/**
 * Vertex shader: vertex snapping, affine-UV pair generation, flat vertex lighting.
 *
 * Three.js automatically declares `position`, `normal`, `uv`, `color` (when
 * `vertexColors: true`) and `instanceMatrix` (when rendering an `InstancedMesh`), so
 * they are intentionally not redeclared here.
 */
export const PS1_VERTEX_SHADER = /* glsl */ `
precision highp float;

uniform vec2 uSnapGrid;          // (columns, rows) in virtual pixels
uniform vec3 uSunDirection;      // world-space, normalised, pointing AT the sun
uniform float uTerminatorHardness;
uniform float uRimPower;

varying vec2 vUv;                // raw UV, interpolated perspective-correctly
varying vec2 vUvAffineTimesW;    // the "A" varying: uv * w
varying float vClipW;            // the "W" varying: w
varying vec3 vTint;              // per-vertex colour (baked lighting / material tint)
varying float vDiffuse;          // hard-terminator Lambert term
varying float vRim;              // silhouette rim term
varying float vFogDepth;         // view-space distance, for fog in the fragment stage

void main() {
    // ---- Transform to clip space ----
    // Instance transform is applied first so that instanced props (trees, rocks)
    // participate in lighting and snapping identically to unique geometry.
    #ifdef USE_INSTANCING
        // Built from three column vectors rather than mat3(instanceMatrix): matrix-from-
        // matrix construction has patchy GLSL ES 1.00 driver support, and instancing is
        // exactly where a driver-dependent failure would be hardest to diagnose.
        mat3 instanceRotation = mat3(
            instanceMatrix[0].xyz,
            instanceMatrix[1].xyz,
            instanceMatrix[2].xyz
        );
        vec4 localPosition = instanceMatrix * vec4(position, 1.0);
        vec3 localNormal = instanceRotation * normal;
    #else
        vec4 localPosition = vec4(position, 1.0);
        vec3 localNormal = normal;
    #endif

    vec4 worldPosition = modelMatrix * localPosition;
    vec4 viewPosition = viewMatrix * worldPosition;
    vec4 clipPosition = projectionMatrix * viewPosition;

    // ---- PS1 vertex snapping ----
    // Equivalent to snapClipSpaceXY() in src/core/math/ps1.ts.
    //
    // Snapping is performed on the post-divide NDC value and then re-multiplied by w,
    // which is algebraically identical to snapping in NDC while preserving the correct
    // w for the rasteriser. The guard mirrors the TypeScript singularity handling:
    // vertices at or behind the camera plane (|w| < epsilon) are left untouched rather
    // than allowed to produce NaN that would corrupt the whole triangle.
    if (abs(clipPosition.w) > 1e-6) {
        vec2 ndc = clipPosition.xy / clipPosition.w;
        vec2 gridStep = 2.0 / uSnapGrid;          // NDC spans [-1, 1]: a step of 2/N
        // Nearest grid line, matching snapNdcToGrid() in src/core/math/ps1.ts.
        //
        // NOTE: floor(x + 0.5) rather than round(x). GLSL ES 1.00 has no round(); it was
        // introduced in ES 3.00. floor(x + 0.5) is exactly equivalent to JavaScript's
        // Math.round for all values (both round a .5 toward +Infinity), so this keeps the
        // GLSL and the tested TypeScript in perfect agreement. Guarded by the GLSL
        // ES 1.00 compatibility lint in test/unit/shader-uniforms.test.ts.
        ndc = floor(ndc / gridStep + 0.5) * gridStep;
        clipPosition.xy = ndc * clipPosition.w;
    }

    // ---- Affine texture mapping: emit the two-varying pair ----
    // The GPU interpolates every varying perspective-correctly, which is exactly what
    // we must defeat. See the derivation in src/core/math/ps1.ts (shaderTrickAffineUV):
    // dividing the interpolated (uv * w) by the interpolated w cancels the perspective
    // correction and yields screen-space-linear UVs. This pair is what makes that work.
    vUv = uv;
    vUvAffineTimesW = uv * clipPosition.w;
    vClipW = clipPosition.w;

    // ---- Flat vertex lighting (bright, hard-terminated, period-authentic) ----
    vec3 worldNormal = normalize(mat3(modelMatrix) * localNormal);
    float nDotL = dot(worldNormal, normalize(uSunDirection));

    // clampTerminator(): compress the diffuse ramp into a narrow band so the
    // terminator is crisp. A smooth modern falloff reads as muddy in a high-key
    // scene, which is precisely risk R5.
    vDiffuse = clamp(nDotL / max(uTerminatorHardness, 1e-4), 0.0, 1.0);

    // Silhouette rim light. Without it, flat-shaded low-poly geometry collapses into
    // a single flat value and forms become unreadable in bright lighting.
    vec3 viewDirection = normalize(-viewPosition.xyz);
    float rimTerm = 1.0 - clamp(dot(worldNormal, viewDirection), 0.0, 1.0);
    vRim = pow(rimTerm, max(uRimPower, 0.001));

    // Vertex colour carries the material tint and any baked shading. Because the
    // lighting model is deliberately primitive (W3), hue and value separation between
    // forms has to come from here.
    #ifdef USE_COLOR
        vTint = color;
    #else
        vTint = vec3(1.0);
    #endif

    vFogDepth = -viewPosition.z;

    gl_Position = clipPosition;
}
`;

/**
 * Fragment shader: blended affine UVs, texture fetch with alpha test,
 * Lambert + ambient + rim lighting, and distance fog matched to the sky colour.
 *
 * Note that palette quantisation is deliberately NOT performed here. Quantising the
 * final composite in a dedicated post pass is cheaper (one pass over 129,600 fragments
 * instead of once per object with overdraw), more correct (real hardware palettes
 * applied to the composited frame), and keeps this shader simpler.
 */
export const PS1_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uMap;
uniform float uWarpAmount;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uAmbientColor;
uniform float uAmbientIntensity;
uniform vec3 uRimColor;
uniform float uRimIntensity;
uniform float uAlphaTest;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uTint;

varying vec2 vUv;
varying vec2 vUvAffineTimesW;
varying float vClipW;
varying vec3 vTint;
varying float vDiffuse;
varying float vRim;
varying float vFogDepth;

void main() {
    // ---- Recover the affine UV from the two-varying pair ----
    // The perspective correction in the interpolators cancels in this divide, leaving
    // screen-space-linear UVs. The exact identity is proven in
    // src/core/math/ps1.ts -> shaderTrickAffineUV().
    vec2 uvPerspective = vUv;
    vec2 uvAffine = vClipW != 0.0 ? (vUvAffineTimesW / vClipW) : vUv;

    // blendUV(): unrestricted affine mapping makes large surfaces look broken rather
    // than retro, so the warp is a tunable scalar defaulting below 1.0.
    vec2 uv = mix(uvPerspective, uvAffine, uWarpAmount);

    vec4 texel = texture2D(uMap, uv);

    // Alpha test for foliage cards and other cut-out geometry. The PS1 had no blend
    // pipeline worth using, and hard cut-outs are the period-correct look.
    if (texel.a < uAlphaTest) {
        discard;
    }

    // ---- Lighting ----
    // Ambient + hard-terminated diffuse + rim. No specular, no shadows, no PBR:
    // the era had none of them and none of them survive affine warping attractively.
    vec3 lighting =
        uAmbientColor * uAmbientIntensity +
        uSunColor * uSunIntensity * vDiffuse +
        uRimColor * uRimIntensity * vRim;

    vec3 surfaceColor = texel.rgb * vTint * uTint * lighting;

    // ---- Fog ----
    // Matched to the sky colour so distance reads as warm tropical haze rather than
    // as gloom. Fog is never used to hide draw distance (the level uses authored
    // occluders); it exists only to soften the far edge of the world.
    float fogFactor = clamp((vFogDepth - uFogNear) / max(uFogFar - uFogNear, 1e-4), 0.0, 1.0);
    vec3 fogged = mix(surfaceColor, uFogColor, fogFactor);

    gl_FragColor = vec4(fogged, 1.0);
}
`;

/**
 * Vertex shader for the full-screen passes (palette quantisation, final blit).
 *
 * Position is passed through directly in clip space, since the geometry is already a
 * screen-aligned quad.
 */
export const FULLSCREEN_VERTEX_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Fragment shader for the palette quantisation pass.
 *
 * Quantisation happens here, on the composited low-resolution frame, rather than in
 * the world shader: it is cheaper, it matches how period hardware applied palettes,
 * and it keeps the world shader's responsibilities narrow.
 *
 * Ordered dithering is applied *before* quantisation. Without it, the limited palette
 * turns smooth sky gradients into visible bands; with it, the banding becomes the
 * characteristic stippled texture of the era.
 */
export const PALETTE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uSource;
uniform sampler2D uDitherTable;
uniform float uPaletteLevels;
uniform float uDitherAmount;

varying vec2 vUv;

void main() {
    vec3 color = texture2D(uSource, vUv).rgb;

    // Sample the 4x4 Bayer matrix by fragment coordinate. A texture lookup is used
    // instead of a const array because GLSL ES 1.00 does not support array
    // constructors, and because it guarantees the GLSL matrix is bit-identical to the
    // unit-tested TypeScript implementation in src/core/math/ps1.ts.
    // The 0.5 scale maps the [0,1) table entry into the [-0.5, 0.5) dither offset range.
    vec2 tableCoord = (floor(gl_FragCoord.xy) + 0.5) / 4.0;
    float dither = (texture2D(uDitherTable, tableCoord).r - 0.5) * uDitherAmount;

    // quantiseChannel(): offset by the dither, then snap to the nearest of N levels.
    float levels = max(uPaletteLevels - 1.0, 1.0);
    vec3 dithered = clamp(color + dither / uPaletteLevels, 0.0, 1.0);
    vec3 quantised = floor(dithered * levels + 0.5) / levels;

    gl_FragColor = vec4(quantised, 1.0);
}
`;

/**
 * Fragment shader for the final blit to the canvas.
 *
 * Sampling is nearest-neighbour with no filtering of any kind: any smoothing here
 * would undo the entire point of rendering at 480x270, and a fractional scale would
 * give rows of inconsistent thickness.
 */
export const BLIT_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform sampler2D uSource;

varying vec2 vUv;

void main() {
    gl_FragColor = vec4(texture2D(uSource, vUv).rgb, 1.0);
}
`;

/**
 * Vertex shader that ignores the camera and outputs world position directly.
 *
 * Used by nothing yet; reserved for the sky dome, which must not move with the camera.
 * Kept here so the shader inventory stays in one place.
 */
export const PS1_SKY_VERTEX_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uSkyOffset;

varying vec3 vDirection;

void main() {
    vDirection = normalize(position);
    vec4 worldPosition = vec4(position + uSkyOffset, 1.0);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

/**
 * Fragment shader for the sky dome: a vertical gradient with procedural cloud bands.
 *
 * Deliberately bright and saturated. The sky is the single largest area of colour on
 * screen and therefore the strongest signal that this is an adventure game rather
 * than a horror game (GDD §1, §9.3).
 */
export const PS1_SKY_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform vec3 uCloudColor;
uniform float uCloudCoverage;
uniform float uCloudSoftness;

varying vec3 vDirection;

void main() {
    vec3 direction = normalize(vDirection);

    // Vertical gradient: zenith at the top, horizon at eye level. The 0.5 offset
    // places the transition around the visual horizon rather than at the equator.
    float elevation = clamp(direction.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 sky = mix(uHorizonColor, uZenithColor, pow(elevation, 0.8));

    // Cloud bands: a cheap analytic function rather than a noise texture, so the sky
    // costs one alu-only pass and needs no texture memory.
    float bands = sin(direction.x * 9.0 + direction.z * 6.0)
                * cos(direction.z * 11.0 - direction.x * 4.0);
    bands = bands * 0.5 + 0.5;
    float cloud = smoothstep(uCloudCoverage, uCloudCoverage + uCloudSoftness, bands);

    // Clouds fade out towards the horizon so the skyline reads cleanly and the clouds
    // do not appear to intersect the terrain.
    cloud *= smoothstep(0.02, 0.35, direction.y);

    gl_FragColor = vec4(mix(sky, uCloudColor, cloud), 1.0);
}
`;
