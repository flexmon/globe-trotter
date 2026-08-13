#version 300 es
// gfbpoint.frag — Filled circle with directional symbol, colored by category.
// Supports 4 SDF symbol types and 3 color modes.
// Category colors come from the LUT texture (compiled from YAML config).

precision highp float;

in float v_value;
in vec2 v_quadUV;
in float v_speed;
in float v_grounded;
in float v_altitude;

uniform sampler2D u_colorRamp;
uniform vec2 u_domain;
uniform float u_opacity;
uniform float u_time;
uniform float u_catWidth;    // LUT texture width for categorical sampling
uniform int u_colorMode;    // 0=fallback, 1=ramp, 2=categorical LUT
uniform int u_symbolType;   // 0=circle+chevron, 1=arrow, 2=diamond, 3=circle

out vec4 fragColor;

// Default fallback color for unconfigured point layers (colorMode=0)
const vec3 DEFAULT_POINT_COLOR = vec3(0.0, 0.75, 0.9); // cyan (#00BFE6)

// ── Symbol 0: Filled circle with V-chevron cutout ──
// Chevron points upward in UV space (+Y = direction of travel).
float circleChevronSDF(vec2 uv) {
    vec2 p = (uv - 0.5) * 2.0;
    float px = abs(p.x);

    // Circle body
    float circle = length(p) - 0.85;

    // V-chevron cutout — clearly visible arrow notch
    float vAngle = px * 0.55 + (p.y + 0.10) * 0.50 - 0.20;
    float vBottom = -p.y - 0.50;
    float vTop = p.y - 0.10;
    float chevron = max(max(vAngle, vBottom), -vTop);

    return max(circle, -chevron);
}

// ── Symbol 1: Solid filled arrow ──
float arrowSDF(vec2 uv) {
    vec2 p = (uv - 0.5) * 2.0;
    float px = abs(p.x);
    float arrow = px + (p.y - 0.6) * 0.6 - 0.1;
    float bottom = -p.y - 0.7;
    float notch = -px - (p.y + 0.2) * 0.8 + 0.15;
    return max(max(arrow, bottom), notch);
}

// ── Symbol 2: Diamond ──
float diamondSDF(vec2 uv) {
    vec2 p = (uv - 0.5) * 2.0;
    return abs(p.x) * 0.5 + abs(p.y) * 0.3 - 0.3;
}

// ── Symbol 3: Plain circle ──
float plainCircleSDF(vec2 uv) {
    return length(uv - 0.5) * 2.0 - 0.55;
}

void main() {
    float dist;
    if (v_grounded > 0.5) {
        dist = plainCircleSDF(v_quadUV);
    } else {
        if      (u_symbolType == 1) dist = arrowSDF(v_quadUV);
        else if (u_symbolType == 2) dist = diamondSDF(v_quadUV);
        else if (u_symbolType == 3) dist = plainCircleSDF(v_quadUV);
        else                        dist = circleChevronSDF(v_quadUV);
    }

    float glowRadius = 0.2;
    if (dist > glowRadius) discard;

    // Hard-discard inside chevron V-cutout to prevent glow from flooding the arrow notch
    if (u_symbolType == 0 && v_grounded < 0.5) {
        vec2 p2 = (v_quadUV - 0.5) * 2.0;
        float px2 = abs(p2.x);
        bool inCircle = length(p2) < 0.88;
        float va = px2 * 0.55 + (p2.y + 0.10) * 0.50 - 0.20;
        float vb = -p2.y - 0.50;
        float vt = p2.y - 0.10;
        bool inChevron = va < 0.0 && vb < 0.0 && vt > 0.0;
        if (inCircle && inChevron) discard;
    }

    // ── Color ──
    vec3 color;
    float baseAlpha = 1.0;

    if (u_colorMode == 1) {
        float t = clamp((v_value - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
        vec4 c = texture(u_colorRamp, vec2(t, 0.5));
        color = c.rgb; baseAlpha = c.a;
    } else if (u_colorMode == 2) {
        float tx = clamp((v_value + 0.5) / u_catWidth, 0.0, 1.0);
        vec4 c = texture(u_colorRamp, vec2(tx, 0.5));
        color = c.rgb; baseAlpha = c.a;
    } else {
        color = DEFAULT_POINT_COLOR;
    }

    // Antialiasing
    float aa = fwidth(dist) * 1.5;
    float shapeMask = 1.0 - smoothstep(-aa, aa, dist);

    // Subtle outer glow (airborne)
    float glow = 0.0;
    if (v_grounded < 0.5 && dist > 0.0) {
        glow = 1.0 - smoothstep(0.0, glowRadius, dist);
        glow *= glow * 0.2;
    }

    // Grounded pulse
    float pulse = 1.0;
    if (v_grounded > 0.5) {
        pulse = 0.6 + 0.4 * sin(u_time * 3.0 + v_value * 0.5);
    }

    float alpha = max(shapeMask * baseAlpha * pulse, glow) * u_opacity;
    vec3 finalColor = color;
    if (glow > 0.0) {
        finalColor = mix(color, mix(color, vec3(1.0), 0.4), glow / max(alpha, 0.001));
    }

    fragColor = vec4(finalColor, alpha);
}
