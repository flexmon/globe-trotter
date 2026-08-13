/**
 * globeGeo — JS twin of the globe geometry defined in the WGSL shaders.
 *
 * This is the single source of truth on the CPU for turning lat/lon/altitude into
 * globe-space XYZ, testing horizon visibility, and projecting to screen. It mirrors
 * `lat_lon_alt_to_xyz` and the geometric horizon test in gfbpoint.wgsl so that CPU
 * picking selects exactly what the GPU renders.
 *
 *   Globe is a unit sphere (radius 1.0). Y-axis = up (latitude). +Z front = lon −180°.
 *   Altitude is in feet, scaled by FEET_TO_GLOBE.
 */

export const FEET_TO_GLOBE = 1.0 / 20925525.0;
const DEG2RAD = Math.PI / 180;

/**
 * lat/lon (degrees) + altitude (feet) → globe-space [x, y, z]. Matches WGSL.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [altFeet=0]
 * @param {number[]|Float32Array} [out]
 * @returns {number[]|Float32Array}
 */
export function latLonAltToXYZ(lat, lon, altFeet = 0, out = [0, 0, 0]) {
  const theta = (90 - lat) * DEG2RAD; // colatitude
  const phi = (lon + 180) * DEG2RAD;
  const r = 1.0 + altFeet * FEET_TO_GLOBE;
  const sinT = Math.sin(theta);
  out[0] = sinT * Math.sin(phi) * r;
  out[1] = Math.cos(theta) * r;
  out[2] = sinT * Math.cos(phi) * r;
  return out;
}

/**
 * Geometric horizon test: a point in direction (lat,lon) is visible from the
 * camera when dot(unitDir, cameraPosition) >= 1.0 (mirrors gfbpoint.wgsl). Uses
 * the unit surface direction — altitude does not change visibility here.
 * @param {number} lat
 * @param {number} lon
 * @param {ArrayLike<number>} cameraPosition  [x, y, z] in globe space
 * @returns {boolean}
 */
export function isVisibleOverHorizon(lat, lon, cameraPosition) {
  const theta = (90 - lat) * DEG2RAD;
  const phi = (lon + 180) * DEG2RAD;
  const sinT = Math.sin(theta);
  const dx = sinT * Math.sin(phi);
  const dy = Math.cos(theta);
  const dz = sinT * Math.cos(phi);
  const dot = dx * cameraPosition[0] + dy * cameraPosition[1] + dz * cameraPosition[2];
  return dot >= 1.0;
}

/**
 * Project a lat/lon/alt point to canvas pixel coordinates.
 * @param {number} lat
 * @param {number} lon
 * @param {number} altFeet
 * @param {{ viewMatrix: ArrayLike<number>, projMatrix: ArrayLike<number>,
 *           cameraPosition: ArrayLike<number>, width: number, height: number }} cam
 * @returns {{ sx: number, sy: number, visible: boolean }}
 *          `visible` is false when the point is behind the horizon or behind the
 *          camera; sx/sy are NaN in the behind-camera case.
 */
export function projectToScreen(lat, lon, altFeet, cam) {
  const visible = isVisibleOverHorizon(lat, lon, cam.cameraPosition);
  const p = latLonAltToXYZ(lat, lon, altFeet);

  // view * p  then  proj * (view * p)   (column-major matrices)
  const v = _transform(cam.viewMatrix, p[0], p[1], p[2], 1);
  const c = _transform(cam.projMatrix, v[0], v[1], v[2], v[3]);

  const w = c[3];
  if (w <= 0) return { sx: NaN, sy: NaN, visible: false };

  const ndcX = c[0] / w;
  const ndcY = c[1] / w;
  return {
    sx: (ndcX * 0.5 + 0.5) * cam.width,
    sy: (1 - (ndcY * 0.5 + 0.5)) * cam.height,
    visible,
  };
}

/** Column-major mat4 × vec4. */
function _transform(m, x, y, z, w) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}
