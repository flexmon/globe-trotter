#version 300 es
// gfbpoly.merc.frag — WebGL2 GFB polygon fill fragment shader for 2D Mercator.
//
// GLSL ES 3.00 port of the fragment half of gfbpoly.merc.wgsl.
// No sun shading (flat 2D map); three color modes (fallback/ramp/categorical).

precision highp float;
precision highp int;

in float v_value;
in float v_visible;

uniform sampler2D u_colorRamp;
uniform float     u_domainMin;
uniform float     u_domainMax;
uniform float     u_opacity;
uniform int       u_colorMode;
uniform float     u_catWidth;

out vec4 fragColor;

void main() {
    if (v_visible < 0.5) discard;

    vec3  color     = vec3(0.3, 0.5, 0.8); // fallback blue-grey
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

    fragColor = vec4(color, baseAlpha * u_opacity);
}
