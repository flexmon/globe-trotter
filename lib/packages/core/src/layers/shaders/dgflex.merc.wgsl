// dgflex.merc.wgsl — WebGPU DGFlex renderer for 2D Web Mercator projection
//                    with 2.5D extrusion support (tilt-aware oblique pillars).
//
// Mirror of dgflex.wgsl but with:
//   - vec2 positions (pre-baked at zoom 0 world pixels) instead of vec3 ECEF
//   - 2.5D pillar extrusion when tilt > 0 and extrusion_scale > 0
//   - Mercator camera uniforms (world_size / camera_offset / viewport_size / tilt)
//
// Bind groups 1 (data) + 2 (ramp) are reused unchanged from the spherical
// pipeline so DGFlexRenderer shares them between projections.
//
// See h3hex.merc.wgsl for the extrusion math derivation.

// ─── Bind group 0: Mercator camera + style uniforms (96 bytes = 24 × f32) ───
struct Uniforms {
    world_size:        f32,   // 256 × 2^zoom
    tex_size:          f32,   // ceil(sqrt(cellCount)) — data texture side length
    camera_offset:     vec2f, // camera center in world pixels (centerX, centerY)
    viewport_size:     vec2f, // canvas physical size (width, height)
    domain_min:        f32,   // value range min for color normalization
    domain_max:        f32,   // value range max
    epoch_frac:        f32,   // interpolation fraction [0, 1) between epochs
    opacity:           f32,   // layer opacity
    color_mode:        i32,   // 1=ramp, 2=categorical/constant (no interp)
    _pad_a:            i32,
    filter_combinator: i32,   // 0=AND, 1=OR
    filter1_op:        i32,   // 0=none, 1=EQ, 2=GT, 3=LT, 4=GTE, 5=LTE, 6=BETWEEN
    filter1_value:     f32,
    filter1_high:      f32,   // upper bound for BETWEEN
    filter1_target:    i32,   // 0=active metric, 1=filter texture
    filter2_op:        i32,
    filter2_value:     f32,
    filter2_high:      f32,
    filter2_target:    i32,
    extrusion_scale:   f32,   // world-pixels at zoom-0 per unit (0=flat)
    tilt:              f32,   // camera tilt in radians (from MercatorCameraController)
    _pad_d:            i32,   // total: 96 bytes, 16-byte aligned
};

@group(0) @binding(0) var<uniform> u: Uniforms;

// ─── Bind group 1: Data textures (same layout as spherical dgflex.wgsl) ───
@group(1) @binding(0) var data_tex:      texture_2d<f32>; // current epoch
@group(1) @binding(1) var data_tex_next: texture_2d<f32>; // next epoch
@group(1) @binding(2) var filter_tex:    texture_2d<f32>; // filter column data
@group(1) @binding(3) var data_sampler:  sampler;         // nearest-neighbor

// ─── Bind group 2: Color ramp (same layout as spherical) ───
@group(2) @binding(0) var color_ramp:    texture_2d<f32>;
@group(2) @binding(1) var ramp_sampler:  sampler;

// ─── Vertex I/O ───
struct VertexInput {
    @location(0) position:    vec2f, // Mercator world pixels at zoom 0
    @location(1) cell_index:  f32,   // cell index for data texture lookup
    @location(2) extrude_flag: f32,  // 0.0=base vertex, 1.0=top vertex
};

struct VertexOutput {
    @builtin(position) clip_position: vec4f,
    @location(0) value:        f32,
    @location(1) filter_value: f32,
    @location(2) valid:        f32,
    @location(3) extrude_flag: f32, // forwarded so frag can apply side-face shading
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;

    // Data-texture lookup
    let tsz = u.tex_size;
    let ty  = floor(in.cell_index / tsz);
    let tx  = in.cell_index - ty * tsz;
    let tc  = (vec2f(tx, ty) + 0.5) / tsz;

    let sz       = textureDimensions(data_tex);
    let uv       = vec2i(i32(tc.x * f32(sz.x)), i32(tc.y * f32(sz.y)));
    let val_cur  = textureLoad(data_tex,      uv, 0).r;
    let val_next = textureLoad(data_tex_next, uv, 0).r;

    // -3.4e38 sentinel = missing data
    out.valid = select(0.0, 1.0, val_cur > -1e37);

    out.value = select(
        mix(val_cur, val_next, u.epoch_frac),
        val_cur,
        u.color_mode == 2
    );
    out.extrude_flag = in.extrude_flag;

    if (u.filter1_target == 1 || u.filter2_target == 1) {
        let fsz = textureDimensions(filter_tex);
        let fuv = vec2i(i32(tc.x * f32(fsz.x)), i32(tc.y * f32(fsz.y)));
        out.filter_value = textureLoad(filter_tex, fuv, 0).r;
    } else {
        out.filter_value = 0.0;
    }

    // ── Mercator projection with optional 2.5D Z extrusion ──────────────────
    let scale = u.world_size / 256.0;
    let wx = in.position.x * scale;
    let wy = in.position.y * scale;

    let half_vp = u.viewport_size * 0.5;
    var sx =  (wx - u.camera_offset.x) / half_vp.x;
    var sy = -(wy - u.camera_offset.y) / half_vp.y;

    // See h3hex.merc.wgsl for the full derivation.
    var ndcZ = 0.0;
    if (u.extrusion_scale > 0.0 && in.extrude_flag > 0.5) {
        let normalized_val = clamp((out.value - u.domain_min) / (u.domain_max - u.domain_min), 0.0, 1.0);
        let extrude_val = pow(normalized_val, 1.2);
        let wz = in.extrude_flag * extrude_val * u.extrusion_scale * scale;

        let sinT = sin(u.tilt);
        sy = sy - wz * sinT / half_vp.y;

        ndcZ = extrude_val * 0.5;
    }

    out.clip_position = vec4f(sx, sy, ndcZ, 1.0);
    return out;
}

fn eval_filter(op: i32, fv: f32, threshold: f32, high: f32) -> bool {
    if (op == 1) { return abs(fv - threshold) < 0.5; }
    if (op == 2) { return fv > threshold; }
    if (op == 3) { return fv < threshold; }
    if (op == 4) { return fv >= threshold; }
    if (op == 5) { return fv <= threshold; }
    if (op == 6) { return fv >= threshold && fv <= high; }
    return true;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    if (in.valid < 0.5) { discard; }

    if (u.filter1_op > 0 || u.filter2_op > 0) {
        let fv1 = select(in.filter_value, in.value, u.filter1_target == 0);
        let fv2 = select(in.filter_value, in.value, u.filter2_target == 0);
        var pass1 = true;
        var pass2 = true;
        if (u.filter1_op > 0) { pass1 = eval_filter(u.filter1_op, fv1, u.filter1_value, u.filter1_high); }
        if (u.filter2_op > 0) { pass2 = eval_filter(u.filter2_op, fv2, u.filter2_value, u.filter2_high); }
        let passes = select(pass1 && pass2, pass1 || pass2, u.filter_combinator == 1);
        if (!passes) { discard; }
    }

    let t     = clamp((in.value - u.domain_min) / (u.domain_max - u.domain_min), 0.0, 1.0);
    let color = textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5));

    // Side-face darkening matches spherical dgflex.wgsl behaviour.
    let side_factor = smoothstep(0.0, 1.0, in.extrude_flag);
    let brightness  = mix(0.5, 1.0, side_factor);

    return vec4f(color.rgb * brightness, color.a * u.opacity);
}
