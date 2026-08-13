---
name: globe-trotter-custom-layers
description: Guide for creating custom renderer/layer types in Globe Trotter — WebGPU renderer contract, WGSL shaders, temporal interpolation, filter integration, and LayerManager registration.
---

# Creating Custom Layers for Globe Trotter

**Updated 2026-06**: The engine is WebGPU-only. Write a single WebGPU (WGSL) renderer, not a WebGL2/WebGPU shader pair.

Guide for extending Globe Trotter with new renderer types beyond the built-in H3 and GFB renderers.

## When to use this skill

- Use this when adding a new visualization type (e.g., heatmap, trajectory ribbon, satellite footprint)
- Use this when building a custom renderer with its own shader pair
- Use this when integrating a new data format into the LayerManager
- Use this when choosing a temporal interpolation pattern for animated data
- Use this when making a custom renderer hoverable/clickable (see "Making a Custom Renderer Pickable")

## How to use it

### Renderer Contract

All renderers are WebGPU-only.

```javascript
class MyRenderer {
    constructor(device, format, depthFormat, data, compiledStyle) { ... }
    render(projection, ctx) { ... }  // Single public method — dispatches to _renderSpherical/_renderMercator
    prepareCompute(commandEncoder, normalizedTime) { ... }  // optional: compute shader work
    dispose() { ... }

    // Private projection-specific methods:
    _renderSpherical(ctx) { ... }  // ctx = { passEncoder, viewMatrix, projMatrix, normalizedTime, ... }
    _renderMercator(ctx) { ... }   // ctx includes mercatorBounds, etc.

    // Optional:
    setStyle(compiledStyle) { ... }
    setExtrusionScale(scale) { ... }
    setFilter(gpuFilter) { ... }  // gpuFilter = { predicates, combinator }
}
```

Key implementation rules:

- Receives a `GPUDevice` for all GPU resource creation
- `render(projection, ctx)` is the ONLY public render method — it reads `projection.mode` and dispatches internally
- `ctx.passEncoder` is the `GPURenderPassEncoder` — use it for draw calls
- Pipelines, bind groups, and buffers created once in constructor
- Uniform data written via `device.queue.writeBuffer()` into pre-allocated scratch buffers
- **Always pre-allocate scratch buffers** for per-frame uniform writes (avoid `new ArrayBuffer()` in render loop)

### Making a Custom Renderer Pickable

Picking is wired independently of rendering. After your layer is registered with `LayerManager`, call `engine._pickController.registerLayer(name, options)` to make it hoverable and clickable. Deregister when the layer is removed.

#### The `picker` interface

```javascript
const picker = {
  /**
   * @param {{ sx: number, sy: number, geo: {lng:number,lat:number}|null,
   *           camera: CameraController, engine: GlobeTrotterEngine }} ctx
   * @returns {{ featureIndex: number } | null}
   */
  pick(ctx) {
    // Return { featureIndex } on hit, null otherwise.
    // geo is the globe-surface lat/lon under the cursor
    // (null when the ray misses the globe entirely).
    // sx/sy are canvas-relative CSS pixels.
  },
};
```

#### The `getProperties` function

```javascript
/**
 * @param {number} featureIndex
 * @param {{ camera: CameraController, engine: GlobeTrotterEngine }} ctx
 * @returns {object}  field-name → raw value (numbers, strings, bigints)
 */
function getProperties(featureIndex, ctx) {
  // Called on every hover tick and on every pinned-popup time-refresh.
  // Return an object whose keys match the popup `fields` names.
}
```

#### Registration

```javascript
engine._pickController.registerLayer(layerName, {
  hover: true, // show popup on pointermove
  click: true, // pin popup on click; fires 'selection' event; Esc clears
  picker,
  getProperties,
  title: 'My Layer', // popup heading (defaults to layerName)
  popupFields: [
    { name: 'id', label: 'ID' },
    { name: 'value', label: 'Value', format: 'number', decimals: 1 },
  ],
});

// Always deregister when removing the layer:
engine._pickController.deregisterLayer(layerName);
```

#### For Flex-backed layers (GFB/H3F data)

Use `FlexRowAccessor` for zero-copy reads from columnar typed arrays, and pass its `.decode` method so dictionary/enum columns resolve to display labels automatically:

```javascript
import { FlexRowAccessor } from '../picking/FlexRowAccessor.js';
import { resolveEpoch } from '../picking/GFBPointAdapter.js';

const accessor = new FlexRowAccessor(data); // data = decoded GFB/H3F object

engine._pickController.registerLayer(layerName, {
  hover: true,
  click: true,
  picker,
  getProperties: (featureIndex, ctx) => {
    const epochCount = data.temporalColumns?.lon?.length / data.featureCount || 1;
    const { nearest } = resolveEpoch(ctx.engine.time.getNormalized(), epochCount);
    return accessor.getAllRaw(featureIndex, nearest);
  },
  decode: accessor.decode, // maps dict indices → display strings
  popupFields: [
    { name: 'target_id', label: 'ID' },
    { name: 'altitude', label: 'Alt', format: 'integer', unit: 'ft' },
  ],
});
```

#### Pick strategy by geometry type

| Geometry                                    | Recommended strategy                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Surface-pinned (H3 cells, GeoJSON polygons) | Use `ctx.geo` (lat/lon) for spatial lookup — ray hits radius 1.0, which is where these live                                                                              |
| Elevated / moving points (GFB)              | Project each candidate point with `ctx.camera.project(lat, lng, altFeet, w, h)` → `{ sx, sy, visible }` and compare to `ctx.sx`/`ctx.sy` within a pixel-radius tolerance |

### Step 1: Create WGSL Shader

Place in `lib/packages/core/src/layers/shaders/`:

```wgsl
// mytype.wgsl

struct Uniforms {
    view: mat4x4<f32>,
    proj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
};
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = u.proj * u.view * vec4<f32>(in.position, 1.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
```

### Step 2: Add GPU Filter Support (optional)

If your layer supports filtering, add filter uniforms:

#### WGSL

```wgsl
// In uniform struct:
filter_combinator: i32,
filter1_op: i32, filter1_value: f32, filter1_high: f32, filter1_target: i32,
filter2_op: i32, filter2_value: f32, filter2_high: f32, filter2_target: i32,

fn evalFilter(op: i32, fv: f32, threshold: f32, high: f32) -> bool {
    if (op == 1) { return abs(fv - threshold) < 0.5; }  // EQ
    if (op == 2) { return fv > threshold; }               // GT
    if (op == 3) { return fv < threshold; }               // LT
    if (op == 4) { return fv >= threshold; }              // GTE
    if (op == 5) { return fv <= threshold; }              // LTE
    if (op == 6) { return fv >= threshold && fv <= high; } // BETWEEN
    return true;
}
```

### Step 3: Create Renderer Class

```javascript
import myWGSL from './shaders/mytype.wgsl?raw';

export class MyRenderer {
  constructor(device, format, depthFormat, data, compiledStyle) {
    this.device = device;
    this._uniformBufferSize = 128; // view(64) + proj(64)

    // Pre-allocate uniform scratch (zero GC per frame)
    this._uniformScratch = new ArrayBuffer(this._uniformBufferSize);
    this._uniformF32 = new Float32Array(this._uniformScratch);

    this.uniformBuffer = device.createBuffer({
      size: this._uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Build pipeline, bind groups, vertex buffers...
    this._buildPipeline();
    this._buildMesh(data);
  }

  // Public API: single entry point
  render(projection, ctx) {
    if (projection.mode === 'spherical') {
      this._renderSpherical(ctx);
    } else if (projection.mode === 'mercator') {
      this._renderMercator(ctx);
    }
  }

  // Private: spherical projection rendering
  _renderSpherical(ctx) {
    const { passEncoder, viewMatrix, projMatrix } = ctx;

    // Reuse pre-allocated scratch buffer
    const f32 = this._uniformF32;
    f32.set(viewMatrix, 0);
    f32.set(projMatrix, 16);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformScratch);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this._uniformBindGroup);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.setIndexBuffer(this.indexBuffer, 'uint32');
    passEncoder.drawIndexed(this._indexCount);
  }

  // Private: mercator projection rendering (implement as needed)
  _renderMercator(ctx) {
    // Similar to _renderSpherical, but use mercator-specific transforms
  }

  dispose() {
    // GPU resources
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    if (this.style) this.style.disposeGPU();
    // CPU buffers — null to release for GC
    this._uniformScratch = null;
    this._uniformF32 = null;
  }
}
```

### Step 4: Register in LayerManager

Add a case in `LayerManager.addLayer()`:

```javascript
} else if (type === 'mytype') {
    data = decodeMyType(buffer);
    renderer = new MyRenderer(this._device, this._format, this._depthFormat, data, compiledStyle);
}
```

### MFB Layers: Non-Rendering Pattern

MFB layers do **not** render geometry — they provide data to charts via `MFBDataSource`. If your custom layer is data-only (no spatial rendering), follow this pattern:

```javascript
// In LayerManager:
this.layers.set(name, {
  type: 'mfb',
  renderer: new MFBDataSource(decoded), // MFBDataSource stands in for the renderer — no geometry, not drawn by render()
  shardedLoader, // MFBShards instance (loader.hasShards ? loader : null)
});
```

`MFBShards` follows the same interface as `GFBShards` — call `updateForTime(normalizedTime)` per frame, and it handles adaptive shard loading.

### Step 5: Hook into Render Loop

Renderers are called from `LayerManager.render()` with the projection object:

```javascript
// In LayerManager.render():
if (layer.renderer) {
  layer.renderer.render(projection, ctx);
}
```

The `ctx` object contains `{ passEncoder, viewMatrix, projMatrix, normalizedTime, ... }` plus projection-specific fields.

### Temporal Interpolation Patterns

| Pattern                | Best For                      | How                                                                    |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| Direct texture write   | Large fixed grids (1M+ cells) | CPU→R32F texture via `queue.writeTexture()` (~5.7MB/epoch) + ping-pong |
| RGBA32F Data Texture   | Moving features               | Two RGBA32F textures swapped on epoch + `mix()` in vertex shader       |
| Data Texture instanced | Instanced particles           | Per-instance texture lookup + `slerp()`                                |
| CPU fallback           | Topology changes              | JavaScript lerp + `writeBuffer`                                        |

### Performance Best Practices

1. **Pre-allocate scratch buffers** — never `new ArrayBuffer()` in the render loop
2. **Reuse bind groups** — only recreate when resources change (e.g., texture swap)
3. **Use storage buffers** for large per-frame data (tile bounds, instance data)
4. **Prefer instanced draws** over per-object draw calls
5. **Dispose all GPU resources** in `dispose()` — buffers, textures, pipelines; **null CPU buffers** for GC
6. **Use `queue.writeBuffer()`** for uniform updates (not `createBuffer()` + copy)
7. **Use `queue.writeTexture()`** for per-epoch data — only upload what you need

### Files to Study

| Pattern                   | File                                         |
| ------------------------- | -------------------------------------------- |
| Simple renderer           | `GFBRenderer.js`, `GFBPolygonRenderer.js`    |
| Compute + render          | `H3FlexRenderer.js`                          |
| Instanced draw            | `TileRenderer.js`, `MercatorTileRenderer.js` |
| Data texture              | `GFBRenderer.js` (RGBA32F pos/vel textures)  |
| Non-rendering (data-only) | `MFBDataSource.js` + `MFBShards.js`          |
| Layer registration        | `LayerManager.js`                            |
| Filter integration        | `QueryParser.js`                             |
| Loader base class         | `loaders/ShardLoader.js`                     |
| Compression               | `util/compression.js` (maybeDecompress)      |
