/**
 * CategoricalCompiler.test.mjs — Characterization tests for category→color LUTs (B-3c).
 * Run: node --test src/styles/CategoricalCompiler.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { compileCategoricalData } from './CategoricalCompiler.js';

describe('compileCategoricalData', () => {
  it('maps dictionary index → color, in dictionary order', () => {
    const { data, width } = compileCategoricalData(
      { CONUS: '#ff0000', EMEA: { color: '#00ff00', opacity: 0.5 } },
      ['CONUS', 'EMEA', 'OTHER'],
      '#999999'
    );
    assert.equal(width, 3);
    assert.equal(data.length, 12);
    assert.deepEqual([...data.slice(0, 4)], [255, 0, 0, 255]); // CONUS
    assert.deepEqual([...data.slice(4, 7)], [0, 255, 0]); // EMEA rgb
    assert.ok(Math.abs(data[7] - 128) <= 1); // EMEA opacity 0.5
    assert.deepEqual([...data.slice(8, 12)], [153, 153, 153, 255]); // OTHER → default #999999
  });

  it('uses the first color of a branding array', () => {
    const { data } = compileCategoricalData({ X: ['#0000ff', '#ffffff'] }, ['X']);
    assert.deepEqual([...data.slice(0, 4)], [0, 0, 255, 255]);
  });

  it('clamps width to 1 for an empty dictionary', () => {
    const { data, width } = compileCategoricalData({}, []);
    assert.equal(width, 1);
    assert.equal(data.length, 4);
  });
});
