---
name: globe-trotter-yaml-config
description: Complete reference for globe-config.yaml — all layer types, style specs, camera, time, extrusion, basemap, charts, interaction/hover-click popups, and UI widget configuration.
---

# Globe Trotter YAML Configuration

All application settings are defined in a YAML config (the default is `public/catalog/globe-config.yaml`) and loaded via `GlobeTrotterEngine.loadConfig()`.

> [!IMPORTANT]
> **URL Parameter Protocol:**
> When sharing or rendering a URL to the Globe Trotter application, **ALWAYS** use the query parameter `?globeconf=` to specify a custom YAML catalog config.
> **NEVER** use `?config=` or `?globeconfig=`.
> Example: `http://localhost:5173/?globeconf=/catalog/my-dataset.yaml`

## When to use this skill

- Use this when configuring layers, styles, camera, or time settings in YAML
- Use this when adding new data layers to the globe
- Use this when troubleshooting why a layer isn't rendering correctly
- Use this when setting up extrusion, basemap styles, or UI widgets
- Use this when adding or configuring GPU chart overlays
- Use this when enabling hover/click detail popups on a layer (`interaction` block)

## How to use it

### Full Schema

```yaml
basemap:
  provider: mapbox # mapbox | google
  style: satellite # See provider-specific style keys below
  # Mapbox: defaults to env:VITE_MAPBOX_TOKEN from .env
  # token: env:VITE_MAPBOX_TOKEN
  # Google: defaults to env:VITE_GOOGLE_MAPS_API_KEY from .env
  # googleApiKey: env:VITE_GOOGLE_MAPS_API_KEY
  #
  # Optional: which geocoding API powers the "Find Location" widget.
  # Omit to use the default: Mapbox when a Mapbox token is set, Google otherwise.
  # geocoderProvider: google   # mapbox | google

# Mapbox styles:    satellite | satellite-streets | streets | outdoors |
#                   light | dark | navigation-day | navigation-night
# Google styles:    google-roadmap | google-satellite | google-terrain |
#                   google-roadmap-dark | google-satellite-dark | google-terrain-dark
#
# Provider notes:
#  - When provider is 'google', a session token is created lazily on first
#    tile request via https://tile.googleapis.com/v1/createSession and is
#    cached in localStorage for ~2 weeks. The 'google-terrain' style auto-
#    includes the layerRoadmap overlay (required by Google's API).
#  - The geocoder widget (Find Location) supports two providers:
#      Mapbox: uses Mapbox Geocoding v5 (requires VITE_MAPBOX_TOKEN)
#      Google: uses Google Places Autocomplete (New) + Place Details (New)
#              (requires VITE_GOOGLE_MAPS_API_KEY with Places API (New) enabled)
#    When both keys are set and geocoderProvider is not specified, Mapbox is
#    used (backward-compatible default). The widget is hidden only when no
#    geocoder credentials are configured at all.
#  - Google geocoder benefits: biases suggestions toward the current viewport;
#    works when only a Google API key is configured (no Mapbox token needed).
#  - Google API key setup: enable both "Map Tiles API" AND "Places API (New)"
#    in Cloud Console for the same key. Autocomplete + Place Details calls are
#    bundled into a single billing session per user selection.

camera:
  center: [39.0, -98.0] # [lat, lon]
  altitude: 12000 # km above surface
  tilt: 0 # degrees (0=nadir, 85=oblique)
  heading: 0 # degrees clockwise from north

time:
  enabled: true
  autoplay: true
  speed: 60 # playback multiplier
  startOffset: '00:00:00'
  loop: true

layers:
  - name: Layer Name
    type: h3f-sharded # h3f | h3f-sharded | gfb | gfb-sharded | mfb
    url: /data/file.manifest.json
    visible: true
    extrusionScale: 0.012 # 0=flat, 0.012=default (1×); setting this implies extrusion enabled
    style:
      # see Style Types below
    interaction: # optional hover/click detail popups — see Interaction Popups below
      hover: true
      popup:
        fields: [target_id, altitude]

  # MFB layers (non-rendering, chart data only)
  - name: Airline Revenue
    type: mfb
    url: ./airline_revenue.manifest.json
    visible: true # controls chart data availability

charts:
  - name: Chart Name
    type: histogram # heatmap | histogram | cdf | boxplot | barplot | time-series
    source: Layer Name # must match a layer name from layers:
    attribute: demand_mbps # temporal column to chart
    position: top-right # top-right | top-left | bottom-right | bottom-left
    size: [420, 180] # [width, height] in CSS pixels
    style:
      # see Chart Types below

ui:
  footer: true # FPS / draw-call / lat-lon readout bar
  layers: true # layer manager panel
  geocoder: true # "Find Location" search widget
  time: true # time scrubber and playback controls
  charts: true # charts data panel
  chartToggle: true # show/hide charts button in sidebar
  legend: true # colour-ramp / categorical legend panel
  projection: true # globe ↔ flat-map toggle button
  compass: true # north-up compass rose
  basemap: true # basemap style selector
  dropZone:
    true # drag-and-drop YAML/data file target
    # all keys default to true when omitted
```

### Style Types

**Color Ramp** (continuous numeric → color):

```yaml
style:
  type: ramp
  attribute: supply_mbps
  domain: [0, 60]
  stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319']
  opacityStops:
    - { value: 0, opacity: 0.0 }
    - { value: 60, opacity: 0.9 }
```

**Categorical** (dictionary enum → color):

```yaml
style:
  type: categorical
  attribute: airline
  categories:
    Delta: '#001E70'
    United: '#003D87'
    American: '#B31B2C'
  default: '#999999'
  opacity: 0.9
```

### Style Resolution Cascade

1. YAML `style:` block (highest priority)
2. Sidecar `.style.json` file next to the data
3. Embedded style in H3F/GFB header
4. Generic fallback (auto-detect, default colors)

### Extrusion

- Setting `extrusionScale: 0.012` enables extrusion at default height
- `extrusionScale: 0` → flat rendering
- Only H3F and GFB polygon layers support extrusion

### Multi-Metric Layers (v3)

H3F sharded layers can contain multiple temporal metrics. Use `metrics:` to define per-metric styles and `activeMetric:` to set the default:

```yaml
layers:
  - name: LEO Supply
    type: h3f-sharded
    url: /data/leo/manifest.json
    activeMetric: served_mbps # default metric shown on load
    metrics:
      served_mbps:
        style:
          type: ramp
          attribute: served_mbps
          domain: [0, 80]
          stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319']
      desired_demand_mbps:
        style:
          type: ramp
          attribute: desired_demand_mbps
          domain: [0, 1200]
          stops: ['#1A0D80', '#6A0DAD', '#E040FB', '#FF6090', '#FF0000']
```

- Each metric can have independent domain, color stops, and opacity
- Switching metrics loads the new metric's shard files on demand (only one metric's data in memory)
- **v3 Shards**: For sharded layers, temporal data is now stored in `.shd3` files. These use the self-describing column-major `SHD3` format, enabling FlexDB to fetch only the requested metrics/columns via HTTP Range Requests, significantly reducing data egress.
- If no `metrics:` block, the layer-level `style:` is used for all metrics.

### Interaction Popups

Add an `interaction` block to a layer to enable hover and/or click detail popups.
Popup content is configurable per layer with field/label pairs and deterministic
value formatting. Picking is **opt-in** — a layer with no `interaction` block (or
with both modes false) is not pickable.

```yaml
layers:
  - name: Serving Satellites
    type: gfb-sharded
    url: /data/sats/manifest.json
    interaction:
      hover: true # popup follows the cursor
      click: true # popup pins on click; fires a 'selection' event; Esc clears
      popup:
        title: 'Satellite' # popup heading; falls back to the layer name if omitted
        fields:
          - target_id # shorthand: name only (label = name)
          - name: altitude
            label: Altitude
            format: integer
            unit: ft
          - name: highest_served_mbps
            label: Served Mbps
            format: number
            decimals: 2
          - name: status
            label: Status
            valueMap: { 0: Inactive, 1: Active, 2: Standby }
            fallback: Unknown
          - name: operator # dictionary/enum column → auto-decoded to its label
            label: Operator
```

**Supported layer types**

| Type                                                                  | Pickable             | Adapter                                                                        |
| --------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `gfb` / `gfb-sharded` / `gfb-streaming` **points** (geometryType 1/2) | ✅                   | CPU screen-space (projects each point; matches the render under tilt/altitude) |
| `h3f` / `h3f-sharded` **cells**                                       | ✅                   | CPU (screen lat/lon → H3 cell at layer resolution → row)                       |
| GeoJSON point/line/polygon                                            | ✅ (via JS API only) | CPU spatial index — see note below                                             |
| GFB lines/polygons, DGF, MFB                                          | ❌                   | not yet supported                                                              |

> GeoJSON layers are added through the JS API, not YAML: `engine.addGeoJSONLayer(name, geojson, { interaction: {...} })`. The `interaction` block shape is identical.

**Field object**

| Key        | Required | Description                                                                                                                                            |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`     | ✅       | Column name. Resolves against static columns, temporal columns (at the current epoch), and the entity-id column (e.g. `modem_mac`, `target_id`).       |
| `label`    | No       | Display label (defaults to `name`).                                                                                                                    |
| `format`   | No       | See formats below. If omitted, values are auto-formatted (numbers localized, objects as JSON).                                                         |
| `decimals` | No       | Fraction digits for `number` / `percent`.                                                                                                              |
| `unit`     | No       | Suffix appended to the formatted value, with a space (e.g. `ft`, `Mbps`).                                                                              |
| `prefix`   | No       | Prepended to the formatted value, no space (e.g. `$`).                                                                                                 |
| `scale`    | No       | Multiplier applied to the raw numeric value before `number`/`integer`/`percent`/`bytes` formatting. E.g. `scale: 0.000001` shows a bps column in Mbps. |
| `valueMap` | No       | Inline `{ rawValue: label }` map. Takes precedence over dictionary decoding.                                                                           |
| `fallback` | No       | Shown when the value is missing/NaN, or absent from `valueMap`. Without it, the row is omitted.                                                        |

A field may also be written as a bare string (`- target_id`), equivalent to `{ name: target_id }`.

**Formats**

| Format       | Behavior                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `string`     | As-is                                                                                                                |
| `number`     | Localized, optional `decimals` (honors `scale`)                                                                      |
| `integer`    | Rounded, localized (honors `scale`)                                                                                  |
| `percent`    | ×100 with `%` (default 1 decimal)                                                                                    |
| `bytes`      | Human-readable (KB/MB/GB, base 1024)                                                                                 |
| `datetime`   | Epoch-ms → ISO string                                                                                                |
| `boolean`    | `true` / `false`                                                                                                     |
| `json`       | Compact JSON                                                                                                         |
| `list`       | Array-ish string (`"[5025, 5023]"`) → clean `5025, 5023`; also applies to a decoded dictionary value                 |
| `objectList` | JSON array of objects → one line per object. Use `keys` to select/order/format properties (best with `layout: grid`) |

**`objectList`** turns a JSON-array-of-objects column into a readable per-object list. `keys` selects which properties to show (string, or a field-like object with its own `format`/`scale`/`decimals`/`unit`/`prefix`); omit `keys` to show all. Empty arrays omit the row; invalid JSON shows the raw string.

```yaml
- name: cmn_rl_rcg_channels
  label: RCG Channels
  format: objectList
  keys:
    - ChipRate
    - { key: FreqOffset_Hz, label: Freq, scale: 0.000001, decimals: 1, unit: MHz }
# renders:  1. ChipRate 2x · Freq 20.0 MHz
#           2. ChipRate 4x · Freq -15.0 MHz
```

**Grouping & layout**

Instead of a flat `fields` list, use `groups` to render labeled sections (each with a divider), and set `layout: grid` for an aligned two-column label/value layout. Empty groups (all values missing) are dropped automatically.

```yaml
popup:
  title: 'Mobile Terminal'
  layout: grid # grid (aligned two columns) | list (default)
  groups:
    - label: Identity
      fields: [modem_mac, ndr_bsid, { name: ndr_beam_id, label: Beam, format: integer }]
    - label: Forward Link
      fields:
        - { name: srm_fl_reb_ids, label: REBs, format: list }
        - {
            name: srm_fl_total_expected_speed_mbps,
            label: Capacity,
            format: number,
            decimals: 1,
            unit: Mbps,
          }
    - label: FL Supply
      fields:
        - {
            name: spdb_fl_usable_bps,
            label: Usable,
            format: number,
            decimals: 1,
            scale: 0.000001,
            unit: Mbps,
          }
```

`groups` and `fields` are mutually exclusive — provide one. In `grid` layout, long values wrap; in `list` layout they ellipsize.

**Behavior notes**

- **Temporal values snap to the nearest epoch** — data values are never interpolated between epochs (geometry position is, to match the render, but factual values are not, so the popup never shows a number that existed at no epoch).
- **Dictionary/enum columns are auto-decoded** to their string label; `valueMap` overrides this per field.
- **No configured `fields`** → the popup shows all non-null properties (GeoJSON) or all columns (Flex), up to 20 rows.
- **Layer Manager** shows per-layer _Hover info_ / _Click info_ toggles for any pickable layer.
- **Events:** a click pick emits a `selection` event (`{ layer, feature, featureIndex }`); clicking empty space emits a cleared selection.

**Limitations**

- Sharded/streaming layers pick against the currently-resident epoch window; H3F fields for a non-active metric may be blank until that metric loads.
- H3F picking uses the cell's ground footprint (surface-accurate); a GPU-readback path for pixel-exact extruded-pillar picking under extreme tilt is deferred.

### Chart Types

Charts are GPU-rendered overlays drawn on a separate transparent WebGPU overlay canvas. Each chart reads temporal data from a `source` layer. Multiple charts auto-stack vertically when sharing the same `position`.

**Common fields** (all chart types):

| Field              | Required | Default             | Description                                                                  |
| ------------------ | -------- | ------------------- | ---------------------------------------------------------------------------- |
| `name`             | ✅       | —                   | Unique chart identifier                                                      |
| `type`             | ✅       | —                   | `heatmap` \| `histogram` \| `cdf` \| `boxplot` \| `barplot` \| `time-series` |
| `source`           | ✅       | —                   | Layer name to read data from                                                 |
| `attribute`        | No       | Auto-detect         | Temporal column name                                                         |
| `position`         | No       | `top-right`         | Screen anchor                                                                |
| `size`             | No       | `[400, 200]`        | `[width, height]` CSS pixels                                                 |
| `visible`          | No       | `true`              | Initial visibility                                                           |
| `style.title`      | No       | Auto                | Chart title text                                                             |
| `style.xLabel`     | No       | Auto                | X-axis label                                                                 |
| `style.yLabel`     | No       | Auto                | Y-axis label                                                                 |
| `style.background` | No       | `rgba(4,6,12,0.88)` | Panel background color                                                       |

**Heatmap** — 2D grid (time × value bins), ramp-colored by count:

```yaml
- name: Demand Heatmap
  type: heatmap
  source: Demand Metrics
  attribute: demand_mbps
  style:
    domain: [0, 60] # value range (Y axis)
    timeBins: 48 # X resolution (time)
    valueBins: 12 # Y resolution (value)
```

**Histogram** — live distribution bars at current epoch:

```yaml
- name: Demand Distribution
  type: histogram
  source: Demand Metrics
  attribute: demand_mbps
  style:
    domain: [0, 60]
    binCount: 20
    yScale: log # log | linear
```

**CDF** — cumulative distribution curve with μ/σ/median stats:

```yaml
- name: Demand CDF
  type: cdf
  source: Demand Metrics
  attribute: demand_mbps
  style:
    domain: [0, 60] # auto-scales if omitted
```

**Box Plot** — whisker/box/median statistics per time bin:

```yaml
- name: Demand Box Plot
  type: boxplot
  source: Demand Metrics
  attribute: demand_mbps
  style:
    domain: [0, 25]
    timeBins: 24 # 24 = hourly bins
    yScale: linear
```

**Bar Plot** — categorical aggregation (requires static ENUM16 column):

```yaml
- name: Demand by Airline
  type: barplot
  source: Aircraft Tracks # layer with ENUM16 static column
  attribute: demand_mbps # temporal value to aggregate
  groupBy: airline # static ENUM16 column for categories
  aggregation: sum # sum | avg | count
  topN: 10 # limit to top N categories (0 = all)
  filterMode: aggregate # aggregate (filter after agg) | entity (filter before)
  timeWindow: 1 # epoch-minutes to aggregate over
  style:
    labelFormat: currency # currency ($1.2K) | plain (1,234) | percent (45.2%)
    labelSize: 10 # GPU label font size in CSS pixels
    labelColor: '#ffffff' # hex color for bar value labels (default white)
    showBarLabels: true # enable/disable GPU bar value labels
```

**Time Series** — aggregated line chart across epochs:

```yaml
- name: Total Demand
  type: time-series
  source: Demand Metrics
  attribute: demand_mbps
  style:
    lineColor: '#00E5FF'
    lineWidth: 2
```

> For detailed chart system internals (data adapter, shader architecture, programmatic API), see the `globe-trotter-charting` skill.

### Current Config Example

The default `public/catalog/globe-config.yaml` ships with:

- **H3 Data** — H3F sharded (color ramp, extrusion, opacity stops)
- **Feature Tracks** — GFB sharded (categorical, 30+ airline colors)
- **Metrics** — MFB sharded (metric data for bar charts)
- **4 charts** — box plot, CDF, histogram, bar plot (all `top-right` stacked)

**Quick test** — load a single manifest without YAML config:

```
http://localhost:5173/?manifest=/data/leo/manifest.json
```

### Key Implementation Files

- Config loader: `lib/packages/core/src/GlobeTrotterEngine.js` → `loadConfig()`
- Style engine: `lib/packages/core/src/styles/StyleEngine.js`
- Chart manager: `lib/packages/core/src/charts/ChartManager.js` → `loadFromConfig()`
