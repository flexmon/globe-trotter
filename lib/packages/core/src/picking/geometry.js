/**
 * Exact geometry hit-test primitives for CPU picking.
 *
 * All coordinates are in (lng, lat) degrees unless noted.
 */

const DEG2RAD = Math.PI / 180;
const R = 6371008.8; // Earth mean radius, metres — used for deg→metre scaling at pick point

/**
 * Approximate metres-per-degree at a given latitude (for distance comparisons).
 */
function _mpdLat(lat) {
  return R * DEG2RAD;
}
function _mpdLng(lat) {
  return R * DEG2RAD * Math.cos(lat * DEG2RAD);
}

/**
 * Squared planar distance in (scaled) degrees space, corrected for lat stretching.
 * Returns a dimensionless value where threshold should be compared against
 * (pixelThresholdMetres / scale)^2 — but we keep everything in degrees².
 */
export function dist2(ax, ay, bx, by, cosLat) {
  const dx = (ax - bx) * cosLat;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Minimum squared distance from point (px, py) to line segment (ax,ay)→(bx,by).
 * Coordinates in degrees; cosLat corrects for longitude stretching.
 */
export function pointToSegmentDist2(px, py, ax, ay, bx, by, cosLat) {
  const dxS = (bx - ax) * cosLat;
  const dyS = by - ay;
  const lenSq = dxS * dxS + dyS * dyS;
  if (lenSq === 0) return dist2(px, py, ax, ay, cosLat);
  const t = Math.max(0, Math.min(1, ((px - ax) * cosLat * dxS + (py - ay) * dyS) / lenSq));
  const projX = ax + t * (bx - ax);
  const projY = ay + t * (by - ay);
  return dist2(px, py, projX, projY, cosLat);
}

/**
 * Point-in-polygon test using the winding number algorithm.
 * @param {number} px lng
 * @param {number} py lat
 * @param {Float64Array|number[]} ring  [x0,y0, x1,y1, ...] closed ring
 * @returns {boolean}
 */
export function pointInPolygon(px, py, ring) {
  const n = ring.length / 2;
  let winding = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2],
      yi = ring[i * 2 + 1];
    const xj = ring[j * 2],
      yj = ring[j * 2 + 1];
    if (yj <= py) {
      if (yi > py) {
        if ((xj - xi) * (py - yi) - (px - xi) * (yj - yi) < 0) winding++;
      }
    } else {
      if (yi <= py) {
        if ((xj - xi) * (py - yi) - (px - xi) * (yj - yi) > 0) winding--;
      }
    }
  }
  return winding !== 0;
}
