# Globe Trotter — Architecture Documentation

Welcome to the Globe Trotter architecture! This documentation is structured as a **Zero-Copy Learning Path**, designed to logically walk you from the core philosophies, through the data structures, across the high-throughput backend, and into the 60FPS web client.

> **Core Philosophy**: Globe Trotter is built entirely around an end-to-end "Zero-Copy" architecture. Data flows from Kafka to the GPU textures with minimal serialization penalties. This means bypassing traditional JSON strings or garbage-collected JavaScript objects whenever possible.

---

## The Zero-Copy Learning Path

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                            Data Sources                                 │
│                      BigQuery  ·  Static Files                          │
└────────────────────────────┬────────────────────┬───────────────────────┘
                             │                    │
                    ┌────────▼──────┐      ┌──────▼──────┐
                    │   Data SDK    │      │  Manual ETL │
                    │   Node.js     │      │  Python/BQ  │
                    │   →*Flex bin  │      │  →*Flex bin │
                    └────────┬──────┘      └──────┬──────┘
                             └────────────────────┘
                                 │
                        ┌────────▼────────┐
                        │  GCS Bucket     │
                        │  SHD3 Binaries  │
                        │ (Range Queries) │
                        └────────┬────────┘
                                 │
                    ┌────────────▼────────────┐
                    │       Cloud CDN          │
                    │      (File Edge)         │
                    └────────────┬────────────┘
                                 │
            ┌────────────────────▼────────────────────┐
            │         Globe Trotter Web Client          │
            │  WebGPU · GPU Charts                      │
            │  (Native Typed Arrays mapped to Textures) │
            └───────────────────────────────────────────┘
```

---

### Phase 1: Storage & Data Engine (*Flex / SHD3)

At the heart of Globe Trotter are the bespoke file formats which replace generic GeoJSON/Parquet.

**The Unified V3 Format (SHD3)** guarantees that analytical clients can execute "Selective Fetching" via HTTP Range requests—loading only the required bytes (columns/epochs) into memory without downloading the entire shard.

| Document                                                                                                                            | Description                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [h3flex-binary-architecture.md](https://github.com/flexmon/flex-format/blob/main/architecture/h3flex-binary-architecture.md)         | **H3F**: Hexagonal heatmaps — geometry once, epoch values only |
| [geoflex-binary-architecture.md](https://github.com/flexmon/flex-format/blob/main/architecture/geoflex-binary-architecture.md)       | **GFB**: Points, lines, polygons — pre-triangulated            |
| [metricflex-binary-architecture.md](https://github.com/flexmon/flex-format/blob/main/architecture/metricflex-binary-architecture.md) | **MFB**: Charts, tables, metrics — geometry-free               |
| [temporal-mensuration.md](https://github.com/flexmon/flex-format/blob/main/architecture/temporal-mensuration.md)                     | Temporal extension for GFB & H3F — epoch-major layout          |
| [format-cost-comparison.md](https://github.com/flexmon/flex-format/blob/main/architecture/format-cost-comparison.md)                 | *Flex vs GeoJSON, GeoParquet, Shapefile, etc.                  |
| [competitive-format-landscape.md](https://github.com/flexmon/flex-format/blob/main/architecture/competitive-format-landscape.md)     | *Flex vs all geospatial + time-series formats                  |
| [formats/data-sdk-architecture.md](formats/data-sdk-architecture.md)                                                                | `@globe-trotter/data-sdk` encoders                             |

---

### Phase 2: Web Client Visualization

The web application leverages a WebGPU pipeline to map the remote data arrays directly to visual charts and geographic layers. Charts render on a separate transparent WebGPU overlay canvas that shares the engine's GPUDevice.

| Document                                                                                             | Description                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [globe-trotter/library-architecture.md](globe-trotter/library-architecture.md)                       | `@globe-trotter/core` — WebGPU-only renderer, data, styles, widgets |
| [globe-trotter/app-architecture.md](globe-trotter/app-architecture.md)                               | Vite SPA managing the zero-copy pipeline handoffs                   |
| [globe-trotter/gpu-chart-architecture.md](globe-trotter/gpu-chart-architecture.md)                   | GPU-accelerated 2D charts on WebGPU second pass                     |
| [globe-trotter/cartographic-style-architecture.md](globe-trotter/cartographic-style-architecture.md) | StyleEngine — declarative specs → GPU textures                      |

---

### Product Comparisons

Deep-dive analysis of how Globe Trotter's purpose-built engines compare to industry-standard alternatives.

| Document                                                                                                           | Description                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [product-comparisons/globe-trotter-product-comparison.md](product-comparisons/globe-trotter-product-comparison.md) | Globe Trotter vs CesiumJS/ArcGIS/Deck.gl — zero-copy GPU pipeline, < 1ms epoch transitions, 60 FPS at 1.4M cells |

---

### Cost Comparisons

Per-component cost analysis comparing Globe Trotter's architecture costs against traditional infrastructure alternatives.

| Document                                                                             | Description                                                                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [cost-comparisons/flex-cost-comparison.md](cost-comparisons/flex-cost-comparison.md) | Full-stack cost comparison — visualization (344× cheaper) and streaming pipeline (40× cheaper) |

---

### Advanced Operations & Economics

| Document                                                                                 | Description                                         |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [globe-trotter/data-hosting-architecture.md](globe-trotter/data-hosting-architecture.md) | Private CDN — GCS + Cloud CDN + IAP                 |
| [monitoring/monitoring-architecture.md](monitoring/monitoring-architecture.md)           | Observability — Grafana, Prometheus, alerting rules |
