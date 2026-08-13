# GPU-First Charting Architecture

> **Updated 2026-06: charts use WebGPU (WebGL2 removed).**

GPU-accelerated, time-mensurated 2D charts rendered on a **separate transparent WebGPU overlay canvas** (sharing the engine's `GPUDevice`), driven by the same `TimeController` and reading from the same temporal data buffers.

## Motivation

Traditional charting libraries (Plotly, D3, Chart.js) render via SVG or Canvas 2D and operate in a completely separate pipeline from the globe. This creates three problems:

1. **Performance** — CPU-bound rendering limits them to ~10K data points before jank
2. **Synchronization** — No shared clock; chart animations must be manually synced to the globe
3. **Data duplication** — Chart data is a separate copy from the layer data, doubling memory

Globe Trotter's GPU charts solve all three by treating a chart as a **different projection of the same GPU data**, using the same `TimeController` that drives the globe.

---

## Architecture Overview

Charts render on a **separate transparent WebGPU overlay canvas** (`_chartOverlayCanvas`). The engine creates a second `<canvas>` element; `ChartGPU` calls `getContext('webgpu')` on it, sharing the engine's `GPUDevice`. The browser composites this overlay canvas over the main globe canvas. This keeps chart rendering fully decoupled from the 3D scene pipeline.

```
┌──────────────────────── Main WebGPU Canvas ─────────────────────┐
│                                                                 │
│  Compute Pass (before render)                                   │
│  │  H3 Epoch Scatter + Histogram Reduce (async fire-and-forget) │
│                                                                 │
│  Render Pass: Globe → Tiles (instanced) → H3 → GFB              │
│  (perspective projection, depth-tested, 3D, WGSL shaders)       │
└─────────────────────────────────────────────────────────────────┘
                              ↓ browser canvas compositing
┌──────── Transparent WebGPU Overlay Canvas (shared GPUDevice) ───┐
│                                                                 │
│  ChartManager.render() (orthographic, depth OFF, blend ON)      │
│  ├── chart_bg.vert/frag    → glassmorphism panel                │
│  ├── chart_grid.vert/frag  → axes, gridlines                    │
│  ├── chart_bar.vert/frag   → bar/histogram/CDF/box/heatmap      │
│  ├── chart_line.vert/frag  → time-series lines                  │
│  ├── chart_now.vert/frag   → “now” indicator line               │
│  └── chart_label.vert/frag → GPU glyph atlas text (DPR-aware)   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌───────────────────── DOM Overlay ───────────────────────────────┐
│  ChartOverlay (title bar, axis labels, ticks, drag, minimize)   │
│  UIManager (footer with backend indicator, layer manager, etc.) │
└─────────────────────────────────────────────────────────────────┘
                              ↑
                    TimeController.getNormalized()
                    (shared clock drives everything)
```

## Component Tree

```
GlobeTrotterEngine
├── ... (existing components)
├── ChartManager                         ← WebGPU second pass
│   ├── ChartPanel[]                     ← layout, position, size per chart
│   │   ├── HeatmapRenderer              ← 2D time×value grid, ramp-colored
│   │   ├── HistogramRenderer            ← live distribution bars, log/linear Y
│   │   ├── CDFRenderer                  ← cumulative distribution curve + stats
│   │   ├── BoxPlotRenderer              ← whisker/box/median per time bin
│   │   ├── BarPlotRenderer              ← categorical bars (e.g. by airline)
│   │   └── TimeSeriesRenderer           ← aggregated line chart
│   ├── ChartDataAdapter                 ← bridges layer data → chart series
│   │   └── GPU histogram fast path      ← WebGPU compute (async fire-and-forget)
│   ├── ChartLabelRenderer               ← GPU glyph atlas text (DPR-aware)
│   ├── NowIndicator                     ← vertical "current time" line
│   ├── AxisRenderer                     ← gridlines, tick marks
│   └── ChartOverlay (DOM)               ← title bar, axis labels, ticks, drag, minimize, zoom
├── ChartManagerDialog (UI)              ← add/remove/configure charts at runtime
└── UIManager
    └── LegendPanel                      ← draggable, scrollable, adaptive width
```

## Integration Points

### 1. Render Loop (`GlobeTrotterEngine._startChartLoop`)

Charts render on their own independent rAF loop, writing to the **transparent WebGPU overlay canvas** (own `webgpu` context, shared `GPUDevice`). This is fully decoupled from the main globe render loop:

```javascript
// Main globe loop submits the 3D scene to the main canvas
device.queue.submit([commandEncoder.finish()]);

// Independent chart loop renders to the overlay canvas (own command encoder)
if (this.chartManager) {
  this.chartManager.render(effectiveTime, overlayWidth, overlayHeight);
}

// DOM UI update
this.ui.update(frameData, normalizedTime);
```

### 2. TimeController Integration

Charts subscribe to the same time system. The `normalizedTime` (0..1) maps to the chart's x-axis:

```
normalizedTime = 0.0  →  00:00 UTC  →  left edge of chart
normalizedTime = 0.5  →  12:00 UTC  →  center of chart
normalizedTime = 1.0  →  24:00 UTC  →  right edge of chart
```

The "now" indicator is a vertical line at `x = normalizedTime * chartWidth`.

### 3. Data Flow (ChartDataAdapter)

Charts don't load data independently. They read from existing layer data:

```
H3FlexRenderer.data                                     ChartDataAdapter
├── temporalColumns['demand_mbps'] (Float32Array)   ─→  getHistogram()   ─→ GPU Buffer
├── staticColumns['airline'] (Uint16Array)          ─→  getBarPlotData() ─→ GPU Buffer
└── cellCount, epochCount, dictionary               ─→  getCDFValues()   ─→ GPU Buffer
```

**GPU histogram fast path**: When the source renderer supports `computeHistogram()` (WebGPU), `getHistogram()` dispatches an async GPU compute shader (`histogram_reduce.wgsl`) that bins 1.4M cells via `atomicAdd`. Results are cached and returned on the next call. Falls back to CPU when filters are active.

**Domain caching**: CPU min/max scan cached for adjacent epochs (±1), avoiding a 1.4M cell scan on sequential playback.

---

## Shader Architecture

All chart shaders live in `lib/packages/core/src/charts/shaders/`:

### Orthographic Projection

Charts use pixel-space coordinates. The vertex shader transforms from data space → pixel space → clip space:

```glsl
// chart_common.glsl (included by all chart shaders)
uniform vec2 u_resolution;      // canvas size in pixels
uniform vec4 u_chartRect;       // x, y, width, height in pixels
uniform vec2 u_dataRange;       // min, max of data values
uniform vec2 u_timeRange;       // 0.0..1.0 (full 24h) or sub-range

vec2 dataToPixel(float time, float value) {
    float px = u_chartRect.x + (time - u_timeRange.x) / (u_timeRange.y - u_timeRange.x) * u_chartRect.z;
    float py = u_chartRect.y + (value - u_dataRange.x) / (u_dataRange.y - u_dataRange.x) * u_chartRect.w;
    return vec2(px, py);
}

vec4 pixelToClip(vec2 pixel) {
    return vec4(
        pixel.x / u_resolution.x * 2.0 - 1.0,
        pixel.y / u_resolution.y * 2.0 - 1.0,
        0.0, 1.0
    );
}
```

### Shader Files

| Shader            | Purpose                                                 |
| ----------------- | ------------------------------------------------------- |
| `chart_line.vert` | Positions thick line segments from temporal data buffer |
| `chart_line.frag` | Anti-aliased line with configurable color and width     |
| `chart_bar.vert`  | Positions instanced quads (one per bar)                 |
| `chart_bar.frag`  | Solid or gradient fill with rounded corners             |
| `chart_grid.vert` | Axis lines, tick marks, gridlines                       |
| `chart_grid.frag` | Dashed/solid lines with configurable opacity            |
| `chart_now.vert`  | Vertical "now" indicator line                           |
| `chart_now.frag`  | Glowing cyan line (matches Globe Trotter accent)        |
| `chart_bg.frag`   | Semi-transparent panel background (glassmorphism)       |

### GPU Rendering Primitives

| Primitive       | Technique                                                 | Chart Element                       |
| --------------- | --------------------------------------------------------- | ----------------------------------- |
| Thick lines     | Quad expansion in vertex shader (2 triangles per segment) | Time series, axes, gridlines        |
| Instanced quads | 4 vertices × N instances                                  | Bar chart columns, area fill strips |
| Point sprites   | `gl_PointSize` + SDF circle in fragment                   | Scatter plot markers                |
| "Now" line      | Single full-height quad                                   | Current time indicator              |

---

## YAML Configuration

Charts are declared in `globe-config.yaml` alongside layers:

```yaml
charts:
  - name: Demand Over Time
    type: time-series
    source: Demand Metrics # references a layer by name
    attribute: demand_mbps
    aggregation: sum # sum | mean | max | count
    position: bottom-right # screen anchor
    size: [400, 200] # pixels
    style:
      lineColor: '#00E5FF'
      lineWidth: 2
      fillColor: 'rgba(0, 229, 255, 0.1)'
      nowIndicator: true
      background: 'rgba(4, 6, 12, 0.85)'

  - name: Regional Breakdown
    type: stacked-area
    source: Demand Metrics
    attribute: demand_mbps
    groupBy: region_name
    position: bottom-left
    size: [500, 250]
    style:
      # colors auto-derived from layer's categorical palette
      nowIndicator: true

  - name: Top Airlines
    type: bar
    source: Aircraft Tracks
    attribute: airline
    aggregation: count
    position: top-right
    size: [300, 200]
    style:
      # colors from layer's categorical palette
      sortBy: descending
      maxBars: 10
```

---

## ChartManager API

```javascript
class ChartManager {
    constructor(gl, engine) { ... }

    // Add a chart from YAML config or programmatically
    addChart(name, config) → ChartPanel

    // Remove a chart
    removeChart(name)

    // Render all charts (called from _renderLoop)
    render(normalizedTime, canvasWidth, canvasHeight)

    // Dispose all GPU resources
    dispose()
}
```

### Public Engine API Extensions

```javascript
// New methods on GlobeTrotterEngine:
engine.addChart(name, config); // Add a chart panel
engine.removeChart(name); // Remove a chart panel
engine.setChartVisibility(name, vis); // Show/hide
```

---

## Interaction Model

```
Mouse position (screen space)
       ↓
  ChartManager.hitTest(x, y)
       ↓
  Is mouse over a chart panel?
       ├── Yes → which chart? which data point?
       │        → Show DOM tooltip (ChartTooltip)
       │        → Highlight corresponding globe feature (future)
       └── No  → pass event to CameraController (existing behavior)
```

**Phase 1**: Hover shows a DOM-based tooltip with the value at the cursor position.
**Future**: Click on a chart data point → `flyTo()` the corresponding region on the globe.

---

## Implementation Phases

| Phase       | Scope                                                                                      | Files             |
| ----------- | ------------------------------------------------------------------------------------------ | ----------------- |
| **Phase 1** | `ChartManager`, `TimeSeriesRenderer`, axes, "now" indicator, YAML config, panel background | 8-10 new files    |
| **Phase 2** | `BarChartRenderer`, `StackedAreaRenderer`, DOM tooltips, interaction                       | 4-6 new files     |
| **Phase 3** | SDF text rendering, sparklines in layer panel, GPU-side aggregation                        | 3-4 new files     |
| **Phase 4** | Draggable/resizable panels, chart↔globe linking, animation transitions                     | Edits to existing |

---

## Key Design Decisions

1. **Separate Transparent WebGPU Overlay Canvas** — Charts render to their own `<canvas>` with its own `webgpu` context, sharing the engine's `GPUDevice`. The browser composites it over the main globe canvas. WebGPU is required; there is no WebGL2 fallback.
2. **Orthographic projection** — charts are screen-space 2D, not projected onto the globe
3. **GPU histogram compute** — `histogram_reduce.wgsl` bins 1.4M cells via `atomicAdd` on WebGPU, async fire-and-forget
4. **DOM overlays for text layout** — axis labels and title bars use HTML overlays. GPU glyph atlas handles in-bar numeric labels (DPR-aware)
5. **No depth testing** — charts render on top of everything, blended with alpha
6. **Data adapter pattern** — charts never load data directly. They adapt existing layer data via `ChartDataAdapter`
7. **Pre-allocated scratch buffers** — label arrays, histogram counts, CDF scratch — all reused per frame for zero GC pressure

---

## File Structure

```
lib/packages/core/src/
├── charts/                          ← WebGPU chart system
│   ├── ChartManager.js              ← orchestrates all chart panels
│   ├── ChartPanel.js                ← layout, position, background
│   ├── ChartDataAdapter.js          ← bridges layer data → chart series (GPU histogram fast path)
│   ├── ChartOverlay.js              ← DOM overlay: title, labels, ticks, drag, minimize, zoom
│   ├── ChartLabelRenderer.js        ← GPU glyph atlas text labels (DPR-aware, rotated)
│   ├── HeatmapRenderer.js           ← 2D time×value heatmap
│   ├── HistogramRenderer.js         ← live distribution bars (log/linear Y)
│   ├── CDFRenderer.js               ← cumulative distribution + stats
│   ├── BoxPlotRenderer.js           ← whisker/box/median per time bin
│   ├── BarPlotRenderer.js           ← categorical bar chart
│   ├── TimeSeriesRenderer.js        ← aggregated line chart
│   ├── AxisRenderer.js              ← GPU gridlines + axis borders
│   ├── NowIndicator.js              ← animated time cursor
│   └── shaders/
│       ├── chart_bar.vert/frag       ← shared bar/cell shader (5 chart types)
│       ├── chart_label.vert/frag     ← glyph atlas text shader
│       ├── chart_line.vert/frag      ← anti-aliased thick line
│       ├── chart_grid.vert/frag      ← gridline shader
│       ├── chart_now.vert/frag       ← glow effect now indicator
│       └── chart_bg.vert/frag        ← glassmorphism background
├── layers/shaders/
│   └── histogram_reduce.wgsl        ← WebGPU compute shader (async histogram)
└── ui/
    └── ChartManagerDialog.js        ← runtime chart CRUD dialog (zoom scale)
```

## Dependencies

Zero new npm dependencies. Chart rendering uses native WebGPU on a separate transparent overlay canvas (shared `GPUDevice`). GPU histogram compute uses the existing WebGPU device via `H3FlexRenderer.computeHistogram()`.
