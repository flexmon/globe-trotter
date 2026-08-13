#version 300 es
precision highp float;

in vec3 a_position;
in vec3 a_normal;
in vec2 a_uv;

uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_projection;
uniform sampler2D u_elevationMap;
uniform float u_terrainScale;

out vec3 v_normal;
out vec3 v_position;
out vec2 v_uv;
out float v_elevation;

void main() {
  v_uv = a_uv;

  // Skip elevation displacement when terrain is disabled (terrainScale=0).
  // When tiles are active, terrainScale is always 0.
  vec3 displaced = a_position;
  float elevation = 0.0;
  if (u_terrainScale > 0.0) {
      elevation = texture(u_elevationMap, v_uv).r;
      displaced = a_position * (1.0 + elevation * u_terrainScale);
  }
  v_elevation = elevation;

  vec4 worldPos = u_model * vec4(displaced, 1.0);
  v_position = worldPos.xyz;
  v_normal = mat3(u_model) * a_normal;
  gl_Position = u_projection * u_view * worldPos;
}
