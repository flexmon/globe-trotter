/**
 * RampCompiler.test.mjs — Characterization tests for color-ramp compilation (B-3c).
 * Run: node --test src/styles/RampCompiler.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseColor, compileRampData } from './RampCompiler.js';

describe('parseColor', () => {
  it('parses 6-char hex (with and without #)', () => {
    assert.deepEqual(parseColor('#ff0000'), [1, 0, 0, 1]);
    assert.deepEqual(parseColor('00ff00'), [0, 1, 0, 1]);
  });
  it('parses 3-char shorthand', () => {
    assert.deepEqual(parseColor('#f00'), [1, 0, 0, 1]);
  });
  it('parses 8-char hex with alpha', () => {
    const c = parseColor('#ffffff80');
    assert.deepEqual(c.slice(0, 3), [1, 1, 1]);
    assert.ok(Math.abs(c[3] - 128 / 255) < 1e-9);
  });
  it('returns magenta for invalid input', () => {
    assert.deepEqual(parseColor(''), [1, 0, 1, 1]);
    assert.deepEqual(parseColor('nothex'), [1, 0, 1, 1]);
    assert.deepEqual(parseColor(null), [1, 0, 1, 1]);
  });
});

describe('compileRampData', () => {
  it('produces a 256×4 RGBA byte array', () => {
    const data = compileRampData(
      [
        { value: 0, color: '#000000' },
        { value: 100, color: '#ffffff' },
      ],
      [0, 100]
    );
    assert.ok(data instanceof Uint8Array);
    assert.equal(data.length, 256 * 4);
  });

  it('interpolates black→white across the domain', () => {
    const data = compileRampData(
      [
        { value: 0, color: '#000000' },
        { value: 100, color: '#ffffff' },
      ],
      [0, 100]
    );
    // first texel ≈ black, last ≈ white, middle ≈ mid-gray
    assert.deepEqual([...data.slice(0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...data.slice(255 * 4, 255 * 4 + 4)], [255, 255, 255, 255]);
    assert.ok(Math.abs(data[128 * 4] - 128) <= 2);
  });

  it('is transparent below the first stop', () => {
    const data = compileRampData(
      [
        { value: 50, color: '#ffffff' },
        { value: 100, color: '#ffffff' },
      ],
      [0, 100]
    );
    assert.equal(data[3], 0); // alpha at texel 0 (t=0 < first stop t=0.5)
  });

  it('applies graduated opacity stops to the alpha channel', () => {
    const data = compileRampData(
      [
        { value: 0, color: '#ffffff' },
        { value: 100, color: '#ffffff' },
      ],
      [0, 100],
      [
        { value: 0, opacity: 0 },
        { value: 100, opacity: 1 },
      ]
    );
    assert.equal(data[3], 0); // alpha 0 at t=0
    assert.equal(data[255 * 4 + 3], 255); // alpha 1 at t=1
    assert.ok(Math.abs(data[128 * 4 + 3] - 128) <= 2); // ~0.5 mid
  });
});
