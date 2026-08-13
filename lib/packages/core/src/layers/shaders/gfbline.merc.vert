#version 300 es
// gfbline.merc.vert — WebGL2 GFB wide-line renderer for 2D Web Mercator projection.
//
// GLSL ES 3.00 port of gfbline.merc.wgsl.
//
// Each line segment A→B is a screen-space quad extruded perpendicular to the
// projected line direction. Geodetic coordinates are projected to Mercator
// world pixels in the vertex shader — no pre-baking.
//
// Uniform layout (individual gl.uniform* calls — no UBO):
//   u_worldSize     f32   — 256 × 2^zoom
//   u_lineWidth     f32   — line width in pixels
//   u_cameraOffset  vec2  — camera center in world pixels (centerX, centerY)
//   u_viewportSize  vec2  — canvas physical size (width, height)
//   u_domainMin     f32   — color ramp domain min
//   u_domainMax     f32   — color ramp domain max
//   u_opacity       f32   — layer opacity
//   u_colorMode     int   — 0=fallback, 1=ramp, 2=categorical
//   u_catWidth      f32   — categorical LUT width

precision highp float;
precision highp int;

// ── Per-vertex attributes ──
in vec3  a_geoA;    // segment start (lon, lat, alt)
in vec3  a_geoB;    // segment end (lon, lat, alt)
in float a_side;    // -1 = left edge, +1 = right edge
in float a_value;   // attribute value for color lookup
in float a_visible; // visibility flag

// ── Uniforms ──
uniform float u_worldSize;
uniform float u_lineWidth;
uniform vec2  u_cameraOffset;
uniform vec2  u_viewportSize;
uniform float u_domainMin;
uniform float u_domainMax;
uniform float u_opacity;
uniform int   u_colorMode;
uniform float u_catWidth;

// ── Varyings ──
out float v_value;
out float v_dist;    // signed distance from center [-1, 1] for AA
out float v_visible;

const float PI = 3.14159265359;

// Convert geographic coordinates to Mercator world pixels at zoom 0 (tile size 256).
vec2 lngLatToMerc(float lng, float lat) {
    float x = (lng + 180.0) / 360.0;
    float sinLat = sin(lat * PI / 180.0);
    float y = 0.5 - log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * PI);
    return vec2(x * 256.0, y * 256.0);
}

// Project Mercator zoom-0 world pixel to NDC.
vec2 mercToNDC(vec2 worldPx) {
    float scale = u_worldSize / 256.0;
    float wx =  worldPx.x * scale;
    float wy =  worldPx.y * scale;
    float halfW = u_viewportSize.x * 0.5;
    float halfH = u_viewportSize.y * 0.5;
    return vec2(
         (wx - u_cameraOffset.x) / halfW,
        -(wy - u_cameraOffset.y) / halfH  // Y-flip: Mercator Y grows down, NDC up
    );
}

void main() {
    v_visible = a_visible;

    // Cull invisible vertices early
    if (a_visible < 0.5) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        v_value = 0.0;
        v_dist  = 0.0;
        return;
    }

    vec2 mercA = lngLatToMerc(a_geoA.x, a_geoA.y);
    vec2 mercB = lngLatToMerc(a_geoB.x, a_geoB.y);

    vec2 ndcA = mercToNDC(mercA);
    vec2 ndcB = mercToNDC(mercB);

    // Screen-space direction and perpendicular
    vec2 screenA = ndcA * u_viewportSize * 0.5;
    vec2 screenB = ndcB * u_viewportSize * 0.5;
    vec2 dir  = normalize(screenB - screenA);
    vec2 perp = vec2(-dir.y, dir.x);

    // Extrude perpendicular by half line width + 0.5px for AA
    float halfWidth = (u_lineWidth + 1.0) * 0.5;
    vec2 screenOffset = perp * halfWidth * a_side;

    // Vertices 0,1 are at A; vertices 2,3 are at B
    // gl_VertexID within segment: 0→A, 1→A, 2→B, 3→B
    vec2 baseNDC = (gl_VertexID % 4 >= 2) ? ndcB : ndcA;

    // Convert screen offset back to NDC
    vec2 ndcOffset = screenOffset / (u_viewportSize * 0.5);
    gl_Position = vec4(baseNDC + ndcOffset, 0.0, 1.0);

    v_value = a_value;
    v_dist  = a_side;  // -1 at left edge, +1 at right — used for AA in frag
}
