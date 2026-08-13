#version 300 es
// h3hex.merc.frag — WebGL2 H3Flex Mercator fragment shader.
//
// GLSL ES 3.00 port of the fragment stage in h3hex.merc.wgsl.
//
// The filter logic and ramp lookup are structurally identical to the
// spherical h3hex.frag; the only difference is we have no side-face
// darkening (flat Mercator map — no extrusion in this pass).

precision highp float;
precision highp int;

// ── Varyings from vertex ──
in float v_value;
in float v_filterValue;
in float v_valid;

// ── Style uniforms ──
uniform sampler2D u_colorRamp;   // 256×1 RGBA ramp texture
uniform float     u_domainMin;
uniform float     u_domainMax;
uniform float     u_opacity;

// ── Filter uniforms ──
// Op codes: 0=none, 1=EQ, 2=GT, 3=LT, 4=GTE, 5=LTE, 6=BETWEEN
uniform int   u_filter1Op;
uniform float u_filter1Value;
uniform float u_filter1High;
uniform int   u_filter1Target;   // 0=active metric (v_value), 1=filter texture

uniform int   u_filter2Op;
uniform float u_filter2Value;
uniform float u_filter2High;
uniform int   u_filter2Target;

uniform int   u_filterCombinator; // 0=AND, 1=OR

out vec4 fragColor;

bool evalFilter(int op, float fv, float threshold, float high) {
    if (op == 1) return abs(fv - threshold) < 0.5;   // EQ (epsilon for enum ints)
    if (op == 2) return fv > threshold;                // GT
    if (op == 3) return fv < threshold;                // LT
    if (op == 4) return fv >= threshold;               // GTE
    if (op == 5) return fv <= threshold;               // LTE
    if (op == 6) return fv >= threshold && fv <= high; // BETWEEN
    return true;
}

void main() {
    // Discard missing-data cells (-3.4e38 sentinel)
    if (v_valid < 0.5) discard;

    // ── GPU filter evaluation ──
    if (u_filter1Op > 0 || u_filter2Op > 0) {
        float fv1 = (u_filter1Target == 0) ? v_value : v_filterValue;
        float fv2 = (u_filter2Target == 0) ? v_value : v_filterValue;

        bool pass1 = (u_filter1Op > 0) ? evalFilter(u_filter1Op, fv1, u_filter1Value, u_filter1High) : true;
        bool pass2 = (u_filter2Op > 0) ? evalFilter(u_filter2Op, fv2, u_filter2Value, u_filter2High) : true;

        bool pass = (u_filterCombinator == 1) ? (pass1 || pass2) : (pass1 && pass2);
        if (!pass) discard;
    }

    // Normalize value to [0, 1] within domain and sample color ramp
    float t = clamp((v_value - u_domainMin) / (u_domainMax - u_domainMin), 0.0, 1.0);
    vec4 rampColor = texture(u_colorRamp, vec2(t, 0.5));

    // Flat Mercator — no side-face darkening; use full brightness
    fragColor = vec4(rampColor.rgb, rampColor.a * u_opacity);
}
