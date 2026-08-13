#version 300 es
precision highp float;

// Glyph-atlas text labels — each vertex has pixel position + UV into atlas
in vec2 a_position;   // pixel position
in vec2 a_uv;         // UV into glyph atlas texture
in vec4 a_color;      // RGBA text color

uniform vec2 u_resolution;

out vec2 v_uv;
out vec4 v_color;

void main() {
    v_uv = a_uv;
    v_color = a_color;
    vec2 clip = a_position / u_resolution * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
}
