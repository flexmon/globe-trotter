/**
 * loaders.test.js — Unit tests for H3FlexShards and VirtualH3Loader.
 *
 * Ported from globe-trotter-2d. Covers manifest parsing, shard decode,
 * temporal view building, metric switching, epoch LRU cache.
 */

import { vi } from 'vitest';
import { H3FlexShards } from '../lib/packages/core/src/layers/loaders/H3FlexShards.js';
import { VirtualH3Loader } from '../lib/packages/core/src/layers/VirtualH3Loader.js';

// Mock apache-arrow
vi.mock('apache-arrow', () => ({ tableFromIPC: vi.fn() }));

// ─── IDB mock (no-op, returns cache miss) ────────────────────────────────────

function mockIndexedDB() {
  global.indexedDB = {
    open: () => {
      const req = { result: null };
      setImmediate(() => {
        req.result = {
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const r = {};
                setImmediate(() => {
                  r.result = undefined;
                  r.onsuccess?.();
                });
                return r;
              },
              put: () => {
                const r = {};
                setImmediate(() => r.oncomplete?.());
                return r;
              },
            }),
            oncomplete: null,
            onerror: null,
          }),
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
}

// ─── H3FlexShards ─────────────────────────────────────────────────────

describe('H3FlexShards', () => {
  let originalFetch;
  let originalIndexedDB;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalIndexedDB = global.indexedDB;
    mockIndexedDB();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.indexedDB = originalIndexedDB;
    vi.restoreAllMocks();
  });

  test('constructor initialises with correct defaults', () => {
    const loader = new H3FlexShards('http://example.com/data/manifest.json');
    expect(loader.manifestUrl).toBe('http://example.com/data/manifest.json');
    expect(loader.baseUrl).toBe('http://example.com/data/');
    expect(loader.manifest).toBeNull();
    expect(loader.baseData).toBeNull();
    expect(loader.activeShardIndex).toBe(-1);
  });

  test('getShardIndex returns correct shard for epoch', () => {
    const loader = new H3FlexShards('http://x/m.json');
    loader.manifest = {
      epochCount: 10,
      epochInterval: 300,
      cellCount: 3,
      shards: [
        { file: 's0.bin', epochs: [0, 4], epochCount: 5 },
        { file: 's1.bin', epochs: [5, 9], epochCount: 5 },
      ],
    };
    expect(loader.getShardIndex(0)).toBe(0);
    expect(loader.getShardIndex(4)).toBe(0);
    expect(loader.getShardIndex(5)).toBe(1);
    expect(loader.getShardIndex(9)).toBe(1);
    expect(loader.getShardIndex(99)).toBe(1); // out-of-range → last
  });

  test('_decodeShard dense: wraps buffer directly when aligned', () => {
    const loader = new H3FlexShards('http://x/m.json');
    loader.manifest = { cellCount: 3, sparseFormat: false, rleEncoding: false };
    loader._activeMetricDef = null;

    const raw = new Float32Array([1, 2, 3, 4, 5, 6]); // 2 epochs × 3 cells
    const result = loader._decodeShard(raw.buffer, 2);
    expect(result).toBeInstanceOf(Float32Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('_decodeShard sparse: correctly expands sparse epoch-major format', () => {
    const loader = new H3FlexShards('http://x/m.json');
    loader.manifest = { cellCount: 4, sparseFormat: true };
    loader._activeMetricDef = null;

    // 1 epoch, 2 sparse values: cell 0 = 1.0, cell 2 = 2.5
    const buf = new ArrayBuffer(4 + 2 * 4 + 2 * 4);
    const dv = new DataView(buf);
    dv.setUint32(0, 2, true); // count = 2
    dv.setUint32(4, 0, true); // index 0
    dv.setUint32(8, 2, true); // index 2
    dv.setFloat32(12, 1.0, true); // value at index 0
    dv.setFloat32(16, 2.5, true); // value at index 2

    const result = loader._decodeShard(buf, 1);
    expect(result[0]).toBeCloseTo(1.0);
    expect(result[1]).toBe(0);
    expect(result[2]).toBeCloseTo(2.5);
    expect(result[3]).toBe(0);
  });

  test('_decodeShard rle: correctly expands RLE cell-major format', () => {
    const loader = new H3FlexShards('http://x/m.json');
    loader.manifest = { cellCount: 3, rleEncoding: true };
    loader._activeMetricDef = null;

    // 1 active cell (cell 0), 1 run of length 2 with value 7.0
    const buf = new ArrayBuffer(4 + 4 + 2 + 2 + 4);
    const dv = new DataView(buf);
    let o = 0;
    dv.setUint32(o, 1, true);
    o += 4; // activeCells = 1
    dv.setUint32(o, 0, true);
    o += 4; // cellIdx = 0
    dv.setUint16(o, 1, true);
    o += 2; // runCount = 1
    dv.setUint16(o, 2, true);
    o += 2; // runLen = 2
    dv.setFloat32(o, 7.0, true); // value = 7.0

    const result = loader._decodeShard(buf, 2);
    expect(result[0]).toBeCloseTo(7.0); // epoch 0, cell 0
    expect(result[3]).toBeCloseTo(7.0); // epoch 1, cell 0 (offset = 1*3 + 0)
    expect(result[1]).toBe(0); // epoch 0, cell 1
  });

  test('_buildTemporalView sets shardEpochStart/End/Count', () => {
    const loader = new H3FlexShards('http://x/m.json');
    loader.manifest = {
      epochCount: 10,
      epochInterval: 300,
      cellCount: 3,
      shards: [{ file: 's0.bin', epochs: [0, 4], epochCount: 5 }],
    };
    loader._activeMetricDef = null;
    loader._activeMetric = 'value';
    loader.baseData = {};
    const data = new Float32Array(15);
    loader._shards.set(0, data);

    loader._buildTemporalView(0);

    expect(loader.baseData.temporalColumns?.value).toBe(data);
    expect(loader.baseData._shardEpochStart).toBe(0);
    expect(loader.baseData._shardEpochEnd).toBe(4);
    expect(loader.baseData._shardEpochCount).toBe(5);
  });

  test('destroy clears all state', () => {
    const loader = new H3FlexShards('http://x/m.json');
    loader.manifest = {};
    loader.baseData = {};
    loader._shards.set(0, new Float32Array(10));

    loader.destroy();

    expect(loader.manifest).toBeNull();
    expect(loader.baseData).toBeNull();
    expect(loader._shards.size).toBe(0);
    expect(loader.activeShardIndex).toBe(-1);
  });

  test('updateForTime returns false when manifest is not loaded', () => {
    const loader = new H3FlexShards('http://x/m.json');
    expect(loader.updateForTime(0.5)).toBe(false);
  });

  test('activeMetric getter returns the active metric name', () => {
    const loader = new H3FlexShards('http://x/m.json');
    loader._activeMetric = 'incoming_octets';
    expect(loader.activeMetric).toBe('incoming_octets');
  });
});

// ─── VirtualH3Loader ─────────────────────────────────────────────────────────

describe('VirtualH3Loader', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('constructor stores options correctly', () => {
    const loader = new VirtualH3Loader({
      flexdbUrl: 'https://db.example.com/',
      table: 'my_table',
      h3Field: 'h3_5',
      metrics: ['a', 'b'],
      aggregation: 'AVG',
      epochIntervalSeconds: 300,
      epochCacheSize: 10,
      extraWhere: 'region = 1',
    });
    expect(loader._url).toBe('https://db.example.com');
    expect(loader._table).toBe('my_table');
    expect(loader._h3Field).toBe('h3_5');
    expect(loader._metrics).toEqual(['a', 'b']);
    expect(loader._agg).toBe('AVG');
    expect(loader._epochInterval).toBe(300);
    expect(loader._cacheSize).toBe(10);
    expect(loader._extraWhere).toBe('region = 1');
  });

  test('init pre-allocates scratch Float32Arrays', () => {
    const loader = new VirtualH3Loader({
      flexdbUrl: 'http://x',
      table: 't',
      h3Field: 'h3',
      metrics: ['a', 'b'],
    });
    const ids = new BigUint64Array([1n, 2n, 3n]);
    loader.init(ids);
    expect(loader._scratches.a).toBeInstanceOf(Float32Array);
    expect(loader._scratches.a.length).toBe(3);
    expect(loader._scratches.b).toBeInstanceOf(Float32Array);
  });

  test('fetchEpoch returns cached result on second call without fetching', async () => {
    const loader = new VirtualH3Loader({
      flexdbUrl: 'http://x',
      table: 't',
      h3Field: 'h3',
      metrics: ['val'],
    });
    loader._meshCellIds = new BigUint64Array([1n]);
    loader._scratches = { val: new Float32Array(1) };

    const cached = { val: new Float32Array([42.0]) };
    loader._cache.set(1000, cached);

    const result = await loader.fetchEpoch(1000);
    expect(result).toBe(cached);
  });

  test('_setCached evicts oldest entry when at capacity', () => {
    const loader = new VirtualH3Loader({
      flexdbUrl: 'http://x',
      table: 't',
      h3Field: 'h3',
      metrics: [],
      epochCacheSize: 2,
    });
    loader._setCached(1, { val: new Float32Array(1) });
    loader._setCached(2, { val: new Float32Array(1) });
    loader._setCached(3, { val: new Float32Array(1) }); // evicts epoch 1

    expect(loader._cache.has(1)).toBe(false);
    expect(loader._cache.has(2)).toBe(true);
    expect(loader._cache.has(3)).toBe(true);
  });

  test('dispose clears cache and nulls meshCellIds', () => {
    const loader = new VirtualH3Loader({
      flexdbUrl: 'http://x',
      table: 't',
      h3Field: 'h',
      metrics: [],
    });
    loader._meshCellIds = new BigUint64Array([1n]);
    loader._cache.set(100, {});
    loader.dispose();
    expect(loader._cache.size).toBe(0);
    expect(loader._meshCellIds).toBeNull();
  });

  test('_decodeResult returns zero arrays for empty/null arrowTable', () => {
    const loader = new VirtualH3Loader({
      flexdbUrl: 'http://x',
      table: 't',
      h3Field: 'h3',
      metrics: ['x', 'y'],
    });
    loader._meshCellIds = new BigUint64Array([1n, 2n]);
    loader._scratches = { x: new Float32Array(2), y: new Float32Array(2) };

    const result = loader._decodeResult(null);
    expect(result.x).toBeInstanceOf(Float32Array);
    expect(result.x.length).toBe(2);
    expect(Array.from(result.x)).toEqual([0, 0]);
    expect(result.y).toBeInstanceOf(Float32Array);
  });

  test('prefetch does not re-fetch if epoch is already cached', () => {
    const loader = new VirtualH3Loader({
      flexdbUrl: 'http://x',
      table: 't',
      h3Field: 'h',
      metrics: [],
    });
    loader._cache.set(500, {});
    const fetchSpy = vi.fn();
    loader.fetchEpoch = fetchSpy;
    loader.prefetch(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('_decodeResult correctly maps h3 ids to mesh cell positions', () => {
    const loader = new VirtualH3Loader({
      flexdbUrl: 'http://x',
      table: 't',
      h3Field: 'h3',
      metrics: ['val'],
    });
    const meshIds = new BigUint64Array([0xabn, 0xcdn, 0xefn]);
    // init() builds _meshCellIds, _scratches, and the cellId→meshIndex map
    // (_cellIdIndex) that _decodeResult scatters through.
    loader.init(meshIds);

    const fakeTable = {
      numRows: 2,
      getChild: (name) => {
        if (name === 'h3') return { get: (i) => [0xabn, 0xefn][i] };
        if (name === 'val') return { get: (i) => [10.0, 30.0][i] };
        return { get: () => null };
      },
    };

    const result = loader._decodeResult(fakeTable);
    expect(result.val[0]).toBeCloseTo(10.0);
    expect(result.val[1]).toBe(0);
    expect(result.val[2]).toBeCloseTo(30.0);
  });

  // ─── SQL sanitizer tests ───────────────────────────────────────────────

  test('constructor rejects table names with disallowed characters', () => {
    expect(
      () =>
        new VirtualH3Loader({
          flexdbUrl: 'http://x',
          table: 'my-table',
          h3Field: 'h3',
          metrics: [],
        })
    ).toThrow(/table.*disallowed characters/i);
  });

  test('constructor rejects h3Field names with disallowed characters', () => {
    expect(
      () =>
        new VirtualH3Loader({
          flexdbUrl: 'http://x',
          table: 'my_table',
          h3Field: 'h3 5',
          metrics: [],
        })
    ).toThrow(/h3Field.*disallowed characters/i);
  });

  test('constructor accepts valid identifiers with numbers and underscores', () => {
    expect(
      () =>
        new VirtualH3Loader({
          flexdbUrl: 'http://x',
          table: 'table_2025',
          h3Field: 'h3_5',
          metrics: ['metric_1'],
        })
    ).not.toThrow();
  });

  test('constructor rejects disallowed aggregation functions', () => {
    expect(
      () =>
        new VirtualH3Loader({
          flexdbUrl: 'http://x',
          table: 't',
          h3Field: 'h3',
          metrics: [],
          aggregation: 'INJECT',
        })
    ).toThrow(/Aggregation function.*not allowed/i);
  });

  test('constructor accepts all permitted aggregation functions', () => {
    for (const agg of ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT']) {
      expect(
        () =>
          new VirtualH3Loader({
            flexdbUrl: 'http://x',
            table: 't',
            h3Field: 'h3',
            metrics: [],
            aggregation: agg,
          })
      ).not.toThrow();
    }
  });

  test('constructor rejects extraWhere containing DROP keyword', () => {
    expect(
      () =>
        new VirtualH3Loader({
          flexdbUrl: 'http://x',
          table: 't',
          h3Field: 'h3',
          metrics: [],
          extraWhere: 'region = 1; DROP TABLE users',
        })
    ).toThrow(/disallowed SQL patterns/i);
  });

  test('constructor rejects extraWhere containing SQL comment "--"', () => {
    expect(
      () =>
        new VirtualH3Loader({
          flexdbUrl: 'http://x',
          table: 't',
          h3Field: 'h3',
          metrics: [],
          extraWhere: 'x = 1 -- bypass',
        })
    ).toThrow(/disallowed SQL patterns/i);
  });

  test('constructor accepts a safe extraWhere clause', () => {
    expect(
      () =>
        new VirtualH3Loader({
          flexdbUrl: 'http://x',
          table: 't',
          h3Field: 'h3',
          metrics: [],
          extraWhere: 'region = 42 AND active = 1',
        })
    ).not.toThrow();
  });

  test('fetchEpoch promotes cache hit to MRU position', async () => {
    const loader = new VirtualH3Loader({
      flexdbUrl: 'http://x',
      table: 't',
      h3Field: 'h3',
      metrics: ['v'],
      epochCacheSize: 2,
    });
    const r1 = { v: new Float32Array([1]) };
    const r2 = { v: new Float32Array([2]) };
    loader._cache.set(100, r1);
    loader._cache.set(200, r2);

    // Access epoch 100 — should promote it to MRU
    await loader.fetchEpoch(100);

    // Now insert a third epoch — should evict epoch 200 (now the oldest), not 100
    loader._setCached(300, { v: new Float32Array([3]) });

    expect(loader._cache.has(100)).toBe(true);
    expect(loader._cache.has(200)).toBe(false);
    expect(loader._cache.has(300)).toBe(true);
  });
});
