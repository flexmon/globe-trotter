#version 300 es
// tile.vert — Satellite tile rendering on the globe sphere.
// Receives raw lat/lon in degrees; projects to 3D on the GPU.

precision highp float;

in vec2 a_latLon;          // (lat, lon) in degrees
in vec2 a_uv;

uniform mat4 u_view;
uniform mat4 u_projection;
uniform float u_tileRadius; // shell radius (e.g. 1.0001)

out vec2 v_uv;
out vec3 v_position;
out vec3 v_normal;

const float PI = 3.14159265359;
const float DEG2RAD = PI / 180.0;

vec3 latLonToXYZ(float lat, float lon, float r) {
    float theta = (90.0 - lat) * DEG2RAD;
    float phi = (lon + 180.0) * DEG2RAD;
    float st = sin(theta);
    return vec3(st * sin(phi), cos(theta), st * cos(phi)) * r;
}

void main() {
  vec3 pos = latLonToXYZ(a_latLon.x, a_latLon.y, u_tileRadius);
  v_uv = a_uv;
  v_position = pos;
  v_normal = normalize(pos); // On unit sphere, normal ≈ position
  gl_Position = u_projection * u_view * vec4(pos, 1.0);
}
