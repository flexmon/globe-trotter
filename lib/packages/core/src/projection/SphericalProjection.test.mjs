/**
 * SphericalProjection.test.mjs — Contract tests for SphericalProjection (D-1).
 * Run: node --test src/projection/SphericalProjection.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { SphericalProjection } from './SphericalProjection.js';

describe('SphericalProjection — preBake is identity', () => {
  const proj = new SphericalProjection();

  it('returns coords and indices unchanged (no transformation)', () => {
    const coords = new Float32Array([0, 0, 10, 0, 5, 10]);
    const indices = new Uint32Array([0, 1, 2]);
    const result = proj.preBake(coords, 2, indices);

    // Identity: coords and indices are the exact same reference
    assert.strictEqual(result.coords, coords);
    assert.strictEqual(result.indices, indices);
  });

  it('passes through additional opts unchanged', () => {
    const coords = new Float32Array([0, 0, 10, 0, 5, 10]);
    const indices = new Uint32Array([0, 1, 2]);
    const values = new Float32Array([11, 22, 33]);
    const visibility = new Float32Array([1, 1, 1]);

    const result = proj.preBake(coords, 2, indices, { values, visibility });

    assert.strictEqual(result.coords, coords);
    assert.strictEqual(result.indices, indices);
    assert.strictEqual(result.values, values);
    assert.strictEqual(result.visibility, visibility);
  });
});

describe('SphericalProjection — mode accessor', () => {
  it('returns "spherical"', () => {
    const proj = new SphericalProjection();
    assert.equal(proj.mode, 'spherical');
  });
});
