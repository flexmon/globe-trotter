// Entry-point for GeoJSON ingest: validate → split by geometry → convert each
// kind to the in-memory data shape consumed by the GFB renderer stack.

import { splitFeatureCollectionByGeometry } from './splitFeatureCollectionByGeometry.js';
import { geojsonToFeatures } from './geojsonToFeatures.js';

const KIND_LABEL = { points: 'points', lines: 'lines', polygons: 'polygons' };

/**
 * Parse a GeoJSON object into renderable sub-layers.
 *
 * @param {object|string} geojson  Parsed GeoJSON or raw JSON string
 * @returns {Array<{ kind: string, data: object }>}
 *   One entry per geometry kind present in the input.
 *   `kind` is 'points' | 'lines' | 'polygons'.
 *   `data` is the shape consumed by GFBRenderer / GFBLineRenderer / GFBPolygonRenderer.
 *
 * @throws {Error} for invalid GeoJSON, non-WGS84 CRS, or parse failures
 */
export function parseGeoJSON(geojson) {
  if (typeof geojson === 'string') {
    try {
      geojson = JSON.parse(geojson);
    } catch (e) {
      throw new Error(`GeoJSON parse error: ${e.message}`);
    }
  }

  if (!geojson || typeof geojson !== 'object') {
    throw new Error('GeoJSON must be an object');
  }

  // RFC 7946 §4: reject explicit non-WGS84 CRS members
  if (geojson.crs) {
    const name = geojson.crs?.properties?.name || '';
    const isWGS84 =
      !name ||
      /urn:ogc:def:crs:OGC:1\.3:CRS84/i.test(name) ||
      /EPSG::?4326/i.test(name) ||
      /WGS84/i.test(name) ||
      /WGS_1984/i.test(name);
    if (!isWGS84) {
      throw new Error(`GeoJSON uses non-WGS84 CRS "${name}". Only WGS84 (EPSG:4326) is supported.`);
    }
  }

  const split = splitFeatureCollectionByGeometry(geojson);
  const results = [];

  for (const kind of ['points', 'lines', 'polygons']) {
    const sub = split[kind];
    if (!sub) continue;
    try {
      const data = geojsonToFeatures(sub);
      results.push({ kind, data });
    } catch (e) {
      throw new Error(`GeoJSON ${kind}: ${e.message}`);
    }
  }

  if (results.length === 0) {
    throw new Error('GeoJSON contains no supported geometry (Point/Line/Polygon)');
  }

  return results;
}
