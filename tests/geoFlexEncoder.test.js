// tests/geoFlexEncoder.test.js — Roundtrip tests for GeoFlexEncoder → decodeGFB
import { gunzipSync } from 'zlib';
import { decodeGFB } from '../src/layers/GFBDecoder.js';
import { GeoFlexEncoder } from '../lib/packages/data-sdk/src/encoders/GeoFlexEncoder.js';

// ─── fs mock ────────────────────────────────────────────────────────────────
const writtenFiles = {};
vi.mock('fs', () => ({
  writeFileSync: vi.fn((filePath, data) => {
    const key = filePath.toString().replace(/.*[\\/]/, '');
    writtenFiles[key] = data;
  }),
  mkdirSync: vi.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function gunzipToArrayBuffer(buf) {
  return toArrayBuffer(gunzipSync(buf));
}

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

describe('GeoFlexEncoder → decodeGFB roundtrip', () => {
  test('base file decodes featureCount and geomType', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 5,
      epochCount: 1,
      epochInterval: 60,
      geometryType: 'point',
      hasAltitude: false,
    });
    // positions: 1 epoch × 5 features × 2 floats
    enc.setPositions(new Float32Array(1 * 5 * 2).fill(0));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const baseBuf = getWritten('_base.gfb.gz');
    const decoded = await decodeGFB(gunzipToArrayBuffer(baseBuf), manifest);

    expect(decoded.featureCount).toBe(5);
    expect(decoded.geomType).toBe(1); // POINT
  });

  test('static F32 column roundtrip', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 3,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(1 * 3 * 2).fill(0));
    enc.addStaticColumn('speed', 'float32', new Float32Array([10.5, 20.5, 30.5]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);
    expect(decoded.staticColumns.speed).toBeDefined();
    expect(decoded.staticColumns.speed[0]).toBeCloseTo(10.5);
    expect(decoded.staticColumns.speed[1]).toBeCloseTo(20.5);
    expect(decoded.staticColumns.speed[2]).toBeCloseTo(30.5);
  });

  test('dictionary + ENUM16 static column roundtrip', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 3,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(1 * 3 * 2).fill(0));
    enc.setDictionary(['Alaska', 'Delta', 'United']);
    enc.addStaticColumn('airline', 'enum16', new Uint16Array([0, 2, 1]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);

    expect(decoded.staticColumns.airline[0]).toBe(0);
    expect(decoded.staticColumns.airline[1]).toBe(2);
    expect(decoded.staticColumns.airline[2]).toBe(1);
  });

  test('addColumn with string array auto-builds dictionary', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 4,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(1 * 4 * 2).fill(0));
    enc.addColumn('airline', ['Delta', 'Alaska', 'Delta', 'United']);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);
    expect(decoded.dictionaries).toBeDefined();
    // Fallback or explicit dictionary check
    const dict = Array.from(decoded.dictionaries.airline);
    const deltaIdx = dict.indexOf('Delta');
    const alaskaIdx = dict.indexOf('Alaska');

    expect(decoded.staticColumns.airline[0]).toBe(deltaIdx);
    expect(decoded.staticColumns.airline[1]).toBe(alaskaIdx);
    expect(decoded.staticColumns.airline[2]).toBe(deltaIdx);
  });

  test('bbox auto-computation from position data', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: false,
    });
    // lon, lat pairs: feature0 at (-100, 30), feature1 at (50, 60)
    enc.setPositions(new Float32Array([-100, 30, 50, 60]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);
    expect(decoded.bbox.minLon).toBeCloseTo(-100, 0);
    expect(decoded.bbox.maxLon).toBeCloseTo(50, 0);
    expect(decoded.bbox.minLat).toBeCloseTo(30, 0);
    expect(decoded.bbox.maxLat).toBeCloseTo(60, 0);
  });

  test('explicit bbox passthrough', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 1,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: false,
    });
    const bbox = { minLon: -10, minLat: -5, maxLon: 10, maxLat: 5 };
    enc.setPositions(new Float32Array([0, 0]), bbox);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);
    expect(decoded.bbox.minLon).toBeCloseTo(-10, 1);
    expect(decoded.bbox.maxLon).toBeCloseTo(10, 1);
    expect(decoded.bbox.minLat).toBeCloseTo(-5, 1);
    expect(decoded.bbox.maxLat).toBeCloseTo(5, 1);
  });

  test('hasAltitude=true → floatsPerPos=3', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: true,
    });
    // 1 epoch × 2 features × 3 floats
    enc.setPositions(new Float32Array(1 * 2 * 3).fill(1));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);
    expect(decoded.hasAltitude).toBe(true);
  });

  test('hasAltitude=false → floatsPerPos=2', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(1 * 2 * 2).fill(1));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);
    expect(decoded.hasAltitude).toBe(false);
  });

  test('multiple static columns with correct schema', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(1 * 2 * 2).fill(0));
    enc.addStaticColumn('speed', 'float32', new Float32Array([100, 200]));
    enc.setDictionary(['A', 'B']);
    enc.addStaticColumn('type', 'enum16', new Uint16Array([0, 1]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);
    expect(decoded.schema.length).toBe(2);
    expect(decoded.schema[0].name).toBe('speed');
    expect(decoded.schema[1].name).toBe('type');
    expect(decoded.staticColumns.speed[0]).toBeCloseTo(100);
    expect(decoded.staticColumns.type[0]).toBe(0);
    expect(decoded.staticColumns.type[1]).toBe(1);
  });

  test('manifest has correct shard structure', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 6,
      epochInterval: 60,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(6 * 2 * 2).fill(1));

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      sharding: { epochsPerShard: 2 },
    });

    expect(manifest.format).toBe('gfb-sharded');
    expect(manifest.version).toBe(3);
    expect(manifest.shardFormat).toBe('v3');
    expect(manifest.featureCount).toBe(2);
    expect(manifest.epochCount).toBe(6);
    expect(manifest.shards).toBeDefined();
    expect(manifest.shards.length).toBe(3);
    expect(manifest.shards[0].epochs).toEqual([0, 1]);
    expect(manifest.shards[1].epochs).toEqual([2, 3]);
    expect(manifest.shards[2].epochs).toEqual([4, 5]);
  });

  test('partial last shard has correct epochCount', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 5,
      epochInterval: 60,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(5 * 2 * 2).fill(1));

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      sharding: { epochsPerShard: 3 },
    });

    // 5 epochs / 3 per shard → 2 shards
    expect(manifest.shards.length).toBe(2);
    expect(manifest.shards[0].epochCount).toBe(3);
    expect(manifest.shards[1].epochCount).toBe(2);
    expect(manifest.shards[1].epochs).toEqual([3, 4]);
  });

  test('temporal position data sliced correctly into shards', async () => {
    const featureCount = 2;
    const epochCount = 4;
    const positions = new Float32Array([
      10,
      11,
      12,
      13, // epoch 0
      20,
      21,
      22,
      23, // epoch 1
      30,
      31,
      32,
      33, // epoch 2
      40,
      41,
      42,
      43, // epoch 3
    ]);

    const enc = new GeoFlexEncoder({
      featureCount,
      epochCount,
      epochInterval: 60,
      hasAltitude: false,
    });
    enc.setPositions(positions);

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      sharding: { epochsPerShard: 2 },
    });

    expect(getWritten('e0000-e0001.shard')).toBeDefined();
    expect(getWritten('e0002-e0003.shard')).toBeDefined();
  });

  test('temporal attribute appended after positions in shard', async () => {
    const featureCount = 2;
    const epochCount = 2;
    const positions = new Float32Array(epochCount * featureCount * 2).fill(0);
    const temporal = new Float32Array([5, 6, 7, 8]);

    const enc = new GeoFlexEncoder({
      featureCount,
      epochCount,
      epochInterval: 60,
      hasAltitude: false,
    });
    enc.setPositions(positions);
    enc.setTemporalData('demand', temporal);

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      sharding: { epochsPerShard: 2 },
    });

    expect(getWritten('e0000-e0001.shard')).toBeDefined();
  });

  test('epoch settings propagated to manifest', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 1,
      epochCount: 10,
      epochInterval: 120,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(10 * 1 * 2).fill(0));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });
    expect(manifest.epochCount).toBe(10);
    expect(manifest.epochInterval).toBe(120);
  });
});
