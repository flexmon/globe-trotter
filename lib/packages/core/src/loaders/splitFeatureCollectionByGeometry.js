// Split a mixed-geometry FeatureCollection into per-kind sub-collections.
// GeometryCollection features are expanded into individual features per member.
//
// Returns { points?, lines?, polygons? } — only kinds that have at least one
// feature are present.

const GEOJSON_TO_KIND = {
  Point: 'points',
  MultiPoint: 'points',
  LineString: 'lines',
  MultiLineString: 'lines',
  Polygon: 'polygons',
  MultiPolygon: 'polygons',
};

/**
 * Partition a FeatureCollection (or single Feature/Geometry) by geometry kind.
 *
 * @param {object} geojson
 * @returns {{ points?: object, lines?: object, polygons?: object }}
 *   Each value is a FeatureCollection with only features of that kind.
 */
export function splitFeatureCollectionByGeometry(geojson) {
  const features = _normalizeToFeatures(geojson);

  const buckets = { points: [], lines: [], polygons: [] };

  for (const f of features) {
    _partitionFeature(f, buckets);
  }

  const result = {};
  for (const kind of ['points', 'lines', 'polygons']) {
    if (buckets[kind].length > 0) {
      result[kind] = {
        type: 'FeatureCollection',
        features: buckets[kind],
      };
    }
  }
  return result;
}

function _normalizeToFeatures(g) {
  if (!g || typeof g !== 'object') return [];
  if (g.type === 'FeatureCollection') return g.features || [];
  if (g.type === 'Feature') return [g];
  // Bare geometry
  return [{ type: 'Feature', geometry: g, properties: {} }];
}

function _partitionFeature(f, buckets) {
  const geom = f.geometry;
  if (!geom) return;

  if (geom.type === 'GeometryCollection') {
    // Expand each geometry member into its own feature, preserving properties
    for (const member of geom.geometries || []) {
      _partitionFeature(
        { type: 'Feature', geometry: member, properties: f.properties, id: f.id },
        buckets
      );
    }
    return;
  }

  const kind = GEOJSON_TO_KIND[geom.type];
  if (kind) buckets[kind].push(f);
}
