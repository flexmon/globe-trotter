/**
 * GFBDecoder.entity.test.mjs — entity-key column resolution.
 * The entity key (e.g. modem_mac) is not in manifest.columns; it must be pulled
 * from the shard's own decoded columns and, for string keys, decoded via its dict.
 * Run: node --test lib/packages/core/src/layers/GFBDecoder.entity.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { resolveEntityColumn } from './GFBDecoder.js';

describe('resolveEntityColumn', () => {
  it('returns null when no entity key name', () => {
    assert.equal(resolveEntityColumn(null, new Map(), new Map(), new Map()), null);
  });

  it('returns null when the column is absent from the shard', () => {
    assert.equal(resolveEntityColumn('modem_mac', new Map(), new Map(), new Map()), null);
  });

  it('decodes a string/dict entity key (raw ArrayBuffer indices) to display strings', () => {
    // decodeShardV3 stores dict indices as a raw ArrayBuffer; type says how to read it.
    const idx = new Uint32Array([1, 0, 1]);
    const cols = new Map([['modem_mac', idx.buffer]]);
    const types = new Map([['modem_mac', 'dict_string32']]);
    const dicts = new Map([['modem_mac', ['AA:BB', 'CC:DD']]]);
    assert.deepEqual(resolveEntityColumn('modem_mac', cols, dicts, types), [
      'CC:DD',
      'AA:BB',
      'CC:DD',
    ]);
  });

  it('reinterprets a numeric entity key ArrayBuffer via its type (no dict)', () => {
    const raw = new Uint32Array([100, 200]);
    const cols = new Map([['target_id', raw.buffer]]);
    const types = new Map([['target_id', 'uint32']]);
    const out = resolveEntityColumn('target_id', cols, new Map(), types);
    assert.deepEqual(Array.from(out), [100, 200]);
  });
});
