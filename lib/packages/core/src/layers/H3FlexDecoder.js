/**
 * H3FlexDecoder.js — Zero-copy H3Flex Binary decoder (with pre-computed mesh).
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
      `[H3Flex] safeView overflow: ${ArrayType.name}[${count}] at offset ${offset}, ` +
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

export async function decodeH3Flex(buffer, manifest) {
  if (!manifest)
    throw new Error('[H3Flex] decodeH3Flex requires a manifest to resolve SHD3 column names');

  const {
    epochCount,
    entityCount,
    columns: shardCols,
    dictionaries,
    types,
    rawSchema,
  } = await decodeShardV3(buffer);

  // Extract core H3Flex properties mapping
  const cellIdsBuf = shardCols.get('h3_cell_id');
  const cellIds = cellIdsBuf ? createTypedArray('uint64', cellIdsBuf) : new BigUint64Array(0);

  const cellIndexBuf = shardCols.get('_cell_index');
  const isRowLevel = !!cellIndexBuf || (rawSchema && rawSchema.is_row_level);
  const cellIndex = cellIndexBuf ? createTypedArray('uint32', cellIndexBuf) : null;

  // Check for mesh presence
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
  const outDictionaries = {};
  const legacyGlobalDict = manifest.dictionary || [];
  if (dictionaries) {
    for (const [colName, dictArray] of dictionaries.entries()) {
      outDictionaries[colName] = dictArray;
    }
  }
  const dataCount = entityCount;
  let hasTemporal = false;

  for (const col of schema) {
    const buf = shardCols.get(col.name);
    if (!buf) continue;

    const rowCount = col.temporal ? epochCount * dataCount : dataCount;
    const typedArray = createTypedArray(types.get(col.name), buf, rowCount);

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
    cellCount: isRowLevel ? cellIds.length || 0 : entityCount,
    colCount: schema.length,
    epochCount: manifest.epochCount ?? epochCount,
    epochInterval: manifest.epochInterval || 0,
    schema: schema.map((c) => ({ name: c.name, type: 0, temporal: c.temporal ? 1 : 0 })),
    dictionaries: outDictionaries,
    cellIds,
    cellIndex,
    mesh,
    staticColumns,
    temporalColumns,
    hasTemporal,
    hasMesh: !!mesh,
    hasStyle: !!manifest.style,
    embeddedStyle: manifest.style || null,
    isRowLevel,
    rowCount: isRowLevel ? entityCount : 0,
    dataCount,
  };
}

/**
 * Decode a standalone H3M1 mesh file (separate from the base H3F file).
 * Format: 16-byte header + raw mesh arrays.
 *   Header: magic[4] "H3M1" + vertCount[4] + idxCount[4] + cellCount[4]
 *   Body:   positions[vert*3] + cellIndices[vert] + extrudeFlags[vert] + indices[idx]
 *
 * @param {ArrayBuffer} buffer — The raw mesh file buffer
 * @returns {{ positions: Float32Array, cellIndices: Float32Array, extrudeFlags: Float32Array, indices: Uint32Array, vertexCount: number, indexCount: number }}
 */
export function decodeH3Mesh(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (magic !== 'H3M1' && magic !== 'H3M2') throw new Error('Invalid H3Mesh magic: ' + magic);

  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const cellCount = view.getUint32(12, true);
  let offset = 16;

  const positions = safeView(Float32Array, buffer, offset, vertexCount * 3);
  offset += vertexCount * 3 * 4;

  const cellIndices = safeView(Float32Array, buffer, offset, vertexCount);
  offset += vertexCount * 4;

  const extrudeFlags = safeView(Float32Array, buffer, offset, vertexCount);
  offset += vertexCount * 4;

  const indices = safeView(Uint32Array, buffer, offset, indexCount);
  offset += indexCount * 4;

  // H3M2: embedded cell IDs (BigUint64Array[cellCount])
  let cellIds = null;
  if (magic === 'H3M2' && offset + cellCount * 8 <= buffer.byteLength) {
    if (offset % 8 !== 0) {
      const aligned = new ArrayBuffer(cellCount * 8);
      new Uint8Array(aligned).set(new Uint8Array(buffer, offset, cellCount * 8));
      cellIds = new BigUint64Array(aligned);
    } else {
      cellIds = new BigUint64Array(buffer, offset, cellCount);
    }
    offset += cellCount * 8;
  }

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
