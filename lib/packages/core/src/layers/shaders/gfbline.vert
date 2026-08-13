#version 300 es
// gfbline.vert — SDF-based wide line rendering for GeoFlex line features.
// Each line segment is a screen-space quad with SDF distance for antialiasing.
// Supports arbitrary line width via uniform.
// Receives raw geodetic coordinates; projects to 3D on the GPU.

precision highp float;

// Per-vertex: quad corner (-1 or +1 in the extrusion direction)
in float a_side;
// Per-vertex: the two endpoints of this segment as (lon, lat, altFeet)
in vec3 a_geoA;
in vec3 a_geoB;
// Per-vertex: attribute value (for color ramp or categorical lookup)
in float a_value;
// Per-vertex: visibility flag (1.0 = visible, 0.0 = filtered out)
in float a_visible;

uniform mat4 u_view;
uniform mat4 u_projection;
uniform float u_lineWidth;      // Line width in pixels
uniform vec2 u_resolution;      // Viewport width, height

out float v_dist;               // Signed distance from line center (-1..1)
out float v_value;              // Attribute value for color lookup
out float v_visible;            // Visibility flag for fragment discard

const float PI = 3.14159265359;
const float DEG2RAD = PI / 180.0;
const float GLOBE_RADIUS = 1.00015;
const float FEET_TO_GLOBE = 1.0 / 20925525.0;

vec3 latLonAltToXYZ(float lat, float lon, float altFeet) {
    float theta = (90.0 - lat) * DEG2RAD;
    float phi = (lon + 180.0) * DEG2RAD;
    float r = GLOBE_RADIUS + altFeet * FEET_TO_GLOBE;
    float st = sin(theta);
    return vec3(st * sin(phi), cos(theta), st * cos(phi)) * r;
}

void main() {
    // Project both endpoints from geodetic → 3D → clip space
    vec3 posA = latLonAltToXYZ(a_geoA.y, a_geoA.x, a_geoA.z);
    vec3 posB = latLonAltToXYZ(a_geoB.y, a_geoB.x, a_geoB.z);
    vec4 clipA = u_projection * u_view * vec4(posA, 1.0);
    vec4 clipB = u_projection * u_view * vec4(posB, 1.0);

    // Convert to NDC
    vec2 ndcA = clipA.xy / clipA.w;
    vec2 ndcB = clipB.xy / clipB.w;

    // Screen-space direction and perpendicular
    vec2 screenA = ndcA * u_resolution * 0.5;
    vec2 screenB = ndcB * u_resolution * 0.5;
    vec2 dir = normalize(screenB - screenA);
    vec2 perp = vec2(-dir.y, dir.x);

    // Extrude perpendicular by half line width + 1px for AA
    float halfWidth = (u_lineWidth + 1.0) * 0.5;
    vec2 offset = perp * halfWidth * a_side;

    // Interpolate position between endpoints based on vertex role
    // Vertices 0,1 are at posA; vertices 2,3 are at posB
    // The vertex buffer encodes this via gl_VertexID pattern
    vec4 clip = mix(clipA, clipB, step(0.5, float(gl_VertexID % 4) / 3.0));

    // Apply screen-space offset back to clip space
    vec2 screenOffset = offset / (u_resolution * 0.5);
    clip.xy += screenOffset * clip.w;

    gl_Position = clip;
    v_dist = a_side;   // -1 at left edge, +1 at right edge
    v_value = a_value;
    v_visible = a_visible;
}
