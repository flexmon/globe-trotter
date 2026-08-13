# Globe Trotter — Agent Skills & Workflows

This `.agents` folder contains the AI skills for the **Globe Trotter** repository — the WebGPU 3D globe visualization engine and surrounding data ecosystem.

## What is Globe Trotter?

Globe Trotter is a high-performance 3D globe visualization library built on a **WebGPU-only** rendering backend (no WebGL2 fallback — unsupported browsers get a `WebGPURequiredError`). It consumes *Flex binary formats (H3F, GFB, MFB) from GCS via a streaming manifest system and renders billions of data points at interactive frame rates.

**Key capabilities:**

- WebGPU compute pipeline — no WebGL2 fallback path
- GPU compute shaders for histogram aggregation over 1.4M H3 cells
- Instanced tile rendering (single draw call for all visible tiles)
- Direct CPU→GPU texture writes (<1ms epoch transitions)
- Zero-stall shard swap via pre-uploaded spare texture pointer swap
- 0 bytes GC pressure per frame (pre-allocated uniform scratch buffers)
- Declarative YAML dataset and layer configuration
- FlexQL — custom zero-copy columnar SQL engine sharing typed arrays with the GPU

---

## 📚 Skills

### `globe-trotter-architecture`

**File:** [`skills/globe-trotter-architecture/SKILL.md`](./skills/globe-trotter-architecture/SKILL.md)

The **core render pipeline reference**. Covers the hybrid WebGL2+WebGPU dual-backend, GPU compute shaders, instanced tile rendering, camera and time systems, the filter engine, event system, and WGSL shader conventions.

**Use when:** Adding new renderer types, debugging frame rate issues, modifying the render loop, or understanding GPU resource ownership.

---

### `globe-trotter-performance`

**File:** [`skills/globe-trotter-performance/SKILL.md`](./skills/globe-trotter-performance/SKILL.md)

Performance tuning guide with active optimization patterns, WebGL2 vs. WebGPU benchmark comparisons, scaling limits, memory budgets, GPU resource lifecycle table, and a common issues troubleshooting matrix.

**Use when:** Investigating low FPS, scaling to larger datasets (100K+ features, 1M+ cells), profiling GPU/CPU bottlenecks, or planning memory budgets.

---

### `globe-trotter-yaml-config`

**File:** [`skills/globe-trotter-yaml-config/SKILL.md`](./skills/globe-trotter-yaml-config/SKILL.md)

Complete reference for `globe-config.yaml` — all layer types, style specs, camera, time, extrusion, basemap, charts, and UI widget configuration.

**Use when:** Adding or modifying dataset layers, configuring time playback, setting up charts, or customizing the globe's initial camera and basemap.

---

### `globe-trotter-styling`

**File:** [`skills/globe-trotter-styling/SKILL.md`](./skills/globe-trotter-styling/SKILL.md)

StyleEngine API — color ramps, categorical LUTs, opacity stops, compile/dispose lifecycle, GPU texture management, symbol types, and the symbology dialog.

**Use when:** Implementing custom color scales, modifying the symbology editor, or compiling style configurations to GPU textures.

---

### `globe-trotter-charting`

**File:** [`skills/globe-trotter-charting/SKILL.md`](./skills/globe-trotter-charting/SKILL.md)

GPU-accelerated chart system — chart types (heatmap, histogram, CDF, boxplot, barplot, time-series), YAML config, data adapter, shader architecture, overlay system, and `ChartManagerDialog`.

**Use when:** Adding new chart types, modifying chart rendering, debugging chart data adapters, or integrating charts with the globe's time system.

---

### `globe-trotter-custom-layers`

**File:** [`skills/globe-trotter-custom-layers/SKILL.md`](./skills/globe-trotter-custom-layers/SKILL.md)

Guide for creating custom renderer/layer types — WebGPU and WebGL2 renderer contracts, shader pairs, temporal interpolation, filter integration, and LayerManager registration.

**Use when:** Building a new layer type that doesn't fit H3F, GFB, or MFB patterns.

---

### `globe-trotter-data-pipeline`

**File:** [`skills/globe-trotter-data-pipeline/SKILL.md`](./skills/globe-trotter-data-pipeline/SKILL.md)

Data pipeline patterns for converting raw geospatial data into H3F, GFB, and MFB formats using the `@globe-trotter/data-sdk` TypeScript encoders.

**Use when:** Onboarding a new dataset, writing data ingestion scripts, or understanding the encoding path from raw source data to *Flex binary.

---

### `globe-trotter-bigquery-to-globe`

**File:** [`skills/globe-trotter-bigquery-to-globe/SKILL.md`](./skills/globe-trotter-bigquery-to-globe/SKILL.md)

End-to-end workflow for querying BigQuery data and visualizing it on the globe via H3F and GFB formats — from BQ SQL to live globe layer.

**Use when:** Visualizing BigQuery datasets on the globe without a full FlexStream pipeline.

---

### `globe-trotter-deploy`

**File:** [`skills/globe-trotter-deploy/SKILL.md`](./skills/globe-trotter-deploy/SKILL.md)

Deployment patterns — static hosting, GKE, CDN, shard serving, Mapbox token management, library builds, and production configuration.

**Use when:** Deploying a Globe Trotter app to production, configuring CDN caching, or building the library for external consumption.

---

### `h3f-virtual-layers`

**File:** [`skills/h3f-virtual-layers/SKILL.md`](./skills/h3f-virtual-layers/SKILL.md)

H3F Virtual Layer system — query-driven live H3 hexagonal aggregation via FlexDB SQL, mesh tile architecture, VirtualH3Loader pipeline, YAML configuration reference, and deployment requirements.

**Use when:** Adding or modifying virtual H3 layers that aggregate live data server-side via FlexDB.
