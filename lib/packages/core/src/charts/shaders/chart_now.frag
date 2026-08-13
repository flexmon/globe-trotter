#version 300 es
precision highp float;

in vec2 v_pixel;

uniform float u_centerX;     // x-position of the "now" line in pixels
uniform float u_glowWidth;   // total glow width in pixels
uniform vec4 u_color;        // base color (cyan accent)

out vec4 fragColor;

void main() {
    float dist = abs(v_pixel.x - u_centerX);

    // Sharp center line (1px)
    float centerAlpha = 1.0 - smoothstep(0.0, 1.5, dist);

    // Soft glow (falloff from center)
    float glowAlpha = exp(-dist * dist / (u_glowWidth * u_glowWidth * 0.1));

    float alpha = max(centerAlpha, glowAlpha * 0.4);

    fragColor = vec4(u_color.rgb, u_color.a * alpha);
}
