// dgflex.wgsl — WGSL translation of dgflex.vert + dgflex.frag
// Renders DGFlex cells as extruded 3D pillars with temporal interpolation.
// Color driven by a 256×1 ramp texture from StyleEngine.

// ─── Bind group 0: Uniforms ───
struct Uniforms {
    view: mat4x4f,
    projection: mat4x4f,
    domain: vec2f,           // [min, max] for value normalization
    tex_size: f32,           // Data texture dimension (ceil(sqrt(cellCount)))
    epoch_frac: f32,         // Interpolation fraction [0,1) between epochs
    opacity: f32,            // Global layer opacity
    extrusion_scale: f32,    // 0.0 = flat, 0.012 = default 3D pillars
    // Filter uniforms
    filter_combinator: i32,  // 0=AND, 1=OR
    filter1_op: i32,         // 0=none, 1=eq, 2=gt, 3=lt, 4=gte, 5=lte, 6=between
    filter1_value: f32,
    filter1_high: f32,
    filter1_target: i32,     // 0=active metric, 1=filter texture
    filter2_op: i32,
    filter2_value: f32,
    filter2_high: f32,
    filter2_target: i32,
    color_mode: i32,         // 0=fallback, 1=ramp, 2=categorical
};

@group(0) @binding(0) var<uniform> u: Uniforms;

// ─── Bind group 1: Data textures ───
@group(1) @binding(0) var data_tex: texture_2d<f32>;          // Current epoch
@group(1) @binding(1) var data_tex_next: texture_2d<f32>;     // Next epoch
@group(1) @binding(2) var filter_tex: texture_2d<f32>;        // Filter data
@group(1) @binding(3) var data_sampler: sampler;              // Nearest sampler

// ─── Bind group 2: Color ramp ───
@group(2) @binding(0) var color_ramp: texture_2d<f32>;        // 256×1 RGBA
@group(2) @binding(1) var ramp_sampler: sampler;              // Linear sampler

// ─── Vertex I/O ───
struct VertexInput {
    @location(0) position: vec3f,      // Pre-computed 3D position on globe
    @location(1) cell_index: f32,      // Cell index for data texture lookup
    @location(2) extrude_flag: f32,    // 0.0=base, 1.0=top
};

struct VertexOutput {
    @builtin(position) clip_position: vec4f,
    @location(0) value: f32,            // Interpolated attribute value
    @location(1) cell_index: f32,
    @location(2) extrude_flag: f32,
    @location(3) filter_value: f32,     // Value from filter texture
};

const Z_FIGHT_OFFSET: f32 = 0.00003;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;

    // Look up attribute value from both epoch textures
    let idx = in.cell_index;
    let tex_y = floor(idx / u.tex_size);
    let tex_x = idx - tex_y * u.tex_size;
    let tex_coord = (vec2f(tex_x, tex_y) + 0.5) / u.tex_size;

    let val_current = textureSampleLevel(data_tex, data_sampler, tex_coord, 0.0).r;
    let val_next = textureSampleLevel(data_tex_next, data_sampler, tex_coord, 0.0).r;

    // Categorical data (mode 2) holds current value rigidly without intermediate interpolation.
    // Continuous data smoothly tweens between epochs.
    if (u.color_mode == 2) {
        out.value = val_current;
    } else {
        out.value = mix(val_current, val_next, u.epoch_frac);
    }
    out.cell_index = in.cell_index;
    out.extrude_flag = in.extrude_flag;

    // Fetch secondary filter value
    if (u.filter1_target > 0 || u.filter2_target > 0) {
        out.filter_value = textureSampleLevel(filter_tex, data_sampler, tex_coord, 0.0).r;
    } else {
        out.filter_value = 0.0;
    }

    // Extrude: top vertices push outward, base vertices stay on surface
    let normal = normalize(in.position);
    let normalized_val = clamp((out.value - u.domain.x) / (u.domain.y - u.domain.x), 0.0, 1.0);
    let extrude_val = pow(normalized_val, 1.2);
    let extrusion = in.extrude_flag * extrude_val * u.extrusion_scale + Z_FIGHT_OFFSET;
    let offset_pos = in.position + normal * extrusion;

    out.clip_position = u.projection * u.view * vec4f(offset_pos, 1.0);

    // Remap depth: WebGL projection Z [-1,1] → WebGPU [0,1]
    out.clip_position.z = out.clip_position.z * 0.5 + out.clip_position.w * 0.5;

    return out;
}

// ─── Fragment Shader ───

fn eval_filter(op: i32, fv: f32, threshold: f32, high: f32) -> bool {
    if (op == 1) { return abs(fv - threshold) < 0.5; }  // EQ
    if (op == 2) { return fv > threshold; }               // GT
    if (op == 3) { return fv < threshold; }               // LT
    if (op == 4) { return fv >= threshold; }              // GTE
    if (op == 5) { return fv <= threshold; }              // LTE
    if (op == 6) { return fv >= threshold && fv <= high; } // BETWEEN
    return true;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    // GPU filter evaluation
    if (u.filter1_op > 0 || u.filter2_op > 0) {
        var fv1: f32;
        var fv2: f32;
        if (u.filter1_target == 0) { fv1 = in.value; } else { fv1 = in.filter_value; }
        if (u.filter2_target == 0) { fv2 = in.value; } else { fv2 = in.filter_value; }

        var pass1 = true;
        var pass2 = true;
        if (u.filter1_op > 0) { pass1 = eval_filter(u.filter1_op, fv1, u.filter1_value, u.filter1_high); }
        if (u.filter2_op > 0) { pass2 = eval_filter(u.filter2_op, fv2, u.filter2_value, u.filter2_high); }

        var passes: bool;
        if (u.filter_combinator == 1) {
            passes = pass1 || pass2;
        } else {
            passes = pass1 && pass2;
        }

        if (!passes) { discard; }
    }

    // Normalize value, sample color ramp
    let t = clamp((in.value - u.domain.x) / (u.domain.y - u.domain.x), 0.0, 1.0);
    let ramp_color = textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5));

    // Side-face darkening
    let side_factor = smoothstep(0.0, 1.0, in.extrude_flag);
    let brightness = mix(0.5, 1.0, side_factor);

    return vec4f(ramp_color.rgb * brightness, ramp_color.a * u.opacity);
}
