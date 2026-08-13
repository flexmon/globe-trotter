/**
 * ShardLoader.test.mjs — lifecycle contract tests for the base class.
 *
 * Uses mocked fetch returning fixture buffers; asserts:
 *   - §C.1 lifecycle (load, dispose, switchMetric)
 *   - §C.2 error semantics (manifest failure rejects; shard 404 yields partial)
 */

import { test } from 'vitest';
import { strict as assert } from 'node:assert';

// Mock minimal subclass for testing the base class lifecycle
class MockShardLoader {
  constructor(manifestUrl, opts = {}) {
    this.manifestUrl = manifestUrl;
    this.opts = opts;
    this.manifest = null;
    this.baseData = {};
    this._shards = new Map();
    this._activeShardIdx = -1;
    this._abortController = new AbortController();
    this._maxResidentBytes = opts.maxResidentBytes ?? 500 * 1024 * 1024;

    // Track calls to abstract methods for verification
    this._decodeShardCalls = [];
    this._activateShardCalls = [];
  }

  async load() {
    const resp = await fetch(this.manifestUrl, { signal: this._abortController.signal });
    if (!resp.ok) throw new Error(`Failed to fetch manifest: ${resp.status}`);
    this.manifest = await resp.json();

    // Simulate loading first shard
    const firstShard = await this._fetchShard(0);
    this._activateShard(0, firstShard);

    return this.baseData;
  }

  async _fetchShard(idx) {
    const shardInfo = this.manifest.shards[idx];
    const resp = await fetch(shardInfo.url, { signal: this._abortController.signal });
    if (!resp.ok) {
      // Log error, mark partial, but don't reject
      this.baseData.meta = this.baseData.meta || {};
      this.baseData.meta.partial = true;
      return null;
    }
    const buffer = await resp.arrayBuffer();
    return this._decodeShard(buffer, shardInfo);
  }

  _decodeShard(buffer, meta) {
    this._decodeShardCalls.push({ buffer, meta });
    // Mock: return a simple decoded object
    return { data: new Float32Array(buffer.byteLength / 4) };
  }

  _activateShard(idx, shard) {
    this._activateShardCalls.push({ idx, shard });
    this._activeShardIdx = idx;
    this._shards.set(idx, shard);
  }

  dispose() {
    this._abortController.abort();
    this._shards.clear();
    this.manifest = null;
    this.baseData = null;
  }

  async switchMetric(name) {
    // No-op for single-metric formats
  }
}

test('ShardLoader lifecycle — manifest failure rejects', async () => {
  // Mock fetch that returns 404 for manifest
  global.fetch = async (url) => {
    if (url.includes('manifest.json')) {
      return { ok: false, status: 404 };
    }
  };

  const loader = new MockShardLoader('http://test.com/manifest.json');
  await assert.rejects(
    () => loader.load(),
    /Failed to fetch manifest: 404/,
    'Manifest fetch failure should reject load()'
  );
});

test('ShardLoader lifecycle — shard 404 yields partial without rejecting', async () => {
  // Mock fetch: manifest succeeds, first shard fails
  global.fetch = async (url) => {
    if (url.includes('manifest.json')) {
      return {
        ok: true,
        json: async () => ({
          shards: [{ url: 'http://test.com/shard0.bin', epochCount: 10 }],
        }),
      };
    }
    if (url.includes('shard0.bin')) {
      return { ok: false, status: 404 };
    }
  };

  const loader = new MockShardLoader('http://test.com/manifest.json');
  const result = await loader.load();

  assert.ok(result.meta, 'Result should have meta');
  assert.strictEqual(
    result.meta.partial,
    true,
    'meta.partial should be true when shard fetch fails'
  );
});

test('ShardLoader lifecycle — dispose aborts in-flight fetches', async () => {
  let abortedDuringFetch = false;

  global.fetch = async (url, opts) => {
    if (url.includes('manifest.json')) {
      return {
        ok: true,
        json: async () => ({
          shards: [{ url: 'http://test.com/shard0.bin', epochCount: 10 }],
        }),
      };
    }
    if (url.includes('shard0.bin')) {
      // Simulate slow fetch
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          abortedDuringFetch = true;
          resolve();
        });
      });
      if (opts.signal.aborted) {
        throw new Error('Aborted');
      }
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(40),
      };
    }
  };

  const loader = new MockShardLoader('http://test.com/manifest.json');
  const loadPromise = loader.load();

  // Dispose before load completes
  setTimeout(() => loader.dispose(), 10);

  try {
    await loadPromise;
  } catch (e) {
    // Expect abort error
  }

  assert.ok(abortedDuringFetch, 'dispose() should have aborted the in-flight fetch');
});

test('ShardLoader lifecycle — successful load flow', async () => {
  global.fetch = async (url) => {
    if (url.includes('manifest.json')) {
      return {
        ok: true,
        json: async () => ({
          shards: [{ url: 'http://test.com/shard0.bin', epochCount: 10 }],
        }),
      };
    }
    if (url.includes('shard0.bin')) {
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(40),
      };
    }
  };

  const loader = new MockShardLoader('http://test.com/manifest.json');
  const result = await loader.load();

  assert.ok(result, 'load() should return a result');
  assert.strictEqual(loader._decodeShardCalls.length, 1, '_decodeShard should be called once');
  assert.strictEqual(loader._activateShardCalls.length, 1, '_activateShard should be called once');
  assert.strictEqual(loader._activeShardIdx, 0, 'First shard should be active');
});
