// tests/h3FlexEncoder.test.js — Roundtrip tests for H3FlexEncoder → decodeH3Flex
import { gunzipSync } from 'zlib';
import { decodeH3Flex } from '../src/layers/H3FlexDecoder.js';
import { H3FlexEncoder } from '../lib/packages/data-sdk/src/encoders/H3FlexEncoder.js';

// ─── fs mock ────────────────────────────────────────────────────────────────
const writtenFiles = {};
vi.mock('fs', () => ({
  writeFileSync: vi.fn((filePath, data) => {
    const key = filePath.toString().replace(/.*[\\/]/, '');
    writtenFiles[key] = data;
  }),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false), // Mock mesh exists check
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

/** Minimal fake H3 cell IDs (as hex strings) — not real H3 IDs but structurally valid. */
const FAKE_CELLS = ['8001fffffffffff', '8001fffffffffffe', '8001fffffffffffd'];

/** Fake cell centers [lat, lon] per cell */
const FAKE_CENTERS = [
  [37.7, -122.4],
  [40.7, -74.0],
  [51.5, -0.1],
];

beforeEach(() => {
  Object.keys(writtenFiles).forEach((k) => delete writtenFiles[k]);
  vi.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('H3FlexEncoder → decodeH3Flex roundtrip', () => {
  test('static-only base: correct cellCount in decoded output', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const baseBuf = getWritten('_base.h3f.gz');
    const decoded = await decodeH3Flex(gunzipToArrayBuffer(baseBuf), manifest);

    expect(decoded.cellCount).toBe(3);
    expect(decoded.epochCount).toBe(0);
    expect(decoded.schema).toEqual([]);
  });

  test('cell IDs roundtrip as BigUint64', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);

    expect(decoded.cellIds.length).toBe(3);
    // Verify each cell ID roundtrips correctly (BigInt)
    for (let i = 0; i < FAKE_CELLS.length; i++) {
      const expected = BigInt('0x' + FAKE_CELLS[i]);
      expect(decoded.cellIds[i]).toBe(expected);
    }
  });

  test('static F32 column roundtrip', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    enc.addStaticColumn('capacity', 'float32', new Float32Array([100.5, 200.5, 300.5]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);
    expect(decoded.staticColumns.capacity).toBeDefined();
    expect(decoded.staticColumns.capacity[0]).toBeCloseTo(100.5);
    expect(decoded.staticColumns.capacity[1]).toBeCloseTo(200.5);
    expect(decoded.staticColumns.capacity[2]).toBeCloseTo(300.5);
  });

  test('static ENUM16 column with explicit dictionary roundtrip', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    const dict = ['CONUS', 'EMEA', 'APAC'];
    enc.addStaticColumn('region', 'enum16', new Uint16Array([0, 1, 2]), dict);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);
    expect(decoded.dictionaries.region).toEqual(['CONUS', 'EMEA', 'APAC']);
    expect(decoded.staticColumns.region[0]).toBe(0);
    expect(decoded.staticColumns.region[1]).toBe(1);
    expect(decoded.staticColumns.region[2]).toBe(2);
  });

  test('addColumn with string array auto-builds dictionary', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    enc.addColumn('region', ['West', 'East', 'West']);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);

    const dict = Array.from(decoded.dictionaries.region);
    expect(dict).toBeDefined();
    expect(dict).toContain('West');
    expect(dict).toContain('East');
    const westIdx = dict.indexOf('West');
    const eastIdx = dict.indexOf('East');
    expect(decoded.staticColumns.region[0]).toBe(westIdx);
    expect(decoded.staticColumns.region[1]).toBe(eastIdx);
    expect(decoded.staticColumns.region[2]).toBe(westIdx);
  });

  test('embedded style roundtrip', async () => {
    const style = { layers: [{ type: 'ramp', attribute: 'demand', domain: [0, 100] }] };
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    enc.setStyle(style);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);
    expect(decoded.hasStyle).toBe(true);
    expect(decoded.embeddedStyle).toEqual(style);
  });

  test('dictionary uses uint32 dictCount (v3 format)', async () => {
    // H3FlexEncoder always writes version 3 (uint32 dictCount).
    // Decoder handles v3 with uint32 read.
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    enc.setDictionary(['Alpha', 'Beta', 'Gamma']);
    enc.addStaticColumn('cat', 'enum', new Uint8Array([0, 1, 2]));

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);
    // Version 3 → decoder reads uint32 dictCount
    expect(decoded.dictionaries.cat).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(decoded.schema[0].name).toBe('cat');
  });

  test('row-level mode: isRowLevel flag and cellIndex decoded', async () => {
    const uniqueCells = FAKE_CELLS; // 3 unique cells
    // 5 data rows: rows 0,1 → cell 0; rows 2,3 → cell 1; row 4 → cell 2
    const cellIndex = new Uint32Array([0, 0, 1, 1, 2]);
    const rowCount = 5;

    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(uniqueCells, FAKE_CENTERS);
    enc.setRowLevelData(cellIndex, rowCount);

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      manifest: { isRowLevel: true, rowCount },
    });

    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);
    expect(decoded.isRowLevel).toBe(true);
    expect(decoded.rowCount).toBe(rowCount);
    expect(decoded.cellCount).toBe(3); // unique cells
    expect(decoded.cellIndex).toBeDefined();
    expect(decoded.cellIndex.length).toBe(rowCount);
    expect(decoded.cellIndex[0]).toBe(0);
    expect(decoded.cellIndex[1]).toBe(0);
    expect(decoded.cellIndex[2]).toBe(1);
    expect(decoded.cellIndex[4]).toBe(2);
  });

  test('row-level mode: static columns use rowCount (not cellCount)', async () => {
    const uniqueCells = FAKE_CELLS; // 3 unique cells
    const cellIndex = new Uint32Array([0, 0, 1, 1, 2]);
    const rowCount = 5;

    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(uniqueCells, FAKE_CENTERS);
    enc.setRowLevelData(cellIndex, rowCount);
    // Column must be sized by rowCount
    enc.addStaticColumn('flow', 'float32', new Float32Array([1, 2, 3, 4, 5]));

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      manifest: { isRowLevel: true, rowCount },
    });

    const decoded = await decodeH3Flex(gunzipToArrayBuffer(getWritten('_base.h3f.gz')), manifest);
    expect(decoded.dataCount).toBe(rowCount); // 5 rows
    expect(decoded.staticColumns.flow.length).toBe(rowCount);
    expect(decoded.staticColumns.flow[0]).toBeCloseTo(1);
    expect(decoded.staticColumns.flow[4]).toBeCloseTo(5);
  });

  test('static-only manifest: format h3flex-static, no shards', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);

    const { manifest } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    expect(manifest.format).toBe('h3flex-static');
    expect(manifest.version).toBe(3);
    expect(manifest.cellCount).toBe(3);
    expect(manifest.epochCount).toBe(0);
    expect(manifest.base).toBe('mydata_base.h3f.gz');
    expect(manifest.shards).toBeUndefined();
  });

  test('single-metric manifest: format h3flex-sharded (SHD2)', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300, epochCount: 4 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    enc.setTemporalData('demand', new Float32Array(3 * 4).fill(1.0));

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      sharding: { epochsPerShard: 4 },
    });

    expect(manifest.format).toBe('h3flex-sharded');
    expect(manifest.version).toBe(3);
    expect(manifest.shardFormat).toBe('v3');
    expect(manifest.temporalAttributes).toBeDefined();
    expect(manifest.shards).toBeDefined();
    expect(manifest.shards.length).toBe(1);
  });

  test('multi-metric manifest: format h3flex-sharded v3 with temporalAttributes', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300, epochCount: 4 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    enc.setTemporalData('demand', new Float32Array(3 * 4).fill(1.0));
    enc.setTemporalData('supply', new Float32Array(3 * 4).fill(2.0));

    const { manifest } = await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      sharding: { epochsPerShard: 4 },
    });

    expect(manifest.format).toBe('h3flex-sharded');
    expect(manifest.version).toBe(3);
    expect(manifest.shardFormat).toBe('v3');
    expect(manifest.temporalAttributes).toBeDefined();
    expect(manifest.temporalAttributes.length).toBe(2);
    const names = manifest.temporalAttributes.map((a) => a.name);
    expect(names).toContain('demand');
    expect(names).toContain('supply');
    expect(manifest.activeMetric).toBe('demand');
  });

  test('setTemporalData auto-detects epochCount from data length', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS); // 3 cells
    // 12 values / 3 cells = 4 epochs
    enc.setTemporalData('metric', new Float32Array(12).fill(1));

    expect(enc.epochCount).toBe(4);
  });

  test('shard files named with correct epoch padding', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300, epochCount: 6 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);
    enc.setTemporalData('demand', new Float32Array(3 * 6).fill(1.0));

    await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      sharding: { epochsPerShard: 3 },
    });

    // Expect shard files with 4-digit padded epoch numbers
    expect(Object.keys(writtenFiles).some((k) => k.includes('e0000-e0002'))).toBe(true);
    expect(Object.keys(writtenFiles).some((k) => k.includes('e0003-e0005'))).toBe(true);
  });

  test('stats returned from encode()', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(FAKE_CELLS, FAKE_CENTERS);

    const { stats } = await enc.encode({ output: '/tmp/test/', baseName: 'mydata' });

    expect(stats.cellCount).toBe(3);
    expect(stats.epochCount).toBe(0);
    expect(typeof stats.durationMs).toBe('number');
  });
});
