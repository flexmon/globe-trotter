#!/usr/bin/env node
/**
 * parquet-to-flex.js — Batch conversion tool: Parquet → H3Flex (H3F) or GeoFlex (GFB).
 *
 * Reads Parquet files from a local directory or GCS bucket, maps columns
 * defined in a YAML config, and produces either:
 *   • H3F output (base + temporal shards + manifest) via H3FlexEncoder
 *   • GFB output (base + temporal shards + manifest) via GeoFlexEncoder
 *
 * The output format is controlled by the `geometry.type` field in the config
 * (either "h3f" or "gfb"). Legacy configs using the `h3:` key are supported
 * as a backwards-compatible alias for `geometry.type: h3f`.
 *
 * Requires: parquet-wasm, apache-arrow, h3-js, yaml, @google-cloud/storage
 *   (all present in package.json devDependencies / dependencies)
 *
 * Usage:
 *   node scripts/parquet-to-flex.js <config.yaml> [options]
 *   node --max-old-space-size=8192 scripts/parquet-to-flex.js <config.yaml>
 *
 * Options:
 *   --dry-run      Parse config and show plan without reading/writing files
 *   --keep-tmp     Keep the temporary GCS download directory on exit
 *   --no-mesh      Skip mesh generation for H3F output (base file only)
 *
 * Config file format: see scripts/parquet-to-flex-example.yaml
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import initWasm, { readParquet } from 'parquet-wasm/esm';
import { tableFromIPC } from 'apache-arrow';
import { cellToLatLng, cellToBoundary } from 'h3-js';
import { H3FlexEncoder, GeoFlexEncoder } from '../lib/packages/data-sdk/src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI argument parsing ───────────────────────────────────────────────────

const args = process.argv.slice(2);
const configPath = args.find((a) => !a.startsWith('--'));

if (!configPath) {
  console.error('Usage: node scripts/parquet-to-flex.js <config.yaml> [options]');
  console.error('');
  console.error('Options:');
  console.error('  --dry-run      Show plan without reading or writing files');
  console.error('  --keep-tmp     Keep the temporary GCS download directory on exit');
  console.error('  --no-mesh      Skip mesh generation (H3F only)');
  console.error('');
  console.error('Config Examples:');
  console.error(
    '  H3Flex (grid):  node scripts/parquet-to-flex.js scripts/parquet-to-h3f-example.yaml'
  );
  console.error(
    '  GeoFlex (tracks): node scripts/parquet-to-flex.js scripts/parquet-to-gfb-example.yaml'
  );
  process.exit(1);
}

const FLAG_DRY_RUN = args.includes('--dry-run');
const FLAG_KEEP_TMP = args.includes('--keep-tmp');
const FLAG_NO_MESH = args.includes('--no-mesh');

// ─── Config loading ──────────────────────────────────────────────────────────

function loadConfig(path) {
  const absPath = resolve(process.cwd(), path);
  if (!existsSync(absPath)) {
    console.error(`ERROR: Config file not found: ${absPath}`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = parseYaml(readFileSync(absPath, 'utf8'));
  } catch (e) {
    console.error(`ERROR: Failed to parse YAML config: ${e.message}`);
    process.exit(1);
  }

  // ── Legacy compat: `h3:` key → `geometry: { type: 'h3f', ... }` ──
  if (!cfg.geometry && cfg.h3) {
    cfg.geometry = {
      type: 'h3f',
      cell_column: cfg.h3.cell_column,
      resolution: cfg.h3.resolution,
    };
  }

  return cfg;
}

// ─── Config validation ───────────────────────────────────────────────────────

function validateConfig(cfg) {
  const errors = [];

  if (!cfg.source?.path) errors.push('source.path is required');
  if (!cfg.output?.path) errors.push('output.path is required');
  if (!cfg.geometry?.type) errors.push('geometry.type is required ("h3f" or "gfb")');

  const geomType = cfg.geometry?.type;

  if (geomType === 'h3f') {
    if (!cfg.geometry.cell_column) errors.push('geometry.cell_column is required for type h3f');
  } else if (geomType === 'gfb') {
    if (!cfg.geometry.longitude_column)
      errors.push('geometry.longitude_column is required for type gfb');
    if (!cfg.geometry.latitude_column)
      errors.push('geometry.latitude_column is required for type gfb');
    const hasTemporalCols = (cfg.columns?.temporal?.length ?? 0) > 0;
    if (hasTemporalCols && !cfg.geometry.entity_column) {
      errors.push(
        'geometry.entity_column is required for type gfb when columns.temporal is specified'
      );
    }
  } else if (geomType) {
    errors.push(`geometry.type must be "h3f" or "gfb", got: "${geomType}"`);
  }

  const hasTemporalCols = (cfg.columns?.temporal?.length ?? 0) > 0;
  if (hasTemporalCols && !cfg.time?.epoch_column) {
    errors.push('time.epoch_column is required when columns.temporal is specified');
  }
  if (hasTemporalCols && !cfg.time?.epoch_interval) {
    errors.push('time.epoch_interval (seconds) is required when columns.temporal is specified');
  }

  const allCols = [...(cfg.columns?.static ?? []), ...(cfg.columns?.temporal ?? [])];
  for (const col of allCols) {
    if (!col.source)
      errors.push(`Column entry missing required 'source' field: ${JSON.stringify(col)}`);
  }

  if (errors.length > 0) {
    console.error('Config validation errors:');
    for (const e of errors) console.error(`  • ${e}`);
    process.exit(1);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Output name for a column: prefer col.output, fall back to col.source */
function colOutputName(col) {
  return col.output ?? col.source;
}

/** All source column names needed from Parquet (deduped) */
function requiredParquetColumns(cfg) {
  const cols = new Set();
  const geomType = cfg.geometry.type;

  if (geomType === 'h3f') {
    cols.add(cfg.geometry.cell_column);
  } else {
    cols.add(cfg.geometry.longitude_column);
    cols.add(cfg.geometry.latitude_column);
    if (cfg.geometry.altitude_column) cols.add(cfg.geometry.altitude_column);
    if (cfg.geometry.entity_column) cols.add(cfg.geometry.entity_column);
  }

  if (cfg.time?.epoch_column) cols.add(cfg.time.epoch_column);
  if (cfg.time?.start_timestamp_column) cols.add(cfg.time.start_timestamp_column);

  for (const col of cfg.columns?.static ?? []) cols.add(col.source);
  for (const col of cfg.columns?.temporal ?? []) cols.add(col.source);

  return [...cols];
}

// ─── GCS download ───────────────────────────────────────────────────────────

/**
 * Download all Parquet files matching a GCS prefix to a local temp directory.
 * Returns { localDir, files: string[] } — caller is responsible for cleanup.
 */
async function downloadFromGcs(gcsPath, concurrency = 5) {
  const match = gcsPath.match(/^gs:\/\/([^/]+)\/(.*)/);
  if (!match) {
    console.error(`ERROR: Invalid GCS path (expected gs://bucket/prefix): ${gcsPath}`);
    process.exit(1);
  }
  const bucketName = match[1];
  const prefix = match[2].replace(/\/$/, '') + '/';

  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  console.log(`  Listing GCS objects: gs://${bucketName}/${prefix}`);
  const [allFiles] = await bucket.getFiles({ prefix });
  const parquetFiles = allFiles.filter((f) => f.name.endsWith('.parquet'));

  if (parquetFiles.length === 0) {
    console.error(`ERROR: No .parquet files found at gs://${bucketName}/${prefix}`);
    process.exit(1);
  }

  const localDir = join(tmpdir(), `parquet-to-flex-${Date.now()}`);
  mkdirSync(localDir, { recursive: true });

  console.log(`  Downloading ${parquetFiles.length} Parquet files → ${localDir}`);
  console.log(`  Concurrency: ${concurrency}`);

  let downloaded = 0;
  let totalBytes = 0;
  const t0 = performance.now();

  for (let i = 0; i < parquetFiles.length; i += concurrency) {
    const batch = parquetFiles.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (file) => {
        const localPath = join(localDir, file.name.split('/').pop());
        await file.download({ destination: localPath });
        return Number(file.metadata?.size ?? 0);
      })
    );
    for (const size of results) totalBytes += size;
    downloaded += batch.length;
    const pct = Math.round((downloaded / parquetFiles.length) * 100);
    console.log(
      `  Downloaded ${downloaded}/${parquetFiles.length} files (${(totalBytes / 1e6).toFixed(0)} MB, ${pct}%)`
    );
  }

  const elapsed = (performance.now() - t0) / 1000;
  console.log(
    `  Download complete: ${(totalBytes / 1e6).toFixed(0)} MB in ${elapsed.toFixed(1)}s` +
      ` (${(totalBytes / (elapsed * 1e6)).toFixed(0)} MB/s)`
  );

  const localFiles = parquetFiles.map((f) => join(localDir, f.name.split('/').pop())).sort();
  return { localDir, files: localFiles };
}

// ─── Source file resolution ──────────────────────────────────────────────────

/**
 * Resolve Parquet files from the configured source path.
 * Returns { files: string[], tempDir: string|null }
 */
async function resolveSourceFiles(cfg) {
  const sourcePath = cfg.source.path;
  const pattern = cfg.source.pattern ?? '*.parquet';

  if (sourcePath.startsWith('gs://')) {
    const concurrency = cfg.source.download_concurrency ?? 5;
    const { localDir, files } = await downloadFromGcs(sourcePath, concurrency);
    const ext = pattern.replace(/^\*/, '');
    const filtered = files.filter((f) => f.endsWith(ext)).sort();
    console.log(`  GCS source: ${filtered.length} files matched pattern '${pattern}'`);
    return { files: filtered, tempDir: localDir };
  } else {
    const absPath = resolve(process.cwd(), sourcePath);
    if (!existsSync(absPath)) {
      console.error(`ERROR: Source path not found: ${absPath}`);
      process.exit(1);
    }

    let files;
    const stat = (await import('node:fs')).statSync(absPath);
    if (stat.isDirectory()) {
      const ext = pattern.replace(/^\*/, '');
      files = readdirSync(absPath)
        .filter((f) => f.endsWith(ext))
        .sort()
        .map((f) => join(absPath, f));
    } else {
      files = [absPath];
    }

    if (files.length === 0) {
      console.error(`ERROR: No files matching '${pattern}' found in: ${absPath}`);
      process.exit(1);
    }
    return { files, tempDir: null };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// H3F PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pass 1 (H3F): Scan Arrow batches to discover unique H3 cells, epoch values,
 * and per-column unique string values for dictionary building.
 */
function h3f_discoverCellsAndEpochs(batches, cfg) {
  const cellSet = new Set();
  const epochSet = new Set();
  const hasTime = !!cfg.time?.epoch_column;
  const epochCol = cfg.time?.epoch_column;
  const cellCol = cfg.geometry.cell_column;
  const startTsCol = cfg.time?.start_timestamp_column ?? null;

  const stringStaticCols = (cfg.columns?.static ?? []).filter((c) => c.type === 'string');
  const stringUniques = new Map(stringStaticCols.map((c) => [c.source, new Set()]));

  let minStartTimestamp = startTsCol ? Infinity : null;
  let rowsScanned = 0;
  const logInterval = 1_000_000;
  const t0 = performance.now();

  for (const table of batches) {
    const h3ColArrow = table.getChild(cellCol);
    const epochColArrow = hasTime ? table.getChild(epochCol) : null;
    const startTsColArrow = startTsCol ? table.getChild(startTsCol) : null;

    if (!h3ColArrow) {
      throw new Error(
        `Column '${cellCol}' not found in Parquet. ` +
          `Available: ${table.schema.fields.map((f) => f.name).join(', ')}`
      );
    }
    if (hasTime && !epochColArrow) {
      throw new Error(
        `Epoch column '${epochCol}' not found in Parquet. ` +
          `Available: ${table.schema.fields.map((f) => f.name).join(', ')}`
      );
    }
    if (startTsCol && !startTsColArrow) {
      throw new Error(
        `start_timestamp_column '${startTsCol}' not found in Parquet. ` +
          `Available: ${table.schema.fields.map((f) => f.name).join(', ')}`
      );
    }
    for (const col of stringStaticCols) {
      if (!table.getChild(col.source)) {
        throw new Error(
          `Static column '${col.source}' not found in Parquet. ` +
            `Available: ${table.schema.fields.map((f) => f.name).join(', ')}`
        );
      }
    }

    const numRows = table.numRows;
    for (let i = 0; i < numRows; i++) {
      cellSet.add(h3ColArrow.get(i));
      if (epochColArrow) epochSet.add(Number(epochColArrow.get(i)));
      if (startTsColArrow) {
        const v = Number(startTsColArrow.get(i));
        if (v < minStartTimestamp) minStartTimestamp = v;
      }
      for (const col of stringStaticCols) {
        stringUniques.get(col.source).add(table.getChild(col.source).get(i));
      }
      rowsScanned++;
      if (rowsScanned % logInterval === 0) {
        const rate = ((rowsScanned / (performance.now() - t0)) * 1000).toFixed(0);
        console.log(
          `    ${(rowsScanned / 1e6).toFixed(1)}M rows scanned (${rate} rows/s, ` +
            `${cellSet.size.toLocaleString()} cells, ${epochSet.size} epochs)`
        );
      }
    }
  }

  if (minStartTimestamp === Infinity) minStartTimestamp = null;

  const cellIds = [...cellSet].sort();
  const cellIndexMap = new Map(cellIds.map((id, i) => [id, i]));
  const epochValues = [...epochSet].sort((a, b) => a - b);
  const epochIndexMap = new Map(epochValues.map((v, i) => [v, i]));

  return { cellIds, cellIndexMap, epochValues, epochIndexMap, stringUniques, minStartTimestamp };
}

/** Build per-column string dictionaries (H3F static string columns). */
function h3f_buildStringDictionaries(cfg, stringUniques) {
  const dicts = new Map();
  for (const col of cfg.columns?.static ?? []) {
    if (col.type !== 'string') continue;
    const uniques = stringUniques.get(col.source);
    const dictionary = [...uniques].sort();
    const indexMap = new Map(dictionary.map((s, i) => [s, i]));
    dicts.set(col.source, { dictionary, indexMap });
  }
  return dicts;
}

/**
 * Pass 2 (H3F): Allocate pre-sized typed arrays and pivot Arrow batches
 * into cell-indexed column arrays.
 */
function h3f_pivotBatches(batches, cfg, cellIndexMap, epochIndexMap, dicts) {
  const cellCount = cellIndexMap.size;
  const epochCount = epochIndexMap.size;
  const hasTime = !!cfg.time?.epoch_column;
  const epochCol = cfg.time?.epoch_column;
  const cellCol = cfg.geometry.cell_column;

  const staticCols = cfg.columns?.static ?? [];
  const temporalCols = cfg.columns?.temporal ?? [];

  // ── Allocate typed arrays ──
  const staticArrays = new Map();
  for (const col of staticCols) {
    if (col.type === 'string') {
      const { dictionary } = dicts.get(col.source);
      const ArrayType =
        dictionary.length <= 255
          ? Uint8Array
          : dictionary.length <= 65535
            ? Uint16Array
            : Uint32Array;
      staticArrays.set(col.source, new ArrayType(cellCount));
    } else if (col.type === 'float64') {
      staticArrays.set(col.source, new Float64Array(cellCount));
    } else if (col.type === 'int32') {
      staticArrays.set(col.source, new Int32Array(cellCount));
    } else if (col.type === 'uint32') {
      staticArrays.set(col.source, new Uint32Array(cellCount));
    } else {
      staticArrays.set(col.source, new Float32Array(cellCount));
    }
  }

  const temporalArrays = new Map();
  for (const col of temporalCols) {
    const size = epochCount * cellCount;
    temporalArrays.set(
      col.source,
      col.type === 'float64' ? new Float64Array(size) : new Float32Array(size)
    );
  }

  const temporalStats = new Map(
    temporalCols.map((col) => [col.source, { min: Infinity, max: -Infinity }])
  );

  // ── Pivot ──
  let rowsProcessed = 0;
  let rowsSkipped = 0;
  const logInterval = 1_000_000;
  const t0 = performance.now();

  for (const table of batches) {
    const h3ColArrow = table.getChild(cellCol);
    const epochColArrow = hasTime ? table.getChild(epochCol) : null;

    const staticAccessors = staticCols.map((col) => table.getChild(col.source));
    const temporalAccessors = temporalCols.map((col) => table.getChild(col.source));
    const numRows = table.numRows;

    for (let i = 0; i < numRows; i++) {
      const cellId = h3ColArrow.get(i);
      const cellIdx = cellIndexMap.get(cellId);
      if (cellIdx === undefined) {
        rowsSkipped++;
        continue;
      }

      for (let c = 0; c < staticCols.length; c++) {
        const col = staticCols[c];
        const arr = staticAccessors[c];
        if (!arr) continue;
        const val = arr.get(i);
        if (col.type === 'string') {
          const { indexMap } = dicts.get(col.source);
          staticArrays.get(col.source)[cellIdx] = indexMap.get(val) ?? 0;
        } else {
          staticArrays.get(col.source)[cellIdx] = Number(val);
        }
      }

      if (hasTime && epochColArrow) {
        const epochVal = Number(epochColArrow.get(i));
        const epochIdx = epochIndexMap.get(epochVal);
        if (epochIdx === undefined) {
          rowsSkipped++;
          continue;
        }
        const offset = epochIdx * cellCount + cellIdx;
        for (let c = 0; c < temporalCols.length; c++) {
          const arr = temporalAccessors[c];
          if (!arr) continue;
          const v = Number(arr.get(i));
          temporalArrays.get(temporalCols[c].source)[offset] = v;
          const stats = temporalStats.get(temporalCols[c].source);
          if (v < stats.min) stats.min = v;
          if (v > stats.max) stats.max = v;
        }
      }

      rowsProcessed++;
      if (rowsProcessed % logInterval === 0) {
        const rate = ((rowsProcessed / (performance.now() - t0)) * 1000).toFixed(0);
        console.log(`    ${(rowsProcessed / 1e6).toFixed(1)}M rows pivoted (${rate} rows/s)`);
      }
    }
  }

  return { staticArrays, temporalArrays, temporalStats, rowsProcessed, rowsSkipped };
}

// ═══════════════════════════════════════════════════════════════════════════
// GFB PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pass 1 (GFB): Scan Arrow batches to discover unique entities, epoch values,
 * and per-column unique string values for dictionary building.
 *
 * For static-only GFB (no time section), entityColumn may be null — in that
 * case every row is its own feature (row order determines feature index).
 */
function gfb_discoverEntitiesAndEpochs(batches, cfg) {
  const hasTime = !!cfg.time?.epoch_column;
  const epochCol = cfg.time?.epoch_column;
  const entityCol = cfg.geometry.entity_column ?? null;
  const lonCol = cfg.geometry.longitude_column;
  const latCol = cfg.geometry.latitude_column;
  const startTsCol = cfg.time?.start_timestamp_column ?? null;

  const epochSet = new Set();
  const entitySet = new Set(); // used when entity_column is present

  const stringStaticCols = (cfg.columns?.static ?? []).filter((c) => c.type === 'string');
  const stringUniques = new Map(stringStaticCols.map((c) => [c.source, new Set()]));

  let minStartTimestamp = startTsCol ? Infinity : null;
  let totalRows = 0; // used when no entity_column (static GFB)
  let rowsScanned = 0;
  const logInterval = 1_000_000;
  const t0 = performance.now();

  for (const table of batches) {
    // Validate required columns exist
    const lonArrow = table.getChild(lonCol);
    const latArrow = table.getChild(latCol);
    if (!lonArrow)
      throw new Error(
        `Column '${lonCol}' not found. Available: ${table.schema.fields.map((f) => f.name).join(', ')}`
      );
    if (!latArrow)
      throw new Error(
        `Column '${latCol}' not found. Available: ${table.schema.fields.map((f) => f.name).join(', ')}`
      );

    const entityArrow = entityCol ? table.getChild(entityCol) : null;
    const epochArrow = hasTime ? table.getChild(epochCol) : null;
    const startTsArrow = startTsCol ? table.getChild(startTsCol) : null;

    if (entityCol && !entityArrow) {
      throw new Error(
        `entity_column '${entityCol}' not found. Available: ${table.schema.fields.map((f) => f.name).join(', ')}`
      );
    }
    if (hasTime && !epochArrow) {
      throw new Error(
        `Epoch column '${epochCol}' not found. Available: ${table.schema.fields.map((f) => f.name).join(', ')}`
      );
    }
    for (const col of stringStaticCols) {
      if (!table.getChild(col.source)) {
        throw new Error(
          `Static column '${col.source}' not found. Available: ${table.schema.fields.map((f) => f.name).join(', ')}`
        );
      }
    }

    const numRows = table.numRows;
    totalRows += numRows;

    for (let i = 0; i < numRows; i++) {
      if (entityArrow) entitySet.add(String(entityArrow.get(i)));
      if (epochArrow) epochSet.add(Number(epochArrow.get(i)));
      if (startTsArrow) {
        const v = Number(startTsArrow.get(i));
        if (v < minStartTimestamp) minStartTimestamp = v;
      }
      for (const col of stringStaticCols) {
        stringUniques.get(col.source).add(table.getChild(col.source).get(i));
      }
      rowsScanned++;
      if (rowsScanned % logInterval === 0) {
        const rate = ((rowsScanned / (performance.now() - t0)) * 1000).toFixed(0);
        console.log(
          `    ${(rowsScanned / 1e6).toFixed(1)}M rows scanned (${rate} rows/s, ` +
            `${entityCol ? entitySet.size.toLocaleString() + ' entities' : totalRows.toLocaleString() + ' rows'}, ` +
            `${epochSet.size} epochs)`
        );
      }
    }
  }

  if (minStartTimestamp === Infinity) minStartTimestamp = null;

  // Feature ordering: if entity_column is present, sort entity IDs for stable ordering.
  // Otherwise features are numbered 0..totalRows-1 (static only).
  const entityIds = entityCol ? [...entitySet].sort() : null;
  const entityIndexMap = entityIds ? new Map(entityIds.map((id, i) => [id, i])) : null;
  const featureCount = entityIds ? entityIds.length : totalRows;

  const epochValues = [...epochSet].sort((a, b) => a - b);
  const epochIndexMap = new Map(epochValues.map((v, i) => [v, i]));

  return {
    featureCount,
    entityIds,
    entityIndexMap,
    epochValues,
    epochIndexMap,
    stringUniques,
    minStartTimestamp,
    totalRows,
  };
}

/** Build per-column string dictionaries (GFB static string columns). */
function gfb_buildStringDictionaries(cfg, stringUniques) {
  const dicts = new Map();
  for (const col of cfg.columns?.static ?? []) {
    if (col.type !== 'string') continue;
    const uniques = stringUniques.get(col.source);
    const dictionary = [...uniques].sort();
    const indexMap = new Map(dictionary.map((s, i) => [s, i]));
    dicts.set(col.source, { dictionary, indexMap });
  }
  return dicts;
}

/**
 * Pass 2 (GFB): Allocate typed arrays and pivot Arrow batches into feature-indexed
 * position + attribute column arrays.
 *
 * Position array layout: epoch-major Float32Array[epochCount × featureCount × fpp]
 *   where fpp = 3 (lon, lat, alt) or 2 (lon, lat)
 *
 * Static arrays: TypedArray[featureCount]
 * Temporal arrays: TypedArray[epochCount × featureCount]
 */
function gfb_pivotBatches(
  batches,
  cfg,
  featureCount,
  entityIndexMap,
  epochIndexMap,
  dicts,
  _staticOnlyRowCount
) {
  const hasTime = !!cfg.time?.epoch_column;
  const epochCol = cfg.time?.epoch_column;
  const epochCount = epochIndexMap.size;
  const entityCol = cfg.geometry.entity_column ?? null;
  const lonCol = cfg.geometry.longitude_column;
  const latCol = cfg.geometry.latitude_column;
  const altCol = cfg.geometry.altitude_column ?? null;
  const hasAlt = !!altCol;
  const fpp = hasAlt ? 3 : 2;

  const staticCols = cfg.columns?.static ?? [];
  const temporalCols = cfg.columns?.temporal ?? [];

  // For static-only (no entity_column), featureCount == totalRows,
  // and we track an incrementing row index across batches.
  let staticRowCursor = 0;

  // ── Allocate position array ──
  // For static-only GFB: one position per feature (no temporal movement)
  // For temporal GFB: epoch-major positions across all epochs
  const posSize = hasTime ? epochCount * featureCount * fpp : featureCount * fpp;
  const positions = new Float32Array(posSize);

  // ── Allocate static column arrays ──
  const staticArrays = new Map();
  for (const col of staticCols) {
    if (col.type === 'string') {
      const { dictionary } = dicts.get(col.source);
      const ArrayType =
        dictionary.length <= 255
          ? Uint8Array
          : dictionary.length <= 65535
            ? Uint16Array
            : Uint32Array;
      staticArrays.set(col.source, new ArrayType(featureCount));
    } else if (col.type === 'float64') {
      staticArrays.set(col.source, new Float64Array(featureCount));
    } else if (col.type === 'int32') {
      staticArrays.set(col.source, new Int32Array(featureCount));
    } else if (col.type === 'uint32') {
      staticArrays.set(col.source, new Uint32Array(featureCount));
    } else {
      staticArrays.set(col.source, new Float32Array(featureCount));
    }
  }

  // ── Allocate temporal column arrays ──
  const temporalArrays = new Map();
  for (const col of temporalCols) {
    const size = epochCount * featureCount;
    temporalArrays.set(
      col.source,
      col.type === 'float64' ? new Float64Array(size) : new Float32Array(size)
    );
  }

  const temporalStats = new Map(
    temporalCols.map((col) => [col.source, { min: Infinity, max: -Infinity }])
  );

  let rowsProcessed = 0;
  let rowsSkipped = 0;
  const logInterval = 1_000_000;
  const t0 = performance.now();

  for (const table of batches) {
    const lonArrow = table.getChild(lonCol);
    const latArrow = table.getChild(latCol);
    const altArrow = altCol ? table.getChild(altCol) : null;
    const entityArrow = entityCol ? table.getChild(entityCol) : null;
    const epochArrow = hasTime ? table.getChild(epochCol) : null;

    const staticAccessors = staticCols.map((col) => table.getChild(col.source));
    const temporalAccessors = temporalCols.map((col) => table.getChild(col.source));

    const numRows = table.numRows;

    for (let i = 0; i < numRows; i++) {
      // ── Determine feature index ──
      let featureIdx;
      if (entityArrow) {
        const entityVal = String(entityArrow.get(i));
        featureIdx = entityIndexMap.get(entityVal);
        if (featureIdx === undefined) {
          rowsSkipped++;
          continue;
        }
      } else {
        // Static-only: sequential row assignment
        featureIdx = staticRowCursor++;
        if (featureIdx >= featureCount) {
          rowsSkipped++;
          continue;
        }
      }

      const lon = Number(lonArrow.get(i));
      const lat = Number(latArrow.get(i));
      const alt = altArrow ? Number(altArrow.get(i)) : 0;

      // ── Write position ──
      if (hasTime && epochArrow) {
        const epochVal = Number(epochArrow.get(i));
        const epochIdx = epochIndexMap.get(epochVal);
        if (epochIdx === undefined) {
          rowsSkipped++;
          continue;
        }
        const posOffset = (epochIdx * featureCount + featureIdx) * fpp;
        positions[posOffset] = lon;
        positions[posOffset + 1] = lat;
        if (hasAlt) positions[posOffset + 2] = alt;
      } else {
        // Static position
        const posOffset = featureIdx * fpp;
        positions[posOffset] = lon;
        positions[posOffset + 1] = lat;
        if (hasAlt) positions[posOffset + 2] = alt;
      }

      // ── Static columns (last writer wins for same feature) ──
      for (let c = 0; c < staticCols.length; c++) {
        const col = staticCols[c];
        const arr = staticAccessors[c];
        if (!arr) continue;
        const val = arr.get(i);
        if (col.type === 'string') {
          const { indexMap } = dicts.get(col.source);
          staticArrays.get(col.source)[featureIdx] = indexMap.get(val) ?? 0;
        } else {
          staticArrays.get(col.source)[featureIdx] = Number(val);
        }
      }

      // ── Temporal columns ──
      if (hasTime && epochArrow) {
        const epochVal = Number(epochArrow.get(i));
        const epochIdx = epochIndexMap.get(epochVal);
        if (epochIdx !== undefined) {
          const offset = epochIdx * featureCount + featureIdx;
          for (let c = 0; c < temporalCols.length; c++) {
            const arr = temporalAccessors[c];
            if (!arr) continue;
            const v = Number(arr.get(i));
            temporalArrays.get(temporalCols[c].source)[offset] = v;
            const stats = temporalStats.get(temporalCols[c].source);
            if (v < stats.min) stats.min = v;
            if (v > stats.max) stats.max = v;
          }
        }
      }

      rowsProcessed++;
      if (rowsProcessed % logInterval === 0) {
        const rate = ((rowsProcessed / (performance.now() - t0)) * 1000).toFixed(0);
        console.log(`    ${(rowsProcessed / 1e6).toFixed(1)}M rows pivoted (${rate} rows/s)`);
      }
    }
  }

  return {
    positions,
    staticArrays,
    temporalArrays,
    temporalStats,
    rowsProcessed,
    rowsSkipped,
    hasAlt,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

const t_total = performance.now();

// 1. Load + validate config
const cfg = loadConfig(configPath);
validateConfig(cfg);

const geomType = cfg.geometry.type;
const isH3F = geomType === 'h3f';
const isGFB = geomType === 'gfb';

const sourcePath = cfg.source.path;
const epochInterval = cfg.time?.epoch_interval ?? 300;
const epochColName = cfg.time?.epoch_column ?? null;
const cfgStartTimestamp = cfg.time?.start_timestamp ?? null;
const startTsColumn = cfg.time?.start_timestamp_column ?? null;
const hasTime = !!epochColName;
const staticCols = cfg.columns?.static ?? [];
const temporalCols = cfg.columns?.temporal ?? [];
const outputPath = resolve(process.cwd(), cfg.output.path);
const baseName = cfg.output.base_name ?? 'data';
const epochsPerShard = cfg.output.epochs_per_shard ?? 60;
const gzipLevel = cfg.output.gzip_level ?? 1;
const activeMetric =
  cfg.output.active_metric ?? (temporalCols[0] ? colOutputName(temporalCols[0]) : null);

// H3F-specific
const cellCol = isH3F ? cfg.geometry.cell_column : null;
const h3Resolution = isH3F ? (cfg.geometry.resolution ?? 5) : null;
const meshDir = isH3F && cfg.output.mesh_dir ? resolve(process.cwd(), cfg.output.mesh_dir) : null;

// GFB-specific
const lonCol = isGFB ? cfg.geometry.longitude_column : null;
const latCol = isGFB ? cfg.geometry.latitude_column : null;
const altCol = isGFB ? (cfg.geometry.altitude_column ?? null) : null;
const entityCol = isGFB ? (cfg.geometry.entity_column ?? null) : null;
const gfbGeomType = isGFB ? (cfg.geometry.geometry_type ?? 'point') : null;

const parquetColumns = requiredParquetColumns(cfg);

// ── Print plan ──
console.log(`\n${'═'.repeat(60)}`);
console.log(`parquet-to-flex — Parquet → ${isH3F ? 'H3Flex (H3F)' : 'GeoFlex (GFB)'} converter`);
console.log(`${'═'.repeat(60)}`);
console.log(`Config:        ${resolve(process.cwd(), configPath)}`);
console.log(`Source:        ${sourcePath}`);
console.log(`Format:        ${geomType.toUpperCase()}`);

if (isH3F) {
  console.log(`H3 cell col:   ${cellCol}`);
  console.log(`H3 resolution: ${h3Resolution}`);
  console.log(`Mesh dir:      ${meshDir ?? 'none (per-dataset mesh)'}`);
} else {
  console.log(`Lon column:    ${lonCol}`);
  console.log(`Lat column:    ${latCol}`);
  if (altCol) console.log(`Alt column:    ${altCol}`);
  if (entityCol) console.log(`Entity col:    ${entityCol}`);
  console.log(`Geometry type: ${gfbGeomType}`);
}

console.log(
  `Temporal:      ${hasTime ? `yes — epoch_col=${epochColName}, interval=${epochInterval}s` : 'no (static only)'}`
);
if (hasTime && (cfgStartTimestamp != null || startTsColumn)) {
  const src = cfgStartTimestamp != null ? `literal ${cfgStartTimestamp}` : `min(${startTsColumn})`;
  console.log(`Start ts:      ${src}`);
}
console.log(
  `Static cols:   ${staticCols.map((c) => `${c.source}${c.output ? '→' + c.output : ''}(${c.type ?? 'float32'})`).join(', ') || 'none'}`
);
console.log(
  `Temporal cols: ${temporalCols.map((c) => `${c.source}${c.output ? '→' + c.output : ''}(${c.type ?? 'float32'})`).join(', ') || 'none'}`
);
console.log(`Output:        ${outputPath}`);
console.log(`Base name:     ${baseName}`);
console.log(`Epochs/shard:  ${epochsPerShard}`);
console.log(`Parquet cols:  ${parquetColumns.join(', ')}`);
if (FLAG_DRY_RUN) console.log(`\n  [DRY RUN — no files will be read or written]`);
console.log('');

if (FLAG_DRY_RUN) {
  console.log('Dry run complete. Remove --dry-run to execute.');
  process.exit(0);
}

// ── Track temp dir for cleanup ──
let tempDir = null;

try {
  // 2. Resolve source files
  console.log(`Phase 1: Resolving source files...`);
  const { files, tempDir: td } = await resolveSourceFiles(cfg);
  tempDir = td;
  console.log(`  Found ${files.length} Parquet file(s)`);
  for (const f of files) console.log(`    ${f}`);

  // 3. Read all Parquet files into Arrow tables
  console.log(`\nPhase 2: Reading Parquet files via parquet-wasm...`);
  const t2 = performance.now();

  {
    const { resolve: _resolve } = await import('node:path');
    const wasmPkgDir = _resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../node_modules/parquet-wasm/esm'
    );
    const { readFileSync: _rfs } = await import('node:fs');
    const wasmBytes = _rfs(_resolve(wasmPkgDir, 'parquet_wasm_bg.wasm'));
    const wasmModule = await WebAssembly.compile(wasmBytes);
    await initWasm({ module_or_path: wasmModule });
  }

  const tables = [];
  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const buf = readFileSync(filePath);
    const wasmTable = readParquet(new Uint8Array(buf), { columns: parquetColumns });
    const ipcBuf = wasmTable.intoIPCStream();
    const table = tableFromIPC(ipcBuf);
    tables.push(table);
    console.log(
      `  [${i + 1}/${files.length}] ${filePath.split('/').pop()} — ${table.numRows.toLocaleString()} rows`
    );
  }

  const totalRows = tables.reduce((s, t) => s + t.numRows, 0);
  console.log(
    `  Total: ${totalRows.toLocaleString()} rows across ${tables.length} file(s) in ${((performance.now() - t2) / 1000).toFixed(1)}s`
  );

  // ─────────────────────────────────────────────────────────────────────
  // BRANCH: H3F
  // ─────────────────────────────────────────────────────────────────────
  if (isH3F) {
    // 4. Pass 1: Discover unique cells + epochs
    console.log(`\nPhase 3: Discovering unique H3 cells${hasTime ? ' + epochs' : ''}...`);
    const t3 = performance.now();

    const { cellIds, cellIndexMap, epochValues, epochIndexMap, stringUniques, minStartTimestamp } =
      h3f_discoverCellsAndEpochs(tables, cfg);

    const cellCount = cellIds.length;
    const epochCount = epochValues.length;

    let startTimestamp, startTimestampSource;
    if (cfgStartTimestamp != null) {
      startTimestamp = cfgStartTimestamp;
      startTimestampSource = 'config literal';
    } else if (minStartTimestamp != null) {
      startTimestamp = minStartTimestamp;
      startTimestampSource = `min(${startTsColumn})`;
    } else if (hasTime && epochValues.length > 0) {
      startTimestamp = epochValues[0];
      startTimestampSource = 'first epoch value (fallback)';
    } else {
      startTimestamp = null;
      startTimestampSource = null;
    }

    console.log(`  Cells:  ${cellCount.toLocaleString()} unique`);
    if (hasTime) {
      console.log(
        `  Epochs: ${epochCount} unique (${epochValues[0]} → ${epochValues[epochValues.length - 1]})`
      );
      if (startTimestamp != null) {
        console.log(`  Start:  ${startTimestamp} (Unix s) [${startTimestampSource}]`);
      }
    }
    console.log(`  Scan:   ${((performance.now() - t3) / 1000).toFixed(1)}s`);

    if (cellCount === 0) {
      console.error('ERROR: No H3 cells found.');
      process.exit(1);
    }
    if (hasTime && epochCount === 0) {
      console.error('ERROR: No epoch values found.');
      process.exit(1);
    }

    const staticMB = (staticCols.length * cellCount * 4) / 1e6;
    const temporalMB = (temporalCols.length * epochCount * cellCount * 4) / 1e6;
    console.log(
      `  Memory estimate: static=${staticMB.toFixed(0)} MB, temporal=${temporalMB.toFixed(0)} MB`
    );

    // 5. Build string dictionaries
    const dicts = h3f_buildStringDictionaries(cfg, stringUniques);
    for (const [colSrc, { dictionary }] of dicts) {
      console.log(`  Dictionary '${colSrc}': ${dictionary.length} entries`);
    }

    // 6. Pass 2: Pivot
    console.log(`\nPhase 4: Pivoting rows into typed arrays...`);
    const t4 = performance.now();

    const { staticArrays, temporalArrays, temporalStats, rowsProcessed, rowsSkipped } =
      h3f_pivotBatches(tables, cfg, cellIndexMap, epochIndexMap, dicts);

    console.log(
      `  Pivoted ${rowsProcessed.toLocaleString()} rows at ${((rowsProcessed / (performance.now() - t4)) * 1000).toFixed(0)} rows/s`
    );
    if (rowsSkipped > 0)
      console.log(`  Skipped ${rowsSkipped.toLocaleString()} rows (unknown cell or epoch)`);
    for (const col of temporalCols) {
      const { min, max } = temporalStats.get(col.source);
      console.log(`  ${colOutputName(col)}: min=${min}, max=${max}`);
    }

    tables.length = 0; // GC hint

    // 7. Compute cell centers
    console.log(`\nPhase 5: Computing cell centers (h3-js)...`);
    const t5 = performance.now();
    const cellCenters = new Float64Array(cellCount * 2);
    for (let i = 0; i < cellCount; i++) {
      const [lat, lng] = cellToLatLng(cellIds[i]);
      cellCenters[i * 2] = lat;
      cellCenters[i * 2 + 1] = lng;
    }
    console.log(
      `  ${cellCount.toLocaleString()} centers in ${((performance.now() - t5) / 1000).toFixed(1)}s`
    );

    // 8. Encode via H3FlexEncoder
    console.log(`\nPhase 6: Encoding H3Flex output...`);
    mkdirSync(outputPath, { recursive: true });

    const encoder = new H3FlexEncoder({
      epochInterval,
      epochCount: hasTime ? epochCount : 0,
      gzipLevel,
    });

    encoder.setCells(cellIds, cellCenters);

    // Static columns — string columns use addColumn() which auto-builds the shared
    // dictionary and always produces enum16 indices (the only enum type in v3).
    // Numeric columns use addStaticColumn() with an explicit type code.
    for (const col of staticCols) {
      const name = colOutputName(col);
      const data = staticArrays.get(col.source);
      if (col.type === 'string') {
        // Reconstruct string array from per-column pivot dictionary + index array
        const { dictionary } = dicts.get(col.source);
        const strings = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
          strings[i] = dictionary[data[i]] ?? '';
        }
        encoder.addColumn(name, strings);
      } else {
        encoder.addStaticColumn(name, col.type ?? 'float32', data);
      }
    }

    for (const col of temporalCols) {
      encoder.setTemporalData(colOutputName(col), temporalArrays.get(col.source), epochCount);
    }

    const extraManifest = { startTimestamp };
    if (activeMetric) extraManifest.activeMetric = activeMetric;
    if (cfg.manifest) Object.assign(extraManifest, cfg.manifest);

    const encodeOptions = {
      output: outputPath,
      baseName,
      sharding: { epochsPerShard },
      manifest: extraManifest,
    };

    if (!FLAG_NO_MESH) {
      encodeOptions.cellToBoundary = cellToBoundary;
      if (meshDir) {
        encodeOptions.meshDir = meshDir;
        encodeOptions.meshLevel = h3Resolution;
      }
    }

    const { stats } = await encoder.encode(encodeOptions);

    // Patch meshTiles into manifest if tiled mesh directory exists
    if (!FLAG_NO_MESH && meshDir) {
      const tileDir = join(meshDir, `h3-l${h3Resolution}`);
      const tileManifestPath = join(tileDir, 'tiles.manifest.json');
      if (existsSync(tileManifestPath)) {
        const manifestFilePath = join(outputPath, `${baseName}.manifest.json`);
        const manifestData = JSON.parse(readFileSync(manifestFilePath, 'utf8'));
        const { relative } = await import('node:path');
        const rel = relative(outputPath, tileManifestPath);
        if (manifestData.meshTiles !== rel) {
          manifestData.meshTiles = rel;
          writeFileSync(manifestFilePath, JSON.stringify(manifestData, null, 2));
          console.log(`  Patched manifest: meshTiles → ${rel}`);
        }
      }
    }

    // 9. Summary
    const totalMs = performance.now() - t_total;
    const shardCount = hasTime ? Math.ceil(epochCount / epochsPerShard) : 0;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Done in ${(totalMs / 1000).toFixed(1)}s`);
    console.log(`  Format:       H3F`);
    console.log(`  Output:       ${outputPath}/`);
    console.log(`  Cells:        ${cellCount.toLocaleString()}`);
    console.log(
      `  Epochs:       ${hasTime ? `${epochCount} × ${epochInterval}s` : 'none (static)'}`
    );
    if (hasTime && startTimestamp != null) {
      console.log(`  Start time:   ${startTimestamp} (Unix s)`);
    }
    console.log(`  Shards:       ${shardCount}`);
    console.log(`  Rows pivoted: ${rowsProcessed.toLocaleString()}`);
    if (stats.vertCount > 0) {
      console.log(
        `  Mesh:         ${stats.vertCount.toLocaleString()} verts, ${stats.triCount.toLocaleString()} tris`
      );
    }
    console.log(`${'═'.repeat(60)}`);

    console.log(`\nAdd to globe-config.yaml:\n`);
    const layerType = hasTime ? 'h3f-sharded' : 'h3f';
    console.log(`  - name: ${baseName}`);
    console.log(`    type: ${layerType}`);
    console.log(`    url: /data/${baseName}/${baseName}.manifest.json`);
    if (activeMetric) console.log(`    activeMetric: ${activeMetric}`);
    console.log(`    extrusionEnabled: true`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // BRANCH: GFB
  // ─────────────────────────────────────────────────────────────────────
  else if (isGFB) {
    // 4. Pass 1: Discover entities + epochs
    console.log(
      `\nPhase 3: Discovering unique ${entityCol ? 'entities' : 'features'}${hasTime ? ' + epochs' : ''}...`
    );
    const t3 = performance.now();

    const {
      featureCount,
      entityIds,
      entityIndexMap,
      epochValues,
      epochIndexMap,
      stringUniques,
      minStartTimestamp,
    } = gfb_discoverEntitiesAndEpochs(tables, cfg);

    const epochCount = epochValues.length;

    let startTimestamp, startTimestampSource;
    if (cfgStartTimestamp != null) {
      startTimestamp = cfgStartTimestamp;
      startTimestampSource = 'config literal';
    } else if (minStartTimestamp != null) {
      startTimestamp = minStartTimestamp;
      startTimestampSource = `min(${startTsColumn})`;
    } else if (hasTime && epochValues.length > 0) {
      startTimestamp = epochValues[0];
      startTimestampSource = 'first epoch value (fallback)';
    } else {
      startTimestamp = null;
      startTimestampSource = null;
    }

    console.log(`  Features: ${featureCount.toLocaleString()} unique`);
    if (hasTime) {
      console.log(
        `  Epochs:   ${epochCount} unique (${epochValues[0]} → ${epochValues[epochValues.length - 1]})`
      );
      if (startTimestamp != null) {
        console.log(`  Start:    ${startTimestamp} (Unix s) [${startTimestampSource}]`);
      }
    }
    console.log(`  Scan:     ${((performance.now() - t3) / 1000).toFixed(1)}s`);

    if (featureCount === 0) {
      console.error('ERROR: No features found.');
      process.exit(1);
    }
    if (hasTime && epochCount === 0) {
      console.error('ERROR: No epoch values found.');
      process.exit(1);
    }

    const hasAltForEst = !!altCol;
    const fppEst = hasAltForEst ? 3 : 2;
    const posMB = ((hasTime ? epochCount : 1) * featureCount * fppEst * 4) / 1e6;
    const staticMB = (staticCols.length * featureCount * 4) / 1e6;
    const temporalMB = (temporalCols.length * (hasTime ? epochCount : 0) * featureCount * 4) / 1e6;
    console.log(
      `  Memory estimate: positions=${posMB.toFixed(0)} MB, static=${staticMB.toFixed(0)} MB, temporal=${temporalMB.toFixed(0)} MB`
    );

    // 5. Build string dictionaries
    const dicts = gfb_buildStringDictionaries(cfg, stringUniques);
    for (const [colSrc, { dictionary }] of dicts) {
      console.log(`  Dictionary '${colSrc}': ${dictionary.length} entries`);
    }

    // 6. Pass 2: Pivot
    console.log(`\nPhase 4: Pivoting rows into typed arrays...`);
    const t4 = performance.now();

    const {
      positions,
      staticArrays,
      temporalArrays,
      temporalStats,
      rowsProcessed,
      rowsSkipped,
      hasAlt,
    } = gfb_pivotBatches(
      tables,
      cfg,
      featureCount,
      entityIndexMap,
      epochIndexMap,
      dicts,
      totalRows
    );

    console.log(
      `  Pivoted ${rowsProcessed.toLocaleString()} rows at ${((rowsProcessed / (performance.now() - t4)) * 1000).toFixed(0)} rows/s`
    );
    if (rowsSkipped > 0)
      console.log(`  Skipped ${rowsSkipped.toLocaleString()} rows (unknown entity or epoch)`);
    for (const col of temporalCols) {
      const { min, max } = temporalStats.get(col.source);
      console.log(`  ${colOutputName(col)}: min=${min}, max=${max}`);
    }

    tables.length = 0; // GC hint

    // 7. Encode via GeoFlexEncoder
    console.log(`\nPhase 5: Encoding GeoFlex output...`);
    mkdirSync(outputPath, { recursive: true });

    const encoder = new GeoFlexEncoder({
      featureCount,
      epochCount: hasTime ? epochCount : 0,
      epochInterval,
      geometryType: gfbGeomType,
      hasAltitude: hasAlt,
      gzipLevel,
    });

    // Static columns — string columns use addColumn() which auto-builds the shared
    // dictionary and always produces enum16 indices (the only enum type in v3).
    // Numeric columns use addStaticColumn() with an explicit type code.
    // String columns must be added BEFORE the entity key so that encoder._dictionary
    // is populated when we merge entity IDs into it below.
    for (const col of staticCols) {
      const name = colOutputName(col);
      const data = staticArrays.get(col.source);
      if (col.type === 'string') {
        // Reconstruct string array from per-column pivot dictionary + index array
        const { dictionary } = dicts.get(col.source);
        const strings = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
          strings[i] = dictionary[data[i]] ?? '';
        }
        encoder.addColumn(name, strings);
      } else {
        encoder.addStaticColumn(name, col.type ?? 'float32', data);
      }
    }

    // Entity key column — merge entity ID strings into the encoder's auto-built
    // dictionary, then pass Uint16Array indices to setEntityKey().
    // v3 uses only enum16 (Uint16Array) for all dictionary-encoded columns.
    if (entityIds && entityCol) {
      const dictMap = new Map(encoder._dictionary.map((s, i) => [s, i]));
      for (const id of entityIds) {
        if (!dictMap.has(id)) {
          dictMap.set(id, encoder._dictionary.length);
          encoder._dictionary.push(id);
        }
      }
      const entityIndices = new Uint16Array(featureCount);
      for (let i = 0; i < featureCount; i++) {
        entityIndices[i] = dictMap.get(entityIds[i]) ?? 0;
      }
      encoder.setEntityKey(entityCol, entityIndices);
    }

    // Positions
    encoder.setPositions(positions);

    // Temporal columns
    for (const col of temporalCols) {
      encoder.setTemporalData(
        colOutputName(col),
        temporalArrays.get(col.source),
        hasTime ? epochCount : 0
      );
    }

    const extraManifest = { startTimestamp };
    if (activeMetric) extraManifest.activeMetric = activeMetric;
    if (cfg.manifest) Object.assign(extraManifest, cfg.manifest);

    await encoder.encode({
      output: outputPath,
      baseName,
      sharding: { epochsPerShard },
      manifest: extraManifest,
    });

    // 8. Summary
    const totalMs = performance.now() - t_total;
    const shardCount = hasTime ? Math.ceil(epochCount / epochsPerShard) : 0;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Done in ${(totalMs / 1000).toFixed(1)}s`);
    console.log(`  Format:       GFB (${gfbGeomType})`);
    console.log(`  Output:       ${outputPath}/`);
    console.log(`  Features:     ${featureCount.toLocaleString()}`);
    console.log(
      `  Epochs:       ${hasTime ? `${epochCount} × ${epochInterval}s` : 'none (static)'}`
    );
    if (hasTime && startTimestamp != null) {
      console.log(`  Start time:   ${startTimestamp} (Unix s)`);
    }
    console.log(`  Shards:       ${shardCount}`);
    console.log(`  Rows pivoted: ${rowsProcessed.toLocaleString()}`);
    console.log(`${'═'.repeat(60)}`);

    console.log(`\nAdd to globe-config.yaml:\n`);
    const layerType = hasTime ? 'gfb-sharded' : 'gfb';
    console.log(`  - name: ${baseName}`);
    console.log(`    type: ${layerType}`);
    console.log(`    url: /data/${baseName}/${baseName}.manifest.json`);
    if (activeMetric) console.log(`    activeMetric: ${activeMetric}`);
  }
} finally {
  if (tempDir && !FLAG_KEEP_TMP) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      console.log(`\nCleaned up temp dir: ${tempDir}`);
    } catch (e) {
      console.warn(`WARNING: Could not remove temp dir: ${e.message}`);
    }
  } else if (tempDir && FLAG_KEEP_TMP) {
    console.log(`\nTemp dir retained (--keep-tmp): ${tempDir}`);
  }
}
