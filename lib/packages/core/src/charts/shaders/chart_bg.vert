#version 300 es
precision highp float;

// Panel background — simple fullscreen quad in pixel coords
in vec2 a_position;  // pixel coordinates of quad corners

uniform vec2 u_resolution;

out vec2 v_uv;

void main() {
    v_uv = a_position / u_resolution;
    vec2 clip = a_position / u_resolution * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
}
