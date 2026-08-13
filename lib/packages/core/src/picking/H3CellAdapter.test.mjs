/**
 * H3CellAdapter.test.mjs — CPU H3F cell picking (screen lat/lon → h3 cell → row).
 * Run: node --test lib/packages/core/src/picking/H3CellAdapter.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { latLngToCell } from 'h3-js';
import { H3CellAdapter, buildCellIndex, deriveResolution, lookupCellRow } from './H3CellAdapter.js';

// Two real H3 cells at resolution 5.
const RES = 5;
const A = { lat: 37.5, lng: -122.0 };
const B = { lat: 40.0, lng: -74.0 };
function cellIdsFor(...pts) {
  return new BigUint64Array(pts.map((p) => BigInt('0x' + latLngToCell(p.lat, p.lng, RES))));
}

describe('buildCellIndex', () => {
  it('maps each cell id (bigint) to its row index', () => {
    const ids = cellIdsFor(A, B);
    const idx = buildCellIndex(ids);
    assert.equal(idx.get(ids[0]), 0);
    assert.equal(idx.get(ids[1]), 1);
    assert.equal(idx.size, 2);
  });
  it('returns an empty map for missing cellIds', () => {
    assert.equal(buildCellIndex(null).size, 0);
  });
});

describe('deriveResolution', () => {
  it('reads the resolution from the first cell id', () => {
    assert.equal(deriveResolution(cellIdsFor(A)), RES);
  });
  it('returns -1 for empty cellIds', () => {
    assert.equal(deriveResolution(new BigUint64Array(0)), -1);
  });
});

describe('lookupCellRow', () => {
  const ids = cellIdsFor(A, B);
  const idx = buildCellIndex(ids);
  it('resolves a lat/lon inside a cell to its row', () => {
    assert.equal(lookupCellRow(A.lat, A.lng, RES, idx), 0);
    assert.equal(lookupCellRow(B.lat, B.lng, RES, idx), 1);
  });
  it('returns -1 for a lat/lon in no dataset cell', () => {
    assert.equal(lookupCellRow(0, 0, RES, idx), -1);
  });
  it('returns -1 when resolution is invalid', () => {
    assert.equal(lookupCellRow(A.lat, A.lng, -1, idx), -1);
  });
});

describe('H3CellAdapter integration', () => {
  function fakeEngine(data, normalized = 0) {
    return {
      canvas: { clientWidth: 800, clientHeight: 600 },
      time: { getNormalized: () => normalized },
      layerManager: { layers: new Map([['H', { data }]]) },
    };
  }
  function h3Data() {
    return {
      cellIds: cellIdsFor(A, B),
      epochCount: 1,
      dataCount: 2,
      cellCount: 2,
      staticColumns: { demand: new Float32Array([42, 99]) },
      temporalColumns: {},
      dictionaries: {},
    };
  }

  it('picks the cell under the cursor lat/lon', () => {
    const adapter = new H3CellAdapter({ engine: fakeEngine(h3Data()), layerName: 'H' });
    const hit = adapter.pick({ geo: { lat: A.lat, lng: A.lng } });
    assert.equal(hit.featureIndex, 0);
    const hitB = adapter.pick({ geo: { lat: B.lat, lng: B.lng } });
    assert.equal(hitB.featureIndex, 1);
  });

  it('returns null off any cell or with no geo', () => {
    const adapter = new H3CellAdapter({ engine: fakeEngine(h3Data()), layerName: 'H' });
    assert.equal(adapter.pick({ geo: { lat: 0, lng: 0 } }), null);
    assert.equal(adapter.pick({ geo: null }), null);
  });

  it('materializes the row properties', () => {
    const adapter = new H3CellAdapter({ engine: fakeEngine(h3Data()), layerName: 'H' });
    assert.equal(adapter.getProperties(1).demand, 99);
  });
});
