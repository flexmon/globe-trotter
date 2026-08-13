/**
 * greatCircleSubdivide.js — Great-circle triangle subdivision for spherical polygons.
 *
 * On the 3D globe a flat triangle whose edges span many degrees chords *through*
 * the sphere instead of hugging its surface (and its per-vertex value/colour
 * interpolates linearly along that chord). This recursively splits any triangle
 * edge longer than ~2° (in lon/lat degree space) at its midpoint, interpolating
 * the per-vertex value and inheriting the feature index, so the rasterised
 * surface stays close to the sphere.
 *
 * Pure function: typed-array in, typed-array out. No GPU/GL/projection coupling.
 * Mercator (a flat projection) does not need this — straight edges are correct
 * there — so callers apply it to the spherical geometry path only.
 *
 * Extracted from GFBPolygonRenderer (WebGL2) so the WebGPU renderer shares one
 * source of truth (see Contracts / Track C-0). Behaviour is identical to the
 * original: MAX_EDGE_DEG = 2°, MAX_DEPTH = 3.
 *
 * @param {Float32Array} coords            - interleaved positions, length = vertexCount × fpp
 * @param {number}       fpp               - floats per position (2 = lon,lat; 3 = lon,lat,alt)
 * @param {Uint16Array|Uint32Array} triangles - triangle index list, length = triCount × 3
 * @param {Float32Array} values            - one value per vertex (interpolated at midpoints)
 * @param {Uint32Array}  featureForVertex  - one feature index per vertex (inherited at midpoints)
 * @returns {{ coords: Float32Array, triangles: Uint16Array|Uint32Array,
 *             values: Float32Array, featureForVertex: Uint32Array }}
 *          Original arrays returned untouched when no edge exceeds the threshold.
 */
export function subdivideTriangles(coords, fpp, triangles, values, featureForVertex) {
  const MAX_EDGE_DEG = 2.0;
  const MAX_EDGE_SQ = MAX_EDGE_DEG * MAX_EDGE_DEG;

  // Depth cap is adaptive per root triangle. Normal polygons (dense coverage
  // cells etc.) cap at MAX_DEPTH_NORMAL — the edge test usually stops them
  // sooner anyway, so this keeps the common case cheap. Only genuinely huge
  // triangles (a world-spanning mask polygon with 180–360° edges) get the
  // deeper cap so they hug the sphere instead of cutting coarse chords; there
  // are very few of those, so they don't blow up the vertex count.
  const MAX_DEPTH_NORMAL = 3;
  const MAX_DEPTH_BIG = 8;
  const BIG_EDGE_SQ = 90 * 90; // root edge span (weighted deg) above which we go deep

  // Hard ceiling on generated vertices — a safety net so a pathological layer
  // can never blow the midpoint-cache Map past its ~16.7M-entry engine limit
  // and throw. When hit we stop splitting and emit the rest as-is. Kept well
  // under the Map limit so the cache (one entry per midpoint) never overflows.
  const MAX_VERTS = 12_000_000;

  const origVertCount = coords.length / fpp;
  const origTriCount = triangles.length / 3;

  // Quick scan: count triangles needing subdivision to estimate output size.
  // Most triangles won't need splitting, so we avoid over-allocating.
  let largeTriCount = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const i0 = triangles[t],
      i1 = triangles[t + 1],
      i2 = triangles[t + 2];
    const o0 = i0 * fpp,
      o1 = i1 * fpp,
      o2 = i2 * fpp;
    const cosLat01 = Math.cos(((coords[o0 + 1] + coords[o1 + 1]) * 0.5 * Math.PI) / 180);
    const cosLat12 = Math.cos(((coords[o1 + 1] + coords[o2 + 1]) * 0.5 * Math.PI) / 180);
    const cosLat20 = Math.cos(((coords[o2 + 1] + coords[o0 + 1]) * 0.5 * Math.PI) / 180);
    const d01x = (coords[o0] - coords[o1]) * cosLat01,
      d01y = coords[o0 + 1] - coords[o1 + 1];
    const d12x = (coords[o1] - coords[o2]) * cosLat12,
      d12y = coords[o1 + 1] - coords[o2 + 1];
    const d20x = (coords[o2] - coords[o0]) * cosLat20,
      d20y = coords[o2 + 1] - coords[o0 + 1];
    if (
      d01x * d01x + d01y * d01y > MAX_EDGE_SQ ||
      d12x * d12x + d12y * d12y > MAX_EDGE_SQ ||
      d20x * d20x + d20y * d20y > MAX_EDGE_SQ
    ) {
      largeTriCount++;
    }
  }

  // If no triangles need splitting, return original data untouched
  if (largeTriCount === 0) {
    return { coords, triangles, values, featureForVertex };
  }

  // Estimate: each large tri spawns up to 64 sub-tris (4^3) and ~42 new verts
  // Small tris pass through unchanged. Add generous headroom.
  const estNewVerts = origVertCount + largeTriCount * 45;
  const estNewTris = origTriCount - largeTriCount + largeTriCount * 64;

  // Pre-allocate output buffers
  let coordBuf = new Float32Array(estNewVerts * fpp);
  let valBuf = new Float32Array(estNewVerts);
  let featBuf = new Uint32Array(estNewVerts);
  let idxBuf = new Uint32Array(estNewTris * 3);

  // Copy original vertices into output buffers
  coordBuf.set(coords);
  valBuf.set(values);
  featBuf.set(featureForVertex);
  let nextVert = origVertCount;
  let idxPtr = 0;

  // Midpoint cache: cantor-pair hash → new vertex index
  const midCache = new Map();

  const growCoords = () => {
    const newLen = coordBuf.length * 2;
    const c = new Float32Array(newLen);
    c.set(coordBuf);
    coordBuf = c;
    const v = new Float32Array(newLen / fpp);
    v.set(valBuf);
    valBuf = v;
    const f = new Uint32Array(newLen / fpp);
    f.set(featBuf);
    featBuf = f;
  };

  const growIdx = () => {
    const c = new Uint32Array(idxBuf.length * 2);
    c.set(idxBuf);
    idxBuf = c;
  };

  const getMidpoint = (iA, iB) => {
    const lo = iA < iB ? iA : iB;
    const hi = iA < iB ? iB : iA;
    const key = lo * 2654435761 + hi; // fast hash (Knuth multiplicative)
    if (midCache.has(key)) return midCache.get(key);

    if (nextVert * fpp >= coordBuf.length) growCoords();

    const idx = nextVert++;
    const oA = iA * fpp,
      oB = iB * fpp,
      oN = idx * fpp;
    for (let c = 0; c < fpp; c++) {
      coordBuf[oN + c] = (coordBuf[oA + c] + coordBuf[oB + c]) * 0.5;
    }
    valBuf[idx] = (valBuf[iA] + valBuf[iB]) * 0.5;
    featBuf[idx] = featBuf[iA];

    midCache.set(key, idx);
    return idx;
  };

  const edgeLenSq = (iA, iB) => {
    const oA = iA * fpp,
      oB = iB * fpp;
    const latA = (coordBuf[oA + 1] * Math.PI) / 180;
    const latB = (coordBuf[oB + 1] * Math.PI) / 180;
    const cosLat = Math.cos((latA + latB) * 0.5);
    const dLon = (coordBuf[oA] - coordBuf[oB]) * cosLat;
    const dLat = coordBuf[oA + 1] - coordBuf[oB + 1];
    return dLon * dLon + dLat * dLat;
  };

  const subdivideTri = (i0, i1, i2, depth, maxDepth) => {
    const e01 = edgeLenSq(i0, i1);
    const e12 = edgeLenSq(i1, i2);
    const e20 = edgeLenSq(i2, i0);

    if (
      (e01 <= MAX_EDGE_SQ && e12 <= MAX_EDGE_SQ && e20 <= MAX_EDGE_SQ) ||
      depth >= maxDepth ||
      nextVert >= MAX_VERTS
    ) {
      if (idxPtr + 3 > idxBuf.length) growIdx();
      idxBuf[idxPtr++] = i0;
      idxBuf[idxPtr++] = i1;
      idxBuf[idxPtr++] = i2;
      return;
    }

    const m01 = getMidpoint(i0, i1);
    const m12 = getMidpoint(i1, i2);
    const m20 = getMidpoint(i2, i0);

    subdivideTri(i0, m01, m20, depth + 1, maxDepth);
    subdivideTri(m01, i1, m12, depth + 1, maxDepth);
    subdivideTri(m20, m12, i2, depth + 1, maxDepth);
    subdivideTri(m01, m12, m20, depth + 1, maxDepth);
  };

  for (let t = 0; t < triangles.length; t += 3) {
    const i0 = triangles[t],
      i1 = triangles[t + 1],
      i2 = triangles[t + 2];
    // Only giant triangles (world-mask scale) earn the deeper cap.
    const longestSq = Math.max(edgeLenSq(i0, i1), edgeLenSq(i1, i2), edgeLenSq(i2, i0));
    const maxDepth = longestSq > BIG_EDGE_SQ ? MAX_DEPTH_BIG : MAX_DEPTH_NORMAL;
    subdivideTri(i0, i1, i2, 0, maxDepth);
  }

  // Trim to actual size
  const IndexType = nextVert > 65535 ? Uint32Array : Uint16Array;
  return {
    coords: coordBuf.subarray(0, nextVert * fpp),
    triangles: new IndexType(idxBuf.subarray(0, idxPtr)),
    values: valBuf.subarray(0, nextVert),
    featureForVertex: featBuf.subarray(0, nextVert),
  };
}
