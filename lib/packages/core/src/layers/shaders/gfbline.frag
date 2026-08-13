#version 300 es
// gfbline.frag — SDF-based antialised line fragment shader.
// Uses signed distance from line center for smooth edges at any width.
// Color driven by StyleEngine ramp or categorical texture.

precision highp float;

in float v_dist;              // Signed distance from center: -1 (left edge) to +1 (right edge)
in float v_value;             // Attribute value for color lookup
in float v_visible;           // Visibility flag for filtering

uniform sampler2D u_colorRamp;  // 256×1 RGBA from StyleEngine
uniform vec2 u_domain;          // [min, max] for ramp normalization
uniform float u_opacity;        // Global line opacity
uniform float u_lineWidth;      // For AA threshold calculation

out vec4 fragColor;

void main() {
    // Filter: discard invisible fragments
    if (v_visible < 0.5) discard;
    // Color from ramp texture
    float t = clamp((v_value - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
    vec4 color = texture(u_colorRamp, vec2(t, 0.5));

    // SDF antialiasing: smooth falloff at edges
    // v_dist goes from -1 (left edge) to +1 (right edge)
    // The core line is where |v_dist| < lineCore, AA in the outer 1px
    float lineCore = u_lineWidth / (u_lineWidth + 1.0);
    float dist = abs(v_dist);
    float alpha = 1.0 - smoothstep(lineCore, 1.0, dist);

    fragColor = vec4(color.rgb, color.a * alpha * u_opacity);
}
