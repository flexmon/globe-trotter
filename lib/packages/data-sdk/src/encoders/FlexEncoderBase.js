import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { gzipSync } from 'zlib';
import { encodeShardV3 } from './ShardV3Encoder.js';

// *Flex Column Type Codes (matches Rust flex-format/src/common.rs)
export const TYPE_FLOAT32 = 0x01;
export const TYPE_FLOAT64 = 0x02;
export const TYPE_INT32 = 0x03;
export const TYPE_UINT32 = 0x04;
export const TYPE_BOOLEAN = 0x05;
export const TYPE_ENUM16 = 0x06;
export const TYPE_UINT8 = 0x07;
export const TYPE_INT8 = 0x08;
export const TYPE_UINT16 = 0x09;
export const TYPE_INT16 = 0x0a;
export const TYPE_INT64 = 0x0b;
export const TYPE_TIMESTAMP_S = 0x0c;
export const TYPE_UINT64 = 0x0d;
export const TYPE_ENUM32 = 0x0e;

export const COL_TYPES = {
  float32: TYPE_FLOAT32,
  float64: TYPE_FLOAT64,
  int32: TYPE_INT32,
  uint32: TYPE_UINT32,
  boolean: TYPE_BOOLEAN,
  enum32: TYPE_ENUM32,
  uint8: TYPE_UINT8,
  int8: TYPE_INT8,
  uint16: TYPE_UINT16,
  int16: TYPE_INT16,
  int64: TYPE_INT64,
  timestamp_s: TYPE_TIMESTAMP_S,
  uint64: TYPE_UINT64,
};

// Type code → human-readable name (for manifest columns)
export const TYPE_NAMES = {
  [TYPE_FLOAT32]: 'float32',
  [TYPE_FLOAT64]: 'float64',
  [TYPE_INT32]: 'int32',
  [TYPE_UINT32]: 'uint32',
  [TYPE_BOOLEAN]: 'boolean',
  [TYPE_ENUM32]: 'enum32',
  [TYPE_UINT8]: 'uint8',
  [TYPE_INT8]: 'int8',
  [TYPE_UINT16]: 'uint16',
  [TYPE_INT16]: 'int16',
  [TYPE_INT64]: 'int64',
  [TYPE_TIMESTAMP_S]: 'timestamp_s',
  [TYPE_UINT64]: 'uint64',
};

export function _coerceEnumArray(data, typeCode) {
  if (typeCode === TYPE_ENUM32 && !(data instanceof Uint32Array)) return new Uint32Array(data);
  return data;
}

/** Infer encoder type code from a TypedArray instance. */
export function _inferType(data) {
  if (data instanceof Float32Array) return TYPE_FLOAT32;
  if (data instanceof Float64Array) return TYPE_FLOAT64;
  if (data instanceof Int32Array) return TYPE_INT32;
  if (data instanceof Uint32Array) return TYPE_UINT32;
  if (data instanceof Uint8Array) return TYPE_UINT8;
  if (data instanceof BigInt64Array) return TYPE_INT64;
  if (data instanceof BigUint64Array) return TYPE_UINT64;
  return TYPE_FLOAT32;
}

export class FlexEncoderBase {
  /**
   * @param {Object} options
   * @param {number} options.epochCount
   * @param {number} options.epochInterval — Seconds between epochs
   * @param {number} [options.startTimestamp] — Unix epoch seconds of the first epoch
   * @param {number} [options.gzipLevel=1] — Compression level (1=fast, 9=best)
   */
  constructor(options = {}) {
    this.epochCount = options.epochCount || 0;
    this.epochInterval = options.epochInterval || 60;
    this.startTimestamp = options.startTimestamp || null;
    this.gzipLevel = options.gzipLevel ?? 1;

    this._columns = []; // { name, type, temporal, data, dictSnapshot }
    this._temporalColumns = []; // { name, data: TypedArray (epoch-major) }
    this._dictionary = []; // global dictionary for enum columns
  }

  /** @param {string[]} dictionary */
  setDictionary(dictionary) {
    this._dictionary = dictionary;
  }

  /**
   * Unified column API — auto-detects type from data.
   * @param {string} name — Column name
   * @param {string[]|TypedArray} data
   * @param {{ temporal?: boolean, dictionary?: string[] }} [options]
   */
  addColumn(name, data, options) {
    if (options?.temporal) {
      this.setTemporalData(name, data, options);
      return;
    }
    if (Array.isArray(data) && typeof data[0] === 'string') {
      const { indices, typeCode, dictionary } = this._buildEnumColumn(data);
      this._columns.push({ name, type: typeCode, temporal: 0, data: indices, dictionary });
      return;
    }
    const type = _inferType(data);
    this._columns.push({ name, type, temporal: 0, data });
  }

  /**
   * Add a static column with explicit type.
   * @param {string} name
   * @param {string|number} type
   * @param {TypedArray} data
   * @param {string[]} [dictionary]
   */
  addStaticColumn(name, type, data, dictionary) {
    let typeCode;
    if (type === 'enum' || type === 'enum16' || type === 'enum32' || type === 'enum_binary') {
      typeCode = TYPE_ENUM32;
    } else if (typeof type === 'number') {
      typeCode = type;
    } else {
      typeCode = COL_TYPES[type] || TYPE_FLOAT32;
    }

    const coerced = _coerceEnumArray(data, typeCode);
    const isDict = typeCode === TYPE_ENUM16 || typeCode === TYPE_ENUM32;

    this._columns.push({
      name,
      type: typeCode,
      temporal: 0,
      data: coerced,
      dictionary: isDict ? dictionary || this._dictionary || undefined : undefined,
    });
  }

  /**
   * Set temporal data for a metric column.
   * @param {string} name — Column name
   * @param {TypedArray} data — Flat array: epochCount × rowCount (epoch-major)
   * @param {number|Object} [options] — Number of epochs OR options object
   */
  setTemporalData(name, data, options) {
    let epCount, dictionary, explicitType;
    if (typeof options === 'object') {
      epCount = options.epochCount;
      dictionary = options.dictionary;
      explicitType = options.typeCode;
    } else {
      epCount = options;
    }

    if (epCount) {
      this.epochCount = epCount;
    }
    const typeCode = explicitType || _inferType(data);

    // Add to schema as temporal column
    const existing = this._columns.find((c) => c.name === name);
    if (!existing) {
      this._columns.push({ name, type: typeCode, temporal: 1, data: null, dictionary });
    } else {
      existing.dictionary = dictionary || existing.dictionary;
      existing.type = typeCode;
    }

    // Store external reference for shard extraction
    this._temporalColumns.push({ name, data, typeCode, dictionary });
  }

  _buildEnumColumn(strings) {
    const dictionary = [];
    const dictMap = new Map();
    const indices = new Uint32Array(strings.length);

    for (let i = 0; i < strings.length; i++) {
      const s = strings[i];
      let idx = dictMap.get(s);
      if (idx === undefined) {
        idx = dictionary.length;
        dictMap.set(s, idx);
        dictionary.push(s);
      }
      indices[i] = idx;
    }

    return { indices, typeCode: TYPE_ENUM32, dictionary };
  }

  /**
   * Abstract encode implementation. Handled by subclasses to perform layout
   * specific to the `format` output.
   */
  async encode(options) {
    throw new Error('Must be implemented by subclass.');
  }
}
