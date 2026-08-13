/**
 * geo.test.mjs — Characterization tests for geographic math (B-2).
 * Unit sphere (radius 1) by default. Run: node --test src/math/geo.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as geo from './geo.js';

function close(a, b, eps) {
  assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (±${eps})`);
}

describe('geo.latLonToCartesian', () => {
  // Convention: x=east(sin lon), y=up(sin lat), z=front(cos lon) on unit sphere.
  it('(0,0) maps to the prime-meridian point (0,0,1)', () => {
    const p = geo.latLonToCartesian(0, 0);
    close(p[0], 0, 1e-6);
    close(p[1], 0, 1e-6);
    close(p[2], 1, 1e-6);
  });
  it('north pole (90,0) maps to (0,1,0)', () => {
    const p = geo.latLonToCartesian(90, 0);
    close(p[0], 0, 1e-6);
    close(p[1], 1, 1e-6);
    close(p[2], 0, 1e-6);
  });
  it('(0,90) maps to (1,0,0)', () => {
    const p = geo.latLonToCartesian(0, 90);
    close(p[0], 1, 1e-6);
    close(p[1], 0, 1e-6);
    close(p[2], 0, 1e-6);
  });
});

describe('geo lat/lon ↔ cartesian round-trip', () => {
  it('survives a round-trip within float32 tolerance', () => {
    const lat = 37.5,
      lon = -122.3;
    const back = geo.cartesianToLatLon(geo.latLonToCartesian(lat, lon));
    close(back.lat, lat, 1e-3);
    close(back.lon, lon, 1e-3);
  });
});

describe('geo.greatCircleDistance (angular radians)', () => {
  it('zero for identical points', () => {
    close(geo.greatCircleDistance(10, 20, 10, 20), 0, 1e-12);
  });
  it('quarter circle from equator-prime-meridian to (0,90) is π/2', () => {
    close(geo.greatCircleDistance(0, 0, 0, 90), Math.PI / 2, 1e-9);
  });
  it('antipodal-on-equator (0,0)→(0,180) is π', () => {
    close(geo.greatCircleDistance(0, 0, 0, 180), Math.PI, 1e-9);
  });
});

describe('geo.greatCircleInterpolate', () => {
  it('endpoints reproduce the input points', () => {
    const a = geo.greatCircleInterpolate(0, 0, 0, 90, 0);
    close(a[0], 0, 1e-6);
    close(a[2], 1, 1e-6);
    const b = geo.greatCircleInterpolate(0, 0, 0, 90, 1);
    close(b[0], 1, 1e-6);
    close(b[2], 0, 1e-6);
  });
  it('midpoint of (0,0)→(0,90) is (0,45)', () => {
    const m = geo.greatCircleInterpolate(0, 0, 0, 90, 0.5);
    const h = Math.SQRT1_2; // cos45 = sin45
    close(m[0], h, 1e-6);
    close(m[1], 0, 1e-6);
    close(m[2], h, 1e-6);
  });
});

describe('geo altitude ↔ zoom', () => {
  it('round-trips altitude through zoom in the valid range', () => {
    const altKm = 10000;
    const z = geo.altitudeToZoom(altKm, 0);
    close(geo.zoomToAltitude(z, 0), altKm, 1e-3);
  });
  it('clamps zoom to [0, 22]', () => {
    assert.equal(geo.altitudeToZoom(1e-9, 0), 22); // tiny altitude → max zoom
    assert.equal(geo.altitudeToZoom(1e12, 0), 0); // huge altitude → min zoom
  });
});
