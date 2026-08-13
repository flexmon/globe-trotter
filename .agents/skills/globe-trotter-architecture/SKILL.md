---
name: globe-trotter-architecture
description: Globe Trotter render pipeline architecture — WebGPU-only engine, compute shaders, instanced tile rendering, camera, time, filter engine, event system, and shader conventions.
---

# Globe Trotter Architecture

**Updated 2026-06**: The engine is WebGPU-only. WebGL2 has been removed. On browsers without WebGPU support, the engine throws `WebGPURequiredError` and emits an `'unsupported'` event — there is no fallback.

**Updated 2026-07**: The standalone `FlightRenderer` (`lib/packages/core/src/flights/`) has been removed. Aircraft/flight data now renders through the **GFB point path** (`GFBRenderer` + `gfbpoint.wgsl`, which already handles heading, grounded/airborne state, and altitude). There is no separate flight renderer, draw call, or data texture.

Globe Trotter is a GPU-accelerated 4D globe engine for visualizing geospatial-temporal data using **WebGPU**.

## When to use this skill

- Use this when navigating the codebase for the first time
- Use this when understanding how rendering, time, and camera systems interact
- Use this when debugging render order or depth testing issues
- Use this when planning new features that touch multiple subsystems

## How to use it

### Architecture

Globe Trotter uses **WebGPU** for all rendering. Charts render on a separate transparent **WebGPU** overlay canvas (its own `getContext('webgpu')` sharing the engine's GPUDevice) layered over the main globe canvas.

```
┌─────────────────────────────────────────────────┐
│  WebGPU Globe Canvas (3D scene)                 │
│  ┌─────────────────────────────────────────┐    │
│  │  Globe (GlobeRenderer)                  │    │
│  │  Tiles (TileRenderer, 1 instanced draw) │    │
│  │  H3 Hex (H3FlexRenderer + compute)      │    │
│  │  GFB Points/Lines/Poly (GFBRenderer)    │    │
│  └─────────────────────────────────────────┘    │
├─────────────────────────────────────────────────┤
│  WebGPU Overlay Canvas (transparent, composited)│
│  ┌─────────────────────────────────────────┐    │
│  │  Charts (Histogram, Heatmap, CDF, etc.) │    │
│  │  GPU Text Labels (glyph atlas)          │    │
│  │  Axes, Grids, Now Indicator             │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

**Key design choices:**

- WebGPU for everything: compute shaders, instanced draws, explicit resource management, texture arrays
- Charts use a separate WebGPU overlay canvas (`ChartGPU`, sharing the engine's GPUDevice) with its own command encoder — composited by the browser, decoupled from the globe's render loop

### Render Pipeline

Every frame runs via `GlobeTrotterEngine._renderLoop()`:

```
requestAnimationFrame
  ↓
time.update() → normalizedTime (0..1)
camera.update() → { view, projection, position }
projection.mode → 'spherical' | 'mercator'
  ↓
WebGPU Render Pass:
  0. Pre-render: H3 direct texture writes (CPU→R32F, ~5.7MB per epoch)
     + GFB texture prep (RGBA32F position uploads)
  1. Globe          → base sphere + Blue Marble lighting
  2. Tiles          → Mapbox tiles via single instanced draw (texture 2D array)
  3. H3 Layers      → hexagonal data (GPU filter)
  4. GFB Layers     → point/line/polygon (GPU filter + horizon check)
  ↓ device.queue.submit()
WebGPU Overlay (Charts):
  5. Charts         → WebGPU overlay canvas (orthographic, depth OFF)
  ↓
UI.update() → acetate footer, time panel, layer manager, legend
```

### Z-Fighting Layer Stack

All layers render on concentric shells around the unit sphere. These radii prevent z-fighting between overlapping geometry. **Always check this table before changing any layer radius.**

| Order | Layer           | Radius                      | Source File     | Notes                                                                                                       |
| ----- | --------------- | --------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| 1     | Globe surface   | `1.0`                       | `globe.wgsl`    | Base sphere + Blue Marble                                                                                   |
| 2     | H3Flex cells    | `1.0 + 0.00003 + extrusion` | `h3hex.wgsl`    | `Z_FIGHT_OFFSET` + `u_extrusionScale`                                                                       |
| 3     | GFB polygons    | `1.00005`                   | `gfbpoly.wgsl`  | Normalized onto sphere at this radius                                                                       |
| 4     | Satellite tiles | `1.0001`                    | `tile.wgsl`     | `TILE_RADIUS`                                                                                               |
| 5     | GFB lines       | `1.00015`                   | `gfbline.wgsl`  | Above tiles so routes are visible                                                                           |
| 6     | GFB points      | `1.0 + altitude`            | `gfbpoint.wgsl` | Dynamic; grounded (alt > 0 && alt < 100ft) use 800ft effective alt. alt == 0 → airborne at extrusion height |

### Component Tree

```
GlobeTrotterEngine
├── capabilities: { webgpu } (WebGPURequiredError thrown if unsupported)
├── CameraController (orbit + tilt + inertia + flyTo; polymorphic projection)
├── MercatorCameraController (flat-map navigation)
├── TimeController (playback, speed, scrub, loop)
├── Projection: SphericalProjection | WebMercatorProjection
│   └── projection.mode → 'spherical' | 'mercator' (renderers dispatch internally)
│
├── ── WebGPU 3D Scene ──
│   ├── GlobeRenderer (sphere + Blue Marble, WGSL shaders)
│   ├── TileManager → TileRenderer / MercatorTileRenderer (instanced, texture 2D array, 1 draw call)
│   ├── LayerManager
│   │   ├── H3FlexShards (per-metric shard loading, Web Worker decode,
│   │   │                  viewport-selective mesh tile loading + IndexedDB cache)
│   │   └── H3FlexRenderer (direct CPU→texture writes, GPU filter, GPU histogram,
│   │                        updateMesh() for progressive tile growth)
│   │   ├── GFBShards → GFBRenderer / GFBLineRenderer / GFBPolygonRenderer
│   │   ├── MFBShards → MFBDataSource (chart-only, no spatial rendering)
│   │   ├── StreamingGFBLoader (live WebSocket stream)
│   │   ├── setActiveMetric() → switchMetric() + style hot-swap
│   │   ├── setFilter() → QueryParser.parseQuery() → flattenForGPU() → shader uniforms
│   │   └── updateLayerRamp() → GPU-first texture update (no recompile)
│   └── (no dedicated flight renderer — aircraft/flight data uses the GFB point path)
│
├── ── WebGPU Chart Overlay ──
│   ├── ChartGPU (overlay canvas getContext('webgpu'), quad/line/text pipelines, glyph atlas)
│   ├── ChartManager → ChartDataAdapter (GPU histogram fast path + CPU fallback)
│   │   ├── ChartLabelRenderer (GPU glyph atlas, DPR-aware sizing)
│   │   └── ChartManagerDialog (add/remove charts, zoom scale)
│   └── (transparent WebGPU canvas composited over the main globe canvas)
│
├── StyleEngine (color ramps, categorical LUTs, 3 color modes)
├── QueryParser (parse filter expressions → GPU predicates)
├── PickController (rAF-throttled hover/click, pinning, Esc clear, live-refresh)
│   ├── CPUSpatialAdapter  (GeoJSON — KDBush/RBush, degree space)
│   ├── GFBPointAdapter    (GFB points — screen-space scan, camera.project)
│   └── H3CellAdapter      (H3F cells — h3-js cell id → dataset row)
│
└── UIManager
    ├── AcetateFooter (FPS, draws, LAT/LON)
    ├── LayerManagerDialog (basemap, toggles, symbology, filter, zoom scale)
    ├── ChartManagerDialog (chart CRUD, type/source/attribute, zoom scale)
    ├── TimePanel (clock, play/pause, scrubber, speed, video recording)
    ├── GeocoderDialog (Mapbox typeahead + flyTo)
    ├── LegendPanel (draggable, scrollable, adaptive width, zoom scale)
    ├── H3SymbologyDialog / SymbologyDialog / Line/PolygonSymbologyDialog
    ├── FeaturePopup (hover tooltip + pinned click popup)
    └── LoadingScreen (brandable splash overlay)
```

### SHD3 Universal Core Architecture

All spatial and metric datasets consumed by the rendering engine are encoded using **SHD3 (Shard Data V3)**. SHD3 completely replaces opaque `SHD2` legacy blocks with **Self-Describing JSON Schemas** prepended to identical compressed column blocks.

- **MFB (MetricFlex)**: The pure structural foundation for rendering datasets representing geometry-free columnar frames.
- **GFB (GeoFlex)**: Appends explicit spatial dimensions (floating-point coordinates) binding logically to the SHD3 JSON entities.
- **H3F (H3Flex)**: Appends structural descriptors (cell identifiers, indexing arrays) binding logically to the SHD3 JSON entities.

> All `GFB` and `H3F` layouts share the exact same underlying native SHD3 chunking structures used by `MFB`. Temporal data is separated into **Temporal Epoch Streams** (delta shards) mapped physically on top of static geometries encoded natively inside **Global Base Shards**.

### Zero-Copy Temporal DataStore (MANDATORY)

> [!CAUTION]
> The zero-copy architecture is **compulsory**. Never duplicate shard data between the GPU pipeline and external tools. GPU renderers consume TypedArray buffers directly from *Flex decoders.

The `DataStore` stores decoded typed arrays for GPU renderers. For SQL queries, use the standalone **FlexQL** tool (`tools/flex-query-engine/`).

```
Shard binary (.bin)
    ↓ decode (H3FlexDecoder / GFBDecoder / MFBDecoder)
TypedArrays (Float32Array, BigUint64Array, etc.)
    ├── GPU renderer: reads directly for texture writes
    └── FlexQL (standalone tool): registers typed arrays directly (zero-copy)
```

**Key invariants:**

1. **Full shard load**: ALL epochs loaded at once. No per-epoch reloads.
2. **`subarray()` for temporal columns**: Zero-copy view of existing Float32Arrays.
3. **GPU filter expressions**: `QueryParser.js` parses simple filter syntax → GPU-ready predicates.

**Files:**

- `DataStore.ingestH3F()` / `ingestGFB()` / `ingestMFB()` — stores decoded data for GPU
- `QueryParser.parseQuery()` — `served_mbps > 50 AND region = CONUS` → GPU predicates

**Never do:**

- ❌ Replicate static columns across epochs (flat denormalized table = OOM)
- ❌ Create duplicate Float64 arrays from Float32 source data

### WebGPU Compute Pipelines

Globe Trotter uses WebGPU compute shaders for non-rendering GPU work:

| Pipeline         | Shader                  | Purpose                                            | Frequency                |
| ---------------- | ----------------------- | -------------------------------------------------- | ------------------------ |
| Histogram Reduce | `histogram_reduce.wgsl` | Bin 1.4M cells into histogram counts via atomicAdd | Per epoch minute (async) |

**H3 epoch data** is written directly to R32F textures via `queue.writeTexture()` (CPU→GPU, ~5.7MB per epoch) — only the 1–2 epochs needed per frame are uploaded. Two ping-pong textures (`dataTexA`/`dataTexB`, aliased as `_texCurrent`/`_texNext`) swap and overwrite per epoch (`H3FlexRenderer.js:610-613`, swap at `:871-873`). There are **no** dedicated spare textures — the sequential advance re-writes `_texNext` each epoch.

**Histogram compute** creates a temporary single-epoch storage buffer on-demand, runs fire-and-forget, and destroys the buffer after readback. Falls back to CPU when filters are active.

### Instanced Tile Rendering (WebGPU)

Instead of 50–150 per-tile draw calls, WebGPU uses:

- **Texture 2D array**: 256 layers × 512×512 rgba8unorm (all tiles in one GPU resource)
- **Storage buffer**: per-tile lat/lon bounds + array layer index
- **Single `drawIndexedInstanced()`**: vertex shader reads `instance_index` for tile lookup
- **LRU free list**: recycled array layers with 5-second grace period

### Public API (GlobeTrotterEngine)

| Method                                           | Description                              |
| ------------------------------------------------ | ---------------------------------------- |
| `addLayer(name, type, url, options)`             | Add a single H3F or GFB layer            |
| `addShardedLayer(name, manifestUrl, options)`    | Add sharded H3F layer                    |
| `addShardedGFBLayer(name, manifestUrl, options)` | Add sharded GFB layer                    |
| `addMFBLayer(name, manifestUrl)`                 | Add MFB metric layer (sharded or single) |
| `removeLayer(name)`                              | Remove layer and free GPU resources      |
| `setLayerStyle(name, styleSpec)`                 | Hot-swap style at runtime                |
| `setLayerVisibility(name, visible)`              | Show/hide a layer                        |
| `toggleLayerVisibility(name)`                    | Toggle visibility                        |
| `getLayerInfo()`                                 | Get all layer metadata                   |
| `getLayerNames()`                                | Get layer name list                      |
| `loadConfig(config)`                             | Load from parsed YAML config             |
| `setView({ lat, lon, distance })`                | Set camera immediately                   |
| `getView()`                                      | Get `{ lat, lon, distance }`             |
| `flyTo(lat, lon, distance)`                      | Smooth camera animation                  |
| `setBasemap(style)`                              | Change Mapbox basemap                    |
| `play() / pause() / togglePlay()`                | Time playback controls                   |
| `setSpeed(speed)`                                | Set playback multiplier                  |
| `scrubTo(normalized)`                            | Scrub to time position 0..1              |
| `on(event, cb) / off(event, cb)`                 | Subscribe to events                      |
| `destroy()`                                      | Free all GPU resources                   |

### Event System

```javascript
// on() returns an unsubscribe function: const off = engine.on(...); off();
engine.on('ready',        () => { ... });                                          // init complete
engine.on('frame',        ({ fps, normalizedTime }) => { ... });
engine.on('layerAdded',   ({ name }) => { ... });
engine.on('layerRemoved', ({ name }) => { ... });
engine.on('click',        ({ lat, lon }) => { ... });                              // raw canvas click
engine.on('selection',    ({ layer, feature, featureIndex, lngLat }) => { ... }); // pick click; all-null when cleared
```

> For the full public API surface — `ready()`, `isReady`, `getState()`/`applyState()`, widget visibility, named clock sources, looping animation window — see [`docs/core-lib-api.md`](../../docs/core-lib-api.md).

### GPU Filter Pipeline

Filters are parsed by `QueryParser` and applied as shader uniforms — zero CPU per-frame cost.

```
User types filter → QueryParser.parseQuery(queryStr, schema)
  → FilterSpec { groups: [[pred, pred], [pred]] }  // OR of AND groups
  → flattenForGPU(spec) → { predicates (≤2), combinator }
  → LayerManager.setFilter() → set shader uniforms:
    filter1Op, filter1Value, filter1High, filter1Target
    filter2Op, filter2Value, filter2High, filter2Target
    filterCombinator (0=AND, 1=OR)
  → Fragment shader: evalFilter() → discard non-matching cells
```

**Query syntax**: `served_mbps > 50`, `supply 100..500`, `airline = Delta`, `served_mbps > 50 AND custom_region = CONUS`

### Picking & Interaction Popup System

Picking is **opt-in** — a layer with no `interaction` block is not pickable. `PickController` owns the full interaction lifecycle: rAF-throttled pointer tracking, hover popup, click pinning, Escape clearing, and live-refresh of pinned popups as time advances. Per-layer hit-testing is delegated to a registered **adapter** behind a single interface: `picker.pick(ctx) → { featureIndex } | null`.

#### Adapter model

Each pickable layer is registered via `engine._pickController.registerLayer(name, options)` (called internally by the engine when a layer is loaded with an `interaction` block). The `picker` object can use any strategy; `PickController` is agnostic.

**Three built-in adapters:**

| Adapter             | Layers                                               | Strategy                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CPUSpatialAdapter` | GeoJSON point/line/polygon                           | KDBush (points) or RBush (lines/polygons) index in degree space                                                                                                                       |
| `GFBPointAdapter`   | GFB points (`gfb` / `gfb-sharded` / `gfb-streaming`) | rAF linear scan — projects each point to screen via `camera.project()`, returns nearest within pixel radius; geometry interpolated between epochs, popup values snap to nearest epoch |
| `H3CellAdapter`     | H3F cells (`h3f` / `h3f-sharded`)                    | Screen lat/lon → `h3-js` cell id at layer resolution → dataset row via cell-id map                                                                                                    |

#### FlexRowAccessor

Zero-copy read from columnar Flex data (GFB/H3F). Resolves a field by column kind:

- **Entity id** → `data.entityIds[featureIndex]` (column name = `data.entityKey.name`, e.g. `target_id`)
- **Temporal** → `data.temporalColumns[field][epochIndex * featureCount + featureIndex]`
- **Static** → `data.staticColumns[field][featureIndex]`

Dictionary/enum columns store numeric indices; `decode(field, raw)` maps them to display strings via per-column `data.dictionaries[field]`. Values are returned raw so `PopupFields` can apply per-field `valueMap` overrides first.

#### PopupFields + buildPickPayload

Normalises field specs (shorthand strings and full objects), applies `scale`/`prefix`/`unit`, formats values (`number`, `integer`, `string`, `bytes`, `datetime`, `percent`, `list`, `objectList`, `json`, `boolean`), applies `valueMap` overrides, and assembles flat `rows` or grouped `sections` for `FeaturePopup`.

#### Data flow

```
pointermove / click
     ↓
PickController.tick() / _onClick()
     ↓
_screenToGeo() → { lng, lat }          ← camera._screenToGlobe()
     ↓
adapter.pick(ctx)                       ← ctx = { sx, sy, geo, camera, engine }
     ↓
entry.getProperties(featureIndex, ctx)  ← FlexRowAccessor.getAllRaw() or GeoJSON props
     ↓
buildPickPayload()                      ← PopupFields.buildRows() / buildSections()
     ↓
FeaturePopup.showHover() / showPinned()
engine._emit('selection', {...})        ← on click only
```

#### GPU readback (deferred)

CPU screen-space picking is pixel-accurate for current point scales. A GPU id-readback path (separate pick-pass pipeline, `R32Uint` target, async `mapAsync`) is designed but deferred — it provides unique value only for very dense point layers or extruded H3 pillar precision under extreme tilt, neither of which exist today. See `docs/layer-interaction-popups-plan.md` for the full rationale and the opt-in architecture that makes adding it a non-breaking future step.

### Shader Conventions

- Globe is a **unit sphere** (radius = 1.0) centered at origin
- Y-axis = up (latitude), +Z front = lon −180° (date line)
- Altitude stored in **feet**, converted via `FEET_TO_GLOBE = 1/20925525`
- Standard function `latLonAltToXYZ(lat, lon, altFeet)` in all shaders (WGSL)
- WGSL shaders use `@group(N) @binding(M)` for bind group layout
- GFB points use 4 SDF symbol types via `u_symbolType` and 3 color modes via `u_colorMode`
- Chevron symbol (type 0) uses hard-discard in fragment shader to prevent additive glow from flooding the V-cutout
- UI changes (visibility toggles, symbology) call `requestRender()` and increment `_styleVersion` to wake stationary frame detection
- Renderers have a single public `render(projection, ctx)` method that dispatches internally to `_renderSpherical(ctx)` / `_renderMercator(ctx)` based on `projection.mode`

### Depth Strategy

| Layer | Depth Test       | Why                                                                                           |
| ----- | ---------------- | --------------------------------------------------------------------------------------------- |
| Globe | Yes + write      | Base geometry                                                                                 |
| Tiles | LEQUAL, no write | Overlay on globe                                                                              |
| H3    | LEQUAL + write   | 3D extruded pillars                                                                           |
| GFB   | None             | Geometric horizon check in shader (points incl. aircraft; `depthCompare: 'always'`, no write) |

### GPU Interpolation Patterns & Shard Transitions

- **State-Free On-Demand Textures (H3 & GFB)**: `queue.writeTexture()` is fast enough (< 1ms) to execute synchronously during the render pass. We do **not** use amortized upload queues or "spare" textures. Texture pointers (`_texCurrent` and `_texNext`) simply swap and overwrite per epoch.
- **GFB Points** (incl. aircraft/flights): RGBA32F data textures; the vertex shader interpolates positions with `slerp_unit()` (great-circle) and 4-point `catmullRom()` for C1-smooth trajectories, falling back to `slerp`/`mix` at trajectory fringes (`gfbpoint.wgsl`). Velocity unpacking (`_packVelocityRGBA32F`, `GFBRenderer.js:851`) must include boundary temporal columns to prevent rubber-banding.
- **GFB Polygons**: CPU triangle subdivision + vertex shader sphere normalization
- **Multi-Column Boundary Extraction (CRITICAL)**: When a `ShardedLoader` extracts the first epoch of the next shard to use as an interpolation boundary, it **must iterate over all columns in the shard map** (`for (const [metric, buf] of nextShard.entries())`), populating `_boundaryEpochs[metric]`. Hardcoding a single `_activeMetric` will break transitions when the renderer uses a different attribute for styling (e.g. `demand_mbps`).
- **Dynamic origShardCount**: Renderers assess `origShardCount` dynamically by subtracting 1 if boundary slices were successfully loaded (`this.data._boundaryEpochs?.[colorAttr] ? 1 : 0`). This ensures clamping math safely falls back only if boundary data is genuinely missing.

### Key Files

| Component               | File                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Engine                  | `lib/packages/core/src/GlobeTrotterEngine.js`                                                            |
| Public Exports          | `lib/packages/core/src/index.js`                                                                         |
| Camera                  | `lib/packages/core/src/camera/CameraController.js`, `MercatorCameraController.js`                        |
| Projection              | `lib/packages/core/src/projection/SphericalProjection.js`, `WebMercatorProjection.js`                    |
| Time                    | `lib/packages/core/src/time/TimeController.js`                                                           |
| Globe                   | `lib/packages/core/src/globe/GlobeRenderer.js`                                                           |
| Tiles                   | `lib/packages/core/src/tiles/TileRenderer.js`, `MercatorTileRenderer.js`, `TileManager.js`               |
| Tile Shader (WGSL)      | `lib/packages/core/src/tiles/shaders/tile.wgsl`                                                          |
| Layers                  | `lib/packages/core/src/layers/LayerManager.js`                                                           |
| H3F Renderer            | `lib/packages/core/src/layers/H3FlexRenderer.js`                                                         |
| H3F Histogram           | `lib/packages/core/src/layers/shaders/histogram_reduce.wgsl`                                             |
| H3F Shader (WGSL)       | `lib/packages/core/src/layers/shaders/h3hex.wgsl`                                                        |
| GFB Renderers           | `lib/packages/core/src/layers/GFBRenderer.js`, `GFBLineRenderer.js`, `GFBPolygonRenderer.js`             |
| Shard Loaders           | `lib/packages/core/src/layers/loaders/H3FlexShards.js`, `GFBShards.js`, `MFBShards.js`, `ShardLoader.js` |
| Streaming Loader        | `lib/packages/core/src/layers/loaders/StreamingGFBLoader.js`                                             |
| Compression Utils       | `lib/packages/core/src/util/compression.js`                                                              |
| Query/Filter            | `lib/packages/core/src/query/QueryParser.js`                                                             |
| Styles                  | `lib/packages/core/src/styles/StyleEngine.js`                                                            |
| Charts                  | `lib/packages/core/src/charts/ChartManager.js`, `ChartDataAdapter.js`                                    |
| Chart Dialog            | `lib/packages/core/src/ui/ChartManagerDialog.js`                                                         |
| UI Manager              | `lib/packages/core/src/ui/UIManager.js`                                                                  |
| Layer Dialog            | `lib/packages/core/src/ui/LayerManagerDialog.js`                                                         |
| Legend                  | `lib/packages/core/src/ui/LegendPanel.js`                                                                |
| Footer                  | `lib/packages/core/src/ui/AcetateFooter.js`                                                              |
| UI Styles               | `lib/packages/core/src/ui/styles.js`                                                                     |
| **Data SDK**            | `lib/packages/data-sdk/src/index.js`                                                                     |
| **DataStore**           | `lib/packages/core/src/data/DataStore.js`                                                                |
| **Query Dialog**        | `lib/packages/core/src/ui/QueryDialog.js`                                                                |
| H3F Encoder             | `lib/packages/data-sdk/src/encoders/H3FlexEncoder.js`                                                    |
| GFB Encoder             | `lib/packages/data-sdk/src/encoders/GeoFlexEncoder.js`                                                   |
| MFB Encoder             | `lib/packages/data-sdk/src/encoders/MetricFlexEncoder.js`                                                |
| **FlexDB Client**       | `lib/packages/flexdb-client/` (`@globe-trotter/flexdb-client`)                                           |
| SDK Docs                | `docs/data-sdk-guide.md`, `architecture/data-sdk-architecture.md`                                        |
| **Pick Controller**     | `lib/packages/core/src/picking/PickController.js`                                                        |
| **Flex Row Accessor**   | `lib/packages/core/src/picking/FlexRowAccessor.js`                                                       |
| **GFB Point Adapter**   | `lib/packages/core/src/picking/GFBPointAdapter.js`                                                       |
| **H3 Cell Adapter**     | `lib/packages/core/src/picking/H3CellAdapter.js`                                                         |
| **CPU Spatial Adapter** | `lib/packages/core/src/picking/CPUSpatialAdapter.js`                                                     |
| **Popup Fields**        | `lib/packages/core/src/picking/PopupFields.js`                                                           |
| **Spatial Index**       | `lib/packages/core/src/picking/SpatialIndex.js`                                                          |
| **Feature Popup**       | `lib/packages/core/src/ui/FeaturePopup.js`                                                               |
