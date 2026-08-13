/**
 * GFBPointAdapter.test.mjs — pure hit-test core for CPU screen-space GFB picking.
 * Run: node --test lib/packages/core/src/picking/GFBPointAdapter.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  GFBPointAdapter,
  resolveEpoch,
  readInterpolatedPosition,
  pickNearestPoint,
} from './GFBPointAdapter.js';
import { packRGBA32F_deinterleaved } from '../layers/GFBDecoder.js';
import { projectToScreen } from '../math/globeGeo.js';
import * as mat4 from '../math/mat4.js';
import { buildPickPayload } from './PickController.js';
import { normalizeFields } from './PopupFields.js';

describe('resolveEpoch', () => {
  it('single-epoch (static) data pins to epoch 0', () => {
    assert.deepEqual(resolveEpoch(0.7, 1), { e0: 0, e1: 0, frac: 0, nearest: 0 });
  });
  it('interpolates between bracketing epochs', () => {
    const r = resolveEpoch(0.6, 5); // g = 2.4
    assert.equal(r.e0, 2);
    assert.equal(r.e1, 3);
    assert.equal(r.nearest, 2);
    assert.ok(Math.abs(r.frac - 0.4) < 1e-9, `frac ${r.frac} ≈ 0.4`);
  });
  it('rounds nearest up past the half-epoch', () => {
    assert.equal(resolveEpoch(0.7, 5).nearest, 3); // g = 2.8
  });
  it('clamps at the end (e1 does not exceed last epoch)', () => {
    assert.deepEqual(resolveEpoch(1, 5), { e0: 4, e1: 4, frac: 0, nearest: 4 });
  });
  it('clamps normalizedTime below 0 (frac 0 → resolves to epoch 0)', () => {
    assert.deepEqual(resolveEpoch(-1, 5), { e0: 0, e1: 1, frac: 0, nearest: 0 });
  });
});

describe('readInterpolatedPosition', () => {
  // texelsPerEpoch = 1; epoch0 feat0 = [10,20,100], epoch1 feat0 = [30,40,200]
  const packed = new Float32Array([10, 20, 100, 0, 30, 40, 200, 0]);
  it('reads the exact epoch when frac is 0', () => {
    assert.deepEqual(readInterpolatedPosition(packed, 1, 0, 0, 1, 0), {
      lng: 10,
      lat: 20,
      alt: 100,
    });
  });
  it('linearly interpolates lng/lat/alt', () => {
    const p = readInterpolatedPosition(packed, 1, 0, 0, 1, 0.5);
    assert.equal(p.lng, 20);
    assert.equal(p.lat, 30);
    assert.equal(p.alt, 150);
  });
});

describe('pickNearestPoint', () => {
  // 4 points at lng 0,1,2,3 → project to sx 0,10,20,30 (sy 100)
  const base = {
    sy: 100,
    featureCount: 4,
    radiusPx: 12,
    getPoint: (i) => ({ lng: i, lat: 0, alt: 0 }),
    project: (lng) => ({ sx: lng * 10, sy: 100, visible: true }),
  };

  it('returns the nearest point within the pixel radius', () => {
    const hit = pickNearestPoint({ ...base, sx: 21 });
    assert.equal(hit.featureIndex, 2); // sx 20, dist 1
  });

  it('returns null when nothing is within radius', () => {
    const hit = pickNearestPoint({ ...base, sx: 200 });
    assert.equal(hit, null);
  });

  it('skips points that fail the visibility (horizon) check', () => {
    const project = (lng) => ({ sx: lng * 10, sy: 100, visible: lng !== 2 });
    const hit = pickNearestPoint({ ...base, sx: 21, project });
    assert.equal(hit.featureIndex, 3); // idx2 hidden → idx3 (sx 30, dist 9 ≤ 12)
  });

  it('skips points with no geometry', () => {
    const getPoint = (i) => (i === 2 ? null : { lng: i, lat: 0, alt: 0 });
    const hit = pickNearestPoint({ ...base, sx: 21, getPoint });
    assert.equal(hit.featureIndex, 3);
  });
});

// ─── Integration: full adapter chain with real projection math ────────────────
// Substitutes for a browser drive (engine is WebGPU-only; headless has no WebGPU).
// Exercises data-provider → interpolation → camera.project (real globeGeo) →
// nearest-point → materialization → payload composition.

describe('GFBPointAdapter integration', () => {
  const W = 800,
    H = 600,
    EYE = [0, 0, 3];

  function fakeEngine(data, normalized = 0) {
    const viewMatrix = mat4.lookAt(mat4.create(), EYE, [0, 0, 0], [0, 1, 0]);
    const projMatrix = mat4.perspective(mat4.create(), Math.PI / 4, W / H, 0.1, 100);
    const camera = {
      project: (lat, lon, alt, w, h) =>
        projectToScreen(lat, lon, alt, {
          viewMatrix,
          projMatrix,
          cameraPosition: EYE,
          width: w,
          height: h,
        }),
    };
    const engine = {
      canvas: { clientWidth: W, clientHeight: H },
      time: { getNormalized: () => normalized },
      layerManager: { layers: new Map([['L', { data }]]) },
    };
    return { engine, camera };
  }

  // Two static points: feature0 at lon -180 (front, sub-camera), feature1 at lon 0 (far side).
  function staticData() {
    const packed = packRGBA32F_deinterleaved([-180, 0], [0, 0], null, 2, 1);
    return {
      featureCount: 2,
      epochCount: 1,
      geometry: { packedPositions: packed, floatsPerPos: 2 },
      staticColumns: { operator_idx: new Uint32Array([0, 1]) },
      temporalColumns: {},
      dictionaries: { operator_idx: ['GlobeTrotter', 'SES'] },
      entityKey: { name: 'target_id', type: 4 },
      entityIds: new Uint32Array([111, 222]),
    };
  }

  it('picks the front point at screen center and skips the far-side point', () => {
    const { engine, camera } = fakeEngine(staticData());
    const adapter = new GFBPointAdapter({ engine, layerName: 'L' });
    const hit = adapter.pick({ sx: W / 2, sy: H / 2, camera });
    assert.equal(hit.featureIndex, 0);
  });

  it('returns null when the cursor is far from every point', () => {
    const { engine, camera } = fakeEngine(staticData());
    const adapter = new GFBPointAdapter({ engine, layerName: 'L' });
    assert.equal(adapter.pick({ sx: 10, sy: 10, camera }), null);
  });

  it('materializes entity id + dictionary label into popup rows', () => {
    const { engine } = fakeEngine(staticData());
    const adapter = new GFBPointAdapter({ engine, layerName: 'L' });
    const props = adapter.getProperties(0);
    assert.equal(props.target_id, 111);
    assert.equal(props.operator_idx, 0);

    const fields = normalizeFields([
      { name: 'target_id', label: 'Sat ID' },
      { name: 'operator_idx', label: 'Operator' },
    ]);
    const payload = buildPickPayload({
      layerName: 'L',
      featureIndex: 0,
      properties: props,
      popupFields: fields,
      decode: adapter.decode,
    });
    assert.deepEqual(payload.rows, [
      { label: 'Sat ID', value: '111' },
      { label: 'Operator', value: 'GlobeTrotter' },
    ]);
  });

  it('tracks a moving point across epochs (picks by interpolated position)', () => {
    // feature0 moves lon -180 → -150 over 2 epochs; at t=1 it sits off-center.
    const packed = packRGBA32F_deinterleaved([-180, 0, -150, 0], [0, 0, 0, 0], null, 2, 2);
    const data = {
      featureCount: 2,
      epochCount: 2,
      geometry: { packedPositions: packed, floatsPerPos: 2 },
      staticColumns: {},
      temporalColumns: {},
      dictionaries: {},
    };
    // At t=1 feature0 is at lon -150 → projects right of center.
    const { engine, camera } = fakeEngine(data, 1);
    const adapter = new GFBPointAdapter({ engine, layerName: 'L' });
    const screen = camera.project(0, -150, 0, W, H);
    const hit = adapter.pick({ sx: screen.sx, sy: screen.sy, camera });
    assert.equal(hit.featureIndex, 0);
    // The old epoch-0 position (center) should no longer pick feature0.
    assert.equal(adapter.pick({ sx: W / 2, sy: H / 2, camera }), null);
  });
});
