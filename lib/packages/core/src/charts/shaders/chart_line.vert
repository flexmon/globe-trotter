#version 300 es
precision highp float;

// Time-series line — pre-computed pixel positions
in vec2 a_position;     // pixel position (with quad expansion)
in float a_edgeDist;    // signed distance from center for AA
in float a_normValue;   // normalized value for fill gradient

uniform vec2 u_resolution;

out float v_edgeDist;
out float v_normValue;

void main() {
    v_edgeDist = a_edgeDist;
    v_normValue = a_normValue;
    vec2 clip = a_position / u_resolution * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
}
