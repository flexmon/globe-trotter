# Globe Trotter Utilities & Data Processing Scripts

This directory contains utility tools and synthetic data generators for **Globe Trotter**.

---

## 1. Synthetic Simulation Data Generator (`demo-sim`)

Generates synthetic 4D global datasets (GFB points/tracks, H3F cell demand grids, MFB metric time-series) for testing and demonstrating Globe Trotter.

```bash
# Generate full synthetic simulation dataset (GFB + H3F + MFB):
npm run generate

# Or run individual format generators:
npm run generate:gfb
npm run generate:h3
npm run generate:mfb
```

---

## 2. Parquet to Flex Converter (`parquet-to-flex.js`)

Batch converts Parquet files (local files or GCS bucket exports) into Globe Trotter's zero-copy binary formats (**H3Flex `.h3f`** or **GeoFlex `.gfb`**).

```bash
# Convert Parquet to H3Flex (H3 Hexagonal Grid):
node scripts/parquet-to-flex.js scripts/parquet-to-h3f-example.yaml

# Convert Parquet to GeoFlex (Vector Trajectories / 3D Moving Points):
node scripts/parquet-to-flex.js scripts/parquet-to-gfb-example.yaml

# Dry run (validate config & inspect schema mapping without writing files):
node scripts/parquet-to-flex.js scripts/parquet-to-h3f-example.yaml --dry-run
```

### Example Configurations

- **[parquet-to-h3f-example.yaml](./parquet-to-h3f-example.yaml)**: Template for H3 hex grid datasets.
- **[parquet-to-gfb-example.yaml](./parquet-to-gfb-example.yaml)**: Template for 3D trajectory and moving entity datasets.

---

## 3. Library Build Helper (`build-lib.js`)

Builds `@globe-trotter/core` into the `dist/globe-trotter/` bundle.

```bash
npm run build:lib
```
