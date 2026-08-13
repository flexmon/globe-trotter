# Globe Trotter — Core Library API Reference

Complete API reference for `@globe-trotter/core` v0.1.0.

> **Updated 2026-06:** WebGPU-only. WebGL2 backend fully removed. See [Migration Guide](#webgpu-requirement) for compatibility notes.

## Table of Contents

- [GlobeTrotterEngine](#globetrotterengine)
- [StyleEngine](#styleengine)
- [Configuration Options](#configuration-options)
- [Events](#events)
- [Exports](#exports)

---

## GlobeTrotterEngine

The main entry point. Creates a **WebGPU-powered** globe renderer with camera, time, tiles, layers, charts, and UI. Requires WebGPU support in the browser — throws `WebGPURequiredError` if unavailable.

### Constructor

```js
new GlobeTrotterEngine(canvas, options?)
```

| Parameter | Type                | Description                                           |
| --------- | ------------------- | ----------------------------------------------------- |
| `canvas`  | `HTMLCanvasElement` | **Required.** Canvas to render into                   |
| `options` | `Object`            | Configuration (see [Options](#configuration-options)) |

```js
const engine = new GlobeTrotterEngine(document.getElementById('globe'), {
  mapboxToken: 'pk.xxx',
  basemap: 'satellite',
  camera: { center: [39.0, -98.0], altitude: 12000 },
  time: { enabled: true, autoplay: true, speed: 60 },
});
```

---

### Lifecycle

#### `ready()`

**Returns:** `Promise<void>` — resolves once the engine has finished initializing (WebGPU backend + core systems). The supported way to wait for readiness; **use this instead of the private `_initPromise`**. Rejects with `WebGPURequiredError` if WebGPU is unavailable or init fails (also surfaced via the `'unsupported'` event). Safe to await repeatedly.

```js
const engine = new GlobeTrotterEngine(canvas, opts);
try {
  await engine.ready();
  await engine.loadConfig(config);
} catch (err) {
  // WebGPURequiredError — show a "WebGPU required" message
}
```

#### `isReady`

**Returns:** `boolean` — `true` once `ready()` has resolved; never `true` if init failed. (Property getter.)

#### `isDestroyed`

**Returns:** `boolean` — `true` after `destroy()`. Use instead of the private `_destroyed`. (Property getter.)

#### `start()`

Start the render loop. Called automatically if `autoStart: true` (default).

#### `stop()`

Pause the render loop. Does not free resources.

#### `destroy()`

Stop the render loop and free all GPU resources (WebGPU buffers/textures/pipelines). Call when unmounting the component. **Idempotent** — calling it again is a no-op. After destroy the instance is inert (`isDestroyed === true`) and should be discarded.

The engine also emits a `'ready'` event when initialization completes (see [Events](#available-events)).

```js
// React useEffect cleanup
return () => engine.destroy();
```

---

### Data Layers

#### `addLayer(name, type, url, options?)`

Load a single-file data layer.

| Parameter                | Type             | Description                          |
| ------------------------ | ---------------- | ------------------------------------ |
| `name`                   | `string`         | Display name                         |
| `type`                   | `'h3f' \| 'gfb'` | Data format                          |
| `url`                    | `string`         | URL to binary file                   |
| `options.style`          | `Object`         | Style spec                           |
| `options.extrusionScale` | `number`         | H3F pillar height (default: `0.012`) |

**Returns:** `Promise<void>`

```js
await engine.addLayer('Coverage', 'h3f', '/data/coverage.h3f', {
  style: {
    type: 'ramp',
    attribute: 'value',
    domain: [0, 100],
    stops: ['#0D1A80', '#1ABF59', '#F23319'],
  },
});
```

#### `addShardedLayer(name, manifestUrl, options?)`

Load a sharded H3Flex layer from a manifest file.

| Parameter              | Type     | Description                     |
| ---------------------- | -------- | ------------------------------- |
| `name`                 | `string` | Display name                    |
| `manifestUrl`          | `string` | URL to `.manifest.json`         |
| `options.style`        | `Object` | Style spec                      |
| `options.activeMetric` | `string` | Default metric for v3 manifests |
| `options.metrics`      | `Object` | Per-metric style overrides      |

**Returns:** `Promise<void>`

```js
await engine.addShardedLayer('Demand', '/data/supply.manifest.json', {
  activeMetric: 'served_mbps',
  metrics: {
    served_mbps: {
      style: {
        type: 'ramp',
        attribute: 'served_mbps',
        domain: [0, 80],
        stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319'],
      },
    },
  },
});
```

#### `addShardedGFBLayer(name, manifestUrl, options?)`

Load a sharded GFB layer from a manifest file.

**Returns:** `Promise<void>`

#### `addMFBLayer(name, manifestUrl)`

Load a MetricFlex layer (single-file or sharded). MFB layers provide data to charts only — they do not render geometry.

**Returns:** `Promise<void>`

```js
await engine.addMFBLayer('Revenue', '/data/revenue/airline_revenue.manifest.json');
```

#### `loadConfig(config)`

Load all layers and settings from a parsed YAML config object.

| Parameter | Type     | Description                                                                    |
| --------- | -------- | ------------------------------------------------------------------------------ |
| `config`  | `Object` | Parsed YAML config (see [YAML Config](developers-guide.md#yaml-configuration)) |

**Returns:** `Promise<{ ok: boolean, layersLoaded: number, layersFailed: number, errors: string[] }>`

```js
import YAML from 'yaml';
const config = YAML.parse(await (await fetch('/globe-config.yaml')).text());
const result = await engine.loadConfig(config);
console.log(`Loaded ${result.layersLoaded} layers, ${result.layersFailed} failed`);
```

#### `removeLayer(name)`

Remove a layer and free its GPU resources.

#### `setLayerStyle(name, styleSpec)`

Hot-swap the style for a named layer at runtime.

```js
engine.setLayerStyle('Demand', {
  type: 'ramp',
  attribute: 'demand_mbps',
  domain: [0, 200],
  stops: ['#1A0D80', '#E040FB', '#FF0000'],
});
```

#### `setLayerVisibility(name, visible)`

Show or hide a layer.

#### `toggleLayerVisibility(name)`

Toggle a layer's visibility. **Returns:** `boolean` (new state)

#### `getLayerInfo()`

Get metadata about all loaded layers.

**Returns:** `Array<{ name, type, visible, featureCount, epochCount, activeMetric, temporalAttributes }>`

#### `getLayerNames()`

**Returns:** `string[]` — names of all loaded layers.

#### `setActiveMetric(layerName, metricName)`

Switch the active temporal metric for a named H3F sharded layer. Triggers on-demand shard loading for the new metric (v3 manifests).

| Parameter    | Type     | Description                                    |
| ------------ | -------- | ---------------------------------------------- |
| `layerName`  | `string` | Name of the layer                              |
| `metricName` | `string` | Temporal attribute name (e.g. `'served_mbps'`) |

> **Note:** This method is on `LayerManager`, not on `GlobeTrotterEngine` directly. Access via `engine.layerManager.setActiveMetric()`.

```js
await engine.layerManager.setActiveMetric('Demand', 'desired_demand_mbps');
```

#### `setFilter(layerName, queryString)`

Apply a GPU-accelerated filter to a named layer. Non-matching features are discarded in the fragment shader.

| Parameter     | Type     | Description       |
| ------------- | -------- | ----------------- |
| `layerName`   | `string` | Name of the layer |
| `queryString` | `string` | Filter expression |

**Query syntax:**

- Comparison: `served_mbps > 50`
- Range: `served_mbps 100..500`
- Enum: `custom_region = CONUS`
- Boolean: `served_mbps > 50 AND custom_region = CONUS`
- OR groups: `served_mbps > 200 OR served_mbps < 10`

> **Note:** This method is on `LayerManager`. Access via `engine.layerManager.setFilter()`.

```js
engine.layerManager.setFilter('Coverage', 'served_mbps > 50 AND custom_region = CONUS');
```

#### `clearFilter(layerName)`

Remove a GPU filter from a named layer, restoring all features.

```js
engine.layerManager.clearFilter('Coverage');
```

#### `getFilter(name)`

**Returns:** `string | null` — the active filter expression on a layer, or `null` if none. Pairs with `setFilter`/`clearFilter`; the returned string can be passed straight back to `setFilter`.

#### Hover / click popups (`options.interaction`)

GFB point, H3F cell, and GeoJSON layers accept an optional `interaction` block that enables hover/click detail popups with configurable fields. It is passed the same way through `addLayer` / `addShardedGFBLayer` / `addStreamingGFBLayer` / `addShardedLayer` / `loadConfig`, and (for GeoJSON) through `addGeoJSONLayer(name, geojson, { interaction })`.

```js
engine.addGeoJSONLayer('Regions', geojson, {
  interaction: {
    hover: true,
    click: true, // click also fires a 'selection' event; Esc clears
    popup: {
      title: 'Region',
      fields: [
        'id', // shorthand (label = name)
        { name: 'pop', label: 'Population', format: 'integer' },
        {
          name: 'status',
          label: 'Status',
          valueMap: { 0: 'Inactive', 1: 'Active' },
          fallback: 'Unknown',
        },
      ],
    },
  },
});
```

Picking is opt-in (no block → not pickable). For the full field/format/valueMap reference and behavior notes, see the **Interaction Popups** section of the `globe-trotter-yaml-config` skill.

---

### Camera

#### `setView({ lat, lon, distance, heading?, tilt? })`

Set the camera position (immediate on Mercator; eased to the target on the spherical globe).

| Parameter  | Type     | Description                                                            |
| ---------- | -------- | ---------------------------------------------------------------------- |
| `lat`      | `number` | Latitude in degrees                                                    |
| `lon`      | `number` | Longitude in degrees                                                   |
| `distance` | `number` | Distance from globe center (`1.0` = surface, `2.0` = one radius above) |
| `heading`  | `number` | Heading in degrees (spherical camera only)                             |
| `tilt`     | `number` | Tilt in degrees (spherical camera only)                                |

```js
engine.setView({ lat: 51.5, lon: -0.1, distance: 1.5 });
```

#### `getView()`

**Returns:** `{ lat: number, lon: number, distance: number, heading: number, tilt: number }` — heading/tilt in degrees (`0` on the Mercator camera).

#### `getProjectionMode()`

**Returns:** `'spherical' | 'mercator'` — the current projection. Pairs with `setProjectionMode()`.

#### `flyTo(lat, lon, distance?)`

Smoothly animate the camera to a position.

```js
engine.flyTo(35.68, 139.69, 1.1); // Tokyo, close-up
```

---

### Time

#### `play()`

Start time playback.

#### `pause()`

Pause time playback.

#### `togglePlay()`

Toggle play/pause. **Returns:** `boolean` (isPlaying)

#### `setSpeed(speed)`

Set playback speed multiplier.

| Value | Meaning        |
| ----- | -------------- |
| `1`   | Real-time      |
| `60`  | 1 minute/sec   |
| `600` | 10 minutes/sec |

#### `getSpeedLabel()`

**Returns:** `string` — e.g. `'10x'`, `'60x'`

#### `scrubTo(normalized)`

Jump to a specific time position.

| Parameter    | Type     | Description                                      |
| ------------ | -------- | ------------------------------------------------ |
| `normalized` | `number` | `0.0` = start, `1.0` = end (of the full dataset) |

#### `getNormalizedTime()`

**Returns:** `number` — current position (0–1)

#### `getFormattedTime()`

**Returns:** `string` — formatted as `HH:MM:SS`

#### `isPlaying()`

**Returns:** `boolean`

#### `setTime(epochSec)`

Jump the playhead to a specific absolute UNIX timestamp (seconds). Single-point scrub; does **not** set a window.

#### `setTimeWindow(startEpochSec, endEpochSec)`

Set a **looping animation window** using absolute UNIX timestamps (seconds). Playback loops between the two bounds and the time bar represents exactly that window (not the whole loaded dataset). Designed for dashboard embedding where the host controls the time range.

| Parameter       | Type     | Description                          |
| --------------- | -------- | ------------------------------------ |
| `startEpochSec` | `number` | Window start (absolute UNIX seconds) |
| `endEpochSec`   | `number` | Window end (absolute UNIX seconds)   |

- Replay only. No-op in live mode, or when `startEpochSec >= endEpochSec` (logs a warning).
- May be set **before** layer data loads; the window is applied once the epoch range is known.
- The bounds share the same absolute-epoch space as the current epoch reported by the engine.
- Renderers are unaffected: epoch selection still spans the full dataset — the window only re-scales the time bar.

Also available declaratively at construction via `time.window: { start, end }` (see Configuration Options).

#### `clearTimeWindow()`

Clear the animation window, restoring the full-dataset timeline.

#### `getTimeWindow()`

**Returns:** `{ startEpochSec, endEpochSec } | null` — the active window, or `null` if none is set.

#### `setClockSource(source)`

Select who drives the playhead.

| Source       | Behavior                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'internal'` | The engine self-advances (play/pause/scrub/window). Default.                                                                                                         |
| `'external'` | The host owns the clock — self-advance is **off** and `play()`/`pause()` are no-ops. Drive the playhead with `pushEpoch()`. Use for multi-panel / master-clock sync. |
| `'live'`     | The engine follows the data live edge.                                                                                                                               |

#### `pushEpoch(epochSec)`

Push an absolute playhead position (UNIX seconds) from the host. Valid **only** when the clock source is `'external'` (ignored otherwise, with a warning). Lossless — writes the absolute epoch directly, no `0..1` round-trip.

#### `getTime()`

Symmetric time getter. Absolute `epochSec` is the source of truth; `normalized` is derived from it. Supersedes `getNormalizedTime()`/`getFormattedTime()`/`isPlaying()` for hosts that want a single snapshot.

**Returns:** `{ epochSec, normalized, source, playing }`

```js
engine.setClockSource('external'); // host owns the clock
engine.pushEpoch(1700000120); // move all panels to the same instant
engine.getTime(); // { epochSec: 1700000120, normalized, source: 'external', playing: false }
```

> **Lossless epoch:** the playhead is stored as an absolute epoch and `normalized` is _derived_ from it — never the reverse. `setTime()`/`pushEpoch()` write the absolute value directly, so `getTime().epochSec` reads back exactly what you set (this removes the old `setTime` desync).

---

### Charts

Charts are GPU-accelerated and always available on WebGPU.

#### `addChart(name, config)`

Add a GPU-rendered chart panel.

| Parameter          | Type               | Description                                                                              |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------------- |
| `name`             | `string`           | Chart display name                                                                       |
| `config`           | `Object`           | Chart definition                                                                         |
| `config.type`      | `string`           | `'heatmap'` \| `'histogram'` \| `'cdf'` \| `'boxplot'` \| `'barplot'` \| `'time-series'` |
| `config.source`    | `string`           | Layer name to read data from                                                             |
| `config.attribute` | `string`           | Temporal column name                                                                     |
| `config.position`  | `string`           | `'top-right'` \| `'top-left'` \| `'bottom-right'` \| `'bottom-left'`                     |
| `config.size`      | `[number, number]` | `[width, height]` in CSS pixels                                                          |
| `config.style`     | `Object`           | Type-specific style options                                                              |

```js
engine.addChart('Demand Histogram', {
  type: 'histogram',
  source: 'Demand Metrics',
  attribute: 'demand_mbps',
  position: 'top-right',
  size: [420, 180],
  style: { domain: [0, 60], binCount: 20, yScale: 'log' },
});
```

#### `removeChart(name)`

Remove a chart panel and free its GPU resources.

#### `setChartVisibility(name, visible)`

Show or hide a chart panel.

> **Advanced:** Access `engine.chartManager` directly for additional operations:
>
> - `engine.chartManager.toggleAllVisibility()` — toggle all charts
> - `engine.chartManager.invalidateData()` — force data reload
> - `engine.chartManager.chartsVisible` — check if any chart is visible

---

### Basemap

#### `setBasemap(style)`

Change the Mapbox basemap style.

| Style Name          | Description                      |
| ------------------- | -------------------------------- |
| `satellite`         | Raw satellite imagery (v4 API)   |
| `satellite-streets` | Satellite with road labels       |
| `streets`           | Full street map                  |
| `outdoors`          | Topographic outdoor map          |
| `light`             | Light minimal style              |
| `dark`              | Dark minimal style               |
| `navigation-day`    | Navigation-optimized (daytime)   |
| `navigation-night`  | Navigation-optimized (nighttime) |

```js
engine.setBasemap('dark');
```

#### `getBasemap()`

**Returns:** `string | null` — the current basemap style, or `null` if there is no tile system. Pairs with `setBasemap()`.

---

### UI Visibility

Complements the construction-time `uiWidgets` option (see Configuration Options) so an embedding host can adjust chrome after load.

#### `setWidgetVisible(name, visible)`

Show or hide a UI widget at runtime.

| Parameter | Type      | Description                       |
| --------- | --------- | --------------------------------- |
| `name`    | `string`  | Canonical widget name (see below) |
| `visible` | `boolean` |                                   |

**Returns:** `boolean` — `true` if the widget exists and was toggled; `false` if the name is unknown, the widget wasn't created, or UI is disabled (`ui: false`).

Canonical names: `footer`, `layers`, `geocoder`, `time`, `legend`, `charts`, `chartToggle`, `projection`, `compass`, `basemap`, `dropZone`.

```js
engine.setWidgetVisible('projection', false); // hide the 2D/3D toggle
engine.setWidgetVisible('basemap', false); // hide the basemap selector
```

#### `getWidgetVisibility()`

**Returns:** `Record<string, boolean>` — current visibility of every toggleable widget. Widgets that were never created (disabled or unavailable) report `false`. Returns `{}` when UI is disabled.

---

### State round-trip

Persist and restore the **view state** (camera, time, basemap, projection, and adjustments to already-loaded layers). View-state only — never data sources or layer existence.

#### `getState()`

Snapshot the current view. Composes the individual getters.

**Returns:**

```js
{
  version: 1,
  camera:    { lat, lon, distance, heading, tilt },
  time:      { epochSec, source },              // source per setClockSource
  basemap:   string | null,
  projection:'spherical' | 'mercator',
  layers: [ { name, visible, filter, style } ]  // filter = active expression | null;
                                                // style = programmatic setLayerStyle spec | null
}
```

#### `applyState(state)`

**Returns:** `Promise<void>`. Restore a (partial) snapshot from `getState()`.

- **View-state only** — never creates layers or fetches data; that stays `loadConfig`'s job.
- **Partial-tolerant** — applies only the keys present; ignores unknown fields.
- **Versioned** — older/newer `version` values are accepted best-effort.
- Applies setters in dependency order: **projection → camera → basemap → layers (visibility, style) → filters → time**. This is the single place restore-ordering lives.

Restore flow:

```js
await engine.ready();
await engine.loadConfig(yamlConfig); // the document (data sources)
await engine.applyState(savedState); // the view into it
```

---

### Events

#### `on(event, callback)`

Subscribe to an engine event. **Returns an unsubscribe function** — call it to remove the listener (no need to keep the callback reference for `off`).

```js
const off = engine.on('viewChanged', (v) => console.log(v));
// later…
off();
```

#### `off(event, callback)`

Unsubscribe from an event (alternative to the function returned by `on`).

#### Available Events

| Event          | Payload                                                 | Description                                                                                            |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ready`        | `{}`                                                    | Fired once initialization completes (pairs with `ready()`)                                             |
| `unsupported`  | `{ reason }`                                            | WebGPU unavailable / init failed                                                                       |
| `error`        | `{ error }`                                             | An error occurred (e.g. a layer failed to load)                                                        |
| `viewChanged`  | `{ lat, lon, distance, heading, tilt }`                 | Camera view changed (fires while moving; not when stationary)                                          |
| `timeChanged`  | `{ epochSec, normalized }`                              | Playhead epoch changed                                                                                 |
| `selection`    | `{ layer, feature, featureIndex, lngLat }`              | A feature was clicked; all-null when the selection is cleared. `lngLat` is currently `null` (reserved) |
| `layerLoad`    | `{ name, status: 'loading'\|'ready'\|'error', error? }` | Layer load lifecycle (emitted by `loadConfig`)                                                         |
| `frame`        | `{ time, normalizedTime, fps, drawCalls, features }`    | Fired every frame                                                                                      |
| `layerAdded`   | `{ name, type }`                                        | Layer successfully loaded                                                                              |
| `layerRemoved` | `{ name }`                                              | Layer removed                                                                                          |

```js
const off = engine.on('frame', ({ fps, drawCalls, features }) => {
  hudElement.textContent = `${fps} FPS | ${drawCalls} draws | ${features} features`;
});

engine.on('selection', ({ layer, feature }) => {
  if (layer) showDetails(layer, feature);
  else clearDetails();
});
```

---

## StyleEngine

Static utility for creating and compiling data-driven styles.

### `StyleEngine.ramp(options)`

Create a continuous color ramp style spec.

```js
const spec = StyleEngine.ramp({
  attribute: 'demand_mbps',
  domain: [0, 100],
  stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319'],
  opacityStops: [
    { value: 0, opacity: 0.0 },
    { value: 100, opacity: 0.9 },
  ],
});
```

### `StyleEngine.categorical(options)`

Create a categorical discrete-color style spec.

```js
const spec = StyleEngine.categorical({
  attribute: 'region',
  categories: { North: '#E31937', South: '#0032A0' },
  default: '#999999',
  opacity: 0.9,
});
```

### `StyleEngine.compile(device, spec, dictionary?)`

Compile a style spec into GPU textures for WebGPU.

**Returns:** `CompiledStyle` with `.color`, `.opacity`, `.dispose()`

```js
const compiled = StyleEngine.compile(device, spec, data.dictionary || []);
renderer.setStyle(compiled);
```

### Style Resolution Cascade

When a layer is loaded, styles are resolved in this priority order:

| Priority | Source                | Description                                 |
| -------- | --------------------- | ------------------------------------------- |
| **1**    | YAML `style:` block   | Explicit style in `globe-config.yaml`       |
| **2**    | Sidecar `.style.json` | Convention file next to the data            |
| **3**    | Embedded in data      | Style from HAS_STYLE flag in H3F/GFB binary |
| **4**    | Geometry-type default | Single constant color per geometry type     |

**Geometry-type defaults** (used when no style is configured):

| Geometry | Color                  | Opacity |
| -------- | ---------------------- | ------- |
| Point    | `#00BFE6` (cyan)       | 0.9     |
| Line     | `#4A90D9` (steel blue) | 0.8     |
| Polygon  | `#2E8B57` (sea green)  | 0.6     |
| H3F      | Blue→red ramp          | 0.7     |

> **Note:** `_resolveStyle()` always returns a valid style spec — never null. A `CompiledStyle` is always created for every layer.

---

## SymbologyDialog

Rich symbology editor dialog for GFB vector layers. Provides interactive controls for symbol type, scale, per-category color, and opacity. All changes are applied instantly via `StyleEngine` → `renderer.setStyle()`.

### Constructor

```js
import { SymbologyDialog } from '@globe-trotter/core';
const dialog = new SymbologyDialog(engine, 'Aircraft Tracks');
```

| Parameter   | Type                 | Description                   |
| ----------- | -------------------- | ----------------------------- |
| `engine`    | `GlobeTrotterEngine` | Engine instance               |
| `layerName` | `string`             | Name of the GFB layer to edit |

### Methods

| Method      | Description                                        |
| ----------- | -------------------------------------------------- |
| `close()`   | Animate-out and remove the dialog overlay          |
| `destroy()` | Immediately remove overlay and null all references |

### Features

- **Symbol**: Type selector (chevron, arrow, diamond, circle) and scale slider (0.3–4×)
- **Color**: Default/Custom toggle; Custom mode shows per-category color pickers
- **Opacity**: Global opacity slider (0–1)
- **Attribute selector**: Dynamically discovers enum columns from any GFB dataset
- **Reset**: Returns to YAML-configured defaults
- **Lazy-loaded**: Imported via dynamic `import()` from LayerManagerDialog — no impact on initial load

---

## Configuration Options

Full options passed to `new GlobeTrotterEngine(canvas, options)`:

| Option                                    | Type              | Default                      | Description                                                                                                                                              |
| ----------------------------------------- | ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mapboxToken`                             | `string`          | `null`                       | Mapbox access token                                                                                                                                      |
| `basemap`                                 | `string`          | `'satellite-v9'`             | Initial basemap style                                                                                                                                    |
| `antialias`                               | `boolean`         | `true`                       | WebGPU antialiasing (MSAA)                                                                                                                               |
| `background`                              | `number[4]`       | `[0.008, 0.016, 0.032, 1.0]` | Clear color (RGBA)                                                                                                                                       |
| `powerPreference`                         | `string`          | `'high-performance'`         | WebGPU adapter preference                                                                                                                                |
| `maxDpr`                                  | `number`          | `2`                          | Max device pixel ratio                                                                                                                                   |
| `autoStart`                               | `boolean`         | `true`                       | Start render loop immediately                                                                                                                            |
| `camera`                                  | `Object`          | `{}`                         | Camera settings                                                                                                                                          |
| `camera.center`                           | `[lat, lon]`      | —                            | Initial center                                                                                                                                           |
| `camera.altitude`                         | `number`          | —                            | Altitude in km                                                                                                                                           |
| `camera.tilt`                             | `number`          | `0`                          | Tilt in degrees (0–85)                                                                                                                                   |
| `camera.heading`                          | `number`          | `0`                          | Heading in degrees                                                                                                                                       |
| `time`                                    | `Object`          | `{}`                         | Time controller settings                                                                                                                                 |
| `time.enabled`                            | `boolean`         | `true`                       | Enable temporal animation                                                                                                                                |
| `time.autoplay`                           | `boolean`         | `true`                       | Auto-start playback                                                                                                                                      |
| `time.speed`                              | `number`          | `60`                         | Playback multiplier                                                                                                                                      |
| `time.startOffset`                        | `string\|number`  | `0`                          | `"HH:MM:SS"` or seconds                                                                                                                                  |
| `time.loop`                               | `boolean`         | `true`                       | Loop playback                                                                                                                                            |
| `time.window`                             | `Object`          | —                            | Looping animation window `{ start, end }`; each is an absolute UNIX-epoch number or ISO date string. Equivalent to calling `setTimeWindow()` after load. |
| `ui`                                      | `boolean`         | `true`                       | Enable UI widgets (master switch)                                                                                                                        |
| `uiWidgets`                               | `Object`          | all `true`                   | Per-widget visibility. Any omitted key defaults to `true` (except `loadingScreen`). Runtime-toggleable via `setWidgetVisible()`.                         |
| `uiWidgets.footer`                        | `boolean`         | `true`                       | Attribution / FPS footer                                                                                                                                 |
| `uiWidgets.layers`                        | `boolean`         | `true`                       | Layer manager panel                                                                                                                                      |
| `uiWidgets.geocoder`                      | `boolean`         | `true`                       | Search / geocoder (also needs a provider key)                                                                                                            |
| `uiWidgets.time`                          | `boolean`         | `true`                       | Time bar / scrubber                                                                                                                                      |
| `uiWidgets.legend`                        | `boolean`         | `true`                       | Legend panel                                                                                                                                             |
| `uiWidgets.charts`                        | `boolean`         | `true`                       | Charts button + manager                                                                                                                                  |
| `uiWidgets.chartToggle`                   | `boolean`         | `true`                       | Floating chart visibility button (also requires `charts`)                                                                                                |
| `uiWidgets.projection`                    | `boolean`         | `true`                       | 2D/3D projection toggle                                                                                                                                  |
| `uiWidgets.compass`                       | `boolean`         | `true`                       | Heading compass                                                                                                                                          |
| `uiWidgets.basemap`                       | `boolean`         | `true`                       | Basemap selector (nested in the layer manager)                                                                                                           |
| `uiWidgets.dropZone`                      | `boolean`         | `true`                       | Drag-drop GeoJSON overlay                                                                                                                                |
| `uiWidgets.loadingScreen`                 | `Object\|boolean` | `false`                      | Branded loading screen (see below)                                                                                                                       |
| `uiWidgets.loadingScreen.logoUrl`         | `string`          | —                            | URL to brand wordmark / logo image                                                                                                                       |
| `uiWidgets.loadingScreen.iconUrl`         | `string`          | —                            | URL to brand icon (shown beside logo)                                                                                                                    |
| `uiWidgets.loadingScreen.title`           | `string`          | —                            | Title text below logo                                                                                                                                    |
| `uiWidgets.loadingScreen.subtitle`        | `string`          | —                            | Subtitle text                                                                                                                                            |
| `uiWidgets.loadingScreen.backgroundColor` | `string`          | —                            | Override background CSS                                                                                                                                  |
| `onProgress`                              | `Function`        | `null`                       | `(message, percent) => void`                                                                                                                             |

---

## Exports

The package has **two entry points**. TypeScript declarations ship for both (`types` field in `package.json`).

### Primary — `@globe-trotter/core` (stable, fully typed)

```js
import {
  GlobeTrotterEngine,
  WebGPURequiredError, // engine + capability error
  StyleEngine, // data-driven styling
  FilterOp, // query filter operators (value type)
  altitudeToZoom,
  zoomToAltitude, // geo helpers
  EARTH_CIRC_KM,
  EARTH_RADIUS_KM, // geo constants
} from '@globe-trotter/core';
```

This is the supported contract — the surface an embedding host should build against.

### Advanced — `@globe-trotter/core/advanced` (unstable internals)

Engine internals for power users. **Not part of the stable contract — names may change between releases** (typed loosely as `any`).

```js
import { LayerManager, CameraController, TimeController } from '@globe-trotter/core/advanced';
```

Available here: `TileManager`, `GlobeRenderer`, `TileRenderer`, `MercatorTileRenderer`; basemap providers (`BasemapProvider`/`MapboxProvider`/`GoogleProvider`); style compilers (`compileRampData`/`uploadRampTexture`/`compileCategoricalData`/`uploadCategoricalTexture`); `LayerManager` + all loaders (`H3FlexShards`, `DGFlexShards`, `MFBShards`, `GFBShards`, `VirtualH3Loader`, `StreamingGFBLoader`, `LoaderRegistry`) + `GFBLineRenderer`/`GFBPolygonRenderer` + mesh/epoch utils; decoders (`decodeH3Flex`/`decodeH3Mesh`/`decodeDGFlex`/`decodeDGFMesh`/`decodeGFB`/`decodeMFB`/`MFBDataSource`); GeoJSON loaders (`parseGeoJSON`/`geojsonToFeatures`/`splitFeatureCollectionByGeometry`); picking (`PickController`/`SpatialIndex`); query (`parseQuery`/`flattenForGPU`); `TimeController`; cameras (`CameraController`/`MercatorCameraController`); math namespaces (`mat4`/`vec3`/`geo`); projection (`assertIsProjection`/`SphericalProjection`/`WebMercatorProjection`); `ChartManager`; and UI widgets (`FeaturePopup`, `UIManager`, `AcetateFooter`, `LayerManagerDialog`, `GeocoderDialog`, `TimePanel`, `LoadingScreen`, and the symbology dialogs).

### WebGPU Requirement

**Updated 2026-06:** Globe Trotter now requires WebGPU. The dual-backend architecture (WebGPU + WebGL2 fallback) has been removed.

**Browser Support:**

- Chrome/Edge 113+
- Firefox Nightly (experimental)
- Safari Technology Preview (experimental)

**Error Handling:**

```js
import { GlobeTrotterEngine, WebGPURequiredError } from '@globe-trotter/core';

try {
  const engine = new GlobeTrotterEngine(canvas, options);
  // Check capabilities synchronously after construction
  console.log(engine.capabilities); // { webgpu: GPUDevice }
} catch (err) {
  if (err instanceof WebGPURequiredError) {
    // Browser does not support WebGPU
    showError('WebGPU required. Please use Chrome 113+ or Edge 113+.');
  }
}

// Or listen for the 'unsupported' event
engine.on('unsupported', () => {
  showError('WebGPU not available.');
});
```

**Renderers:**
All renderers are WebGPU-only and have a single `render(projection, ctx)` method:

- `H3FlexRenderer`
- `DGFlexRenderer`
- `GFBRenderer`
- `GFBLineRenderer`
- `GFBPolygonRenderer`
- `GlobeRenderer`
- `TileRenderer`
- `MercatorTileRenderer`

**Loaders:**
Sharded data loaders are now accessed via `LoaderRegistry.create(type, manifestUrl, opts)`:

```js
import { LoaderRegistry } from '@globe-trotter/core';

const loader = LoaderRegistry.create('h3f', '/data/coverage.manifest.json', {
  activeMetric: 'served_mbps',
});
```

Supported types: `'h3f'`, `'dgf'`, `'gfb'`, `'mfb'`, `'gfb-stream'`

**Projection:**
Projection classes expose `mode` and `preBake(coords, fpp, indices, opts)` for pre-baking geometry into projection-specific coordinate spaces.

**Dev Workflow:**

- Run tests: `npm test` in `lib/packages/core` (uses Node.js built-in test runner)
- Run benchmarks: `npm run bench` at repo root (headless WebGPU via Playwright)

> **Tip:** Most applications only need `GlobeTrotterEngine` and optionally `StyleEngine`. The lower-level exports are for advanced use cases like custom renderers or data pipelines.
