// h3hex.merc.wgsl — WebGPU H3Flex renderer for 2D Web Mercator projection
//                   with 2.5D extrusion support (tilt-aware oblique pillars).
//
// Bind group layout matches the spherical h3hex.wgsl (groups 0-2 with the
// same data / ramp groups) so H3FlexRenderer can reuse both the data and
// ramp bind groups and only swap group 0 for the Mercator-specific uniforms.
//
// Positions arrive as world pixels baked at zoom 0 (worldSize = 256).
// The vertex shader scales to the current zoom and projects to NDC via the
// same camera-offset / viewport-half transform as MercatorTileRenderer.
//
// 2.5D extrusion (when extrusion_scale > 0 and extrude_flag = 1):
//   Top vertices are displaced along +Z in world-pixel space before projection.
//   The tilt angle is used to compute the perspective foreshortening of the
//   Z offset into screen XY, matching what MercatorCameraController produces.
//
//   Unit mapping: extrusion_scale is in world-pixels at zoom-0.
//   spherical extrusion_scale of 0.012 ≈ 76 km.
//   At zoom 0: 1 px = (Earth circumference / 256) ≈ 156 km.
//   So 76 km ≈ 0.49 px at zoom 0.  The JS side passes a pre-converted value.
//   At zoom N the world-pixel extrusion is multiplied by (worldSize / 256)
//   so apparent pillar height is zoom-invariant in screen space.

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

// ─── Bind group 1: Data textures (same layout as spherical h3hex.wgsl) ───
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
    @location(0) value:        f32, // interpolated metric value
    @location(1) filter_value: f32, // from filter texture (non-active-metric predicates)
    @location(2) valid:        f32, // 1.0 = cell has data, 0.0 = missing
    @location(3) extrude_flag: f32, // forwarded for side-face shading in fragment
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;

    // Data-texture lookup (same as spherical shader)
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

    // Categorical values must not be interpolated
    out.value = select(
        mix(val_cur, val_next, u.epoch_frac),
        val_cur,
        u.color_mode == 2
    );
    out.extrude_flag = in.extrude_flag;

    // Filter texture (only read when a non-active-metric predicate is active)
    if (u.filter1_target == 1 || u.filter2_target == 1) {
        let fsz = textureDimensions(filter_tex);
        let fuv = vec2i(i32(tc.x * f32(fsz.x)), i32(tc.y * f32(fsz.y)));
        out.filter_value = textureLoad(filter_tex, fuv, 0).r;
    } else {
        out.filter_value = 0.0;
    }

    // ── Mercator projection with optional 2.5D Z extrusion ──────────────────
    //
    // Positions baked at zoom-0 world size (256); scale to current zoom.
    let scale = u.world_size / 256.0;
    let wx = in.position.x * scale;
    let wy = in.position.y * scale;

    // NDC XY before extrusion (flat top-down projection).
    let half_vp = u.viewport_size * 0.5;
    var sx =  (wx - u.camera_offset.x) / half_vp.x;
    var sy = -(wy - u.camera_offset.y) / half_vp.y;

    // 2.5D extrusion: when tilt > 0 and extrusion_scale > 0, top vertices
    // are lifted along +Z in world-pixel space. The tilt angle foreshortens
    // this into a Y shift on screen (the camera looks down the -Z axis tilted
    // by `tilt` around the local X axis, so a +Z world displacement projects
    // as a +Y screen displacement of magnitude Z * sin(tilt) / cos(tilt)
    // evaluated at the virtual camera height).
    //
    // Derivation: the tilt-aware view matrix from MercatorCameraController
    // places the eye at (0, sin(tilt)*h, cos(tilt)*h) looking at origin.
    // A point at world-space (wx, wy, wz) in that frame projects as:
    //   screen_y ∝ wy_view / wz_view  where the view transform rotates
    //   (wx, wy, wz) by -tilt around X.  Simplified for flat-map geometry
    //   (the base plane is Z=0, tilt angles up to 60°):
    //     projected_sy = sy + wz_scaled * sin(tilt) / half_vp.y
    //   where wz_scaled is the extrusion in world-pixels at current zoom.
    //
    // At tilt=0 sin(0)=0 so no displacement — flat mode unchanged.
    // The NDC depth (z) is set to a small positive value proportional to
    // the extrusion height so higher pillars occlude lower ones; with depth
    // testing enabled this gives correct inter-pillar occlusion.
    var ndcZ = 0.0;
    if (u.extrusion_scale > 0.0 && in.extrude_flag > 0.5) {
        let normalized_val = clamp((out.value - u.domain_min) / (u.domain_max - u.domain_min), 0.0, 1.0);
        // Apply the same power curve as spherical for visual consistency.
        let extrude_val = pow(normalized_val, 1.2);
        // Extrusion height in world-pixels at current zoom.
        let wz = in.extrude_flag * extrude_val * u.extrusion_scale * scale;

        // Project the Z offset onto screen Y: +Z world → screen-up when tilted.
        // sin(tilt) / half_vp.y converts world-px wz to a delta in NDC Y.
        let sinT = sin(u.tilt);
        sy = sy - wz * sinT / half_vp.y;

        // NDC depth: map extrusion to [0, 0.5] so top faces have smaller depth
        // than base faces. Scale by cos(tilt)/cameraH to normalise. For
        // simplicity we use a proportional encoding: ndcZ = extrude_val * 0.5.
        // This ensures depth ordering within a layer is correct even though
        // we don't compute the exact perspective depth — tile Z-fighting is
        // avoided because hex layers are already above the tile plane.
        ndcZ = extrude_val * 0.5;
    }

    out.clip_position = vec4f(sx, sy, ndcZ, 1.0);
    return out;
}

// ─── Filter helper ───
fn eval_filter(op: i32, fv: f32, threshold: f32, high: f32) -> bool {
    if (op == 1) { return abs(fv - threshold) < 0.5; }   // EQ
    if (op == 2) { return fv > threshold; }                // GT
    if (op == 3) { return fv < threshold; }                // LT
    if (op == 4) { return fv >= threshold; }               // GTE
    if (op == 5) { return fv <= threshold; }               // LTE
    if (op == 6) { return fv >= threshold && fv <= high; } // BETWEEN
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

    // Side-face darkening: top faces (extrude_flag=1) are full brightness;
    // base/side faces (extrude_flag=0) are darker. Matches spherical shader.
    let side_factor = smoothstep(0.0, 1.0, in.extrude_flag);
    let brightness  = mix(0.5, 1.0, side_factor);

    return vec4f(color.rgb * brightness, color.a * u.opacity);
}
