// gfbpoly.merc.wgsl — WebGPU GFB polygon fill renderer for 2D Web Mercator projection.
//
// Bind group layout:
//   Group 0: Mercator camera + style uniforms (64 bytes)
//   Group 1: Color ramp texture + sampler
//
// Vertex attributes (per-vertex):
//   @location(0) position: vec3f — (lon, lat, alt) — geodetic coordinates
//   @location(1) value:    f32   — per-vertex attribute for color lookup
//   @location(2) visible:  f32   — visibility flag (0=hidden, 1=visible)
//
// Vertices store raw geodetic coordinates (lon, lat, alt). The vertex shader
// projects each vertex to Mercator world pixels per-frame — no pre-baking.
//
// Antimeridian-crossing triangles are pre-split by the JS renderer
// (splitMercatorPolygon in util/mercatorBake.js); split slivers carry lng
// values offset by ±360°, and lngLatToMerc projects them into the correct
// world-x positions on either side of the seam.
//
// 2.5D extrusion (when extrusion_scale > 0 and tilt > 0):
//   Polygon vertices are lifted in screen Y by sin(tilt) × wz, matching the
//   H3F/DGF pattern. wz = extrudeVal × extrusion_scale × scale (world-pixels
//   at current zoom). Mirrors the spherical lift behavior so toggling
//   modes preserves the visual relationship between polygons and value.

// ─── Bind group 0: Mercator camera + style uniforms (64 bytes = 16 × f32) ───
struct MercUniforms {
    world_size:      f32,   // offset 0:  256 × 2^zoom
    _pad0:           f32,   // offset 4:  alignment
    camera_offset:   vec2f, // offset 8:  camera center in world pixels (centerX, centerY)
    viewport_size:   vec2f, // offset 16: canvas physical size (width, height)
    domain:          vec2f, // offset 24: [min, max] for color ramp + extrusion normalization
    opacity:         f32,   // offset 32: layer opacity
    color_mode:      i32,   // offset 36: 0=fallback, 1=ramp, 2=categorical
    cat_width:       f32,   // offset 40: categorical LUT width
    extrusion_scale: f32,   // offset 44: world-pixels at zoom-0 per unit (0 = flat)
    tilt:            f32,   // offset 48: camera tilt in radians
    first_copy:      f32,   // offset 52: leftmost visible world-copy index (may be < 0)
    _pad2:           f32,   // offset 56
    _pad3:           f32,   // offset 60
    // total: 64 bytes
};

@group(0) @binding(0) var<uniform> u: MercUniforms;

// ─── Bind group 1: Color ramp ───
@group(1) @binding(0) var color_ramp:   texture_2d<f32>;
@group(1) @binding(1) var ramp_sampler: sampler;

// ─── Vertex I/O ───
struct VertexInput {
    @builtin(instance_index) instance: u32, // one instance per visible world copy
    @location(0) position: vec3f, // (lon, lat, alt_feet)
    @location(1) value:    f32,   // attribute value for color lookup
    @location(2) visible:  f32,   // visibility flag
};

struct VertexOutput {
    @builtin(position) clip_position: vec4f,
    @location(0) value:   f32,
    @location(1) visible: f32,
};

const PI: f32 = 3.14159265359;

// Convert geographic coordinates to Mercator world pixels at zoom 0 (tile size 256).
fn lngLatToMerc(lng: f32, lat: f32) -> vec2f {
    let x = (lng + 180.0) / 360.0;
    let sin_lat = sin(lat * PI / 180.0);
    let y = 0.5 - log((1.0 + sin_lat) / (1.0 - sin_lat)) / (4.0 * PI);
    return vec2f(x * 256.0, y * 256.0);
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.value   = in.value;
    out.visible = in.visible;

    let merc = lngLatToMerc(in.position.x, in.position.y);

    let scale  = u.world_size / 256.0;
    // Replicate horizontally: each instance is one visible world copy, shifted by
    // a whole world width so geometry repeats across the seam like the tiles do.
    let copy   = u.first_copy + f32(in.instance);
    let wx     =  merc.x * scale + copy * u.world_size;
    let wy     =  merc.y * scale;
    let half_w = u.viewport_size.x * 0.5;
    let half_h = u.viewport_size.y * 0.5;
    var ndc_x  =  (wx - u.camera_offset.x) / half_w;
    var ndc_y  = -(wy - u.camera_offset.y) / half_h; // Y-flip

    // 2.5D extrusion: lift the polygon in screen Y proportional to value.
    // Mirrors h3hex.merc.wgsl — see derivation there. Unlike hexes, polygons
    // have no top/base distinction (no side walls), so every vertex lifts by
    // the same amount and the polygon "floats" above the base plane.
    var ndc_z = 0.0;
    if (u.extrusion_scale > 0.0) {
        let normalized = clamp((in.value - u.domain.x) / (u.domain.y - u.domain.x), 0.0, 1.0);
        let extrude_val = pow(normalized, 1.2);
        let wz = extrude_val * u.extrusion_scale * scale;
        ndc_y = ndc_y - wz * sin(u.tilt) / half_h;
        ndc_z = extrude_val * 0.5;
    }

    out.clip_position = vec4f(ndc_x, ndc_y, ndc_z, 1.0);
    return out;
}

// ─── Fragment Shader ───

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    if (in.visible < 0.5) { discard; }

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
        // Fallback: blue-grey fill
        color = vec3f(0.3, 0.5, 0.8);
    }

    return vec4f(color, base_alpha * u.opacity);
}
