#version 300 es
// gfbpoint.vert — Instanced billboard rendering for GFB point features.
// Heading-aware: derives direction from current→next position delta,
// rotates billboard to point in direction of travel.
// Uses a GEOMETRIC horizon test (dot product) to hide far-side features.
//
// GPU INTERPOLATION: Positions are sampled from RGBA32F data textures
// instead of CPU-interpolated buffers. Two textures hold adjacent epochs,
// slerp() interpolates between them along a great-circle arc using u_epochFrac.

precision highp float;

// Per-vertex: billboard quad (2 triangles = 6 verts)
in vec2 a_quadVertex;

// Per-instance: attribute value (category index or continuous metric)
in float a_value;
// Per-instance: visibility flag (1.0 = visible, 0.0 = filtered out)
in float a_visible;

uniform mat4 u_view;
uniform mat4 u_projection;
uniform vec3 u_cameraRight;
uniform vec3 u_cameraUp;
uniform vec3 u_cameraPosition;   // Camera position for horizon test
uniform float u_symbolScale;     // Scale multiplier for symbol size (default 1.0)
uniform float u_baseSize;        // Base size in globe units (configurable per layer)

// Scale-dependent rendering: zoom attenuation
uniform float u_zoomNear;        // Camera distance where symbols are smallest (default 1.05)
uniform float u_zoomFar;         // Camera distance where symbols are largest (default 3.0)
uniform float u_zoomMinScale;    // Minimum scale fraction at close zoom (default 0.25)
uniform float u_extrusionScale;  // Altitude multiplier

// Data textures: RGBA32F holding (lon, lat, alt, 0) per feature
uniform sampler2D u_posTex;       // Current epoch positions
uniform sampler2D u_posTexNext;   // Next epoch positions
uniform float u_texSize;          // Texture width/height (square)
uniform float u_epochFrac;        // Interpolation fraction [0, 1]

// Velocity-based heading: RGBA32F holding (ewVelocity, nsVelocity, 0, 0)
uniform sampler2D u_velTex;       // Current epoch velocities
uniform sampler2D u_velTexNext;   // Next epoch velocities
uniform int u_hasVelocity;        // 1 = use velocity for heading, 0 = position delta

out float v_value;
out vec2 v_quadUV;
out float v_speed;       // Normalized speed (0..1) for glow intensity
out float v_grounded;    // 1.0 if grounded, 0.0 if airborne
out float v_altitude;    // Raw altitude in feet

const float PI = 3.14159265359;
const float DEG2RAD = PI / 180.0;
const float GLOBE_RADIUS = 1.0;

// Convert altitude in feet to normalized globe units.
const float FEET_TO_GLOBE = 1.0 / 20925525.0;

// WGS84 lat/lon/alt to globe 3D position.
vec3 latLonAltToXYZ(float lat, float lon, float altFeet) {
    float theta = (90.0 - lat) * DEG2RAD;
    float phi = (lon + 180.0) * DEG2RAD;
    float r = GLOBE_RADIUS + altFeet * FEET_TO_GLOBE;
    return vec3(
        sin(theta) * sin(phi),
        cos(theta),
        sin(theta) * cos(phi)
    ) * r;
}

// Sample position from data texture using feature index
vec3 samplePos(sampler2D tex, int featureIdx, float texSize) {
    float tx = mod(float(featureIdx), texSize) + 0.5;
    float ty = floor(float(featureIdx) / texSize) + 0.5;
    vec2 uv = vec2(tx, ty) / texSize;
    vec4 d = texture(tex, uv);
    return d.xyz;  // lon, lat, alt
}

// Cheap unit-direction vector from lat/lon degrees — avoids the full
// latLonAltToXYZ() cost (no altitude multiply) when only direction is needed.
// Cost: 2 sin + 2 cos, with cos(lat) shared between x and z components.
vec3 dirFromLatLon(float latDeg, float lonDeg) {
    float theta = (90.0 - latDeg) * DEG2RAD;  // colatitude
    float phi   = (lonDeg + 180.0) * DEG2RAD;
    float sinT  = sin(theta);
    float cosT  = cos(theta);
    float sinP  = sin(phi);
    float cosP  = cos(phi);
    return vec3(sinT * sinP, cosT, sinT * cosP);
}

// Spherical linear interpolation — follows a great-circle arc on the sphere.
// Critical for correct interpolation on a globe: plain mix() in lat/lon space
// produces rhumb-line paths that visibly deviate from great circles, especially
// at high latitudes where longitude lines converge toward the poles. For
// orbital or long-range paths this causes visible "bouncing" artifacts.
//
// Inputs are assumed to be unit vectors (from dirFromLatLon). The return
// value is also a unit vector; scale by radius after calling.
vec3 slerpUnit(vec3 n0, vec3 n1, float t) {
    float d = clamp(dot(n0, n1), -1.0, 1.0);
    float theta = acos(d);
    // Raised threshold (0.01 rad ≈ 0.57°): nearly-stationary features (ground
    // stations, parked assets) take the cheap mix() path with no visible error.
    // LEO orbital arcs (~4° per 60s epoch) always use the full slerp path.
    if (theta < 0.01) {
        return normalize(mix(n0, n1, t));
    }
    float sinTheta = sin(theta);
    return n0 * (sin((1.0 - t) * theta) / sinTheta)
         + n1 * (sin(t * theta) / sinTheta);
}

void main() {
    // Filter: skip invisible instances
    if (a_visible < 0.5) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    // GPU interpolation: sample current and next epoch positions
    int featureIdx = gl_InstanceID;
    vec3 posCur  = samplePos(u_posTex,     featureIdx, u_texSize);
    vec3 posNext = samplePos(u_posTexNext, featureIdx, u_texSize);

    // Altitude interpolates linearly — it is a scalar radial offset, not an
    // angular quantity, so linear mix is correct here.
    float alt = mix(posCur.z, posNext.z, u_epochFrac);

    // Grounded detection: only classify as grounded if altitude data exists
    bool grounded = (alt > 0.0 && alt < 100.0);
    float effectiveAlt;
    if (grounded) {
        effectiveAlt = 800.0 * u_extrusionScale;
    } else if (alt < 1.0) {
        effectiveAlt = 800.0 * u_extrusionScale;
    } else {
        effectiveAlt = alt * u_extrusionScale;
    }

    // ── Scale-dependent rendering ──
    // Modulate symbol size based on camera distance (zoom level).
    // At globe view (far): full size. Zoomed in (close): shrink to prevent
    // massive blobs — a standard GIS cartographic technique.
    float camDist = length(u_cameraPosition);
    float zoomScale = smoothstep(u_zoomNear, u_zoomFar, camDist);
    zoomScale = mix(u_zoomMinScale, 1.0, zoomScale);

    float size = grounded
        ? u_baseSize * 0.35 * zoomScale
        : u_baseSize * u_symbolScale * zoomScale;

    // Spherical interpolation: convert both epoch positions to unit direction
    // vectors (dirFromLatLon — cheaper than latLonAltToXYZ: no radius multiply),
    // slerp along the great-circle arc, then scale to the interpolated radius
    // using inversesqrt for the final normalise step (hardware rsqrt).
    // Anti-meridian wrapping is implicit in XYZ space — no date-line handling needed.
    vec3 dirCur    = dirFromLatLon(posCur.y,  posCur.x);
    vec3 dirNext   = dirFromLatLon(posNext.y, posNext.x);
    vec3 dirInterp = slerpUnit(dirCur, dirNext, u_epochFrac);
    float r = GLOBE_RADIUS + effectiveAlt * FEET_TO_GLOBE;
    // inversesqrt-based scaling: hardware rsqrt avoids a sqrt+divide.
    // dirInterp is already unit from slerpUnit, but the final scale still
    // needs a normalise to absorb any floating-point drift.
    vec3 center = dirInterp * (r * inversesqrt(dot(dirInterp, dirInterp)));

    // ── Geometric horizon test ──
    // dirInterp is the unit direction of center (center = dirInterp * r),
    // so reuse it directly — saves one normalize() call.
    float horizon = dot(dirInterp, u_cameraPosition);
    if (horizon < 1.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }

    // ── Derive heading ──
    float heading;

    if (u_hasVelocity == 1) {
        // Velocity-based heading: ew/ns velocity from data texture
        vec3 velCur  = samplePos(u_velTex,     featureIdx, u_texSize);
        vec3 velNext = samplePos(u_velTexNext, featureIdx, u_texSize);
        float ew = mix(velCur.x, velNext.x, u_epochFrac);
        float ns = mix(velCur.y, velNext.y, u_epochFrac);
        float speed2d = sqrt(ew * ew + ns * ns);
        v_speed = clamp(speed2d / 300.0, 0.0, 1.0);  // normalize ~300 m/s max

        // atan2(ns, ew): 0=east, PI/2=north. Geographic heading.
        // Project geographic heading into screen-space rotation.
        // Convert geographic ew/ns to screen-space delta:
        // ew → eastward → positive screen X (at equator)
        // ns → northward → positive screen Y
        vec3 fwdCenter = latLonAltToXYZ(posCur.y + ns * 0.001, posCur.x + ew * 0.001, effectiveAlt);
        vec4 clipCur  = u_projection * u_view * vec4(center, 1.0);
        vec4 clipFwd  = u_projection * u_view * vec4(fwdCenter, 1.0);
        vec2 screenCur = clipCur.xy / clipCur.w;
        vec2 screenFwd = clipFwd.xy / clipFwd.w;
        vec2 screenDelta = screenFwd - screenCur;

        float aspectCorrection = u_projection[1][1] / u_projection[0][0];
        vec2 corrected = vec2(screenDelta.x * aspectCorrection, screenDelta.y);
        heading = (speed2d > 0.5) ? atan(corrected.y, corrected.x) : 0.0;
    } else {
        // Fallback: derive heading from current → next position delta
        // Use non-interpolated positions so heading is stable across zoom
        vec3 headingCur  = latLonAltToXYZ(posCur.y,  posCur.x,  effectiveAlt);
        vec3 headingNext = latLonAltToXYZ(posNext.y, posNext.x, effectiveAlt);
        vec4 clipCur  = u_projection * u_view * vec4(headingCur, 1.0);
        vec4 clipNext = u_projection * u_view * vec4(headingNext, 1.0);
        vec2 screenCur  = clipCur.xy / clipCur.w;
        vec2 screenNext = clipNext.xy / clipNext.w;
        vec2 screenDelta = screenNext - screenCur;

        float speed = length(screenDelta);
        v_speed = clamp(speed * 200.0, 0.0, 1.0);

        if (speed > 0.0001) {
            float aspectCorrection = u_projection[1][1] / u_projection[0][0];
            vec2 corrected = vec2(screenDelta.x * aspectCorrection, screenDelta.y);
            heading = atan(corrected.y, corrected.x);
        } else {
            heading = 0.0;
        }
    }

    // Rotate quad so the SDF's +Y axis (chevron nose) points along heading.
    vec2 rotated;
    float angle = heading - PI * 0.5;
    float cosA = cos(angle);
    float sinA = sin(angle);
    rotated = vec2(
        a_quadVertex.x * cosA - a_quadVertex.y * sinA,
        a_quadVertex.x * sinA + a_quadVertex.y * cosA
    );

    // Billboard offset in camera space (using rotated quad)
    vec3 offset = u_cameraRight * rotated.x * size
                + u_cameraUp * rotated.y * size;

    vec3 pos = center + offset;

    gl_Position = u_projection * u_view * vec4(pos, 1.0);
    v_value = a_value;
    v_quadUV = a_quadVertex * 0.5 + 0.5;
    v_grounded = grounded ? 1.0 : 0.0;
    v_altitude = alt;
}
