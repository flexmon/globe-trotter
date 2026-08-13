#version 300 es
// h3hex.frag — Style-driven fragment shader for H3Flex cells.
// Color is sampled from a 256x1 ramp texture (compiled by StyleEngine).
// Side faces of extruded pillars are darkened for visual depth.
// GPU filter: evaluates up to 2 predicates with AND/OR combinator.

precision highp float;
precision highp int;

in float v_value;       // Raw attribute value from vertex shader
in float v_cellIndex;   // Cell index (for multi-attribute opacity lookup)
in float v_extrudeFlag; // 0.0=base, 1.0=top; interpolated values = side face
in float v_filterValue; // Value from filter texture (non-active column)

uniform sampler2D u_colorRamp;  // 256×1 RGBA texture from RampCompiler
uniform vec2 u_domain;          // [min, max] value range for normalization
uniform float u_opacity;        // Global layer opacity

// ─── Filter uniforms ───
// Op codes: 0=none, 1=eq, 2=gt, 3=lt, 4=gte, 5=lte, 6=between
uniform int u_filter1Op;
uniform float u_filter1Value;
uniform float u_filter1High;     // Upper bound for BETWEEN
uniform int u_filter1Target;     // 0=active metric (v_value), 1=filter texture

uniform int u_filter2Op;
uniform float u_filter2Value;
uniform float u_filter2High;
uniform int u_filter2Target;

uniform int u_filterCombinator;  // 0=AND, 1=OR

out vec4 fragColor;

bool evalFilter(int op, float fv, float threshold, float high) {
    if (op == 1) return abs(fv - threshold) < 0.5;  // EQ (with epsilon for enum ints)
    if (op == 2) return fv > threshold;               // GT
    if (op == 3) return fv < threshold;               // LT
    if (op == 4) return fv >= threshold;              // GTE
    if (op == 5) return fv <= threshold;              // LTE
    if (op == 6) return fv >= threshold && fv <= high; // BETWEEN
    return true;
}

void main() {
    // ─── GPU filter evaluation ───
    if (u_filter1Op > 0 || u_filter2Op > 0) {
        float fv1 = (u_filter1Target == 0) ? v_value : v_filterValue;
        float fv2 = (u_filter2Target == 0) ? v_value : v_filterValue;

        bool pass1 = (u_filter1Op > 0) ? evalFilter(u_filter1Op, fv1, u_filter1Value, u_filter1High) : true;
        bool pass2 = (u_filter2Op > 0) ? evalFilter(u_filter2Op, fv2, u_filter2Value, u_filter2High) : true;

        bool pass;
        if (u_filterCombinator == 1) {
            pass = pass1 || pass2;   // OR
        } else {
            pass = pass1 && pass2;   // AND (default)
        }

        if (!pass) discard;
    }

    // Normalize value to 0..1 within domain, sample color ramp texture
    float t = clamp((v_value - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
    vec4 rampColor = texture(u_colorRamp, vec2(t, 0.5));

    // Darken side faces: interpolated extrudeFlag (between 0 and 1) = side wall
    // Top faces have v_extrudeFlag ≈ 1.0, side faces interpolate 0↔1
    float sideFactor = smoothstep(0.0, 1.0, v_extrudeFlag);
    float brightness = mix(0.5, 1.0, sideFactor);  // sides are 50% darker

    fragColor = vec4(rampColor.rgb * brightness, rampColor.a * u_opacity);
}
