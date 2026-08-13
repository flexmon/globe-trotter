/**
 * H3EpochUtils.js — Shared pure-logic utilities for H3 renderers and virtual layers.
 *
 * No GPU API dependencies (no gl, no GPUDevice). All functions are stateless.
 * Used by:
 *   - H3FlexRenderer      (WebGL2)
 *   - H3FlexRenderer   (WebGPU)
 *   - VirtualH3Loader     (FlexDB query → texture)
 *   - DGFlexRenderer / DGFlexRenderer (if applicable)
 */

/**
 * Compute epoch indices and fractional position from normalizedTime (0..1).
 *
 * @param {number} normalizedTime - 0..1 position in the dataset's time range
 * @param {number} epochCount - total number of epochs in the loaded data
 * @returns {{ e0: number, e1: number, frac: number }}
 */
export function computeEpochWindow(normalizedTime, epochCount) {
  if (epochCount <= 1) return { e0: 0, e1: 0, frac: 0 };
  const t = normalizedTime * (epochCount - 1);
  const e0 = Math.max(0, Math.min(Math.floor(t), epochCount - 2));
  return { e0, e1: e0 + 1, frac: t - e0 };
}

/**
 * Extract one epoch's flat slice from a temporal column TypedArray.
 * Handles boundary epochs (the last slot in a shard = interpolation boundary
 * from the next shard, stored in data._boundaryEpochs).
 *
 * @param {Float32Array} attrData - full concatenated temporal column (cellCount × epochCount)
 * @param {number} globalEpoch - absolute epoch index (may span multiple shards)
 * @param {number} cellCount - number of H3 cells in the loaded mesh
 * @param {Object} shardMeta - the data object (subset of H3Flex decoded output):
 *   { _shardEpochStart, _shardEpochCount, epochCount, _boundaryEpochs }
 * @param {string} attrName - column name (used to look up _boundaryEpochs)
 * @returns {Float32Array} - subarray view (or boundary slice) for this epoch
 */
export function sliceEpoch(attrData, globalEpoch, cellCount, shardMeta, attrName) {
  const shardStart = shardMeta._shardEpochStart || 0;
  const hasBoundary = Boolean(shardMeta._boundaryEpochs?.[attrName]);
  const origShardCount =
    (shardMeta._shardEpochCount || shardMeta.epochCount) - (hasBoundary ? 1 : 0);

  const localEpoch = globalEpoch - shardStart;

  if (localEpoch >= origShardCount && hasBoundary) {
    // This is the boundary slot — use the pre-fetched next-shard first epoch
    return shardMeta._boundaryEpochs[attrName].subarray(0, cellCount);
  }

  const clamped = Math.max(0, Math.min(localEpoch, origShardCount - 1));
  const off = clamped * cellCount;
  return attrData.subarray(off, off + cellCount);
}

/**
 * Normalize a Uint16Array or Float32Array source column into a flat Float32 buffer.
 * Both H3FlexRenderer and H3FlexRenderer contain identical copies of this logic
 * inside _uploadFilterColumn() — centralized here.
 *
 * @param {Uint16Array|Float32Array} srcData - source column data
 * @param {Float32Array} dst - pre-allocated output buffer (length >= cellCount)
 * @param {number} cellCount - number of cells to write
 */
export function fillFloat32FromColumn(srcData, dst, cellCount) {
  dst.fill(0);
  const n = Math.min(srcData.length, cellCount);
  if (srcData instanceof Uint16Array) {
    for (let i = 0; i < n; i++) dst[i] = srcData[i];
  } else {
    dst.set(srcData.subarray(0, n));
  }
}

/**
 * Build a dense Float32Array (texture-ready) from a sparse { h3Id → value } map.
 * Used by VirtualH3Loader to convert FlexDB query results into the per-cell
 * layout expected by H3FlexRenderer._directWriteToTex() / writeTexture().
 *
 * Cells not present in the lookup are set to NaN (rendered as transparent by the shader).
 *
 * @param {BigUint64Array} meshCellIds - ordered H3 cell IDs from the loaded mesh
 * @param {Map<bigint, number>} valueLookup - h3CellId → metric value from query result
 * @param {Float32Array} [dst] - optional pre-allocated buffer; reallocated if wrong size
 * @returns {Float32Array}
 */
export function buildDenseEpochBuffer(meshCellIds, valueLookup, dst) {
  const n = meshCellIds.length;
  if (!dst || dst.length !== n) {
    dst = new Float32Array(n);
  }
  dst.fill(0);
  for (let i = 0; i < n; i++) {
    const val = valueLookup.get(meshCellIds[i]);
    if (val !== undefined) dst[i] = val;
  }
  return dst;
}

/**
 * Default ramp style spec for H3 layers when no style is provided.
 * Both H3FlexRenderer and H3FlexRenderer duplicate this — centralized here.
 *
 * @param {string} [firstAttr='value'] - the first temporal attribute name to use
 * @returns {Object} - StyleEngine ramp spec
 */
export function defaultH3StyleSpec(firstAttr = 'value') {
  return {
    type: 'ramp',
    attribute: firstAttr,
    domain: [0, 100],
    stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319'],
    opacityStops: [
      { value: 0, opacity: 0.0 },
      { value: 5, opacity: 0.3 },
      { value: 25, opacity: 0.55 },
      { value: 60, opacity: 0.75 },
      { value: 100, opacity: 0.9 },
    ],
  };
}
