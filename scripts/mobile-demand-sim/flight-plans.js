#!/usr/bin/env node
/**
 * flight-plans.js — Shared flight generation module.
 *
 * Generates realistic GLOBAL flight plans with timezone-aware departure
 * patterns over a full 24-hour UTC day (1440 epochs × 1 minute).
 *
 * Departure model:
 *   - Each airport departs based on LOCAL time, offset by its UTC timezone.
 *   - Peak departures: 9am–1pm local (business + leisure travel)
 *   - Morning rush: 6am–9am local (~60% of peak)
 *   - Afternoon: 1pm–5pm (~80% of peak)
 *   - Evening taper: 5pm–8pm (~40%)
 *   - Late evening: 8pm–10pm (~15%)
 *   - Red-eye overnight: 10pm–5am (~2-5%)
 *
 * Route selection:
 *   - 60% domestic/regional (same continent)
 *   - 30% intercontinental (nearby continents)
 *   - 10% long-haul (opposite side of globe)
 *
 * Used by both generate-gfb-data.js and generate-h3-data.js.
 */

// ─── Configuration ───
export const EPOCH_COUNT = 1440; // 24 hours at 1-min intervals
export const EPOCH_INTERVAL = 60; // 1 minute in seconds
export const EPOCH_MINUTES = EPOCH_INTERVAL / 60; // 1 minute per epoch
export const SPEED_MPH = 540; // Typical cruise speed
export const EARTH_RADIUS_MILES = 3958.8;

// ─── Global Airport Database ───
// Each airport has a utcOffset (hours) and region tag for route selection.

export const AIRPORTS = [
  // ─── North America ───
  // US Major hubs
  { code: 'ATL', lat: 33.64, lon: -84.43, weight: 12, utcOffset: -5, region: 'NA' },
  { code: 'DFW', lat: 32.9, lon: -97.04, weight: 10, utcOffset: -6, region: 'NA' },
  { code: 'DEN', lat: 39.86, lon: -104.67, weight: 9, utcOffset: -7, region: 'NA' },
  { code: 'ORD', lat: 41.97, lon: -87.91, weight: 11, utcOffset: -6, region: 'NA' },
  { code: 'LAX', lat: 33.94, lon: -118.41, weight: 11, utcOffset: -8, region: 'NA' },
  { code: 'JFK', lat: 40.64, lon: -73.78, weight: 10, utcOffset: -5, region: 'NA' },
  { code: 'SFO', lat: 37.62, lon: -122.38, weight: 8, utcOffset: -8, region: 'NA' },
  { code: 'SEA', lat: 47.45, lon: -122.31, weight: 7, utcOffset: -8, region: 'NA' },
  { code: 'MIA', lat: 25.79, lon: -80.29, weight: 9, utcOffset: -5, region: 'NA' },
  { code: 'MCO', lat: 28.43, lon: -81.31, weight: 7, utcOffset: -5, region: 'NA' },
  // US Large
  { code: 'CLT', lat: 35.21, lon: -80.94, weight: 6, utcOffset: -5, region: 'NA' },
  { code: 'EWR', lat: 40.69, lon: -74.17, weight: 7, utcOffset: -5, region: 'NA' },
  { code: 'PHX', lat: 33.44, lon: -112.01, weight: 6, utcOffset: -7, region: 'NA' },
  { code: 'IAH', lat: 29.98, lon: -95.34, weight: 7, utcOffset: -6, region: 'NA' },
  { code: 'BOS', lat: 42.36, lon: -71.01, weight: 6, utcOffset: -5, region: 'NA' },
  { code: 'MSP', lat: 44.88, lon: -93.22, weight: 5, utcOffset: -6, region: 'NA' },
  { code: 'DTW', lat: 42.21, lon: -83.35, weight: 5, utcOffset: -5, region: 'NA' },
  { code: 'LGA', lat: 40.78, lon: -73.87, weight: 5, utcOffset: -5, region: 'NA' },
  { code: 'PHL', lat: 39.87, lon: -75.24, weight: 5, utcOffset: -5, region: 'NA' },
  { code: 'DCA', lat: 38.85, lon: -77.04, weight: 4, utcOffset: -5, region: 'NA' },
  // US Medium
  { code: 'SAN', lat: 32.73, lon: -117.19, weight: 4, utcOffset: -8, region: 'NA' },
  { code: 'TPA', lat: 27.98, lon: -82.53, weight: 4, utcOffset: -5, region: 'NA' },
  { code: 'PDX', lat: 45.59, lon: -122.59, weight: 4, utcOffset: -8, region: 'NA' },
  { code: 'SLC', lat: 40.79, lon: -111.98, weight: 5, utcOffset: -7, region: 'NA' },
  { code: 'LAS', lat: 36.08, lon: -115.15, weight: 6, utcOffset: -8, region: 'NA' },
  { code: 'BWI', lat: 39.18, lon: -76.67, weight: 4, utcOffset: -5, region: 'NA' },
  { code: 'FLL', lat: 26.07, lon: -80.15, weight: 4, utcOffset: -5, region: 'NA' },
  { code: 'AUS', lat: 30.19, lon: -97.67, weight: 4, utcOffset: -6, region: 'NA' },
  { code: 'BNA', lat: 36.12, lon: -86.68, weight: 3, utcOffset: -6, region: 'NA' },
  { code: 'MSY', lat: 29.99, lon: -90.26, weight: 3, utcOffset: -6, region: 'NA' },
  // Canada
  { code: 'YYZ', lat: 43.68, lon: -79.63, weight: 6, utcOffset: -5, region: 'NA' },
  { code: 'YVR', lat: 49.19, lon: -123.18, weight: 4, utcOffset: -8, region: 'NA' },
  { code: 'YUL', lat: 45.47, lon: -73.74, weight: 4, utcOffset: -5, region: 'NA' },
  { code: 'YYC', lat: 51.12, lon: -114.01, weight: 3, utcOffset: -7, region: 'NA' },
  // Mexico & Central America
  { code: 'MEX', lat: 19.44, lon: -99.07, weight: 7, utcOffset: -6, region: 'NA' },
  { code: 'CUN', lat: 21.04, lon: -86.87, weight: 5, utcOffset: -5, region: 'NA' },
  { code: 'GDL', lat: 20.52, lon: -103.31, weight: 3, utcOffset: -6, region: 'NA' },
  { code: 'SJO', lat: 10.0, lon: -84.21, weight: 2, utcOffset: -6, region: 'NA' },
  { code: 'PTY', lat: 9.07, lon: -79.38, weight: 3, utcOffset: -5, region: 'NA' },
  // Caribbean
  { code: 'NAS', lat: 25.04, lon: -77.47, weight: 2, utcOffset: -5, region: 'NA' },
  { code: 'SJU', lat: 18.44, lon: -66.0, weight: 3, utcOffset: -4, region: 'NA' },
  { code: 'MBJ', lat: 18.5, lon: -77.91, weight: 2, utcOffset: -5, region: 'NA' },

  // ─── Europe ───
  { code: 'LHR', lat: 51.47, lon: -0.46, weight: 12, utcOffset: 0, region: 'EU' },
  { code: 'CDG', lat: 49.01, lon: 2.55, weight: 10, utcOffset: 1, region: 'EU' },
  { code: 'FRA', lat: 50.03, lon: 8.57, weight: 9, utcOffset: 1, region: 'EU' },
  { code: 'AMS', lat: 52.31, lon: 4.76, weight: 8, utcOffset: 1, region: 'EU' },
  { code: 'MAD', lat: 40.47, lon: -3.56, weight: 7, utcOffset: 1, region: 'EU' },
  { code: 'FCO', lat: 41.8, lon: 12.25, weight: 6, utcOffset: 1, region: 'EU' },
  { code: 'IST', lat: 41.26, lon: 28.74, weight: 10, utcOffset: 3, region: 'EU' },
  { code: 'DUB', lat: 53.42, lon: -6.27, weight: 4, utcOffset: 0, region: 'EU' },
  { code: 'LIS', lat: 38.77, lon: -9.13, weight: 4, utcOffset: 0, region: 'EU' },
  { code: 'ZRH', lat: 47.46, lon: 8.55, weight: 5, utcOffset: 1, region: 'EU' },
  { code: 'BCN', lat: 41.3, lon: 2.08, weight: 5, utcOffset: 1, region: 'EU' },
  { code: 'MUC', lat: 48.35, lon: 11.79, weight: 6, utcOffset: 1, region: 'EU' },
  { code: 'CPH', lat: 55.62, lon: 12.66, weight: 4, utcOffset: 1, region: 'EU' },
  { code: 'OSL', lat: 60.19, lon: 11.1, weight: 3, utcOffset: 1, region: 'EU' },
  { code: 'ARN', lat: 59.65, lon: 17.94, weight: 3, utcOffset: 1, region: 'EU' },
  { code: 'HEL', lat: 60.32, lon: 24.97, weight: 3, utcOffset: 2, region: 'EU' },
  { code: 'ATH', lat: 37.94, lon: 23.94, weight: 3, utcOffset: 2, region: 'EU' },
  { code: 'VIE', lat: 48.11, lon: 16.57, weight: 4, utcOffset: 1, region: 'EU' },

  // ─── Middle East ───
  { code: 'DXB', lat: 25.25, lon: 55.36, weight: 12, utcOffset: 4, region: 'ME' },
  { code: 'DOH', lat: 25.27, lon: 51.61, weight: 8, utcOffset: 3, region: 'ME' },
  { code: 'AUH', lat: 24.43, lon: 54.65, weight: 5, utcOffset: 4, region: 'ME' },
  { code: 'JED', lat: 21.68, lon: 39.16, weight: 5, utcOffset: 3, region: 'ME' },
  { code: 'TLV', lat: 32.01, lon: 34.89, weight: 4, utcOffset: 2, region: 'ME' },

  // ─── Asia-Pacific ───
  { code: 'HND', lat: 35.55, lon: 139.78, weight: 10, utcOffset: 9, region: 'AP' },
  { code: 'NRT', lat: 35.76, lon: 140.39, weight: 7, utcOffset: 9, region: 'AP' },
  { code: 'PEK', lat: 40.08, lon: 116.58, weight: 10, utcOffset: 8, region: 'AP' },
  { code: 'PVG', lat: 31.14, lon: 121.81, weight: 9, utcOffset: 8, region: 'AP' },
  { code: 'HKG', lat: 22.31, lon: 113.91, weight: 8, utcOffset: 8, region: 'AP' },
  { code: 'SIN', lat: 1.35, lon: 103.99, weight: 9, utcOffset: 8, region: 'AP' },
  { code: 'ICN', lat: 37.46, lon: 126.44, weight: 8, utcOffset: 9, region: 'AP' },
  { code: 'BKK', lat: 13.69, lon: 100.75, weight: 7, utcOffset: 7, region: 'AP' },
  { code: 'DEL', lat: 28.57, lon: 77.1, weight: 8, utcOffset: 5.5, region: 'AP' },
  { code: 'BOM', lat: 19.09, lon: 72.87, weight: 6, utcOffset: 5.5, region: 'AP' },
  { code: 'KUL', lat: 2.74, lon: 101.7, weight: 5, utcOffset: 8, region: 'AP' },
  { code: 'CGK', lat: -6.13, lon: 106.66, weight: 5, utcOffset: 7, region: 'AP' },
  { code: 'MNL', lat: 14.51, lon: 121.02, weight: 4, utcOffset: 8, region: 'AP' },
  { code: 'TPE', lat: 25.08, lon: 121.23, weight: 5, utcOffset: 8, region: 'AP' },
  { code: 'CAN', lat: 23.39, lon: 113.3, weight: 5, utcOffset: 8, region: 'AP' },

  // ─── Oceania ───
  { code: 'SYD', lat: -33.95, lon: 151.18, weight: 7, utcOffset: 11, region: 'OC' },
  { code: 'MEL', lat: -37.67, lon: 144.84, weight: 5, utcOffset: 11, region: 'OC' },
  { code: 'AKL', lat: -37.01, lon: 174.79, weight: 3, utcOffset: 13, region: 'OC' },
  { code: 'BNE', lat: -27.38, lon: 153.12, weight: 3, utcOffset: 10, region: 'OC' },

  // ─── South America ───
  { code: 'GRU', lat: -23.43, lon: -46.47, weight: 8, utcOffset: -3, region: 'SA' },
  { code: 'GIG', lat: -22.81, lon: -43.25, weight: 5, utcOffset: -3, region: 'SA' },
  { code: 'EZE', lat: -34.82, lon: -58.54, weight: 5, utcOffset: -3, region: 'SA' },
  { code: 'BOG', lat: 4.7, lon: -74.15, weight: 5, utcOffset: -5, region: 'SA' },
  { code: 'LIM', lat: -12.02, lon: -77.11, weight: 4, utcOffset: -5, region: 'SA' },
  { code: 'SCL', lat: -33.39, lon: -70.79, weight: 4, utcOffset: -4, region: 'SA' },
  { code: 'BSB', lat: -15.87, lon: -47.92, weight: 2, utcOffset: -3, region: 'SA' },

  // ─── Africa ───
  { code: 'JNB', lat: -26.14, lon: 28.25, weight: 5, utcOffset: 2, region: 'AF' },
  { code: 'CAI', lat: 30.12, lon: 31.41, weight: 5, utcOffset: 2, region: 'AF' },
  { code: 'ADD', lat: 8.98, lon: 38.8, weight: 3, utcOffset: 3, region: 'AF' },
  { code: 'NBO', lat: -1.32, lon: 36.93, weight: 3, utcOffset: 3, region: 'AF' },
  { code: 'CMN', lat: 33.37, lon: -7.59, weight: 3, utcOffset: 1, region: 'AF' },
  { code: 'LOS', lat: 6.58, lon: 3.32, weight: 3, utcOffset: 1, region: 'AF' },
  { code: 'CPT', lat: -33.97, lon: 18.6, weight: 3, utcOffset: 2, region: 'AF' },
];

// Group airports by region for route selection
const REGION_AIRPORTS = {};
for (const ap of AIRPORTS) {
  if (!REGION_AIRPORTS[ap.region]) REGION_AIRPORTS[ap.region] = [];
  REGION_AIRPORTS[ap.region].push(ap);
}
const ALL_REGIONS = Object.keys(REGION_AIRPORTS);

// ─── Seeded RNG ───
let rngState = 42;
function rng() {
  rngState = (rngState * 1664525 + 1013904223) & 0xffffffff;
  return (rngState >>> 0) / 0xffffffff;
}
function rngInt(min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// ─── Weighted airport selection ───
const weightedAll = [];
for (const ap of AIRPORTS) {
  for (let w = 0; w < ap.weight; w++) weightedAll.push(ap);
}

const weightedByRegion = {};
for (const region of ALL_REGIONS) {
  weightedByRegion[region] = [];
  for (const ap of REGION_AIRPORTS[region]) {
    for (let w = 0; w < ap.weight; w++) weightedByRegion[region].push(ap);
  }
}

function pickOrigin() {
  return weightedAll[rngInt(0, weightedAll.length - 1)];
}

function pickDest(origin) {
  const roll = rng();
  let pool;
  if (roll < 0.6) {
    // 60% domestic/regional — same region
    pool = weightedByRegion[origin.region];
  } else if (roll < 0.9) {
    // 30% intercontinental — different region
    pool = weightedAll;
  } else {
    // 10% long-haul — weighted toward distant regions
    const distantRegions = ALL_REGIONS.filter((r) => r !== origin.region);
    const pick = distantRegions[rngInt(0, distantRegions.length - 1)];
    pool = weightedByRegion[pick];
  }

  let ap;
  let attempts = 0;
  do {
    ap = pool[rngInt(0, pool.length - 1)];
    attempts++;
  } while (ap.code === origin.code && attempts < 20);
  return ap;
}

// ─── Departure probability by local hour ───
// Returns a probability multiplier [0, 1] for departures at a given local hour.
function departureProbability(localHour) {
  // Smooth piecewise model
  if (localHour < 5) return 0.02; // overnight red-eye
  if (localHour < 6) return 0.1; // pre-dawn
  if (localHour < 7) return 0.35; // early morning ramp
  if (localHour < 9) return 0.6; // morning rush
  if (localHour < 13) return 1.0; // peak (9am–1pm)
  if (localHour < 17) return 0.8; // afternoon
  if (localHour < 20) return 0.4; // evening taper
  if (localHour < 22) return 0.15; // late evening
  return 0.05; // overnight (10pm–midnight)
}

// ─── Great circle utilities ───
function toRad(d) {
  return (d * Math.PI) / 180;
}
function toDeg(r) {
  return (r * 180) / Math.PI;
}

export function greatCircleDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function greatCircleInterpolate(lat1, lon1, lat2, lon2, t) {
  const φ1 = toRad(lat1),
    λ1 = toRad(lon1);
  const φ2 = toRad(lat2),
    λ2 = toRad(lon2);
  const d = greatCircleDistance(lat1, lon1, lat2, lon2) / EARTH_RADIUS_MILES;

  if (d < 1e-6) return [lat1, lon1];

  const a = Math.sin((1 - t) * d) / Math.sin(d);
  const b = Math.sin(t * d) / Math.sin(d);

  const x = a * Math.cos(φ1) * Math.cos(λ1) + b * Math.cos(φ2) * Math.cos(λ2);
  const y = a * Math.cos(φ1) * Math.sin(λ1) + b * Math.cos(φ2) * Math.sin(λ2);
  const z = a * Math.sin(φ1) + b * Math.sin(φ2);

  return [toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))];
}

// ─── Altitude profile ───
export function altitudeProfile(t, cruiseAlt) {
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

/**
 * Generate all flight plans for a full 24h UTC day.
 *
 * Each flight is assigned a departure time based on the origin airport's
 * LOCAL time zone. The departure probability curve ensures realistic
 * temporal distribution: peak at 9am–1pm local, overnight taper, with
 * a small percentage of red-eye flights.
 *
 * Flights that departed before 00:00 UTC (i.e., negative departMinute)
 * are included if they're still airborne during the observation window.
 */
export function generateFlightPlans() {
  rngState = 42; // Reset seed for reproducibility

  const flights = [];
  const totalMinutes = EPOCH_COUNT * EPOCH_MINUTES; // 1440 minutes = 24 hours

  // We generate flights departing from -360 min (6h before midnight UTC)
  // through +1440 min (end of day). This ensures flights departing
  // late in the previous day (e.g., US evening) are still airborne
  // at 00:00 UTC.
  const TOTAL_ATTEMPTS = 200_000; // Generate many candidates, filter by probability

  for (let i = 0; i < TOTAL_ATTEMPTS; i++) {
    const origin = pickOrigin();
    const dest = pickDest(origin);

    const dist = greatCircleDistance(origin.lat, origin.lon, dest.lat, dest.lon);
    const flightDurationMin = (dist / SPEED_MPH) * 60;

    // Skip unrealistically short flights
    if (flightDurationMin < 30) continue;

    // Pick a random UTC departure minute across the full day + buffer
    const departMinuteUTC = rng() * (totalMinutes + 360) - 360;

    // Convert to local hour at origin airport
    const departHourUTC = departMinuteUTC / 60;
    const localHour = (((departHourUTC + origin.utcOffset) % 24) + 24) % 24;

    // Accept/reject based on departure probability at local hour
    const prob = departureProbability(localHour);
    if (rng() > prob) continue; // Reject — too unlikely at this hour

    // Cruise altitude varies by route distance
    let cruiseAlt;
    if (dist < 500) cruiseAlt = 28000 + rng() * 4000;
    else if (dist < 1500) cruiseAlt = 33000 + rng() * 4000;
    else if (dist < 4000) cruiseAlt = 35000 + rng() * 6000;
    else cruiseAlt = 37000 + rng() * 6000; // Ultra long-haul

    flights.push({
      id: i,
      origin,
      dest,
      dist,
      flightDurationMin,
      departMinute: departMinuteUTC,
      cruiseAlt,
    });
  }

  // Keep only flights that are airborne at some point during [0, 1440] minutes
  let activeFlights = flights.filter((f) => {
    const landMinute = f.departMinute + f.flightDurationMin;
    return landMinute > 0 && f.departMinute < totalMinutes;
  });

  if (activeFlights.length > 60000) {
    activeFlights = activeFlights.slice(0, 60000);
  }

  console.log(`  Total flight plans: ${flights.length}, active in window: ${activeFlights.length}`);

  // Log region breakdown
  const regionCounts = {};
  for (const f of activeFlights) {
    const r = f.origin.region;
    regionCounts[r] = (regionCounts[r] || 0) + 1;
  }
  console.log(
    `  Region breakdown: ${Object.entries(regionCounts)
      .map(([r, c]) => `${r}=${c}`)
      .join(', ')}`
  );

  return activeFlights;
}

/**
 * Get the position of a flight at a given epoch.
 * Returns null if the flight is not airborne.
 */
export function getFlightPositionAtEpoch(flight, epoch) {
  const epochMinutes = epoch * EPOCH_MINUTES;
  const elapsed = epochMinutes - flight.departMinute;

  if (elapsed < 0 || elapsed >= flight.flightDurationMin) {
    return null; // Not airborne
  }

  const t = elapsed / flight.flightDurationMin;
  const [lat, lon] = greatCircleInterpolate(
    flight.origin.lat,
    flight.origin.lon,
    flight.dest.lat,
    flight.dest.lon,
    t
  );
  const alt = altitudeProfile(t, flight.cruiseAlt);

  return { lat, lon, alt };
}

/**
 * Count active flights at a given epoch.
 */
export function countActiveFlights(flights, epoch) {
  let count = 0;
  for (const f of flights) {
    if (getFlightPositionAtEpoch(f, epoch)) count++;
  }
  return count;
}

export const AIRLINES = [
  // North America
  'Delta',
  'United',
  'American',
  'Southwest',
  'JetBlue',
  'Alaska',
  'Spirit',
  'Air Canada',
  'WestJet',
  'Aeromexico',
  // Europe
  'British Airways',
  'Lufthansa',
  'Air France',
  'KLM',
  'Ryanair',
  'Turkish Airlines',
  'Swiss',
  'Iberia',
  'SAS',
  'TAP Portugal',
  // Asia-Pacific
  'Singapore Airlines',
  'Cathay Pacific',
  'ANA',
  'JAL',
  'Korean Air',
  'Thai Airways',
  'Air India',
  'Qantas',
  'Air New Zealand',
  'China Southern',
  // Middle East
  'Emirates',
  'Qatar Airways',
  'Etihad',
  'Saudia',
  // South America & Africa
  'LATAM',
  'Avianca',
  'GOL',
  'Ethiopian Airlines',
  'South African Airways',
];

// Weighted airline selection — major carriers get proportionally more flights
export const AIRLINE_WEIGHTS = {
  // NA majors (high volume)
  Delta: 12,
  United: 11,
  American: 11,
  Southwest: 10,
  JetBlue: 5,
  Alaska: 5,
  Spirit: 4,
  'Air Canada': 6,
  WestJet: 3,
  Aeromexico: 3,
  // EU majors
  'British Airways': 8,
  Lufthansa: 8,
  'Air France': 7,
  KLM: 5,
  Ryanair: 7,
  'Turkish Airlines': 6,
  Swiss: 3,
  Iberia: 4,
  SAS: 2,
  'TAP Portugal': 2,
  // AP majors
  'Singapore Airlines': 5,
  'Cathay Pacific': 4,
  ANA: 5,
  JAL: 5,
  'Korean Air': 4,
  'Thai Airways': 3,
  'Air India': 4,
  Qantas: 4,
  'Air New Zealand': 2,
  'China Southern': 6,
  // ME
  Emirates: 8,
  'Qatar Airways': 6,
  Etihad: 4,
  Saudia: 3,
  // SA & AF
  LATAM: 5,
  Avianca: 3,
  GOL: 3,
  'Ethiopian Airlines': 3,
  'South African Airways': 2,
};

// Pre-expanded weighted pool for O(1) selection
export const WEIGHTED_AIRLINES = [];
for (const airline of AIRLINES) {
  const w = AIRLINE_WEIGHTS[airline] || 1;
  for (let i = 0; i < w; i++) WEIGHTED_AIRLINES.push(airline);
}

/** Pick an airline using weighted distribution */
export function pickWeightedAirline(rngFn) {
  return WEIGHTED_AIRLINES[Math.floor(rngFn() * WEIGHTED_AIRLINES.length)];
}

// ─── Demand Model ───
// Low-priority (budget/LCC) airlines have capped demand at 3 Mbps
export const LOW_PRIORITY_AIRLINES = new Set(['Spirit', 'Ryanair', 'GOL', 'WestJet', 'JetBlue']);

/**
 * Get the max demand for a flight based on distance and airline tier.
 * - Long-haul (>2500 mi, widebody): 25 Mbps
 * - Medium-haul (800–2500 mi):      15 Mbps
 * - Short-haul (<800 mi):            5 Mbps
 * - Low-priority airline override:    3 Mbps
 */
export function getFlightMaxDemand(flight, airlineName) {
  // Low-priority airlines always cap at 3 Mbps regardless of route
  if (LOW_PRIORITY_AIRLINES.has(airlineName)) return 3;

  const dist = flight.dist;
  if (dist > 2500) return 25; // Long-haul widebody
  if (dist > 800) return 15; // Medium-haul
  return 5; // Short-haul
}

/**
 * Compute demand at a specific flight progress (0–1).
 * Demand scales with altitude: 0 on ground → maxDemand at cruise.
 * Uses the altitude profile curve for smooth climb/descent ramps.
 */
export function getFlightDemand(flight, airlineName, t) {
  const maxDemand = getFlightMaxDemand(flight, airlineName);
  // altitudeProfile returns altitude in feet (0 → cruiseAlt)
  // Normalize to 0–1 to scale demand
  const alt = altitudeProfile(t, flight.cruiseAlt);
  const altFactor = Math.min(alt / flight.cruiseAlt, 1.0);
  return maxDemand * altFactor;
}
