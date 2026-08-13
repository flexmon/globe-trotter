/**
 * mat4.test.mjs — Characterization tests for the 4x4 matrix math (B-2).
 * Column-major Float32Array[16]. Locks in current behavior before refactors.
 * Run: node --test src/math/mat4.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as mat4 from './mat4.js';

const EPS = 1e-5; // Float32Array storage precision

function assertMat(actual, expected, eps = EPS) {
  assert.equal(actual.length, 16);
  for (let i = 0; i < 16; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= eps,
      `index ${i}: ${actual[i]} != ${expected[i]} (±${eps})`
    );
  }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('mat4.create / identity', () => {
  it('create returns identity', () => {
    assertMat(mat4.create(), IDENTITY);
  });
  it('identity resets a dirty matrix', () => {
    const m = new Float32Array(16).fill(7);
    assertMat(mat4.identity(m), IDENTITY);
  });
});

describe('mat4.multiply', () => {
  it('identity is the right and left multiplicative identity', () => {
    const a = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const id = mat4.create();
    const out = mat4.create();
    assertMat(mat4.multiply(out, a, id), a);
    assertMat(mat4.multiply(out, id, a), a);
  });
});

describe('mat4.perspective (WebGL NDC z in [-1,1])', () => {
  it('matches closed-form entries for fovY=90°, aspect=1, near=1, far=100', () => {
    const out = mat4.perspective(mat4.create(), Math.PI / 2, 1, 1, 100);
    const nf = 1 / (1 - 100);
    assert.ok(Math.abs(out[0] - 1) <= EPS); // f/aspect, f=1
    assert.ok(Math.abs(out[5] - 1) <= EPS);
    assert.ok(Math.abs(out[10] - 101 * nf) <= EPS); // (far+near)*nf
    assert.ok(Math.abs(out[11] - -1) <= EPS);
    assert.ok(Math.abs(out[14] - 2 * 100 * 1 * nf) <= EPS); // 2*far*near*nf
    assert.equal(out[15], 0);
  });
});

describe('mat4.perspectiveZO (WebGPU NDC z in [0,1] — added in develop merge)', () => {
  it('matches closed-form entries and differs from perspective in z rows', () => {
    const fovY = Math.PI / 2,
      aspect = 1,
      near = 1,
      far = 100;
    const zo = mat4.perspectiveZO(mat4.create(), fovY, aspect, near, far);
    const nf = 1 / (near - far);
    assert.ok(Math.abs(zo[0] - 1) <= EPS);
    assert.ok(Math.abs(zo[5] - 1) <= EPS);
    assert.ok(Math.abs(zo[10] - far * nf) <= EPS); // far*nf, not (far+near)*nf
    assert.ok(Math.abs(zo[11] - -1) <= EPS);
    assert.ok(Math.abs(zo[14] - far * near * nf) <= EPS); // far*near*nf, not 2*far*near*nf
    assert.equal(zo[15], 0);

    const persp = mat4.perspective(mat4.create(), fovY, aspect, near, far);
    assert.ok(Math.abs(zo[10] - persp[10]) > 1e-3, 'z scale must differ from WebGL perspective');
    assert.ok(
      Math.abs(zo[14] - persp[14]) > 1e-3,
      'z translate must differ from WebGL perspective'
    );
  });
});

describe('mat4.rotateY / rotateX', () => {
  it('rotateY by 90° on identity sends +X axis to -Z', () => {
    const out = mat4.rotateY(mat4.create(), mat4.create(), Math.PI / 2);
    // column 0 (the transformed X basis) ≈ (0, 0, -1)
    assert.ok(Math.abs(out[0] - 0) <= EPS);
    assert.ok(Math.abs(out[2] - -1) <= EPS);
    assert.ok(Math.abs(out[8] - 1) <= EPS);
    assert.ok(Math.abs(out[10] - 0) <= EPS);
  });
  it('rotateX by 90° on identity sends +Y axis to +Z', () => {
    const out = mat4.rotateX(mat4.create(), mat4.create(), Math.PI / 2);
    assert.ok(Math.abs(out[5] - 0) <= EPS);
    assert.ok(Math.abs(out[6] - 1) <= EPS);
    assert.ok(Math.abs(out[9] - -1) <= EPS);
    assert.ok(Math.abs(out[10] - 0) <= EPS);
  });
});

describe('mat4.invert', () => {
  it('inverse of a lookAt matrix multiplies back to identity', () => {
    const view = mat4.lookAt(mat4.create(), [3, 4, 5], [0, 0, 0], [0, 1, 0]);
    const inv = mat4.invert(mat4.create(), view);
    assert.ok(inv, 'lookAt is invertible');
    assertMat(mat4.multiply(mat4.create(), view, inv), IDENTITY, 1e-4);
  });
  it('returns null for a singular (all-zero) matrix', () => {
    assert.equal(mat4.invert(mat4.create(), new Float32Array(16)), null);
  });
});
