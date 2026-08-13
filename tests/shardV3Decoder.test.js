/**
 * shardV3Decoder.test.js — Unit tests for ShardV3Decoder (ported from globe-trotter-2d).
 *
 * Tests the core SHD3 binary parsing pipeline:
 *   parseShardHeader, createTypedArray, isShardV3, parseDict32Column, decodeShardV3
 */

import { gzipSync } from 'zlib';
import {
  parseShardHeader,
  createTypedArray,
  isShardV3,
  parseDict32Column,
  decodeShardV3,
} from '../lib/packages/data-sdk/src/decoders/ShardV3Decoder.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function gzip(data) {
  const compressed = gzipSync(Buffer.from(data));
  return compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength
  );
}

function concat(...buffers) {
  const total = buffers.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), off);
    off += b.byteLength;
  }
  return out.buffer;
}

function uint32LE(value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, value, true);
  return buf;
}

async function buildSHD3(columns, opts = {}) {
  const epochCount = opts.epochCount ?? 0;
  const entityCount = opts.entityCount ?? columns[0]?.data?.length ?? 0;

  const encoded = await Promise.all(
    columns.map(async (col) => {
      const rawBuf = col.data
        ? col.data.buffer.slice(col.data.byteOffset, col.data.byteOffset + col.data.byteLength)
        : new ArrayBuffer(0);
      const compressed = gzip(rawBuf);
      return {
        name: col.name,
        data_type: col.dataType,
        nullable: false,
        compressed_len: compressed.byteLength,
        decompressed_len: rawBuf.byteLength,
        _compressed: compressed,
      };
    })
  );

  const schema = {
    epoch_count: epochCount,
    entity_count: entityCount,
    columns: encoded.map(({ name, data_type, nullable, compressed_len, decompressed_len }) => ({
      name,
      data_type,
      nullable,
      compressed_len,
      decompressed_len,
    })),
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(schema));
  const magic = new Uint8Array([0x53, 0x48, 0x44, 0x33]); // "SHD3"
  const jsonLen = uint32LE(jsonBytes.length);
  return concat(magic.buffer, jsonLen, jsonBytes.buffer, ...encoded.map((e) => e._compressed));
}

// ─── parseShardHeader ─────────────────────────────────────────────────────────

describe('parseShardHeader', () => {
  test('returns null for a too-short buffer', () => {
    expect(parseShardHeader(new ArrayBuffer(4))).toBeNull();
  });

  test('returns null for wrong magic bytes', () => {
    const buf = new ArrayBuffer(16);
    new Uint8Array(buf).set([0x00, 0x00, 0x00, 0x00]);
    expect(parseShardHeader(buf)).toBeNull();
  });

  test('parses a minimal valid SHD3 header', async () => {
    const buf = await buildSHD3(
      [{ name: 'speed', dataType: 'float32', data: new Float32Array([1, 2, 3]) }],
      { epochCount: 1, entityCount: 3 }
    );
    const index = parseShardHeader(buf);
    expect(index).not.toBeNull();
    expect(index.epochCount).toBe(1);
    expect(index.entityCount).toBe(3);
    expect(index.columnCount).toBe(1);
    expect(index.entries[0].name).toBe('speed');
    expect(index.entries[0].dataType).toBe('float32');
  });

  test('computes correct column byte offsets', async () => {
    const buf = await buildSHD3([
      { name: 'a', dataType: 'float32', data: new Float32Array([1]) },
      { name: 'b', dataType: 'uint32', data: new Uint32Array([2]) },
    ]);
    const index = parseShardHeader(buf);
    expect(index.entries[0].offset).toBeGreaterThan(0);
    expect(index.entries[1].offset).toBeGreaterThan(index.entries[0].offset);
  });
});

// ─── isShardV3 ───────────────────────────────────────────────────────────────

describe('isShardV3', () => {
  test('returns false for short buffer', () => {
    expect(isShardV3(new ArrayBuffer(2))).toBe(false);
  });

  test('returns false for wrong magic', () => {
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([0, 0, 0, 0]);
    expect(isShardV3(buf)).toBe(false);
  });

  test('returns true for SHD3 magic', async () => {
    const buf = await buildSHD3([{ name: 'x', dataType: 'float32', data: new Float32Array([1]) }]);
    expect(isShardV3(buf)).toBe(true);
  });
});

// ─── createTypedArray ─────────────────────────────────────────────────────────

describe('createTypedArray', () => {
  test('float32 → Float32Array', () => {
    const buf = new Float32Array([1.5, 2.5]).buffer;
    const result = createTypedArray('float32', buf);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result[0]).toBeCloseTo(1.5);
  });

  test('uint32 → Uint32Array', () => {
    const buf = new Uint32Array([10, 20]).buffer;
    const result = createTypedArray('uint32', buf);
    expect(result).toBeInstanceOf(Uint32Array);
    expect(result[1]).toBe(20);
  });

  test('u_int32 alias → Uint32Array', () => {
    expect(createTypedArray('u_int32', new Uint32Array([7]).buffer)).toBeInstanceOf(Uint32Array);
  });

  test('enum16 → Uint16Array', () => {
    expect(createTypedArray('enum16', new Uint16Array([0, 1, 2]).buffer)).toBeInstanceOf(
      Uint16Array
    );
  });

  test('uint64 → BigUint64Array', () => {
    const arr = new BigUint64Array([42n]);
    const result = createTypedArray('uint64', arr.buffer);
    expect(result).toBeInstanceOf(BigUint64Array);
    expect(result[0]).toBe(42n);
  });

  test('boolean → Uint8Array of 0/1 values', () => {
    const buf = new ArrayBuffer(1);
    new Uint8Array(buf)[0] = 0b10110101;
    const result = createTypedArray('boolean', buf, 8);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result[0]).toBe(1); // bit 0 set
    expect(result[1]).toBe(0); // bit 1 clear
    expect(result[2]).toBe(1); // bit 2 set
  });

  test('unknown type falls back to Float32Array', () => {
    expect(createTypedArray('unknown_xyz', new Float32Array([0]).buffer)).toBeInstanceOf(
      Float32Array
    );
  });

  test('handles misaligned views by copying to aligned buffer', () => {
    const raw = new ArrayBuffer(1 + 4 * 2); // 1 pad + 2 float32
    new DataView(raw).setFloat32(1, 3.14, true);
    new DataView(raw).setFloat32(5, 2.71, true);
    const misaligned = new Uint8Array(raw, 1, 8);
    const result = createTypedArray('float32', misaligned);
    expect(result[0]).toBeCloseTo(3.14, 2);
    expect(result[1]).toBeCloseTo(2.71, 2);
  });
});

// ─── parseDict32Column ────────────────────────────────────────────────────────

describe('parseDict32Column', () => {
  function buildDict32(strings, indices) {
    const encoder = new TextEncoder();
    const encoded = strings.map((s) => encoder.encode(s));
    const charsLen = encoded.reduce((n, b) => n + b.length, 0);
    const dictCount = strings.length;
    const size = 4 + 4 * (dictCount + 1) + charsLen + indices.length * 4;
    const buf = new ArrayBuffer(size);
    const dv = new DataView(buf);
    let pos = 0;

    dv.setUint32(pos, dictCount, true);
    pos += 4;
    let charOffset = 0;
    for (const enc of encoded) {
      dv.setUint32(pos, charOffset, true);
      pos += 4;
      charOffset += enc.length;
    }
    dv.setUint32(pos, charOffset, true);
    pos += 4;

    const bytes = new Uint8Array(buf);
    for (const enc of encoded) {
      bytes.set(enc, pos);
      pos += enc.length;
    }
    for (const idx of indices) {
      dv.setUint32(pos, idx, true);
      pos += 4;
    }

    return buf;
  }

  test('parses dictionary strings correctly', () => {
    const buf = buildDict32(['hello', 'world'], [0, 1, 0]);
    const { dictionary, indicesBuffer } = parseDict32Column(buf);
    expect(dictionary).toEqual(['hello', 'world']);
    expect(Array.from(indicesBuffer)).toEqual([0, 1, 0]);
  });

  test('handles empty strings in dictionary', () => {
    const buf = buildDict32(['', 'nonempty'], [0, 1]);
    const { dictionary } = parseDict32Column(buf);
    expect(dictionary[0]).toBe('');
    expect(dictionary[1]).toBe('nonempty');
  });

  test('returns Uint32Array for indicesBuffer', () => {
    const buf = buildDict32(['a'], [0]);
    const { indicesBuffer } = parseDict32Column(buf);
    expect(indicesBuffer).toBeInstanceOf(Uint32Array);
  });
});

// ─── decodeShardV3 (integration) ─────────────────────────────────────────────

describe('decodeShardV3', () => {
  test('decodes a single float32 column', async () => {
    const data = new Float32Array([10, 20, 30]);
    const buf = await buildSHD3([{ name: 'value', dataType: 'float32', data }], {
      epochCount: 1,
      entityCount: 3,
    });
    const result = await decodeShardV3(buf);
    expect(result.epochCount).toBe(1);
    expect(result.entityCount).toBe(3);
    expect(result.types.get('value')).toBe('float32');
    const decoded = new Float32Array(result.columns.get('value'));
    expect(Array.from(decoded)).toEqual([10, 20, 30]);
  });

  test('decodes multiple columns in parallel', async () => {
    const buf = await buildSHD3(
      [
        { name: 'x', dataType: 'float32', data: new Float32Array([1, 2]) },
        { name: 'y', dataType: 'uint32', data: new Uint32Array([3, 4]) },
      ],
      { entityCount: 2 }
    );
    const result = await decodeShardV3(buf);
    expect(result.columns.has('x')).toBe(true);
    expect(result.columns.has('y')).toBe(true);
  });

  test('respects onlyNames filter', async () => {
    const buf = await buildSHD3([
      { name: 'keep', dataType: 'float32', data: new Float32Array([1]) },
      { name: 'skip', dataType: 'float32', data: new Float32Array([2]) },
    ]);
    const result = await decodeShardV3(buf, new Set(['keep']));
    expect(result.columns.has('keep')).toBe(true);
    expect(result.columns.has('skip')).toBe(false);
  });

  test('throws for invalid SHD3 header', async () => {
    const bad = new ArrayBuffer(8);
    await expect(decodeShardV3(bad)).rejects.toThrow('Invalid SHD3 header');
  });

  test('returns empty column map when all columns are filtered out', async () => {
    const buf = await buildSHD3([
      { name: 'col', dataType: 'float32', data: new Float32Array([1]) },
    ]);
    const result = await decodeShardV3(buf, new Set(['nonexistent']));
    expect(result.columns.size).toBe(0);
  });
});
