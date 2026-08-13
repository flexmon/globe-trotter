/**
 * mercatorBake.test.mjs — Characterization tests for antimeridian splitting (B-3a).
 * Run: node --test src/util/mercatorBake.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { splitMercatorPolygon, splitMercatorMesh, computeWorldCopies } from './mercatorBake.js';

// Build a unit-sphere XYZ triple (equator) whose mercatorBake longitude is `lon`.
// xyzToMerc uses lon = atan2(gx,gz)·180/π − 180 (wrapped), so θ = lon + 180.
function xyzAtLon(lon) {
  const th = ((lon + 180) * Math.PI) / 180;
  return [Math.sin(th), 0, Math.cos(th)];
}

describe('splitMercatorPolygon — passthrough (no antimeridian crossing)', () => {
  it('returns original geometry unchanged when lng span ≤ 180°', () => {
    const lngLat = new Float32Array([0, 0, 10, 0, 5, 10]); // span 10°
    const indices = new Uint32Array([0, 1, 2]);
    const out = splitMercatorPolygon(lngLat, 2, indices, {
      values: new Float32Array([11, 22, 33]),
    });

    assert.deepEqual([...out.mercIndices], [0, 1, 2]);
    assert.equal(out.mercPositions.length, 6); // 3 verts × 2, no duplicates
    assert.deepEqual([...out.parentVertexMap], [0, 1, 2]);
    assert.deepEqual([...out.mercValues], [11, 22, 33]);
  });
});

describe('splitMercatorPolygon — split (crosses ±180°)', () => {
  // lngs 170, -170, 175 → span 345° > 180° → east + west slivers.
  const lngLat = new Float32Array([170, 0, -170, 5, 175, 10]);
  const indices = new Uint32Array([0, 1, 2]);
  const out = splitMercatorPolygon(lngLat, 2, indices, { values: new Float32Array([11, 22, 33]) });

  it('emits two triangles (east + west sliver)', () => {
    assert.equal(out.mercIndices.length, 6);
    assert.deepEqual([...out.mercIndices], [0, 3, 2, 4, 1, 5]);
  });
  it('duplicates minority-side vertices at lng ±360', () => {
    // vert3 = east dup of vert1 (-170 + 360 = 190)
    assert.equal(out.mercPositions[3 * 2], 190);
    // vert4 = west dup of vert0 (170 − 360 = −190)
    assert.equal(out.mercPositions[4 * 2], -190);
    // vert5 = west dup of vert2 (175 − 360 = −185)
    assert.equal(out.mercPositions[5 * 2], -185);
  });
  it('parentVertexMap and attribs follow the duplicated vertices', () => {
    assert.deepEqual([...out.parentVertexMap], [0, 1, 2, 1, 0, 2]);
    assert.deepEqual([...out.mercValues], [11, 22, 33, 22, 11, 33]);
  });
});

describe('splitMercatorMesh — XYZ hex mesh', () => {
  it('passes a non-crossing triangle through unchanged', () => {
    const xyz = new Float32Array([...xyzAtLon(-1), ...xyzAtLon(0), ...xyzAtLon(1)]);
    const indices = new Uint32Array([0, 1, 2]);
    const cellIdx = new Float32Array([0, 1, 2]);
    const out = splitMercatorMesh(xyz, indices, cellIdx);

    assert.equal(out.mercIndices.length, 3);
    assert.equal(out.mercPositions.length, 6); // 3 verts × 2
    assert.equal(out.mercCellIndices.length, 3);
  });
  it('splits a triangle straddling the antimeridian into more verts/tris', () => {
    const xyz = new Float32Array([...xyzAtLon(178), ...xyzAtLon(179), ...xyzAtLon(-179)]);
    const indices = new Uint32Array([0, 1, 2]);
    const cellIdx = new Float32Array([0, 1, 2]);
    const out = splitMercatorMesh(xyz, indices, cellIdx);

    assert.equal(out.mercIndices.length, 6); // two slivers
    assert.ok(out.mercPositions.length > 6, 'duplicated vertices added');
    // cellIndices stay parallel to positions (one per Mercator vertex).
    assert.equal(out.mercCellIndices.length, out.mercPositions.length / 2);
  });
});

describe('computeWorldCopies', () => {
  it('collapses to a single world when wrapping is disabled', () => {
    // Even with a viewport far wider than a world, no copies when disabled.
    const r = computeWorldCopies(128, 256, 10000, false);
    assert.deepEqual(r, { firstCopy: 0, copyCount: 1 });
  });

  it('returns one copy when a single world fills the viewport', () => {
    // Camera centered (lng 0 → cameraX = worldSize/2), narrow viewport.
    const r = computeWorldCopies(128, 256, 100, true);
    assert.deepEqual(r, { firstCopy: 0, copyCount: 1 });
  });

  it('returns multiple copies when the viewport spans several worlds', () => {
    // halfW = 300; left edge at -172px → copy -1, right edge at 428px → copy 1.
    const r = computeWorldCopies(128, 256, 600, true);
    assert.deepEqual(r, { firstCopy: -1, copyCount: 3 });
  });

  it('yields a negative firstCopy when the camera sits on the seam', () => {
    // cameraX = 0 (antimeridian): left edge wraps into the previous world.
    const r = computeWorldCopies(0, 256, 100, true);
    assert.deepEqual(r, { firstCopy: -1, copyCount: 2 });
  });

  it('never returns fewer than one copy', () => {
    const r = computeWorldCopies(128, 256, 0, true);
    assert.equal(r.copyCount >= 1, true);
  });
});
