/**
 * epoch-worker.js — Worker thread for parallel epoch demand computation.
 *
 * All large data arrives via SharedArrayBuffer (zero-copy from main thread):
 *   - flightsBuf: Float64Array, 9 fields per flight
 *   - centersBuf: Float64Array, 2 values per cell (lat, lon)
 *   - gridOffsetsBuf/gridIndicesBuf: CSR-format spatial grid
 *   - demandBuffer: Float32Array output (workers write non-overlapping regions)
 *
 * Only gridKeys (64k strings) uses structured clone — insignificant overhead.
 */

import { workerData, parentPort } from 'worker_threads';

const {
  flightsBuf,
  flightCount,
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
  GRID_SIZE,
} = workerData;

// Wrap SharedArrayBuffers as typed arrays (zero-copy views)
const flights = new Float64Array(flightsBuf);
const cellCenters = new Float64Array(centersBuf);
const gridOffsets = new Int32Array(gridOffsetsBuf);
const gridIndices = new Int32Array(gridIndicesBuf);
const demandData = new Float32Array(demandBuffer);
const maxDemands = new Float32Array(maxDemandBuf);

// Inlined altitude profile (can't import from main module in worker)
function altitudeProfile(t, cruiseAlt) {
  const climbEnd = 0.12;
  const descentStart = 0.85;
  if (t < climbEnd) {
    const ct = t / climbEnd;
    return cruiseAlt * (1 - (1 - ct) * (1 - ct));
  } else if (t > descentStart) {
    const dt = (t - descentStart) / (1 - descentStart);
    return cruiseAlt * (1 - dt * dt);
  }
  return cruiseAlt;
}

// Build grid Map from gridKeys + CSR data
const cellGrid = new Map();
for (let i = 0; i < gridKeys.length; i++) {
  cellGrid.set(gridKeys[i], i); // Store index into CSR instead of bucket array
}

// Flight position computation (inlined to avoid importing h3-js in workers)
const EPOCH_MINUTES = EPOCH_INTERVAL / 60;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function greatCircleInterpolate(lat1, lon1, lat2, lon2, t) {
  const φ1 = lat1 * DEG2RAD,
    λ1 = lon1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD,
    λ2 = lon2 * DEG2RAD;
  const Δφ = φ2 - φ1,
    Δλ = λ2 - λ1;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const d = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  if (d < 1e-10) return [lat1, lon1];
  const A = Math.sin((1 - t) * d) / Math.sin(d);
  const B = Math.sin(t * d) / Math.sin(d);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return [Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD2DEG, Math.atan2(y, x) * RAD2DEG];
}

// Pre-compute constants
const R2 = 2 * DEMAND_RADIUS_DEG * DEMAND_RADIUS_DEG;
const cutoff = DEMAND_RADIUS_DEG * DEMAND_RADIUS_DEG * 4;
const searchRadius = Math.ceil((DEMAND_RADIUS_DEG * 2) / GRID_SIZE);

const GR2 = 2 * GROUND_RADIUS_DEG * GROUND_RADIUS_DEG;
const groundCutoff = GROUND_RADIUS_DEG * GROUND_RADIUS_DEG * 4;
const groundSearchRadius = Math.ceil((GROUND_RADIUS_DEG * 2) / GRID_SIZE);

function flightHash(id) {
  let h = id * 2654435761;
  return ((h >>> 0) & 0xffffffff) / 0xffffffff;
}

// Helper: look up grid bucket via CSR
function getGridBucket(key) {
  const idx = cellGrid.get(key);
  if (idx === undefined) return null;
  return { start: gridOffsets[idx], end: gridOffsets[idx + 1] };
}

let lastEpochFlightCount = 0;

for (let epoch = epochStart; epoch < epochEnd; epoch++) {
  const off = (epoch - epochStart) * cellCount;

  // Base supply
  for (let i = 0; i < cellCount; i++) {
    demandData[off + i] = BASE_SUPPLY;
  }

  // Airborne demand
  const epochMinutes = epoch * EPOCH_MINUTES;
  let activeCount = 0;

  for (let fi = 0; fi < flightCount; fi++) {
    const fo = fi * FLIGHT_FIELDS;
    const departMinute = flights[fo + 5];
    const flightDurationMin = flights[fo + 6];
    const elapsed = epochMinutes - departMinute;

    if (elapsed < 0 || elapsed >= flightDurationMin) continue;

    activeCount++;
    const t = elapsed / flightDurationMin;
    const [lat, lon] = greatCircleInterpolate(
      flights[fo + 1],
      flights[fo + 2],
      flights[fo + 3],
      flights[fo + 4],
      t
    );

    const centerGLat = Math.floor(lat / GRID_SIZE);
    const centerGLon = Math.floor(lon / GRID_SIZE);

    // Pre-compute altitude-scaled demand (constant for this flight at this epoch)
    const cruiseAlt = flights[fo + 8];
    const alt = altitudeProfile(t, cruiseAlt);
    const altFactor = cruiseAlt > 0 ? Math.min(alt / cruiseAlt, 1.0) : 1.0;
    const demand = maxDemands[fi] * altFactor;

    for (let dLat = -searchRadius; dLat <= searchRadius; dLat++) {
      for (let dLon = -searchRadius; dLon <= searchRadius; dLon++) {
        const bucket = getGridBucket(`${centerGLat + dLat},${centerGLon + dLon}`);
        if (!bucket) continue;

        for (let bi = bucket.start; bi < bucket.end; bi++) {
          const cellIdx = gridIndices[bi];
          const cLat = cellCenters[cellIdx * 2];
          const cLon = cellCenters[cellIdx * 2 + 1];
          const d2 = (cLat - lat) ** 2 + (cLon - lon) ** 2;
          if (d2 < cutoff) {
            demandData[off + cellIdx] += demand * Math.exp(-d2 / R2);
          }
        }
      }
    }
  }

  // Ground-state demand
  for (let fi = 0; fi < flightCount; fi++) {
    const fo = fi * FLIGHT_FIELDS;
    const departMinute = flights[fo + 5];
    const flightDurationMin = flights[fo + 6];
    const elapsed = epochMinutes - departMinute;

    const h = flightHash(flights[fo]); // id
    const preDwell = GROUND_DWELL_PRE_MIN + h * (GROUND_DWELL_PRE_MAX - GROUND_DWELL_PRE_MIN);
    const postDwell = GROUND_DWELL_POST_MIN + h * (GROUND_DWELL_POST_MAX - GROUND_DWELL_POST_MIN);
    const groundMbps = GROUND_MBPS_MIN + h * (GROUND_MBPS_MAX - GROUND_MBPS_MIN);

    let airportLat, airportLon;

    if (elapsed >= -preDwell && elapsed < 0) {
      airportLat = flights[fo + 1]; // origin lat
      airportLon = flights[fo + 2]; // origin lon
    } else if (elapsed >= flightDurationMin && elapsed < flightDurationMin + postDwell) {
      airportLat = flights[fo + 3]; // dest lat
      airportLon = flights[fo + 4]; // dest lon
    } else {
      continue;
    }

    const centerGLat = Math.floor(airportLat / GRID_SIZE);
    const centerGLon = Math.floor(airportLon / GRID_SIZE);

    for (let dLat = -groundSearchRadius; dLat <= groundSearchRadius; dLat++) {
      for (let dLon = -groundSearchRadius; dLon <= groundSearchRadius; dLon++) {
        const bucket = getGridBucket(`${centerGLat + dLat},${centerGLon + dLon}`);
        if (!bucket) continue;

        for (let bi = bucket.start; bi < bucket.end; bi++) {
          const cellIdx = gridIndices[bi];
          const cLat = cellCenters[cellIdx * 2];
          const cLon = cellCenters[cellIdx * 2 + 1];
          const d2 = (cLat - airportLat) ** 2 + (cLon - airportLon) ** 2;
          if (d2 < groundCutoff) {
            demandData[off + cellIdx] += groundMbps * Math.exp(-d2 / GR2);
          }
        }
      }
    }
  }

  // Clamp
  for (let i = 0; i < cellCount; i++) {
    demandData[off + i] = Math.min(150, demandData[off + i]);
  }

  lastEpochFlightCount = activeCount;
}

// Report completion
parentPort.postMessage({
  epochStart,
  epochEnd,
  activeCount: lastEpochFlightCount,
});
