// tests/geo.test.js — Unit tests for geographic math utilities
import {
  latLonToCartesian,
  cartesianToLatLon,
  greatCircleDistance,
  greatCircleInterpolate,
  generateGreatCircleArc,
  DEG2RAD,
} from '../src/math/geo.js';

describe('latLonToCartesian', () => {
  test('equator at prime meridian (0, 0) → (0, 0, R)', () => {
    const p = latLonToCartesian(0, 0);
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeCloseTo(0, 5);
    expect(p[2]).toBeCloseTo(1, 5);
  });

  test('north pole (90, 0) → (0, R, 0)', () => {
    const p = latLonToCartesian(90, 0);
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeCloseTo(1, 5);
    expect(p[2]).toBeCloseTo(0, 5);
  });

  test('south pole (-90, 0) → (0, -R, 0)', () => {
    const p = latLonToCartesian(-90, 0);
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeCloseTo(-1, 5);
    expect(p[2]).toBeCloseTo(0, 5);
  });

  test('equator at 90°E → (R, 0, 0)', () => {
    const p = latLonToCartesian(0, 90);
    expect(p[0]).toBeCloseTo(1, 5);
    expect(p[1]).toBeCloseTo(0, 5);
    expect(p[2]).toBeCloseTo(0, 5);
  });

  test('equator at 180° → (0, 0, -R)', () => {
    const p = latLonToCartesian(0, 180);
    expect(p[0]).toBeCloseTo(0, 5);
    expect(p[1]).toBeCloseTo(0, 5);
    expect(p[2]).toBeCloseTo(-1, 5);
  });

  test('custom radius scales correctly', () => {
    const r = 6371;
    const p = latLonToCartesian(0, 0, r);
    expect(p[2]).toBeCloseTo(r, 1);
  });

  test('result is always on sphere surface', () => {
    const testCases = [
      [45, 90],
      [-30, -120],
      [60, 45],
      [-75, 170],
      [0, -90],
    ];
    for (const [lat, lon] of testCases) {
      const p = latLonToCartesian(lat, lon);
      const len = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
      expect(len).toBeCloseTo(1, 5);
    }
  });
});

describe('cartesianToLatLon', () => {
  test('round-trip conversion preserves coordinates', () => {
    const testCases = [
      [0, 0],
      [45, 90],
      [-30, -120],
      [60, 45],
      [-75, 170],
    ];
    for (const [lat, lon] of testCases) {
      const cart = latLonToCartesian(lat, lon);
      const result = cartesianToLatLon(cart);
      expect(result.lat).toBeCloseTo(lat, 3);
      expect(result.lon).toBeCloseTo(lon, 3);
    }
  });
});

describe('greatCircleDistance', () => {
  test('same point returns 0', () => {
    expect(greatCircleDistance(40, -74, 40, -74)).toBeCloseTo(0, 10);
  });

  test('antipodal points return π', () => {
    expect(greatCircleDistance(0, 0, 0, 180)).toBeCloseTo(Math.PI, 5);
  });

  test('NYC to London ≈ 5570 km (0.874 rad)', () => {
    const d = greatCircleDistance(40.64, -73.78, 51.47, -0.46);
    const dKm = d * 6371;
    expect(dKm).toBeGreaterThan(5500);
    expect(dKm).toBeLessThan(5700);
  });

  test('equatorial quarter arc = π/2', () => {
    const d = greatCircleDistance(0, 0, 0, 90);
    expect(d).toBeCloseTo(Math.PI / 2, 5);
  });

  test('symmetry: d(A,B) = d(B,A)', () => {
    const d1 = greatCircleDistance(33.94, -118.41, 35.76, 140.39);
    const d2 = greatCircleDistance(35.76, 140.39, 33.94, -118.41);
    expect(d1).toBeCloseTo(d2, 10);
  });
});

describe('greatCircleInterpolate', () => {
  test('t=0 returns start point', () => {
    const p = greatCircleInterpolate(40, -74, 51, -0.5, 0);
    const start = latLonToCartesian(40, -74);
    expect(p[0]).toBeCloseTo(start[0], 4);
    expect(p[1]).toBeCloseTo(start[1], 4);
    expect(p[2]).toBeCloseTo(start[2], 4);
  });

  test('t=1 returns end point', () => {
    const p = greatCircleInterpolate(40, -74, 51, -0.5, 1);
    const end = latLonToCartesian(51, -0.5);
    expect(p[0]).toBeCloseTo(end[0], 4);
    expect(p[1]).toBeCloseTo(end[1], 4);
    expect(p[2]).toBeCloseTo(end[2], 4);
  });

  test('midpoint is equidistant from both endpoints', () => {
    const lat1 = 0,
      lon1 = 0,
      lat2 = 0,
      lon2 = 90;
    const mid = greatCircleInterpolate(lat1, lon1, lat2, lon2, 0.5);
    const start = latLonToCartesian(lat1, lon1);
    const end = latLonToCartesian(lat2, lon2);

    const dStart = Math.sqrt(
      (mid[0] - start[0]) ** 2 + (mid[1] - start[1]) ** 2 + (mid[2] - start[2]) ** 2
    );
    const dEnd = Math.sqrt(
      (mid[0] - end[0]) ** 2 + (mid[1] - end[1]) ** 2 + (mid[2] - end[2]) ** 2
    );
    expect(dStart).toBeCloseTo(dEnd, 4);
  });

  test('interpolation stays on sphere surface', () => {
    for (let t = 0; t <= 1; t += 0.1) {
      const p = greatCircleInterpolate(33, -118, 51, -0.5, t);
      const len = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
      expect(len).toBeCloseTo(1, 4);
    }
  });

  test('same point returns same point at any t', () => {
    const p = greatCircleInterpolate(45, 90, 45, 90, 0.5);
    const ref = latLonToCartesian(45, 90);
    expect(p[0]).toBeCloseTo(ref[0], 4);
    expect(p[1]).toBeCloseTo(ref[1], 4);
    expect(p[2]).toBeCloseTo(ref[2], 4);
  });
});

describe('generateGreatCircleArc', () => {
  test('returns correct number of waypoints', () => {
    const arc = generateGreatCircleArc(0, 0, 0, 90, 16);
    expect(arc.length).toBe(17); // segments + 1
  });

  test('first waypoint matches start', () => {
    const arc = generateGreatCircleArc(40, -74, 51, -0.5, 10);
    const start = latLonToCartesian(40, -74);
    expect(arc[0][0]).toBeCloseTo(start[0], 4);
    expect(arc[0][1]).toBeCloseTo(start[1], 4);
    expect(arc[0][2]).toBeCloseTo(start[2], 4);
  });

  test('last waypoint matches end', () => {
    const arc = generateGreatCircleArc(40, -74, 51, -0.5, 10);
    const end = latLonToCartesian(51, -0.5);
    const last = arc[arc.length - 1];
    expect(last[0]).toBeCloseTo(end[0], 4);
    expect(last[1]).toBeCloseTo(end[1], 4);
    expect(last[2]).toBeCloseTo(end[2], 4);
  });

  test('all waypoints are on sphere surface', () => {
    const arc = generateGreatCircleArc(33, -118, 35, 140, 32);
    for (const p of arc) {
      const len = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
      expect(len).toBeCloseTo(1, 4);
    }
  });

  test('default segments produces reasonable arc', () => {
    const arc = generateGreatCircleArc(0, 0, 45, 90);
    expect(arc.length).toBe(33); // default 32 segments + 1
  });
});
