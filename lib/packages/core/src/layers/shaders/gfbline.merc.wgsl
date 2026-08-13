// gfbline.merc.wgsl — WebGPU GFB wide-line renderer for 2D Web Mercator projection.
//
// Bind group layout:
//   Group 0: Mercator camera + style uniforms (48 bytes)
//   Group 1: Color ramp texture + sampler
//
// Vertex attributes (per-vertex, interleaved as separate buffers):
//   @location(0) geo_a:    vec3f  — segment start (lon, lat, alt)
//   @location(1) geo_b:    vec3f  — segment end (lon, lat, alt)
//   @location(2) side:     f32    — quad side: -1 = left, +1 = right
//   @location(3) value:    f32    — per-instance attribute for color lookup
//   @location(4) visible:  f32    — visibility flag (0=hidden, 1=visible)
//
// Each line segment A→B is a screen-space quad extruded perpendicular to the
// projected line direction. Geodetic coordinates are projected to Mercator
// world pixels in the vertex shader — no pre-baking.

// ─── Bind group 0: Mercator camera + style uniforms (48 bytes = 12 × f32) ───
struct MercUniforms {
    world_size:    f32,   // 256 × 2^zoom
    line_width:    f32,   // line width in pixels
    camera_offset: vec2f, // camera center in world pixels (centerX, centerY)
    viewport_size: vec2f, // canvas physical size (width, height)
    domain:        vec2f, // [min, max] for color ramp normalization
    opacity:       f32,   // layer opacity
    color_mode:    i32,   // 0=fallback, 1=ramp, 2=categorical
    cat_width:     f32,   // categorical LUT width
    first_copy:    f32,   // leftmost visible world-copy index (may be < 0)
    // total: 48 bytes (3 × vec2f = 24 bytes + 6 scalars = 24 bytes)
};

@group(0) @binding(0) var<uniform> u: MercUniforms;

// ─── Bind group 1: Color ramp ───
@group(1) @binding(0) var color_ramp:   texture_2d<f32>;
@group(1) @binding(1) var ramp_sampler: sampler;

// ─── Vertex I/O ───
struct VertexInput {
    @location(0) geo_a:   vec3f, // segment start (lon, lat, alt)
    @location(1) geo_b:   vec3f, // segment end (lon, lat, alt)
    @location(2) side:    f32,   // -1 or +1 (left/right edge of quad)
    @location(3) value:   f32,   // attribute value for color lookup
    @location(4) visible: f32,   // visibility flag
};

struct VertexOutput {
    @builtin(position) clip_position: vec4f,
    @location(0) value:   f32,
    @location(1) dist:    f32,   // signed distance from center [-1, 1] for AA
};

const PI: f32 = 3.14159265359;

// Convert geographic coordinates to Mercator world pixels at zoom 0 (tile size 256).
fn lngLatToMerc(lng: f32, lat: f32) -> vec2f {
    let x = (lng + 180.0) / 360.0;
    let sin_lat = sin(lat * PI / 180.0);
    let y = 0.5 - log((1.0 + sin_lat) / (1.0 - sin_lat)) / (4.0 * PI);
    return vec2f(x * 256.0, y * 256.0);
}

// Project Mercator zoom-0 world pixel to NDC. copy_off_px shifts the vertex by
// whole world widths (at the current zoom) so each instance draws one visible
// world copy, repeating lines across the antimeridian like the tiles do.
fn mercToNDC(world_px: vec2f, copy_off_px: f32) -> vec2f {
    let scale = u.world_size / 256.0;
    let wx =  world_px.x * scale + copy_off_px;
    let wy =  world_px.y * scale;
    let half_w = u.viewport_size.x * 0.5;
    let half_h = u.viewport_size.y * 0.5;
    return vec2f(
         (wx - u.camera_offset.x) / half_w,
        -(wy - u.camera_offset.y) / half_h, // Y-flip: Mercator Y grows down, NDC up
    );
}

@vertex
fn vs_main(
    in: VertexInput,
    @builtin(vertex_index) vert_idx: u32,
    @builtin(instance_index) instance: u32,
) -> VertexOutput {
    var out: VertexOutput;

    // Cull invisible vertices early
    if (in.visible < 0.5) {
        out.clip_position = vec4f(2.0, 2.0, 2.0, 1.0);
        return out;
    }

    // One instance per visible world copy, shifted by whole world widths.
    let copy_off = (u.first_copy + f32(instance)) * u.world_size;

    let merc_a = lngLatToMerc(in.geo_a.x, in.geo_a.y);
    let merc_b = lngLatToMerc(in.geo_b.x, in.geo_b.y);

    let ndc_a = mercToNDC(merc_a, copy_off);
    let ndc_b = mercToNDC(merc_b, copy_off);

    // Screen-space direction and perpendicular
    let screen_a = ndc_a * u.viewport_size * 0.5;
    let screen_b = ndc_b * u.viewport_size * 0.5;
    let dir = normalize(screen_b - screen_a);
    let perp = vec2f(-dir.y, dir.x);

    // Extrude perpendicular by half line width + 0.5px for AA
    let half_width = (u.line_width + 1.0) * 0.5;
    let screen_offset = perp * half_width * in.side;

    // Vertices 0,1 are at A; vertices 2,3 are at B
    // side pattern: 0=-1(A), 1=+1(A), 2=-1(B), 3=+1(B)
    // vertex_index within segment: 0→A, 1→A, 2→B, 3→B
    let at_b = f32(vert_idx % 4u) >= 2.0;
    let base_ndc = select(ndc_a, ndc_b, at_b);

    // Convert screen offset back to NDC
    let ndc_offset = screen_offset / (u.viewport_size * 0.5);
    out.clip_position = vec4f(base_ndc + ndc_offset, 0.0, 1.0);

    out.value = in.value;
    out.dist  = in.side;  // -1 at left edge, +1 at right — used for AA in frag

    return out;
}

// ─── Fragment Shader ───

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    // SDF antialiasing: smooth falloff at edges
    let line_core = u.line_width / (u.line_width + 1.0);
    let dist = abs(in.dist);
    let alpha_aa = 1.0 - smoothstep(line_core, 1.0, dist);

    var color: vec3f;
    var base_alpha: f32 = 1.0;

    if (u.color_mode == 1) {
        // Ramp
        let t = clamp((in.value - u.domain.x) / (u.domain.y - u.domain.x), 0.0, 1.0);
        let c = textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5));
        color = c.rgb; base_alpha = c.a;
    } else if (u.color_mode == 2) {
        // Categorical
        let t = clamp((in.value + 0.5) / u.cat_width, 0.0, 1.0);
        let c = textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5));
        color = c.rgb; base_alpha = c.a;
    } else {
        // Fallback: teal
        color = vec3f(0.0, 0.75, 0.9);
    }

    let alpha = base_alpha * alpha_aa * u.opacity;
    if (alpha < 0.01) { discard; }

    return vec4f(color, alpha);
}
