# Globe Trotter — Developer Documentation

> **Globe Trotter is agentic-first.** Every format spec, GPU pipeline, chart system, and deployment pattern is codified in [10 workspace agent skills](../.agents/skills/) — purpose-built for AI-accelerated development with [Google Antigravity](https://developers.google.com/antigravity). You don't need to read all these docs manually. Ask your AI assistant to build features, generate data pipelines, or debug shaders — the skills give it complete domain knowledge. See the [Antigravity Vibe Coding Guide](developers-guide-antigravity-vibe.md) to get started.
>
> **Updated 2026-06:** WebGPU-only. WebGL2 backend fully removed.

---

## Platform Components

```
┌────────────────────────────────────────────────────────────────────┐
│                        Globe Trotter Platform                      │
├──────────────────┬──────────────────────────────────────────────────┤
│   Applications   │             Shared Packages                      │
├──────────────────┼──────────────────────────────────────────────────┤
│ Globe Viewer     │ @globe-trotter/core                              │
│ (src/)           │ (lib/packages/core)                              │
│                  │                                                  │
│                  │ @globe-trotter/data-sdk                          │
│                  │ (lib/packages/data-sdk)                          │
├──────────────────┴──────────────────────────────────────────────────┤
│              Binary Data Formats: H3F · GFB · MFB                   │
└────────────────────────────────────────────────────────────────────┘
```

| Component                   | Description                                              | README                          |
| --------------------------- | -------------------------------------------------------- | ------------------------------- |
| **Globe Viewer**            | YAML-driven 4D globe application — WebGPU-powered        | [Root README](../README.md)     |
| **@globe-trotter/core**     | Engine library — renderers, styles, charts, camera, time | [Core Lib API](core-lib-api.md) |
| **@globe-trotter/data-sdk** | Encoders for generating H3F, GFB, MFB binary data        | [Data SDK Guide](data-sdk-guide.md) |

---

## Developer Guides

### Getting Started

| Guide                                                                     | What You'll Learn                                                                |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [**Developer's Guide**](developers-guide.md)                              | Installation, data formats, YAML configuration, Engine API, styling, GPU filters |
| [**Data SDK Guide**](data-sdk-guide.md)                                   | Generating H3F, GFB, MFB binary data from any source                             |
| [**Antigravity Vibe Coding Guide**](developers-guide-antigravity-vibe.md) | AI-accelerated development — skills, prompts, `/create-dataset` workflow         |

### API Reference

| Reference                       | Scope                                                |
| ------------------------------- | ---------------------------------------------------- |
| [**Core Library API**](core-lib-api.md) | `GlobeTrotterEngine`, `StyleEngine`, events, exports |

### Architecture

Deep-dive technical documents for contributors and advanced users.

| Document                                                                                                                         | Topic                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [Library Architecture](../architecture/globe-trotter/library-architecture.md)                                                    | Render pipeline, module graph, filter system      |
| [App Architecture](../architecture/globe-trotter/app-architecture.md)                                                            | YAML boot sequence, URL parameters                |
| [H3Flex Binary Architecture](https://github.com/flexmon/flex-format/blob/main/architecture/h3flex-binary-architecture.md)         | H3F wire format, temporal sharding, GPU rendering |
| [GeoFlex Binary Architecture](https://github.com/flexmon/flex-format/blob/main/architecture/geoflex-binary-architecture.md)       | GFB vector format, pre-triangulation              |
| [MetricFlex Binary Architecture](https://github.com/flexmon/flex-format/blob/main/architecture/metricflex-binary-architecture.md) | MFB columnar format, entity tracking              |
| [GPU Chart Architecture](../architecture/globe-trotter/gpu-chart-architecture.md)                                                | Chart types, data adapter, overlay system         |
| [Cartographic Styling](../architecture/globe-trotter/cartographic-style-architecture.md)                                         | Color ramps, categorical LUTs, GPU textures       |
| [Data Hosting](../architecture/globe-trotter/data-hosting-architecture.md)                                                       | CDN + GCS, cost analysis                          |
| [Temporal Mensuration](https://github.com/flexmon/flex-format/blob/main/architecture/temporal-mensuration.md)                     | Epoch interpolation, time controllers             |
| [Geodetic Coordinates](../architecture/globe-trotter/geodetic-coordinate-system.md)                                              | WGS84, altitude scaling, co-registration          |
| [Format Cost Comparison](https://github.com/flexmon/flex-format/blob/main/architecture/format-cost-comparison.md)                 | *Flex vs GeoJSON/Parquet/Shapefile sizing         |

---

## Agentic-First Development

Globe Trotter is designed to be **extended through conversation, not configuration**. The embedded workspace agent skills give AI assistants deep domain knowledge across the entire platform:

| Skill Area  | Skills                                                           | What They Enable                            |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------- |
| **Engine**  | `globe-trotter-architecture`, `globe-trotter-custom-layers`      | Build custom renderers, extend the pipeline |
| **Styling** | `globe-trotter-styling`, `globe-trotter-charting`                | Create styles, charts, symbology            |
| **Data**    | `globe-trotter-data-pipeline`, `globe-trotter-bigquery-to-globe` | End-to-end data generation pipelines        |
| **Config**  | `globe-trotter-yaml-config`                                      | YAML config reference                       |
| **Ops**     | `globe-trotter-deploy`, `globe-trotter-performance`              | Deployment, CDN, GPU profiling              |

**Example:** To add a new dataset, simply tell your AI assistant:

```
/create-dataset
I have a CSV with lat, lon, temperature columns at hourly intervals.
Visualize as a sharded H3F heatmap with a blue-white-red diverging ramp.
```

The agent reads the relevant skills, generates the data pipeline, writes the YAML config, and serves it — no manual documentation reading required.

---

## Quick Links

- [Root README](../README.md) — Quickstart, project structure, demo
- [Examples](../examples/) — Vanilla, Vue 3, React starter apps
- [Data Generators](../scripts/mobile-demand-sim/) — H3F, GFB, MFB generation scripts
