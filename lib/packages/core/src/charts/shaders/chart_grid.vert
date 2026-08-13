#version 300 es
precision highp float;

// Grid / axis lines — each vertex has the full pixel position pre-computed
in vec2 a_position;   // pre-computed pixel position (including quad expansion)
in float a_edgeDist;  // signed distance from line center for AA

uniform vec2 u_resolution;

out float v_edgeDist;

void main() {
    v_edgeDist = a_edgeDist;
    vec2 clip = a_position / u_resolution * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
}
