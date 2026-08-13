// geo.js — Geographic coordinate math: WGS84, great circles, SLERP

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS = 1.0; // Normalized unit sphere

/**
 * Convert latitude/longitude (degrees) to 3D Cartesian coordinates on a unit sphere.
 * @param {number} lat - Latitude in degrees (-90 to 90)
 * @param {number} lon - Longitude in degrees (-180 to 180)
 * @param {number} [radius=1.0] - Sphere radius
 * @returns {Float32Array} [x, y, z]
 */
export function latLonToCartesian(lat, lon, radius = EARTH_RADIUS) {
  const latRad = lat * DEG2RAD;
  const lonRad = lon * DEG2RAD;
  const cosLat = Math.cos(latRad);
  return new Float32Array([
    radius * cosLat * Math.sin(lonRad), // x — east
    radius * Math.sin(latRad), // y — up (north pole)
    radius * cosLat * Math.cos(lonRad), // z — front (prime meridian)
  ]);
}

/**
 * Convert 3D Cartesian coordinates back to latitude/longitude (degrees).
 * @param {Float32Array} pos - [x, y, z]
 * @returns {{ lat: number, lon: number }}
 */
export function cartesianToLatLon(pos) {
  const r = Math.sqrt(pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2]);
  return {
    lat: Math.asin(pos[1] / r) * RAD2DEG,
    lon: Math.atan2(pos[0], pos[2]) * RAD2DEG,
  };
}

/**
 * Compute great circle distance between two points in radians.
 * Uses Haversine formula for numerical stability.
 * @param {number} lat1 - Latitude 1 (degrees)
 * @param {number} lon1 - Longitude 1 (degrees)
 * @param {number} lat2 - Latitude 2 (degrees)
 * @param {number} lon2 - Longitude 2 (degrees)
 * @returns {number} Angular distance in radians
 */
export function greatCircleDistance(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG2RAD;
  const φ2 = lat2 * DEG2RAD;
  const Δφ = (lat2 - lat1) * DEG2RAD;
  const Δλ = (lon2 - lon1) * DEG2RAD;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Spherical linear interpolation (SLERP) between two points on the unit sphere.
 * @param {number} lat1 - Start latitude (degrees)
 * @param {number} lon1 - Start longitude (degrees)
 * @param {number} lat2 - End latitude (degrees)
 * @param {number} lon2 - End longitude (degrees)
 * @param {number} t - Interpolation factor [0, 1]
 * @param {number} [radius=1.0] - Sphere radius
 * @returns {Float32Array} Interpolated [x, y, z] position
 */
export function greatCircleInterpolate(lat1, lon1, lat2, lon2, t, radius = EARTH_RADIUS) {
  const p1 = latLonToCartesian(lat1, lon1, 1.0);
  const p2 = latLonToCartesian(lat2, lon2, 1.0);

  const dot = p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2];
  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));

  if (theta < 0.000001) {
    // Points are essentially the same — just lerp
    return new Float32Array([
      radius * (p1[0] + t * (p2[0] - p1[0])),
      radius * (p1[1] + t * (p2[1] - p1[1])),
      radius * (p1[2] + t * (p2[2] - p1[2])),
    ]);
  }

  const sinTheta = Math.sin(theta);
  const a = Math.sin((1 - t) * theta) / sinTheta;
  const b = Math.sin(t * theta) / sinTheta;

  return new Float32Array([
    radius * (a * p1[0] + b * p2[0]),
    radius * (a * p1[1] + b * p2[1]),
    radius * (a * p1[2] + b * p2[2]),
  ]);
}

/**
 * Generate an array of waypoints along a great circle arc.
 * @param {number} lat1 - Start latitude
 * @param {number} lon1 - Start longitude
 * @param {number} lat2 - End latitude
 * @param {number} lon2 - End longitude
 * @param {number} segments - Number of segments (waypoints = segments + 1)
 * @param {number} [radius=1.0] - Sphere radius
 * @returns {Float32Array[]} Array of [x, y, z] waypoints
 */
export function generateGreatCircleArc(
  lat1,
  lon1,
  lat2,
  lon2,
  segments = 32,
  radius = EARTH_RADIUS
) {
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    points.push(greatCircleInterpolate(lat1, lon1, lat2, lon2, t, radius));
  }
  return points;
}

/**
 * Earth circumference at the equator in kilometres (WGS84).
 * Exposed so altitude↔zoom math can share the same constant.
 */
export const EARTH_CIRC_KM = 40075.016686;

/**
 * Earth mean radius in kilometres (used by spherical↔mercator camera-state
 * translation: distance = 1 + altKm / EARTH_RADIUS_KM on the unit sphere).
 */
export const EARTH_RADIUS_KM = 6371.0;

/**
 * Convert an altitude in kilometres to an approximate Web Mercator zoom level.
 * Based on:
 *   altitude ≈ EARTH_CIRCUMFERENCE * cos(lat) / (256 * 2^zoom)
 *
 * This is a heuristic — the exact zoom depends on viewport height — but it
 * gives a sensible starting zoom for a YAML camera spec and is what the 2D
 * project uses today (MapEngine.altitudeToZoom). Moved into core so both
 * projects (and the projection-toggle state translator) share one copy.
 *
 * @param {number} altitudeKm
 * @param {number} [latDeg=0]
 * @returns {number} Zoom clamped to [0, 22]
 */
export function altitudeToZoom(altitudeKm, latDeg = 0) {
  const z = Math.log2((EARTH_CIRC_KM * Math.cos((latDeg * Math.PI) / 180)) / altitudeKm);
  return Math.max(0, Math.min(22, z));
}

/**
 * Inverse of altitudeToZoom — useful for the spherical↔mercator camera state
 * translator (Phase 2 toggle work). Returns altitude in km that produces the
 * given Mercator zoom level at the given latitude.
 *
 * @param {number} zoom
 * @param {number} [latDeg=0]
 * @returns {number} Altitude in kilometres
 */
export function zoomToAltitude(zoom, latDeg = 0) {
  return (EARTH_CIRC_KM * Math.cos((latDeg * Math.PI) / 180)) / Math.pow(2, zoom);
}

export { DEG2RAD, RAD2DEG, EARTH_RADIUS };
