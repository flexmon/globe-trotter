// chart_text.wgsl — Glyph atlas text rendering for chart labels
//
// Vertex format: position(f32x2) + uv(f32x2) + color(f32x4) = 32 bytes per vertex
// Samples a glyph atlas texture and applies per-vertex color.

struct Uniforms {
    resolution: vec2f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var glyphAtlas: texture_2d<f32>;
@group(1) @binding(1) var glyphSampler: sampler;

struct VertexInput {
    @location(0) position: vec2f,
    @location(1) uv: vec2f,
    @location(2) color: vec4f,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) color: vec4f,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let clip = in.position / u.resolution * 2.0 - 1.0;
    out.position = vec4f(clip, 0.0, 1.0);
    out.uv = in.uv;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let alpha = textureSample(glyphAtlas, glyphSampler, in.uv).a;
    if (alpha < 0.05) {
        discard;
    }
    return vec4f(in.color.rgb, in.color.a * alpha);
}
