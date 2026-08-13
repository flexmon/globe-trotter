// tests/h3FlexDecoder.test.js — Unit tests for H3Flex binary decoder (v3)
import { gunzipSync } from 'zlib';
import { decodeH3Flex, decodeH3Mesh } from '../src/layers/H3FlexDecoder.js';
import { H3FlexEncoder } from '../lib/packages/data-sdk/src/encoders/H3FlexEncoder.js';

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
  existsSync: vi.fn(() => false),
}));

function getWritten(suffix) {
  const key = Object.keys(writtenFiles).find((k) => k.endsWith(suffix));
  if (!key)
    throw new Error(
      `No file matching '${suffix}' was written. Available: ${Object.keys(writtenFiles).join(', ')}`
    );
  return writtenFiles[key];
}

const FAKE_CELLS = ['8001fffffffffff', '8001fffffffffffe', '8001fffffffffffd'];
const FAKE_CENTERS = [
  [37.7, -122.4],
  [40.7, -74.0],
  [51.5, -0.1],
];

beforeEach(() => {
  Object.keys(writtenFiles).forEach((k) => delete writtenFiles[k]);
  vi.clearAllMocks();
});

describe('H3FlexDecoder (v3)', () => {
  test('static-only base: correct cellCount in decoded output', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const baseBuf = getWritten('_base.h3f.gz');
    const decoded = await decodeH3Flex(gunzipToArrayBuffer(baseBuf), manifest);

    expect(decoded.cellCount).toBe(3);
    expect(decoded.epochCount).toBe(0); // in base
    expect(decoded.schema).toEqual([]); // no cols
  });

  test('rejects invalid magic', async () => {
    const buffer = new ArrayBuffer(32);
    const u8 = new Uint8Array(buffer);
    u8[0] = 0x42;
    u8[1] = 0x41;
    u8[2] = 0x44;
    u8[3] = 0x21; // BAD!

    await expect(decodeH3Flex(buffer, { columns: [] })).rejects.toThrow('Invalid SHD3 header');
  });

  test('decodes schema columns', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    enc.addStaticColumn('metric_a', 'float32', new Float32Array([1, 2, 3]));
    enc.addStaticColumn('region', 'enum16', new Uint16Array([0, 1, 2]), ['A', 'B', 'C']);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);

    expect(decoded.schema.length).toBe(2);
    const names = decoded.schema.map((c) => c.name);
    expect(names).toContain('metric_a');
    expect(names).toContain('region');
  });

  test('decodes static F32 column', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    enc.addStaticColumn('score', 'float32', new Float32Array([10.5, 20.5, 30.5]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);

    expect(decoded.staticColumns.score).toBeDefined();
    expect(decoded.staticColumns.score.length).toBe(3);
    expect(decoded.staticColumns.score[0]).toBeCloseTo(10.5);
    expect(decoded.staticColumns.score[1]).toBeCloseTo(20.5);
    expect(decoded.staticColumns.score[2]).toBeCloseTo(30.5);
  });

  test('decodes static ENUM16 column', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    enc.addStaticColumn('region', 'enum16', new Uint16Array([0, 1, 0]), ['CONUS', 'EMEA']);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);

    expect(Array.from(decoded.dictionaries.region)).toEqual(['CONUS', 'EMEA']);
    expect(decoded.staticColumns.region[0]).toBe(0);
    expect(decoded.staticColumns.region[1]).toBe(1);
  });

  test('decodes mesh data (external file in v3)', async () => {
    // v3 mesh encode generates a separate mesh file
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);

    // We provide a fake mesh structure
    const fakeMesh = {
      vertCount: 6,
      idxCount: 6,
      positions: new Float32Array(18).fill(1),
      cellIndices: new Float32Array(6).fill(0),
      extrudeFlags: new Float32Array(6).fill(1),
      indices: new Uint32Array(6).fill(0),
    };

    await enc.encode({ output: '/tmp/test/', baseName: 'mydata', mesh: fakeMesh });

    // Retrieve and decode the standalone mesh
    const meshBuf = getWritten('_mesh.h3f.gz');
    const meshData = decodeH3Mesh(gunzipToArrayBuffer(meshBuf));

    expect(meshData.vertexCount).toBe(6);
    expect(meshData.indexCount).toBe(6);
    expect(meshData.positions.length).toBe(18); // 6 * 3
    expect(meshData.cellIndices.length).toBe(6);
    expect(meshData.extrudeFlags.length).toBe(6);
    expect(meshData.indices.length).toBe(6);
  });

  test('decodes embedded style (via manifest in v3)', async () => {
    const style = { layers: [{ type: 'ramp', color: { domain: [0, 100] } }] };
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS.slice(0, 1), FAKE_CENTERS.slice(0, 1));
    enc.setStyle(style);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    // The embedded UI/layer style information in v3 is carried entirely within the manifest
    expect(manifest.style).toBeDefined();
    expect(manifest.style).toEqual(style);

    // the decoder sets hasStyle=true if manifest provides it
    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);
    expect(decoded.hasStyle).toBe(true);
    expect(decoded.embeddedStyle).toEqual(style);
  });

  test('full decode with manifest schema + dictionary + style', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS.slice(0, 2), FAKE_CENTERS.slice(0, 2));

    enc.addStaticColumn('val', 'float32', new Float32Array([1.0, 2.0]));
    enc.addColumn('cat', ['A', 'B']); // ENUM32 from string[]
    enc.setStyle({ test: true });

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'test' });
    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);

    expect(decoded.cellCount).toBe(2);
    expect(decoded.hasStyle).toBe(true);
    expect(Array.from(decoded.dictionaries.cat)).toEqual(['A', 'B']);
    expect(decoded.staticColumns.val[0]).toBeCloseTo(1.0);
    expect(decoded.staticColumns.cat[1]).toBe(1); // 'B' is index 1
  });
});
