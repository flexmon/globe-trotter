/**
 * mercatorBake.js — Shared Mercator mesh pre-baking for WebGPU hex renderers.
 *
 * Strategy: option (a) — CPU split at mesh construction time.
 *
 * The pre-bake win (positions computed once at load, not per-frame) is worth
 * keeping for H3F/DGF which can have millions of cells.  The antimeridian fix
 * is a tiny one-time CPU cost (<1ms even for full-globe meshes) added at the
 * same load step.
 *
 * Algorithm
 * ---------
 * 1. Convert every XYZ vertex to Mercator world-pixels at zoom 0 (BAKE_WORLD=256).
 * 2. Walk the index buffer triangle-by-triangle.
 * 3. If a triangle's world-X span exceeds HALF_WORLD (128 px), it crosses the
 *    antimeridian.  Duplicate the "minority-side" vertex at ±BAKE_WORLD so
 *    the rasteriser draws two narrow slivers instead of one continent-wide band.
 * 4. Return { mercPositions, mercIndices, mercCellIndices } — parallel arrays
 *    that the caller uploads to separate GPU buffers.
 *
 * The caller (H3FlexRenderer / DGFlexRenderer) must use mercIndices for
 * the Mercator draw call and mercCellIndices as its vertex buffer 1 (cell
 * index lookup).  The spherical positionBuffer / cellIndexBuffer / indexBuffer
 * are unchanged.
 *
 * Worst-case extra vertices: 3 per crossing triangle.  For a typical resolution-
 * 4 H3 global mesh (~1m cells) roughly O(100) hexes straddle ±180°, so the
 * overhead is negligible.
 */

/** World size in pixels at zoom 0 (matches Mapbox / Leaflet tile convention). */
export const BAKE_WORLD = 256;
const HALF_WORLD = BAKE_WORLD / 2;

const PI = Math.PI;

/**
 * Compute the visible horizontal world-copy range for a Mercator draw.
 *
 * Renderers repeat their geometry once per visible world copy so features wrap
 * across the antimeridian like the Mercator tiles do. Callers draw one instance
 * (or one 6-vertex billboard band) per copy, shifting by `world_size` in the
 * shader via the returned `firstCopy` base index. When world wrapping is off
 * (`renderWorldCopies === false`), this collapses to a single world.
 *
 * @param {number} cameraX - camera center X in world pixels at the current zoom
 * @param {number} worldSize - world width in pixels at the current zoom (256 × 2^zoom)
 * @param {number} viewportW - canvas width in physical (device) pixels
 * @param {boolean} renderWorldCopies - whether the camera allows wrapping
 * @returns {{ firstCopy: number, copyCount: number }} leftmost copy index and
 *   the number of copies to draw (always ≥ 1)
 */
export function computeWorldCopies(cameraX, worldSize, viewportW, renderWorldCopies) {
  if (!renderWorldCopies) return { firstCopy: 0, copyCount: 1 };
  const halfW = viewportW / 2;
  const firstCopy = Math.floor((cameraX - halfW) / worldSize);
  const lastCopy = Math.floor((cameraX + halfW) / worldSize);
  return { firstCopy, copyCount: Math.max(1, lastCopy - firstCopy + 1) };
}

/**
 * Convert a single unit-sphere XYZ triple to Mercator world-pixel coords at zoom 0.
 * @param {number} gx
 * @param {number} gy
 * @param {number} gz
 * @returns {[number, number]} [worldX, worldY]
 */
function xyzToMerc(gx, gy, gz) {
  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, gy))) * (180 / PI);
  const lonRaw = Math.atan2(gx, gz) * (180 / PI) - 180;
  const lon = lonRaw < -180 ? lonRaw + 360 : lonRaw;
  const x = ((lon + 180) / 360) * BAKE_WORLD;
  const sinLat = Math.sin((lat * PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * PI)) * BAKE_WORLD;
  return [x, y];
}

/**
 * Convert all XYZ triples to Mercator world pixels without splitting.
 * Used internally and exposed for callers that don't have an index buffer
 * (e.g. incremental append — see splitMercatorBatch for the full version).
 *
 * @param {Float32Array} xyz - interleaved [x,y,z, ...], length = vertexCount × 3
 * @returns {Float32Array} length = vertexCount × 2
 */
export function batchXyzToMercator(xyz) {
  const count = xyz.length / 3;
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const [x, y] = xyzToMerc(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
  return out;
}

/**
 * Convert XYZ vertices to Mercator world pixels **and** split triangles that
 * cross the antimeridian (±180° longitude).
 *
 * Antimeridian crossing detection: a triangle crosses when its world-X range
 * exceeds HALF_WORLD (128 px at zoom 0).  In that case the "minority side"
 * vertices are duplicated at ±BAKE_WORLD so both slivers rasterise correctly.
 *
 * The returned mercCellIndices is a Float32Array parallel to mercPositions
 * (one cell-index per *Mercator* vertex, not per original vertex), so data-
 * texture lookups remain correct for duplicated vertices.
 *
 * @param {Float32Array} xyz           - interleaved XYZ, length = vertexCount × 3
 * @param {Uint32Array}  indices       - triangle list, length = triangleCount × 3
 * @param {Float32Array} cellIdxSrc   - one cell-index per original vertex
 * @param {Float32Array} [extrudeSrc] - one extrude-flag per original vertex (optional;
 *                                      if omitted mercExtrudeFlags is all zeros)
 * @returns {{
 *   mercPositions:     Float32Array,  // vertexCount × 2 (may be > original)
 *   mercIndices:       Uint32Array,   // triangleCount × 3 (may be > original)
 *   mercCellIndices:   Float32Array,  // one per Mercator vertex
 *   mercExtrudeFlags:  Float32Array,  // one per Mercator vertex (0=base, 1=top)
 * }}
 */
export function splitMercatorMesh(xyz, indices, cellIdxSrc, extrudeSrc) {
  const origVertCount = xyz.length / 3;
  const triCount = indices.length / 3;

  // Step 1: project all original vertices once.
  const baseXY = new Float32Array(origVertCount * 2);
  for (let i = 0; i < origVertCount; i++) {
    const [x, y] = xyzToMerc(xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]);
    baseXY[i * 2] = x;
    baseXY[i * 2 + 1] = y;
  }

  // Step 2: walk triangles, collecting extra vertices for crossing tris.
  // Use dynamic arrays since crossing count is unknown at start.
  const extraPositions = []; // flat [x, y, x, y, ...]
  const extraCellIdxs = []; // flat [ci, ci, ...]
  const extraExtrudeFlgs = []; // flat [ef, ef, ...]
  // Map: origVertIdx → [shiftedVertIdx, ...] keyed by shift sign (+1 or -1)
  // We allocate fresh duplicates per crossing triangle to avoid conflicts.
  const outIndices = new Uint32Array(indices.length); // same count: split adds tris separately
  const splitTris = []; // [{i0,i1,i2,x0,x1,x2}] for crossing triangles

  let nextVertIdx = origVertCount;

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    const x0 = baseXY[i0 * 2];
    const x1 = baseXY[i1 * 2];
    const x2 = baseXY[i2 * 2];

    const xMin = Math.min(x0, x1, x2);
    const xMax = Math.max(x0, x1, x2);

    if (xMax - xMin <= HALF_WORLD) {
      // Non-crossing — copy indices as-is.
      outIndices[t * 3] = i0;
      outIndices[t * 3 + 1] = i1;
      outIndices[t * 3 + 2] = i2;
    } else {
      // Crossing triangle — mark for post-processing; zero out in main array.
      // (We'll push two replacement triangles into splitTris.)
      outIndices[t * 3] = 0; // placeholder; overwritten below
      outIndices[t * 3 + 1] = 0;
      outIndices[t * 3 + 2] = 0;
      splitTris.push({ t, i0, i1, i2, x0, x1, x2 });
    }
  }

  // Step 3: resolve crossing triangles.
  // For each, we emit 2 triangles: one with the minority-side vertices shifted
  // left (−BAKE_WORLD) and one with them shifted right (+BAKE_WORLD).
  // All 6 vertices of the pair are freshly duplicated to avoid polluting
  // neighbours that don't cross.
  const extraTriIndices = []; // flat [i0,i1,i2, ...] appended after outIndices

  for (const { t, i0, i1, i2, x0, x1, x2 } of splitTris) {
    const xMid = (x0 + x1 + x2) / 3;
    // Determine which side is the "majority": vertices whose X is on the same
    // side as the centroid stay; the minority vertices get mirrored.
    const threshold = xMid > HALF_WORLD ? HALF_WORLD : HALF_WORLD;
    // Simpler: shift the "low-x" vertices right (+BAKE_WORLD) to join
    // the high-x group, producing the east sliver; then shift the
    // "high-x" vertices left (−BAKE_WORLD) for the west sliver.

    // Determine per-vertex side relative to centroid X.
    // "High side" = majority if centroid > HALF_WORLD, else minority.
    const onHigh = [x0 > HALF_WORLD, x1 > HALF_WORLD, x2 > HALF_WORLD];
    const highCount = onHigh.filter(Boolean).length;

    // Emit EAST sliver: all vertices shifted so low-x ones move to +BAKE_WORLD side.
    // Emit WEST sliver: all vertices shifted so high-x ones move to −BAKE_WORLD side.
    const verts = [
      {
        orig: i0,
        x: x0,
        y: baseXY[i0 * 2 + 1],
        ci: cellIdxSrc[i0],
        ef: extrudeSrc ? extrudeSrc[i0] : 0,
      },
      {
        orig: i1,
        x: x1,
        y: baseXY[i1 * 2 + 1],
        ci: cellIdxSrc[i1],
        ef: extrudeSrc ? extrudeSrc[i1] : 0,
      },
      {
        orig: i2,
        x: x2,
        y: baseXY[i2 * 2 + 1],
        ci: cellIdxSrc[i2],
        ef: extrudeSrc ? extrudeSrc[i2] : 0,
      },
    ];

    // For EAST sliver: shift low-x vertices right.
    const eastIdxs = verts.map((v) => {
      const sx = v.x < HALF_WORLD ? v.x + BAKE_WORLD : v.x;
      extraPositions.push(sx, v.y);
      extraCellIdxs.push(v.ci);
      extraExtrudeFlgs.push(v.ef);
      return nextVertIdx++;
    });

    // For WEST sliver: shift high-x vertices left.
    const westIdxs = verts.map((v) => {
      const sx = v.x >= HALF_WORLD ? v.x - BAKE_WORLD : v.x;
      extraPositions.push(sx, v.y);
      extraCellIdxs.push(v.ci);
      extraExtrudeFlgs.push(v.ef);
      return nextVertIdx++;
    });

    // Replace the zeroed-out original triangle slot with the east sliver,
    // and push the west sliver as an extra triangle.
    outIndices[t * 3] = eastIdxs[0];
    outIndices[t * 3 + 1] = eastIdxs[1];
    outIndices[t * 3 + 2] = eastIdxs[2];

    extraTriIndices.push(westIdxs[0], westIdxs[1], westIdxs[2]);
  }

  // Step 4: assemble final position / cellIdx / extrudeFlag arrays.
  const totalVerts = origVertCount + extraPositions.length / 2;
  const mercPositions = new Float32Array(totalVerts * 2);
  mercPositions.set(baseXY, 0);
  if (extraPositions.length) {
    mercPositions.set(extraPositions, origVertCount * 2);
  }

  const mercCellIndices = new Float32Array(totalVerts);
  mercCellIndices.set(cellIdxSrc, 0);
  if (extraCellIdxs.length) {
    mercCellIndices.set(extraCellIdxs, origVertCount);
  }

  const mercExtrudeFlags = new Float32Array(totalVerts);
  if (extrudeSrc) {
    mercExtrudeFlags.set(extrudeSrc, 0);
  }
  // Else: leave zeroed (base vertices only, no pillar tops needed for flat mode)
  if (extraExtrudeFlgs.length) {
    mercExtrudeFlags.set(extraExtrudeFlgs, origVertCount);
  }

  // Step 5: assemble final index array.
  const totalTris = triCount + extraTriIndices.length / 3;
  const mercIndices = new Uint32Array(totalTris * 3);
  mercIndices.set(outIndices, 0);
  if (extraTriIndices.length) {
    mercIndices.set(extraTriIndices, triCount * 3);
  }

  return { mercPositions, mercIndices, mercCellIndices, mercExtrudeFlags };
}

/**
 * Incremental-append variant: convert a NEW batch of XYZ positions + their
 * indices (already offset-adjusted relative to the full mesh) to Mercator,
 * with antimeridian splitting.
 *
 * Unlike splitMercatorMesh, this operates on a partial batch.  The returned
 * arrays are sized to exactly the new vertices/indices to write.  The caller
 * is responsible for managing write offsets into the GPU buffers.
 *
 * Note: because splitting may produce extra vertices, the mercator GPU buffers
 * must have been pre-allocated with a SPLIT_HEADROOM factor (see renderers).
 *
 * @param {Float32Array} xyz          - new positions, length = newVerts × 3
 * @param {Uint32Array}  indices      - new triangle indices (already offset-adjusted)
 * @param {Float32Array} cellIdxs    - new cell indices, length = newVerts
 * @param {number} vertexBaseOffset  - number of original vertices already written
 *                                     (used to re-base split vertex indices)
 * @param {Float32Array} [extrudeFlgs] - new extrude flags, length = newVerts (optional)
 * @returns {{
 *   mercPositions:    Float32Array,
 *   mercIndices:      Uint32Array,
 *   mercCellIndices:  Float32Array,
 *   mercExtrudeFlags: Float32Array,
 *   vertexCount:      number,        // total Mercator vertex count for this batch
 *   indexCount:       number,        // total Mercator index count for this batch
 * }}
 */
/**
 * Triangle-mesh polygon antimeridian splitter for lng/lat-encoded geometry.
 *
 * The hex-mesh splitter (splitMercatorMesh) takes XYZ unit-sphere vertices and
 * pre-bakes Mercator world pixels; polygon meshes ship lng/lat and project in
 * the vertex shader.  This variant works directly in lng-degree space so the
 * Mercator polygon shader can stay unchanged — duplicated vertices are simply
 * given lng ±360°, and `lngLatToMerc` in the shader handles the rest.
 *
 * Crossing detection: a triangle crosses ±180° iff `max(lng) - min(lng) > 180`.
 * For each crossing tri we emit two slivers:
 *   - East sliver: vertices with lng < 0 are duplicated at lng + 360.
 *   - West sliver: vertices with lng > 0 are duplicated at lng − 360.
 * The shader projects lng=181 → world_x = 257 (just east of the seam) and
 * lng=−181 → world_x = −1 (just west) — both render as small slivers near
 * the antimeridian instead of one ribbon spanning the world.
 *
 * Per-vertex attribute arrays (value, visibility, featureForVertex) are
 * duplicated alongside positions so the split vertices inherit the right
 * style/filter state.  A `parentVertexMap` is returned so callers can resync
 * any attribute later (e.g. when a filter changes visibility) by walking the
 * split array and copying `original[parentVertexMap[i]]`.
 *
 * @param {Float32Array} lngLat        - interleaved [lng,lat] or [lng,lat,alt], length = vertexCount × fpp
 * @param {number}       fpp           - floats per position in input (2 or 3); output mercPositions is always fpp=2
 * @param {Uint32Array|Uint16Array} indices - triangle list, length = triangleCount × 3
 * @param {object}       [attribs]     - per-vertex parallel arrays to duplicate
 * @param {Float32Array} [attribs.values]
 * @param {Float32Array} [attribs.visibility]
 * @param {Uint32Array}  [attribs.featureForVertex]
 * @returns {{
 *   mercPositions:        Float32Array,  // interleaved [lng,lat], may include lng ±360 for split slivers
 *   mercIndices:          Uint32Array,
 *   mercValues:           Float32Array | null,
 *   mercVisibility:       Float32Array | null,
 *   mercFeatureForVertex: Uint32Array | null,
 *   parentVertexMap:      Uint32Array,   // length = output vertex count; identity for original verts
 * }}
 */
export function splitMercatorPolygon(lngLat, fpp, indices, attribs = {}) {
  const origVertCount = lngLat.length / fpp;
  const triCount = indices.length / 3;

  const srcValues = attribs.values || null;
  const srcVisibility = attribs.visibility || null;
  const srcFeatureForVertex = attribs.featureForVertex || null;

  // Start output arrays as copies of the original per-vertex data (lng,lat only).
  const outLngLat = new Array(origVertCount * 2);
  for (let i = 0; i < origVertCount; i++) {
    outLngLat[i * 2] = lngLat[i * fpp];
    outLngLat[i * 2 + 1] = lngLat[i * fpp + 1];
  }
  const outValues = srcValues ? Array.from(srcValues) : null;
  const outVisibility = srcVisibility ? Array.from(srcVisibility) : null;
  const outFeatureForVertex = srcFeatureForVertex ? Array.from(srcFeatureForVertex) : null;
  const parentMap = new Array(origVertCount);
  for (let i = 0; i < origVertCount; i++) parentMap[i] = i;

  const outIndices = [];

  let nextVertIdx = origVertCount;
  const duplicate = (origIdx, lngShift) => {
    const newIdx = nextVertIdx++;
    outLngLat.push(lngLat[origIdx * fpp] + lngShift, lngLat[origIdx * fpp + 1]);
    if (outValues) outValues.push(srcValues[origIdx]);
    if (outVisibility) outVisibility.push(srcVisibility[origIdx]);
    if (outFeatureForVertex) outFeatureForVertex.push(srcFeatureForVertex[origIdx]);
    parentMap.push(origIdx);
    return newIdx;
  };

  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3],
      i1 = indices[t * 3 + 1],
      i2 = indices[t * 3 + 2];
    const lng0 = lngLat[i0 * fpp],
      lng1 = lngLat[i1 * fpp],
      lng2 = lngLat[i2 * fpp];
    const lngMin = Math.min(lng0, lng1, lng2);
    const lngMax = Math.max(lng0, lng1, lng2);

    if (lngMax - lngMin <= 180) {
      outIndices.push(i0, i1, i2);
      continue;
    }

    // Crossing triangle — emit east + west slivers.
    const v = [i0, i1, i2];
    const l = [lng0, lng1, lng2];
    const east = v.map((origIdx, k) => (l[k] < 0 ? duplicate(origIdx, 360) : origIdx));
    const west = v.map((origIdx, k) => (l[k] > 0 ? duplicate(origIdx, -360) : origIdx));
    outIndices.push(east[0], east[1], east[2]);
    outIndices.push(west[0], west[1], west[2]);
  }

  return {
    mercPositions: new Float32Array(outLngLat),
    mercIndices: new Uint32Array(outIndices),
    mercValues: outValues ? new Float32Array(outValues) : null,
    mercVisibility: outVisibility ? new Float32Array(outVisibility) : null,
    mercFeatureForVertex: outFeatureForVertex ? new Uint32Array(outFeatureForVertex) : null,
    parentVertexMap: new Uint32Array(parentMap),
  };
}

export function splitMercatorBatch(xyz, indices, cellIdxs, vertexBaseOffset, extrudeFlgs) {
  // Re-base indices to be relative to this batch so splitMercatorMesh works
  // correctly, then shift results back up by vertexBaseOffset.
  const relIndices = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    relIndices[i] = indices[i] - vertexBaseOffset;
  }

  const { mercPositions, mercIndices, mercCellIndices, mercExtrudeFlags } = splitMercatorMesh(
    xyz,
    relIndices,
    cellIdxs,
    extrudeFlgs
  );

  // Shift indices back to absolute (offset by vertexBaseOffset)
  for (let i = 0; i < mercIndices.length; i++) {
    mercIndices[i] += vertexBaseOffset;
  }

  return {
    mercPositions,
    mercIndices,
    mercCellIndices,
    mercExtrudeFlags,
    vertexCount: mercPositions.length / 2,
    indexCount: mercIndices.length,
  };
}
