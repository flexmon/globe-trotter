#version 300 es
// gfbpoly.vert — Polygon fill rendering for GFB POLYGON/MULTI_POLYGON geometry on globe
// Supports optional extrusion: polygons pushed outward along globe normal proportional to value.

precision highp float;

in vec3 a_position;    // lon, lat, altitude_feet (alt=0 when no altitude data)
in float a_value;      // per-vertex attribute value for color lookup
in float a_visible;    // per-vertex visibility flag for filtering

uniform mat4 u_view;
uniform mat4 u_projection;
uniform float u_extrusionScale; // 0 = flat on surface, > 0 = raised by value
uniform vec2 u_domain;          // [min, max] for value normalization

out float v_value;
out vec3 v_normal;
out float v_visible;

const float PI = 3.14159265359;
const float DEG2RAD = PI / 180.0;
const float GLOBE_RADIUS = 1.00005; // Just above globe surface
const float Z_FIGHT_OFFSET = 0.00003;
const float FEET_TO_GLOBE = 1.0 / 20925525.0;

vec3 latLonAltToXYZ(float lat, float lon, float altFeet) {
    float theta = (90.0 - lat) * DEG2RAD;
    float phi = (lon + 180.0) * DEG2RAD;
    float r = GLOBE_RADIUS + altFeet * FEET_TO_GLOBE;
    float st = sin(theta);
    return vec3(
        st * sin(phi),
        cos(theta),
        st * cos(phi)
    ) * r;
}

void main() {
    float altFeet = a_position.z;
    float r = GLOBE_RADIUS + altFeet * FEET_TO_GLOBE;
    vec3 pos = latLonAltToXYZ(a_position.y, a_position.x, altFeet);

    // Re-project onto sphere surface to fix chord geometry for large polygons.
    // Without this, the rasterizer linearly interpolates between vertices in 3D,
    // causing polygon interiors to dip below the sphere on large spans.
    pos = normalize(pos) * r;

    v_normal = normalize(pos);

    // Extrude outward along normal if scale > 0
    if (u_extrusionScale > 0.0) {
        float normalizedVal = clamp((a_value - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
        float extrudeVal = pow(normalizedVal, 1.2);
        pos += v_normal * (extrudeVal * u_extrusionScale + Z_FIGHT_OFFSET);
    }

    gl_Position = u_projection * u_view * vec4(pos, 1.0);
    v_value = a_value;
    v_visible = a_visible;
}
