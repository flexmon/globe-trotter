#!/usr/bin/env node
/**
 * generate-h3-data.js — Generate H3 res-5 cells across the ENTIRE GLOBE
 * with temporal demand_mbps + sinr data driven by flight positions.
 *
 * Uses H3FlexEncoder from @globe-trotter/data-sdk for output encoding.
 * The encoder pre-computes GPU-ready mesh, handles split mesh/base files,
 * auto-detects optimal shard encoding (RLE vs sparse), and writes manifests.
 *
 * Supply demand is computed from flight positions: each in-flight aircraft
 * contributes ~15 Mbps demand to nearby H3 cells via Gaussian falloff.
 *
 * Output: public/data/mobile-demand-sim/ (base + mesh + shards + manifest)
 *
 * Usage: node scripts/mobile-demand-sim/generate-h3-data.js
 */

import { getRes0Cells, cellToChildren, cellToLatLng, cellToBoundary } from 'h3-js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { Worker } from 'worker_threads';
import { cpus } from 'os';
import {
  generateFlightPlans,
  getFlightMaxDemand,
  EPOCH_COUNT,
  EPOCH_INTERVAL,
  pickWeightedAirline,
} from './flight-plans.js';
import { H3FlexEncoder, encodeShardV3 } from '../../lib/packages/data-sdk/src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Configuration ───
const H3_RES = 5;

// Supply model — very tight radius: only the H3 cell under each plane lights up
// Per-flight max demand is now computed from flight distance + airline tier
const DEMAND_RADIUS_DEG = 0.18; // Reverted to original tighter halo
const BASE_SUPPLY = 0; // No base — cells with no planes = transparent

console.log('=== H3 Columnar Binary Generator (Flight-Driven Supply) ===');
console.log(`Coverage: GLOBAL res-${H3_RES}, ${EPOCH_COUNT} epochs × ${EPOCH_INTERVAL}s`);

// ─── Step 1: Generate ALL H3 cell IDs at res-5 (global) ───
console.log('Step 1: Enumerating all global H3 res-5 cells...');

const baseCells = getRes0Cells();
console.log(`  Base (res-0) cells: ${baseCells.length}`);

const cellIds = [];
const cellCenters = [];
for (let b = 0; b < baseCells.length; b++) {
  const children = cellToChildren(baseCells[b], H3_RES);
  for (const cellId of children) {
    cellIds.push(cellId);
    cellCenters.push(cellToLatLng(cellId));
  }
  if ((b + 1) % 20 === 0) {
    console.log(
      `  Expanded ${b + 1}/${baseCells.length} base cells (${cellIds.length.toLocaleString()} cells so far)`
    );
  }
}
const cellCount = cellIds.length;
console.log(`  Generated ${cellCount.toLocaleString()} global H3 cells`);

// ─── Step 2: Assign regions ───
console.log('Step 2: Assigning regions...');
const regions = [
  'North America',
  'South America',
  'Europe',
  'Africa',
  'Asia',
  'Oceania',
  'Antarctica',
  'Atlantic',
];
const regionIndices = new Uint16Array(cellCount);
for (let i = 0; i < cellCount; i++) {
  const [lat, lon] = cellCenters[i];
  if (lat < -60)
    regionIndices[i] = 6; // Antarctica
  else if (lat > 15 && lon >= -170 && lon < -30)
    regionIndices[i] = 0; // North America
  else if (lat <= 15 && lon >= -90 && lon < -30)
    regionIndices[i] = 1; // South America
  else if (lat > 35 && lon >= -30 && lon < 60)
    regionIndices[i] = 2; // Europe
  else if (lat <= 35 && lon >= -30 && lon < 60)
    regionIndices[i] = 3; // Africa
  else if (lat > -10 && lon >= 60 && lon < 150)
    regionIndices[i] = 4; // Asia
  else if (lon >= 100 || lon < -170)
    regionIndices[i] = 5; // Oceania
  // New Atlantic region: lat between -30 and 30, lon between -30 and -10
  else if (lat >= -30 && lat <= 30 && lon >= -30 && lon < -10)
    regionIndices[i] = 7; // Atlantic
  else regionIndices[i] = 4; // Default to Asia
}

// ─── Step 3: Generate flight plans ───
console.log('Step 3: Generating flight plans for demand correlation...');
const flights = generateFlightPlans();

// ─── Step 4: Build spatial grid for fast flight lookups ───
console.log('Step 4: Building spatial index for H3 cells...');

// Grid: 1° × 1° buckets for fast cell lookup
const GRID_SIZE = 1; // degrees
const cellGrid = new Map();

function gridKey(lat, lon) {
  const gLat = Math.floor(lat / GRID_SIZE);
  const gLon = Math.floor(lon / GRID_SIZE);
  return `${gLat},${gLon}`;
}

for (let i = 0; i < cellCount; i++) {
  const [lat, lon] = cellCenters[i];
  const key = gridKey(lat, lon);
  if (!cellGrid.has(key)) cellGrid.set(key, []);
  cellGrid.get(key).push(i);
}
console.log(`  Grid: ${cellGrid.size} occupied cells`);

// ─── Step 5: Generate temporal demand data from flights (PARALLEL) ───

// Ground-state demand model constants
const GROUND_DWELL_PRE_MIN = 45;
const GROUND_DWELL_PRE_MAX = 90;
const GROUND_DWELL_POST_MIN = 30;
const GROUND_DWELL_POST_MAX = 60;
const GROUND_MBPS_MIN = 3;
const GROUND_MBPS_MAX = 25; // Per user: planes use up to 25 Mbps on ground
const GROUND_RADIUS_DEG = 0.18; // ~20 km — covers 4-6 H3 res-5 cells for compact hotspots
const GRID_SIZE_VAL = GRID_SIZE;

// ─── Step 5: Generate temporal demand data from flights (SHARDED) ───
const SHARD_SIZE = 60;
const numShards = Math.ceil(EPOCH_COUNT / SHARD_SIZE);

// Create a separate SharedArrayBuffer for each shard to avoid TypedArray length limits.
// Each shard is ~480MB (60 epochs * 2M cells * 4 bytes).
const shardBuffers = [];
const shardDataViews = [];
for (let s = 0; s < numShards; s++) {
  const buf = new SharedArrayBuffer(SHARD_SIZE * cellCount * 4);
  shardBuffers.push(buf);
  shardDataViews.push(new Float32Array(buf));
}

// Pack ALL large data into SharedArrayBuffers for zero-copy worker transfer.
// This eliminates the 12× structured-clone bottleneck that was causing spawn delays.

// 1. Cell centers → SharedArrayBuffer Float64Array
const centersBuf = new SharedArrayBuffer(cellCount * 2 * 8);
const sharedCenters = new Float64Array(centersBuf);
for (let i = 0; i < cellCount; i++) {
  sharedCenters[i * 2] = cellCenters[i][0];
  sharedCenters[i * 2 + 1] = cellCenters[i][1];
}

// 2. Flights → SharedArrayBuffer Float64Array (flat packed, 9 fields per flight)
const FLIGHT_FIELDS = 9;
const flightsBuf = new SharedArrayBuffer(flights.length * FLIGHT_FIELDS * 8);
const sharedFlights = new Float64Array(flightsBuf);
for (let i = 0; i < flights.length; i++) {
  const f = flights[i];
  const off = i * FLIGHT_FIELDS;
  sharedFlights[off + 0] = f.id;
  sharedFlights[off + 1] = f.origin.lat;
  sharedFlights[off + 2] = f.origin.lon;
  sharedFlights[off + 3] = f.dest.lat;
  sharedFlights[off + 4] = f.dest.lon;
  sharedFlights[off + 5] = f.departMinute;
  sharedFlights[off + 6] = f.flightDurationMin;
  sharedFlights[off + 7] = f.dist;
  sharedFlights[off + 8] = f.cruiseAlt;
}

// Pre-compute per-flight max demand based on distance + airline tier
// (airlines are assigned deterministically using same seeded RNG as GFB generator)
let rngState2 = 77; // Same seed as GFB generator
function rng2() {
  rngState2 = (rngState2 * 1664525 + 1013904223) & 0xffffffff;
  return (rngState2 >>> 0) / 0xffffffff;
}
const maxDemandBuf = new SharedArrayBuffer(flights.length * 4); // Float32
const maxDemands = new Float32Array(maxDemandBuf);
for (let i = 0; i < flights.length; i++) {
  const airline = pickWeightedAirline(rng2);
  maxDemands[i] = getFlightMaxDemand(flights[i], airline);
}

// 3. Spatial grid → SharedArrayBuffer Int32Arrays
//    Pack as: flat bucket array + offset table (CSR format)
const gridKeys = [...cellGrid.keys()];
const gridBuckets = gridKeys.map((k) => cellGrid.get(k));
let totalGridEntries = 0;
for (const b of gridBuckets) totalGridEntries += b.length;

const gridOffsetsBuf = new SharedArrayBuffer((gridKeys.length + 1) * 4);
const sharedGridOffsets = new Int32Array(gridOffsetsBuf);
const gridIndicesBuf = new SharedArrayBuffer(totalGridEntries * 4);
const sharedGridIndices = new Int32Array(gridIndicesBuf);

let gridPos = 0;
for (let i = 0; i < gridBuckets.length; i++) {
  sharedGridOffsets[i] = gridPos;
  for (const idx of gridBuckets[i]) {
    sharedGridIndices[gridPos++] = idx;
  }
}
sharedGridOffsets[gridBuckets.length] = gridPos;

// Spawn one worker per shard for simplicity and max parallelism
const NUM_WORKERS = Math.max(1, cpus().length - 2);
console.log(
  `Step 5: Computing demand from flight positions (${numShards} shards, max ${NUM_WORKERS} concurrent)...`
);
const t6 = performance.now();

const shardWorkerQueue = Array.from({ length: numShards }, (_, i) => i);
let activeWorkers = 0;

const runNextShard = () => {
  if (shardWorkerQueue.length === 0) return Promise.resolve();

  activeWorkers++;
  const s = shardWorkerQueue.shift();
  const epochStart = s * SHARD_SIZE;
  const epochEnd = Math.min(epochStart + SHARD_SIZE, EPOCH_COUNT);
  const demandBuffer = shardBuffers[s];

  return new Promise((resolveW, rejectW) => {
    const workerPath = resolve(__dirname, 'epoch-worker.js');
    const worker = new Worker(workerPath, {
      workerData: {
        flightsBuf,
        flightCount: flights.length,
        FLIGHT_FIELDS,
        centersBuf,
        gridKeys,
        gridOffsetsBuf,
        gridIndicesBuf,
        epochStart,
        epochEnd,
        cellCount,
        demandBuffer,
        DEMAND_RADIUS_DEG,
        maxDemandBuf,
        BASE_SUPPLY,
        GROUND_DWELL_PRE_MIN,
        GROUND_DWELL_PRE_MAX,
        GROUND_DWELL_POST_MIN,
        GROUND_DWELL_POST_MAX,
        GROUND_MBPS_MIN,
        GROUND_MBPS_MAX,
        GROUND_RADIUS_DEG,
        EPOCH_INTERVAL,
        GRID_SIZE: GRID_SIZE_VAL,
      },
    });

    worker.on('message', (msg) => {
      console.log(
        `  Shard ${s} [epochs ${msg.epochStart}-${msg.epochEnd - 1}] done (${msg.activeCount.toLocaleString()} flights)`
      );
      activeWorkers--;
      runNextShard().then(resolveW);
    });
    worker.on('error', rejectW);
    worker.on('exit', (code) => {
      if (code !== 0) rejectW(new Error(`Shard worker ${s} failed with code ${code}`));
    });
  });
};

const initialPromises = [];
for (let i = 0; i < Math.min(NUM_WORKERS, numShards); i++) {
  initialPromises.push(runNextShard());
}

await Promise.all(initialPromises);
console.log(`  Step 5 completed in ${((performance.now() - t6) / 1000).toFixed(1)}s`);

// ─── Step 6: Filter to cells with non-zero supply ───
// Most of the 2M+ global cells have zero supply (no flights nearby).
// Filter to only cells that light up to keep file under browser 2 GB limit.
console.log('Step 6: Filtering to active cells...');

const activeMask = new Uint8Array(cellCount);
let activeCellCount = 0;
for (let s = 0; s < numShards; s++) {
  const demandData = shardDataViews[s];
  const shardEpochs = Math.min(SHARD_SIZE, EPOCH_COUNT - s * SHARD_SIZE);
  for (let e = 0; e < shardEpochs; e++) {
    const off = e * cellCount;
    for (let i = 0; i < cellCount; i++) {
      if (!activeMask[i] && demandData[off + i] > 0) {
        activeMask[i] = 1;
        activeCellCount++;
      }
    }
  }
}
console.log(
  `  Active cells: ${activeCellCount.toLocaleString()} / ${cellCount.toLocaleString()} (${((100 * activeCellCount) / cellCount).toFixed(1)}%)`
);

// Build mapping from old index → new index
const newToOld = new Int32Array(activeCellCount);
let newIdx = 0;
for (let i = 0; i < cellCount; i++) {
  if (activeMask[i]) {
    newToOld[newIdx] = i;
    newIdx++;
  }
}

// ─── Step 7: Build filtered data arrays + derive SINR ───
console.log('Step 7: Building filtered data + SINR...');

const shardFiles = [];

// Seeded RNG for SINR jitter (deterministic across runs)
let sinrRng = 42;
function sinrRandom() {
  sinrRng = (sinrRng * 1664525 + 1013904223) & 0xffffffff;
  return (sinrRng >>> 0) / 0xffffffff;
}

const OUTPUT_DIR = resolve(__dirname, '../../public/data/mobile-demand-sim');
mkdirSync(OUTPUT_DIR, { recursive: true });
const fCellIdsData = new BigUint64Array(activeCellCount);
for (let newC = 0; newC < activeCellCount; newC++) {
  fCellIdsData[newC] = BigInt('0x' + cellIds[newToOld[newC]]);
}

for (let s = 0; s < numShards; s++) {
  const shardEpochs = Math.min(SHARD_SIZE, EPOCH_COUNT - s * SHARD_SIZE);
  const demandShard = new Float32Array(shardEpochs * activeCellCount);
  const sinrShard = new Float32Array(shardEpochs * activeCellCount);
  const srcDemand = shardDataViews[s];

  for (let e = 0; e < shardEpochs; e++) {
    const srcOff = e * cellCount;
    const dstOff = e * activeCellCount;
    for (let newC = 0; newC < activeCellCount; newC++) {
      const demand = srcDemand[srcOff + newToOld[newC]];
      demandShard[dstOff + newC] = demand;

      if (demand > 0) {
        const baseSinr = 9.0 - (Math.min(demand, 60) / 60) * 7.0;
        const jitter = (sinrRandom() - 0.5) * 1.0;
        const raw = Math.max(1.0, Math.min(9.0, baseSinr + jitter));
        sinrShard[dstOff + newC] = Math.round(raw * 100) / 100;
      }
    }
  }

  // Encode and write shard immediately to save memory
  const columns = [
    { name: 'h3_cell_id', data: fCellIdsData },
    { name: 'demand_mbps', data: demandShard },
    { name: 'sinr', data: sinrShard },
  ];
  const shardBuf = encodeShardV3(columns, {
    epochCount: shardEpochs,
    entityCount: activeCellCount,
    gzipLevel: 1,
  });

  const epochStart = s * SHARD_SIZE;
  const epochEnd = epochStart + shardEpochs;
  const padS = String(epochStart).padStart(4, '0');
  const padE = String(epochEnd - 1).padStart(4, '0');
  const shardName = `demand_metrics_e${padS}-e${padE}.shd3`;

  writeFileSync(resolve(OUTPUT_DIR, shardName), shardBuf);
  shardFiles.push({ epochs: [epochStart, epochEnd - 1], file: shardName, epochCount: shardEpochs });

  // ─────────────────────────────────────────────────────────────
  // CRITICAL: Release memory immediately
  // ─────────────────────────────────────────────────────────────
  shardDataViews[s] = null;
  shardBuffers[s] = null; // SAB release
  // ─────────────────────────────────────────────────────────────

  if (s % 4 === 0 || s === numShards - 1) {
    console.log(`  Processed and wrote shard ${s + 1} / ${numShards}`);
  }
}

const fRegionIndices = new Uint16Array(activeCellCount);
for (let newC = 0; newC < activeCellCount; newC++) {
  fRegionIndices[newC] = regionIndices[newToOld[newC]];
}

const fCellIds = new Array(activeCellCount);
const fCellCenters = new Array(activeCellCount);
for (let newC = 0; newC < activeCellCount; newC++) {
  fCellIds[newC] = cellIds[newToOld[newC]];
  fCellCenters[newC] = cellCenters[newToOld[newC]];
}

// ─── Step 8: Encode with H3FlexEncoder ───
console.log('Step 8: Encoding with H3FlexEncoder...');

const encoder = new H3FlexEncoder({
  epochInterval: EPOCH_INTERVAL,
  epochCount: EPOCH_COUNT,
  gzipLevel: 1,
});

// Set cells — encoder uses these for cellIDs and mesh building
encoder.setCells(fCellIds, fCellCenters);

// Dictionary + static region column
encoder.setDictionary(regions);
encoder.addStaticColumn('region_name', 'enum', fRegionIndices);

// Add temporal column definitions (types only, we wrote data manually)
encoder.setTemporalData('demand_mbps', [], EPOCH_COUNT);
encoder.setTemporalData('sinr', [], EPOCH_COUNT);

// Embedded style spec — demand_mbps (0-60 Mbps) + sinr (1-9)
encoder.setStyle({
  format: 'h3flex',
  version: 1,
  layers: [
    {
      id: 'demand-heatmap',
      attribute: 'demand_mbps',
      style: {
        type: 'color-ramp',
        domain: [0, 60],
        stops: [
          { value: 0, color: '#0D1A80' },
          { value: 8, color: '#0D73BF' },
          { value: 20, color: '#1ABF59' },
          { value: 40, color: '#D9D91A' },
          { value: 60, color: '#F23319' },
        ],
        opacityStops: [
          { value: 0, opacity: 0.0 },
          { value: 2, opacity: 0.3 },
          { value: 15, opacity: 0.55 },
          { value: 40, opacity: 0.75 },
          { value: 60, opacity: 0.9 },
        ],
      },
    },
    {
      id: 'sinr-heatmap',
      attribute: 'sinr',
      style: {
        type: 'color-ramp',
        domain: [1, 9],
        stops: [
          { value: 1, color: '#D32F2F' },
          { value: 3, color: '#FF9800' },
          { value: 5, color: '#FFEB3B' },
          { value: 7, color: '#66BB6A' },
          { value: 9, color: '#1B5E20' },
        ],
        opacityStops: [
          { value: 0, opacity: 0.0 },
          { value: 1, opacity: 0.3 },
          { value: 3, opacity: 0.5 },
          { value: 6, opacity: 0.7 },
          { value: 9, opacity: 0.9 },
        ],
      },
    },
  ],
});

// Encode — encoder builds mesh, writes base + manifest
const MESH_DIR = resolve(__dirname, '../../public/meshes');
const { stats } = await encoder.encode({
  output: OUTPUT_DIR,
  baseName: 'demand_metrics',
  cellToBoundary,
  encoding: 'auto',
  sharding: { epochsPerShard: 60, shardFormat: 'v3' }, // Shards explicitly configured exclusively V3
  meshDir: './public/meshes/',
  meshLevel: H3_RES,
  manifest: {
    startHourUTC: 0,
    startTimestamp: Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000),
    shards: shardFiles, // Inject our manually written shard list
  },
});

console.log(`\nDone! H3FlexEncoder output:`);
console.log(
  `  Cells: ${stats.cellCount.toLocaleString()} (filtered from ${cellCount.toLocaleString()} global)`
);
console.log(
  `  Mesh: ${stats.vertCount.toLocaleString()} verts, ${stats.triCount.toLocaleString()} tris`
);
console.log(`  Epochs: ${stats.epochCount} × ${EPOCH_INTERVAL}s (${stats.shardCount} shards)`);
console.log(`  Duration: ${(stats.durationMs / 1000).toFixed(1)}s`);

// ─── Step 9: Generate tiled mesh + patch manifest with meshTiles ───

const TILE_DIR = resolve(MESH_DIR, `h3-l${H3_RES}`);
const tileManifestPath = resolve(TILE_DIR, 'tiles.manifest.json');

if (!existsSync(tileManifestPath)) {
  console.log(`\nStep 9: Generating tiled meshes for L${H3_RES}...`);
  const tileScript = resolve(__dirname, '../generate-mesh-tiles.js');
  execFileSync(process.execPath, [tileScript, '--level', String(H3_RES)], {
    stdio: 'inherit',
  });
} else {
  console.log(`\nStep 9: Tiled meshes already exist at ${TILE_DIR}`);
}

// Patch manifest with meshTiles field
const manifestPath = resolve(OUTPUT_DIR, 'demand_metrics.manifest.json');
const manifestData = JSON.parse(readFileSync(manifestPath, 'utf8'));
const meshTilesRelative = `../../meshes/h3-l${H3_RES}/tiles.manifest.json`;

if (manifestData.meshTiles !== meshTilesRelative) {
  manifestData.meshTiles = meshTilesRelative;
  writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
  console.log(`  Patched manifest with meshTiles: ${meshTilesRelative}`);
} else {
  console.log(`  Manifest already has meshTiles`);
}

console.log('\n=== All done! ===');
