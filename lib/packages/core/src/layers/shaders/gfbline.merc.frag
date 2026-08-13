#version 300 es
// gfbline.merc.frag — WebGL2 GFB wide-line fragment shader for 2D Mercator.
//
// GLSL ES 3.00 port of the fragment half of gfbline.merc.wgsl.
// SDF antialiasing for smooth line edges; three color modes (fallback/ramp/categorical).

precision highp float;
precision highp int;

in float v_value;
in float v_dist;    // signed distance from center [-1, 1]
in float v_visible;

uniform sampler2D u_colorRamp;
uniform float     u_domainMin;
uniform float     u_domainMax;
uniform float     u_opacity;
uniform float     u_lineWidth;
uniform int       u_colorMode;
uniform float     u_catWidth;

out vec4 fragColor;

void main() {
    if (v_visible < 0.5) discard;

    // SDF antialiasing: smooth falloff at edges
    float lineCore = u_lineWidth / (u_lineWidth + 1.0);
    float dist = abs(v_dist);
    float alphaAA = 1.0 - smoothstep(lineCore, 1.0, dist);

    vec3  color     = vec3(0.0, 0.75, 0.9); // fallback teal
    float baseAlpha = 1.0;

    if (u_colorMode == 1) {
        float t = clamp((v_value - u_domainMin) / (u_domainMax - u_domainMin), 0.0, 1.0);
        vec4 c = texture(u_colorRamp, vec2(t, 0.5));
        color = c.rgb; baseAlpha = c.a;
    } else if (u_colorMode == 2) {
        float t = clamp((v_value + 0.5) / u_catWidth, 0.0, 1.0);
        vec4 c = texture(u_colorRamp, vec2(t, 0.5));
        color = c.rgb; baseAlpha = c.a;
    }

    float alpha = baseAlpha * alphaAA * u_opacity;
    if (alpha < 0.01) discard;

    fragColor = vec4(color, alpha);
}
