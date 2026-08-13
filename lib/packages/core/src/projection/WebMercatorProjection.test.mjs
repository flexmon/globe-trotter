/**
 * WebMercatorProjection.test.mjs — Contract tests for WebMercatorProjection (D-2).
 * Run: node --test src/projection/WebMercatorProjection.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { WebMercatorProjection } from './WebMercatorProjection.js';

describe('WebMercatorProjection — preBake delegates to splitMercatorPolygon', () => {
  const proj = new WebMercatorProjection();

  it('passthrough: non-crossing triangle unchanged', () => {
    const coords = new Float32Array([0, 0, 10, 0, 5, 10]);
    const indices = new Uint32Array([0, 1, 2]);
    const result = proj.preBake(coords, 2, indices);

    // No crossing: same vertex count, same triangle count
    assert.equal(result.coords.length, 6); // 3 verts × 2
    assert.deepEqual([...result.indices], [0, 1, 2]);
  });

  it('split: crossing triangle produces two slivers with duplicated vertices', () => {
    // Triangle crossing ±180°: lngs 170, -170, 175 → span 345° > 180°
    const coords = new Float32Array([170, 0, -170, 5, 175, 10]);
    const indices = new Uint32Array([0, 1, 2]);
    const result = proj.preBake(coords, 2, indices);

    // Split: two triangles (6 indices), more vertices
    assert.equal(result.indices.length, 6);
    assert.ok(result.coords.length > 6, 'duplicated vertices added for split slivers');
  });

  it('duplicates per-vertex attributes alongside coords', () => {
    const coords = new Float32Array([170, 0, -170, 5, 175, 10]);
    const indices = new Uint32Array([0, 1, 2]);
    const values = new Float32Array([11, 22, 33]);
    const result = proj.preBake(coords, 2, indices, { values });

    // values array should match the new vertex count
    assert.equal(result.values.length, result.coords.length / 2);
    // parentVertexMap should track which original vertex each split vertex came from
    assert.ok(result.parentVertexMap, 'parentVertexMap present');
  });
});

describe('WebMercatorProjection — mode accessor', () => {
  it('returns "mercator"', () => {
    const proj = new WebMercatorProjection();
    assert.equal(proj.mode, 'mercator');
  });
});
