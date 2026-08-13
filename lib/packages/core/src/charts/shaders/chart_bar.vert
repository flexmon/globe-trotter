#version 300 es
precision highp float;

// Histogram bars — each vertex has pre-computed pixel position and color
in vec2 a_position;   // pixel position
in vec4 a_color;      // RGBA bar color

uniform vec2 u_resolution;

out vec4 v_color;

void main() {
    v_color = a_color;
    vec2 clip = a_position / u_resolution * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
}
