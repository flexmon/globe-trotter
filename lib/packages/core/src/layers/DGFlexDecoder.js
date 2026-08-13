/**
 * DGFlexDecoder.js — Zero-copy DGFlex Binary decoder (with arbitrary DGFlex DGGrid meshes).
 * Creates typed array views directly into the network ArrayBuffer.
 */

const TYPE_SIZES = { 1: 4, 2: 8, 3: 4, 4: 4, 5: 4, 6: 2, 7: 1, 8: 1, 9: 4 };
const TYPE_ARRAYS = {
  1: Float32Array,
  2: Float64Array,
  3: Int32Array,
  4: Uint32Array,
  5: Uint32Array,
  6: Uint16Array,
  7: Uint8Array,
  8: Uint8Array,
  9: Uint32Array,
};

/**
 * Try to create a typed array view; falls back to aligned copy if misaligned.
 */
function safeView(ArrayType, buffer, offset, count) {
  const elemSize = ArrayType.BYTES_PER_ELEMENT;
  const byteLen = count * elemSize;
  const endByte = offset + byteLen;
  if (endByte > buffer.byteLength) {
    throw new RangeError(
      `[DGFlex] safeView overflow: ${ArrayType.name}[${count}] at offset ${offset}, ` +
        `needs ${endByte} bytes but buffer is only ${buffer.byteLength} bytes ` +
        `(overflow by ${endByte - buffer.byteLength})`
    );
  }
  if (offset % elemSize !== 0) {
    const aligned = new ArrayBuffer(byteLen);
    new Uint8Array(aligned).set(new Uint8Array(buffer, offset, byteLen));
    return new ArrayType(aligned);
  }
  return new ArrayType(buffer, offset, count);
}

import { decodeShardV3, createTypedArray } from '../../../data-sdk/src/decoders/ShardV3Decoder.js';

export async function decodeDGFlex(buffer, manifest) {
  if (!manifest)
    throw new Error('[DGFlex] decodeDGFlex requires a manifest to resolve SHD3 column names');

  const {
    epochCount,
    entityCount,
    columns: shardCols,
    dictionaries,
    types,
    rawSchema,
  } = await decodeShardV3(buffer);

  // Extract core DGFlex properties mapping
  const cellIdsBuf = shardCols.get('_dg_cell_id');
  const cellIds = cellIdsBuf ? createTypedArray('uint64', cellIdsBuf) : new BigUint64Array(0);

  const cellIndexBuf = shardCols.get('_cell_index');
  const isRowLevel = !!cellIndexBuf || (rawSchema && rawSchema.is_row_level);
  const cellIndex = cellIndexBuf ? createTypedArray('uint32', cellIndexBuf) : null;

  // Check for mesh presence (if embedded in SHD3 natively)
  let mesh = null;
  const posBuf = shardCols.get('_mesh_positions');
  if (posBuf) {
    const positions = createTypedArray('float32', posBuf);
    const cellIndices = createTypedArray('float32', shardCols.get('_mesh_cell_indices'));
    const extrudeFlags = createTypedArray('float32', shardCols.get('_mesh_extrude_flags'));
    const indices = createTypedArray('uint32', shardCols.get('_mesh_indices'));
    mesh = {
      positions,
      cellIndices,
      extrudeFlags,
      indices,
      vertexCount: positions.length / 3,
      indexCount: indices.length,
    };
  }

  // Extract schema attributes mapped from manifest
  const staticColumns = {};
  const temporalColumns = {};
  const schema = manifest.columns || [];
  let dictionary = manifest.dictionary || [];
  if (dictionaries && dictionaries.size > 0) {
    dictionary = Array.from(dictionaries.values())[0];
  }
  const dataCount = entityCount;
  let hasTemporal = false;

  for (const col of schema) {
    const buf = shardCols.get(col.name);
    if (!buf) continue;

    const typedArray = createTypedArray(types.get(col.name), buf);

    if (col.temporal) {
      temporalColumns[col.name] = typedArray;
      hasTemporal = true;
    } else {
      staticColumns[col.name] = typedArray;
    }
  }

  if (!mesh && (manifest.meshTiles || manifest.mesh)) {
    mesh = {
      vertexCount: 0,
      indexCount: 0,
      positions: new Float32Array(0),
      cellIndices: new Float32Array(0),
      extrudeFlags: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  return {
    version: 3,
    format: 'dgflex',
    cellCount: isRowLevel ? cellIds.length || 0 : entityCount,
    colCount: schema.length,
    epochCount: manifest.epochCount || epochCount,
    epochInterval: manifest.epochInterval || 0,
    schema: schema.map((c) => ({ name: c.name, type: 0, temporal: c.temporal ? 1 : 0 })),
    dictionary,
    cellIds,
    cellIndex,
    mesh,
    staticColumns,
    temporalColumns,
    hasTemporal,
    hasMesh: !!mesh,
    hasStyle: false,
    embeddedStyle: null,
    isRowLevel,
    rowCount: isRowLevel ? entityCount : 0,
    dataCount,
  };
}

/**
 * Decode a standalone DGM1 mesh file (separate from the base DGF file).
 * Format: 16-byte header + cellIds + raw mesh arrays.
 *   Header: magic[4] "DGM1" + vertCount[4] + idxCount[4] + cellCount[4]
 *   CellIDs: BigUint64Array[cellCount]
 *   Body:   positions[vert*3] + cellIndices[vert] + extrudeFlags[vert] + indices[idx]
 *
 * @param {ArrayBuffer} buffer — The raw mesh file buffer
 * @returns {{ positions: Float32Array, cellIndices: Float32Array, extrudeFlags: Float32Array, indices: Uint32Array, vertexCount: number, indexCount: number, cellCount: number, cellIds: BigUint64Array }}
 */
export function decodeDGFMesh(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== 'DGM1') throw new Error('Invalid DGFMesh magic: ' + magic);

  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const cellCount = view.getUint32(12, true);
  let offset = 16;

  let cellIds = null;
  if (offset + cellCount * 8 <= buffer.byteLength) {
    if (offset % 8 !== 0) {
      const aligned = new ArrayBuffer(cellCount * 8);
      new Uint8Array(aligned).set(new Uint8Array(buffer, offset, cellCount * 8));
      cellIds = new BigUint64Array(aligned);
    } else {
      cellIds = new BigUint64Array(buffer, offset, cellCount);
    }
    offset += cellCount * 8;
  }

  const positions = safeView(Float32Array, buffer, offset, vertexCount * 3);
  offset += vertexCount * 3 * 4;

  const cellIndices = safeView(Float32Array, buffer, offset, vertexCount);
  offset += vertexCount * 4;

  const extrudeFlags = safeView(Float32Array, buffer, offset, vertexCount);
  offset += vertexCount * 4;

  const indices = safeView(Uint32Array, buffer, offset, indexCount);
  offset += indexCount * 4;

  return {
    positions,
    cellIndices,
    extrudeFlags,
    indices,
    vertexCount,
    indexCount,
    cellCount,
    cellIds,
  };
}
