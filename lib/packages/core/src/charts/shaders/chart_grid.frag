#version 300 es
precision highp float;

in float v_edgeDist;

uniform vec4 u_color;
uniform float u_lineWidth;

out vec4 fragColor;

void main() {
    float halfWidth = u_lineWidth * 0.5;
    float dist = abs(v_edgeDist);
    float alpha = 1.0 - smoothstep(halfWidth - 1.0, halfWidth, dist);

    fragColor = vec4(u_color.rgb, u_color.a * alpha);
}
