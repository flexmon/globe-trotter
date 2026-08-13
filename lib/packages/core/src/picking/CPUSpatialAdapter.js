/**
 * CPUSpatialAdapter — pick adapter for static, CPU-resident vector data (GeoJSON).
 *
 * Wraps a SpatialIndex (KDBush for points, RBush for lines/polygons) and exposes
 * the source-neutral adapter interface consumed by PickController:
 *   pick(ctx) -> { featureIndex } | null
 *   getProperties(featureIndex) -> object
 *
 * Tolerance is owned here (degree-space), since it is specific to this adapter's
 * screen→surface lat/lon model. Screen-space / GPU adapters use pixel tolerance.
 */

import { SpatialIndex } from './SpatialIndex.js';

const TOLERANCE_DEG_POINT = 0.5;
const TOLERANCE_DEG_LINE = 0.25;
const TOLERANCE_DEG_POLYGON = 0.0; // bounding-box + point-in-polygon, no tolerance needed

export class CPUSpatialAdapter {
  /**
   * @param {object} data  Output of geojsonToFeatures()
   * @param {'points'|'lines'|'polygons'} kind
   */
  constructor(data, kind) {
    this._data = data;
    this._kind = kind;
    this._tol =
      kind === 'points'
        ? TOLERANCE_DEG_POINT
        : kind === 'lines'
          ? TOLERANCE_DEG_LINE
          : TOLERANCE_DEG_POLYGON;
    this._index = new SpatialIndex();
    this._index.build(kind, data);
  }

  /**
   * @param {{ geo: { lng: number, lat: number } | null }} ctx
   * @returns {{ featureIndex: number } | null}
   */
  pick(ctx) {
    const geo = ctx?.geo;
    if (!geo) return null;
    const hit = this._index.query(geo.lng, geo.lat, this._tol);
    return hit ? { featureIndex: hit.featureIndex } : null;
  }

  /** @param {number} featureIndex @returns {object} */
  getProperties(featureIndex) {
    return this._data._featureStore?.[featureIndex]?.properties || {};
  }
}
