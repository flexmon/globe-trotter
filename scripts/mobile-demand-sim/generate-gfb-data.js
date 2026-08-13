#!/usr/bin/env node
/**
 * generate-gfb-data.js — Generate realistic aircraft positions flying
 * great-circle routes from global airports.
 *
 * Uses GeoFlexEncoder from @globe-trotter/data-sdk for binary encoding.
 *
 * 24-hour window (UTC 00:00–24:00), 1-minute epochs, timezone-aware departures.
 *
 * Output: public/data/mobile-demand-sim/ (base + shards + manifest)
 *
 * Usage: node scripts/mobile-demand-sim/generate-gfb-data.js
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  generateFlightPlans,
  getFlightPositionAtEpoch,
  getFlightDemand,
  countActiveFlights,
  EPOCH_COUNT,
  EPOCH_INTERVAL,
  EPOCH_MINUTES,
  AIRLINES,
  pickWeightedAirline,
} from './flight-plans.js';
import { GeoFlexEncoder } from '../../lib/packages/data-sdk/src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('=== GeoFlex Binary Generator (Global 24h Flights) ===');
console.log(`Window: UTC 00:00–24:00, ${EPOCH_COUNT} epochs × ${EPOCH_INTERVAL}s`);

// ─── Step 1: Generate flight plans ───
console.log('Step 1: Generating flight plans...');
const allFlights = generateFlightPlans();
const FEATURE_COUNT = allFlights.length;
console.log(`  Features (unique aircraft): ${FEATURE_COUNT.toLocaleString()}`);

// Show airborne count at 2-hour intervals
for (let e = 0; e < EPOCH_COUNT; e += 120) {
  const active = countActiveFlights(allFlights, e);
  const utcHour = e / 60;
  console.log(`  Epoch ${e} (UTC ${utcHour.toFixed(0)}:00): ${active.toLocaleString()} in-flight`);
}

// ─── Step 2: Build dictionary ───
console.log('Step 2: Building string dictionary...');

let rngState2 = 77;
function rng2() {
  rngState2 = (rngState2 * 1664525 + 1013904223) & 0xffffffff;
  return (rngState2 >>> 0) / 0xffffffff;
}

const allStrings = new Set(AIRLINES);
const dictionary = Array.from(allStrings);
const dictMap = new Map();
dictionary.forEach((s, i) => dictMap.set(s, i));
console.log(`  Dictionary: ${dictionary.length.toLocaleString()} entries`);

// ─── Step 3: Build static attributes ───
console.log('Step 3: Building static attributes...');
const airlineIndices = new Uint16Array(FEATURE_COUNT);
for (let i = 0; i < FEATURE_COUNT; i++) {
  const airline = pickWeightedAirline(rng2);
  airlineIndices[i] = dictMap.get(airline);
}

// ─── Step 4: Build temporal position + demand data ───
console.log('Step 4: Computing positions for all epochs...');

const FLOATS_PER_POS = 3; // lon, lat, altitude
const positions = new Float32Array(EPOCH_COUNT * FEATURE_COUNT * FLOATS_PER_POS);
const demandData = new Float32Array(EPOCH_COUNT * FEATURE_COUNT);
const ewVelocity = new Float32Array(EPOCH_COUNT * FEATURE_COUNT);
const nsVelocity = new Float32Array(EPOCH_COUNT * FEATURE_COUNT);

for (let epoch = 0; epoch < EPOCH_COUNT; epoch++) {
  const offset = epoch * FEATURE_COUNT * FLOATS_PER_POS;

  for (let i = 0; i < FEATURE_COUNT; i++) {
    const flight = allFlights[i];
    const pos = getFlightPositionAtEpoch(flight, epoch);

    let lat, lon, alt;
    if (pos) {
      lat = pos.lat;
      lon = pos.lon;
      alt = pos.alt;
    } else {
      const epochMinutes = epoch * EPOCH_MINUTES;
      const elapsed = epochMinutes - flight.departMinute;
      if (elapsed < 0) {
        lat = flight.origin.lat;
        lon = flight.origin.lon;
      } else {
        lat = flight.dest.lat;
        lon = flight.dest.lon;
      }
      alt = 0;
    }

    const idx = offset + i * FLOATS_PER_POS;
    positions[idx] = lon;
    positions[idx + 1] = lat;
    positions[idx + 2] = alt;

    // Demand and Velocity
    if (pos) {
      const elapsed = epoch * EPOCH_MINUTES - flight.departMinute;
      const t = elapsed / flight.flightDurationMin;
      const airline = dictionary[airlineIndices[i]] || AIRLINES[0];
      demandData[epoch * FEATURE_COUNT + i] = getFlightDemand(flight, airline, t);

      const nextPos = getFlightPositionAtEpoch(flight, epoch + 1);
      if (nextPos) {
        const dLat = nextPos.lat - pos.lat;
        // Handle dateline crossing for longitude differences properly to avoid huge spikes
        let dLon = nextPos.lon - pos.lon;
        if (dLon > 180) dLon -= 360;
        if (dLon < -180) dLon += 360;

        const ns_ms = (dLat * 111320) / EPOCH_INTERVAL;
        const ew_ms = (dLon * 111320 * Math.cos((pos.lat * Math.PI) / 180.0)) / EPOCH_INTERVAL;
        ewVelocity[epoch * FEATURE_COUNT + i] = ew_ms;
        nsVelocity[epoch * FEATURE_COUNT + i] = ns_ms;
      } else {
        ewVelocity[epoch * FEATURE_COUNT + i] = 0;
        nsVelocity[epoch * FEATURE_COUNT + i] = 0;
      }
    } else {
      demandData[epoch * FEATURE_COUNT + i] = 0;
      ewVelocity[epoch * FEATURE_COUNT + i] = 0;
      nsVelocity[epoch * FEATURE_COUNT + i] = 0;
    }
  }

  if ((epoch + 1) % 60 === 0) {
    const active = countActiveFlights(allFlights, epoch);
    console.log(`  Epoch ${epoch + 1}/${EPOCH_COUNT} — ${active.toLocaleString()} active`);
  }
}

// ─── Step 5: Encode with GeoFlexEncoder ───
console.log('Step 5: Encoding with GeoFlexEncoder...');

const encoder = new GeoFlexEncoder({
  featureCount: FEATURE_COUNT,
  epochCount: EPOCH_COUNT,
  epochInterval: EPOCH_INTERVAL,
  geometryType: 'point',
  hasAltitude: true,
  gzipLevel: 1,
});

// Set dictionary and static columns
encoder.setDictionary(dictionary);
encoder.addStaticColumn('airline', 'enum16', airlineIndices);

// Set temporal position data (epoch-major: lon, lat, alt × features × epochs)
encoder.setPositions(positions);

// Set temporal demand attribute (epoch-major: features × epochs)
encoder.setTemporalData('demand_mbps', demandData);
encoder.setTemporalData('ewvelocity', ewVelocity);
encoder.setTemporalData('nsvelocity', nsVelocity);

// Encode — writes base + shards + manifest
const OUTPUT_DIR = resolve(__dirname, '../../public/data/mobile-demand-sim');
const { manifest, stats } = await encoder.encode({
  output: OUTPUT_DIR,
  baseName: 'aircraft_tracks',
  sharding: { epochsPerShard: 60, shardFormat: 'v3' },
  manifest: {
    startTimestamp: Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000),
  },
});

console.log(`\nDone! GeoFlexEncoder output:`);
console.log(`  Aircraft: ${stats.featureCount.toLocaleString()}`);
console.log(`  Epochs: ${stats.epochCount} × ${EPOCH_INTERVAL}s (${stats.shardCount} shards)`);
console.log(
  `  Bbox: [${manifest.bbox.minLon.toFixed(2)}, ${manifest.bbox.minLat.toFixed(2)}, ${manifest.bbox.maxLon.toFixed(2)}, ${manifest.bbox.maxLat.toFixed(2)}]`
);
console.log(`  Duration: ${(stats.durationMs / 1000).toFixed(1)}s`);
