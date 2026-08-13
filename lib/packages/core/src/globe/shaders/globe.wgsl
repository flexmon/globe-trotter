// Globe shader — WGSL translation of globe.vert + globe.frag
// Renders a textured unit sphere with Blue Marble, bump mapping, lighting,
// specular highlights, night lights, and atmospheric rim.

struct Uniforms {
    model: mat4x4f,
    view: mat4x4f,
    projection: mat4x4f,
    sun_direction: vec3f,
    time: f32,
    terrain_scale: f32,
    dark_mode: f32,
    _pad0: f32,
    _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var earth_texture: texture_2d<f32>;
@group(1) @binding(1) var earth_sampler: sampler;
@group(1) @binding(2) var elevation_map: texture_2d<f32>;
@group(1) @binding(3) var elevation_sampler: sampler;

struct VertexInput {
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4f,
    @location(0) normal: vec3f,
    @location(1) world_position: vec3f,
    @location(2) uv: vec2f,
    @location(3) elevation: f32,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.uv = in.uv;

    var displaced = in.position;
    var elevation: f32 = 0.0;
    if (u.terrain_scale > 0.0) {
        elevation = textureSampleLevel(elevation_map, elevation_sampler, in.uv, 0.0).r;
        displaced = in.position * (1.0 + elevation * u.terrain_scale);
    }
    out.elevation = elevation;

    let world_pos = u.model * vec4f(displaced, 1.0);
    out.world_position = world_pos.xyz;
    out.normal = (mat4x4f(
        vec4f(u.model[0].xyz, 0.0),
        vec4f(u.model[1].xyz, 0.0),
        vec4f(u.model[2].xyz, 0.0),
        vec4f(0.0, 0.0, 0.0, 1.0)
    ) * vec4f(in.normal, 0.0)).xyz;
    out.clip_position = u.projection * u.view * world_pos;

    // Remap depth: WebGL projection maps Z to [-1,1], WebGPU expects [0,1]
    out.clip_position.z = out.clip_position.z * 0.5 + out.clip_position.w * 0.5;

    return out;
}

// Compute bump-mapped normal from heightmap
fn compute_bump_normal(uv: vec2f, normal: vec3f) -> vec3f {
    let tex_size = vec2f(textureDimensions(elevation_map, 0));
    let texel = 1.0 / tex_size;

    let hL = textureSampleLevel(elevation_map, elevation_sampler, uv + vec2f(-texel.x, 0.0), 0.0).r;
    let hR = textureSampleLevel(elevation_map, elevation_sampler, uv + vec2f(texel.x, 0.0), 0.0).r;
    let hD = textureSampleLevel(elevation_map, elevation_sampler, uv + vec2f(0.0, -texel.y), 0.0).r;
    let hU = textureSampleLevel(elevation_map, elevation_sampler, uv + vec2f(0.0, texel.y), 0.0).r;

    let bump_strength: f32 = 2.5;
    let dU = vec3f(1.0, 0.0, (hR - hL) * bump_strength);
    let dV = vec3f(0.0, 1.0, (hU - hD) * bump_strength);

    let bump_normal = normalize(cross(dU, dV));

    let N = normalize(normal);
    let T = normalize(cross(N, vec3f(0.0, 1.0, 0.001)));
    let B = normalize(cross(N, T));
    // TBN transform
    return normalize(T * bump_normal.x + B * bump_normal.y + N * bump_normal.z);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    // Dark mode early-out when tiles are active
    if (u.dark_mode > 0.5) {
        return vec4f(0.02, 0.02, 0.02, 1.0);
    }

    let sun_dir = normalize(u.sun_direction);

    // Sample Blue Marble
    let tex_color = textureSample(earth_texture, earth_sampler, in.uv);

    // Bump-mapped normal
    let bumped_normal = compute_bump_normal(in.uv, in.normal);
    let normal = bumped_normal;

    // Diffuse lighting
    let diffuse = max(dot(normal, sun_dir), 0.0);
    let ambient: f32 = 0.25;

    // Ocean vs land detection
    let elevation = in.elevation;
    let is_ocean = smoothstep(0.0, 0.06, 1.0 - elevation);
    let blue_ratio = tex_color.b / max(tex_color.r + tex_color.g + tex_color.b, 0.001);
    let color_ocean_mask = smoothstep(0.35, 0.45, blue_ratio);
    let ocean_mask = max(is_ocean * 0.5, color_ocean_mask);

    // Specular reflection
    let view_dir = normalize(-in.world_position);
    let half_vec = normalize(sun_dir + view_dir);
    let spec_power = mix(16.0, 128.0, ocean_mask);
    let spec_intensity = mix(0.05, 0.8, ocean_mask);
    let specular = pow(max(dot(normal, half_vec), 0.0), spec_power) * spec_intensity;

    let spec_color = mix(vec3f(1.0), vec3f(0.7, 0.85, 1.0), ocean_mask);

    // Night-side city lights
    let night_factor = max(-dot(normal, sun_dir), 0.0);
    let night_intensity = night_factor * 0.12;
    let night_color = vec3f(1.0, 0.8, 0.4) * night_intensity * (1.0 - ocean_mask * 0.8);

    // Atmospheric rim
    let rim = 1.0 - max(dot(normalize(in.normal), view_dir), 0.0);
    let rim_color = vec3f(0.3, 0.5, 1.0) * pow(rim, 3.5) * 0.35;

    // Terrain color enhancement
    var enhanced_color = tex_color.rgb;
    let lum = dot(enhanced_color, vec3f(0.299, 0.587, 0.114));
    enhanced_color = mix(vec3f(lum), enhanced_color, 1.2);

    // Snow on high elevation
    let snow_line = smoothstep(0.55, 0.70, elevation);
    enhanced_color = mix(enhanced_color, vec3f(0.92, 0.94, 0.96), snow_line * 0.6);

    // Final composition
    var final_color = enhanced_color * (ambient + diffuse)
                    + specular * spec_color
                    + night_color
                    + rim_color;

    // Terminator glow
    let terminator = exp(-pow((diffuse - 0.02) * 18.0, 2.0)) * 0.12;
    final_color += vec3f(1.0, 0.35, 0.12) * terminator;

    // Clamp and gentle gamma brightening (no Reinhard — Blue Marble values are already [0,1])
    final_color = clamp(final_color, vec3f(0.0), vec3f(1.0));
    final_color = pow(final_color, vec3f(0.85));

    return vec4f(final_color, 1.0);
}
