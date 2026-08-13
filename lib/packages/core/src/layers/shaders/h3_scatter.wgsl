// h3_scatter.wgsl — Compute shader for H3 epoch data scatter.
//
// Reads from a storage buffer containing the full temporal column
// (all epochs × cellCount values) and writes one epoch's data
// into an R32F texture for the vertex shader to sample.
//
// Dispatch: ceil(cellCount / 64) workgroups × 1 × 1

struct ScatterUniforms {
    cell_count: u32,
    epoch_offset: u32,   // = localEpoch * cellCount
    tex_size: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> u: ScatterUniforms;
@group(0) @binding(1) var<storage, read> src_data: array<f32>;
@group(0) @binding(2) var output_tex: texture_storage_2d<r32float, write>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;
    if (idx >= u.cell_count) { return; }

    let value = src_data[u.epoch_offset + idx];

    let tx = idx % u.tex_size;
    let ty = idx / u.tex_size;
    textureStore(output_tex, vec2u(tx, ty), vec4f(value, 0.0, 0.0, 0.0));
}
