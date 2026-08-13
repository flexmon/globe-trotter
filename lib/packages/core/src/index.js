/**
 * @globe-trotter/core — Public API.
 *
 * Usage:
 *   import { GlobeTrotterEngine, StyleEngine } from '@globe-trotter/core';
 *
 * This is the stable, supported surface. Engine internals (renderers, loaders,
 * decoders, camera, projection, math, UI widgets, …) live behind a separate
 * entry and may change between releases:
 *   import { LayerManager, CameraController } from '@globe-trotter/core/advanced';
 */

// ─── Primary API ───
export { GlobeTrotterEngine, WebGPURequiredError } from './GlobeTrotterEngine.js';

// ─── Styling ───
export { StyleEngine } from './styles/StyleEngine.js';

// ─── Query filter operators (value type) ───
export { FilterOp } from './query/QueryParser.js';

// ─── Geo value helpers / constants ───
export { altitudeToZoom, zoomToAltitude, EARTH_CIRC_KM, EARTH_RADIUS_KM } from './math/geo.js';
