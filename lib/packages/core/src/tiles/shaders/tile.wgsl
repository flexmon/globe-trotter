// Tile shader — Instanced rendering with texture 2D array.
// Each instance = one map tile. Vertex shader reads per-tile
// lat/lon bounds from a storage buffer using instance_index,
// computes lat/lon from grid UV, and projects to 3D.

struct Uniforms {
    view: mat4x4f,
    projection: mat4x4f,
    sun_direction: vec3f,
    tile_radius: f32,
};

struct TileData {
    merc_min_y: f32,
    merc_max_y: f32,
    merc_min_x: f32,
    merc_max_x: f32,
    layer: u32,
    opacity: f32,  // 0.0→1.0 fade-in driven by loadedAt; 1.0 = fully opaque
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var tile_textures: texture_2d_array<f32>;
@group(1) @binding(1) var tile_sampler: sampler;
@group(2) @binding(0) var<storage, read> tiles: array<TileData>;

struct VertexInput {
    @location(0) uv: vec2f,
    @builtin(instance_index) instance_id: u32,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4f,
    @location(0) uv: vec2f,
    @location(1) world_position: vec3f,
    @location(2) normal: vec3f,
    @location(3) @interpolate(flat) layer: u32,
    @location(4) @interpolate(flat) opacity: f32,
};

const PI: f32 = 3.14159265359;
const DEG2RAD: f32 = PI / 180.0;

fn lat_lon_to_xyz(lat: f32, lon: f32, r: f32) -> vec3f {
    let theta = (90.0 - lat) * DEG2RAD;
    let phi = (lon + 180.0) * DEG2RAD;
    let st = sin(theta);
    return vec3f(st * sin(phi), cos(theta), st * cos(phi)) * r;
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;

    let tile = tiles[in.instance_id];

    // Compute Web Mercator coordinates from UV and exact tile bounds.
    // Mapbox tiles are top-to-bottom: in.uv.y = 0 connects to merc_max_y (North)
    let mercY = tile.merc_max_y - in.uv.y * (tile.merc_max_y - tile.merc_min_y);
    let mercX = tile.merc_min_x + in.uv.x * (tile.merc_max_x - tile.merc_min_x);

    // Apply exact spherical inverse Mercator projection to recover true latitude and longitude.
    // phi = atan(sinh(mercY)), lambda = mercX
    var lat = atan(sinh(mercY)) * (180.0 / PI);
    let lon = mercX * (180.0 / PI);

    // FIX: Stretch poles to seal the sphere geometry!
    // Mapbox Web Mercator tiles only extend to ±85.0511°. This leaves gaping holes 
    // at the physical North and South poles of the 3D globe.
    // If we are drawing the topmost edge of a northern tile, snap the vertex to 90.0°.
    if (tile.merc_max_y > 3.141 && in.uv.y < 0.001) {
        lat = 90.0;
    } else if (tile.merc_min_y < -3.141 && in.uv.y > 0.999) {
        lat = -90.0;
    }

    let pos = lat_lon_to_xyz(lat, lon, u.tile_radius);
    out.uv = in.uv;
    out.world_position = pos;
    out.normal = normalize(pos);
    out.layer = tile.layer;
    out.opacity = tile.opacity;
    out.clip_position = u.projection * u.view * vec4f(pos, 1.0);

    // Remap depth: WebGL projection maps Z to [-1,1], WebGPU expects [0,1]
    out.clip_position.z = out.clip_position.z * 0.5 + out.clip_position.w * 0.5;

    // Depth-hack for stretched polar triangles.
    // The 5-degree stretch from 85° to 90° forms a flat cone that physically 
    // dips below the mathematical sphere of the background globe. Pull it closer 
    // in the depth buffer to reliably prevent Z-fighting and clipping holes.
    let pole_prox = smoothstep(80.0, 90.0, abs(lat));
    out.clip_position.z -= 0.002 * pole_prox * out.clip_position.w;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let tex_color = textureSample(tile_textures, tile_sampler, in.uv, in.layer);

    let normal = normalize(in.normal);
    let sun_dir = normalize(u.sun_direction);

    // Diffuse lighting
    let diffuse = max(dot(normal, sun_dir), 0.0);
    let ambient: f32 = 0.12;

    // Night side subtle glow
    let night_factor = max(-dot(normal, sun_dir), 0.0);
    let night_color = vec3f(0.02, 0.02, 0.04) * night_factor;

    // Atmospheric rim
    let view_dir = normalize(-in.world_position);
    let rim = 1.0 - max(dot(normal, view_dir), 0.0);
    let rim_color = vec3f(0.2, 0.4, 0.8) * pow(rim, 4.0) * 0.2;

    // Blend tile color with dark background using the tile's alpha channel.
    // Styled Mapbox tiles (satellite-streets, dark, etc.) are PNGs with
    // transparency where the satellite layer isn't rendered at low zoom.
    // Without this blend, the globe's Blue Marble texture bleeds through.
    // V4 satellite JPEG tiles always have alpha=1.0, so this is a no-op.
    let dark_bg = vec3f(0.01, 0.015, 0.04);
    let tile_rgb = mix(dark_bg, tex_color.rgb, tex_color.a);

    let final_color = tile_rgb * (ambient + diffuse * 0.9) + night_color + rim_color;

    // in.opacity drives the 300 ms fade-in when a tile first arrives.
    // The Z=2/Z=3 background tiles (always opacity=1.0) show through during
    // the fade because they render first (lower zoom → painter's algorithm).
    return vec4f(final_color, in.opacity);
}
