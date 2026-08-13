/**
 * vec3.test.mjs — Characterization tests for 3-component vector math (B-2).
 * Run: node --test src/math/vec3.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as vec3 from './vec3.js';

const EPS = 1e-6;
function close(a, b, eps = EPS) {
  assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (±${eps})`);
}
function closeVec(v, expected, eps = EPS) {
  for (let i = 0; i < 3; i++) close(v[i], expected[i], eps);
}

describe('vec3 construction', () => {
  it('create defaults to zero, fromValues sets components', () => {
    closeVec(vec3.create(), [0, 0, 0]);
    closeVec(vec3.fromValues(1, 2, 3), [1, 2, 3]);
  });
});

describe('vec3 arithmetic', () => {
  it('add / subtract / scale', () => {
    const out = vec3.create();
    closeVec(vec3.add(out, [1, 2, 3], [4, 5, 6]), [5, 7, 9]);
    closeVec(vec3.subtract(out, [4, 5, 6], [1, 2, 3]), [3, 3, 3]);
    closeVec(vec3.scale(out, [1, 2, 3], 2), [2, 4, 6]);
  });
  it('negate / lerp / distance', () => {
    const out = vec3.create();
    closeVec(vec3.negate(out, [1, -2, 3]), [-1, 2, -3]);
    closeVec(vec3.lerp(out, [0, 0, 0], [10, 20, 30], 0.5), [5, 10, 15]);
    close(vec3.distance([0, 0, 0], [3, 4, 0]), 5);
  });
});

describe('vec3 products', () => {
  it('dot product', () => {
    close(vec3.dot([1, 2, 3], [4, 5, 6]), 32);
  });
  it('cross product follows right-hand rule (x × y = z)', () => {
    closeVec(vec3.cross(vec3.create(), [1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  });
});

describe('vec3 length / normalize', () => {
  it('length of a 3-4-5 vector', () => {
    close(vec3.length([3, 4, 0]), 5);
  });
  it('normalize yields a unit vector in the same direction', () => {
    const out = vec3.normalize(vec3.create(), [3, 4, 0]);
    closeVec(out, [0.6, 0.8, 0]);
    close(vec3.length(out), 1);
  });
  it('normalize of a near-zero vector leaves out untouched', () => {
    const out = vec3.fromValues(9, 9, 9);
    vec3.normalize(out, [0, 0, 0]);
    closeVec(out, [9, 9, 9]); // guard: len <= 1e-6 → no write
  });
});
