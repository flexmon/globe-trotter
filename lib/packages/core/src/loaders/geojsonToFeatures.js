// Browser-side GeoJSON → in-memory feature data, shaped like a decoded GFB so
// that GFBRenderer, GFBLineRenderer, GFBPolygonRenderer, StyleEngine, and the
// FlexQL filter system can consume it unchanged.
//
// Supports: Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon.
// Mixed-geometry FeatureCollections throw — split into separate layers first
// (see splitFeatureCollectionByGeometry.js).

import earcut from 'earcut';

const TYPE_FLOAT32 = 1;
const TYPE_ENUM = 9;

const GEOM_POINT = 1;
const GEOM_LINE = 3;
const GEOM_POLYGON = 5;

const GEOJSON_TO_KIND = {
  Point: 'point',
  MultiPoint: 'point',
  LineString: 'line',
  MultiLineString: 'line',
  Polygon: 'polygon',
  MultiPolygon: 'polygon',
};

const KIND_TO_GEOM_TYPE = { point: GEOM_POINT, line: GEOM_LINE, polygon: GEOM_POLYGON };

/**
 * Convert a GeoJSON object to a data object the GFB renderer stack can render.
 *
 * @param {object} geojson  FeatureCollection, Feature, or Geometry
 * @returns {object} data — shape consumed by GFBRenderer/GFBLineRenderer/GFBPolygonRenderer/StyleEngine/parseQuery
 */
export function geojsonToFeatures(geojson) {
  const features = _normalizeToFeatures(geojson);
  if (features.length === 0) throw new Error('geojsonToFeatures: no features');

  const kind = _detectKind(features);
  const { staticColumns, dictionary, dictionaries, schema } = _buildColumns(features);
  const geometry = _buildGeometry(kind, features, staticColumns);
  const featureStore = _buildFeatureStore(features);

  return {
    geomType: KIND_TO_GEOM_TYPE[kind],
    featureCount: features.length,
    epochCount: 1,
    epochInterval: 0,
    geometry,
    staticColumns,
    temporalColumns: {},
    dictionary,
    dictionaries,
    schema,
    _featureStore: featureStore,
  };
}

// ─── Input normalization ─────────────────────────────────────────────────────

function _normalizeToFeatures(g) {
  if (!g || typeof g !== 'object') throw new Error('geojsonToFeatures: invalid GeoJSON');
  if (g.type === 'FeatureCollection') return g.features || [];
  if (g.type === 'Feature') return [g];
  return [{ type: 'Feature', geometry: g, properties: {} }];
}

function _detectKind(features) {
  const kinds = new Set();
  for (const f of features) {
    const t = f.geometry?.type;
    const k = t && GEOJSON_TO_KIND[t];
    if (k) kinds.add(k);
  }
  if (kinds.size === 0) throw new Error('geojsonToFeatures: no recognized geometry');
  if (kinds.size > 1) {
    throw new Error(`geojsonToFeatures: mixed geometry kinds (${[...kinds].join(', ')})`);
  }
  return [...kinds][0];
}

// ─── Property columns ────────────────────────────────────────────────────────
//
// One pass to pick the dominant type per attribute, then one pass per
// attribute to fill the column. Nested objects / arrays are skipped on the
// GPU side but stay in _featureStore for popup rendering.
//
// Enum encoding: indices reference the GLOBAL `dictionary` array because
// QueryParser._buildPredicate does `dict.indexOf(value)` against
// `schema.dictionary`. `dictionaries[attr]` is a per-attribute subset for
// the symbology UI's categorical lookup.

function _buildColumns(features) {
  const n = features.length;
  const propTypes = _inferPropertyTypes(features);

  const staticColumns = {};
  const dictionaries = {};
  const schema = [];
  const dictionary = [];
  const dictIndex = new Map();

  const intern = (s) => {
    let idx = dictIndex.get(s);
    if (idx === undefined) {
      idx = dictionary.length;
      dictionary.push(s);
      dictIndex.set(s, idx);
    }
    return idx;
  };

  for (const [name, t] of propTypes) {
    if (t === 'number') {
      const arr = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = features[i].properties?.[name];
        arr[i] = typeof v === 'number' && Number.isFinite(v) ? v : NaN;
      }
      staticColumns[name] = arr;
      schema.push({ name, type: TYPE_FLOAT32, temporal: false });
    } else if (t === 'boolean') {
      const arr = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = features[i].properties?.[name];
        arr[i] = v === true ? 1 : v === false ? 0 : NaN;
      }
      staticColumns[name] = arr;
      schema.push({ name, type: TYPE_FLOAT32, temporal: false });
    } else if (t === 'string') {
      const arr = new Uint32Array(n);
      const localSeen = new Set();
      const local = [];
      for (let i = 0; i < n; i++) {
        const v = features[i].properties?.[name];
        const s = v == null ? '' : String(v);
        arr[i] = intern(s);
        if (!localSeen.has(s)) {
          localSeen.add(s);
          local.push(s);
        }
      }
      staticColumns[name] = arr;
      dictionaries[name] = local;
      schema.push({ name, type: TYPE_ENUM, temporal: false });
    }
  }

  return { staticColumns, dictionary, dictionaries, schema };
}

function _inferPropertyTypes(features) {
  const counts = new Map();
  for (const f of features) {
    const p = f.properties;
    if (!p) continue;
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v == null) continue;
      const t = typeof v;
      if (t !== 'number' && t !== 'string' && t !== 'boolean') continue;
      let c = counts.get(k);
      if (!c) {
        c = { number: 0, string: 0, boolean: 0 };
        counts.set(k, c);
      }
      c[t]++;
    }
  }
  const out = new Map();
  for (const [name, c] of counts) {
    let best = 'number';
    if (c.string > c[best]) best = 'string';
    if (c.boolean > c[best]) best = 'boolean';
    if (c[best] === 0) continue;
    out.set(name, best);
  }
  return out;
}

// ─── Sidecar (for picking / popups; full fidelity including nested objects) ──

function _buildFeatureStore(features) {
  return features.map((f, i) => ({
    id: f.id != null ? f.id : i,
    geometry: f.geometry,
    properties: f.properties || {},
  }));
}

// ─── Geometry builders ───────────────────────────────────────────────────────

function _buildGeometry(kind, features, staticColumns) {
  switch (kind) {
    case 'point':
      return _buildPointGeometry(features);
    case 'line':
      return _buildLineGeometry(features, staticColumns);
    case 'polygon':
      return _buildPolygonGeometry(features, staticColumns);
  }
  throw new Error(`geojsonToFeatures: unsupported kind "${kind}"`);
}

// Points: pack (lon, lat, 0, 0) per feature into the RGBA32F texture layout
// the GFBRenderer expects in geom.packedPositions.
function _buildPointGeometry(features) {
  const n = features.length;
  const texSize = Math.max(1, Math.ceil(Math.sqrt(n)));
  const packed = new Float32Array(texSize * texSize * 4);
  for (let i = 0; i < n; i++) {
    const [lon, lat] = _pointForFeature(features[i].geometry);
    packed[i * 4] = lon;
    packed[i * 4 + 1] = lat;
  }
  return {
    type: 'point',
    featureCount: n,
    epochCount: 1,
    packedPositions: packed,
    _texSize: texSize,
    _texelsPerEpoch: texSize * texSize,
  };
}

function _pointForFeature(g) {
  if (!g) return [0, 0];
  if (g.type === 'Point') return [g.coordinates[0], g.coordinates[1]];
  if (g.type === 'MultiPoint') {
    const cs = g.coordinates;
    if (!cs.length) return [0, 0];
    let lon = 0,
      lat = 0;
    for (const c of cs) {
      lon += c[0];
      lat += c[1];
    }
    return [lon / cs.length, lat / cs.length];
  }
  return [0, 0];
}

// Lines: emit both the WebGL2 shape (segments array) AND the WebGPU shape
// (coordinates + lineOffsets + featureOffsets, type multi_line).
function _buildLineGeometry(features, staticColumns) {
  const initial = _firstColumn(staticColumns);

  const segments = [];
  const coordsChunks = [];
  const lineOffsets = [0];
  const featureOffsets = [0];
  let vertexCount = 0;
  let lineCount = 0;

  for (let i = 0; i < features.length; i++) {
    const g = features[i].geometry;
    const v = initial ? Number(initial[i]) || 0 : 0;
    const lineStrings = g ? _extractLineStrings(g) : [];
    for (const ls of lineStrings) {
      if (ls.length < 2) continue;
      const sub = new Float32Array(ls.length * 2);
      for (let k = 0; k < ls.length; k++) {
        sub[k * 2] = ls[k][0];
        sub[k * 2 + 1] = ls[k][1];
      }
      coordsChunks.push(sub);
      vertexCount += ls.length;
      lineCount++;
      lineOffsets.push(vertexCount);

      for (let k = 1; k < ls.length; k++) {
        const a = ls[k - 1],
          b = ls[k];
        segments.push({ lonA: a[0], latA: a[1], lonB: b[0], latB: b[1], value: v });
      }
    }
    featureOffsets.push(lineCount);
  }

  const coordinates = _concatFloat32(coordsChunks, vertexCount * 2);

  return {
    type: 'multi_line',
    featureCount: features.length,
    epochCount: 1,
    segments,
    coordinates,
    floatsPerPos: 2,
    lineOffsets: new Uint32Array(lineOffsets),
    featureOffsets: new Uint32Array(featureOffsets),
  };
}

function _extractLineStrings(g) {
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  return [];
}

// Polygons: triangulate every ring set with earcut.
// Emits both WebGL2 (positions + indices + values) and WebGPU
// (coordinates/triangles + featureOffsets + ringOffsets) shapes.
function _buildPolygonGeometry(features, staticColumns) {
  const initial = _firstColumn(staticColumns);
  const posChunks = [];
  const idxChunks = [];
  const valChunks = [];
  const vidChunks = [];
  const featureOffsets = [0];
  const ringOffsets = [0];
  let vertexOffset = 0;
  let totalVerts = 0;
  let totalIndices = 0;
  let ringCount = 0;

  for (let i = 0; i < features.length; i++) {
    const g = features[i].geometry;
    const featValue = initial ? Number(initial[i]) || 0 : 0;

    if (g) {
      for (const rings of _extractPolygons(g)) {
        const { coords, holes } = _flattenRings(rings);
        const vertCount = coords.length / 2;
        if (vertCount === 0) continue;
        let tris;
        try {
          tris = earcut(coords, holes, 2);
        } catch (e) {
          continue; // skip degenerate polygon
        }
        if (!tris.length) continue;

        const posArr = new Float32Array(vertCount * 2);
        for (let k = 0; k < coords.length; k++) posArr[k] = coords[k];
        const idxArr = new Uint32Array(tris.length);
        for (let k = 0; k < tris.length; k++) idxArr[k] = tris[k] + vertexOffset;
        const valArr = new Float32Array(vertCount).fill(featValue);
        const vidArr = new Uint32Array(vertCount).fill(i);

        posChunks.push(posArr);
        idxChunks.push(idxArr);
        valChunks.push(valArr);
        vidChunks.push(vidArr);
        vertexOffset += vertCount;
        totalVerts += vertCount;
        totalIndices += tris.length;
      }
    }

    ringCount++;
    ringOffsets.push(vertexOffset);
    featureOffsets.push(ringCount);
  }

  return {
    type: 'polygon',
    featureCount: features.length,
    epochCount: 1,
    positions: _concatFloat32(posChunks, totalVerts * 2),
    indices: _concatUint32(idxChunks, totalIndices),
    values: _concatFloat32(valChunks, totalVerts),
    floatsPerPos: 2,
    featureOffsets: new Uint32Array(featureOffsets),
    ringOffsets: new Uint32Array(ringOffsets),
    _vertexFeatureIds: _concatUint32(vidChunks, totalVerts),
  };
}

function _extractPolygons(g) {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

// rings: [[outerRing], [hole1], ...]; each ring is [[lon, lat], ...].
function _flattenRings(rings) {
  let total = 0;
  for (const r of rings) total += r.length;
  const coords = new Float64Array(total * 2);
  const holes = [];
  let idx = 0;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (r > 0) holes.push(idx / 2);
    for (let v = 0; v < ring.length; v++) {
      coords[idx++] = ring[v][0];
      coords[idx++] = ring[v][1];
    }
  }
  return { coords, holes };
}

function _firstColumn(staticColumns) {
  const keys = Object.keys(staticColumns);
  return keys.length ? staticColumns[keys[0]] : null;
}

function _concatFloat32(chunks, totalLen) {
  const out = new Float32Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function _concatUint32(chunks, totalLen) {
  const out = new Uint32Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
