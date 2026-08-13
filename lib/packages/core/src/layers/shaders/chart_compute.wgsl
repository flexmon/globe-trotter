// chart_compute.wgsl — Unified GPU chart data computation
//
// All chart types read from a shared epoch storage buffer (26K float values).
// Each entry point computes a different aggregation:
//   histogramMain  — bin counts via atomicAdd
//   minMaxMain     — parallel min/max reduction
//   statsMain      — sorted-order statistics (count, sum, min, max, p5, q1, median, q3, p95)
//
// The epoch buffer is uploaded ONCE per epoch change, shared by all chart shaders.

// ─── Shared bindings ───
struct ChartParams {
    cellCount:    u32,    // number of active cells
    binCount:     u32,    // histogram bins (or category count for barplot)
    _pad0:        u32,
    _pad1:        u32,
    domainMin:    f32,    // auto-computed or YAML domain
    domainMax:    f32,
    _pad2:        f32,
    _pad3:        f32,
};

@group(0) @binding(0) var<uniform> params: ChartParams;
@group(0) @binding(1) var<storage, read> values: array<f32>;             // epoch data (cellCount floats)
@group(0) @binding(2) var<storage, read_write> output: array<atomic<u32>>;  // histogram bins or reduction output

// ═══════════════════════════════════════════════════
// HISTOGRAM — atomicAdd binning
// ═══════════════════════════════════════════════════
@compute @workgroup_size(256)
fn histogramMain(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;
    if (idx >= params.cellCount) { return; }

    let val = values[idx];
    // Skip zero and NaN
    if (val == 0.0 || val != val) { return; }

    let dMin = params.domainMin;
    let dMax = params.domainMax;
    if (dMax <= dMin) { return; }
    if (val < dMin || val > dMax) { return; }

    let binWidth = (dMax - dMin) / f32(params.binCount);
    var bin = u32(floor((val - dMin) / binWidth));
    bin = min(bin, params.binCount - 1u);

    atomicAdd(&output[bin], 1u);
}

// ═══════════════════════════════════════════════════
// MIN/MAX REDUCTION — parallel reduction for auto domain
// Output[0] = min (as bitcast u32), Output[1] = max (as bitcast u32),
// Output[2] = non-zero count
// ═══════════════════════════════════════════════════
// We use atomicMin/Max on u32 bit patterns.  For positive floats, IEEE 754
// bit order == numeric order, so atomicMin on bitcast<u32>(val) gives min.

@compute @workgroup_size(256)
fn minMaxMain(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;
    if (idx >= params.cellCount) { return; }

    let val = values[idx];
    if (val == 0.0 || val != val) { return; }
    // We only handle positive values (demand, revenue etc are always > 0)
    if (val < 0.0) { return; }

    let bits = bitcast<u32>(val);
    atomicMin(&output[0], bits);
    atomicMax(&output[1], bits);
    atomicAdd(&output[2], 1u);
}
