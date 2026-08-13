// tests/metricFlexEncoder.test.js — Roundtrip tests for MetricFlexEncoder → decodeMFB
import { gunzipSync } from 'zlib';
import { decodeMFB } from '../src/layers/MFBDecoder.js';
import { MetricFlexEncoder } from '../lib/packages/data-sdk/src/encoders/MetricFlexEncoder.js';

// ─── fs mock ────────────────────────────────────────────────────────────────
// We capture what the encoder would write to disk without touching the filesystem.
const writtenFiles = {};
vi.mock('fs', () => ({
  writeFileSync: vi.fn((filePath, data) => {
    const key = filePath.toString().replace(/.*[\\/]/, ''); // filename only
    writtenFiles[key] = data;
  }),
  mkdirSync: vi.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert a Node.js Buffer to an ArrayBuffer. */
function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Decompress a gzipped Buffer and convert to ArrayBuffer. */
function gunzipToArrayBuffer(buf) {
  return toArrayBuffer(gunzipSync(buf));
}

/** Get a written file by filename suffix (e.g. 'mydata.mfb'). */
function getWritten(suffix) {
  const key = Object.keys(writtenFiles).find((k) => k.endsWith(suffix));
  if (!key)
    throw new Error(
      `No file matching '${suffix}' was written. Available: ${Object.keys(writtenFiles).join(', ')}`
    );
  return writtenFiles[key];
}

beforeEach(() => {
  Object.keys(writtenFiles).forEach((k) => delete writtenFiles[k]);
  vi.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MetricFlexEncoder → decodeMFB roundtrip', () => {
  test('monolithic: static-only, no temporal', async () => {
    const enc = new MetricFlexEncoder({
      entityCount: 3,
      epochCount: 0,
      epochInterval: 300,
    });
    enc.addStaticColumn('score', 'float32', new Float32Array([10.0, 20.0, 30.0]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const buf = getWritten('_base.mfb.gz');
    const decoded = await decodeMFB(gunzipToArrayBuffer(buf), manifest);

    expect(decoded.entityCount).toBe(3);
    expect(decoded.epochCount).toBe(0);
    expect(decoded.staticColumns.score).toBeDefined();
    expect(decoded.staticColumns.score[0]).toBeCloseTo(10.0);
    expect(decoded.staticColumns.score[1]).toBeCloseTo(20.0);
    expect(decoded.staticColumns.score[2]).toBeCloseTo(30.0);
  });

  test('monolithic: temporal F32 column roundtrip', async () => {
    const entityCount = 2;
    const epochCount = 3;
    // epoch-major: epoch0[e0,e1], epoch1[e0,e1], epoch2[e0,e1]
    const temporal = new Float32Array([1, 2, 3, 4, 5, 6]);

    const enc = new MetricFlexEncoder({ entityCount, epochCount, epochInterval: 60 });
    enc.setTemporalData('demand', temporal);

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'test',
      sharding: { epochsPerShard: 3 },
    });

    // In v3, temporal columns are sharded
    const baseBuf = getWritten('_base.mfb.gz');
    const decodedBase = await decodeMFB(gunzipToArrayBuffer(baseBuf), manifest);

    expect(decodedBase.staticColumns.demand).toBeUndefined(); // temporal data is in shards

    // Let's decode the shard
    const shardBuf = getWritten('e0000-e0002.shard');
    const decodedShard = await decodeMFB(toArrayBuffer(shardBuf), manifest);

    expect(decodedShard.temporalColumns.demand).toBeDefined();
    expect(decodedShard.temporalColumns.demand[0]).toBeCloseTo(1);
    expect(decodedShard.temporalColumns.demand[1]).toBeCloseTo(2);
  });

  test('monolithic: entity IDs roundtrip', async () => {
    const ids = new Uint32Array([101, 202, 303]);
    const enc = new MetricFlexEncoder({ entityCount: 3, epochCount: 0, epochInterval: 60 });
    enc.setEntityIds('tail_id', ids);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const buf = getWritten('_base.mfb.gz');
    const decoded = await decodeMFB(gunzipToArrayBuffer(buf), manifest);

    expect(decoded.staticColumns.tail_id).toBeUndefined(); // Entity IDs decoded directly
    expect(decoded.entityIds).toBeDefined();
    expect(decoded.entityIds[0]).toBe(101);
    expect(decoded.entityIds[1]).toBe(202);
    expect(decoded.entityIds[2]).toBe(303);
  });

  test('monolithic: addColumn string[] builds dictionary and enum indices', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 4, epochCount: 0, epochInterval: 60 });
    enc.addColumn('airline', ['Delta', 'Alaska', 'Delta', 'United']);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const buf = getWritten('_base.mfb.gz');
    const decoded = await decodeMFB(gunzipToArrayBuffer(buf), manifest);

    expect(decoded.dictionaries.airline[decoded.staticColumns.airline[0]]).toBe('Delta');
    expect(decoded.dictionaries.airline[decoded.staticColumns.airline[1]]).toBe('Alaska');
    expect(decoded.dictionaries.airline[decoded.staticColumns.airline[2]]).toBe('Delta');
    expect(decoded.dictionaries.airline[decoded.staticColumns.airline[3]]).toBe('United');
  });

  test('monolithic: addColumn string[] always uses ENUM32 (type 14, Uint32 indices)', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 3, epochCount: 0, epochInterval: 60 });
    enc.addColumn('cat', ['A', 'B', 'C']);

    await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    // v3 encoder uses ENUM32 (0x0E) with Uint32Array indices
    expect(enc._columns[0].type).toBe(14);
    expect(enc._columns[0].data).toBeInstanceOf(Uint32Array);
  });

  test('monolithic: addColumn with { temporal: true } option', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 2, epochCount: 2, epochInterval: 60 });
    enc.addColumn('cpu', new Float32Array([1, 2, 3, 4]), { temporal: true });

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const shardBuf = getWritten('.shard'); // Because temporal columns are put in shards
    const decoded = await decodeMFB(toArrayBuffer(shardBuf), manifest);

    expect(decoded.temporalColumns.cpu).toBeDefined();
    expect(decoded.temporalColumns.cpu[0]).toBeCloseTo(1);
    expect(decoded.temporalColumns.cpu[1]).toBeCloseTo(2);
  });

  test('monolithic: manifest has correct v3 format', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 2, epochCount: 0, epochInterval: 300 });
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    expect(manifest.format).toBe('mfb-v3-sharded');
    expect(manifest.version).toBe(3);
    expect(manifest.entityCount).toBe(2);
    expect(manifest.epochInterval).toBe(300);
    expect(manifest.base).toBe('mydata_base.mfb.gz');
  });

  test('sharded: base file has epochCount=0', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 4, epochCount: 6, epochInterval: 60 });
    enc.setTemporalData('val', new Float32Array(4 * 6).fill(1.0));

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      sharding: { epochsPerShard: 3 },
    });

    const baseBuf = getWritten('_base.mfb.gz');
    const decoded = await decodeMFB(gunzipToArrayBuffer(baseBuf), manifest);

    // Base file epochCount=0 (temporal data lives in shards)
    expect(decoded.entityCount).toBe(4);
    expect(decoded.epochCount).toBe(6); // Comes from manifest
    expect(Object.keys(decoded.temporalColumns)).toHaveLength(0);
  });

  test('sharded: manifest v3 has correct format and shard list', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 2, epochCount: 6, epochInterval: 60 });
    enc.setTemporalData('val', new Float32Array(2 * 6).fill(1.0));

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      sharding: { epochsPerShard: 3 },
    });

    expect(manifest.format).toBe('mfb-v3-sharded');
    expect(manifest.version).toBe(3);
    expect(manifest.shardFormat).toBe('v3');
    expect(manifest.entityCount).toBe(2);
    expect(manifest.epochCount).toBe(6);
    expect(manifest.shards).toBeDefined();
    expect(manifest.shards.length).toBe(2);
    expect(manifest.shards[0].epochs).toEqual([0, 2]);
    expect(manifest.shards[1].epochs).toEqual([3, 5]);
  });

  test('sharded: multiple temporal columns combined into shards', async () => {
    const entityCount = 2;
    const epochCount = 4;

    const enc = new MetricFlexEncoder({ entityCount, epochCount, epochInterval: 60 });
    enc.setTemporalData('col_a', new Float32Array(entityCount * epochCount).fill(1));
    enc.setTemporalData('col_b', new Float32Array(entityCount * epochCount).fill(2));

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'multi',
      sharding: { epochsPerShard: 2 },
    });

    expect(manifest.shards.length).toBe(2);
    const names = manifest.columns.map((a) => a.name);
    expect(names).toContain('col_a');
    expect(names).toContain('col_b');
  });

  test('sharded: shard file created for slice', async () => {
    const entityCount = 2;
    const epochCount = 4;
    const temporal = new Float32Array([10, 20, 30, 40, 50, 60, 70, 80]);

    const enc = new MetricFlexEncoder({ entityCount, epochCount, epochInterval: 60 });
    enc.setTemporalData('val', temporal);

    await enc.encode({ output: '/tmp/test/', baseName: 'slice', sharding: { epochsPerShard: 2 } });

    expect(getWritten('e0000-e0001.shard')).toBeDefined();
    expect(getWritten('e0002-e0003.shard')).toBeDefined();
  });

  test('sharded: partial last shard handled correctly', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 2, epochCount: 5, epochInterval: 60 });
    enc.setTemporalData('val', new Float32Array(2 * 5).fill(1.0));

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'partial',
      sharding: { epochsPerShard: 3 },
    });

    const shards = manifest.shards;
    expect(shards.length).toBe(2);
    expect(shards[0].epochCount).toBe(3);
    expect(shards[1].epochCount).toBe(2);
    expect(shards[1].epochs).toEqual([3, 4]);
  });

  test('monolithic: static + temporal columns coexist', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 2, epochCount: 2, epochInterval: 60 });
    enc.addStaticColumn('label', 'float32', new Float32Array([1.0, 2.0]));
    enc.setTemporalData('val', new Float32Array([10, 20, 30, 40]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mixed' });

    const baseBuf = getWritten('_base.mfb.gz');
    const decodedBase = await decodeMFB(gunzipToArrayBuffer(baseBuf), manifest);

    expect(decodedBase.staticColumns.label[0]).toBeCloseTo(1.0);
    expect(decodedBase.staticColumns.label[1]).toBeCloseTo(2.0);

    const shardBuf = getWritten('e0000-e0001.shard');
    const decodedShard = await decodeMFB(toArrayBuffer(shardBuf), manifest);

    expect(decodedShard.temporalColumns.val[0]).toBeCloseTo(10);
    expect(decodedShard.temporalColumns.val[1]).toBeCloseTo(20);
  });
});
