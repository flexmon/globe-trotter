/**
 * rampCompilerFull.test.js — Extended unit tests for RampCompiler.
 *
 * Ported from globe-trotter-2d. Covers:
 *   - parseColor (exported after Phase 1 backport)
 *   - compileRampData (including divide-by-zero guard)
 *   - RAMP_WIDTH constant
 */

import { parseColor, compileRampData, RAMP_WIDTH } from '../src/styles/RampCompiler.js';

// ─── parseColor ───────────────────────────────────────────────────────────────

describe('parseColor', () => {
  test('parses 6-char hex → alpha 1.0', () => {
    const [r, g, b, a] = parseColor('#ff0000');
    expect(r).toBeCloseTo(1.0);
    expect(g).toBeCloseTo(0.0);
    expect(b).toBeCloseTo(0.0);
    expect(a).toBeCloseTo(1.0);
  });

  test('parses 6-char hex without leading #', () => {
    const [r, g, b, a] = parseColor('00ff00');
    expect(r).toBeCloseTo(0.0);
    expect(g).toBeCloseTo(1.0);
    expect(b).toBeCloseTo(0.0);
    expect(a).toBeCloseTo(1.0);
  });

  test('parses 8-char hex with alpha', () => {
    const [, , , a] = parseColor('#ffffff80');
    expect(a).toBeCloseTo(0x80 / 255, 2);
  });

  test('parses 3-char shorthand', () => {
    const [r, g, b, a] = parseColor('#f00');
    expect(r).toBeCloseTo(1.0);
    expect(g).toBeCloseTo(0.0);
    expect(b).toBeCloseTo(0.0);
    expect(a).toBeCloseTo(1.0);
  });

  test('parses black #000000', () => {
    expect(parseColor('#000000')).toEqual([0, 0, 0, 1]);
  });

  test('parses white #ffffff', () => {
    const [r, g, b, a] = parseColor('#ffffff');
    expect(r).toBeCloseTo(1.0);
    expect(g).toBeCloseTo(1.0);
    expect(b).toBeCloseTo(1.0);
    expect(a).toBeCloseTo(1.0);
  });

  test('returns magenta fallback for invalid input', () => {
    expect(parseColor('#xyz')).toEqual([1, 0, 1, 1]);
  });

  test('returns magenta fallback for non-string (Phase 1: type guard)', () => {
    expect(parseColor(null)).toEqual([1, 0, 1, 1]);
    expect(parseColor(42)).toEqual([1, 0, 1, 1]);
  });

  test('returns magenta fallback for empty string', () => {
    expect(parseColor('')).toEqual([1, 0, 1, 1]);
  });
});

// ─── compileRampData ──────────────────────────────────────────────────────────

describe('compileRampData', () => {
  test('returns a Uint8Array of length RAMP_WIDTH * 4', () => {
    const stops = [
      { value: 0, color: '#000000' },
      { value: 1, color: '#ffffff' },
    ];
    const data = compileRampData(stops, [0, 1]);
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBe(RAMP_WIDTH * 4);
  });

  test('pixel at domain minimum matches first stop color', () => {
    const stops = [
      { value: 0, color: '#ff0000' },
      { value: 1, color: '#0000ff' },
    ];
    const data = compileRampData(stops, [0, 1]);
    expect(data[0]).toBeGreaterThan(200); // R
    expect(data[1]).toBeLessThan(10); // G
    expect(data[2]).toBeLessThan(10); // B
    expect(data[3]).toBe(255); // A
  });

  test('pixel at domain maximum matches last stop color', () => {
    const stops = [
      { value: 0, color: '#ff0000' },
      { value: 1, color: '#0000ff' },
    ];
    const data = compileRampData(stops, [0, 1]);
    const last = (RAMP_WIDTH - 1) * 4;
    expect(data[last]).toBeLessThan(10); // R
    expect(data[last + 1]).toBeLessThan(10); // G
    expect(data[last + 2]).toBeGreaterThan(200); // B
  });

  test('midpoint is interpolated between two stops', () => {
    const stops = [
      { value: 0, color: '#000000' },
      { value: 1, color: '#ffffff' },
    ];
    const data = compileRampData(stops, [0, 1]);
    const mid = 128 * 4;
    expect(data[mid]).toBeGreaterThan(100);
    expect(data[mid]).toBeLessThan(160);
  });

  test('pixels before the first stop are transparent', () => {
    const stops = [
      { value: 50, color: '#ff0000' },
      { value: 100, color: '#0000ff' },
    ];
    const data = compileRampData(stops, [0, 100]);
    expect(data[3]).toBe(0); // alpha=0 below first stop
  });

  test('bakes opacity stops into the alpha channel', () => {
    const stops = [
      { value: 0, color: '#ffffff' },
      { value: 1, color: '#ffffff' },
    ];
    const opacityStops = [
      { value: 0, opacity: 0 },
      { value: 1, opacity: 1 },
    ];
    const data = compileRampData(stops, [0, 1], opacityStops);
    expect(data[3]).toBeLessThan(5);
    expect(data[(RAMP_WIDTH - 1) * 4 + 3]).toBeGreaterThan(250);
  });

  test('all bytes are valid (0–255) for any well-formed input', () => {
    const stops = [
      { value: 10, color: '#abcdef' },
      { value: 90, color: '#123456' },
    ];
    const data = compileRampData(stops, [0, 100]);
    for (let i = 0; i < data.length; i++) {
      expect(data[i]).toBeGreaterThanOrEqual(0);
      expect(data[i]).toBeLessThanOrEqual(255);
    }
  });

  test('handles domain with zero range (Phase 1: divide-by-zero guard)', () => {
    // This test FAILS on old 3D code where range = 0 causes NaN.
    const stops = [{ value: 5, color: '#ff0000' }];
    expect(() => compileRampData(stops, [5, 5])).not.toThrow();
    const data = compileRampData(stops, [5, 5]);
    // All pixels should be valid numbers, not NaN
    for (let i = 0; i < data.length; i++) {
      expect(isNaN(data[i])).toBe(false);
    }
  });

  test('sorts stops regardless of input order', () => {
    const fwd = compileRampData(
      [
        { value: 0, color: '#ff0000' },
        { value: 1, color: '#0000ff' },
      ],
      [0, 1]
    );
    const rev = compileRampData(
      [
        { value: 1, color: '#0000ff' },
        { value: 0, color: '#ff0000' },
      ],
      [0, 1]
    );
    expect(Array.from(fwd)).toEqual(Array.from(rev));
  });

  test('exports RAMP_WIDTH = 256', () => {
    expect(RAMP_WIDTH).toBe(256);
  });
});
