// tests/encoderUtils.test.js — Tests for shared encoder utility logic via public API.
// Tests _inferType, _coerceEnumArray, _buildEnumColumn, and enum width auto-selection
// indirectly through addColumn() / addStaticColumn() on all three encoders.
import { GeoFlexEncoder } from '../lib/packages/data-sdk/src/encoders/GeoFlexEncoder.js';
import { MetricFlexEncoder } from '../lib/packages/data-sdk/src/encoders/MetricFlexEncoder.js';
import { H3FlexEncoder } from '../lib/packages/data-sdk/src/encoders/H3FlexEncoder.js';

// ─── _inferType via addColumn ───────────────────────────────────────────────

describe('_inferType via GeoFlexEncoder.addColumn', () => {
  function makeEncoder() {
    return new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 0,
      epochInterval: 60,
      hasAltitude: false,
    });
  }

  test('Float32Array inferred as float32', () => {
    const enc = makeEncoder();
    enc.addColumn('x', new Float32Array([1, 2]));
    expect(enc._columns[0].type).toBe(1); // F32
  });

  test('Uint32Array inferred as uint32', () => {
    const enc = makeEncoder();
    enc.addColumn('x', new Uint32Array([1, 2]));
    expect(enc._columns[0].type).toBe(4); // _inferType returns 'uint32' → addStaticColumn gets 'uint32'
  });

  test('string array builds dictionary and uses ENUM32 type', () => {
    const enc = makeEncoder();
    enc.addColumn('airline', ['Alaska', 'Delta', 'Alaska']);
    expect(enc._columns[0].type).toBe(14); // ENUM32 (14)
    expect(enc._columns[0].dictionary).toEqual(['Alaska', 'Delta']);
    expect(enc._columns[0].data[0]).toBe(0); // Alaska
    expect(enc._columns[0].data[1]).toBe(1); // Delta
    expect(enc._columns[0].data[2]).toBe(0); // Alaska again
  });

  test('string array with duplicates produces correct index mapping', () => {
    const enc = makeEncoder();
    enc.addColumn('status', ['A', 'B', 'A', 'C', 'B']);
    expect(enc._columns[0].dictionary).toEqual(['A', 'B', 'C']);
    const indices = enc._columns[0].data;
    expect(indices[0]).toBe(0); // A
    expect(indices[1]).toBe(1); // B
    expect(indices[2]).toBe(0); // A
    expect(indices[3]).toBe(2); // C
    expect(indices[4]).toBe(1); // B
  });
});

// ─── Dictionary width auto-selection ────────────────────────────────────────

// v3 MetricFlexEncoder always uses ENUM32 (type 14) with Uint32Array indices
// regardless of dictionary size.
describe('Dictionary encoding (MetricFlexEncoder v3)', () => {
  test('string[] always uses ENUM32 (type 14, Uint32Array)', () => {
    const enc = new MetricFlexEncoder({ entityCount: 3, epochCount: 0, epochInterval: 60 });
    enc.addColumn('label', ['A', 'B', 'C']);
    expect(enc._columns[0].type).toBe(14); // TYPE_ENUM32
    expect(enc._columns[0].data).toBeInstanceOf(Uint32Array);
  });

  test('255 unique strings → still ENUM32 with Uint32Array', () => {
    const enc = new MetricFlexEncoder({ entityCount: 255, epochCount: 0, epochInterval: 60 });
    const strings = Array.from({ length: 255 }, (_, i) => `item_${i}`);
    enc.addColumn('label', strings);
    expect(enc._columns[0].type).toBe(14); // TYPE_ENUM32
    expect(enc._columns[0].data).toBeInstanceOf(Uint32Array);
  });

  test('256 unique strings → ENUM32 with Uint32Array', () => {
    const enc = new MetricFlexEncoder({ entityCount: 256, epochCount: 0, epochInterval: 60 });
    const strings = Array.from({ length: 256 }, (_, i) => `item_${i}`);
    enc.addColumn('label', strings);
    expect(enc._columns[0].type).toBe(14); // TYPE_ENUM32
    expect(enc._columns[0].data).toBeInstanceOf(Uint32Array);
  });

  test('65535 unique strings → ENUM32 with Uint32Array', () => {
    const enc = new MetricFlexEncoder({ entityCount: 65535, epochCount: 0, epochInterval: 60 });
    const strings = Array.from({ length: 65535 }, (_, i) => `s${i}`);
    enc.addColumn('label', strings);
    expect(enc._columns[0].type).toBe(14); // TYPE_ENUM32
    expect(enc._columns[0].data).toBeInstanceOf(Uint32Array);
  });

  test('65536 unique strings → ENUM32 with Uint32Array', () => {
    const enc = new MetricFlexEncoder({ entityCount: 65536, epochCount: 0, epochInterval: 60 });
    const strings = Array.from({ length: 65536 }, (_, i) => `s${i}`);
    enc.addColumn('label', strings);
    expect(enc._columns[0].type).toBe(14); // TYPE_ENUM32
    expect(enc._columns[0].data).toBeInstanceOf(Uint32Array);
  });

  test('indices stored correctly for small dictionary', () => {
    const enc = new MetricFlexEncoder({ entityCount: 4, epochCount: 0, epochInterval: 60 });
    enc.addColumn('cat', ['X', 'Y', 'X', 'Z']);
    const col = enc._columns[0];
    expect(col.type).toBe(14);
    expect(col.data[0]).toBe(col.data[2]); // 'X' → same index
    expect(col.data[1]).not.toBe(col.data[0]); // 'Y' → different from 'X'
    expect(col.data[3]).not.toBe(col.data[0]); // 'Z' → different from 'X'
  });
});

// ─── _buildEnumColumn dictionary merging ────────────────────────────────────

describe('_buildEnumColumn dictionary merging (MetricFlexEncoder)', () => {
  test('builds dictionary from scratch for local column', () => {
    const enc = new MetricFlexEncoder({ entityCount: 2, epochCount: 0, epochInterval: 60 });
    enc.addColumn('cat', ['X', 'Y']);
    expect(enc._columns[0].dictionary).toEqual(['X', 'Y']);
  });
});

// ─── _coerceEnumArray via addStaticColumn ───────────────────────────────────

describe('_coerceEnumArray via H3FlexEncoder.addStaticColumn', () => {
  function makeH3Enc() {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['8001fffffffffff'], [[0, 0]]);
    return enc;
  }

  test('ENUM16 accepts Uint32Array and stores it unchanged', () => {
    const enc = makeH3Enc();
    // addStaticColumn maps 'enum16' → TYPE_ENUM32; data is already Uint32Array → no coercion needed
    const data = new Uint32Array([0, 1]);
    enc.addStaticColumn('cat', 'enum16', data);
    expect(enc._columns[0].data).toBeInstanceOf(Uint32Array);
    expect(enc._columns[0].data).toBe(data); // Same reference — no copy performed
  });

  test('ENUM32 coerces non-Uint32Array to Uint32Array', () => {
    const enc = makeH3Enc();
    // Pass a plain Uint16Array — _coerceEnumArray must convert it
    const data = new Uint16Array([0, 1]);
    enc.addStaticColumn('cat', 'enum32', data);
    expect(enc._columns[0].data).toBeInstanceOf(Uint32Array);
    expect(enc._columns[0].data[0]).toBe(0);
    expect(enc._columns[0].data[1]).toBe(1);
  });

  test('float32 column stores as-is', () => {
    const enc = makeH3Enc();
    const data = new Float32Array([1.5, 2.5]);
    enc.addStaticColumn('value', 'float32', data);
    expect(enc._columns[0].type).toBe(1); // F32
    expect(enc._columns[0].data).toBe(data);
  });
});

// ─── H3FlexEncoder.setCells input variants ──────────────────────────────────

describe('H3FlexEncoder.setCells input formats', () => {
  test('accepts array-of-[lat,lon] pairs', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(
      ['8001fffffffffff', '8001fffffffffff1'],
      [
        [37.7, -122.4],
        [40.7, -74.0],
      ]
    );
    expect(enc._cellCenters).toBeInstanceOf(Float64Array);
    expect(enc._cellCenters.length).toBe(4); // 2 cells × 2 coords
    expect(enc._cellCenters[0]).toBeCloseTo(37.7);
    expect(enc._cellCenters[1]).toBeCloseTo(-122.4);
  });

  test('accepts pre-built Float64Array', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    const centers = new Float64Array([37.7, -122.4, 40.7, -74.0]);
    enc.setCells(['8001fffffffffff', '8001fffffffffff1'], centers);
    expect(enc._cellCenters).toBe(centers); // same reference
  });

  test('sets cellCount correctly', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(
      ['a', 'b', 'c'],
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ]
    );
    expect(enc._cellCount).toBe(3);
  });
});

// ─── GeoFlexEncoder.setPositions bbox computation ───────────────────────────

describe('GeoFlexEncoder.setPositions bbox computation', () => {
  test('auto-computes bbox from position data', () => {
    const enc = new GeoFlexEncoder({
      featureCount: 2,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: false,
    });
    // 1 epoch × 2 features × 2 floats = [lon, lat, lon, lat]
    enc.setPositions(new Float32Array([-100, 30, 50, 60]));
    expect(enc._bbox.minLon).toBeCloseTo(-100);
    expect(enc._bbox.maxLon).toBeCloseTo(50);
    expect(enc._bbox.minLat).toBeCloseTo(30);
    expect(enc._bbox.maxLat).toBeCloseTo(60);
  });

  test('skips (0,0) positions when computing bbox', () => {
    const enc = new GeoFlexEncoder({
      featureCount: 3,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: false,
    });
    // The (0,0) entry should be excluded from bbox computation
    enc.setPositions(new Float32Array([0, 0, -50, 20, 80, 45]));
    expect(enc._bbox.minLon).toBeCloseTo(-50);
    expect(enc._bbox.maxLon).toBeCloseTo(80);
    expect(enc._bbox.minLat).toBeCloseTo(20);
    expect(enc._bbox.maxLat).toBeCloseTo(45);
  });

  test('uses explicit bbox when provided', () => {
    const enc = new GeoFlexEncoder({
      featureCount: 1,
      epochCount: 1,
      epochInterval: 60,
      hasAltitude: false,
    });
    const bbox = { minLon: -10, minLat: -5, maxLon: 10, maxLat: 5 };
    enc.setPositions(new Float32Array([0, 0]), bbox);
    expect(enc._bbox).toEqual(bbox);
  });
});
