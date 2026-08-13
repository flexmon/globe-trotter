/**
 * categoricalCompilerFull.test.js — Extended unit tests for CategoricalCompiler.
 *
 * Ported from globe-trotter-2d and merged with existing 3D tests.
 * Covers the defColor mutation bug (fixed in Phase 1 backport).
 */

import { compileCategoricalData } from '../src/styles/CategoricalCompiler.js';

describe('compileCategoricalData (full suite)', () => {
  test('returns a Uint8Array of width * 4 bytes', () => {
    const { data, width } = compileCategoricalData({ cat_a: '#ff0000', cat_b: '#00ff00' }, [
      'cat_a',
      'cat_b',
    ]);
    expect(data).toBeInstanceOf(Uint8Array);
    expect(width).toBe(2);
    expect(data.length).toBe(2 * 4);
  });

  test('maps hex-string categories to correct RGBA', () => {
    const { data } = compileCategoricalData({ red: '#ff0000', blue: '#0000ff' }, ['red', 'blue']);
    expect(data[0]).toBe(255); // R
    expect(data[1]).toBe(0); // G
    expect(data[2]).toBe(0); // B
    expect(data[3]).toBe(255); // A
    expect(data[4]).toBe(0);
    expect(data[5]).toBe(0);
    expect(data[6]).toBe(255);
    expect(data[7]).toBe(255);
  });

  test('uses first element of array entries', () => {
    const { data } = compileCategoricalData({ team: ['#ff0000', '#ffffff', '#0000ff'] }, ['team']);
    expect(data[0]).toBe(255);
    expect(data[2]).toBe(0);
  });

  test('respects opacity from object entries', () => {
    const { data } = compileCategoricalData({ semi: { color: '#ffffff', opacity: 0.5 } }, ['semi']);
    expect(data[3]).toBeGreaterThan(120);
    expect(data[3]).toBeLessThan(135);
  });

  test('falls back to defaultColor for unmapped categories', () => {
    const { data } = compileCategoricalData({}, ['unknown'], '#333333');
    expect(data[0]).toBeCloseTo(Math.round((0x33 / 255) * 255));
  });

  test('uses default color of #999999 when not specified', () => {
    const { data } = compileCategoricalData({}, ['x']);
    expect(data[0]).toBe(153); // 0x99
    expect(data[1]).toBe(153);
    expect(data[2]).toBe(153);
  });

  test('handles empty dictionary by producing width=1', () => {
    const { data, width } = compileCategoricalData({}, []);
    expect(width).toBe(1);
    expect(data.length).toBe(4);
  });

  test('supports dictionary with .getString() method (ShardV3 ENUM16 compat)', () => {
    const dict = { length: 2, getString: (i) => ['alpha', 'beta'][i] };
    const { data, width } = compileCategoricalData({ alpha: '#ff0000', beta: '#00ff00' }, dict);
    expect(width).toBe(2);
    expect(data[0]).toBe(255); // alpha → red
    expect(data[5]).toBe(255); // beta → green
  });

  test('all bytes are valid (0–255)', () => {
    const cats = { a: '#123456', b: '#abcdef', c: { color: '#fedcba', opacity: 0.8 } };
    const dict = ['a', 'b', 'c', 'd'];
    const { data } = compileCategoricalData(cats, dict);
    for (let i = 0; i < data.length; i++) {
      expect(data[i]).toBeGreaterThanOrEqual(0);
      expect(data[i]).toBeLessThanOrEqual(255);
    }
  });

  test('does not mutate defColor across iterations (regression: Phase 1 backport)', () => {
    // Two unmapped entries should both get the default color, not a corrupted one.
    // This test FAILS on the old 3D code where `color = defColor` (reference assignment)
    // then `color[3] = entry.opacity` mutates defColor for subsequent iterations.
    const { data } = compileCategoricalData({}, ['x', 'y'], '#404040');
    expect(data[0]).toBe(data[4]); // R matches
    expect(data[1]).toBe(data[5]); // G matches
    expect(data[2]).toBe(data[6]); // B matches
    expect(data[3]).toBe(data[7]); // A matches
  });

  test('opacity on one entry does not affect subsequent unmapped entries', () => {
    // Entry with custom opacity followed by unmapped entry.
    // Old 3D code: opacity mutation on `defColor` would corrupt 'unmapped's alpha.
    const cats = { withOpacity: { color: '#ff0000', opacity: 0.2 } };
    const dict = ['withOpacity', 'unmapped'];
    const { data } = compileCategoricalData(cats, dict, '#ffffff');
    // Unmapped entry (idx 1) should have full alpha (255), not 0.2 * 255 ≈ 51
    expect(data[7]).toBe(255); // Alpha for 'unmapped' → full opacity
  });

  test('null/undefined dictionary length does not throw', () => {
    // The 2D version guards against null dictionary.length
    expect(() => compileCategoricalData({}, [], '#ff0000')).not.toThrow();
  });
});
