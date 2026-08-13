// tests/mfbDecoder.test.js — Unit tests for MFB decoder
import { gunzipSync } from 'zlib';
import { decodeMFB } from '../src/layers/MFBDecoder.js';
import { MetricFlexEncoder } from '../lib/packages/data-sdk/src/encoders/MetricFlexEncoder.js';

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function gunzipToArrayBuffer(buf) {
  return toArrayBuffer(gunzipSync(buf));
}

const writtenFiles = {};
vi.mock('fs', () => ({
  writeFileSync: vi.fn((filePath, data) => {
    const key = filePath.toString().replace(/.*[\\/]/, '');
    writtenFiles[key] = data;
  }),
  mkdirSync: vi.fn(),
}));

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

describe('MFBDecoder (v3)', () => {
  test('decodes FLOAT32 column data', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 3, epochCount: 0, epochInterval: 60 });
    enc.addStaticColumn('score', 'float32', new Float32Array([1.5, 2.5, 3.5]));
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeMFB(gunzipToArrayBuffer(getWritten('_base.mfb.gz')), manifest);

    expect(decoded.staticColumns.score).toBeDefined();
    expect(decoded.staticColumns.score.length).toBe(3);
    expect(decoded.staticColumns.score[0]).toBeCloseTo(1.5);
    expect(decoded.staticColumns.score[1]).toBeCloseTo(2.5);
    expect(decoded.staticColumns.score[2]).toBeCloseTo(3.5);
  });

  test('decodes INT32 column data including negative values', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 3, epochCount: 0, epochInterval: 60 });
    enc.addStaticColumn('val', 'int32', new Int32Array([-10, 0, 42]));
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeMFB(gunzipToArrayBuffer(getWritten('_base.mfb.gz')), manifest);

    expect(decoded.staticColumns.val.length).toBe(3);
    expect(decoded.staticColumns.val[0]).toBe(-10);
    expect(decoded.staticColumns.val[1]).toBe(0);
    expect(decoded.staticColumns.val[2]).toBe(42);
  });

  test('decodes UINT32 column data', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 2, epochCount: 0, epochInterval: 60 });
    enc.addStaticColumn('id', 'uint32', new Uint32Array([1001, 2002]));
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeMFB(gunzipToArrayBuffer(getWritten('_base.mfb.gz')), manifest);

    expect(decoded.staticColumns.id[0]).toBe(1001);
    expect(decoded.staticColumns.id[1]).toBe(2002);
  });

  test('decodes UINT8 column data', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 4, epochCount: 0, epochInterval: 60 });
    enc.addStaticColumn('flags', 'uint8', new Uint8Array([0, 1, 255, 128]));
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeMFB(gunzipToArrayBuffer(getWritten('_base.mfb.gz')), manifest);

    expect(decoded.staticColumns.flags.length).toBe(4);
    expect(decoded.staticColumns.flags[0]).toBe(0);
    expect(decoded.staticColumns.flags[1]).toBe(1);
    expect(decoded.staticColumns.flags[2]).toBe(255);
    expect(decoded.staticColumns.flags[3]).toBe(128);
  });

  test('decodes FLOAT64 column data with high precision', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 2, epochCount: 0, epochInterval: 60 });
    enc.addStaticColumn(
      'precise',
      'float64',
      new Float64Array([1.23456789012345, -9.87654321098765])
    );
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeMFB(gunzipToArrayBuffer(getWritten('_base.mfb.gz')), manifest);

    expect(decoded.staticColumns.precise.length).toBe(2);
    expect(decoded.staticColumns.precise[0]).toBeCloseTo(1.23456789012345, 10);
    expect(decoded.staticColumns.precise[1]).toBeCloseTo(-9.87654321098765, 10);
  });

  test('decodes ENUM32 column — resolves indices to strings', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 3, epochCount: 0, epochInterval: 60 });
    enc.addColumn('airline', ['Alaska', 'United', 'Delta']);
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeMFB(gunzipToArrayBuffer(getWritten('_base.mfb.gz')), manifest);

    // Encoder auto-builds dict: ['Alaska', 'United', 'Delta']
    // v3 decoder maps dict array into decoded object correctly.
    expect(decoded.dictionaries.airline[decoded.staticColumns.airline[0]]).toBe('Alaska');
    expect(decoded.dictionaries.airline[decoded.staticColumns.airline[1]]).toBe('United');
    expect(decoded.dictionaries.airline[decoded.staticColumns.airline[2]]).toBe('Delta');
  });

  test('decodes BOOLEAN column (via uint8 / 0 or 1)', async () => {
    // v3 currently passes booleans naturally via unint8 mapping when using addStaticColumn
    const enc = new MetricFlexEncoder({ entityCount: 5, epochCount: 0, epochInterval: 60 });
    enc.addStaticColumn('active', 'boolean', new Uint8Array([1, 0, 1, 1, 0]));
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeMFB(gunzipToArrayBuffer(getWritten('_base.mfb.gz')), manifest);

    expect(decoded.staticColumns.active.length).toBe(5);
    expect(decoded.staticColumns.active[0]).toBe(1);
    expect(decoded.staticColumns.active[1]).toBe(0);
    expect(decoded.staticColumns.active[2]).toBe(1);
    expect(decoded.staticColumns.active[3]).toBe(1);
    expect(decoded.staticColumns.active[4]).toBe(0);
  });

  test('decodes multiple columns in a single file', async () => {
    const enc = new MetricFlexEncoder({ entityCount: 2, epochCount: 0, epochInterval: 60 });
    enc.addStaticColumn('score', 'float32', new Float32Array([1.0, 2.0]));
    enc.addStaticColumn('count', 'uint32', new Uint32Array([100, 200]));
    enc.addStaticColumn('flag', 'uint8', new Uint8Array([0, 1]));
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeMFB(gunzipToArrayBuffer(getWritten('_base.mfb.gz')), manifest);

    expect(decoded.schema.length).toBe(3);
    expect(decoded.staticColumns.score[0]).toBeCloseTo(1.0);
    expect(decoded.staticColumns.score[1]).toBeCloseTo(2.0);
    expect(decoded.staticColumns.count[0]).toBe(100);
    expect(decoded.staticColumns.count[1]).toBe(200);
    expect(decoded.staticColumns.flag[0]).toBe(0);
    expect(decoded.staticColumns.flag[1]).toBe(1);
  });

  test('large rowCount with multiple column types', async () => {
    const n = 100;
    const floatVals = new Float32Array(n).map((_, i) => i * 0.1);
    const intVals = new Int32Array(n).map((_, i) => i - 50);
    const u8Vals = new Uint8Array(n).map((_, i) => i % 256);

    const enc = new MetricFlexEncoder({ entityCount: n, epochCount: 0, epochInterval: 60 });
    enc.addStaticColumn('f32', 'float32', floatVals);
    enc.addStaticColumn('i32', 'int32', intVals);
    enc.addStaticColumn('u8', 'uint8', u8Vals);
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeMFB(gunzipToArrayBuffer(getWritten('_base.mfb.gz')), manifest);

    expect(decoded.entityCount).toBe(n);
    expect(decoded.staticColumns.f32.length).toBe(n);
    expect(decoded.staticColumns.f32[50]).toBeCloseTo(5.0);
    expect(decoded.staticColumns.i32[0]).toBe(-50);
    expect(decoded.staticColumns.i32[50]).toBe(0);
    expect(decoded.staticColumns.u8[255 % n]).toBe(255 % n);
  });
});
