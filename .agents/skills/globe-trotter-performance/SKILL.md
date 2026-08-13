---
name: globe-trotter-performance
description: Performance tuning guide for Globe Trotter — WebGPU profiling, GPU compute optimizations, memory budgeting, and scaling limits.
---

# Globe Trotter Performance Guide

**Updated 2026-06**: The engine is WebGPU-only. Performance characteristics assume WebGPU is available; on unsupported browsers the engine throws `WebGPURequiredError`.

**Updated 2026-07**: Corrected the H3 texture model (2 ping-pong data textures + 1 filter, **no spare/pre-upload textures**) and removed the standalone `FlightRenderer` (aircraft now render via the GFB point path). GFB point interpolation uses 4 position textures with `slerp`/`catmullRom`.

Patterns and limits for achieving high FPS with large datasets using WebGPU.

## When to use this skill

- Use this when investigating low FPS or frame drops
- Use this when scaling to larger datasets (100K+ features, 1M+ cells)
- Use this when profiling GPU or CPU bottlenecks
- Use this when planning memory budgets for production deployments

## How to use it

### Active Optimization Patterns

#### WebGPU Core

1. **Direct CPU→texture epoch writes** — `H3FlexRenderer` writes only the 1–2 epochs needed per frame directly to R32F textures via `queue.writeTexture()` (~5.7MB each). **No storage buffer in the hot path**
2. **GPU histogram compute** — `histogram_reduce.wgsl` bins 1.4M cells via `atomicAdd` on GPU. Creates a temporary single-epoch storage buffer on demand, destroys after readback. Falls back to CPU when filters are active
3. **Instanced tile rendering** — `TileRenderer` renders all visible tiles in a **single `drawIndexedInstanced()`** call using a 256-layer texture 2D array + storage buffer for tile bounds. **Replaces** ~150 per-tile draw calls
4. **Pre-allocated uniform scratch buffers** — `H3FlexRenderer.render()` and `TileRenderer.render()` reuse pre-allocated `ArrayBuffer` + typed-array views for per-frame uniform writes (zero GC pressure, eliminates ~500KB/sec allocation)
5. **Histogram domain caching** — CPU min/max scan of 1.4M cells cached for adjacent epochs (±1). Only rescans when epoch jumps >1
6. **State-free on-demand textures** — H3 uses 2 ping-pong R32F textures (`_texCurrent`/`_texNext`, i.e. `dataTexA`/`dataTexB`), overwritten per epoch via direct `writeTexture()` — **no spare textures or pre-upload queue**. Shard transitions rely on zero-copy boundary-epoch extraction (see #7), not pre-uploaded spares
7. **Zero-copy boundary extension (GFB)** — boundary epoch uses `subarray` reference instead of allocating+copying the full positions array (~18MB saved per boundary extend)
8. **Visible tile list caching** — `TileManager.js` skips tile selection when camera is stationary
9. **GPU point interpolation** — `GFBRenderer.js` uses 4 RGBA32F position textures (prev/current/next/next2); the vertex shader does great-circle `slerp_unit()` + 4-point `catmullRom()` interpolation (zero CPU interpolation)

#### General Patterns

10. **GPU-first ramp updates** — `LayerManager.updateLayerRamp()` recompiles color stops into 256×1 RGBA texture. Cost: ~0.1ms CPU + 1 KB GPU upload. No shader recompile
11. **GPU filter pipeline** — Fragment shader evaluates ≤2 predicates with AND/OR combinator. Zero per-frame CPU cost
12. **Aircraft/flights via GFB points** — there is no separate flight renderer; aircraft data renders through the GFB point path (#9) as instanced billboards
13. **dt capping** — `TimeController` caps `dt` to 100ms to prevent time jumps from long frames or tab switches
14. **ChartDataAdapter caching** — Heatmap grid cached by shard key, CDF in-place sort on scratch buffer, BarPlot pre-allocated typed arrays
15. **Chart label scratch reuse** — `ChartManager._labelScratch` array reused per frame (zero GC per frame)
16. **Zero-alloc histogram** — `ChartDataAdapter.getHistogram()` returns `Uint32Array.subarray()` — zero heap allocation
17. **DPR-aware chart labels** — `ChartLabelRenderer` multiplies `fontSize` by `devicePixelRatio` for correct sizing on high-DPI screens
18. **Layer manager loop optimization** — `prepareH3Compute()` merges shard-dirty + compute dispatch into 2 loops (minimum required: effectiveTime depends on all loaders updating first)

### Performance Characteristics

| Metric                 | WebGPU            | Notes                                                       |
| ---------------------- | ----------------- | ----------------------------------------------------------- |
| Tile draw calls/frame  | **1** (instanced) | 256-layer texture 2D array                                  |
| H3 epoch transition    | **~1ms**          | Direct write ~5.7MB via `queue.writeTexture()`              |
| Shard swap stall       | **~1ms**          | Zero-copy boundary-epoch extraction; no bulk upload at swap |
| Histogram (1.4M cells) | **<0.1ms** GPU    | Async, temp buffer; CPU fallback when filtered              |
| Per-frame GC pressure  | **0 bytes**       | Pre-allocated scratch buffers                               |

### Profiling with DevTools

1. Open Chrome DevTools → Performance tab
2. Record ~5 seconds of playback
3. Look for frame time > 16.6ms, long GPU tasks, GC events
4. Use `chrome://gpu/` to verify WebGPU adapter info
5. Check `engine.capabilities = { webgpu }` in console

### Video Recording

`TimePanel._startRecording()` captures the canvas stream via `MediaRecorder` API. Records at native resolution and frame rate, outputs WebM.

### Scaling Limits

| Resource              | Limit | Notes                                        |
| --------------------- | ----- | -------------------------------------------- |
| H3 cells              | ~1.5M | R32F texture size constraint                 |
| GFB features          | ~100K | RGBA32F texture upload on epoch change only  |
| Cached tiles          | 2000  | Configurable `maxCachedTiles`                |
| Tile array layers     | 256   | WebGPU texture 2D array limit (LRU recycled) |
| Concurrent tile loads | 24    | Configurable `maxConcurrent`                 |
| Epochs per shard      | 48–96 | Memory: cells × epochs × 4 bytes             |
| GPU filter predicates | 2     | AND or OR combinator in shader               |
| Histogram bins        | 256   | GPU compute buffer limit                     |

### Memory Budget (typical dataset)

```
H3 data textures:    3 × 1,225² × 4B  ≈ 18 MB GPU (2 data A/B + 1 filter)
H3 mesh:             positions+indices  ≈ 80 MB GPU (grows progressively with tile loading)
H3 direct write buf: 1,225² × 4B       ≈ 6 MB CPU (scratch, reused)
H3 histogram buffers: uniform+output+staging ≈ 2 KB GPU (temp buf: ~5.7MB, created/destroyed per histogram)
GFB VBOs:            2 × 20K × 12B     ≈ 0.5 MB GPU
GFB point textures:  6 × 317² × 16B  ≈ 10 MB GPU (4 pos for Catmull-Rom + 2 velocity; points datasets only)
Tile texture array:   256 × 512² × 4B  ≈ 256 MB GPU (2D array, LRU-managed)
Color ramp textures:  ~5 × 256×1 × 4B  ≈ 5 KB GPU
Chart GPU resources:  ~6 × (VBO+VAO+program+atlas) ≈ 100 KB GPU
Uniform scratch:      192B (H3) + 8KB (tiles) ≈ 8 KB CPU (pre-allocated, reused)
Total GPU:                                   ≈ 370 MB GPU (dominated by tile array + H3 mesh)
```

### GPU Resource Lifecycle

All GPU resources are properly disposed on layer remove / engine destroy:

| Resource                             | Created In                         | Destroyed In                                    |
| ------------------------------------ | ---------------------------------- | ----------------------------------------------- |
| H3 data textures (A/B)               | `_buildDataTextures()`             | `dispose()`                                     |
| H3 filter texture                    | `_buildDataTextures()`             | `dispose()`                                     |
| GFB pos/vel textures (A–D + vel A/B) | `_buildDataTextures()` (GFB)       | `dispose()`; rebuilt on feature-count grow      |
| H3 histogram buffers                 | `_buildHistogramPipeline()`        | `dispose()`                                     |
| H3 direct write buffer               | `_directWriteToTex()` (lazy)       | `dispose()` (nulled for GC)                     |
| Histogram temp storage               | `computeHistogram()` (on-demand)   | `computeHistogram()` (destroyed after readback) |
| Tile texture array                   | `_buildPipeline()`                 | `dispose()`                                     |
| Tile data buffer                     | `_buildPipeline()`                 | `dispose()`                                     |
| Style ramp texture                   | `StyleEngine.compileGPU()`         | `style.disposeGPU()`                            |
| Chart label atlas                    | `ChartLabelRenderer._buildAtlas()` | `dispose()`                                     |

### Common Issues

| Symptom                     | Cause                      | Fix                                                                                                                                                      |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low FPS during orbit        | Tile projection recalc     | Verify caching is active in `TileManager`                                                                                                                |
| FPS drop at epoch boundary  | Texture upload stall       | WebGPU uses direct writes (~5.7MB, <1ms); check for other bottlenecks                                                                                    |
| Shard swap stall            | Missing boundary epoch     | Shard transitions use zero-copy boundary-epoch extraction; ensure `_boundaryEpochs` / `_boundaryPackedPositions` are populated for the styling attribute |
| Memory growth               | Undisposed GPU resources   | Check `dispose()` calls; null CPU buffers for GC                                                                                                         |
| Memory growth from charts   | LabelRenderer not disposed | Verify `removeChart()` calls `labelRenderer.dispose()`                                                                                                   |
| Slow initial load           | Large base file            | Use sharding + tiled mesh (`meshTiles` in manifest) for viewport-selective loading                                                                       |
| Filter causes flicker       | Full style recompile       | Use `updateLayerRamp()` instead of `setLayerStyle()`                                                                                                     |
| Time jumps after tab switch | Uncapped dt                | TimeController caps dt to 100ms                                                                                                                          |
| Labels too small on laptop  | DPR not applied            | Verify `ChartLabelRenderer.setLabels()` multiplies fontSize by dpr                                                                                       |
