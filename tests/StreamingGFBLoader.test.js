/**
 * StreamingGFBLoader.test.js — Shard discovery must be fully deterministic.
 *
 * Production is a self-contained single-file build with no backend routing,
 * so the `/data-list/` GCS-listing endpoint (a vite dev-server-only
 * convenience, see vite.config.js gcsProxy()) never exists post-deploy.
 * These tests lock in that shard_idx is computed from manifest metadata
 * alone, and that discovery/polling never depends on that endpoint.
 */

import { vi } from 'vitest';
import { StreamingGFBLoader } from '../lib/packages/core/src/layers/loaders/StreamingGFBLoader.js';

vi.mock('../lib/packages/core/src/layers/GFBDecoder.js', () => ({
  decodeGFB: vi.fn(async () => ({
    featureCount: 2,
    epochCount: 10,
    hasAltitude: false,
    geometry: { type: 'temporal_point', positions: new Float32Array(4) },
    dictionaries: {},
    staticColumns: {},
    temporalColumns: {},
    entityIds: null,
  })),
}));

const MANIFEST_URL = 'http://example.com/data/gfb_stream/gfb_stream.manifest.json';
const BASE_URL = 'http://example.com/data/gfb_stream/';
const EPOCH_INTERVAL = 60; // shard window duration (seconds)
const START_TIMESTAMP = 1711152000;

function makeManifest(overrides = {}) {
  return {
    format: 'gfb-streaming',
    pipeline: 'test-pipeline',
    table: 'test_table',
    hasAltitude: false,
    geometryType: 1,
    columns: [],
    live: {
      epochInterval: EPOCH_INTERVAL,
      filePattern: 'gfb_stream-w{window_start}-s{shard_idx}.shard',
      shardEpochs: 10,
      ttl: '1h',
    },
    start_timestamp: START_TIMESTAMP,
    ...overrides,
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

function shardResponse() {
  return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
}

function notFoundResponse() {
  return { ok: true, status: 204, arrayBuffer: async () => new ArrayBuffer(0) };
}

describe('StreamingGFBLoader shard_idx resolution', () => {
  let originalFetch;
  let calledUrls;
  let loader;

  beforeEach(() => {
    originalFetch = global.fetch;
    calledUrls = [];
    loader = null;
  });

  afterEach(() => {
    loader?.dispose();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function installFetch({ manifest, foundWindowStart }) {
    global.fetch = vi.fn(async (url) => {
      calledUrls.push(url);
      if (url === MANIFEST_URL) return jsonResponse(manifest);
      if (url.includes('/data-list/')) {
        // The endpoint that doesn't exist in production. Simulate that
        // reality: no server-side route, so this always fails.
        return { ok: false, status: 404, json: async () => [] };
      }
      // Direct shard URL.
      const wMatch = url.match(/-w(\d+)-/);
      const windowStart = wMatch ? parseInt(wMatch[1], 10) : null;
      if (windowStart === foundWindowStart) return shardResponse();
      return notFoundResponse();
    });
  }

  test('resolves shard_idx offset from manifest.start_timestamp without any fetch beyond the manifest and the shard itself', async () => {
    const manifest = makeManifest();
    const targetWindowStart = START_TIMESTAMP + 5 * EPOCH_INTERVAL; // slot 5
    installFetch({ manifest, foundWindowStart: targetWindowStart });
    vi.spyOn(Date, 'now').mockReturnValue(targetWindowStart * 1000);

    const loader = new StreamingGFBLoader(MANIFEST_URL);
    await loader.load();

    // Deterministic direct URL for slot 5 must be requested with shard_idx = 5.
    expect(calledUrls).toContain(`${BASE_URL}gfb_stream-w${targetWindowStart}-s0005.shard`);
    // The loader must never touch the dev-only listing endpoint.
    expect(calledUrls.some((u) => u.includes('/data-list/'))).toBe(false);
    expect(loader.ringInfo.count).toBe(1);
  });

  test('defaults shard_idx offset to 0 (shard_idx == window slot) when start_timestamp is absent', async () => {
    const manifest = makeManifest({ start_timestamp: undefined });
    const targetWindowStart = 300; // slot 5 at epochInterval=60, from epoch zero
    installFetch({ manifest, foundWindowStart: targetWindowStart });
    vi.spyOn(Date, 'now').mockReturnValue(targetWindowStart * 1000);

    const loader = new StreamingGFBLoader(MANIFEST_URL);
    await loader.load();

    expect(calledUrls).toContain(`${BASE_URL}gfb_stream-w${targetWindowStart}-s0005.shard`);
    expect(calledUrls.some((u) => u.includes('/data-list/'))).toBe(false);
  });

  test('bootstrap probes backwards using only direct URLs and never falls back to listing when recent windows 404', async () => {
    const manifest = makeManifest();
    // Pipeline is a couple windows behind wall clock — bootstrap should
    // probe backwards via direct URLs only, never listing.
    const now = START_TIMESTAMP + 10 * EPOCH_INTERVAL;
    const foundWindowStart = START_TIMESTAMP + 8 * EPOCH_INTERVAL;
    installFetch({ manifest, foundWindowStart });
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);

    const loader = new StreamingGFBLoader(MANIFEST_URL);
    await loader.load();

    expect(loader._bootstrapWindowStart).toBe(foundWindowStart);
    expect(calledUrls.some((u) => u.includes('/data-list/'))).toBe(false);
  });
});
