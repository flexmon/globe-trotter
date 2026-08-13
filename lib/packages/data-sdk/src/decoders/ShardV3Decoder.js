/**
 * ShardV3Decoder.js — Fast selective column fetcher and decoder for SHD3 shard files.
 *
 * Browser-only (no Node.js dependencies). Uses:
 *   - HTTP Range Requests for selective column fetching
 *   - DecompressionStream ('gzip') for in-browser decompression
 *   - DataView / TypedArray for zero-copy binary parsing
 *
 * Optimized for minimal latency:
 *   - Parse unified SHD3 JSON schema from the byte header
 *   - Single-request path: header probe + column data in one Range request
 *   - Parallel group fetches for multi-column requests
 *   - Automatic fallback to full-file fetch if Range not supported (HTTP 200)
 *   - Column coalescing for adjacent columns (< 4 KB gap)
 *   - Parallel DecompressionStream per column
 */

const SHD3_MAGIC = [0x53, 0x48, 0x44, 0x33]; // "SHD3"

// ─────────────────────────────────────────────────────────────────────────────
// Type dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instantiate the correct TypedArray view for a buffer given its SHD3 dataType string.
 * Handles byte-alignment copying automatically so callers never get a misaligned view.
 *
 * @param {string} dataType - SHD3 data_type string (e.g. 'float32', 'enum16', 'uint64')
 * @param {ArrayBuffer|ArrayBufferView} bufferOrView
 * @param {number} [rowCount] - Required only for 'boolean' columns
 * @returns {TypedArray}
 */
export function createTypedArray(dataType, bufferOrView, rowCount) {
  // Pre-parsed list column objects from parseListColumn — return as-is
  if (dataType && dataType.startsWith('list_')) {
    return bufferOrView;
  }

  const isView = ArrayBuffer.isView(bufferOrView);
  const buffer = isView ? bufferOrView.buffer : bufferOrView;
  const byteOffset = isView ? bufferOrView.byteOffset : 0;
  const byteLength = isView ? bufferOrView.byteLength : buffer.byteLength;

  if (dataType === 'boolean') {
    return _decodeBooleanColumn(buffer, byteOffset, byteLength, rowCount);
  }

  let ArrayType;
  switch (dataType) {
    case 'float32':
      ArrayType = Float32Array;
      break;
    case 'float64':
      ArrayType = Float64Array;
      break;
    case 'int32':
      ArrayType = Int32Array;
      break;
    case 'uint32':
    case 'u_int32':
      ArrayType = Uint32Array;
      break;
    case 'dict_string':
    case 'enum16':
      ArrayType = Uint16Array;
      break;
    case 'dict_string32':
    case 'enum32':
      ArrayType = Uint32Array;
      break;
    case 'uint8':
    case 'u_int8':
      return new Uint8Array(buffer, byteOffset, byteLength);
    case 'int8':
      return new Int8Array(buffer, byteOffset, byteLength);
    case 'uint16':
    case 'u_int16':
      ArrayType = Uint16Array;
      break;
    case 'int16':
      ArrayType = Int16Array;
      break;
    case 'int64':
    case 'timestamp_s':
    case 'timestamp_ms':
    case 'timestamp_us':
    case 'timestamp_ns':
      ArrayType = BigInt64Array;
      break;
    case 'uint64':
    case 'u_int64':
      ArrayType = BigUint64Array;
      break;
    default:
      ArrayType = Float32Array;
      break;
  }

  if (byteOffset % ArrayType.BYTES_PER_ELEMENT !== 0) {
    // Misaligned — copy to an aligned buffer
    const aligned = new ArrayBuffer(byteLength);
    new Uint8Array(aligned).set(new Uint8Array(buffer, byteOffset, byteLength));
    return new ArrayType(aligned);
  }
  return new ArrayType(buffer, byteOffset, byteLength / ArrayType.BYTES_PER_ELEMENT);
}

/**
 * Decode a bit-packed boolean column into a flat Uint8Array of 0/1 values.
 * Each byte in the source buffer encodes 8 rows in LSB-first order.
 *
 * @param {ArrayBuffer} buffer - Source ArrayBuffer
 * @param {number} byteOffset - Byte offset into the buffer where the column data starts
 * @param {number} byteLength - Number of bytes of compressed boolean data
 * @param {number} expectedRowCount - Total number of rows; determines output array length
 * @returns {Uint8Array} Flat array of 0/1 values, one entry per row
 */
function _decodeBooleanColumn(buffer, byteOffset, byteLength, expectedRowCount) {
  const view = new Uint8Array(buffer, byteOffset, byteLength);
  const result = new Uint8Array(expectedRowCount);
  for (let i = 0; i < expectedRowCount; i++) {
    result[i] = (view[Math.floor(i / 8)] >> (i % 8)) & 1 ? 1 : 0;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHD3 header parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a SHD3 header from an ArrayBuffer.
 *
 * @param {ArrayBuffer} buf
 * @returns {ShardIndex|null} null if the magic bytes don't match or the buffer is too small
 *
 * @typedef {Object} ShardIndex
 * @property {number} epochCount
 * @property {number} entityCount
 * @property {number} columnCount
 * @property {ShardEntry[]} entries
 * @property {number} headerBytes - byte offset where column data begins
 * @property {Object} rawSchema - the parsed JSON schema object
 *
 * @typedef {Object} ShardEntry
 * @property {string} name
 * @property {string} dataType
 * @property {boolean} nullable
 * @property {number} offset - byte offset of this column's compressed data
 * @property {number} compressedLen
 * @property {number} decompressedLen
 */
export function parseShardHeader(buf) {
  if (buf.byteLength < 8) return null;

  const magic = new Uint8Array(buf, 0, 4);
  if (
    magic[0] !== SHD3_MAGIC[0] ||
    magic[1] !== SHD3_MAGIC[1] ||
    magic[2] !== SHD3_MAGIC[2] ||
    magic[3] !== SHD3_MAGIC[3]
  ) {
    return null;
  }

  const view = new DataView(buf);
  const jsonLen = view.getUint32(4, true);
  const headerBytes = 8 + jsonLen;
  if (buf.byteLength < headerBytes) return null;

  let schema;
  try {
    schema = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf, 8, jsonLen)));
  } catch {
    return null;
  }

  const entries = [];
  let currentOffset = headerBytes;
  for (const col of schema.columns) {
    entries.push({
      name: col.name,
      dataType: col.data_type,
      nullable: col.nullable,
      offset: currentOffset,
      compressedLen: col.compressed_len,
      decompressedLen: col.decompressed_len,
    });
    currentOffset += col.compressed_len;
  }

  return {
    epochCount: schema.epoch_count,
    entityCount: schema.entity_count,
    columnCount: schema.columns.length,
    entries,
    headerBytes,
    rawSchema: schema,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gzip decompression (browser / Node 18+)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decompress a gzip-compressed ArrayBuffer.
 * Uses the browser's native `DecompressionStream` (available in all modern browsers
 * and Node.js 18+).
 *
 * @param {ArrayBuffer} slice - gzip-compressed bytes
 * @returns {Promise<ArrayBuffer>}
 */
export async function decompress(slice) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(slice));
  writer.close();
  return new Response(ds.readable).arrayBuffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// dict_string32 and dictlistfloat16 column parsers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unpack a raw buffer encoded by `dict_string32` into a string dictionary and
 * a Uint32Array of per-row indices.
 *
 * Wire format:
 *   [dictCount: uint32] [offsets: uint32 × (dictCount+1)] [chars: utf8 bytes] [indices: uint32 × rowCount]
 *
 * @param {ArrayBuffer|ArrayBufferView} bufferOrView
 * @returns {{ dictionary: string[], indicesBuffer: Uint32Array }}
 */
export function parseDict32Column(bufferOrView) {
  const isView = ArrayBuffer.isView(bufferOrView);
  const buffer = isView ? bufferOrView.buffer : bufferOrView;
  const byteOffset = isView ? bufferOrView.byteOffset : 0;
  const byteLength = isView ? bufferOrView.byteLength : buffer.byteLength;

  const view = new DataView(buffer, byteOffset, byteLength);
  const decoder = new TextDecoder('utf-8');
  let pos = 0;

  const dictCount = view.getUint32(pos, true);
  pos += 4;

  const offsetsLen = dictCount + 1;
  const offsetsBytes = offsetsLen * 4;
  // Alignment guard on the offsets view
  let offsets;
  if ((byteOffset + pos) % 4 !== 0) {
    const aligned = new ArrayBuffer(offsetsBytes);
    new Uint8Array(aligned).set(new Uint8Array(buffer, byteOffset + pos, offsetsBytes));
    offsets = new Uint32Array(aligned);
  } else {
    offsets = new Uint32Array(buffer, byteOffset + pos, offsetsLen);
  }
  pos += offsetsBytes;

  const charsLen = offsets[dictCount]; // last offset = total char bytes
  const charsData = new Uint8Array(buffer, byteOffset + pos, charsLen);
  pos += charsLen;

  const dictionary = new Array(dictCount);
  for (let i = 0; i < dictCount; i++) {
    const start = offsets[i];
    const end = offsets[i + 1];
    dictionary[i] = start === end ? '' : decoder.decode(charsData.subarray(start, end));
  }

  const dataOffset = byteOffset + pos;
  const dataLen = byteLength - pos;
  let indicesBuffer;
  if (dataOffset % 4 !== 0) {
    const aligned = new ArrayBuffer(dataLen);
    new Uint8Array(aligned).set(new Uint8Array(buffer, dataOffset, dataLen));
    indicesBuffer = new Uint32Array(aligned);
  } else {
    indicesBuffer = new Uint32Array(buffer, dataOffset, dataLen / 4);
  }

  return { dictionary, indicesBuffer };
}

/**
 * Unpack a raw buffer encoded by `dict_string` (16-bit keys) into a string
 * dictionary and a Uint16Array of per-row indices.
 *
 * Wire format:
 *   [dictCount: uint16] [strLen₀: uint16 + chars₀] [...] [indices: uint16 × rowCount]
 *
 * @param {ArrayBuffer|ArrayBufferView} bufferOrView
 * @returns {{ dictionary: string[], indicesBuffer: Uint16Array }}
 */
export function parseDictStringColumn(bufferOrView) {
  const isView = ArrayBuffer.isView(bufferOrView);
  const buffer = isView ? bufferOrView.buffer : bufferOrView;
  const byteOffset = isView ? bufferOrView.byteOffset : 0;
  const byteLength = isView ? bufferOrView.byteLength : buffer.byteLength;

  const view = new DataView(buffer, byteOffset, byteLength);
  const decoder = new TextDecoder('utf-8');
  let pos = 0;

  const dictCount = view.getUint16(pos, true);
  pos += 2;

  const dictionary = new Array(dictCount);
  for (let i = 0; i < dictCount; i++) {
    const strLen = view.getUint16(pos, true);
    pos += 2;
    dictionary[i] = decoder.decode(new Uint8Array(buffer, byteOffset + pos, strLen));
    pos += strLen;
  }

  const dataOffset = byteOffset + pos;
  const dataLen = byteLength - pos;
  let indicesBuffer;
  if (dataOffset % 2 !== 0) {
    const aligned = new ArrayBuffer(dataLen);
    new Uint8Array(aligned).set(new Uint8Array(buffer, dataOffset, dataLen));
    indicesBuffer = new Uint16Array(aligned);
  } else {
    indicesBuffer = new Uint16Array(buffer, dataOffset, dataLen / 2);
  }

  return { dictionary, indicesBuffer };
}

/**
 * Unpack a raw buffer encoded by `dictlistfloat16` into a Float16 dictionary
 * (as a Uint16Array) and a Uint32Array of per-row indices.
 *
 * Wire format:
 *   [dictCount: uint32] [f16 vectors: uint16 × (dictCount × 384)] [indices: uint32 × rowCount]
 *
 * @param {ArrayBuffer|ArrayBufferView} bufferOrView
 * @returns {{ dictionary: Uint16Array, indicesBuffer: Uint32Array }}
 */
export function parseDictListFloat16Column(bufferOrView) {
  const isView = ArrayBuffer.isView(bufferOrView);
  const buffer = isView ? bufferOrView.buffer : bufferOrView;
  const byteOffset = isView ? bufferOrView.byteOffset : 0;
  const byteLength = isView ? bufferOrView.byteLength : buffer.byteLength;

  const view = new DataView(buffer, byteOffset, byteLength);
  let pos = 0;

  const dictCount = view.getUint32(pos, true);
  pos += 4;

  const f16Bytes = dictCount * 384 * 2; // 384 f16 values per entry
  let dictionaryBuffer;
  if ((byteOffset + pos) % 2 !== 0) {
    const aligned = new ArrayBuffer(f16Bytes);
    new Uint8Array(aligned).set(new Uint8Array(buffer, byteOffset + pos, f16Bytes));
    dictionaryBuffer = new Uint16Array(aligned);
  } else {
    dictionaryBuffer = new Uint16Array(buffer, byteOffset + pos, dictCount * 384);
  }
  pos += f16Bytes;

  const dataOffset = byteOffset + pos;
  const dataLen = byteLength - pos;
  let indicesBuffer;
  if (dataOffset % 4 !== 0) {
    const aligned = new ArrayBuffer(dataLen);
    new Uint8Array(aligned).set(new Uint8Array(buffer, dataOffset, dataLen));
    indicesBuffer = new Uint32Array(aligned);
  } else {
    indicesBuffer = new Uint32Array(buffer, dataOffset, dataLen / 4);
  }

  return { dictionary: dictionaryBuffer, indicesBuffer };
}

// ─────────────────────────────────────────────────────────────────────────────
// List / repeated-column parser
// ─────────────────────────────────────────────────────────────────────────────

function _listInnerCtor(innerType) {
  switch (innerType) {
    case 'int8':
      return Int8Array;
    case 'int16':
      return Int16Array;
    case 'int32':
      return Int32Array;
    case 'int64':
    case 'timestamp_s':
    case 'timestamp_ms':
    case 'timestamp_us':
    case 'timestamp_ns':
      return BigInt64Array;
    case 'uint8':
      return Uint8Array;
    case 'uint16':
      return Uint16Array;
    case 'uint32':
      return Uint32Array;
    case 'uint64':
      return BigUint64Array;
    case 'float32':
      return Float32Array;
    case 'float64':
      return Float64Array;
    default:
      return Uint8Array;
  }
}

/**
 * Parse a decompressed list/repeated column buffer into a structured object.
 *
 * Validity bitmap layout: [len: u32 LE][bytes] — len=0 means no nulls; bit i is 1 if valid (LSB first).
 *
 * Primitive/boolean wire format:
 *   [list-validity][i32 offsets×(rows+1)][values-validity][values raw bytes]
 *   For boolean: values are bit-packed, ceil(total/8) bytes.
 *
 * list_string wire format:
 *   [list-validity][dict_count: u32][dict_offsets: u32×(n+1)][dict_chars: UTF-8]
 *   [list_offsets: i32×(rows+1)][string_indices: u32×total] (u32::MAX = null element)
 *
 * @param {ArrayBuffer} rawBuf - Decompressed column bytes
 * @param {string} dataType - e.g. 'list_float64', 'list_string', 'list_int32'
 * @param {number} rowCount - Number of rows (epochCount × entityCount)
 * @returns {{ offsets: Int32Array, values: TypedArray, nullMask: Uint8Array|null }
 *          | { offsets: Int32Array, indices: Uint32Array, dictionary: string[], nullMask: Uint8Array|null }}
 */
export function parseListColumn(rawBuf, dataType, rowCount) {
  const bytes = new Uint8Array(rawBuf);
  const dv = new DataView(rawBuf);
  let pos = 0;

  // List-level validity bitmap
  const bitmapLen = dv.getUint32(pos, true);
  pos += 4;
  let nullMask = null;
  if (bitmapLen > 0) {
    nullMask = new Uint8Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
      nullMask[i] = (bytes[pos + (i >> 3)] >> (i & 7)) & 1;
    }
    pos += bitmapLen;
  }

  if (dataType === 'list_string') {
    const dictCount = dv.getUint32(pos, true);
    pos += 4;

    const dictOffsetsByteLen = (dictCount + 1) * 4;
    let dictOffsets;
    if (pos % 4 !== 0) {
      const aligned = new ArrayBuffer(dictOffsetsByteLen);
      new Uint8Array(aligned).set(bytes.subarray(pos, pos + dictOffsetsByteLen));
      dictOffsets = new Uint32Array(aligned);
    } else {
      dictOffsets = new Uint32Array(rawBuf, pos, dictCount + 1);
    }
    pos += dictOffsetsByteLen;

    const charsLen = dictOffsets[dictCount];
    const textDecoder = new TextDecoder('utf-8');
    const dictionary = new Array(dictCount);
    for (let i = 0; i < dictCount; i++) {
      const s = pos + dictOffsets[i];
      const e = pos + dictOffsets[i + 1];
      dictionary[i] = textDecoder.decode(bytes.subarray(s, e));
    }
    pos += charsLen;

    const listOffsetsByteLen = (rowCount + 1) * 4;
    let offsets;
    if (pos % 4 !== 0) {
      const aligned = new ArrayBuffer(listOffsetsByteLen);
      new Uint8Array(aligned).set(bytes.subarray(pos, pos + listOffsetsByteLen));
      offsets = new Int32Array(aligned);
    } else {
      offsets = new Int32Array(rawBuf, pos, rowCount + 1);
    }
    pos += listOffsetsByteLen;
    const totalValues = offsets[rowCount];

    const indicesByteLen = totalValues * 4;
    let indices;
    if (pos % 4 !== 0) {
      const aligned = new ArrayBuffer(indicesByteLen);
      new Uint8Array(aligned).set(bytes.subarray(pos, pos + indicesByteLen));
      indices = new Uint32Array(aligned);
    } else {
      indices = new Uint32Array(rawBuf, pos, totalValues);
    }

    return { offsets, indices, dictionary, nullMask };
  }

  // Primitive and boolean list columns

  const offsetsByteLen = (rowCount + 1) * 4;
  let offsets;
  if (pos % 4 !== 0) {
    const aligned = new ArrayBuffer(offsetsByteLen);
    new Uint8Array(aligned).set(bytes.subarray(pos, pos + offsetsByteLen));
    offsets = new Int32Array(aligned);
  } else {
    offsets = new Int32Array(rawBuf, pos, rowCount + 1);
  }
  pos += offsetsByteLen;
  const totalValues = offsets[rowCount];

  // Values-level validity bitmap (consumed but not separately exposed)
  const valuesBitmapLen = dv.getUint32(pos, true);
  pos += 4;
  if (valuesBitmapLen > 0) pos += valuesBitmapLen;

  let values;
  if (dataType === 'list_boolean') {
    values = new Uint8Array(totalValues);
    for (let i = 0; i < totalValues; i++) {
      values[i] = (bytes[pos + (i >> 3)] >> (i & 7)) & 1;
    }
  } else {
    const innerType = dataType.slice(5); // 'list_float64' → 'float64'
    const Ctor = _listInnerCtor(innerType);
    const width = Ctor.BYTES_PER_ELEMENT;
    const valuesByteLen = totalValues * width;
    if (pos % width !== 0) {
      const aligned = new ArrayBuffer(valuesByteLen);
      new Uint8Array(aligned).set(bytes.subarray(pos, pos + valuesByteLen));
      values = new Ctor(aligned);
    } else {
      values = new Ctor(rawBuf, pos, totalValues);
    }
  }

  return { offsets, values, nullMask };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers for dict/special-column processing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a decompressed column buffer for dict-encoded types.
 * Mutates the `columns` and `dictionaries` maps in place.
 *
 * @param {string} name
 * @param {string} dataType
 * @param {ArrayBuffer} rawBuf
 * @param {Map<string, ArrayBuffer>} columns
 * @param {Map<string, any>} dictionaries
 * @param {number} [rowCount] - Required for list_* types (epochCount × entityCount)
 */
function _processColumnBuffer(name, dataType, rawBuf, columns, dictionaries, rowCount) {
  if (dataType === 'dict_string32' && rawBuf.byteLength > 0) {
    const { dictionary, indicesBuffer } = parseDict32Column(rawBuf);
    columns.set(
      name,
      indicesBuffer.buffer.slice(
        indicesBuffer.byteOffset,
        indicesBuffer.byteOffset + indicesBuffer.byteLength
      )
    );
    dictionaries.set(name, dictionary);
  } else if (dataType === 'dict_string' && rawBuf.byteLength > 0) {
    const { dictionary, indicesBuffer } = parseDictStringColumn(rawBuf);
    columns.set(
      name,
      indicesBuffer.buffer.slice(
        indicesBuffer.byteOffset,
        indicesBuffer.byteOffset + indicesBuffer.byteLength
      )
    );
    dictionaries.set(name, dictionary);
  } else if (dataType === 'dictlistfloat16' && rawBuf.byteLength > 0) {
    const { dictionary, indicesBuffer } = parseDictListFloat16Column(rawBuf);
    columns.set(
      name,
      indicesBuffer.buffer.slice(
        indicesBuffer.byteOffset,
        indicesBuffer.byteOffset + indicesBuffer.byteLength
      )
    );
    dictionaries.set(name, dictionary);
  } else if (dataType && dataType.startsWith('list_') && rawBuf.byteLength > 0 && rowCount > 0) {
    const parsed = parseListColumn(rawBuf, dataType, rowCount);
    columns.set(name, parsed);
    if (parsed.dictionary) dictionaries.set(name, parsed.dictionary);
  } else {
    columns.set(name, rawBuf);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch-based column retrieval
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch specific columns from a SHD3 shard file using HTTP Range Requests.
 *
 * Returns null if the server does not support Range requests (HTTP 200 instead of 206).
 * Callers should fall back to `fetchFullAndFilter` in that case, or use `fetchColumns`
 * which handles the fallback automatically.
 *
 * @param {string} url
 * @param {string[]} columnNames
 * @param {ShardIndex} [cachedIndex]
 * @returns {Promise<{columns: Map<string, ArrayBuffer>, index: ShardIndex, dictionaries: Map, types: Map}|null>}
 */
export async function fetchSelectiveColumns(url, columnNames, cachedIndex) {
  const requestedNames = new Set(columnNames);
  let index = cachedIndex;
  let headerBuf = null;

  if (!index) {
    const PROBE_BYTES = 1024;
    const probeResp = await fetch(url, { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` } });
    if (probeResp.status !== 206) {
      // Server doesn't support Range requests — cancel the response body
      // immediately so the browser releases the connection rather than
      // downloading the full file in the background. Without this, the
      // ignored body consumes a connection slot and can starve subsequent
      // fetches when multiple shards are prefetched concurrently.
      probeResp.body?.cancel().catch(() => {});
      return null; // Range not supported
    }

    headerBuf = await probeResp.arrayBuffer();

    // If the probe didn't capture the full JSON schema, fetch the exact header
    if (headerBuf.byteLength >= 8) {
      const jsonLen = new DataView(headerBuf).getUint32(4, true);
      if (jsonLen + 8 > headerBuf.byteLength) {
        headerBuf = await (
          await fetch(url, { headers: { Range: `bytes=0-${jsonLen + 7}` } })
        ).arrayBuffer();
      }
    }

    index = parseShardHeader(headerBuf);
    if (!index) return null;
  }

  const neededEntries = index.entries.filter((e) => requestedNames.has(e.name));
  if (neededEntries.length === 0) {
    return { columns: new Map(), index, dictionaries: new Map(), types: new Map() };
  }

  neededEntries.sort((a, b) => a.offset - b.offset);

  const columns = new Map();
  const dictionaries = new Map();
  const types = new Map();
  const stillNeeded = [];
  const rowCount = index.epochCount * index.entityCount;

  // Pull columns already captured inside the header probe buffer
  if (headerBuf) {
    for (const entry of neededEntries) {
      const end = entry.offset + entry.compressedLen;
      if (end <= headerBuf.byteLength) {
        types.set(entry.name, entry.dataType);
        const rawBuf =
          entry.compressedLen > 0
            ? await decompress(headerBuf.slice(entry.offset, end))
            : new ArrayBuffer(0);
        _processColumnBuffer(entry.name, entry.dataType, rawBuf, columns, dictionaries, rowCount);
      } else {
        stillNeeded.push(entry);
      }
    }
  } else {
    stillNeeded.push(...neededEntries);
  }

  if (stillNeeded.length === 0) return { columns, index, dictionaries, types };

  // Coalesce nearby column ranges into group fetches (< 4 KB gap)
  const COALESCE_GAP = 4096;
  const groups = [];
  let cur = {
    start: stillNeeded[0].offset,
    end: stillNeeded[0].offset + stillNeeded[0].compressedLen,
    entries: [stillNeeded[0]],
  };
  for (let i = 1; i < stillNeeded.length; i++) {
    const e = stillNeeded[i];
    const eEnd = e.offset + e.compressedLen;
    if (e.offset - cur.end <= COALESCE_GAP) {
      cur.end = Math.max(cur.end, eEnd);
      cur.entries.push(e);
    } else {
      groups.push(cur);
      cur = { start: e.offset, end: eEnd, entries: [e] };
    }
  }
  groups.push(cur);

  const ok = await Promise.all(
    groups.map(async (group) => {
      const resp = await fetch(url, {
        headers: { Range: `bytes=${group.start}-${group.end - 1}` },
      });
      if (resp.status !== 206) return false;
      const groupBuf = await resp.arrayBuffer();

      await Promise.all(
        group.entries.map(async (entry) => {
          const localOff = entry.offset - group.start;
          const rawBuf =
            entry.compressedLen > 0
              ? await decompress(groupBuf.slice(localOff, localOff + entry.compressedLen))
              : new ArrayBuffer(0);
          types.set(entry.name, entry.dataType);
          _processColumnBuffer(entry.name, entry.dataType, rawBuf, columns, dictionaries, rowCount);
        })
      );
      return true;
    })
  );

  if (ok.some((r) => r === false)) return null;
  return { columns, index, dictionaries, types };
}

/**
 * Fetch the full shard file and extract only the requested columns.
 * Fallback when the server doesn't support Range requests.
 *
 * @param {string} url - URL of the SHD3 shard file
 * @param {string[]} columnNames - Column names to extract
 * @returns {Promise<{columns: Map, dictionaries: Map, types: Map}>}
 * @throws {Error} If the HTTP request fails (non-2xx response)
 */
export async function fetchFullAndFilter(url, columnNames) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch shard: ${resp.status}`);
  let buf = await resp.arrayBuffer();

  // Decompress the entire file if it's gzip-wrapped
  const m = new Uint8Array(buf, 0, 2);
  if (m[0] === 0x1f && m[1] === 0x8b) buf = await decompress(buf);

  const index = parseShardHeader(buf);
  if (!index) return { columns: null, rawBuffer: buf };

  const requestedNames = new Set(columnNames);
  const columns = new Map();
  const dictionaries = new Map();
  const types = new Map();
  const rowCount = index.epochCount * index.entityCount;

  await Promise.all(
    index.entries
      .filter((e) => requestedNames.has(e.name))
      .map(async (entry) => {
        types.set(entry.name, entry.dataType);
        const rawBuf =
          entry.compressedLen > 0
            ? await decompress(buf.slice(entry.offset, entry.offset + entry.compressedLen))
            : new ArrayBuffer(0);
        _processColumnBuffer(entry.name, entry.dataType, rawBuf, columns, dictionaries, rowCount);
      })
  );

  return { columns, dictionaries, types };
}

/**
 * Fetch columns with automatic Range/fallback selection.
 *
 * @param {string} url
 * @param {string[]} columnNames
 * @param {ShardIndex} [cachedIndex]
 * @returns {Promise<{columns: Map, index: ShardIndex|null, dictionaries: Map, types: Map}>}
 */
export async function fetchColumns(url, columnNames, cachedIndex) {
  const result = await fetchSelectiveColumns(url, columnNames, cachedIndex);
  if (result) return result;
  return fetchFullAndFilter(url, columnNames);
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory decode helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether an ArrayBuffer starts with the SHD3 magic bytes.
 *
 * @param {ArrayBuffer} buf
 * @returns {boolean}
 */
export function isShardV3(buf) {
  if (buf.byteLength < 4) return false;
  const m = new Uint8Array(buf, 0, 4);
  return m[0] === 0x53 && m[1] === 0x48 && m[2] === 0x44 && m[3] === 0x33;
}

/**
 * Decode all (or a selected subset of) columns from an in-memory SHD3 ArrayBuffer.
 *
 * @param {ArrayBuffer} buf - Full SHD3 binary (not URL, already in memory)
 * @param {Set<string>} [onlyNames] - If provided, only these columns are decoded
 * @returns {Promise<{epochCount: number, entityCount: number, columns: Map, dictionaries: Map, types: Map, rawSchema: Object}>}
 * @throws {Error} If the buffer does not start with a valid SHD3 magic header
 */
export async function decodeShardV3(buf, onlyNames) {
  const index = parseShardHeader(buf);
  if (!index) throw new Error('Invalid SHD3 header');

  const columns = new Map();
  const dictionaries = new Map();
  const types = new Map();
  const rowCount = index.epochCount * index.entityCount;

  await Promise.all(
    index.entries
      .filter((e) => !onlyNames || onlyNames.has(e.name))
      .map(async (entry) => {
        types.set(entry.name, entry.dataType);
        const rawBuf =
          entry.compressedLen > 0
            ? await decompress(buf.slice(entry.offset, entry.offset + entry.compressedLen))
            : new ArrayBuffer(0);
        _processColumnBuffer(entry.name, entry.dataType, rawBuf, columns, dictionaries, rowCount);
      })
  );

  return {
    epochCount: index.epochCount,
    entityCount: index.entityCount,
    columns,
    dictionaries,
    types,
    rawSchema: index.rawSchema,
  };
}
