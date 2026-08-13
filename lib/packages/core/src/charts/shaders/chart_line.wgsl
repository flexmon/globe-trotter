// chart_line.wgsl — Anti-aliased line rendering for charts
//
// Vertex format: position(f32x2) + edgeDist(f32) = 12 bytes per vertex
// Lines are expanded to quads on CPU with edgeDist for AA smoothstep.

struct Uniforms {
    resolution: vec2f,
};

struct LineUniforms {
    color: vec4f,
    lineWidth: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<uniform> line: LineUniforms;

struct VertexInput {
    @location(0) position: vec2f,
    @location(1) edgeDist: f32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) edgeDist: f32,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let clip = in.position / u.resolution * 2.0 - 1.0;
    out.position = vec4f(clip, 0.0, 1.0);
    out.edgeDist = in.edgeDist;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let halfWidth = line.lineWidth * 0.5;
    let dist = abs(in.edgeDist);
    let alpha = 1.0 - smoothstep(halfWidth - 1.0, halfWidth, dist);
    return vec4f(line.color.rgb, line.color.a * alpha);
}
