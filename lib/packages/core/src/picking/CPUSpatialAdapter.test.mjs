/**
 * CPUSpatialAdapter.test.mjs — GeoJSON CPU picking adapter over SpatialIndex.
 * Run: node --test lib/packages/core/src/picking/CPUSpatialAdapter.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { CPUSpatialAdapter } from './CPUSpatialAdapter.js';
import { buildPickPayload } from './PickController.js';
import { normalizeFields } from './PopupFields.js';

function pointsData() {
  // Two points: A at (0,0), B at (10,10). packedPositions stride = 4 (lng,lat,_,_).
  return {
    featureCount: 2,
    geometry: { packedPositions: new Float64Array([0, 0, 0, 0, 10, 10, 0, 0]) },
    _featureStore: [
      { properties: { name: 'A' }, geometry: { type: 'Point', coordinates: [0, 0] } },
      { properties: { name: 'B' }, geometry: { type: 'Point', coordinates: [10, 10] } },
    ],
  };
}

describe('CPUSpatialAdapter (points)', () => {
  it('picks the nearest feature index at the cursor geo', () => {
    const a = new CPUSpatialAdapter(pointsData(), 'points');
    const hit = a.pick({ geo: { lng: 0, lat: 0 } });
    assert.equal(hit.featureIndex, 0);
  });

  it('returns null when nothing is within tolerance', () => {
    const a = new CPUSpatialAdapter(pointsData(), 'points');
    assert.equal(a.pick({ geo: { lng: 50, lat: 50 } }), null);
  });

  it('returns null when the cursor is off-globe (no geo)', () => {
    const a = new CPUSpatialAdapter(pointsData(), 'points');
    assert.equal(a.pick({ geo: null }), null);
  });

  it('materializes properties by feature index', () => {
    const a = new CPUSpatialAdapter(pointsData(), 'points');
    assert.deepEqual(a.getProperties(1), { name: 'B' });
    assert.deepEqual(a.getProperties(99), {});
  });

  it('composes with popupFields into structured rows (configured GeoJSON popup)', () => {
    const a = new CPUSpatialAdapter(pointsData(), 'points');
    const props = a.getProperties(1);
    const payload = buildPickPayload({
      layerName: 'Places',
      featureIndex: 1,
      properties: props,
      popupFields: normalizeFields([{ name: 'name', label: 'Name' }]),
    });
    assert.deepEqual(payload.rows, [{ label: 'Name', value: 'B' }]);
    assert.equal(payload.title, 'Places');
  });
});

// ─── Overlapping polygons: pick the most specific (smallest) one ──────────────
// A world-spanning mask polygon overlaps a small coverage cell; clicking inside
// the cell must return the cell, not the mask that also contains the point.
function overlappingPolygonsData() {
  const worldMask = {
    type: 'Polygon',
    coordinates: [
      [
        [-180, -90],
        [180, -90],
        [180, 90],
        [-180, 90],
        [-180, -90],
      ],
    ],
  };
  const smallCell = {
    type: 'Polygon',
    coordinates: [
      [
        [-101, 39],
        [-99, 39],
        [-99, 41],
        [-101, 41],
        [-101, 39],
      ],
    ],
  };
  return {
    featureCount: 2,
    _featureStore: [
      { properties: { name: 'world-mask' }, geometry: worldMask },
      { properties: { name: 'cell' }, geometry: smallCell },
    ],
  };
}

describe('CPUSpatialAdapter (polygons) — overlap resolution', () => {
  it('returns the smallest containing polygon when polygons overlap', () => {
    const a = new CPUSpatialAdapter(overlappingPolygonsData(), 'polygons');
    const hit = a.pick({ geo: { lng: -100, lat: 40 } });
    assert.equal(hit.featureIndex, 1); // the small cell, not the world mask
    assert.equal(a.getProperties(hit.featureIndex).name, 'cell');
  });

  it('falls back to the mask outside the small cell', () => {
    const a = new CPUSpatialAdapter(overlappingPolygonsData(), 'polygons');
    const hit = a.pick({ geo: { lng: 20, lat: 10 } });
    assert.equal(hit.featureIndex, 0); // only the world mask contains this point
  });
});
