#version 300 es
// gfbpoly.merc.vert — WebGL2 GFB polygon fill renderer for 2D Web Mercator projection.
//
// GLSL ES 3.00 port of gfbpoly.merc.wgsl.
//
// Vertices store raw geodetic coordinates (lon, lat, alt). The vertex shader
// projects each vertex to Mercator world pixels per-frame — no pre-baking.
//
// Antimeridian-crossing triangles are pre-split by the JS renderer
// (splitMercatorPolygon in util/mercatorBake.js); split slivers carry lng
// values offset by ±360°, and lngLatToMerc projects them into the correct
// world-x positions on either side of the seam.
//
// Uniform layout (individual gl.uniform* calls — no UBO):
//   u_worldSize       f32   — 256 × 2^zoom
//   u_cameraOffset    vec2  — camera center in world pixels (centerX, centerY)
//   u_viewportSize    vec2  — canvas physical size (width, height)
//   u_domainMin       f32   — color ramp / extrusion domain min
//   u_domainMax       f32   — color ramp / extrusion domain max
//   u_opacity         f32   — layer opacity
//   u_colorMode       int   — 0=fallback, 1=ramp, 2=categorical
//   u_catWidth        f32   — categorical LUT width
//   u_extrusionScale  f32   — world-pixels at zoom-0 per unit value (0 = flat)
//   u_tilt            f32   — camera tilt in radians
//
// 2.5D extrusion: when extrusion_scale > 0, every polygon vertex lifts in
// screen Y by sin(tilt) × wz where wz = extrudeVal × extrusion_scale × scale.
// Mirrors gfbpoly.merc.wgsl and h3hex.merc.vert.

precision highp float;
precision highp int;

// ── Per-vertex attributes ──
in vec3  a_position; // (lon, lat, alt_feet)
in float a_value;    // attribute value for color lookup
in float a_visible;  // visibility flag

// ── Uniforms ──
uniform float u_worldSize;
uniform vec2  u_cameraOffset;
uniform vec2  u_viewportSize;
uniform float u_domainMin;
uniform float u_domainMax;
uniform float u_opacity;
uniform int   u_colorMode;
uniform float u_catWidth;
uniform float u_extrusionScale;
uniform float u_tilt;

// ── Varyings ──
out float v_value;
out float v_visible;

const float PI = 3.14159265359;

// Convert geographic coordinates to Mercator world pixels at zoom 0 (tile size 256).
vec2 lngLatToMerc(float lng, float lat) {
    float x = (lng + 180.0) / 360.0;
    float sinLat = sin(lat * PI / 180.0);
    float y = 0.5 - log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * PI);
    return vec2(x * 256.0, y * 256.0);
}

void main() {
    v_value   = a_value;
    v_visible = a_visible;

    vec2 merc = lngLatToMerc(a_position.x, a_position.y);

    float scale = u_worldSize / 256.0;
    float wx    =  merc.x * scale;
    float wy    =  merc.y * scale;
    float halfW = u_viewportSize.x * 0.5;
    float halfH = u_viewportSize.y * 0.5;
    float ndcX  =  (wx - u_cameraOffset.x) / halfW;
    float ndcY  = -(wy - u_cameraOffset.y) / halfH; // Y-flip

    // 2.5D extrusion: lift the polygon in screen Y proportional to value.
    // Mirrors gfbpoly.merc.wgsl — see derivation in h3hex.merc.wgsl.
    float ndcZ = 0.0;
    if (u_extrusionScale > 0.0) {
        float normalized = clamp((a_value - u_domainMin) / (u_domainMax - u_domainMin), 0.0, 1.0);
        float extrudeVal = pow(normalized, 1.2);
        float wz = extrudeVal * u_extrusionScale * scale;
        ndcY = ndcY - wz * sin(u_tilt) / halfH;
        ndcZ = extrudeVal * 0.5;
    }

    gl_Position = vec4(ndcX, ndcY, ndcZ, 1.0);
}
