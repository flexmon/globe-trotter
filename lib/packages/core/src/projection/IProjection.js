/**
 * IProjection — contract every projection implementation must satisfy.
 *
 * This file is documentation-only: JavaScript has no interface keyword, so we
 * describe the contract via JSDoc and a runtime sanity-check helper. Concrete
 * implementations (SphericalProjection, WebMercatorProjection, ...) must
 * provide every method below.
 *
 * The contract lets the engine, camera, tile manager, and layer renderers stay
 * projection-agnostic. They consume `engine.projection` and call into the
 * methods here; switching projections is a single assignment + event emit.
 *
 * ## Tile-selection asymmetry
 *
 * `getVisibleTiles` and `getViewportBounds` are intentionally Mercator-only
 * methods, even though they appear on both projection classes. In spherical
 * mode, tile selection is owned entirely by `TileManager.getVisibleTiles()`
 * because it requires 3D frustum × sphere intersection, tilt-aware horizon
 * expansion, a pooled tile-object allocator, and a multi-zoom base-tile pass —
 * none of which fit cleanly into a stateless projection helper. Mercator tile
 * selection is simpler (canvas-aligned world-rect intersection) and will
 * eventually migrate into `WebMercatorProjection.getVisibleTiles()` as a
 * Phase 2 clean-up, but callers must always check `engine.projection.getMode()`
 * and dispatch to the correct code path: `TileManager.getVisibleTiles()` for
 * spherical, `TileManager.getVisibleTilesMercator()` for Mercator.
 *
 * Do NOT call `projection.getVisibleTiles()` or `projection.getViewportBounds()`
 * from any spherical render path — `SphericalProjection` throws on those calls.
 *
 * @typedef {Object} IProjection
 * @property {() => 'spherical' | 'mercator'} getMode
 *   Identifier for the projection type. Used by code paths that must branch
 *   (e.g. globe-sphere render skipped in Mercator mode).
 *
 * @property {(lng: number, lat: number) => { x: number, y: number }} project
 *   Forward projection: geographic coordinates to a projection-defined
 *   coordinate space. Spherical returns unit-sphere XY (Z dropped). Mercator
 *   returns world-pixel coordinates at the current zoom.
 *
 * @property {(x: number, y: number) => { lng: number, lat: number }} unproject
 *   Inverse projection. The Mercator implementation depends on the current
 *   zoom level; spherical is zoom-independent.
 *
 * @property {(lng: number, lat: number, zoom: number) => { tileX: number, tileY: number }} lngLatToTile
 *   Compute the integer tile coordinates containing the given geographic
 *   point at the given zoom. Both projections use the same XYZ tile addressing,
 *   so this is identical math; kept on the projection for symmetry.
 *
 * @property {() => string} getGLSLProjection
 *   Returns a GLSL source snippet that defines `projectToClip(vec2 lngLat,
 *   float extrudeAmount) → vec4` plus any uniforms it needs. Injected as a
 *   shader header by `gl/ShaderUtils.js` at compile time so a single .vert
 *   file works for any projection.
 *
 * @property {() => string} getWGSLProjection
 *   WGSL equivalent of `getGLSLProjection()` for the WebGPU path.
 *
 * @property {(camera: Object, viewport: { width: number, height: number }) => Array<{ z: number, x: number, y: number }>} getVisibleTiles
 *   MERCATOR-ONLY — Phase 1 stub (returns []). Real implementation lands in
 *   Phase 2 as a canvas-aligned world-rect intersection. Spherical tile
 *   selection is handled entirely by `TileManager.getVisibleTiles()`; calling
 *   this method on a `SphericalProjection` throws an Error by design.
 *   See the "Tile-selection asymmetry" note above.
 *
 * @property {(camera: Object, viewport: { width: number, height: number }) => { minLng: number, minLat: number, maxLng: number, maxLat: number }} getViewportBounds
 *   MERCATOR-ONLY — Phase 1 stub (returns world bounds). Spherical viewport
 *   bounds come from the frustum × sphere intersection in TileManager; calling
 *   this method on a `SphericalProjection` throws an Error by design.
 *   See the "Tile-selection asymmetry" note above.
 */

/**
 * Throws if `proj` is missing any core IProjection method. Useful in test
 * setups and engine init to fail fast on incomplete implementations.
 *
 * Note: `getVisibleTiles` and `getViewportBounds` are intentionally excluded
 * from this check because they are Mercator-only helpers — SphericalProjection
 * deliberately throws on those calls rather than implementing them. Code that
 * needs tile selection must dispatch via projection.getMode(), not call those
 * methods polymorphically.
 *
 * @param {unknown} proj
 * @returns {asserts proj is IProjection}
 */
export function assertIsProjection(proj) {
  const required = [
    'getMode',
    'project',
    'unproject',
    'lngLatToTile',
    'getGLSLProjection',
    'getWGSLProjection',
  ];
  if (!proj || typeof proj !== 'object') {
    throw new TypeError('[IProjection] expected an object');
  }
  for (const method of required) {
    if (typeof proj[method] !== 'function') {
      throw new TypeError(`[IProjection] missing required method: ${method}`);
    }
  }
}
