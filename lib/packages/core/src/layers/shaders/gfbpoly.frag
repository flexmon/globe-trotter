#version 300 es
// gfbpoly.frag — Polygon fill fragment shader with color ramp and optional outline.
// Color driven by StyleEngine ramp or categorical texture.

precision highp float;

in float v_value;
in vec3 v_normal;
in float v_visible;

uniform sampler2D u_colorRamp;
uniform vec2 u_domain;
uniform float u_opacity;

out vec4 fragColor;

void main() {
    // Filter: discard invisible fragments
    if (v_visible < 0.5) discard;
    float t = clamp((v_value - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
    vec4 color = texture(u_colorRamp, vec2(t, 0.5));

    // Subtle shading based on normal dot with sun direction
    vec3 sun = normalize(vec3(0.3, 0.8, 0.5));
    float shade = 0.7 + 0.3 * max(dot(v_normal, sun), 0.0);

    fragColor = vec4(color.rgb * shade, color.a * u_opacity);
}
