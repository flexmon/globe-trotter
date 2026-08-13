// tests/gfbDecoder.test.js — Unit tests for GeoFlex Binary decoder (v3)
import { gunzipSync } from 'zlib';
import { decodeGFB } from '../src/layers/GFBDecoder.js';
import { GeoFlexEncoder } from '../lib/packages/data-sdk/src/encoders/GeoFlexEncoder.js';

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

describe('GFBDecoder (v3)', () => {
  test('decodes minimal point geometry', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 3,
      epochCount: 0,
      epochInterval: 300,
      geometryType: 'point',
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(3 * 2).fill(0));
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);

    expect(decoded.featureCount).toBe(3);
    expect(decoded.geomType).toBe(1);
    expect(decoded.geometry.type).toBe('point');
    expect(decoded.geometry.packedPositions.length).toBe(16); // 2x2 texture padding × 4 channels
  });

  test('rejects invalid magic', async () => {
    const buffer = new ArrayBuffer(48);
    const u8 = new Uint8Array(buffer);
    u8[0] = 0x42;
    u8[1] = 0x41;
    u8[2] = 0x44;
    u8[3] = 0x21; // BAD!

    // Pass a dummy manifest so it gets past the !manifest check
    await expect(decodeGFB(buffer, { columns: [] })).rejects.toThrow('Invalid SHD3 header');
  });

  test('decodes bbox correctly', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 1,
      epochCount: 0,
      epochInterval: 300,
      geometryType: 'point',
      hasAltitude: false,
    });
    const bbox = { minLon: -180, minLat: -90, maxLon: 180, maxLat: 90 };
    enc.setPositions(new Float32Array([0, 0]), bbox);
    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });

    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);

    expect(decoded.bbox.minLon).toBeCloseTo(-180);
    expect(decoded.bbox.minLat).toBeCloseTo(-90);
    expect(decoded.bbox.maxLon).toBeCloseTo(180);
    expect(decoded.bbox.maxLat).toBeCloseTo(90);
  });

  test('decodes schema columns', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 0,
      epochInterval: 300,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(2 * 2).fill(0));
    enc.addStaticColumn('speed', 'float32', new Float32Array([10, 20]));
    enc.setDictionary([]); // trigger dictionary creation
    enc.addStaticColumn('color_idx', 'enum16', new Uint16Array([0, 1]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);

    expect(decoded.schema.length).toBe(2);
    // Note: names in v3 manifest usually map properties
    expect(decoded.schema.map((c) => c.name)).toContain('speed');
    expect(decoded.schema.map((c) => c.name)).toContain('color_idx');
  });

  test('decodes static F32 column data', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 0,
      epochInterval: 300,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(2 * 2).fill(0));
    enc.addStaticColumn('speed', 'float32', new Float32Array([100.5, 200.5]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);

    expect(decoded.staticColumns.speed[0]).toBeCloseTo(100.5);
    expect(decoded.staticColumns.speed[1]).toBeCloseTo(200.5);
  });

  test('decodes dictionary', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 1,
      epochCount: 0,
      epochInterval: 300,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(1 * 2).fill(0));
    enc.setDictionary(['RED', 'GREEN', 'BLUE']);
    enc.addStaticColumn('color', 'enum32', new Uint32Array([1]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);

    expect(decoded.dictionaries.color).toEqual(['RED', 'GREEN', 'BLUE']);
  });

  test('decodes epoch settings', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 10,
      epochInterval: 600,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(10 * 2 * 2).fill(0)); // 10 epochs

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);

    expect(decoded.epochCount).toBe(10);
    expect(decoded.epochInterval).toBe(600);
  });

  test('handles altitude flag (3 floats per position)', async () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 0,
      epochInterval: 300,
      hasAltitude: true,
    });
    enc.setPositions(new Float32Array(2 * 3).fill(0));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);

    expect(decoded.hasAltitude).toBe(true);
    expect(decoded.geometry.floatsPerPos).toBe(3);
    expect(decoded.geometry.packedPositions.length / 4).toBe(4); // RGBA32F packing maps 2 feats to 4 texels (2x2 tex)
  });

  test('decodes enum32 static column after large dictionary (alignment regression)', async () => {
    // v3 decoder now naturally respects JS typed arrays offsets from the ShardV3Decoder.
    // We simulate a weird misalignment scenario by setting dictionary and schema sizes.
    const enc = new GeoFlexEncoder({
      featureCount: 4,
      epochCount: 0,
      epochInterval: 300,
      hasAltitude: false,
    });
    enc.setPositions(new Float32Array(4 * 2).fill(0));
    enc.setDictionary(['A', 'B', 'C']);
    enc.addStaticColumn('sat_id', 'enum32', new Uint32Array([0, 1, 2, 0]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    const decoded = await decodeGFB(gunzipToArrayBuffer(getWritten('_base.gfb.gz')), manifest);

    expect(decoded.featureCount).toBe(4);
    expect(decoded.dictionaries.sat_id).toEqual(['A', 'B', 'C']);
    expect(decoded.staticColumns.sat_id).toBeDefined();
    expect(decoded.staticColumns.sat_id.length).toBe(4);
    expect(decoded.staticColumns.sat_id[0]).toBe(0);
    expect(decoded.staticColumns.sat_id[1]).toBe(1);
    expect(decoded.staticColumns.sat_id[2]).toBe(2);
    expect(decoded.staticColumns.sat_id[3]).toBe(0);
  });
});
