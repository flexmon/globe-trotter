/**
 * SphericalProjection — IProjection implementation for the 3D globe mode.
 *
 * Wraps the existing spherical projection math that's currently implicit in
 * tile.vert, h3hex.vert, and the rest of the layer shaders. Phase 1 gathers
 * the contract surface; Phase 2 wires `getGLSLProjection()` / `getWGSLProjection()`
 * into the unified shader header pipeline so layer shaders stop hard-coding
 * `lngLatToECEF()`.
 *
 * `project()` returns the X/Y of the unit-sphere ECEF position (Z dropped).
 * This is a flat 2D representation suitable for non-rendering use cases
 * (hit-testing in screen space, label collision, etc.). For full 3D position
 * use `getGLSLProjection()` which emits the vec3 form.
 *
 * ## Why getVisibleTiles / getViewportBounds are NOT implemented here
 *
 * Spherical tile selection is owned entirely by `TileManager.getVisibleTiles()`
 * for three reasons that make it unsuitable for a stateless projection helper:
 *
 *   1. It is inherently 3D — it must intersect the camera frustum with the
 *      unit sphere, handle the geometric horizon, and apply tilt-aware forward
 *      expansion. All of that math requires the camera position (a 3D vector),
 *      the distance-from-center scalar, and the look-point, none of which map
 *      cleanly onto the two-argument `(camera, viewport)` signature that the
 *      flat Mercator version uses.
 *
 *   2. It maintains per-frame state — a pooled tile-object allocator
 *      (`_tilePool`, `_tilePoolIdx`) and a bounded bounds cache
 *      (`_boundsCache`) that TileManager reuses across frames to eliminate GC
 *      pressure. Moving those into a projection object would either duplicate
 *      the state or require the projection to hold a TileManager reference,
 *      inverting the dependency.
 *
 *   3. It handles multiple zoom levels in one pass — the low-res Z=2 base-tile
 *      sweep that guarantees full globe coverage is deeply coupled to the
 *      same LRU cache and fetch queue as the high-res FOV tiles.
 *
 * Callers MUST dispatch by mode, not call these methods polymorphically:
 *   - Spherical: `tileManager.getVisibleTiles(cameraPos, distance, lookPt, tilt)`
 *   - Mercator:  `tileManager.getVisibleTilesMercator(lng, lat, zoom, w, h)`
 *
 * Both methods on this class throw with a descriptive error so any accidental
 * polymorphic call fails immediately at the call site rather than silently
 * returning empty results.
 */

import { latLonToCartesian } from '../math/geo.js';

/** Web Mercator world size at zoom 0 — used by lngLatToTile for tile addressing parity with Mercator. */
const WORLD_SIZE = 256;

export class SphericalProjection {
  constructor() {}

  /** @returns {'spherical'} */
  getMode() {
    return 'spherical';
  }

  /**
   * Forward project [lng, lat] to unit-sphere XY (Z dropped).
   *
   * The returned coordinates are the X and Y components of the 3D ECEF
   * position on the unit sphere. Use this when you need a 2D coordinate
   * for a spherical layer (rare); for actual rendering, the GPU shader
   * computes the full vec3 via the snippet from `getGLSLProjection()`.
   *
   * @param {number} lng
   * @param {number} lat
   * @returns {{ x: number, y: number }}
   */
  project(lng, lat) {
    const pos = latLonToCartesian(lat, lng, 1.0);
    return { x: pos[0], y: pos[1] };
  }

  /**
   * Inverse project from a 2D point back to [lng, lat]. Assumes the input
   * came from `project()` (i.e. lives on the visible hemisphere with Z >= 0).
   *
   * @param {number} x
   * @param {number} y
   * @returns {{ lng: number, lat: number }}
   */
  unproject(x, y) {
    const z2 = 1.0 - (x * x + y * y);
    const z = z2 > 0 ? Math.sqrt(z2) : 0;
    const lat = Math.asin(y) * (180 / Math.PI);
    const lng = Math.atan2(x, z) * (180 / Math.PI);
    return { lng, lat };
  }

  /**
   * XYZ tile addressing is identical between Mercator and Spherical (both
   * use Web Mercator tile coordinates — the spherical mode just texture-maps
   * those tiles onto the sphere). Same math as WebMercatorProjection.
   *
   * @param {number} lng
   * @param {number} lat
   * @param {number} zoom
   * @returns {{ tileX: number, tileY: number }}
   */
  lngLatToTile(lng, lat, zoom) {
    const n = Math.pow(2, zoom);
    const tileX = Math.floor(((lng + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const tileY = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    return { tileX, tileY };
  }

  /**
   * GLSL snippet defining `sphericalProject(vec2 lngLat) → vec3` — the unit
   * sphere ECEF position used by every spherical layer shader. Phase 2 will
   * extend this with `projectToClip(vec2 lngLat, float extrudeAmount) → vec4`
   * so the layer .vert files become projection-agnostic.
   *
   * @returns {string} GLSL function source
   */
  getGLSLProjection() {
    return /* glsl */ `
// Spherical (ECEF) projection — converts [lng, lat] degrees to unit-sphere XYZ.
// Y axis = north pole, X = east at prime meridian, Z = front (toward camera at lng=0,lat=0).
// This matches latLonToCartesian() in math/geo.js so CPU and GPU agree.

const float PI = 3.14159265358979323846;

vec3 sphericalProject(vec2 lngLat) {
  float latRad = lngLat.y * PI / 180.0;
  float lonRad = lngLat.x * PI / 180.0;
  float cosLat = cos(latRad);
  return vec3(
    cosLat * sin(lonRad),  // x — east
    sin(latRad),           // y — up
    cosLat * cos(lonRad)   // z — front
  );
}
`;
  }

  /**
   * WGSL equivalent of getGLSLProjection() for the WebGPU path.
   *
   * @returns {string} WGSL function source
   */
  getWGSLProjection() {
    return /* wgsl */ `
// Spherical (ECEF) projection — WGSL counterpart of sphericalProject().

fn sphericalProject(lngLat: vec2<f32>) -> vec3<f32> {
  let PI: f32 = 3.14159265358979323846;
  let latRad: f32 = lngLat.y * PI / 180.0;
  let lonRad: f32 = lngLat.x * PI / 180.0;
  let cosLat: f32 = cos(latRad);
  return vec3<f32>(
    cosLat * sin(lonRad),
    sin(latRad),
    cosLat * cos(lonRad)
  );
}
`;
  }

  /**
   * NOT IMPLEMENTED for spherical mode.
   *
   * Spherical tile selection requires 3D frustum × sphere intersection and
   * per-frame pooled state that lives in TileManager. Call
   * `TileManager.getVisibleTiles(cameraPos, distance, lookPt, tilt)` instead.
   * See the class-level comment block for the full rationale.
   *
   * @throws {Error} Always — this method must not be called on SphericalProjection.
   */
  getVisibleTiles() {
    throw new Error(
      '[SphericalProjection] getVisibleTiles() is not implemented. ' +
        'Use TileManager.getVisibleTiles(cameraPos, distance, lookPt, tilt) ' +
        'for spherical tile selection.'
    );
  }

  /**
   * NOT IMPLEMENTED for spherical mode.
   *
   * Spherical viewport bounds require frustum × sphere intersection; they
   * cannot be derived from a flat canvas rect. Call
   * `TileManager.cameraLatLon()` plus the frustum helpers in TileManager
   * to compute geographic coverage. See the class-level comment block.
   *
   * @throws {Error} Always — this method must not be called on SphericalProjection.
   */
  getViewportBounds() {
    throw new Error(
      '[SphericalProjection] getViewportBounds() is not implemented. ' +
        'Spherical viewport bounds require frustum × sphere intersection ' +
        'that lives in TileManager, not in the projection.'
    );
  }

  /**
   * Pre-bake geometry for rendering in this projection.
   * For spherical mode, this is an identity operation — no transformation needed.
   * Coordinates are already in the correct format (lng/lat or XYZ).
   *
   * @param {Float32Array} coords - input coordinates
   * @param {number} fpp - floats per position
   * @param {Uint32Array|Uint16Array} indices - triangle indices
   * @param {Object} [opts] - additional attributes to pass through
   * @returns {{ coords: Float32Array, indices: Uint32Array|Uint16Array }}
   */
  preBake(coords, fpp, indices, opts = {}) {
    // Spherical projection: identity — no transformation needed
    return { coords, indices, ...opts };
  }

  /**
   * Projection mode accessor (required by §C.5).
   * Returns the mode string for use in conditional dispatch.
   *
   * @returns {'spherical'}
   */
  get mode() {
    return 'spherical';
  }
}

export { WORLD_SIZE };
