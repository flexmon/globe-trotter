// histogram_reduce.wgsl — GPU histogram binning
//
// Reads one epoch's worth of cell values from the H3 storage buffer
// and bins them into a histogram using atomicAdd.
//
// Output buffer layout (u32):
//   [0..binCount-1] = bin counts

struct Params {
    cellCount:    u32,
    epochOffset:  u32,
    binCount:     u32,
    _pad0:        u32,
    domainMin:    f32,
    domainMax:    f32,
    _pad1:        u32,
    _pad2:        u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> values: array<f32>;
@group(0) @binding(2) var<storage, read_write> bins: array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let cellIdx = gid.x;
    if (cellIdx >= params.cellCount) { return; }

    let val = values[params.epochOffset + cellIdx];

    // Skip zero and NaN values
    if (val == 0.0 || val != val) { return; }

    let domainMin = params.domainMin;
    let domainMax = params.domainMax;
    if (domainMax <= domainMin) { return; }
    if (val < domainMin || val > domainMax) { return; }

    let binWidth = (domainMax - domainMin) / f32(params.binCount);
    var bin = u32(floor((val - domainMin) / binWidth));
    bin = min(bin, params.binCount - 1u);

    atomicAdd(&bins[bin], 1u);
}
