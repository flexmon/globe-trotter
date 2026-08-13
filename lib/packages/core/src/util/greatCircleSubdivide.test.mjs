/**
 * greatCircleSubdivide.test.mjs — Tests for spherical triangle subdivision (C-0).
 * Run: node --test src/util/greatCircleSubdivide.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { subdivideTriangles } from './greatCircleSubdivide.js';

describe('subdivideTriangles — passthrough', () => {
  it('returns the original arrays untouched when all edges ≤ 2°', () => {
    const coords = new Float32Array([0, 0, 1, 0, 0, 1]); // edges 1, √2, 1 — all < 2°
    const triangles = new Uint32Array([0, 1, 2]);
    const values = new Float32Array([10, 20, 30]);
    const feat = new Uint32Array([0, 0, 0]);
    const out = subdivideTriangles(coords, 2, triangles, values, feat);
    assert.equal(out.coords, coords); // same reference — no work done
    assert.equal(out.triangles, triangles);
    assert.equal(out.values, values);
    assert.equal(out.featureForVertex, feat);
  });
});

describe('subdivideTriangles — large triangle is split', () => {
  // 10°×10° right triangle: every edge exceeds the 2° threshold.
  const coords = new Float32Array([0, 0, 10, 0, 0, 10]);
  const triangles = new Uint32Array([0, 1, 2]);
  const values = new Float32Array([0, 100, 200]);
  const feat = new Uint32Array([7, 7, 7]);
  const out = subdivideTriangles(coords, 2, triangles, values, feat);

  it('produces more vertices and more triangles', () => {
    assert.ok(out.coords.length / 2 > 3, 'vertices added');
    assert.ok(out.triangles.length > 3, 'triangles added');
    assert.equal(out.triangles.length % 3, 0);
  });
  it('interpolates values within the original range', () => {
    for (const v of out.values) assert.ok(v >= 0 && v <= 200, `value ${v} in [0,200]`);
  });
  it('midpoint vertices inherit the feature index', () => {
    for (const f of out.featureForVertex) assert.equal(f, 7);
  });
  it('all vertices stay within the triangle bounding box', () => {
    for (let i = 0; i < out.coords.length / 2; i++) {
      const lon = out.coords[i * 2],
        lat = out.coords[i * 2 + 1];
      assert.ok(lon >= 0 && lon <= 10, `lon ${lon} in [0,10]`);
      assert.ok(lat >= 0 && lat <= 10, `lat ${lat} in [0,10]`);
    }
  });
  it('uses Uint16 indices for small vertex counts', () => {
    assert.equal(out.triangles.constructor, Uint16Array);
  });
});

describe('subdivideTriangles — adaptive depth cap', () => {
  // A near-hemisphere triangle (edges up to ~180°) — e.g. from a world-mask
  // polygon. It must recurse well past the normal depth-3 cap (max 4^3 = 64
  // sub-triangles) so it hugs the sphere instead of cutting coarse chords.
  it('lets a world-spanning triangle subdivide deeply (> normal cap)', () => {
    const coords = new Float32Array([-170, 0, 170, 0, 0, 85]);
    const triangles = new Uint32Array([0, 1, 2]);
    const out = subdivideTriangles(coords, 2, triangles, new Float32Array(3), new Uint32Array(3));
    assert.ok(
      out.triangles.length / 3 > 64,
      `expected > 64 sub-triangles for a 340°-wide triangle, got ${out.triangles.length / 3}`
    );
  });

  // A merely-wide triangle (well under the "big" threshold) must stay at the
  // cheap normal cap so a layer of thousands of such polygons cannot explode
  // the midpoint cache (regression: MAX_DEPTH=7 everywhere overflowed the Map).
  it('keeps a moderately-wide triangle bounded at the normal cap (≤ 4^3)', () => {
    const coords = new Float32Array([0, 0, 40, 0, 0, 40]); // 40° edges — big but not mask-scale
    const triangles = new Uint32Array([0, 1, 2]);
    const out = subdivideTriangles(coords, 2, triangles, new Float32Array(3), new Uint32Array(3));
    assert.ok(
      out.triangles.length / 3 <= 64,
      `expected ≤ 64 sub-triangles (normal depth 3), got ${out.triangles.length / 3}`
    );
  });
});

describe('subdivideTriangles — fpp=3 (altitude) passthrough', () => {
  it('preserves a small triangle with lon/lat/alt vertices', () => {
    const coords = new Float32Array([0, 0, 5, 1, 0, 5, 0, 1, 5]); // 3 verts × 3
    const triangles = new Uint32Array([0, 1, 2]);
    const out = subdivideTriangles(
      coords,
      3,
      triangles,
      new Float32Array([1, 2, 3]),
      new Uint32Array([0, 0, 0])
    );
    assert.equal(out.coords, coords); // unchanged
  });
});
