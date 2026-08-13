// chart_quad.wgsl — Colored rectangle rendering for charts
//
// Vertex format: position(f32x2) + color(f32x4) = 24 bytes per vertex
// Renders bars, boxes, backgrounds as colored quads.

struct Uniforms {
    resolution: vec2f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexInput {
    @location(0) position: vec2f,
    @location(1) color: vec4f,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let clip = in.position / u.resolution * 2.0 - 1.0;
    out.position = vec4f(clip, 0.0, 1.0);
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    return in.color;
}
