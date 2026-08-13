/**
 * PickController.test.mjs — adapter registration + pick resolution (DOM-guarded).
 * Run: node --test lib/packages/core/src/picking/PickController.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { PickController, buildPickPayload } from './PickController.js';
import { normalizeGroups } from './PopupFields.js';

function makePC() {
  const canvas = {
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    clientWidth: 800,
    clientHeight: 600,
  };
  const layers = new Map();
  const emitted = [];
  const engine = {
    canvas,
    layerManager: { layers },
    time: {
      t: 0,
      getNormalized() {
        return this.t;
      },
    },
    _emit: (ev, d) => emitted.push({ ev, d }),
  };
  const camera = { _screenToGlobe: () => ({ theta: 0, phi: 0 }) };
  const popup = {
    showHover() {},
    clearHover() {},
    clearPinned() {},
    pinned: [],
    updated: [],
    showPinned(hit) {
      this.pinned.push(hit);
    },
    updatePinned(hit) {
      this.updated.push(hit);
    },
  };
  const pc = new PickController(engine, camera, popup);
  return { pc, layers, emitted, engine, popup };
}

const fixedAdapter = (featureIndex) => ({
  pick: () => (featureIndex == null ? null : { featureIndex }),
});

describe('buildPickPayload', () => {
  it('produces legacy shape when no popupFields', () => {
    const p = buildPickPayload({ layerName: 'L', featureIndex: 2, properties: { a: 1 } });
    assert.equal(p.layerName, 'L');
    assert.equal(p.featureIndex, 2);
    assert.deepEqual(p.properties, { a: 1 });
    assert.equal(p.rows, undefined);
  });

  it('produces structured rows when popupFields present', () => {
    const p = buildPickPayload({
      layerName: 'L',
      featureIndex: 0,
      properties: { name: 'Sat', extra: 9 },
      popupFields: [{ name: 'name', label: 'Name' }],
    });
    assert.deepEqual(p.rows, [{ label: 'Name', value: 'Sat' }]);
    assert.equal(p.title, 'L'); // defaults title to layerName
    assert.deepEqual(p.properties, { name: 'Sat', extra: 9 }); // raw kept for events
  });

  it('uses explicit title when provided', () => {
    const p = buildPickPayload({
      layerName: 'L',
      featureIndex: 0,
      properties: { id: 1 },
      popupFields: [{ name: 'id', label: 'ID' }],
      title: 'Satellite',
    });
    assert.equal(p.title, 'Satellite');
  });

  it('produces grouped sections when popupGroups is present (with layout)', () => {
    const p = buildPickPayload({
      layerName: 'L',
      featureIndex: 0,
      properties: { cap: 80, rl: 20 },
      popupGroups: normalizeGroups([
        { label: 'FL', fields: [{ name: 'cap', label: 'Cap' }] },
        { label: 'RL', fields: [{ name: 'rl', label: 'Cap' }] },
      ]),
      layout: 'grid',
    });
    assert.equal(p.layout, 'grid');
    assert.equal(p.rows, undefined);
    assert.equal(p.sections.length, 2);
    assert.equal(p.sections[0].label, 'FL');
    assert.deepEqual(p.sections[0].rows, [{ label: 'Cap', value: '80' }]);
  });
});

describe('PickController registration', () => {
  it('registers, retrieves, and deregisters layers', () => {
    const { pc } = makePC();
    pc.registerLayer('L', { kind: 'points', hover: true, picker: fixedAdapter(1) });
    assert.ok(pc.getLayer('L'));
    pc.deregisterLayer('L');
    assert.equal(pc.getLayer('L'), undefined);
  });

  it('setLayerPickOptions toggles hover/click', () => {
    const { pc } = makePC();
    pc.registerLayer('L', { kind: 'points', hover: false, click: false, picker: fixedAdapter(1) });
    pc.setLayerPickOptions('L', { hover: true });
    assert.equal(pc.getLayer('L').hover, true);
    assert.equal(pc.getLayer('L').click, false);
  });
});

describe('PickController._pickAt', () => {
  function register(pc, layers, name, opts) {
    pc.registerLayer(name, opts);
    layers.set(name, { visible: true });
  }

  it('returns a hit with the adapter feature index and materialized properties', () => {
    const { pc, layers } = makePC();
    register(pc, layers, 'L', {
      kind: 'points',
      hover: true,
      picker: fixedAdapter(3),
      getProperties: (fi) => ({ id: fi, name: 'X' }),
    });
    const hit = pc._pickAt(10, 10, 'hover');
    assert.equal(hit.layerName, 'L');
    assert.equal(hit.featureIndex, 3);
    assert.deepEqual(hit.properties, { id: 3, name: 'X' });
  });

  it('respects hover/click mode gating', () => {
    const { pc, layers } = makePC();
    register(pc, layers, 'L', {
      kind: 'points',
      hover: false,
      click: true,
      picker: fixedAdapter(0),
      getProperties: () => ({}),
    });
    assert.equal(pc._pickAt(10, 10, 'hover'), null);
    assert.ok(pc._pickAt(10, 10, 'click'));
  });

  it('skips hidden layers', () => {
    const { pc, layers } = makePC();
    pc.registerLayer('L', {
      kind: 'points',
      hover: true,
      picker: fixedAdapter(0),
      getProperties: () => ({}),
    });
    layers.set('L', { visible: false });
    assert.equal(pc._pickAt(10, 10, 'hover'), null);
  });

  it('applies the layer filter predicate against materialized properties', () => {
    const { pc, layers } = makePC();
    register(pc, layers, 'L', {
      kind: 'points',
      hover: true,
      picker: fixedAdapter(0),
      getProperties: () => ({ served: 10 }),
    });
    pc.setLayerFilterFn('L', (props) => props.served > 50);
    assert.equal(pc._pickAt(10, 10, 'hover'), null);
    pc.setLayerFilterFn('L', (props) => props.served > 5);
    assert.ok(pc._pickAt(10, 10, 'hover'));
  });

  it('emits structured rows for layers with popupFields', () => {
    const { pc, layers } = makePC();
    register(pc, layers, 'S', {
      kind: 'points',
      hover: true,
      picker: fixedAdapter(1),
      getProperties: () => ({ name: 'Sat', extra: 9 }),
      popupFields: [{ name: 'name', label: 'Name' }],
    });
    const hit = pc._pickAt(10, 10, 'hover');
    assert.deepEqual(hit.rows, [{ label: 'Name', value: 'Sat' }]);
  });
});

describe('PickController._screenToGeo — longitude convention', () => {
  const DEG2RAD = Math.PI / 180;

  it('converts camera theta ((lon+180)·rad) back to a real longitude', () => {
    const { pc, engine } = makePC();
    // Both cameras return theta in the shader (lon+180) convention. For a
    // point at lon=-100,lat=40 the camera yields theta=(−100+180)·rad.
    engine.camera = {
      _screenToGlobe: () => ({ theta: (-100 + 180) * DEG2RAD, phi: 40 * DEG2RAD }),
    };
    const geo = pc._screenToGeo(10, 10);
    assert.ok(Math.abs(geo.lng - -100) < 1e-6, `lng ${geo.lng} should be -100`);
    assert.ok(Math.abs(geo.lat - 40) < 1e-6, `lat ${geo.lat} should be 40`);
  });

  it('wraps into [-180,180] for eastern longitudes (atan2 gives theta < 0)', () => {
    const { pc, engine } = makePC();
    // Real lon=10 → (lon+180)=190°, which atan2 reports as −170°. The −180
    // conversion then gives −350°, and the wrap restores +10°.
    engine.camera = { _screenToGlobe: () => ({ theta: -170 * DEG2RAD, phi: 0 }) };
    const geo = pc._screenToGeo(10, 10);
    assert.ok(Math.abs(geo.lng - 10) < 1e-6, `lng ${geo.lng} should be 10`);
  });
});

describe('PickController pinned refresh (live time updates)', () => {
  function pinLayer(pc, layers, getVal) {
    pc.registerLayer('L', {
      kind: 'points',
      hover: false,
      click: true,
      picker: fixedAdapter(2),
      getProperties: () => ({ v: getVal() }),
      popupFields: [{ name: 'v', label: 'V' }],
    });
    layers.set('L', { visible: true });
  }

  it('re-materializes pinned data when time changes', () => {
    const { pc, layers, engine, popup } = makePC();
    let val = 10;
    pinLayer(pc, layers, () => val);
    pc._onClick({ clientX: 10, clientY: 10 }); // pin at t=0, v=10
    assert.equal(popup.pinned.length, 1);

    val = 20;
    engine.time.t = 0.5; // time advances, value changes
    pc.tick();
    assert.equal(popup.updated.length, 1);
    assert.deepEqual(popup.updated[0].rows, [{ label: 'V', value: '20' }]);
  });

  it('does not refresh while time is unchanged', () => {
    const { pc, layers, engine, popup } = makePC();
    pinLayer(pc, layers, () => 10);
    pc._onClick({ clientX: 10, clientY: 10 });
    engine.time.t = 0.5;
    pc.tick(); // one refresh
    pc.tick();
    pc.tick(); // same time → no more
    assert.equal(popup.updated.length, 1);
  });

  it('does nothing when no popup is pinned', () => {
    const { pc, engine, popup } = makePC();
    engine.time.t = 0.9;
    pc.tick();
    assert.equal(popup.updated.length, 0);
  });
});
