#version 300 es
// gfbpoint.merc.vert — WebGL2 GFB billboard renderer for 2D Web Mercator projection.
//
// GLSL ES 3.00 port of gfbpoint.merc.wgsl.
//
// Positions are read as lat/lon from RGBA32F data textures (same layout as
// the spherical gfbpoint.vert). The vertex shader converts each instance
// position to Mercator world pixels, interpolates between epochs, projects
// to NDC, then offsets by the quad vertex in screen pixels to produce a
// fixed-size billboard.
//
// Uniform layout (individual gl.uniform* calls — no UBO):
//   u_worldSize     f32   — 256 × 2^zoom
//   u_texSize       f32   — ceil(sqrt(featureCount))
//   u_cameraOffset  vec2  — camera center in world pixels (centerX, centerY)
//   u_viewportSize  vec2  — canvas physical size (width, height)
//   u_domainMin     f32   — color ramp domain min
//   u_domainMax     f32   — color ramp domain max
//   u_epochFrac     f32   — interpolation fraction [0, 1)
//   u_opacity       f32   — layer opacity
//   u_colorMode     int   — 0=fallback, 1=ramp, 2=categorical
//   u_catWidth      f32   — categorical LUT width
//   u_pixelSize     f32   — billboard radius in screen pixels
//   u_symbolType    int   — 0=circle+chevron, 1=arrow, 2=diamond, 3=circle
//   u_time          f32   — performance.now()/1000 for pulse animation
//   u_hasVelocity   int   — 1 = use velocity textures for heading

precision highp float;
precision highp int;
precision highp sampler2D;

// ── Per-vertex: billboard quad [-1, 1] ──
in vec2  a_quadVertex;
// ── Per-instance: attribute value and visibility ──
in float a_value;
in float a_visible;

// ── Uniforms ──
uniform float u_worldSize;
uniform float u_texSize;
uniform vec2  u_cameraOffset;
uniform vec2  u_viewportSize;
uniform float u_domainMin;
uniform float u_domainMax;
uniform float u_epochFrac;
uniform float u_opacity;
uniform int   u_colorMode;
uniform float u_catWidth;
uniform float u_pixelSize;
uniform int   u_symbolType;
uniform float u_time;
uniform int   u_hasVelocity;

// ── Data textures (same layout as spherical gfbpoint.vert) ──
uniform sampler2D u_posTex;       // Current epoch (RGBA32F: lon, lat, alt, 0)
uniform sampler2D u_posTexNext;   // Next epoch
uniform sampler2D u_velTex;       // Current epoch velocity (ew, ns, 0, 0)
uniform sampler2D u_velTexNext;   // Next epoch velocity

// ── Varyings ──
out float v_value;
out vec2  v_quadUV;
out float v_speed;
out float v_grounded;

const float PI = 3.14159265359;

// Convert geographic coordinates to Mercator world pixels at zoom 0 (tile size 256).
vec2 lngLatToMerc(float lng, float lat) {
    float x = (lng + 180.0) / 360.0;
    float sinLat = sin(lat * PI / 180.0);
    float y = 0.5 - log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * PI);
    return vec2(x * 256.0, y * 256.0);
}

// Sample lat/lon/alt from a position texture at the given feature index.
vec3 samplePos(sampler2D tex, int featureIdx) {
    int tsz = int(u_texSize);
    int tx = featureIdx - (featureIdx / tsz) * tsz;  // featureIdx % tsz
    int ty = featureIdx / tsz;
    return texelFetch(tex, ivec2(tx, ty), 0).xyz;
}

void main() {
    // Filter: skip invisible instances
    if (a_visible < 0.5) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        v_value    = 0.0;
        v_quadUV   = vec2(0.0);
        v_speed    = 0.0;
        v_grounded = 0.0;
        return;
    }

    int featureIdx = gl_InstanceID;
    vec3 posCur  = samplePos(u_posTex,     featureIdx);
    vec3 posNext = samplePos(u_posTexNext, featureIdx);

    // Sentinel: -1000 means no observation for this epoch
    if (posCur.x < -900.0 || posNext.x < -900.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        v_value    = 0.0;
        v_quadUV   = vec2(0.0);
        v_speed    = 0.0;
        v_grounded = 0.0;
        return;
    }

    // Convert both epoch positions to Mercator world pixels (zoom 0)
    // pos_tex stores: .x = longitude, .y = latitude, .z = altitude
    vec2 mercCur  = lngLatToMerc(posCur.x,  posCur.y);
    vec2 mercNext = lngLatToMerc(posNext.x, posNext.y);

    // Antimeridian unwrap: pick the shortest path between epochs in Mercator X.
    // Without this, a feature crossing ±180° interpolates the long way through
    // the prime meridian instead of stepping cleanly across the seam.
    float worldW = 256.0;
    float dx = mercNext.x - mercCur.x;
    if (dx > worldW * 0.5)  { mercNext.x -= worldW; }
    if (dx < -worldW * 0.5) { mercNext.x += worldW; }

    // Linear interpolation in Mercator space between epochs
    vec2 center0 = mix(mercCur, mercNext, u_epochFrac);

    // Wrap result back to [0, worldW); downstream camera-offset math
    // handles drawing near the seam.
    if (center0.x < 0.0)     { center0.x += worldW; }
    if (center0.x >= worldW) { center0.x -= worldW; }

    // Scale from zoom-0 world coords to current zoom
    float scale = u_worldSize / 256.0;
    float wx = center0.x * scale;
    float wy = center0.y * scale;

    // Project to NDC (Y-flipped: screen Y increases downward in Mercator)
    float halfW = u_viewportSize.x * 0.5;
    float halfH = u_viewportSize.y * 0.5;
    float ndcX =  (wx - u_cameraOffset.x) / halfW;
    float ndcY = -(wy - u_cameraOffset.y) / halfH;

    // Derive screen-space heading from position delta for position-based heading
    float pxCur  = (mercCur.x  * scale - u_cameraOffset.x) / halfW;
    float pyCur  = -(mercCur.y  * scale - u_cameraOffset.y) / halfH;
    float pxNext = (mercNext.x * scale - u_cameraOffset.x) / halfW;
    float pyNext = -(mercNext.y * scale - u_cameraOffset.y) / halfH;
    vec2 screenDelta = vec2(pxNext - pxCur, pyNext - pyCur);
    float posSpeed = length(screenDelta);

    float heading = 0.0;
    bool hasHeading = false;

    // Velocity-based heading (overrides position delta when available)
    if (u_hasVelocity == 1) {
        vec3 velC = samplePos(u_velTex,     featureIdx);
        vec3 velN = samplePos(u_velTexNext, featureIdx);
        float ew = mix(velC.x, velN.x, u_epochFrac);
        float ns = mix(velC.y, velN.y, u_epochFrac);
        float speed2d = sqrt(ew * ew + ns * ns);
        v_speed = clamp(speed2d / 300.0, 0.0, 1.0);
        if (speed2d > 0.5) {
            // EW → +NDC-x, NS → +NDC-y (after Y-flip Mercator → NDC)
            heading = atan(ns, ew);
            hasHeading = true;
        }
    }

    if (!hasHeading) {
        v_speed = clamp(posSpeed * 200.0, 0.0, 1.0);
        if (posSpeed > 0.0001) {
            heading = atan(screenDelta.y, screenDelta.x);
            hasHeading = true;
        }
    }

    // Billboard quad offset in screen pixels → NDC
    vec2 rotated;
    if (hasHeading) {
        float angle = heading - PI * 0.5;
        float cosA = cos(angle);
        float sinA = sin(angle);
        rotated = vec2(
            a_quadVertex.x * cosA - a_quadVertex.y * sinA,
            a_quadVertex.x * sinA + a_quadVertex.y * cosA
        );
    } else {
        rotated = a_quadVertex;
    }

    vec2 ndcOffset = rotated * u_pixelSize / vec2(halfW, halfH);
    gl_Position = vec4(ndcX + ndcOffset.x, ndcY + ndcOffset.y, 0.0, 1.0);

    v_value    = a_value;
    v_quadUV   = a_quadVertex * 0.5 + 0.5;
    v_grounded = 0.0; // Altitude-based grounding deferred for Mercator
}
