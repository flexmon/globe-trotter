// gfbpoint.merc.wgsl — WebGPU GFB billboard renderer for 2D Web Mercator projection.
//
// Bind group layout:
//   Group 0: Mercator camera + style uniforms (64 bytes = 16 × f32)
//   Group 1: Data textures (same layout as gfbpoint.wgsl — pos + vel textures)
//   Group 2: Color ramp (same as gfbpoint.wgsl)
//
// Positions are read as lat/lon from pos_tex (same RGBA32F layout as spherical).
// The vertex shader converts each instance position to Mercator world pixels,
// applies linear interpolation between epochs, projects to NDC, then offsets
// by quad_vertex in screen pixels to produce a fixed-size billboard.

// ─── Bind group 0: Mercator camera + style uniforms (80 bytes = 20 × f32) ───
struct MercUniforms {
    world_size:    f32,   // 256 × 2^zoom
    tex_size:      f32,   // ceil(sqrt(featureCount)) — position texture side length
    camera_offset: vec2f, // camera center in world pixels (centerX, centerY)
    viewport_size: vec2f, // canvas physical size (width, height)
    domain:        vec2f, // [min, max] for color ramp normalization
    epoch_frac:    f32,   // interpolation fraction [0, 1) between epochs
    opacity:       f32,   // layer opacity
    color_mode:    i32,   // 0=fallback, 1=ramp, 2=categorical
    cat_width:     f32,   // categorical LUT width
    pixel_size:    f32,   // billboard radius in screen pixels
    symbol_type:   i32,   // 0=circle+chevron, 1=arrow, 2=diamond, 3=circle
    time:          f32,   // performance.now()/1000 for pulse animation
    has_velocity:  i32,   // 1 = use velocity textures for heading  (offset 60)
    first_copy:    f32,   // offset 64: leftmost visible world-copy index (may be < 0)
    _pad0:         f32,   // offset 68
    _pad1:         f32,   // offset 72
    _pad2:         f32,   // offset 76
    // total: 80 bytes
};

@group(0) @binding(0) var<uniform> u: MercUniforms;

// ─── Bind group 1: Data textures (same layout as spherical gfbpoint.wgsl) ───
@group(1) @binding(0) var pos_tex:      texture_2d<f32>; // Current epoch (RGBA32F)
@group(1) @binding(1) var pos_tex_next: texture_2d<f32>; // Next epoch
@group(1) @binding(2) var data_sampler: sampler;          // Nearest-neighbor
@group(1) @binding(3) var vel_tex:      texture_2d<f32>; // Current velocity
@group(1) @binding(4) var vel_tex_next: texture_2d<f32>; // Next velocity
@group(1) @binding(5) var pos_tex_prev: texture_2d<f32>; // Previous epoch (e-1)
@group(1) @binding(6) var pos_tex_next2:texture_2d<f32>; // Epoch e+2

// ─── Bind group 2: Color ramp (same layout as spherical) ───
@group(2) @binding(0) var color_ramp:   texture_2d<f32>;
@group(2) @binding(1) var ramp_sampler: sampler;

// ─── Vertex I/O ───
// The billboard quad corner is derived from @builtin(vertex_index) rather than a
// vertex buffer so we can pack horizontal world copies into the vertex dimension:
// the draw issues 6 × copy_count vertices per instance, where corner = vi % 6 and
// copy = vi / 6. This keeps the per-instance value/visibility buffers (indexed by
// instance_index = feature) correct while repeating each point across the seam.
struct VertexInput {
    @location(1) value:       f32,   // Per-instance attribute value
    @location(2) visible:     f32,   // Per-instance visibility
};

// Two-triangle quad in [-1, 1] — matches _quadBuffer in GFBRenderer.js.
const QUAD = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0,  1.0), vec2f(-1.0, 1.0),
);

struct VertexOutput {
    @builtin(position) clip_position: vec4f,
    @location(0) value:    f32,
    @location(1) quad_uv:  vec2f,
    @location(2) speed:    f32,
    @location(3) grounded: f32,
};

const PI: f32 = 3.14159265359;

// Convert geographic coordinates to Mercator world pixels at zoom 0 (tile size 256).
fn lngLatToMerc(lng: f32, lat: f32) -> vec2f {
    let x = (lng + 180.0) / 360.0;
    let sin_lat = sin(lat * PI / 180.0);
    let y = 0.5 - log((1.0 + sin_lat) / (1.0 - sin_lat)) / (4.0 * PI);
    return vec2f(x * 256.0, y * 256.0);
}

// Sample lat/lon/alt from a position texture at the given feature index.
fn sample_pos(tex: texture_2d<f32>, feature_idx: i32) -> vec3f {
    let tsz = i32(u.tex_size);
    let tx = feature_idx % tsz;
    let ty = feature_idx / tsz;
    return textureLoad(tex, vec2i(tx, ty), 0).xyz;
}

@vertex
fn vs_main(
    in: VertexInput,
    @builtin(instance_index) instance_id: u32,
    @builtin(vertex_index) vertex_id: u32,
) -> VertexOutput {
    var out: VertexOutput;

    if (in.visible < 0.5) {
        out.clip_position = vec4f(2.0, 2.0, 2.0, 1.0);
        return out;
    }

    // Billboard corner + world copy from the vertex index (see VertexInput note).
    let quad_vertex = QUAD[vertex_id % 6u];
    let copy = f32(vertex_id / 6u);

    let feature_idx = i32(instance_id);
    let pos_cur  = sample_pos(pos_tex,       feature_idx);
    let pos_next = sample_pos(pos_tex_next,  feature_idx);

    // Sentinel: -1000 means no observation for this epoch
    if (pos_cur.x < -900.0 || pos_next.x < -900.0) {
        out.clip_position = vec4f(2.0, 2.0, 2.0, 1.0);
        return out;
    }

    // Convert both epoch positions to Mercator world pixels
    // pos_tex stores: .x = longitude, .y = latitude, .z = altitude
    let merc_cur = lngLatToMerc(pos_cur.x, pos_cur.y);
    var merc_next = lngLatToMerc(pos_next.x, pos_next.y);

    // Antimeridian unwrap: pick the shortest path between epochs in Mercator X.
    // Without this, a feature crossing ±180° interpolates the long way through
    // the prime meridian instead of stepping cleanly across the seam.
    let world_w = 256.0;
    let dx = merc_next.x - merc_cur.x;
    if (dx > world_w * 0.5)  { merc_next.x -= world_w; }
    if (dx < -world_w * 0.5) { merc_next.x += world_w; }

    // Linear interpolation in Mercator space between epochs
    var center_z0 = mix(merc_cur, merc_next, u.epoch_frac);

    // Wrap result back to [0, world_w); downstream camera-offset math
    // handles drawing near the seam.
    if (center_z0.x < 0.0)        { center_z0.x += world_w; }
    if (center_z0.x >= world_w)   { center_z0.x -= world_w; }

    // Scale from zoom-0 world coords to current zoom. Shift by whole world widths
    // so each vertex-band copy repeats across the antimeridian like the tiles do.
    let scale = u.world_size / 256.0;
    let wx = center_z0.x * scale + (u.first_copy + copy) * u.world_size;
    let wy = center_z0.y * scale;

    // Project to NDC (Y-flipped: screen Y increases downward in Mercator)
    let half_w = u.viewport_size.x * 0.5;
    let half_h = u.viewport_size.y * 0.5;
    let ndc_x =  (wx - u.camera_offset.x) / half_w;
    let ndc_y = -(wy - u.camera_offset.y) / half_h;

    // Derive screen-space heading from position delta
    let px_cur  = (merc_cur.x  * scale - u.camera_offset.x) / half_w;
    let py_cur  = -(merc_cur.y  * scale - u.camera_offset.y) / half_h;
    let px_next = (merc_next.x * scale - u.camera_offset.x) / half_w;
    let py_next = -(merc_next.y * scale - u.camera_offset.y) / half_h;
    let screen_delta = vec2f(px_next - px_cur, py_next - py_cur);
    let speed = length(screen_delta);

    var heading: f32 = 0.0;
    var has_heading: bool = false;

    // Velocity-based heading (overrides position delta when available)
    if (u.has_velocity == 1) {
        let vel_c = sample_pos(vel_tex,      feature_idx);
        let vel_n = sample_pos(vel_tex_next, feature_idx);
        let ew = mix(vel_c.x, vel_n.x, u.epoch_frac);
        let ns = mix(vel_c.y, vel_n.y, u.epoch_frac);
        let speed2d = sqrt(ew * ew + ns * ns);
        out.speed = clamp(speed2d / 300.0, 0.0, 1.0);
        if (speed2d > 0.5) {
            // EW → +NDC-x, NS → +NDC-y (after Y-flip Mercator → NDC)
            heading = atan2(ns, ew);
            has_heading = true;
        }
    }

    if (!has_heading) {
        out.speed = clamp(speed * 200.0, 0.0, 1.0);
        if (speed > 0.0001) {
            heading = atan2(screen_delta.y, screen_delta.x);
            has_heading = true;
        }
    }

    // Billboard quad offset in screen pixels → NDC
    var rotated: vec2f;
    if (has_heading) {
        let angle = heading - PI * 0.5;
        let cos_a = cos(angle);
        let sin_a = sin(angle);
        rotated = vec2f(
            quad_vertex.x * cos_a - quad_vertex.y * sin_a,
            quad_vertex.x * sin_a + quad_vertex.y * cos_a,
        );
    } else {
        rotated = quad_vertex;
    }

    let ndc_offset = rotated * u.pixel_size / vec2f(half_w, half_h);
    out.clip_position = vec4f(ndc_x + ndc_offset.x, ndc_y + ndc_offset.y, 0.0, 1.0);

    out.value   = in.value;
    out.quad_uv = quad_vertex * 0.5 + 0.5;
    out.grounded = 0.0; // Altitude-based grounding deferred for Mercator

    return out;
}

// ─── SDF shapes (same as spherical gfbpoint.wgsl) ───

fn circle_chevron_sdf(uv: vec2f) -> f32 {
    let p = (uv - 0.5) * 2.0;
    let px = abs(p.x);
    let circle = length(p) - 0.85;
    let v_angle = px * 0.55 + (p.y + 0.10) * 0.50 - 0.20;
    let v_bottom = -p.y - 0.50;
    let v_top = p.y - 0.10;
    let chevron = max(max(v_angle, v_bottom), -v_top);
    return max(circle, -chevron);
}

fn arrow_sdf(uv: vec2f) -> f32 {
    let p = (uv - 0.5) * 2.0;
    let px = abs(p.x);
    let arrow = px + (p.y - 0.6) * 0.6 - 0.1;
    let bottom = -p.y - 0.7;
    let notch = -px - (p.y + 0.2) * 0.8 + 0.15;
    return max(max(arrow, bottom), notch);
}

fn diamond_sdf(uv: vec2f) -> f32 {
    let p = (uv - 0.5) * 2.0;
    return abs(p.x) * 0.5 + abs(p.y) * 0.3 - 0.3;
}

fn plain_circle_sdf(uv: vec2f) -> f32 {
    return length(uv - 0.5) * 2.0 - 0.55;
}

// ─── Fragment Shader ───

const DEFAULT_POINT_COLOR: vec3f = vec3f(0.0, 0.75, 0.9);

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    var dist: f32;
    if (in.grounded > 0.5) {
        dist = plain_circle_sdf(in.quad_uv);
    } else {
        if (u.symbol_type == 1) { dist = arrow_sdf(in.quad_uv); }
        else if (u.symbol_type == 2) { dist = diamond_sdf(in.quad_uv); }
        else if (u.symbol_type == 3) { dist = plain_circle_sdf(in.quad_uv); }
        else { dist = circle_chevron_sdf(in.quad_uv); }
    }

    let glow_radius: f32 = 0.2;
    if (dist > glow_radius) { discard; }

    if (u.symbol_type == 0 && in.grounded < 0.5) {
        let p2 = (in.quad_uv - 0.5) * 2.0;
        let px2 = abs(p2.x);
        let in_circle = length(p2) < 0.88;
        let v_a = px2 * 0.55 + (p2.y + 0.10) * 0.50 - 0.20;
        let v_b = -p2.y - 0.50;
        let v_t = p2.y - 0.10;
        let in_chevron = v_a < 0.0 && v_b < 0.0 && v_t > 0.0;
        if (in_circle && in_chevron) { discard; }
    }

    var color: vec3f;
    var base_alpha: f32 = 1.0;

    if (u.color_mode == 1) {
        let t = clamp((in.value - u.domain.x) / (u.domain.y - u.domain.x), 0.0, 1.0);
        let c = textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5));
        color = c.rgb; base_alpha = c.a;
    } else if (u.color_mode == 2) {
        let t = clamp((in.value + 0.5) / u.cat_width, 0.0, 1.0);
        let c = textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5));
        color = c.rgb; base_alpha = c.a;
    } else {
        color = DEFAULT_POINT_COLOR;
    }

    let aa = fwidth(dist) * 1.5;
    let shape_mask = 1.0 - smoothstep(-aa, aa, dist);

    var glow: f32 = 0.0;
    if (dist > 0.0) {
        glow = 1.0 - smoothstep(0.0, glow_radius, dist);
        glow = glow * glow * 0.2;
    }

    let alpha = max(shape_mask * base_alpha, glow) * u.opacity;
    var final_color = color;
    if (glow > 0.0) {
        final_color = mix(color, mix(color, vec3f(1.0), 0.4), glow / max(alpha, 0.001));
    }

    return vec4f(final_color, alpha);
}
