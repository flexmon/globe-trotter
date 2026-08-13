#version 300 es
// dgflex.vert — Renders DGFlex cells as extruded 3D pillars.
// Top vertices (a_extrudeFlag=1.0) push outward proportional to attribute value.
// Base vertices (a_extrudeFlag=0.0) stay on the globe surface.

precision highp float;

// Per-vertex: pre-computed 3D position on globe surface
in vec3 a_position;
// Per-vertex: cell index for data texture lookups
in float a_cellIndex;
// Per-vertex: 0.0=base (surface), 1.0=top (extruded)
in float a_extrudeFlag;

uniform mat4 u_view;
uniform mat4 u_projection;
uniform sampler2D u_dataTex;      // Current epoch supply values
uniform sampler2D u_dataTexNext;  // Next epoch supply values
uniform float u_texSize;          // Data texture dimension (ceil(sqrt(cellCount)))
uniform float u_epochFrac;        // Interpolation fraction [0, 1) between epochs
uniform vec2 u_domain;            // [min, max] for value normalization

// ─── Filter uniforms ───
uniform sampler2D u_filterTex;    // Secondary filter data (unit 3)
uniform int u_filter1Target;      // 0=active metric, 1=filter texture
uniform int u_filter2Target;      // 0=active metric, 1=filter texture

out float v_value;                // Interpolated attribute value for color ramp
out float v_cellIndex;            // Pass cell index to frag for opacity lookup
out float v_extrudeFlag;          // Pass to frag for side-face shading
out float v_filterValue;          // Value from filter texture (if filtering on non-active column)

// Extrusion: max height in globe units.
// 0.012 ≈ 250,000 ft — good balance between dramatic and readable.
uniform float u_extrusionScale;    // 0.0 = flat, 0.012 = default 3D pillars
uniform int u_colorMode;           // 0=fallback, 1=ramp, 2=categorical
const float Z_FIGHT_OFFSET = 0.00003;

void main() {
    // Look up attribute value from both epoch textures
    float idx = a_cellIndex;
    float texY = floor(idx / u_texSize);
    float texX = idx - texY * u_texSize;
    vec2 texCoord = (vec2(texX, texY) + 0.5) / u_texSize;

    float valCurrent = texture(u_dataTex, texCoord).r;
    float valNext = texture(u_dataTexNext, texCoord).r;

    // Categorical data (mode 2) holds current value rigidly without intermediate interpolation.
    if (u_colorMode == 2) {
        v_value = valCurrent;
    } else {
        v_value = mix(valCurrent, valNext, u_epochFrac);
    }
    v_cellIndex = a_cellIndex;
    v_extrudeFlag = a_extrudeFlag;

    // Fetch secondary filter value (only needed if filtering on non-active column)
    v_filterValue = (u_filter1Target > 0 || u_filter2Target > 0)
        ? texture(u_filterTex, texCoord).r
        : 0.0;

    // Extrude: top vertices push outward, base vertices stay on surface
    vec3 normal = normalize(a_position);
    float normalizedVal = clamp((v_value - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);

    // Power 1.2: gentle compression of low values, highs stand out clearly
    // without extremes. Good middle ground between linear and quadratic.
    float extrudeVal = pow(normalizedVal, 1.2);
    float extrusion = a_extrudeFlag * extrudeVal * u_extrusionScale + Z_FIGHT_OFFSET;
    vec3 offsetPos = a_position + normal * extrusion;

    gl_Position = u_projection * u_view * vec4(offsetPos, 1.0);
}
