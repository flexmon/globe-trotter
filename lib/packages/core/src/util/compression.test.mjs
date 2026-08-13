/**
 * compression.test.mjs — Characterization tests for maybeDecompress (A-4).
 * Locks the contract the three loader copies must share before E-1 unifies them.
 * Run: node --test src/util/compression.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { maybeDecompress } from './compression.js';

const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

describe('maybeDecompress', () => {
  it('decompresses a gzip-framed buffer back to the original bytes', async () => {
    const original = new TextEncoder().encode('hello shard payload '.repeat(50));
    const gz = gzipSync(Buffer.from(original)); // starts with 1F 8B
    const out = new Uint8Array(await maybeDecompress(toAB(gz)));
    assert.deepEqual([...out], [...original]);
  });

  it('returns an SHD3 buffer unchanged (passthrough)', async () => {
    const shd3 = new Uint8Array([0x53, 0x48, 0x44, 0x33, 1, 2, 3, 4]); // "SHD3" + payload
    const ab = toAB(shd3);
    const out = await maybeDecompress(ab);
    assert.equal(out, ab); // same reference — untouched
    assert.deepEqual([...new Uint8Array(out)], [...shd3]);
  });

  it('returns a plain (non-magic) buffer unchanged', async () => {
    const plain = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const ab = toAB(plain);
    assert.equal(await maybeDecompress(ab), ab);
  });

  it('handles a buffer shorter than the 2-byte header without throwing', async () => {
    const tiny = toAB(new Uint8Array([0x1f])); // only one byte
    const out = await maybeDecompress(tiny);
    assert.equal(out, tiny); // not gzip (needs both bytes) → passthrough
  });
});
