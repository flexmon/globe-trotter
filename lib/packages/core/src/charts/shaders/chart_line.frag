#version 300 es
precision highp float;

in float v_edgeDist;
in float v_normValue;

uniform vec4 u_lineColor;
uniform vec4 u_fillColor;
uniform float u_lineWidth;

out vec4 fragColor;

void main() {
    float halfWidth = u_lineWidth * 0.5;
    float dist = abs(v_edgeDist);

    // Anti-aliased line edge
    float lineAlpha = 1.0 - smoothstep(halfWidth - 1.5, halfWidth, dist);

    vec4 line = vec4(u_lineColor.rgb, u_lineColor.a * lineAlpha);

    // Gradient fill below line
    float fillAlpha = u_fillColor.a * v_normValue * 0.6;
    vec4 fill = vec4(u_fillColor.rgb, fillAlpha);

    fragColor = mix(fill, line, lineAlpha);
}
