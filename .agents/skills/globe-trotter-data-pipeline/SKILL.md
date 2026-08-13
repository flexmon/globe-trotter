---
name: globe-trotter-data-pipeline
description: Data pipeline patterns for Globe Trotter — converting raw geospatial data into H3F, GFB, and MFB formats using the @globe-trotter/data-sdk encoders.
---

# Globe Trotter Data Pipeline

Patterns for transforming raw geospatial data into GPU-ready binary formats using the `@globe-trotter/data-sdk` encoders.

## When to use this skill

- Use this when building data generation scripts from any data source
- Use this when converting CSV, Parquet, BigQuery, or PostGIS data to binary
- Use this when deciding between H3F, GFB, and MFB for a dataset
- Use this when configuring sharding for large time-series datasets

## How to use it

### Data SDK — Preferred Encoding Method

Always use the SDK encoders from `@globe-trotter/data-sdk` instead of raw binary manipulation. The SDK handles header packing, schema encoding, dictionary writing, shard creation, gzip compression, and manifest generation.

```javascript
import {
  H3FlexEncoder,
  GeoFlexEncoder,
  MetricFlexEncoder,
} from '../../lib/packages/data-sdk/src/index.js';
```

| Encoder             | Format | Data Shape                              | Output                                    |
| ------------------- | ------ | --------------------------------------- | ----------------------------------------- |
| `H3FlexEncoder`     | `.h3f` | H3 hex cells + temporal metrics         | base + shards + manifest                  |
| `GeoFlexEncoder`    | `.gfb` | Moving points, lines, polygons          | base + shards + manifest                  |
| `MetricFlexEncoder` | `.mfb` | Geometry-free entity metrics for charts | base + shards + manifest (or single file) |

### Choosing the Right Format

| Data Type                      | Format          | Encoder                               | Example                          |
| ------------------------------ | --------------- | ------------------------------------- | -------------------------------- |
| Hexagonal heatmap (aggregated) | H3F             | `H3FlexEncoder`                       | Network supply, demand density   |
| Raw telemetry per H3 cell      | H3F (row-level) | `H3FlexEncoder` + `setRowLevelData()` | Subscriber flows, sensor data    |
| Moving points                  | GFB             | `GeoFlexEncoder`                      | Aircraft, ships, vehicles        |
| Static polylines               | GFB             | `GeoFlexEncoder`                      | Routes, boundaries               |
| Polygons/regions               | GFB             | `GeoFlexEncoder`                      | Coverage areas                   |
| Entity metrics (no geometry)   | MFB             | `MetricFlexEncoder`                   | Revenue, efficiency, utilization |

### Pipeline Steps

1. **Query/extract** raw data (SQL, CSV, API)
2. **Build data arrays** — `Float32Array` for metrics, `string[]` for categoricals
3. **Configure encoder** — set cells/features, columns, dictionary, style
4. **Call `encoder.encode()`** — SDK handles encoding, sharding, gzip, manifest
5. **Serve** via static files and reference from `globe-config.yaml`

### H3F Generation Pattern (Cell-Aggregated)

```javascript
import { cellToBoundary } from 'h3-js';
import { H3FlexEncoder } from '../../lib/packages/data-sdk/src/index.js';

const encoder = new H3FlexEncoder({
  epochInterval: 300,
  epochCount: 288,
  gzipLevel: 1,
});

encoder.setCells(cellIds, cellCenters);
encoder.addColumn('region', regionStrings); // string[] → dict_string32 / enum32
encoder.addColumn('demand_mbps', demandFloat32, { temporal: true }); // Float32Array
encoder.setStyle({/* color ramp spec */});

const { manifest, stats } = await encoder.encode({
  output: './public/data/my_dataset/',
  baseName: 'demand_metrics',
  cellToBoundary, // h3-js function — builds mesh if not in meshDir
  sharding: { epochsPerShard: 60 },
  meshDir: './public/meshes/', // Shared mesh directory — skips generation if exists
  meshLevel: 5, // H3 resolution → h3-l5-global.mesh.h3f.gz
});
```

> **Shared mesh**: The `meshDir` option tells the encoder to check for an existing `h3-l{level}-global.mesh.h3f.gz` file. If found, mesh generation is skipped (~2 min saved). If not, the mesh is generated and written there for future datasets. The manifest gets a relative path (e.g. `../../meshes/h3-l5-global.mesh.h3f.gz`). **Always pass `meshDir` and `meshLevel` for H3F datasets.**

### Post-Encoding: Tiled Mesh Generation (MANDATORY for H3F)

After `encoder.encode()`, **always** add this post-encoding step to generate tiled meshes and patch the manifest with `meshTiles`. This enables viewport-selective loading (15 tiles near camera first, rest in background). If tiles already exist, this is a no-op.

```javascript
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';

// ... after encoder.encode() ...

// Generate tiled meshes if they don't exist
const MESH_DIR = resolve(__dirname, '../../public/meshes');
const TILE_DIR = resolve(MESH_DIR, `h3-l${H3_RES}`);
const tileManifestPath = resolve(TILE_DIR, 'tiles.manifest.json');

if (!existsSync(tileManifestPath)) {
  const tileScript = resolve(__dirname, '../generate-mesh-tiles.js');
  execFileSync(process.execPath, [tileScript, '--level', String(H3_RES)], {
    stdio: 'inherit',
  });
}

// Patch manifest with meshTiles field
const manifestPath = resolve(OUTPUT_DIR, `${baseName}.manifest.json`);
const manifestData = JSON.parse(readFileSync(manifestPath, 'utf8'));
const meshTilesRef = `../../meshes/h3-l${H3_RES}/tiles.manifest.json`;
if (manifestData.meshTiles !== meshTilesRef) {
  manifestData.meshTiles = meshTilesRef;
  writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
}
```

> **Reference**: See `scripts/mobile-demand-sim/generate-h3-data.js` Step 9 for a complete working example. The centralized tile generator is at `scripts/generate-mesh-tiles.js` and supports `--level 0-7`.

### H3F Generation Pattern (Row-Level)

For raw data with N rows per cell (e.g. subscriber flows):

```javascript
const encoder = new H3FlexEncoder({ epochInterval: 60, epochCount: 0 });
encoder.setCells(uniqueCellIds, cellCenters);
encoder.setRowLevelData(cellIndex, rowCount); // Uint32Array[rowCount]
encoder.addColumn('fl_avg_flow_kbps', flowData); // Float32Array
encoder.addColumn('airline', airlineStrings); // string[] → dict_string32 / enum32
await encoder.encode({ output: './public/data/traffic/', baseName: 'shaper' });
```

See the `h3flex-format` skill for detailed binary layout, shared mesh architecture, tiled mesh format (H3M2), and the global base + per-epoch bin pattern.

### GFB Generation Pattern

```javascript
import { GeoFlexEncoder } from '../../lib/packages/data-sdk/src/index.js';

const encoder = new GeoFlexEncoder({
  featureCount: 50000,
  epochCount: 1440,
  epochInterval: 60,
  geometryType: 'point',
  hasAltitude: true,
});

// Dictionary + static columns
encoder.setDictionary(dictionary);
encoder.addStaticColumn('airline', 'enum32', airlineIndices);
encoder.addStaticColumn('tail_number', 'enum32', tailIndices);

// Temporal positions + attributes
encoder.setPositions(positionsFloat32); // Float32Array[epochs × features × 3]
encoder.setTemporalData('demand_mbps', demandFloat32); // Float32Array[epochs × features]

const { manifest, stats } = await encoder.encode({
  output: './public/data/fleet/',
  baseName: 'fleet_tracks',
  sharding: { epochsPerShard: 60, shardFormat: 'v3' },
});
```

> **Velocity columns**: For heading rotation, add `ewvelocity` and `nsvelocity` temporal columns via `setTemporalData()`. The point shader uses these for billboard rotation when `has_velocity` is enabled.

### MFB Generation Pattern

```javascript
import { MetricFlexEncoder } from '../../lib/packages/data-sdk/src/index.js';

const encoder = new MetricFlexEncoder({
  entityCount: 83000,
  epochCount: 1440,
  epochInterval: 60,
});

encoder.setEntityIds('tail_id', entityIdUint32);
encoder.addColumn('airline', airlineStrings); // string[] → dict_string32 / enum32
encoder.addColumn('revenue_usd', revenueFloat32, { temporal: true }); // Float32Array

const { manifest, stats } = await encoder.encode({
  output: './public/data/revenue/',
  baseName: 'airline_revenue',
  sharding: { epochsPerShard: 60 }, // Produces base + shards + manifest
});
```

> Without `sharding`, the SDK outputs a single `.mfb` file + manifest (`format: "mfb"`). With `sharding`, it produces base + shard files + manifest (`format: "mfb-v3-sharded"`).

### Sharding Strategy

Split datasets > 48 epochs into shards:

```
8 hours at 5-min epochs = 96 epochs → 2 shards of 48
24 hours at 5-min epochs = 288 epochs → 5 shards of 60
24 hours at 1-min epochs = 1440 epochs → 24 shards of 60
```

The SDK handles shard creation, naming, and manifest generation automatically via the `sharding` option.

### Coordinate Conventions

| Field          | Unit    | Range                  |
| -------------- | ------- | ---------------------- |
| Longitude      | degrees | -180 to 180            |
| Latitude       | degrees | -90 to 90              |
| Altitude       | feet    | 0 = sea level          |
| Epoch interval | seconds | Time between snapshots |

### Serving Data

Place generated files in `public/data/` and reference from `globe-config.yaml`:

```yaml
layers:
  - name: My Data
    type: h3f-sharded # h3f | h3f-sharded | gfb | gfb-sharded | mfb
    url: /data/my_data.manifest.json
    activeMetric: served_mbps # optional: default metric (v3)
```

> MFB layers use `type: mfb` — the engine auto-detects `mfb-v3-sharded` vs single-file from the manifest `format` field.

### Key Files

| Role                  | File                                                      |
| --------------------- | --------------------------------------------------------- |
| **SDK**               | `lib/packages/data-sdk/src/index.js`                      |
| **H3FlexEncoder**     | `lib/packages/data-sdk/src/encoders/H3FlexEncoder.js`     |
| **GeoFlexEncoder**    | `lib/packages/data-sdk/src/encoders/GeoFlexEncoder.js`    |
| **MetricFlexEncoder** | `lib/packages/data-sdk/src/encoders/MetricFlexEncoder.js` |
| **SDK Guide**         | `docs/data-sdk-guide.md`                                  |
| **SDK Architecture**  | `architecture/formats/data-sdk-architecture.md`           |
| H3 sim script         | `scripts/mobile-demand-sim/generate-h3-data.js`           |
| GFB sim script        | `scripts/mobile-demand-sim/generate-gfb-data.js`          |
| MFB sim script        | `scripts/mobile-demand-sim/generate-mfb-data.js`          |
| Flight plans          | `scripts/mobile-demand-sim/flight-plans.js`               |
