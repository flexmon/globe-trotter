---
name: globe-trotter-charting
description: GPU-accelerated chart system for Globe Trotter — chart types (heatmap, histogram, CDF, boxplot, barplot, time-series), YAML config, data adapter, shader architecture, overlay system, and ChartManagerDialog.
---

# Globe Trotter Chart System

**Updated 2026-06**: The engine is WebGPU-only. Charts render on a separate transparent **WebGPU** overlay canvas (its own `getContext('webgpu')` sharing the engine's GPUDevice) — there is no WebGL2 anywhere.

GPU-rendered charts drawn on a **separate transparent WebGPU overlay canvas** (`_chartOverlayCanvas`, with its own `getContext('webgpu')` sharing the engine's GPUDevice), composited by the browser over the main globe canvas. Charts use orthographic projection (no depth test) and share the same time controller as the globe for synchronized temporal visualization. Charts are always available (no degraded mode).

## When to use this skill

- Use this when adding, modifying, or debugging chart types
- Use this when configuring charts in `globe-config.yaml`
- Use this when working with the `ChartDataAdapter` data pipeline
- Use this when building new chart renderers
- Use this when debugging chart positioning, stacking, or DOM overlays
- Use this when understanding how layer data flows to chart visualizations

## How to use it

### Architecture Overview

Charts render on a **separate transparent WebGPU overlay canvas** layered over the main globe canvas, with its own `getContext('webgpu')` sharing the engine's GPUDevice. `ChartGPU` manages 3 WGSL render pipelines (quad, line, text) and runs its own command encoder, decoupled from the globe's render loop. Browser canvas compositing provides zero-cost transparency. Charts are always available (no degraded mode).

```
GlobeTrotterEngine._renderLoop()
  ↓
  1. WebGPU pass (globe canvas): Globe → Tiles → H3 → GFB (device.queue.submit)
  2. WebGPU overlay (chart canvas): ChartManager.render() (orthographic, depth OFF, blend ON)
     ↓
     For each chart:
       ChartPanel.renderBackground()     → glassmorphism panel
       AxisRenderer.render()             → gridlines
       DataRenderer.render()             → bars / lines / cells / boxes
       ChartLabelRenderer.render()       → GPU-rendered bar/bin labels (DPR-aware)
       NowIndicator.render()             → cyan time cursor
       ChartOverlay.updatePosition()     → DOM labels, ticks, title bar
```

### Component Tree

```
ChartManager
├── ChartGPU                            ← WebGPU overlay canvas context + quad/line/text pipelines + glyph atlas
├── ChartDataAdapter                    ← bridges layer temporal data → chart series
├── ChartPanel                          ← layout (position, size, padding, DPR); quad pipeline for background
├── AxisRenderer                        ← GPU gridlines + axis borders (line pipeline)
├── ChartLabelRenderer                  ← GPU-rendered bar/bin text labels (text pipeline + glyph atlas)
├── NowIndicator                        ← animated time cursor (quad/line pipeline)
├── ChartOverlay (DOM)                  ← title bar, axis labels, ticks, drag, minimize
└── Data Renderers (one per chart):
    ├── HeatmapRenderer                 ← 2D time×value grid, ramp-colored
    ├── HistogramRenderer               ← live distribution bars, log/linear Y
    ├── CDFRenderer                     ← cumulative distribution curve + stats
    ├── BoxPlotRenderer                 ← whisker/box/median per time bin
    ├── BarPlotRenderer                 ← categorical bars (e.g. by airline)
    └── TimeSeriesRenderer              ← aggregated line chart

ChartManagerDialog (UI)                 ← add/remove/configure charts at runtime
```

### Chart Types

| Type          | Renderer             | Data Source        | Live?            | Pipeline    | Description                                           |
| ------------- | -------------------- | ------------------ | ---------------- | ----------- | ----------------------------------------------------- |
| `heatmap`     | `HeatmapRenderer`    | `getHeatmapGrid()` | No (cached)      | quad        | 2D grid: time × value bins, ramp-colored by count     |
| `histogram`   | `HistogramRenderer`  | `getHistogram()`   | Yes (per epoch)  | quad        | Distribution of values at current time, log/linear Y  |
| `cdf`         | `CDFRenderer`        | `getCDFValues()`   | Yes (per epoch)  | quad / line | Cumulative distribution curve with μ, σ, median stats |
| `boxplot`     | `BoxPlotRenderer`    | `getBoxPlotData()` | Yes (stats text) | quad / line | Whisker/box/median per time bin, ramp-colored         |
| `barplot`     | `BarPlotRenderer`    | `getBarPlotData()` | Yes (per epoch)  | quad        | Categorical bars (e.g. sum demand by airline)         |
| `time-series` | `TimeSeriesRenderer` | `getTimeSeries()`  | No (full shard)  | line        | Aggregated value per epoch as a line chart            |

**Live charts** update geometry every simulated minute (epoch change). Non-live charts compute once on shard load.

### YAML Configuration

Charts are defined in `globe-config.yaml` under the `charts:` key:

```yaml
charts:
  # ── Heatmap: full 24h × demand distribution ──
  - name: Demand Heatmap
    type: heatmap
    source: Demand Metrics # must match a layer name
    attribute: demand_mbps # temporal column name
    position: top-right # anchor: top-right | top-left | bottom-right | bottom-left
    size: [420, 180] # [width, height] in CSS pixels
    style:
      title: '24h Demand Heatmap'
      xLabel: 'Time of Day (UTC)'
      yLabel: 'Demand (Mbps)'
      domain: [0, 60] # value range for Y axis
      timeBins: 48 # X-axis resolution
      valueBins: 12 # Y-axis resolution (heatmap only)
      background: 'rgba(4, 6, 12, 0.88)'

  # ── Histogram: live distribution at current time ──
  - name: Demand Histogram
    type: histogram
    source: Demand Metrics
    attribute: demand_mbps
    position: top-right
    size: [420, 180]
    style:
      title: 'Demand Distribution'
      domain: [0, 60]
      binCount: 20
      yScale: log # log | linear
      background: 'rgba(4, 6, 12, 0.88)'

  # ── CDF: cumulative distribution at current time ──
  - name: Demand CDF
    type: cdf
    source: Demand Metrics
    attribute: demand_mbps
    position: top-right
    size: [420, 180]
    style:
      title: 'Demand CDF'
      domain: [0, 60] # auto-scales if omitted
      background: 'rgba(4, 6, 12, 0.88)'

  # ── Box Plot: statistics per time bin ──
  - name: Demand Box Plot
    type: boxplot
    source: Demand Metrics
    attribute: demand_mbps
    position: top-right
    size: [420, 180]
    style:
      title: 'Box Plot'
      domain: [0, 25]
      timeBins: 24 # 24 = hourly bins
      yScale: linear
      background: 'rgba(4, 6, 12, 0.88)'

  # ── Bar Plot: categorical aggregation ──
  - name: Demand by Airline
    type: barplot
    source: Aircraft Tracks # GFB layer with static ENUM16 column
    attribute: demand_mbps # temporal value to aggregate
    groupBy: airline # static ENUM16 column for categories
    aggregation: sum # sum | avg | count
    topN: 10 # show only top N categories
    position: top-right
    size: [420, 180]
    style:
      title: 'Demand by Airline'
      background: 'rgba(4, 6, 12, 0.88)'
```

**Config fields reference:**

| Field                 | Required     | Default                                    | Description                                                                |
| --------------------- | ------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| `name`                | ✅           | —                                          | Unique chart identifier                                                    |
| `type`                | ✅           | —                                          | One of: `heatmap`, `histogram`, `cdf`, `boxplot`, `barplot`, `time-series` |
| `source`              | ✅           | —                                          | Layer name from `layers:` section                                          |
| `attribute`           | No           | Auto-detect                                | Temporal column name to chart                                              |
| `position`            | No           | `top-right`                                | Screen anchor position                                                     |
| `size`                | No           | `[400, 200]`                               | `[width, height]` in CSS pixels                                            |
| `visible`             | No           | `true`                                     | Initial visibility                                                         |
| `groupBy`             | barplot only | —                                          | Static ENUM16 column for categories                                        |
| `aggregation`         | barplot only | `sum`                                      | Aggregation function: `sum`, `avg`, `count`                                |
| `topN`                | barplot only | `0` (all)                                  | Limit to top N categories                                                  |
| `filterMode`          | barplot only | `aggregate`                                | `aggregate` (filter after agg) or `entity` (filter before)                 |
| `timeWindow`          | barplot only | `1`                                        | Number of epoch-minutes to aggregate over                                  |
| `style.labelFormat`   | No           | `currency` (barplot), `number` (histogram) | Label format: `currency`, `number`, `percent`                              |
| `style.labelSize`     | No           | `10`                                       | GPU label font size in CSS pixels                                          |
| `style.showBarLabels` | No           | `true`                                     | Enable/disable GPU bar labels                                              |

### Data Flow: ChartDataAdapter

The adapter bridges temporal layer data to chart-consumable formats:

```
Layer renderer.data
├── temporalColumns['demand_mbps']    → Float32Array [epoch×cellCount contiguous]
├── staticColumns['airline']          → Uint8/16/32Array [cellCount, ENUM indices]
├── dictionary                        → string[] ['Delta', 'United', ...]
├── cellCount / featureCount          → number
├── epochCount                        → number
├── _shardEpochStart                  → number (shard offset)
└── _shardEpochCount                  → number (epochs in this shard)
```

**Adapter methods:**

| Method                                                  | Returns                                           | Used By            | Caching               |
| ------------------------------------------------------- | ------------------------------------------------- | ------------------ | --------------------- |
| `getTimeSeries(layer, attr, agg)`                       | `{ values: Float32Array, dataRange, epochCount }` | TimeSeriesRenderer | By shard key          |
| `getHistogram(layer, binCount, domain, time, attr)`     | `{ counts: Uint32Array, effectiveDomain }`        | HistogramRenderer  | None (live)           |
| `getHeatmapGrid(layer, timeBins, valueBins, domain)`    | `{ grid: number[][], ... }` (2D grid)             | HeatmapRenderer    | By shard key + filter |
| `getCDFValues(layer, domain, time, attr)`               | `Float32Array` (sorted)                           | CDFRenderer        | By epoch + filter     |
| `getBoxPlotData(layer, timeBins, attr)`                 | `{ stats: Object[], dataRange }`                  | BoxPlotRenderer    | Computed once         |
| `getBarPlotData(layer, groupBy, attr, agg, time, topN)` | `{ categories, values, dataRange }`               | BarPlotRenderer    | By simulated minute   |

**Performance patterns:**

- **GPU histogram fast path**: when the source renderer supports `computeHistogram()` and no filter is active, `getHistogram()` dispatches GPU compute async and returns cached results from the previous frame — falls back to CPU if GPU is busy
- **Domain caching**: histogram CPU min/max scan cached for adjacent epochs (±1) — avoids 1.4M cell scan on sequential playback
- Pre-allocated scratch buffers (`_histCounts`, `_cdfScratch`, `_barSums`) — zero GC pressure
- CDF sort uses `Float32Array.sort()` (native, no comparator)
- BarPlot interpolates between adjacent epochs for smooth animation
- Filter predicates parsed once from query string, reused across cells
- Label scratch array (`_labelScratch`) reused per frame — zero allocation
- Histogram returns `Uint32Array.subarray()` instead of `Array.from()` — zero copy
- `plotArea` cached once per chart per frame (not re-computed 3×)

### Shader Architecture

`ChartGPU` manages **3 WGSL render pipelines** on the overlay canvas, all sharing a `resolution` uniform buffer (`vec2f`) for 2D pixel-space orthographic projection:

```wgsl
// Common vertex transform pattern (all chart pipelines):
let clip = in.position / u.resolution * 2.0 - 1.0;
out.position = vec4f(clip, 0.0, 1.0);
```

| WGSL Pipeline                    | Used For                                    | Vertex Format                                         | Uniforms                                                |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `chart_quad.wgsl` (quadPipeline) | bars, boxes, backgrounds, heatmap cells     | `position(f32x2)`, `color(f32x4)` = 24 B              | `resolution`                                            |
| `chart_line.wgsl` (linePipeline) | grid, axes, whiskers, CDF/time-series lines | `position(f32x2)`, `edgeDist(f32)` = 12 B             | `resolution`, `LineUniforms { color, lineWidth }`       |
| `chart_text.wgsl` (textPipeline) | glyph atlas text labels                     | `position(f32x2)`, `uv(f32x2)`, `color(f32x4)` = 32 B | `resolution`; `@group(1)` glyph atlas texture + sampler |

**Key conventions:**

- The `quadPipeline` is the workhorse — used for all bar/box/cell geometry. It passes through per-vertex RGBA colors with no transformation; all color computation happens on the CPU when building vertex buffers.
- The `linePipeline` expands lines to quads on the CPU and uses `edgeDist` + `smoothstep` for anti-aliasing.
- The `textPipeline` samples the glyph atlas alpha channel and hard-discards near-transparent texels.

> NOTE: The legacy GLSL `.vert`/`.frag` files under `charts/shaders/` are no longer the active path — chart rendering is fully WGSL via `ChartGPU.js`.

### ChartPanel Layout

Panels are positioned using CSS-pixel anchors, then scaled by `devicePixelRatio`:

```
Position anchors:
  top-right     →  (canvasWidth - w - margin, canvasHeight - h - marginTop)
  top-left      →  (margin, canvasHeight - h - marginTop)
  bottom-right  →  (canvasWidth - w - margin, marginBottom)
  bottom-left   →  (margin, marginBottom)

Stacking: charts with the same position auto-stack vertically
  with _cssStackGap (10px) between them.

Padding (CSS pixels): top=30, right=20, bottom=35, left=55
  → plotArea = panel rect minus padding (where data is drawn)

Drag: user can drag title bar → sets _dragOffset, overrides anchor
```

### Color Ramp Integration

Charts that support color ramps (`histogram`, `heatmap`, `cdf`, `boxplot`) automatically inherit the source layer's color stops:

```
Layer YAML style.stops → LayerManager.getLayerInfo() → ChartManager._applyLayerRamps()
  → renderer.setColorRamp(hexStops)
```

The `BarPlotRenderer` uses a built-in categorical palette (10 colors) instead of the layer ramp.

### ChartOverlay (DOM Layer)

Each chart has a DOM overlay for text that can't be drawn efficiently on the GPU:

| Element      | Purpose                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Title bar    | Chart name + zoom select + minimize button + drag handle                                                                              |
| Y-axis label | Rotated 90° text (e.g., "Demand (Mbps)")                                                                                              |
| X-axis label | Centered at bottom (e.g., "Time of Day")                                                                                              |
| Y ticks      | Value tick labels — power-of-10 for log scale (0, 1, 10, 100, 1K…), evenly spaced for linear. Uses `_formatCount()` with K/M suffixes |
| X ticks      | Time labels (HH:MM), category labels, or histogram bin edges (auto-rounded: integers for range≥1, 1 decimal otherwise)                |
| Stats text   | μ, σ, median for CDF; p5/mean/med/p95 for boxplot                                                                                     |

### GPU Bar Labels (ChartLabelRenderer)

Histogram and barplot charts render value labels inside bars using GPU textured quads:

- **Glyph atlas**: single-row bitmap font texture generated from Canvas2D (characters: `0123456789$,.%KMBhrs/ -`)
- **DPR-aware sizing**: label scale multiplied by `devicePixelRatio` — labels render correctly on both high-DPI laptops and standard monitors
- **Rotation**: labels are laid out horizontally then rotated 90° CCW around the bar center, reading bottom-to-top
- **Descender correction**: atlas cell height includes descender space; visible glyph center is offset for correct horizontal centering after rotation
- **Pre-allocated VBO**: vertex buffer reused across frames via `bufferSubData`
- **Format modes**: `currency` (`$1.2K`, `$3.4M`), `number` (`1,234`), `percent` (`45.2%`)
- **Skip logic**: labels are hidden if bar height is less than half the rotated text height
- **Label color**: configurable via `style.labelColor` — accepts hex string (`"#FF0000"`, `"#F00"`) or `[r,g,b,a]` array, defaults to white (`[1,1,1,0.9]`). Set in YAML or via the Chart Manager dialog color picker

### Histogram Auto-Domain

The `ChartDataAdapter.getHistogram()` method auto-computes the bin domain from actual data at the current epoch:

1. Scans all non-zero cells to find `dataMin` and `dataMax`
2. If YAML provides a `domain[0]`, uses `Math.max(domain[0], dataMin)` as a floor (clips float artifacts)
3. Max is always auto-computed — no data is ever clipped from the histogram
4. Returns `effectiveDomain` alongside counts so X-axis ticks auto-scale

This means the YAML `domain` for histograms acts as a **minimum floor**, not a hard clip. Set `domain: [0, 60]` to ensure the X-axis never goes negative.

### ChartManagerDialog (Runtime UI)

Interactive dialog for adding/removing/configuring charts at runtime:

- **Left panel**: scrollable list of chart name pills + "+" add button
- **Right panel**: property form for the selected chart
- **Auto-labels**: changing type or attribute auto-generates title, xLabel, yLabel
- **Label color picker**: hex color input for histogram/barplot bar label text color
- **Apply**: removes old chart + adds new one with updated config
- **Remove**: deletes the selected chart

### Programmatic API

```javascript
// Add a chart
engine.chartManager.addChart({
  name: 'My Histogram',
  type: 'histogram',
  source: 'Demand Metrics',
  attribute: 'demand_mbps',
  position: 'top-right',
  size: [420, 180],
  style: { domain: [0, 60], binCount: 20, yScale: 'log' },
});

// Remove a chart
engine.chartManager.removeChart('My Histogram');

// Toggle visibility
engine.chartManager.setVisibility('My Histogram', false);
engine.chartManager.toggleAllVisibility();

// Force data reload (e.g., after filter change)
engine.chartManager.invalidateData();

// Check visibility state
engine.chartManager.chartsVisible; // boolean
```

### Creating a New Chart Type

1. **Create renderer** in `lib/packages/core/src/charts/MyRenderer.js`:

   ```javascript
   export class MyRenderer {
     constructor(chartGPU, style = {}) {
       this.chartGPU = chartGPU; // shared ChartGPU (pipelines + device)
       this.vertexCount = 0;
     }
     setData(data, plotArea) {
       // Build triangle geometry in pixel space (position f32x2 + color f32x4)
       // Lazily create a GPU buffer and upload via:
       //   this._vbo = this.chartGPU.createBuffer('My bars', neededBytes);
       //   this.chartGPU.device.queue.writeBuffer(this._vbo, 0, verts, 0, vi);
     }
     draw(pass) {
       if (this.vertexCount === 0 || !this._vbo) return;
       pass.setPipeline(this.chartGPU.quadPipeline); // or linePipeline / textPipeline
       pass.setBindGroup(0, this.chartGPU._resolutionBG);
       pass.setVertexBuffer(0, this._vbo);
       pass.draw(this.vertexCount);
     }
     dispose() {
       this._vbo?.destroy();
     }
   }
   ```

2. **Register in ChartManager.\_createRenderer()**: add a `case` for your type
3. **Add adapter method** in `ChartDataAdapter` if needed
4. **Add to ChartManagerDialog**: add `<option>` in the type dropdown
5. **Update overlay labels** in `ChartManager._switchChartType()`

### File Inventory

| Path                             | Purpose                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `charts/ChartGPU.js`             | WebGPU chart infrastructure: overlay canvas context, quad/line/text pipelines, glyph atlas, shared resolution uniform |
| `charts/ChartManager.js`         | Orchestrator: add/remove, render loop, data loading                                                                   |
| `charts/ChartDataAdapter.js`     | Temporal data → chart series bridge                                                                                   |
| `charts/ChartPanel.js`           | Layout, anchor, DPR scaling, background render                                                                        |
| `charts/ChartOverlay.js`         | DOM overlay: title, labels, ticks, drag, minimize, zoom                                                               |
| `charts/ChartLabelRenderer.js`   | GPU glyph atlas text labels (rotated bar labels)                                                                      |
| `charts/AxisRenderer.js`         | GPU gridlines + axis borders                                                                                          |
| `charts/NowIndicator.js`         | Animated time cursor line                                                                                             |
| `charts/HeatmapRenderer.js`      | 2D time×value heatmap                                                                                                 |
| `charts/HistogramRenderer.js`    | Live distribution bars                                                                                                |
| `charts/CDFRenderer.js`          | Cumulative distribution + stats                                                                                       |
| `charts/BoxPlotRenderer.js`      | Whisker/box/median per time bin                                                                                       |
| `charts/BarPlotRenderer.js`      | Categorical bar chart                                                                                                 |
| `charts/TimeSeriesRenderer.js`   | Aggregated line chart                                                                                                 |
| `charts/shaders/chart_quad.wgsl` | Colored rectangles (bars, boxes, backgrounds, cells)                                                                  |
| `charts/shaders/chart_line.wgsl` | Anti-aliased lines (grid, axes, whiskers, CDF/series)                                                                 |
| `charts/shaders/chart_text.wgsl` | Glyph atlas text labels                                                                                               |
| `ui/ChartManagerDialog.js`       | Runtime chart CRUD dialog                                                                                             |

> NOTE: Legacy GLSL `chart_*.vert`/`.frag` files may still exist on disk but are no longer used — chart rendering is WGSL-only via `ChartGPU.js`.
