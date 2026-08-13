// gfbpoint.wgsl — WGSL translation of gfbpoint.vert + gfbpoint.frag
// Instanced billboard rendering for GFB temporal point data.
// Heading-aware: derives direction from current→next position delta.
// SDF-based symbols with 4 types and 3 color modes.

// ─── Bind group 0: Uniforms ───
struct Uniforms {
    view: mat4x4f,
    projection: mat4x4f,
    camera_right: vec3f,
    _pad0: f32,
    camera_up: vec3f,
    _pad1: f32,
    camera_position: vec3f,
    symbol_scale: f32,
    domain: vec2f,
    opacity: f32,
    time: f32,
    tex_size: f32,
    epoch_frac: f32,
    cat_width: f32,
    color_mode: i32,            // 0=fallback, 1=ramp, 2=categorical
    symbol_type: i32,           // 0=circle+chevron, 1=arrow, 2=diamond, 3=circle
    base_size: f32,             // Base billboard size in globe units
    zoom_near: f32,             // Camera dist where symbols smallest
    zoom_far: f32,              // Camera dist where symbols largest
    zoom_min_scale: f32,        // Min scale fraction at close zoom
    has_velocity: i32,          // 1 = use velocity textures for heading
    extrusion_scale: f32,       // Exaggerate authentic real-world heights
    _pad3: f32,
    _pad4: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

// ─── Bind group 1: Data textures ───
@group(1) @binding(0) var pos_tex: texture_2d<f32>;          // Current epoch e0 (RGBA32F)
@group(1) @binding(1) var pos_tex_next: texture_2d<f32>;     // Next epoch e1
@group(1) @binding(2) var data_sampler: sampler;              // Nearest sampler
@group(1) @binding(3) var vel_tex: texture_2d<f32>;          // Current epoch velocity
@group(1) @binding(4) var vel_tex_next: texture_2d<f32>;     // Next epoch velocity
@group(1) @binding(5) var pos_tex_prev: texture_2d<f32>;     // Previous epoch e-1
@group(1) @binding(6) var pos_tex_next2: texture_2d<f32>;    // Epoch e+2

// ─── Bind group 2: Color ramp/LUT ───
@group(2) @binding(0) var color_ramp: texture_2d<f32>;
@group(2) @binding(1) var ramp_sampler: sampler;

// ─── Vertex I/O ───
struct VertexInput {
    @location(0) quad_vertex: vec2f,     // Per-vertex billboard quad
    @location(1) value: f32,             // Per-instance attribute
    @location(2) visible: f32,           // Per-instance visibility
};

struct VertexOutput {
    @builtin(position) clip_position: vec4f,
    @location(0) value: f32,
    @location(1) quad_uv: vec2f,
    @location(2) speed: f32,
    @location(3) grounded: f32,
    @location(4) altitude: f32,
};

const PI: f32 = 3.14159265359;
const DEG2RAD: f32 = 3.14159265359 / 180.0;
const GLOBE_RADIUS: f32 = 1.0;
const FEET_TO_GLOBE: f32 = 1.0 / 20925525.0;

fn lat_lon_alt_to_xyz(lat: f32, lon: f32, alt_feet: f32) -> vec3f {
    let theta = (90.0 - lat) * DEG2RAD;
    let phi = (lon + 180.0) * DEG2RAD;
    let r = GLOBE_RADIUS + alt_feet * FEET_TO_GLOBE;
    return vec3f(
        sin(theta) * sin(phi),
        cos(theta),
        sin(theta) * cos(phi),
    ) * r;
}

// Cheap unit-direction vector from lat/lon degrees — avoids the full
// lat_lon_alt_to_xyz() cost (no altitude multiply) when only direction is needed.
// Cost: 2 sin + 2 cos, with cos(lat) shared between x and z components.
fn dir_from_lat_lon(lat_deg: f32, lon_deg: f32) -> vec3f {
    let theta = (90.0 - lat_deg) * DEG2RAD;  // colatitude
    let phi   = (lon_deg + 180.0) * DEG2RAD;
    let sin_t = sin(theta);
    let cos_t = cos(theta);
    let sin_p = sin(phi);
    let cos_p = cos(phi);
    return vec3f(sin_t * sin_p, cos_t, sin_t * cos_p);
}

// Spherical linear interpolation — follows a great-circle arc on the sphere.
// Critical for correct interpolation on a globe: plain mix() in lat/lon space
// produces rhumb-line paths that visibly deviate from great circles, especially
// at high latitudes where longitude lines converge toward the poles. For
// orbital or long-range paths this causes visible "bouncing" artifacts.
//
// Inputs are assumed to be unit vectors (from dir_from_lat_lon). The return
// value is also a unit vector; scale by radius after calling.
fn slerp_unit(n0: vec3f, n1: vec3f, t: f32) -> vec3f {
    let d = clamp(dot(n0, n1), -1.0, 1.0);
    let theta = acos(d);
    // Raised threshold (0.01 rad ≈ 0.57°): nearly-stationary features (ground
    // stations, parked assets) take the cheap mix() path with no visible error.
    // LEO orbital arcs (~4° per 60s epoch) always use the full slerp path.
    if (theta < 0.01) {
        return normalize(mix(n0, n1, t));
    }
    let sin_theta = sin(theta);
    return n0 * (sin((1.0 - t) * theta) / sin_theta)
         + n1 * (sin(t * theta) / sin_theta);
}

fn sample_pos(tex: texture_2d<f32>, samp: sampler, feature_idx: i32, tex_size: f32) -> vec3f {
    let tx = f32(feature_idx % i32(tex_size)) + 0.5;
    let ty = floor(f32(feature_idx) / tex_size) + 0.5;
    let uv = vec2f(tx, ty) / tex_size;
    let d = textureSampleLevel(tex, samp, uv, 0.0);
    return d.xyz;
}

// Catmull-Rom spline: C1-continuous cubic interpolation through 4 control points.
// The curve passes through P1 at t=0 and P2 at t=1, using P0 and P3 to
// determine tangent direction. Eliminates velocity discontinuities at epoch
// boundaries that cause visible "choppiness" at high playback speeds.
fn catmullRom(p0: vec3f, p1: vec3f, p2: vec3f, p3: vec3f, t: f32) -> vec3f {
    let t2 = t * t;
    let t3 = t2 * t;
    return 0.5 * (
        (2.0 * p1) +
        (-p0 + p2) * t +
        (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
        (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
    );
}

// Scalar Catmull-Rom for altitude interpolation
fn catmullRomScalar(v0: f32, v1: f32, v2: f32, v3: f32, t: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    return 0.5 * (
        (2.0 * v1) +
        (-v0 + v2) * t +
        (2.0 * v0 - 5.0 * v1 + 4.0 * v2 - v3) * t2 +
        (-v0 + 3.0 * v1 - 3.0 * v2 + v3) * t3
    );
}

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) instance_id: u32) -> VertexOutput {
    var out: VertexOutput;

    // Filter: skip invisible instances
    if (in.visible < 0.5) {
        out.clip_position = vec4f(2.0, 2.0, 2.0, 1.0);
        return out;
    }

    let feature_idx = i32(instance_id);
    let pos_prev  = sample_pos(pos_tex_prev,  data_sampler, feature_idx, u.tex_size);
    let pos_cur   = sample_pos(pos_tex,       data_sampler, feature_idx, u.tex_size);
    let pos_next  = sample_pos(pos_tex_next,  data_sampler, feature_idx, u.tex_size);
    let pos_next2 = sample_pos(pos_tex_next2, data_sampler, feature_idx, u.tex_size);

    // Catmull-Rom altitude: smooth vertical transitions
    let alt = catmullRomScalar(pos_prev.z, pos_cur.z, pos_next.z, pos_next2.z, u.epoch_frac);

    // Grounded detection: only classify as grounded if altitude data exists
    // (alt > 0 means we have real altitude). When alt == 0 for all features,
    // altitude data is simply absent — treat as airborne.
    let grounded = alt > 0.0 && alt < 100.0;
    var effective_alt: f32;
    var size: f32;

    // Scale-dependent rendering: zoom attenuation
    let cam_dist = length(u.camera_position);
    let zoom_scale = smoothstep(u.zoom_near, u.zoom_far, cam_dist);
    let zoom_factor = mix(u.zoom_min_scale, 1.0, zoom_scale);

    if (grounded) {
        effective_alt = 800.0 * u.extrusion_scale;
        size = u.base_size * 0.35 * zoom_factor;
    } else if (alt < 1.0) {
        // No altitude data — use extrusion scale as fixed altitude
        effective_alt = 800.0 * u.extrusion_scale;
        size = u.base_size * u.symbol_scale * zoom_factor;
    } else {
        effective_alt = alt * u.extrusion_scale;
        size = u.base_size * u.symbol_scale * zoom_factor;
    }

    // Sentinel checks for valid trajectory bounds (extract.py writes -1000.0)
    let valid_prev  = pos_prev.x > -900.0;
    let valid_cur   = pos_cur.x > -900.0;
    let valid_next  = pos_next.x > -900.0;
    let valid_next2 = pos_next2.x > -900.0;

    // Hard clip if the primary interval lacks observation
    if (!valid_cur || !valid_next) {
        out.clip_position = vec4f(2.0, 2.0, 2.0, 1.0);
        return out;
    }

    // Catmull-Rom interpolation in XYZ space: convert all 4 epoch positions
    // to unit-sphere directions, apply Catmull-Rom for C1-smooth trajectory.
    let dir_cur   = lat_lon_alt_to_xyz(pos_cur.y,   pos_cur.x,   0.0);
    let dir_next  = lat_lon_alt_to_xyz(pos_next.y,  pos_next.x,  0.0);
    
    var dir_interp: vec3f;
    if (!valid_prev || !valid_next2) {
        // Fallback to Slerp at the fringes where we lack 4 continuous points
        dir_interp = slerp_unit(dir_cur, dir_next, u.epoch_frac);
    } else {
        let dir_prev  = lat_lon_alt_to_xyz(pos_prev.y,  pos_prev.x,  0.0);
        let dir_next2 = lat_lon_alt_to_xyz(pos_next2.y, pos_next2.x, 0.0);
        dir_interp = catmullRom(dir_prev, dir_cur, dir_next, dir_next2, u.epoch_frac);
    }
    let r = GLOBE_RADIUS + effective_alt * FEET_TO_GLOBE;
    // Use inverseSqrt-based scaling (hardware rsqrt) instead of normalize()*r.
    // dir_interp is already a unit vector from slerp_unit, but floating-point
    // drift after the slerp means a final normalise is still needed.
    let center = dir_interp * (r * inverseSqrt(dot(dir_interp, dir_interp)));

    // Geometric horizon test.
    // dir_interp is the unit direction of center (center = dir_interp * r),
    // so reuse it directly — saves one normalize() call.
    let horizon = dot(dir_interp, u.camera_position);
    if (horizon < 1.0) {
        out.clip_position = vec4f(2.0, 2.0, 2.0, 1.0);
        return out;
    }

    // ── Derive heading ──
    var heading: f32 = 0.0;
    var has_heading: bool = false;

    if (u.has_velocity == 1) {
        // Velocity-based heading: ew/ns velocity from data textures
        let vel_cur  = sample_pos(vel_tex,      data_sampler, feature_idx, u.tex_size);
        let vel_next = sample_pos(vel_tex_next, data_sampler, feature_idx, u.tex_size);
        let ew = mix(vel_cur.x, vel_next.x, u.epoch_frac);
        let ns = mix(vel_cur.y, vel_next.y, u.epoch_frac);
        let speed2d = sqrt(ew * ew + ns * ns);
        out.speed = clamp(speed2d / 300.0, 0.0, 1.0);  // normalize ~300 m/s max

        if (speed2d > 0.5) {
            // Project geographic velocity into screen-space heading.
            // ew → eastward, ns → northward. Nudge position by velocity to get screen delta.
            let fwd_center = lat_lon_alt_to_xyz(pos_cur.y + ns * 0.001, pos_cur.x + ew * 0.001, effective_alt);
            let clip_c  = u.projection * u.view * vec4f(center, 1.0);
            let clip_f  = u.projection * u.view * vec4f(fwd_center, 1.0);
            let screen_c = clip_c.xy / clip_c.w;
            let screen_f = clip_f.xy / clip_f.w;
            let screen_delta = screen_f - screen_c;

            let aspect_correction = u.projection[1][1] / u.projection[0][0];
            let corrected = vec2f(screen_delta.x * aspect_correction, screen_delta.y);
            heading = atan2(corrected.y, corrected.x);
            has_heading = true;
        }
        // If velocity is zero for this feature, fall through to position-delta below
    }

    // Position-delta fallback: used when velocity data is unavailable globally
    // (has_velocity==0) OR when a specific feature has zero velocity.
    if (!has_heading) {
        let heading_cur  = lat_lon_alt_to_xyz(pos_cur.y,  pos_cur.x,  effective_alt);
        let heading_next = lat_lon_alt_to_xyz(pos_next.y, pos_next.x, effective_alt);
        let clip_cur  = u.projection * u.view * vec4f(heading_cur, 1.0);
        let clip_next = u.projection * u.view * vec4f(heading_next, 1.0);
        let screen_cur = clip_cur.xy / clip_cur.w;
        let screen_next = clip_next.xy / clip_next.w;
        let screen_delta = screen_next - screen_cur;

        let speed = length(screen_delta);
        if (u.has_velocity == 0) {
            out.speed = clamp(speed * 200.0, 0.0, 1.0);
        }

        if (speed > 0.0001) {
            let aspect_correction = u.projection[1][1] / u.projection[0][0];
            let corrected = vec2f(screen_delta.x * aspect_correction, screen_delta.y);
            heading = atan2(corrected.y, corrected.x);
            has_heading = true;
        }
    }

    // Rotate quad so the SDF's +Y axis (chevron nose) points along heading.
    var rotated: vec2f;
    if (has_heading) {
        let angle = heading - PI * 0.5;
        let cos_a = cos(angle);
        let sin_a = sin(angle);
        rotated = vec2f(
            in.quad_vertex.x * cos_a - in.quad_vertex.y * sin_a,
            in.quad_vertex.x * sin_a + in.quad_vertex.y * cos_a,
        );
    } else {
        rotated = in.quad_vertex;
    }

    let offset = u.camera_right * rotated.x * size
               + u.camera_up * rotated.y * size;

    let pos = center + offset;
    out.clip_position = u.projection * u.view * vec4f(pos, 1.0);

    // Remap depth: WebGL [-1,1] → WebGPU [0,1]
    out.clip_position.z = out.clip_position.z * 0.5 + out.clip_position.w * 0.5;

    out.value = in.value;
    out.quad_uv = in.quad_vertex * 0.5 + 0.5;
    if (grounded) { out.grounded = 1.0; } else { out.grounded = 0.0; }
    out.altitude = alt;

    return out;
}

// ─── Fragment Shader ───

const DEFAULT_POINT_COLOR: vec3f = vec3f(0.0, 0.75, 0.9);

fn circle_chevron_sdf(uv: vec2f) -> f32 {
    let p = (uv - 0.5) * 2.0;
    let px = abs(p.x);
    let circle = length(p) - 0.85;
    // V-chevron cutout — clearly visible arrow notch
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

    // Hard-discard inside chevron V-cutout to prevent glow from flooding the arrow notch.
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

    // Color
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

    // Antialiasing
    let aa = fwidth(dist) * 1.5;
    let shape_mask = 1.0 - smoothstep(-aa, aa, dist);

    // Subtle outer glow (airborne)
    var glow: f32 = 0.0;
    if (in.grounded < 0.5 && dist > 0.0) {
        glow = 1.0 - smoothstep(0.0, glow_radius, dist);
        glow = glow * glow * 0.2;
    }

    // Grounded pulse
    var pulse: f32 = 1.0;
    if (in.grounded > 0.5) {
        pulse = 0.6 + 0.4 * sin(u.time * 3.0 + in.value * 0.5);
    }

    let alpha = max(shape_mask * base_alpha * pulse, glow) * u.opacity;
    var final_color = color;
    if (glow > 0.0) {
        final_color = mix(color, mix(color, vec3f(1.0), 0.4), glow / max(alpha, 0.001));
    }

    return vec4f(final_color, alpha);
}
