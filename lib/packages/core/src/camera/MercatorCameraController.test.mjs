/**
 * MercatorCameraController.test.mjs — regression tests for the Mercator camera.
 * Run: node --test lib/packages/core/src/camera/MercatorCameraController.test.mjs
 *
 * Covers bugs fixed after browser-based root-cause analysis:
 *   Bug 1: point popups didn't work in Mercator because the controller had no
 *          project() method (GFBPointAdapter early-returns when cam.project is
 *          absent). project() must exist and be the inverse of screenToLngLat.
 *   Bug 4: zooming out revealed white void because _effectiveMinZoom computed
 *          in CSS pixels while the renderer uses device pixels — at DPR>1 the
 *          world could shrink below the viewport. Min zoom must keep the world
 *          >= viewport in device pixels, and world copies must be on by default.
 */

import { describe, it, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { MercatorCameraController } from './MercatorCameraController.js';

// ─── Minimal DOM mocks (node test runner) ─────────────────────────────────────
beforeAll(() => {
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
  }
});

/** Canvas mock with independent CSS (client*) and device (width/height) sizes. */
function makeCanvas(cssW, cssH, dpr = 1) {
  return {
    clientWidth: cssW,
    clientHeight: cssH,
    width: Math.round(cssW * dpr),
    height: Math.round(cssH * dpr),
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssW, height: cssH }),
  };
}

const TILE_PX = 256;

describe('MercatorCameraController — Bug 4: world copies + void prevention', () => {
  it('renderWorldCopies defaults to true', () => {
    const cam = new MercatorCameraController(makeCanvas(1280, 720), { center: [0, 0] });
    assert.equal(cam.renderWorldCopies, true);
  });

  it('caller can still opt out of world copies', () => {
    const cam = new MercatorCameraController(makeCanvas(1280, 720), {
      center: [0, 0],
      renderWorldCopies: false,
    });
    assert.equal(cam.renderWorldCopies, false);
  });

  for (const dpr of [1, 2, 3]) {
    it(`min zoom keeps world >= viewport height at DPR=${dpr} (no vertical void)`, () => {
      const cam = new MercatorCameraController(makeCanvas(1280, 720, dpr), { center: [0, 0] });
      for (let i = 0; i < 20; i++) cam.zoom_by(-1); // zoom way out
      const worldSize = TILE_PX * Math.pow(2, cam.zoom);
      assert.ok(
        worldSize >= cam.canvas.height - 1e-6,
        `worldSize ${worldSize} < device height ${cam.canvas.height}`
      );
    });
  }

  it('single-world mode min zoom fills the wider axis at DPR=2', () => {
    const cam = new MercatorCameraController(makeCanvas(1280, 720, 2), {
      center: [0, 0],
      renderWorldCopies: false,
    });
    for (let i = 0; i < 20; i++) cam.zoom_by(-1);
    const worldSize = TILE_PX * Math.pow(2, cam.zoom);
    assert.ok(worldSize >= Math.max(cam.canvas.width, cam.canvas.height) - 1e-6);
  });
});

describe('MercatorCameraController — Bug 1: project() round-trips with screenToLngLat', () => {
  for (const dpr of [1, 2]) {
    it(`project → screenToLngLat is identity at DPR=${dpr}`, () => {
      const cssW = 1280,
        cssH = 720;
      const cam = new MercatorCameraController(makeCanvas(cssW, cssH, dpr), {
        center: [37, -100],
        altitude: 3000,
      });
      const lat = 40,
        lon = -95;
      const s = cam.project(lat, lon, 0, cssW, cssH);
      assert.ok(Number.isFinite(s.sx) && Number.isFinite(s.sy));
      const geo = cam.screenToLngLat(s.sx, s.sy); // pointer pipeline supplies CSS px
      assert.ok(Math.abs(geo.lng - lon) < 1e-3, `lng ${geo.lng} != ${lon}`);
      assert.ok(Math.abs(geo.lat - lat) < 1e-3, `lat ${geo.lat} != ${lat}`);
    });
  }

  it('a point at the view centre projects to the viewport centre (CSS px)', () => {
    const cssW = 1000,
      cssH = 800;
    const cam = new MercatorCameraController(makeCanvas(cssW, cssH, 2), {
      center: [25, 10],
      altitude: 3000,
    });
    const s = cam.project(cam.lat, cam.lng, 0, cssW, cssH);
    assert.ok(Math.abs(s.sx - cssW / 2) < 1e-3);
    assert.ok(Math.abs(s.sy - cssH / 2) < 1e-3);
  });

  it('project() exists (GFBPointAdapter requires it for Mercator picking)', () => {
    const cam = new MercatorCameraController(makeCanvas(800, 600), { center: [0, 0] });
    assert.equal(typeof cam.project, 'function');
  });
});
