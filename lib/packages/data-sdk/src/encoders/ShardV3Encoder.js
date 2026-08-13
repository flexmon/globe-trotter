import { gzipSync } from 'zlib';

const SHD3_MAGIC = Buffer.from('SHD3');

// ── Type codes (mapped to Rust FlexDataType snake_case strings) ──
export const TYPE_CODES = Object.freeze({
  FLOAT32: 'float32',
  FLOAT64: 'float64',
  INT32: 'int32',
  UINT32: 'u_int32',
  BOOLEAN: 'boolean',
  DICT_STR: 'dict_string',
  DICT_STR32: 'dict_string32',
  UINT8: 'u_int8',
  INT8: 'int8',
  UINT16: 'u_int16',
  INT16: 'int16',
  INT64: 'int64',
  TIMESTAMP: 'timestamp_s',
  UINT64: 'u_int64',
});

function inferTypeCode(data) {
  if (data instanceof Float32Array) return TYPE_CODES.FLOAT32;
  if (data instanceof Float64Array) return TYPE_CODES.FLOAT64;
  if (data instanceof Int32Array) return TYPE_CODES.INT32;
  if (data instanceof Uint32Array) return TYPE_CODES.UINT32;
  if (data instanceof Uint8Array) return TYPE_CODES.UINT8;
  if (data instanceof Int8Array) return TYPE_CODES.INT8;
  if (data instanceof Uint16Array) return TYPE_CODES.UINT16;
  if (data instanceof Int16Array) return TYPE_CODES.INT16;
  if (data instanceof BigInt64Array) return TYPE_CODES.INT64;
  if (data instanceof BigUint64Array) return TYPE_CODES.UINT64;
  return TYPE_CODES.FLOAT32;
}

function typeCodeToString(code) {
  if (typeof code === 'string') return code;
  switch (code) {
    case 0x01:
      return TYPE_CODES.FLOAT32;
    case 0x02:
      return TYPE_CODES.FLOAT64;
    case 0x03:
      return TYPE_CODES.INT32;
    case 0x04:
      return TYPE_CODES.UINT32;
    case 0x05:
      return TYPE_CODES.BOOLEAN;
    case 0x06:
      return TYPE_CODES.DICT_STR;
    case 0x07:
      return TYPE_CODES.UINT8;
    case 0x08:
      return TYPE_CODES.INT8;
    case 0x09:
      return TYPE_CODES.UINT16;
    case 0x0a:
      return TYPE_CODES.INT16;
    case 0x0b:
      return TYPE_CODES.INT64;
    case 0x0c:
      return TYPE_CODES.TIMESTAMP;
    case 0x0d:
      return TYPE_CODES.UINT64;
    case 0x0e:
      return TYPE_CODES.DICT_STR32;
    default:
      return TYPE_CODES.FLOAT32;
  }
}

export function encodeShardV3(columns, options = {}) {
  const epochCount = options.epochCount ?? 1;
  const entityCount = options.entityCount ?? (columns[0]?.data?.length || 0);
  const gzipLevel = options.gzipLevel ?? 1;

  // ── Phase 1: Encode + gzip each column independently ──
  const encodedColumns = columns.map((col) => {
    let typeCode = col.typeCode !== undefined ? col.typeCode : inferTypeCode(col.data);
    typeCode = typeCodeToString(typeCode);
    let rawBuffer;

    if (typeCode === TYPE_CODES.DICT_STR && col.dictionary) {
      rawBuffer = encodeDictColumn(col.data || new Uint16Array(), col.dictionary);
    } else if (typeCode === TYPE_CODES.DICT_STR32 && col.dictionary) {
      rawBuffer = encodeDict32Column(col.data || new Uint32Array(), col.dictionary);
    } else if (typeCode === TYPE_CODES.BOOLEAN) {
      rawBuffer = encodeBooleanColumn(col.data || new Uint8Array());
    } else if (col.data) {
      rawBuffer = Buffer.from(col.data.buffer, col.data.byteOffset, col.data.byteLength);
    } else {
      rawBuffer = Buffer.alloc(0);
    }

    const compressed = gzipSync(rawBuffer, { level: gzipLevel });

    return {
      name: col.name,
      dataType: typeCode,
      rawLength: rawBuffer.length,
      compressed,
      nullable: false,
    };
  });

  // ── Phase 2: Create JSON Schema ──
  const schemaObj = {
    epoch_count: epochCount,
    entity_count: entityCount,
    columns: encodedColumns.map((c) => ({
      name: c.name,
      data_type: c.dataType,
      nullable: c.nullable,
      compressed_len: c.compressed.length,
      decompressed_len: c.rawLength,
    })),
  };
  const schemaJson = JSON.stringify(schemaObj);
  const jsonBytes = Buffer.from(schemaJson, 'utf8');

  // ── Phase 3: Assemble the file ──
  const totalSize =
    8 + jsonBytes.length + encodedColumns.reduce((sum, c) => sum + c.compressed.length, 0);
  const output = Buffer.alloc(totalSize);
  let pos = 0;

  // Header (8 bytes)
  SHD3_MAGIC.copy(output, pos);
  pos += 4;
  output.writeUInt32LE(jsonBytes.length, pos);
  pos += 4;

  // JSON String
  jsonBytes.copy(output, pos);
  pos += jsonBytes.length;

  // Column data blocks
  for (const col of encodedColumns) {
    col.compressed.copy(output, pos);
    pos += col.compressed.length;
  }

  return output;
}

function encodeBooleanColumn(data) {
  const numRows = data.length;
  const bitmapSize = Math.ceil(numRows / 8);
  const buf = Buffer.alloc(bitmapSize);
  for (let i = 0; i < numRows; i++) {
    if (data[i]) {
      buf[Math.floor(i / 8)] |= 1 << (i % 8);
    }
  }
  return buf;
}

function encodeDictColumn(indices, dictionary) {
  let size = 2; // dict count
  for (const s of dictionary) {
    size += 2 + Buffer.byteLength(s, 'utf8');
  }
  size += indices.length * 2; // u16 indices

  const buf = Buffer.alloc(size);
  let pos = 0;

  buf.writeUInt16LE(dictionary.length, pos);
  pos += 2;
  for (const s of dictionary) {
    const bytes = Buffer.from(s, 'utf8');
    buf.writeUInt16LE(bytes.length, pos);
    pos += 2;
    bytes.copy(buf, pos);
    pos += bytes.length;
  }

  for (let i = 0; i < indices.length; i++) {
    buf.writeUInt16LE(indices[i] ?? 0xffff, pos);
    pos += 2;
  }

  return buf.subarray(0, pos);
}

function encodeDict32Column(indices, dictionary) {
  let charsLen = 0;
  for (const s of dictionary) {
    charsLen += Buffer.byteLength(s, 'utf8');
  }
  const dictCount = dictionary.length;

  // total size = 4 (dict count) + 4 * (dictCount + 1) (offsets) + charsLen + indices.length * 4
  const size = 4 + 4 * (dictCount + 1) + charsLen + indices.length * 4;
  const buf = Buffer.alloc(size);
  let pos = 0;

  buf.writeUInt32LE(dictCount, pos);
  pos += 4;

  // Write offsets (starting at 0)
  let currentOffset = 0;
  for (const s of dictionary) {
    buf.writeUInt32LE(currentOffset, pos);
    pos += 4;
    currentOffset += Buffer.byteLength(s, 'utf8');
  }
  // Final offset gives the length of the last string
  buf.writeUInt32LE(currentOffset, pos);
  pos += 4;

  // Write UTF-8 chars
  for (const s of dictionary) {
    const bytes = Buffer.from(s, 'utf8');
    bytes.copy(buf, pos);
    pos += bytes.length;
  }

  // Write indices
  for (let i = 0; i < indices.length; i++) {
    buf.writeUInt32LE(indices[i] ?? 0xffffffff, pos);
    pos += 4;
  }

  return buf.subarray(0, pos);
}
