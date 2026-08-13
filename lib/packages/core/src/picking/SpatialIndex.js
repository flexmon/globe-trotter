/**
 * SpatialIndex — per-layer spatial index for CPU picking.
 *
 * Points   → KDBush (static k-d tree) on packedPositions
 * Lines    → RBush  AABB per feature + exact segment distance on _featureStore geometry
 * Polygons → RBush  AABB per feature + point-in-polygon on _featureStore geometry
 *
 * All exact tests use the original GeoJSON coordinates from _featureStore.geometry,
 * which avoids inverting the packed GPU buffers.
 */

import KDBush from 'kdbush';
import RBush from 'rbush';
import { pointToSegmentDist2, pointInPolygon, dist2 } from './geometry.js';

export class SpatialIndex {
  constructor() {
    this._kind = null;
    this._featureStore = null;
    this._index = null;
    this._pointLngs = null;
    this._pointLats = null;
  }

  /**
   * Build index from a geojsonToFeatures data object.
   * @param {'points'|'lines'|'polygons'} kind
   * @param {object} data  Output of geojsonToFeatures()
   */
  build(kind, data) {
    this._kind = kind;
    this._featureStore = data._featureStore || [];
    const n = data.featureCount || this._featureStore.length;

    if (kind === 'points') {
      this._buildPoints(data, n);
    } else {
      this._buildRBush(n);
    }
  }

  _buildPoints(data, n) {
    const packed = data.geometry.packedPositions;
    const lngs = new Float64Array(n);
    const lats = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      lngs[i] = packed[i * 4];
      lats[i] = packed[i * 4 + 1];
    }
    this._pointLngs = lngs;
    this._pointLats = lats;

    const bush = new KDBush(n, 64, Float64Array);
    for (let i = 0; i < n; i++) bush.add(lngs[i], lats[i]);
    bush.finish();
    this._index = bush;
  }

  _buildRBush(n) {
    const tree = new RBush();
    const items = [];
    for (let fi = 0; fi < n; fi++) {
      const geom = this._featureStore[fi]?.geometry;
      if (!geom) continue;
      const bb = _geomBBox(geom);
      if (!bb) continue;
      items.push({ minX: bb[0], minY: bb[1], maxX: bb[2], maxY: bb[3], fi });
    }
    tree.load(items);
    this._index = tree;
  }

  /**
   * Query the nearest feature within toleranceDeg (degree-space).
   * @param {number} lng
   * @param {number} lat
   * @param {number} toleranceDeg
   * @returns {{ featureIndex: number, properties: object }|null}
   */
  query(lng, lat, toleranceDeg) {
    if (!this._index) return null;
    const cosLat = Math.cos((lat * Math.PI) / 180);

    if (this._kind === 'points') {
      return this._queryPoints(lng, lat, toleranceDeg, cosLat);
    } else if (this._kind === 'lines') {
      return this._queryLines(lng, lat, toleranceDeg, cosLat);
    } else if (this._kind === 'polygons') {
      return this._queryPolygons(lng, lat, toleranceDeg);
    }
    return null;
  }

  _queryPoints(lng, lat, tol, cosLat) {
    const results = this._index.within(lng, lat, tol);
    if (!results.length) return null;
    const tol2 = tol * tol;
    let bestDist = tol2 + 1,
      bestFi = -1;
    for (const idx of results) {
      const d = dist2(lng, lat, this._pointLngs[idx], this._pointLats[idx], cosLat);
      if (d < bestDist) {
        bestDist = d;
        bestFi = idx;
      }
    }
    return bestFi >= 0 ? this._result(bestFi) : null;
  }

  _queryLines(lng, lat, tol, cosLat) {
    const tol2 = tol * tol;
    const candidates = this._index.search({
      minX: lng - tol,
      minY: lat - tol,
      maxX: lng + tol,
      maxY: lat + tol,
    });
    let bestDist = tol2 + 1,
      bestFi = -1;
    for (const { fi } of candidates) {
      const geom = this._featureStore[fi]?.geometry;
      if (!geom) continue;
      const d = _minSegDist2(lng, lat, geom, cosLat);
      if (d < tol2 && d < bestDist) {
        bestDist = d;
        bestFi = fi;
      }
    }
    return bestFi >= 0 ? this._result(bestFi) : null;
  }

  _queryPolygons(lng, lat, tol) {
    const candidates = this._index.search({
      minX: lng - tol,
      minY: lat - tol,
      maxX: lng + tol,
      maxY: lat + tol,
    });
    // When polygons overlap (e.g. a small coverage cell sitting on top of a
    // world-spanning mask), return the SMALLEST-bbox containing polygon so
    // the click resolves to the most specific feature rather than whichever
    // the R-tree happens to yield first.
    let bestFi = -1,
      bestArea = Infinity;
    for (const { fi } of candidates) {
      const geom = this._featureStore[fi]?.geometry;
      if (!geom) continue;
      if (!_pointInGeom(lng, lat, geom)) continue;
      const bbox = _geomBBox(geom);
      const area = bbox ? (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) : Infinity;
      if (area < bestArea) {
        bestArea = area;
        bestFi = fi;
      }
    }
    return bestFi >= 0 ? this._result(bestFi) : null;
  }

  _result(fi) {
    const props = this._featureStore[fi]?.properties || {};
    return { featureIndex: fi, properties: props };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _geomBBox(geom) {
  const coords = _allCoords(geom);
  if (!coords.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function _allCoords(geom) {
  if (!geom) return [];
  const t = geom.type;
  if (t === 'Point') return [geom.coordinates];
  if (t === 'MultiPoint') return geom.coordinates;
  if (t === 'LineString') return geom.coordinates;
  if (t === 'MultiLineString') return geom.coordinates.flat(1);
  if (t === 'Polygon') return geom.coordinates.flat(1);
  if (t === 'MultiPolygon') return geom.coordinates.flat(2);
  return [];
}

function _minSegDist2(lng, lat, geom, cosLat) {
  let best = Infinity;
  const rings =
    geom.type === 'LineString'
      ? [geom.coordinates]
      : geom.type === 'MultiLineString'
        ? geom.coordinates
        : [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const d = pointToSegmentDist2(
        lng,
        lat,
        ring[i][0],
        ring[i][1],
        ring[i + 1][0],
        ring[i + 1][1],
        cosLat
      );
      if (d < best) best = d;
    }
  }
  return best;
}

function _pointInGeom(lng, lat, geom) {
  const polys =
    geom.type === 'Polygon'
      ? [geom.coordinates]
      : geom.type === 'MultiPolygon'
        ? geom.coordinates
        : [];
  for (const poly of polys) {
    if (!poly.length) continue;
    const outer = _ringToFlat(poly[0]);
    if (pointInPolygon(lng, lat, outer)) return true;
  }
  return false;
}

function _ringToFlat(ring) {
  const flat = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    flat[i * 2] = ring[i][0];
    flat[i * 2 + 1] = ring[i][1];
  }
  return flat;
}
