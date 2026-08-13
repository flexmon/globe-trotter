#version 300 es
// h3hex.merc.vert — WebGL2 H3Flex renderer for 2D Web Mercator projection.
//
// GLSL ES 3.00 port of h3hex.merc.wgsl.
//
// Positions arrive as world pixels baked at zoom 0 (worldSize = 256).
// The vertex shader scales to the current zoom and projects to NDC via the
// same camera-offset / viewport-half transform as the WebGPU Mercator shader.
//
// Uniform layout mirrors the WGSL struct exactly so the JS side can share
// the same upload code (individual gl.uniform* calls — no UBO needed here).

precision highp float;
precision highp int;

// ── Vertex attributes ──
// Mercator world-pixel position baked at zoom 0
in vec2  a_position;
// Cell index for data-texture lookup
in float a_cellIndex;

// ── Uniforms: Mercator camera + style ──
// Matches WGSL Uniforms struct field-for-field (same names, same order).
uniform float u_worldSize;       // 256 × 2^zoom
uniform float u_texSize;         // ceil(sqrt(cellCount))
uniform vec2  u_cameraOffset;    // camera center in world pixels
uniform vec2  u_viewportSize;    // canvas physical size (width, height)
uniform float u_domainMin;       // value range min for color normalization
uniform float u_domainMax;       // value range max
uniform float u_epochFrac;       // interpolation fraction [0, 1) between epochs
uniform float u_opacity;         // layer opacity
uniform int   u_colorMode;       // 1=ramp, 2=categorical/constant (no interp)
// Filter uniforms
uniform int   u_filterCombinator; // 0=AND, 1=OR
uniform int   u_filter1Target;    // 0=active metric, 1=filter texture
uniform int   u_filter2Target;    // 0=active metric, 1=filter texture

// ── Data textures ──
uniform sampler2D u_dataTex;      // current epoch R32F
uniform sampler2D u_dataTexNext;  // next epoch R32F
uniform sampler2D u_filterTex;    // filter column (R32F)

// ── Varyings to fragment ──
out float v_value;        // interpolated metric value
out float v_filterValue;  // value from filter texture (non-active-metric preds)
out float v_valid;        // 1.0 = data present, 0.0 = missing (-3.4e38 sentinel)

void main() {
    // ── Data-texture lookup (same as spherical h3hex.vert) ──
    float idx  = a_cellIndex;
    float texY = floor(idx / u_texSize);
    float texX = idx - texY * u_texSize;
    vec2 texCoord = (vec2(texX, texY) + 0.5) / u_texSize;

    float valCur  = texture(u_dataTex,     texCoord).r;
    float valNext = texture(u_dataTexNext, texCoord).r;

    // -3.4e38 sentinel = missing data
    v_valid = (valCur > -1e37) ? 1.0 : 0.0;

    // Categorical data (mode 2) must not be interpolated
    v_value = (u_colorMode == 2) ? valCur : mix(valCur, valNext, u_epochFrac);

    // Filter texture (only read when a non-active-metric predicate is active)
    v_filterValue = (u_filter1Target > 0 || u_filter2Target > 0)
        ? texture(u_filterTex, texCoord).r
        : 0.0;

    // ── Project to NDC ──
    // Positions are baked at zoom-0 world size (256); scale to current zoom.
    float scale = u_worldSize / 256.0;
    float wx = a_position.x * scale;
    float wy = a_position.y * scale;
    float sx =  (wx - u_cameraOffset.x) / (u_viewportSize.x * 0.5);
    float sy = -(wy - u_cameraOffset.y) / (u_viewportSize.y * 0.5);
    gl_Position = vec4(sx, sy, 0.0, 1.0);
}
