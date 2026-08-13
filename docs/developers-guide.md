# Globe Trotter — Developer's Guide

A comprehensive guide to building applications with the `@globe-trotter/core` library.

> [!TIP]
> **Vibe code this project!** Globe Trotter is designed for AI-accelerated development with [Google Antigravity](https://developers.google.com/antigravity). The repo includes 10 workspace agent skills that let you build applications, generate data pipelines, and deploy — all through natural-language prompts. See the **[Antigravity Vibe Coding Guide](developers-guide-antigravity-vibe.md)** to get started.

## Table of Contents

- [Example Projects](#example-projects)
- [Installation](#installation)
- [Data Formats](#data-formats)
- [Generating Data](#generating-data)
- [YAML Configuration](#yaml-configuration)
- [Branded Loading Screen](#branded-loading-screen)
- [Engine API](#engine-api)

---

## Example Projects

The repo ships three runnable example apps that demonstrate Globe Trotter with different frameworks. Each example auto-generates sample data on first run.

| Example     | Stack                                                   | README                                                      |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| **Vanilla** | Plain HTML + `<script type="module">` — zero build step | [examples/vanilla/README.md](../examples/vanilla/README.md) |
| **Vue 3**   | Vue 3 + Vite                                            | [examples/vue/README.md](../examples/vue/README.md)         |
| **React**   | React 18 + Vite                                         | [examples/react/README.md](../examples/react/README.md)     |

```bash
# Run any example:
cd examples/vue   # or react, or vanilla
npm install
npm run dev
```

> **Tip:** All examples resolve `@globe-trotter/core` via a Vite alias to the pre-built `dist/` bundle — no global install or symlink required.

---

## Installation

### npm

```bash
npm install @globe-trotter/core
```

### Direct import (Vite / ESM)

```js
import { GlobeTrotterEngine, StyleEngine } from '@globe-trotter/core';
```

### Pre-Built Distributables

Versioned library builds are committed to the `dist/` folder for easy consumption without a build step. Each release branch produces a self-contained folder:

```
dist/globe-trotter-release-0.1.1/
├── globe-trotter.es.js       # ES module (import/export)
├── globe-trotter.es.js.map   # Source map for debugging
├── globe-trotter.umd.js      # UMD bundle (script tags, AMD, CommonJS)
└── globe-trotter.umd.js.map  # Source map for debugging
```

> [!NOTE]
> The `dist/` folder is gitignored. Run `npm run build:lib` to generate distributables locally.

| File                   | Format    | Use Case                                                             |
| ---------------------- | --------- | -------------------------------------------------------------------- |
| `globe-trotter.es.js`  | ES module | Modern bundlers (Vite, Webpack, Rollup) and `<script type="module">` |
| `globe-trotter.umd.js` | UMD       | Plain `<script>` tags, legacy builds, Node.js `require()`            |

**UMD (script tag):**

```html
<script src="dist/globe-trotter-release-0.1.1/globe-trotter.umd.js"></script>
<script>
  const { GlobeTrotterEngine } = window.GlobeTrotter;
</script>
```

**ES module (script tag):**

```html
<script type="module">
  import { GlobeTrotterEngine } from './dist/globe-trotter-release-0.1.1/globe-trotter.es.js';
</script>
```

#### Building a New Distribution

To build the library from the current branch:

```bash
npm run build:lib
```

This reads the current git branch name and outputs to `dist/globe-trotter-{branch}/`. You can also override the version tag:

```bash
node scripts/build-lib.js v0.2.0    # → dist/globe-trotter-v0.2.0/
```

### Prerequisites

> **Updated 2026-06:** WebGPU-only. WebGL2 backend removed.

- **WebGPU** — **required** (Chrome 113+, Edge 113+, Firefox Nightly with flag). Globe Trotter uses WebGPU for all rendering (globe, tiles, H3, GFB, charts)
- **Mapbox token** — required for basemap tiles ([get one here](https://account.mapbox.com/access-tokens/))

**WebGPU Support Check:**

```js
import { GlobeTrotterEngine, WebGPURequiredError } from '@globe-trotter/core';

try {
  const engine = new GlobeTrotterEngine(canvas, options);
} catch (err) {
  if (err instanceof WebGPURequiredError) {
    showError('WebGPU required. Please upgrade to Chrome 113+ or Edge 113+.');
  }
}
```

The engine emits an `'unsupported'` event and exposes `engine.capabilities.webgpu` (readable synchronously after construction).

---

## Data Formats

Globe Trotter uses three custom binary formats optimized for GPU rendering:

### H3Flex (`.h3f`) — Hexagonal Heatmaps

Best for aggregated grid data (network supply, demand density, coverage).

| Feature   | Detail                                      |
| --------- | ------------------------------------------- |
| Geometry  | H3 hexagonal cells (resolution 0–15)        |
| Temporal  | Per-epoch attribute values                  |
| Rendering | Extruded 3D hex pillars or flat heat        |
| Sharding  | Manifest with base + per-metric shard files |
| Encoding  | Sparse or RLE (auto-detected)               |

```
┌──────────────┐
│ Header 32B   │ — magic "H3F1", cell count, epoch count, flags
├──────────────┤
│ Schema       │ — column names, types, temporal flags
├──────────────┤
│ Cell IDs     │ — BigUint64 H3 indexes
├──────────────┤
│ GPU Mesh     │ — pre-computed hex geometry (optional, recommended)
├──────────────┤
│ Attributes   │ — static + temporal Float32 columns
└──────────────┘
```

### GeoFlex (`.gfb`) — Points, Lines, Polygons

Best for moving features (aircraft, ships) and static geometry (routes, boundaries).

| Feature   | Detail                                                         |
| --------- | -------------------------------------------------------------- |
| Geometry  | Points, Lines, Polygons (+ multi variants)                     |
| Temporal  | Per-epoch positions with altitude                              |
| Rendering | Instanced billboards (points), thick lines, triangulated polys |
| Sharding  | Same manifest pattern as H3F                                   |

```
Geometry types: Point (1), MultiPoint (2), Line (3), MultiLine (4), Polygon (5), MultiPolygon (6)
Coordinates: [longitude, latitude, altitude_feet]
```

### MetricFlex (`.mfb`) — Entity Metrics

Best for geometry-free entity data (per-airline revenue, per-sensor metrics for charts and tables).

| Feature   | Detail                         |
| --------- | ------------------------------ |
| Geometry  | None — entity ID only          |
| Temporal  | Per-epoch attribute values     |
| Rendering | Charts, tables, dashboards     |
| Encoding  | Single-file or manifest+shards |

### Choosing a Format

| Data Type                    | Format                | Example                              |
| ---------------------------- | --------------------- | ------------------------------------ |
| Hexagonal heatmap            | H3F                   | Network supply, demand density       |
| Moving points                | GFB (point, temporal) | Aircraft, ships, vehicles            |
| Static polylines             | GFB (line)            | Routes, boundaries                   |
| Polygons/regions             | GFB (polygon)         | Coverage areas                       |
| Entity metrics (no geometry) | MFB                   | Per-airline revenue, sensor readings |

---

## Generating Data

### Python — H3 Aggregation → H3F

```python
import h3, struct, numpy as np

# 1. Aggregate raw data to H3 cells
df['h3_cell'] = df.apply(
    lambda r: h3.latlng_to_cell(r.lat, r.lon, 4), axis=1
)
agg = df.groupby(['h3_cell', 'epoch']).agg({'metric': 'sum'})

# 2. Build H3F binary
cell_ids = np.array([int(c, 16) for c in cells], dtype=np.uint64)
temporal_data = np.zeros((epoch_count, cell_count), dtype=np.float32)

with open('output.h3f', 'wb') as f:
    f.write(b'H3F1')                                       # magic
    f.write(struct.pack('<HI', 1, cell_count))             # version, cellCount
    f.write(struct.pack('<HH', 1, 0x01))                   # colCount, flags (hasTemporal)
    f.write(struct.pack('<HI', epoch_count, 300))           # epochCount, interval (5 min)
    f.write(struct.pack('<II', 0, 0))                       # meshVertexCount, meshIndexCount
    # Schema
    name = b'demand_mbps'
    f.write(struct.pack('<B', len(name)) + name)
    f.write(struct.pack('<BB', 1, 1))                       # type=Float32, temporal=1
    # Cell IDs
    f.write(cell_ids.tobytes())
    # Temporal column
    f.write(temporal_data.tobytes())
```

### Python — GFB Trajectory

```python
import struct, numpy as np

positions = np.zeros((epoch_count, feature_count, 3), dtype=np.float32)  # [lon, lat, alt_ft]
for _, row in df.iterrows():
    positions[epoch_idx, feat_idx] = [row.lon, row.lat, row.alt_ft]

with open('flights.gfb', 'wb') as f:
    f.write(b'GFB1')                                       # magic
    f.write(struct.pack('<HH', 1, 0x04 | 0x20 | 0x40))    # version, flags
    f.write(struct.pack('<I', feature_count))               # featureCount
    f.write(struct.pack('<B', 1))                           # geomType = Point
    # ... bbox, epochCount, epochInterval, columns
    f.write(positions.tobytes())
```

### Node.js — Data Generation Scripts

The repo includes ready-to-use data generators in `scripts/`:

```bash
# Generate H3 heatmap data
node scripts/mobile-demand-sim/generate-h3-data.js

# Generate GFB flight trajectories
node scripts/mobile-demand-sim/generate-gfb-data.js

# Generate MFB revenue metrics
node scripts/mobile-demand-sim/generate-mfb-data.js
```

All generators write directly to `public/data/mobile-demand-sim/`.

**Testing:**

```bash
# Run tests (Node.js built-in test runner)
cd lib/packages/core
npm test

# Run benchmarks (headless WebGPU via Playwright)
npm run bench  # from repo root
```

### Sharding Large Datasets

For datasets with > 48 epochs, split into shards:

```
8 hours at 5-min epochs = 96 epochs → 2 shards of 48
24 hours at 5-min epochs = 288 epochs → 5 shards of ~60
```

**Manifest format:**

```json
{
  "format": "h3flex-sharded",
  "version": 3,
  "cellCount": 31258,
  "epochCount": 288,
  "epochInterval": 300,
  "base": "data_base.h3f.gz",
  "activeMetric": "served_mbps",
  "temporalAttributes": [
    {
      "name": "served_mbps",
      "encoding": "sparse",
      "shards": [{ "epochs": [0, 59], "file": "served_mbps_e0000-e0059.bin.gz", "epochCount": 60 }]
    },
    {
      "name": "desired_demand_mbps",
      "encoding": "rle",
      "shards": [{ "epochs": [0, 59], "file": "demand_e0000-e0059.rle.bin.gz", "epochCount": 60 }]
    }
  ]
}
```

Place generated files in `public/data/` and reference from your config.

---

## YAML Configuration

The `globe-config.yaml` file drives the entire application. All properties are optional with sensible defaults.

### Full Schema

```yaml
# ── Basemap ──
basemap:
  provider: mapbox
  style:
    satellite # satellite | satellite-streets | streets | outdoors
    # light | dark | navigation-day | navigation-night
  token: env:VITE_MAPBOX_TOKEN # or literal token string

# ── Camera ──
camera:
  center: [39.0, -98.0] # [lat, lon] — initial view center
  altitude: 12000 # km above surface
  tilt: 0 # degrees (0 = looking straight down, 85 = oblique)
  heading: 0 # degrees clockwise from north

# ── Time Playback ──
time:
  enabled: true # enable temporal animation
  autoplay: true # start playing on load
  speed: 60 # playback multiplier (1 = real-time)
  startOffset: '14:00:00' # HH:MM:SS — initial time position
  loop: true # loop at end of time range

# ── Data Layers ──
layers:
  - name: My Layer # display name
    type: h3f-sharded # h3f | h3f-sharded | gfb | gfb-sharded | mfb
    url: /data/file.manifest.json
    visible: true # show on load (default: true)
    extrusionEnabled: true # enable 3D hex pillars (H3F only)
    extrusionScale: 0.012 # pillar height (0 = flat, 0.012 = 1×)
    activeMetric: served_mbps # default metric for multi-metric layers
    style:
      # ... see Style Types below
    filter: 'served_mbps > 50' # GPU filter (optional, query syntax)
    metrics: # per-metric styles (v3, optional)
      served_mbps:
        style:
          type: ramp
          attribute: served_mbps
          domain: [0, 80]
          stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319']

# ── UI Widgets ──
ui:
  footer: true # status bar (FPS, coordinates, zoom, backend indicator)
  layers: true # layer manager dialog
  geocoder: true # location search
  time: true # time slider and controls
  charts: true # chart manager sidebar button
  legend: true # draggable legend panel

# ── Charts (GPU-rendered overlays) ──
charts:
  - name: Demand Histogram
    type: histogram # heatmap | histogram | cdf | boxplot | barplot | time-series
    source: My Layer # must match a layer name
    attribute: demand_mbps # temporal column to chart
    position: top-right # top-right | top-left | bottom-right | bottom-left
    size: [420, 180] # [width, height] CSS pixels
    style:
      title: 'Demand Distribution'
      domain: [0, 60] # histogram uses domain[0] as min floor; max auto-scales from data
      binCount: 20
      yScale: log # log (power-of-10 ticks) | linear (evenly spaced ticks)
      labelColor: '#ffffff' # bar label text color (hex or [r,g,b,a])
      background: 'rgba(4, 6, 12, 0.88)'
```

### Style Types

**Color Ramp** (numeric attribute → continuous color gradient):

```yaml
style:
  type: ramp
  attribute: demand_mbps # column name in the data
  domain: [0, 100] # [min, max] data range
  stops: # color gradient stops (any CSS color)
    - '#0D1A80'
    - '#0D73BF'
    - '#1ABF59'
    - '#D9D91A'
    - '#F23319'
  opacityStops: # optional opacity gradient
    - { value: 0, opacity: 0.0 }
    - { value: 100, opacity: 0.9 }
```

**Categorical** (enum attribute → discrete color mapping):

```yaml
style:
  type: categorical
  attribute: region # dictionary-encoded column
  categories: # explicit name → color mappings
    North: '#E31937'
    South: '#0032A0'
  default: '#999999' # fallback for unmapped values
  opacity: 0.9
```

**Constant** (single color for all features):

```yaml
style:
  type: constant
  color: '#00BFE6'
  opacity: 0.9
```

### Style Resolution Cascade

Styles are resolved in priority order. The engine always produces a compiled style — no layer is ever rendered without one.

| Priority | Source                | Description                                              |
| -------- | --------------------- | -------------------------------------------------------- |
| **1**    | YAML `style:` block   | Explicit style in `globe-config.yaml` (highest priority) |
| **2**    | Sidecar `.style.json` | Convention file next to the data URL                     |
| **3**    | Embedded in data      | Style encoded in the H3F/GFB binary (HAS_STYLE flag)     |
| **4**    | Geometry-type default | Single constant color per geometry type                  |

**Geometry-type defaults** (used when no style is configured anywhere):

| Geometry | Color                  | Opacity | Notes                        |
| -------- | ---------------------- | ------- | ---------------------------- |
| Point    | `#00BFE6` (cyan)       | 0.9     | GFB point/multipoint         |
| Line     | `#4A90D9` (steel blue) | 0.8     | GFB line/multiline, width: 2 |
| Polygon  | `#2E8B57` (sea green)  | 0.6     | GFB polygon/multipolygon     |
| H3F      | Blue→red ramp          | 0.7     | 5-stop color ramp            |

### Symbology Dialogs

All data layers include an interactive **Symbology** button in the Layer Manager. Clicking it opens a draggable overlay tailored to the layer type:

**GFB Point Layers** (SymbologyDialog):

- Symbol type: Chevron, Arrow, Diamond, or Circle
- Symbol scale: 0.3× to 4×
- Color mode: Default (YAML config) or Custom (per-category color pickers)
- Attribute selector: Auto-discovers enum columns from the dataset
- Opacity slider: 0–1
- Reset button

**GFB Line Layers** (LineSymbologyDialog):

- Color mode toggle: Ramp / Discrete
- Line width slider: 1–20px
- Attribute selector, color pickers, opacity slider

**GFB Polygon Layers** (PolygonSymbologyDialog):

- Color mode toggle: Ramp / Discrete
- 3D extrusion toggle + scale slider
- Attribute selector, color pickers, opacity slider

**H3F Layers** (H3SymbologyDialog):

- Color ramp gradient track (click to add stops, right-click to remove)
- Draggable color stop handles with inline color pickers
- **Editable stop table**: per-stop value input, color picker, opacity input, remove button
- Domain min/max inputs (auto-rescales all stops)
- 3D extrusion controls (toggle + scale slider)
- Add Stop / Reset buttons

All dialogs are **draggable by header**, lazy-loaded via dynamic `import()`, and apply changes instantly to the GPU.

### GPU Filtering

The Layer Manager UI includes a **filter input** with context-aware autocomplete. Type a column name and the dialog suggests operators and enum values.

**Query syntax:**

| Example                                      | Description                       |
| -------------------------------------------- | --------------------------------- |
| `served_mbps > 50`                           | Comparison operator               |
| `served_mbps 100..500`                       | Range (BETWEEN)                   |
| `custom_region = CONUS`                      | Enum equality (dictionary lookup) |
| `served_mbps > 50 AND custom_region = CONUS` | AND combinator                    |
| `served_mbps > 200 OR served_mbps < 10`      | OR combinator                     |

**YAML config:**

```yaml
layers:
  - name: Coverage
    type: h3f-sharded
    url: /data/coverage.manifest.json
    filter: 'served_mbps > 50' # applied on load
```

**Programmatic:**

```js
engine.layerManager.setFilter('Coverage', 'served_mbps > 50');
engine.layerManager.clearFilter('Coverage');
```

Non-matching features are discarded entirely in the fragment shader — zero CPU per-feature iteration.

---

## Branded Loading Screen

The core library includes a built-in loading screen widget that shows progress during data loading. It supports custom branding via `uiWidgets.loadingScreen`:

```js
const engine = new GlobeTrotterEngine(canvas, {
  mapboxToken: 'pk.xxx',
  ui: true,
  uiWidgets: {
    footer: true,
    layers: true,
    geocoder: true,
    time: true,
    loadingScreen: {
      logoUrl: '/assets/your-wordmark.svg', // brand wordmark / text logo
      iconUrl: '/assets/your-icon.svg', // brand icon (shown beside logo)
      subtitle: 'Network Intelligence', // subtitle text
    },
  },
});
```

| Option            | Type     | Description                                      |
| ----------------- | -------- | ------------------------------------------------ |
| `logoUrl`         | `string` | URL to brand wordmark / logo image               |
| `iconUrl`         | `string` | URL to brand icon (animated with heartbeat glow) |
| `title`           | `string` | Title text below logo                            |
| `subtitle`        | `string` | Subtitle text                                    |
| `backgroundColor` | `string` | Override background CSS                          |

The loading screen automatically receives progress updates during `loadConfig()` and auto-hides when loading completes. You can also skin it with CSS custom properties:

| CSS Property               | Default            | Description                              |
| -------------------------- | ------------------ | ---------------------------------------- |
| `--gt-loading-bg`          | radial gradient    | Background                               |
| `--gt-loading-accent`      | `--gt-accent-cyan` | Spinner and progress bar color           |
| `--gt-loading-logo-height` | `36px`             | Logo height (width scales automatically) |

---

## Engine API

After initializing the engine (see [Example Projects](#example-projects)), you can manage layers and control the globe programmatically:

```js
// Add a layer
await engine.addShardedLayer('Flights', '/data/flights.manifest.json');

// Change style
engine.setLayerStyle('Demand', {
  type: 'ramp',
  attribute: 'demand_mbps',
  domain: [0, 200],
  stops: ['#1A0D80', '#6A0DAD', '#E040FB', '#FF6090', '#FF0000'],
});

// Toggle visibility
engine.toggleLayerVisibility('Demand');

// Switch basemap
engine.setBasemap('dark');

// Fly to location
engine.flyTo(51.5, -0.1, 1.2); // London, close zoom

// Add a chart
engine.addChart('Demand Histogram', {
  type: 'histogram',
  source: 'Demand',
  attribute: 'demand_mbps',
  position: 'top-right',
  size: [420, 180],
  style: { domain: [0, 60], binCount: 20, yScale: 'log' },
});

// Remove a chart
engine.removeChart('Demand Histogram');

// Listen for events
engine.on('frame', ({ fps, drawCalls }) => {
  console.log(`FPS: ${fps}, Draw calls: ${drawCalls}`);
});
```

---

## Embedding: animation window & UI chrome

When embedding the globe as a panel (e.g. a dashboard), the host usually wants to
(1) animate a specific time range and (2) show only the chrome that fits the panel.

**Looping animation window** — supply a start/end epoch (absolute UNIX seconds) and
the globe loops between them, with the time bar representing exactly that window:

```js
// Imperative
engine.setTimeWindow(1774832400, 1774836000); // 1-hour window; loops
engine.getTimeWindow(); // { startEpochSec, endEpochSec }
engine.clearTimeWindow(); // back to the full dataset

// Declarative (at construction) — accepts epoch seconds or ISO strings
const engine = new GlobeTrotterEngine(canvas, {
  time: { window: { start: '2026-03-30T01:00:00Z', end: '2026-03-30T02:00:00Z' } },
});
```

Replay only; it's a no-op in live mode. Rendering is unaffected (epoch selection still
spans the full dataset) — the window only re-scales the scrubber.

**Choosing UI widgets** — gate any widget at construction, or toggle at runtime:

```js
const engine = new GlobeTrotterEngine(canvas, {
  ui: true, // master switch
  uiWidgets: {
    // omitted keys default to visible
    time: true,
    layers: true,
    projection: false,
    compass: false,
    basemap: false,
    footer: false,
  },
});

engine.setWidgetVisible('layers', false); // hide at runtime
engine.getWidgetVisibility(); // { time: true, layers: false, ... }
```

Canonical widget names: `footer`, `layers`, `geocoder`, `time`, `legend`, `charts`,
`chartToggle`, `projection`, `compass`, `basemap`, `dropZone`. For a panel embed, also
pass `uiContainer: canvas.parentElement` so chrome scopes to the panel instead of
`document.body`. See [`core-lib-api.md`](./core-lib-api.md) for the full reference.
