#!/usr/bin/env node
/**
 * generate-mfb-data.js — Generate MetricFlex Binary (MFB) airline revenue data.
 *
 * Produces a single MFB file with per-airline revenue metrics derived from
 * aggregated demand data.
 *
 * Uses @globe-trotter/data-sdk MetricFlexEncoder for binary encoding.
 *
 * Revenue is calculated as: demand_mbps per flight × airline pricing tier / 1e6
 *
 * Usage: node scripts/mobile-demand-sim/generate-mfb-data.js
 */

import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  generateFlightPlans,
  getFlightPositionAtEpoch,
  getFlightDemand,
  EPOCH_COUNT,
  EPOCH_INTERVAL,
  AIRLINES,
  AIRLINE_WEIGHTS,
  pickWeightedAirline,
} from './flight-plans.js';
import { MetricFlexEncoder } from '../../lib/packages/data-sdk/src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../../public/data/mobile-demand-sim');
mkdirSync(OUT_DIR, { recursive: true });

// ─── Pricing Tiers ───
// Satellite IFC bandwidth pricing ($/TB) scaled to produce realistic
// airline revenue (~$5M/month for top carriers like Delta).
const PRICE_PER_TB = {};
for (const airline of AIRLINES) {
  const w = AIRLINE_WEIGHTS[airline] || 1;
  const base = 1_800_000; // ~$1.8M/TB base (premium satellite IFC)
  PRICE_PER_TB[airline] = base / (1 + Math.log2(1 + w));
}

console.log('=== MetricFlex Binary Generator (Airline Revenue) ===');
console.log(`  Epochs: ${EPOCH_COUNT} × ${EPOCH_INTERVAL}s`);

// ─── Step 1: Generate flights ───
console.log('Step 1: Generating flight plans...');
const allFlights = generateFlightPlans();
const FEATURE_COUNT = allFlights.length;
console.log(`  Features (unique aircraft): ${FEATURE_COUNT.toLocaleString()}`);

// ─── Step 2: Assign airlines ───
console.log('Step 2: Assigning airlines...');

let rngState2 = 77;
function rng2() {
  rngState2 = (rngState2 * 1664525 + 1013904223) & 0xffffffff;
  return (rngState2 >>> 0) / 0xffffffff;
}

const airlinePerFlight = new Array(FEATURE_COUNT);
for (let i = 0; i < FEATURE_COUNT; i++) {
  airlinePerFlight[i] = pickWeightedAirline(rng2);
}

// ─── Step 3: Compute revenue ───
console.log('Step 3: Computing revenue per flight per epoch...');

const revenueData = new Float32Array(EPOCH_COUNT * FEATURE_COUNT);

for (let epoch = 0; epoch < EPOCH_COUNT; epoch++) {
  for (let i = 0; i < FEATURE_COUNT; i++) {
    const flight = allFlights[i];
    const pos = getFlightPositionAtEpoch(flight, epoch);
    if (!pos) {
      revenueData[epoch * FEATURE_COUNT + i] = 0;
      continue;
    }
    // Compute flight progress (0→1) for demand lookup
    const epochMinutes = epoch * (EPOCH_INTERVAL / 60);
    const elapsed = epochMinutes - flight.departMinute;
    const t = elapsed / flight.flightDurationMin;
    const airline = airlinePerFlight[i];
    const demandMbps = getFlightDemand(flight, airline, t);
    const bandwidthTbps = demandMbps / 1e6;
    const intervalHours = EPOCH_INTERVAL / 3600;
    const revenue = bandwidthTbps * PRICE_PER_TB[airline] * intervalHours;
    revenueData[epoch * FEATURE_COUNT + i] = revenue;
  }

  if ((epoch + 1) % 120 === 0) {
    console.log(`  Epoch ${epoch + 1}/${EPOCH_COUNT}`);
  }
}

// Print top airlines
const airlineRevTotals = {};
for (const a of AIRLINES) airlineRevTotals[a] = 0;
for (let epoch = 0; epoch < EPOCH_COUNT; epoch++) {
  for (let i = 0; i < FEATURE_COUNT; i++) {
    airlineRevTotals[airlinePerFlight[i]] += revenueData[epoch * FEATURE_COUNT + i];
  }
}
const sortedAirlines = Object.entries(airlineRevTotals).sort((a, b) => b[1] - a[1]);
console.log('\n  Top 10 airlines by 24h revenue:');
for (let i = 0; i < Math.min(10, sortedAirlines.length); i++) {
  const [name, rev] = sortedAirlines[i];
  console.log(`    ${(i + 1).toString().padStart(2)}. ${name.padEnd(25)} $${rev.toFixed(2)}`);
}

// ─── Step 4: Encode with MetricFlexEncoder ───
console.log('\nStep 4: Encoding with MetricFlexEncoder...');

const entityIds = new Uint32Array(FEATURE_COUNT);
for (let i = 0; i < FEATURE_COUNT; i++) entityIds[i] = i;

const encoder = new MetricFlexEncoder({
  entityCount: FEATURE_COUNT,
  epochCount: EPOCH_COUNT,
  epochInterval: EPOCH_INTERVAL,
  startTimestamp: Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000),
});

encoder.setEntityIds('tail_id', entityIds);
encoder.addColumn('airline', airlinePerFlight);
encoder.addColumn('revenue_usd', revenueData, { temporal: true });

const { stats } = await encoder.encode({
  output: OUT_DIR,
  baseName: 'airline_revenue',
  sharding: { epochsPerShard: 60, shardFormat: 'v3' },
});

console.log(`\n✅ MFB generation complete!`);
console.log(`  Entities: ${stats.entityCount.toLocaleString()}`);
if (stats.shardCount) {
  console.log(
    `  Shards: ${stats.shardCount} (base: ${(stats.baseBytes / 1e6).toFixed(2)} MB, shards: ${(stats.totalShardBytes / 1e6).toFixed(1)} MB)`
  );
} else {
  console.log(`  File size: ${(stats.fileSizeBytes / 1e6).toFixed(1)} MB`);
}
console.log(`  Duration: ${(stats.durationMs / 1000).toFixed(1)}s`);
