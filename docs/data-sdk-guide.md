# Data SDK Developer Guide

Generate GPU-ready binary data for Globe Trotter from any dataset using the `@globe-trotter/data-sdk` encoders.

## Quick Start

```javascript
import { H3FlexEncoder, GeoFlexEncoder, MetricFlexEncoder } from '@globe-trotter/data-sdk';
```

---

## H3Flex — Hexagonal Heatmaps

Use `H3FlexEncoder` when your data maps to H3 hexagonal cells with temporal metrics (e.g., network demand, sensor readings, population density).

### Example: H3 Heatmap from Custom Data

```javascript
import { cellToBoundary } from 'h3-js';
import { H3FlexEncoder } from '@globe-trotter/data-sdk';

const encoder = new H3FlexEncoder({
  epochInterval: 300, // 5-minute intervals
  epochCount: 288, // 24 hours
  gzipLevel: 1,
});

// 1. Set cells (H3 IDs + lat/lon centers)
encoder.setCells(cellIds, cellCenters); // string[], [lat,lon][]

// 2. Add columns — type is auto-detected, strings auto-build dictionary
encoder.addColumn('region', ['NA', 'EU', 'APAC', 'NA' /* ... per cell */]);

// 3. Add temporal data
encoder.addColumn('temperature_c', temperatureData, { temporal: true }); // Float32Array

// 4. Set embedded style (optional)
encoder.setStyle({
  format: 'h3flex',
  version: 1,
  layers: [
    {
      id: 'temp',
      attribute: 'temperature_c',
      style: {
        type: 'color-ramp',
        domain: [-20, 40],
        stops: [
          { value: -20, color: '#0000FF' },
          { value: 0, color: '#00FFFF' },
          { value: 20, color: '#00FF00' },
          { value: 40, color: '#FF0000' },
        ],
      },
    },
  ],
});

// 5. Encode — builds mesh, writes base + shards + manifest
const { manifest, stats } = await encoder.encode({
  output: './public/data/temperature/',
  baseName: 'temperature',
  cellToBoundary, // pass h3-js function
  encoding: 'auto', // auto-detect sparse vs RLE
  sharding: { epochsPerShard: 48 },
});

console.log(`Generated ${stats.cellCount} cells, ${stats.shardCount} shards`);
```

### CLI Flags

The H3 generator scripts support:

- `--rle` — Force RLE shard encoding
- `--sparse` — Force sparse shard encoding
- (default) — Auto-detect based on temporal data patterns

---

## GeoFlex — Vector Features

Use `GeoFlexEncoder` for moving points (aircraft, ships, vehicles), static polylines, or polygons.

### Example: Fleet Tracking

```javascript
import { GeoFlexEncoder } from '@globe-trotter/data-sdk';

const encoder = new GeoFlexEncoder({
  featureCount: 50000,
  epochCount: 1440, // 24h at 1-min intervals
  epochInterval: 60,
  geometryType: 'point',
  hasAltitude: true,
});

// 1. Dictionary + static columns
encoder.setDictionary(dictionary); // string[]
encoder.addStaticColumn('company', 'enum16', companyIndices); // Uint16Array
encoder.addStaticColumn('vehicle_id', 'enum16', vehicleIndices); // Uint16Array

// 2. Set temporal positions (epoch-major, 3 floats per feature: lon, lat, alt)
encoder.setPositions(positionsFloat32); // Float32Array[epochCount × featureCount × 3]

// 3. Temporal attributes (optional)
encoder.setTemporalData('speed_kph', speedData); // Float32Array[epochCount × featureCount]

// 4. Encode
const { manifest, stats } = await encoder.encode({
  output: './public/data/fleet/',
  baseName: 'fleet_tracks',
  sharding: { epochsPerShard: 60 },
});
```

---

## MetricFlex — Entity Metrics

Use `MetricFlexEncoder` for geometry-free data tied to entities (e.g., per-airline revenue, per-sensor readings for charts/tables).

### Example: Revenue Metrics

```javascript
import { MetricFlexEncoder } from '@globe-trotter/data-sdk';

const encoder = new MetricFlexEncoder({
  entityCount: 83000,
  epochCount: 1440,
  epochInterval: 60,
});

// 1. Set entity IDs
encoder.setEntityIds('vehicle_id', vehicleIdUint32);

// 2. Add columns — strings auto-build dictionary, temporal auto-routes
encoder.addColumn('company', companyStrings); // string[] → auto enum
encoder.addColumn('revenue_usd', revenueFloat32, { temporal: true }); // Float32Array → temporal F32

// 4. Encode
const { manifest, stats } = await encoder.encode({
  output: './public/data/revenue/',
  baseName: 'company_revenue',
  sharding: { epochsPerShard: 60 }, // optional: base + shards + manifest
});
```

> Without `sharding`, the SDK outputs a single `.mfb` file + manifest. With `sharding`, it produces base + shard files + manifest (`format: "metricflex-sharded"`).

---

## Format Selection Guide

| Data Shape                               | Format | Encoder             |
| ---------------------------------------- | ------ | ------------------- |
| H3 hexagonal cells with temporal metrics | `.h3f` | `H3FlexEncoder`     |
| Moving points (lat/lon/alt over time)    | `.gfb` | `GeoFlexEncoder`    |
| Static polylines or polygons             | `.gfb` | `GeoFlexEncoder`    |
| Per-entity metrics for charts/tables     | `.mfb` | `MetricFlexEncoder` |
| Entity time-series (no geometry)         | `.mfb` | `MetricFlexEncoder` |

## Encoding Selection Guide

| Data Pattern                                    | Best Encoding | Example                       |
| ----------------------------------------------- | ------------- | ----------------------------- |
| Values change every epoch (dynamic)             | Sparse        | Real-time sensor readings     |
| Values constant for many epochs (slow-changing) | RLE           | Monthly population data       |
| Unknown                                         | Auto          | Let `detectEncoding()` decide |

## Sharding Strategy

Split temporal data into shards when you have many epochs:

| Duration | Interval | Epochs | Recommended Shard Size      |
| -------- | -------- | ------ | --------------------------- |
| 8 hours  | 5 min    | 96     | 48 epochs/shard (2 shards)  |
| 24 hours | 1 min    | 1440   | 60 epochs/shard (24 shards) |
| 30 days  | 15 min   | 2880   | 48 epochs/shard (60 shards) |

The SDK handles shard creation, naming, and manifest generation automatically.

## Integration with globe-config.yaml

After generating data, reference it in your config:

```yaml
layers:
  - name: My Heatmap
    type: h3f-sharded
    url: /data/temperature/temperature.manifest.json
    activeMetric: temperature_c

  - name: Fleet Tracks
    type: gfb-sharded
    url: /data/fleet/fleet_tracks.manifest.json

  - name: Revenue Metrics
    type: mfb
    url: /data/revenue/company_revenue.manifest.json
```
