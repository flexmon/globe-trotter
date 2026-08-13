---
name: h3f-virtual-layers
description: H3F Virtual Layer system — query-driven live H3 hexagonal aggregation via FlexDB SQL queries, mesh tile architecture, VirtualH3Loader pipeline, YAML configuration reference, and deployment requirements for OpsAgent integration.
---

# H3F Virtual Layers

H3 Virtual Layers are a **query-driven** rendering mode that replaces the static shard-file data path with live SQL queries fired against FlexDB on each epoch tick. Unlike `h3f-sharded` layers (which fetch pre-computed binary shards from GCS), virtual layers construct their data dynamically by querying FlexDB and mapping results onto a pre-loaded hexagonal mesh.

## When to Use This Skill

- Creating or configuring an `h3f-virtual` layer in a `globe-config.yaml`
- Embedding a live spatial H3 aggregation panel in an OpsAgent dashboard
- Debugging why a virtual H3 layer shows no data or fails to load
- Understanding the mesh tile → FlexDB query → GPU rendering pipeline

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. MESH LOADING (one-time)                                          │
│    tiles.manifest.json → 122 H3M2 tiles → decode → concatenate      │
│    Result: ~2M cells with BigUint64Array of H3 cell IDs             │
├─────────────────────────────────────────────────────────────────────┤
│ 2. EPOCH TICK (every 60s)                                           │
│    VirtualH3Loader fires SQL:                                       │
│    SELECT h3_5, SUM(metric) FROM table                              │
│      WHERE _epoch = N AND h3_5 IS NOT NULL                          │
│      GROUP BY h3_5 LIMIT 1000000                                    │
├─────────────────────────────────────────────────────────────────────┤
│ 3. SPARSE→DENSE MAPPING                                             │
│    Arrow IPC response → parse H3 hex strings → BigInt lookup        │
│    → buildDenseEpochBuffer() → Float32Array[cellCount]              │
├─────────────────────────────────────────────────────────────────────┤
│ 4. GPU RENDERING                                                    │
│    Float32Array written to data.temporalColumns in-place            │
│    → renderer._currentEpoch = -1 (force texture re-upload)          │
│    → H3FlexRenderer renders extruded hexagons with style ramp       │
└─────────────────────────────────────────────────────────────────────┘
```

## YAML Configuration Reference

### Required Properties

```yaml
layers:
  - name: 'Layer Display Name' # Human-readable label
    type: h3f-virtual # MUST be exactly 'h3f-virtual'

    # ── FlexDB Connection ──
    flexdb_url: /api # FlexDB endpoint (proxied through Vite)
    table: your-flex-dataset # FlexDB table name

    # ── H3 Configuration ──
    h3_field: h3_5 # Column name containing H3 hex index strings
    resolution: 5 # H3 resolution (0-15), must match h3_field

    # ── Metrics ──
    metrics: # Array of column names to aggregate
      - incoming_octets
      - outgoing_octets
    active_metric: incoming_octets # Default metric shown on load
    aggregation: SUM # Aggregation function: SUM | AVG | MAX
```

### Optional Properties

```yaml
# ── Epoch / Time ──
epoch_interval_seconds: 60 # Epoch duration in seconds (default: 60)
epoch_window_minutes: 1440 # Rolling window size in minutes (default: 1440 = 24h)
epoch_cache_size: 60 # LRU cache size for completed epochs (default: 30)
find_latest: true # Auto-discover latest epoch on load (default: true)

# ── Mesh Override ──
mesh_url:
  /meshes/h3-l5 # Override mesh tile directory
  # Default: /meshes/h3-l{resolution}

# ── Filtering ──
extra_where: "airline = 'Delta'" # Optional extra WHERE clause appended to every query

# ── Rendering ──
extrusionScale: 0.08 # 3D extrusion height multiplier (0 = flat)

# ── Styling ──
style: # Primary style (active_metric default)
  type: ramp
  extrusion: true
  attribute: incoming_octets # Must match active_metric
  domain: [0, 1000000000] # [min, max] data value range
  stops: # Color ramp stops (navy → red)
    - '#050A33'
    - '#0D2580'
    - '#0D73BF'
    - '#F23319'
  opacityStops: # Graduated transparency
    - { value: 0, opacity: 0.0 }
    - { value: 1000000000, opacity: 0.9 }

# ── Per-Metric Style Overrides ──
metrics_styles:
  incoming_octets:
    style:
      type: ramp
      extrusion: true
      attribute: incoming_octets
      domain: [0, 1000000000]
      stops: ['#050A33', '#0D73BF', '#F23319']
  outgoing_octets:
    style:
      type: ramp
      extrusion: true
      attribute: outgoing_octets
      domain: [0, 150000000] # Different domain per metric
      stops: ['#050A33', '#0D73BF', '#F23319']
```

### Metric Expression Syntax

Metrics support inline SQL expressions with `AS` aliases for computed fields:

```yaml
metrics:
  - incoming_octets # Simple column reference
  - 'incoming_octets / 62914560.0 AS incoming_mbps' # Inline SQL expression
active_metric: 'incoming_octets / 62914560.0 AS incoming_mbps'
```

The expression is wrapped in the aggregation function automatically:
`SUM(incoming_octets / 62914560.0) AS incoming_mbps`

## Mesh Tile System

Virtual layers do NOT contain their own geometry. They share pre-built global H3 mesh tiles.

### Mesh Tile Directory Layout

```
/meshes/h3-l{resolution}/
├── tiles.manifest.json    # Tile discovery manifest
├── r000.mesh.h3f.gz       # H3M2 format tile (gzip-compressed)
├── r001.mesh.h3f.gz
├── ...
└── r121.mesh.h3f.gz       # 122 tiles for resolution 5
```

### Tile Discovery Flow

1. `LayerManager.addVirtualH3Layer()` constructs the mesh directory:
   `const meshDir = options.meshUrl || '/meshes/h3-l${resolution}'`
2. Fetches `${meshDir}/tiles.manifest.json` containing an array of tile entries
3. Each tile entry specifies: `{ file, cellCount, globalOffset, bounds }`
4. All tiles are fetched and decoded in parallel using `decodeH3Mesh()`
5. Tiles are concatenated with offset-adjusted cell indices into a single global mesh

### Mesh Tile Format (H3M2)

H3M2 tiles contain:

- **cellIds**: `BigUint64Array` — raw H3 cell IDs (used for sparse→dense lookup)
- **positions**: `Float32Array` — 3D vertex positions (x, y, z per vertex)
- **cellIndices**: `Float32Array` — per-vertex cell index (local, offset during concat)
- **extrudeFlags**: `Float32Array` — top-face vs side-face flags for extrusion
- **indices**: `Uint32Array` — triangle index buffer

### Available Mesh Resolutions (local dev)

| Resolution | Mesh Directory   | Tile Count                                    | Approx Cell Count |
| ---------- | ---------------- | --------------------------------------------- | ----------------- |
| 4          | `/meshes/h3-l4/` | N/A (single file: `h3-l4-global.mesh.h3f.gz`) | ~288K             |
| 5          | `/meshes/h3-l5/` | 122 tiles                                     | ~2.02M            |

> **CRITICAL**: Resolution 5 meshes are served from GCS via the Vite proxy.
> The mesh directory must be accessible at runtime — verify with:
> `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/meshes/h3-l5/tiles.manifest.json`

## VirtualH3Loader — Data Fetch Pipeline

### SQL Query Construction

For each epoch tick, `VirtualH3Loader._queryEpoch()` builds:

```sql
SELECT h3_5, SUM(incoming_octets) AS incoming_octets, SUM(outgoing_octets) AS outgoing_octets
FROM "your-flex-dataset"
WHERE _epoch = 29585876 AND h3_5 IS NOT NULL
GROUP BY h3_5
LIMIT 1000000
```

Key design rules:

- Queries use `_epoch = N` (exact bin index match), NOT `_epoch_start` timestamps
- The bin index is computed as `Math.floor(epochTimestamp / epochIntervalSeconds)`
- `LIMIT 1000000` prevents runaway queries on corrupted data
- `h3_field IS NOT NULL` filters null spatial indices
- Response format is `arrow` (Arrow IPC), NOT `json`

### Sparse→Dense Mapping

FlexDB returns sparse rows (only cells with data). The loader maps them to the dense mesh:

1. Parse H3 hex strings from Arrow column → `BigInt`
2. Build per-metric `Map<BigInt, number>` lookup
3. `buildDenseEpochBuffer()` iterates the mesh's `BigUint64Array` cell IDs,
   looking up each ID in the map → writes value or 0.0 to the output `Float32Array`

### Live Edge Discovery

On layer initialization (if `find_latest: true` — defaults to `true` when `time.mode === 'live'`):

1. Fires `SELECT MAX(_epoch) as latest FROM "table"`
2. Computes absolute seconds: `bin * epochIntervalSeconds`
3. Calls `TimeController.advanceLiveEdge(latest + epochInterval, ...)` — the live edge is
   the **epoch boundary** (one interval past the start), so the TimeController's `-1` index
   resolves to exactly `latest` (the start of the most recent available epoch)
4. Background polling interval (`setInterval` every 15s) re-probes for newer epochs

> **IMPORTANT**: The live edge passed to `advanceLiveEdge()` must be `latest + epochIntervalSeconds`,
> NOT `latest` itself. Passing the epoch start directly causes the TimeController to display 1 minute
> behind the dashboard's "Latest:" indicator. This was a known bug fixed in `LayerManager.js`.

### Epoch Cache (LRU)

- Default capacity: 30 epochs (configurable via `epoch_cache_size`)
- Simple FIFO eviction when at capacity
- Each cached entry stores `{ metricName → Float32Array }` (copied, not shared)
- Cache key is the epoch timestamp in seconds

## OpsAgent Integration

> **MANDATORY**: Read the `globe-trotter-integration` skill (in ops-agent) for the complete
> integration guide with working examples. This section summarizes the key requirements.

### Dashboard YAML

For live H3 virtual layers to work, **all three** settings must be configured:

```yaml
# Dashboard YAML — header
title: 'My Dashboard'
default_live: true # ← REQUIRED: enables live tracking mode
default_time: 'Last 5m' # ← REQUIRED: interpreted as isLiveTracking=true

panels:
  - type: globe
    title: 'Live H3 Traffic Density'
    catalog: 'my-dashboard' # References globe-config YAML
    position: { x: 0, y: 4, w: 12, h: 10 }
    options:
      basemap: 'dark-v11'
      camera: { lat: 35.0, lon: -98.0, altitude: 8000000 }
      # NOTE: Do NOT set hideGlobeUI: true — this breaks live epoch advancement
```

```yaml
# Globe config YAML — top level
time:
  mode: live # ← REQUIRED: engine enters live polling mode
```

If ANY of these three (`default_live`, `default_time: "Last Xm"`, `time.mode: live`) is missing,
the globe falls back to a manual playback loop and `h3f-virtual` layers won't auto-advance.

### Config Resolution Flow

```
catalog: "X" → GlobeController.js
  → fetch('/globe-trotter/catalog/X.yaml')
  → Vite gcsProxy middleware:
    1. Check: ops-agent/public/globe-trotter/catalog/X.yaml (local)
    2. Fallback: gs://globe-trotter/catalog/X.yaml (GCS bucket)
  → Parse YAML → GlobeTrotterEngine.loadConfig()
```

> **CRITICAL DEPLOYMENT RULE**: The config YAML must be accessible at the URL
> the `GlobeController.js` resolves. For local dev, place it in:
> `ops-agent/public/globe-trotter/catalog/{name}.yaml`
>
> For production, deploy to GCS:
> `gsutil cp config.yaml gs://globe-trotter/catalog/{name}.yaml`
>
> **NEVER** place configs only in `globe-trotter/public/catalog/` —
> OpsAgent's Vite proxy does NOT serve files from the globe-trotter repo's
> public directory. It checks its OWN public dir first, then falls through to GCS.

### FlexDB URL in OpsAgent Context

When the globe panel runs inside OpsAgent:

- `flexdb_url: /api` routes through OpsAgent's Vite proxy → FlexDB backend
- The Vite proxy at `localhost:5173` rewrites `/api` → FlexDB remote endpoint
- This is the standard path for all dashboard queries
- **Do NOT use** absolute FlexDB URLs (e.g., `http://flexdb.example.com:8090`)
  in catalog configs intended for OpsAgent — they bypass authentication and CORS

## Troubleshooting

### Globe shows no data (empty hexagons)

1. **Config not accessible**: Check HTTP status of the config URL:

   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/globe-trotter/catalog/{name}.yaml
   ```

   Must return **200**. If **204**, the config is missing from both local public/ and GCS.

2. **Mesh tiles not loading**: Check tile manifest:

   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/meshes/h3-l5/tiles.manifest.json
   ```

   Must return **200**.

3. **FlexDB query returning empty**: Check browser console for `[VirtualH3] FlexDB query returned 0 rows`.
   Run the query manually:

   ```bash
   curl -s -X POST http://localhost:5173/api/query \
     -H "Content-Type: application/json" \
     -d '{"sql": "SELECT h3_5, SUM(incoming_octets) AS incoming_octets FROM \"table\" WHERE _epoch = N AND h3_5 IS NOT NULL GROUP BY h3_5 LIMIT 10", "format": "json"}'
   ```

4. **H3 cell ID mismatch**: Virtual layers require H3 indices stored as **hex strings** (e.g., `"85278123fffffff"`). If the FlexDB column stores integers or has a different encoding, the sparse→dense mapping will find zero matches.

### Config loads but hexagons are invisible

1. **Domain mismatch**: Check that `style.domain` covers the actual data range. If the domain is [0, 1B] but actual values are 0-1000, all cells will render as near-zero opacity. Profile with:

   ```sql
   SELECT MIN(incoming_octets), MAX(incoming_octets), AVG(incoming_octets)
   FROM "table" WHERE _epoch = (SELECT MAX(_epoch) FROM "table")
   ```

2. **opacityStops too aggressive**: If the lowest non-zero opacity stop starts at a high value, most cells will be fully transparent.

3. **Extrusion but no altitude**: If `extrusionScale: 0`, the 3D extrusion is disabled and hexagons render flat (hard to see on dark basemaps). Set to `0.08` for visible extrusion.

## Key Source Files

| File                                        | Purpose                                                          |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `GlobeTrotterEngine.js` (line ~1406)        | Config parser — h3f-virtual case in `loadConfig()`               |
| `LayerManager.js` `addVirtualH3Layer()`     | Mesh loading, data object construction, loader setup             |
| `VirtualH3Loader.js`                        | FlexDB query execution, Arrow IPC decoding, sparse→dense mapping |
| `H3EpochUtils.js` `buildDenseEpochBuffer()` | Dense buffer construction from BigInt lookup                     |
| `GlobeController.js` (ops-agent)            | OpsAgent → Globe catalog resolution + lifecycle management       |
| `vite.config.js` (ops-agent)                | GCS proxy routing for `/globe-trotter/` assets                   |
