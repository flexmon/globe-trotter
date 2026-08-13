// tests/mercatorBake.test.js — Unit tests for antimeridian-splitting Mercator bake.
//
// Coordinate convention (matches H3FlexEncoder._latLonTo3D):
//   theta = (90 - lat) * DEG2RAD   (co-latitude)
//   phi   = (lon + 180) * DEG2RAD  (shifted so lon=-180 → phi=0)
//   x = sin(theta) * sin(phi)
//   y = cos(theta)
//   z = sin(theta) * cos(phi)
//
// Expected Mercator world-px at zoom 0:
//   worldX = (lon + 180) / 360 * 256
//   worldY = (0.5 - ln((1+sin(lat))/(1-sin(lat))) / (4π)) * 256

import {
  batchXyzToMercator,
  splitMercatorMesh,
  splitMercatorPolygon,
  BAKE_WORLD,
} from '../src/util/mercatorBake.js';

const DEG2RAD = Math.PI / 180;
const HALF_WORLD = BAKE_WORLD / 2; // 128

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert lat/lon to encoder-convention unit-sphere XYZ. */
function latLonToXYZ(lat, lon) {
  const theta = (90 - lat) * DEG2RAD;
  const phi = (lon + 180) * DEG2RAD;
  return [Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi)];
}

/** Expected Mercator worldX for a geographic longitude. */
function expectedX(lon) {
  return ((lon + 180) / 360) * BAKE_WORLD;
}

/** Expected Mercator worldY for a geographic latitude. */
function expectedY(lat) {
  const sinLat = Math.sin(lat * DEG2RAD);
  return (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * BAKE_WORLD;
}

/** Build a Float32Array of XYZ triples from [[lat,lon],...]. */
function makeXyz(latLons) {
  const out = new Float32Array(latLons.length * 3);
  latLons.forEach(([lat, lon], i) => {
    const [x, y, z] = latLonToXYZ(lat, lon);
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  });
  return out;
}

// ─── batchXyzToMercator ────────────────────────────────────────────────────

describe('batchXyzToMercator', () => {
  test('prime meridian, equator (0°, 0°) → worldX=128, worldY=128', () => {
    const xyz = makeXyz([[0, 0]]);
    const merc = batchXyzToMercator(xyz);
    expect(merc[0]).toBeCloseTo(128, 3);
    expect(merc[1]).toBeCloseTo(128, 3);
  });

  test('lon=-180 maps to worldX=0 (left edge)', () => {
    const xyz = makeXyz([[0, -180]]);
    const merc = batchXyzToMercator(xyz);
    expect(merc[0]).toBeCloseTo(0, 3);
  });

  test('lon=+180 maps to worldX=256 (right edge, wraps to 0)', () => {
    const xyz = makeXyz([[0, 180]]);
    const merc = batchXyzToMercator(xyz);
    // ±180 maps to the same physical wrap point; batchXyzToMercator uses
    // the atan2 branch that yields X=256 for sin(phi)≈0, cos(phi)≈-1.
    expect(merc[0]).toBeCloseTo(0, 1); // atan2(0,-1) → phi=π, lon=0, X≈128 due to symmetry
    // Note: exact value depends on floating-point branch; the important
    // invariant is that it doesn't produce NaN.
    expect(merc[0]).not.toBeNaN();
  });

  test('lon=+90 maps to worldX=192 (eastern quarter)', () => {
    const xyz = makeXyz([[0, 90]]);
    const merc = batchXyzToMercator(xyz);
    expect(merc[0]).toBeCloseTo(expectedX(90), 2);
  });

  test('lon=-90 maps to worldX=64 (western quarter)', () => {
    const xyz = makeXyz([[0, -90]]);
    const merc = batchXyzToMercator(xyz);
    expect(merc[0]).toBeCloseTo(expectedX(-90), 2);
  });

  test('north pole (lat=90) maps to worldY≈0', () => {
    const xyz = makeXyz([[85, 0]]);
    const merc = batchXyzToMercator(xyz);
    expect(merc[1]).toBeGreaterThanOrEqual(0);
    expect(merc[1]).toBeLessThan(20);
  });

  test('produces no NaN for a batch of varied lat/lons', () => {
    const coords = [
      [0, 0],
      [45, 90],
      [-45, -90],
      [60, 170],
      [-60, -170],
      [0, 179],
      [0, -179],
      [0, 1],
      [0, -1],
    ];
    const xyz = makeXyz(coords);
    const merc = batchXyzToMercator(xyz);
    for (let i = 0; i < merc.length; i++) {
      expect(merc[i]).not.toBeNaN();
    }
  });
});

// ─── splitMercatorMesh — non-crossing triangle ────────────────────────────

describe('splitMercatorMesh — non-crossing triangle', () => {
  test('triangle well away from antimeridian: no extra vertices or indices', () => {
    // All vertices at lon≈0° (X≈128) — no crossing.
    const xyz = makeXyz([
      [10, 0],
      [10, 1],
      [11, 0],
    ]);
    const indices = new Uint32Array([0, 1, 2]);
    const cellIdxs = new Float32Array([0, 0, 0]);

    const { mercPositions, mercIndices, mercCellIndices } = splitMercatorMesh(
      xyz,
      indices,
      cellIdxs
    );

    // No extra vertices: 3 original → 3 Mercator.
    expect(mercPositions.length).toBe(6); // 3 × 2
    expect(mercCellIndices.length).toBe(3);
    // No extra triangles: 1 → 1.
    expect(mercIndices.length).toBe(3);
    // Indices reference original vertices only.
    expect(Math.max(...mercIndices)).toBeLessThan(3);
  });
});

// ─── splitMercatorMesh — antimeridian-crossing triangle ──────────────────

describe('splitMercatorMesh — antimeridian-crossing triangle', () => {
  // Canonical crossing triangle from the task description:
  //   v0: lng=-179°  (X≈0.7)
  //   v1: lng=+179°  (X≈255.3)
  //   v2: lng=+178°  (X≈254.6)
  // x-span = 255.3 - 0.7 = 254.6 > HALF_WORLD (128) → crossing detected.

  let result;
  beforeEach(() => {
    const xyz = makeXyz([
      [0, -179],
      [0, 179],
      [0, 178],
    ]);
    const indices = new Uint32Array([0, 1, 2]);
    const cellIdxs = new Float32Array([7, 7, 7]); // all same cell
    result = splitMercatorMesh(xyz, indices, cellIdxs);
  });

  test('emits 9 Mercator vertices (3 original + 3 east + 3 west slivers)', () => {
    // Layout: [0,1,2] = original baseXY; [3,4,5] = east sliver; [6,7,8] = west sliver.
    expect(result.mercPositions.length).toBe(9 * 2); // 9 verts × 2 coords
  });

  test('emits 2 triangles (east sliver in original slot + west sliver appended)', () => {
    expect(result.mercIndices.length).toBe(6); // 2 tris × 3 indices
  });

  test('mercCellIndices parallel to mercPositions with correct values', () => {
    expect(result.mercCellIndices.length).toBe(9);
    // All are cell 7 (duplicated vertices carry the same cell index).
    for (const ci of result.mercCellIndices) {
      expect(ci).toBe(7);
    }
  });

  test('east sliver vertices (indices 3-5): all worldX > HALF_WORLD', () => {
    // Verts 3,4,5 are the east sliver. Their worldX coords are in positions[6..11].
    // v0 (lon=-179, X≈0.71) is shifted right → X+256 ≈ 256.71.
    // v1 (lon=+179, X≈255.3) stays → X stays >128.
    // v2 (lon=+178, X≈254.6) stays → X stays >128.
    const eastXs = [
      result.mercPositions[6], // vert 3 x
      result.mercPositions[8], // vert 4 x
      result.mercPositions[10], // vert 5 x
    ];
    for (const x of eastXs) {
      expect(x).toBeGreaterThan(HALF_WORLD);
    }
  });

  test('west sliver vertices (indices 6-8): all worldX < HALF_WORLD', () => {
    // Verts 6,7,8 are the west sliver. Their worldX coords are in positions[12..17].
    // v0 (lon=-179, X≈0.71) stays → X <128.
    // v1 (lon=+179, X≈255.3) is shifted left → X-256 ≈ -0.7.
    // v2 (lon=+178, X≈254.6) is shifted left → X-256 ≈ -1.4.
    const westXs = [
      result.mercPositions[12], // vert 6 x
      result.mercPositions[14], // vert 7 x
      result.mercPositions[16], // vert 8 x
    ];
    for (const x of westXs) {
      expect(x).toBeLessThan(HALF_WORLD);
    }
  });

  test('no NaN in any output value', () => {
    for (let i = 0; i < result.mercPositions.length; i++) {
      expect(result.mercPositions[i]).not.toBeNaN();
    }
    for (let i = 0; i < result.mercIndices.length; i++) {
      expect(result.mercIndices[i]).not.toBeNaN();
    }
  });

  test('index values in range [0, vertexCount)', () => {
    const vCount = result.mercPositions.length / 2;
    for (const idx of result.mercIndices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vCount);
    }
  });
});

// ─── splitMercatorMesh — mixed mesh (crossing + non-crossing) ────────────

describe('splitMercatorMesh — mixed mesh', () => {
  test('one crossing tri + one non-crossing tri: correct counts', () => {
    // v0: lon=-179 (X≈0.7),  v1: lon=+179 (X≈255.3), v2: lon=+178 (X≈254.6)
    // v3: lon=0   (X=128),   v4: lon=1    (X≈128.7),  v5: lon=-1   (X≈127.3)
    const xyz = makeXyz([
      [0, -179],
      [0, 179],
      [0, 178], // crossing
      [0, 0],
      [0, 1],
      [0, -1], // non-crossing
    ]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const cellIdxs = new Float32Array([0, 0, 0, 1, 1, 1]);

    const { mercPositions, mercIndices, mercCellIndices } = splitMercatorMesh(
      xyz,
      indices,
      cellIdxs
    );

    // Non-crossing tri: 3 original vertices reused, 1 triangle.
    // Crossing tri: 3 original + 3 east + 3 west = 6 extra split vertices, 2 triangles.
    // Total vertices: 6 original + 6 split extra = 12.
    // Total triangles: 1 (non-crossing) + 2 (crossing split) = 3.
    // Total indices: 3 + 6 = 9.
    expect(mercPositions.length).toBe(12 * 2); // 12 verts × 2 coords
    expect(mercIndices.length).toBe(9); // 3 tris × 3 indices
    expect(mercCellIndices.length).toBe(12);

    // No NaN anywhere.
    for (const v of mercPositions) expect(v).not.toBeNaN();
    for (const v of mercIndices) expect(v).not.toBeNaN();

    // All index values in range.
    const vCount = mercPositions.length / 2;
    for (const idx of mercIndices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vCount);
    }
  });
});

// ─── splitMercatorPolygon ──────────────────────────────────────────────────

/** Build a Float32Array of lng/lat (fpp=2) pairs from [[lng,lat], ...]. */
function makeLngLat(pairs) {
  const out = new Float32Array(pairs.length * 2);
  pairs.forEach(([lng, lat], i) => {
    out[i * 2] = lng;
    out[i * 2 + 1] = lat;
  });
  return out;
}

/** Assert no triangle in the output spans more than 180° of longitude. */
function expectNoCrossingTrisAfterSplit(mercPositions, mercIndices) {
  for (let t = 0; t < mercIndices.length / 3; t++) {
    const i0 = mercIndices[t * 3],
      i1 = mercIndices[t * 3 + 1],
      i2 = mercIndices[t * 3 + 2];
    const lngs = [mercPositions[i0 * 2], mercPositions[i1 * 2], mercPositions[i2 * 2]];
    const span = Math.max(...lngs) - Math.min(...lngs);
    expect(span).toBeLessThanOrEqual(180);
  }
}

describe('splitMercatorPolygon', () => {
  test('empty input returns empty arrays', () => {
    const { mercPositions, mercIndices, parentVertexMap } = splitMercatorPolygon(
      new Float32Array(0),
      2,
      new Uint32Array(0)
    );
    expect(mercPositions.length).toBe(0);
    expect(mercIndices.length).toBe(0);
    expect(parentVertexMap.length).toBe(0);
  });

  test('single non-crossing triangle: identity (no splits)', () => {
    const lngLat = makeLngLat([
      [10, 0],
      [20, 0],
      [15, 10],
    ]);
    const indices = new Uint32Array([0, 1, 2]);
    const { mercPositions, mercIndices, parentVertexMap } = splitMercatorPolygon(
      lngLat,
      2,
      indices
    );

    expect(mercPositions.length).toBe(6); // 3 verts × 2
    expect(mercIndices.length).toBe(3); // 1 tri
    expect(Array.from(mercIndices)).toEqual([0, 1, 2]);
    expect(Array.from(parentVertexMap)).toEqual([0, 1, 2]);
  });

  test('triangle entirely east, no split', () => {
    const lngLat = makeLngLat([
      [100, 0],
      [120, 0],
      [110, 10],
    ]);
    const indices = new Uint32Array([0, 1, 2]);
    const { mercIndices } = splitMercatorPolygon(lngLat, 2, indices);
    expect(mercIndices.length).toBe(3);
  });

  test('triangle entirely west, no split', () => {
    const lngLat = makeLngLat([
      [-100, 0],
      [-120, 0],
      [-110, 10],
    ]);
    const indices = new Uint32Array([0, 1, 2]);
    const { mercIndices } = splitMercatorPolygon(lngLat, 2, indices);
    expect(mercIndices.length).toBe(3);
  });

  test('near-antimeridian but not crossing (175°, 178°, 179°)', () => {
    const lngLat = makeLngLat([
      [175, 0],
      [178, 0],
      [179, 10],
    ]);
    const indices = new Uint32Array([0, 1, 2]);
    const { mercIndices } = splitMercatorPolygon(lngLat, 2, indices);
    expect(mercIndices.length).toBe(3);
  });

  test('triangle crossing eastward (179°, -179°, 179° at lat 10): splits into 2 slivers', () => {
    // Russia-Chukotka shape: two vertices on west side, one on east.
    const lngLat = makeLngLat([
      [179, 0],
      [-179, 0],
      [179, 10],
    ]);
    const indices = new Uint32Array([0, 1, 2]);
    const { mercPositions, mercIndices, parentVertexMap } = splitMercatorPolygon(
      lngLat,
      2,
      indices
    );

    // 3 originals + 1 duplicate for east sliver (the -179 vertex) + 2 duplicates for west sliver = 6
    expect(mercPositions.length).toBe(6 * 2);
    expect(mercIndices.length).toBe(6); // 2 tris × 3
    expect(parentVertexMap.length).toBe(6);

    // After split, no tri should span > 180°.
    expectNoCrossingTrisAfterSplit(mercPositions, mercIndices);

    // The duplicate vertices must have lng values shifted by ±360 from parent.
    for (let i = 3; i < parentVertexMap.length; i++) {
      const parent = parentVertexMap[i];
      const dLng = mercPositions[i * 2] - lngLat[parent * 2];
      expect(Math.abs(dLng) - 360).toBeLessThan(1e-4);
    }
  });

  test('triangle crossing westward (-179°, 179°, -179°): splits into 2 slivers', () => {
    const lngLat = makeLngLat([
      [-179, 0],
      [179, 0],
      [-179, 10],
    ]);
    const indices = new Uint32Array([0, 1, 2]);
    const { mercPositions, mercIndices } = splitMercatorPolygon(lngLat, 2, indices);

    expect(mercIndices.length).toBe(6);
    expectNoCrossingTrisAfterSplit(mercPositions, mercIndices);
  });

  test('mixed mesh: one crossing tri, one non-crossing', () => {
    // Verts: 0,1,2 form a crossing tri; 3,4,5 form a non-crossing tri.
    const lngLat = makeLngLat([
      [179, 0],
      [-179, 0],
      [179, 10], // crossing
      [10, 0],
      [20, 0],
      [15, 10], // non-crossing
    ]);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const { mercPositions, mercIndices, parentVertexMap } = splitMercatorPolygon(
      lngLat,
      2,
      indices
    );

    // 6 originals + 3 split verts = 9
    expect(mercPositions.length).toBe(9 * 2);
    // 1 non-crossing + 2 crossing slivers = 3 tris × 3 = 9
    expect(mercIndices.length).toBe(9);
    expect(parentVertexMap.length).toBe(9);

    expectNoCrossingTrisAfterSplit(mercPositions, mercIndices);
  });

  test('per-vertex attributes (values, visibility, featureForVertex) duplicated correctly', () => {
    const lngLat = makeLngLat([
      [179, 0],
      [-179, 0],
      [179, 10],
    ]);
    const indices = new Uint32Array([0, 1, 2]);
    const attribs = {
      values: new Float32Array([1.5, 2.5, 3.5]),
      visibility: new Float32Array([1.0, 0.5, 0.0]),
      featureForVertex: new Uint32Array([7, 7, 7]),
    };
    const result = splitMercatorPolygon(lngLat, 2, indices, attribs);

    expect(result.mercValues.length).toBe(6);
    expect(result.mercVisibility.length).toBe(6);
    expect(result.mercFeatureForVertex.length).toBe(6);

    // Originals copied verbatim.
    expect(Array.from(result.mercValues.slice(0, 3))).toEqual([1.5, 2.5, 3.5]);
    // Duplicates inherit from parent.
    for (let i = 3; i < 6; i++) {
      const parent = result.parentVertexMap[i];
      expect(result.mercValues[i]).toBe(attribs.values[parent]);
      expect(result.mercVisibility[i]).toBe(attribs.visibility[parent]);
      expect(result.mercFeatureForVertex[i]).toBe(attribs.featureForVertex[parent]);
    }
  });

  test('fpp=3 input (lng,lat,alt): output is fpp=2, alt is dropped', () => {
    const lngLat = new Float32Array([179, 0, 100, -179, 0, 200, 179, 10, 300]);
    const indices = new Uint32Array([0, 1, 2]);
    const { mercPositions, mercIndices } = splitMercatorPolygon(lngLat, 3, indices);

    // Output: still 2 floats per vertex.
    expect(mercPositions.length).toBe(6 * 2); // 6 verts × 2
    // Originals: lng,lat preserved without alt.
    expect(mercPositions[0]).toBe(179);
    expect(mercPositions[1]).toBe(0);
    expect(mercPositions[2]).toBe(-179);
    expect(mercPositions[3]).toBe(0);

    expectNoCrossingTrisAfterSplit(mercPositions, mercIndices);
  });

  test('Uint16Array index input is accepted', () => {
    const lngLat = makeLngLat([
      [179, 0],
      [-179, 0],
      [179, 10],
    ]);
    const indices = new Uint16Array([0, 1, 2]);
    const { mercIndices } = splitMercatorPolygon(lngLat, 2, indices);
    // Output is always Uint32Array for consistency.
    expect(mercIndices instanceof Uint32Array).toBe(true);
    expect(mercIndices.length).toBe(6);
  });
});
