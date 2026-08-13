/**
 * WebMercatorProjection — IProjection implementation for the flat 2D map mode.
 *
 * Implements the Web Mercator (EPSG:3857) projection. The CPU side handles
 * tile-coordinate math; the GPU side gets a GLSL/WGSL snippet that implements
 * reverse projection in the vertex shader.
 *
 * Moved verbatim from globe-trotter-2d/packages/map/src/projection/WebMercatorProjection.js
 * during the projection-consolidation refactor. The 2D project now re-exports
 * this from @globe-trotter/core so a single source of truth exists.
 *
 * `getVisibleTiles` and `getViewportBounds` are Phase 1 stubs (Mercator-only).
 * Callers should use `TileManager.getVisibleTilesMercator()` directly until
 * Phase 2 migrates that logic into these methods. `SphericalProjection` does
 * not implement these methods at all — see IProjection.js for the full
 * tile-selection asymmetry rationale.
 */

import { splitMercatorPolygon } from '../util/mercatorBake.js';

/** Web Mercator world size at zoom level 0 (in pixels, standard 256px tiles) */
const WORLD_SIZE = 256;

/** Maximum latitude supported by Web Mercator */
const MAX_LAT = 85.051129;

export class WebMercatorProjection {
  /**
   * Create a new WebMercatorProjection.
   * Initializes at zoom level 0 (the full world fits in a 256×256 pixel square).
   */
  constructor() {
    /** @type {number} Current zoom level */
    this.zoom = 0;
  }

  /** @returns {'mercator'} */
  getMode() {
    return 'mercator';
  }

  /**
   * Project [longitude, latitude] to [x, y] in world pixel space.
   *
   * @param {number} lng - Longitude in degrees
   * @param {number} lat - Latitude in degrees
   * @returns {{ x: number, y: number }}
   */
  project(lng, lat) {
    const scale = WORLD_SIZE * Math.pow(2, this.zoom);
    const x = ((lng + 180) / 360) * scale;
    const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const sinLat = Math.sin((clampedLat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    return { x, y };
  }

  /**
   * Unproject [x, y] world pixel coordinates to [longitude, latitude].
   *
   * @param {number} x - World pixel X coordinate (increases eastward)
   * @param {number} y - World pixel Y coordinate (increases southward, origin at top-left)
   * @returns {{ lng: number, lat: number }}
   */
  unproject(x, y) {
    const scale = WORLD_SIZE * Math.pow(2, this.zoom);
    const lng = (x / scale) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * y) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lng, lat };
  }

  /**
   * Compute the tile coordinates [tileX, tileY] for a given [lng, lat] at zoom.
   *
   * @param {number} lng - Longitude in degrees
   * @param {number} lat - Latitude in degrees (clamped to ±85.051129° by Web Mercator)
   * @param {number} zoom - Integer zoom level (0–22)
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
   * Return the GLSL shader snippet that implements Web Mercator reverse projection.
   * Used by layer shaders to project world coordinates to clip space.
   *
   * @returns {string} GLSL function source
   */
  getGLSLProjection() {
    return /* glsl */ `
// Web Mercator reverse projection — converts [lng, lat] to NDC clip space.
// u_worldSize   : total world size in pixels at the current zoom (256 * 2^zoom)
// u_cameraOffset: camera center in world pixels (centerX, centerY)
// u_viewportSize: canvas physical size in pixels (width, height)

uniform float u_worldSize;
uniform vec2 u_cameraOffset;
uniform vec2 u_viewportSize;

const float PI = 3.14159265358979323846;

vec2 mercatorProject(vec2 lngLat) {
  float x = (lngLat.x + 180.0) / 360.0 * u_worldSize;
  float sinLat = sin(lngLat.y * PI / 180.0);
  float y = (0.5 - log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * PI)) * u_worldSize;
  // Translate to screen space (origin = viewport center)
  float sx = (x - u_cameraOffset.x) / (u_viewportSize.x * 0.5);
  // Y is flipped: world Y increases downward, NDC Y increases upward
  float sy = -(y - u_cameraOffset.y) / (u_viewportSize.y * 0.5);
  return vec2(sx, sy);
}
`;
  }

  /**
   * WGSL equivalent of getGLSLProjection() for the WebGPU layer renderers.
   *
   * Phase 1 returns the same math expressed as a WGSL function. Bindings are
   * intentionally not declared here — the renderer's pipeline layout supplies
   * `worldSize`, `cameraOffset`, `viewportSize` in its uniform buffer.
   *
   * @returns {string} WGSL function source
   */
  getWGSLProjection() {
    return /* wgsl */ `
// Web Mercator reverse projection — WGSL counterpart of mercatorProject().
// Inputs are read from the projection-uniform struct supplied by the host.

fn mercatorProject(lngLat: vec2<f32>, worldSize: f32, cameraOffset: vec2<f32>, viewportSize: vec2<f32>) -> vec2<f32> {
  let PI: f32 = 3.14159265358979323846;
  let x: f32 = (lngLat.x + 180.0) / 360.0 * worldSize;
  let sinLat: f32 = sin(lngLat.y * PI / 180.0);
  let y: f32 = (0.5 - log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * PI)) * worldSize;
  let sx: f32 = (x - cameraOffset.x) / (viewportSize.x * 0.5);
  let sy: f32 = -(y - cameraOffset.y) / (viewportSize.y * 0.5);
  return vec2<f32>(sx, sy);
}
`;
  }

  /**
   * Compute the list of XYZ tiles needed to cover the viewport.
   *
   * MERCATOR-ONLY — Phase 1 stub: returns an empty array. The real
   * implementation will land in Phase 2, ported from the canvas-aligned
   * world-rect intersection in `TileManager.getVisibleTilesMercator()`.
   * Until then, callers must use `TileManager.getVisibleTilesMercator()`
   * directly. Do NOT call this method on a `SphericalProjection` — it throws.
   *
   * @param {Object} _camera
   * @param {{ width: number, height: number }} _viewport
   * @returns {Array<{ z: number, x: number, y: number }>}
   */
  getVisibleTiles(_camera, _viewport) {
    return [];
  }

  /**
   * Compute the geographic bounds of the current viewport.
   *
   * MERCATOR-ONLY — Phase 1 stub: returns full world bounds. Will be filled
   * in alongside `getVisibleTiles` in Phase 2 once the Mercator camera lands.
   * Do NOT call this method on a `SphericalProjection` — it throws.
   *
   * @param {Object} _camera
   * @param {{ width: number, height: number }} _viewport
   * @returns {{ minLng: number, minLat: number, maxLng: number, maxLat: number }}
   */
  getViewportBounds(_camera, _viewport) {
    return { minLng: -180, minLat: -MAX_LAT, maxLng: 180, maxLat: MAX_LAT };
  }

  /**
   * Pre-bake geometry for rendering in Web Mercator projection.
   * Delegates to splitMercatorPolygon to handle antimeridian crossing.
   * Crossing triangles are split into east+west slivers to avoid wrapping artifacts.
   *
   * @param {Float32Array} coords - input coordinates (lng/lat)
   * @param {number} fpp - floats per position (2 for lng/lat, 3 for lng/lat/alt)
   * @param {Uint32Array|Uint16Array} indices - triangle indices
   * @param {Object} [opts] - additional attributes (values, visibility, featureForVertex)
   * @returns {{ coords: Float32Array, indices: Uint32Array, ...opts }}
   */
  preBake(coords, fpp, indices, opts = {}) {
    // For lng/lat geometry, use splitMercatorPolygon
    if (fpp === 2 || fpp === 3) {
      const result = splitMercatorPolygon(coords, fpp, indices, opts);
      return {
        coords: result.mercPositions,
        indices: result.mercIndices,
        values: result.mercValues,
        visibility: result.mercVisibility,
        featureForVertex: result.mercFeatureForVertex,
        parentVertexMap: result.parentVertexMap,
      };
    }

    // Fallback: pass through (for any unexpected format)
    return { coords, indices, ...opts };
  }

  /**
   * Projection mode accessor (required by §C.5).
   * Returns the mode string for use in conditional dispatch.
   *
   * @returns {'mercator'}
   */
  get mode() {
    return 'mercator';
  }
}
