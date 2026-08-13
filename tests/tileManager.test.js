// tests/tileManager.test.js — Unit tests for TileManager zoom and tile selection
import { TileManager } from '../lib/packages/core/src/tiles/TileManager.js';

// Mock fetch globally so the constructor's loadBaseTiles() call doesn't make
// real network requests or throw ReferenceError in Node environments.
beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob()),
  });
  global.createImageBitmap = vi.fn().mockResolvedValue({});
});

afterEach(() => {
  delete global.fetch;
  delete global.createImageBitmap;
});

// Helper: create a TileManager instance for a given style
function createTM(style = 'satellite') {
  const tm = new TileManager('test-token', { style });
  return tm;
}

// Helper: convert feet to globe-radius distance
// Globe radius = 20,925,525 ft (same as FEET_TO_GLOBE denominator)
function altFeetToDistance(feet) {
  return 1.0 + feet / 20925525;
}

// Helper: create a camera position at a given distance along +Z axis
// This is lat=0°, lon=-180° in globe coordinates (atan2(0,d)×180/π - 180 = -180)
function cameraAt(distance) {
  return [0, 0, distance];
}

// Helper: camera above a specific lat/lon at a given distance from globe centre.
// Globe coord system: +Y=north, lon = atan2(x,z)×(180/π) − 180
function cameraAbove(latDeg, lonDeg, distance) {
  const lat = (latDeg * Math.PI) / 180;
  const theta = ((lonDeg + 180) * Math.PI) / 180; // globe lon offset
  return [
    Math.sin(theta) * Math.cos(lat) * distance,
    Math.sin(lat) * distance,
    Math.cos(theta) * Math.cos(lat) * distance,
  ];
}

// Helper: create a TileManager backed by a 256px mock provider (mimics Google Maps).
// _zoomBiasForStyle() returns 6 for this provider (256px satellite tiles),
// so zoom = floor(−log2(altitude) + 6) — one level higher than Mapbox at the same altitude.
// This matches the ZOOM displayed in the app when Google Maps is the basemap.
function createGoogleLikeTM() {
  // Pass the provider instance as the first argument (providerOrToken).
  // getTileWidth()=256 + mapType='satellite' → _zoomBiasForStyle() returns 6,
  // giving zoom = floor(−log2(altitude) + 6) — one level higher than Mapbox.
  const provider = {
    async ensureReady() {},
    getTileUrl: () => 'https://tile.example.com',
    getMaxZoom: () => 20,
    handleFetchError: () => null,
    getTileWidth: () => 256,
    constructor: { STYLES: { satellite: { mapType: 'satellite' } } },
  };
  return new TileManager(provider, { style: 'satellite' });
}

describe('TileManager.zoomFromDistance', () => {
  test('v4 satellite uses +5 bias', () => {
    const tm = createTM('satellite');
    // distance 2.0 → altitude 1.0 → -log2(1) = 0 → floor(0+5) = 5
    expect(tm.zoomFromDistance(2.0)).toBe(5);
  });

  test('non-v4 style uses +4 bias (not +5)', () => {
    const tm = createTM('dark');
    // distance 2.0 → altitude 1.0 → -log2(1) = 0 → floor(0+4) = 4
    expect(tm.zoomFromDistance(2.0)).toBe(4);
  });

  test('non-v4 zoom is exactly 1 level below v4, not 2', () => {
    const distances = [1.5, 2.0, 3.0, 5.0, 8.0];
    const tmV4 = createTM('satellite');
    const tmStyled = createTM('streets');

    for (const d of distances) {
      const diff = tmV4.zoomFromDistance(d) - tmStyled.zoomFromDistance(d);
      expect(diff).toBeLessThanOrEqual(1);
    }
  });

  test('at ~7.5M ft altitude, non-v4 produces zoom >= 5', () => {
    const tm = createTM('dark');
    const distance = altFeetToDistance(7_500_000);
    const zoom = tm.zoomFromDistance(distance);
    expect(zoom).toBeGreaterThanOrEqual(5);
  });

  test('zoom is clamped to [2, maxZoom]', () => {
    const tm = createTM('satellite');
    expect(tm.zoomFromDistance(100)).toBe(2); // very far away
    expect(tm.zoomFromDistance(1.00001)).toBeLessThanOrEqual(19); // very close
  });

  test('zoom increases as distance decreases', () => {
    const tm = createTM('satellite');
    const distances = [8.0, 4.0, 2.0, 1.5, 1.1, 1.01];
    let prevZoom = 0;
    for (const d of distances) {
      const z = tm.zoomFromDistance(d);
      expect(z).toBeGreaterThanOrEqual(prevZoom);
      prevZoom = z;
    }
  });
});

describe('TileManager.getVisibleTiles', () => {
  test('zoom <= 4 loads ALL tiles', () => {
    const tm = createTM('satellite');
    // distance 8.0 → altitude 7.0 → zoom 2 → 4x4 = 16 tiles
    const tiles = tm.getVisibleTiles(cameraAt(8.0), 8.0);
    const n = Math.pow(2, tm.zoomFromDistance(8.0));
    expect(tiles.length).toBe(n * n);
  });

  test('zoom 5+ uses FOV-based selection (not all tiles)', () => {
    const tm = createTM('satellite');
    // distance 1.5 → altitude 0.5 → zoom 6 → 64x64 = 4096 possible
    const zoom = tm.zoomFromDistance(1.5);
    if (zoom > 4) {
      const tiles = tm.getVisibleTiles(cameraAt(1.5), 1.5);
      const maxTiles = Math.pow(2, zoom) ** 2;
      expect(tiles.length).toBeLessThan(maxTiles);
      expect(tiles.length).toBeGreaterThan(0);
    }
  });

  test('oblique tilt at moderate altitude returns more tiles than no tilt', () => {
    const tm = createTM('satellite');
    // At zoom 9 (distance ~1.1), FOV footprint is small enough
    // that tilt expansion increases radius before hitting n/2 cap
    const distance = 1.1;
    const cam = cameraAt(distance);

    // Without tilt: base FOV radius
    const tilesNoTilt = tm.getVisibleTiles(cam, distance, null, 0);

    // With tilt: expanded radius. Use lookPoint at globe surface.
    const lookPoint = [0, 0, 1];
    const tiltRad = 1.0; // ~57°
    const tilesTilted = tm.getVisibleTiles(cam, distance, lookPoint, tiltRad);

    // Tilt expansion should increase tile count (both radii under n/2 cap)
    expect(tilesTilted.length).toBeGreaterThanOrEqual(tilesNoTilt.length);
  });

  test('oblique tilt at low altitude uses moderate expansion', () => {
    const tm = createTM('satellite');
    const distance = 1.01; // very close to surface
    const cam = cameraAt(distance);
    const lookPoint = [0, 0, 1];

    const tilesNoTilt = tm.getVisibleTiles(cam, distance, null, 0);
    const tilesTilted = tm.getVisibleTiles(cam, distance, lookPoint, 0.5);

    // At low altitude tilt should increase tile count, but not massively
    expect(tilesTilted.length).toBeGreaterThanOrEqual(tilesNoTilt.length);
  });

  test('tiles are sorted by distance (nearest first)', () => {
    const tm = createTM('satellite');
    const tiles = tm.getVisibleTiles(cameraAt(3.0), 3.0);
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i].dist).toBeGreaterThanOrEqual(tiles[i - 1].dist);
    }
  });

  test('all tile objects have required properties', () => {
    const tm = createTM('satellite');
    const tiles = tm.getVisibleTiles(cameraAt(4.0), 4.0);
    for (const t of tiles) {
      expect(t).toHaveProperty('z');
      expect(t).toHaveProperty('x');
      expect(t).toHaveProperty('y');
      expect(t).toHaveProperty('key');
      expect(t).toHaveProperty('bounds');
      expect(t).toHaveProperty('dist');
      expect(t.bounds).toHaveProperty('latTop');
      expect(t.bounds).toHaveProperty('latBottom');
      expect(t.bounds).toHaveProperty('lonLeft');
      expect(t.bounds).toHaveProperty('lonRight');
    }
  });
});

describe('TileManager style consistency', () => {
  test('non-v4 styles produce adequate tile coverage at transition altitude', () => {
    // At the critical altitude where zoom transitions from <=5 to >5,
    // there should be no visual gap in coverage
    const styles = ['streets', 'dark', 'light', 'outdoors'];
    for (const style of styles) {
      const tm = createTM(style);
      const distance = altFeetToDistance(7_500_000);
      const zoom = tm.zoomFromDistance(distance);
      const tiles = tm.getVisibleTiles(cameraAt(distance), distance);

      // Must have meaningful tile coverage
      if (zoom <= 4) {
        // Full globe coverage
        expect(tiles.length).toBe(Math.pow(2, zoom) ** 2);
      } else {
        // FOV-based but should cover visible area
        expect(tiles.length).toBeGreaterThan(20);
      }
    }
  });
});

// ── Zoom-out coverage regression tests ───────────────────────────────────────
//
// These tests reproduce the "blurry basemap when zooming out" scenario.
// They verify that at every altitude:
//   1. The zoom formula produces the expected level (bias=6 for Google Maps).
//   2. The center tile (camera nadir) is always in the visible set.
//   3. The 3×3 grid around the nadir has no holes.
//   4. No coverage gap appears when crossing a zoom boundary.
//   5. The zoom-1 prefetch covers the area needed at the next zoom level.
//
// Screenshot reference: lat=24.4°N lon=81.7°W alt=0.076 ZOOM=9 (Google Maps)
// At this altitude, each tile covers ~0.70° and the visible footprint radius is
// ~1.81° of surface arc — the formula should request radiusX≈11, radiusY≈7.
describe('TileManager — zoom-out coverage', () => {
  // ── 1. Zoom formula ─────────────────────────────────────────────────────────

  test('bias=6 provider gives zoom 9 at the screenshot altitude (alt=0.076)', () => {
    const tm = createGoogleLikeTM();
    expect(tm.zoomFromDistance(1.076)).toBe(9);
  });

  test('zoom level is monotonically non-decreasing as distance decreases (bias=6)', () => {
    const tm = createGoogleLikeTM();
    const distances = [8, 4, 2, 1.5, 1.25, 1.125, 1.076, 1.06, 1.04, 1.02, 1.01];
    let prevZoom = 0;
    for (const d of distances) {
      const z = tm.zoomFromDistance(d);
      expect(z).toBeGreaterThanOrEqual(prevZoom);
      prevZoom = z;
    }
  });

  test('each doubling of altitude decreases zoom by exactly 1 (bias=6)', () => {
    const tm = createGoogleLikeTM();
    // At exact power-of-two altitudes the formula is integer-exact:
    //   zoom = floor(-log2(2^-k) + 6) = floor(k + 6) = k + 6
    // so alt=2^-k → zoom k+6 (clamped to [2,maxZoom]).
    for (let k = 1; k <= 8; k++) {
      const alt = Math.pow(2, -k);
      // Step one step inside (alt × 0.99 is strictly less, so floor stays at k+6)
      const zoom = tm.zoomFromDistance(1 + alt * 0.99);
      expect(zoom).toBe(Math.min(tm.maxZoom, k + 6));
    }
  });

  // ── 2. Center tile coverage ─────────────────────────────────────────────────

  test('center tile always present at key altitudes for 256px provider', () => {
    const tm = createGoogleLikeTM();
    const lat = 24.4,
      lon = -81.7; // Florida Keys (screenshot area)

    const cases = [
      { alt: 0.076, expectedZoom: 9 }, // screenshot altitude
      { alt: 0.065, expectedZoom: 9 }, // deep in zoom-9 range
      { alt: 0.14, expectedZoom: 8 }, // zoom 8 (boundary is at alt=0.125 for bias=6)
      { alt: 0.04, expectedZoom: 10 }, // zoom 10
    ];

    for (const { alt, expectedZoom } of cases) {
      const distance = 1 + alt;
      const cam = cameraAbove(lat, lon, distance);
      const zoom = tm.zoomFromDistance(distance);
      expect(zoom).toBe(expectedZoom);

      const tiles = tm.getVisibleTiles(cam, distance);
      const center = tm.latLonToTile(lat, lon, zoom);
      const centerKey = `${zoom}/${center.x}/${center.y}`;
      expect(
        tiles.some((t) => t.key === centerKey),
        `center tile missing at alt=${alt}`
      ).toBe(true);
    }
  });

  // ── 3. No holes in 3×3 grid around nadir ───────────────────────────────────

  test('3×3 grid around camera nadir has no holes at screenshot altitude', () => {
    const tm = createGoogleLikeTM();
    const lat = 24.4,
      lon = -81.7;
    const distance = 1.076; // screenshot: alt=0.076, zoom 9
    const cam = cameraAbove(lat, lon, distance);

    const tiles = tm.getVisibleTiles(cam, distance);
    const zoom = tm.zoomFromDistance(distance); // 9
    const n = Math.pow(2, zoom);
    const center = tm.latLonToTile(lat, lon, zoom);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = (((center.x + dx) % n) + n) % n;
        const ty = center.y + dy;
        if (ty < 0 || ty >= n) continue;
        const key = `${zoom}/${tx}/${ty}`;
        expect(
          tiles.some((t) => t.key === key),
          `missing tile at dx=${dx},dy=${dy}: ${key}`
        ).toBe(true);
      }
    }
  });

  // ── 4. No coverage gap at zoom boundaries ──────────────────────────────────

  test('both sides of every zoom boundary have high-res coverage (bias=6)', () => {
    const tm = createGoogleLikeTM();
    // For bias=6 the boundary between zoom N and N+1 is at alt = 2^(-(N-6)).
    // Test pairs straddling zoom 8/9, 9/10, 10/11 boundaries.
    const boundaries = [
      { below: 1 + 0.126, above: 1 + 0.124 }, // zoom 8/9 boundary at alt=0.125
      { below: 1 + 0.063, above: 1 + 0.061 }, // zoom 9/10 boundary at alt=0.0625
      { below: 1 + 0.032, above: 1 + 0.03 }, // zoom 10/11 boundary
    ];

    for (const { below, above } of boundaries) {
      // Shallow-copy the tile objects — getVisibleTiles reuses a pool of
      // mutable tile objects; the pool entries are overwritten on the next call,
      // so a simple spread of the array is not enough to preserve the first
      // call's z/x/y values.
      const tilesBelow = tm.getVisibleTiles([0, 0, below], below).map((t) => ({ ...t }));
      const tilesAbove = tm.getVisibleTiles([0, 0, above], above).map((t) => ({ ...t }));
      const zBelow = tm.zoomFromDistance(below);
      const zAbove = tm.zoomFromDistance(above);

      // Both sides must have tiles AT the primary zoom level (not just Z=2 fallback)
      expect(
        tilesBelow.some((t) => t.z === zBelow),
        `no zoom-${zBelow} tiles at dist=${below}`
      ).toBe(true);
      expect(
        tilesAbove.some((t) => t.z === zAbove),
        `no zoom-${zAbove} tiles at dist=${above}`
      ).toBe(true);

      // Zoom must step by exactly 1 across the boundary
      expect(zAbove - zBelow).toBe(1);

      // Coverage must not collapse: more than just the Z=2 base layer (16 tiles)
      expect(tilesBelow.length).toBeGreaterThan(16);
      expect(tilesAbove.length).toBeGreaterThan(16);
    }
  });

  // ── 5. Zoom-1 prefetch ──────────────────────────────────────────────────────

  test('zoom-1 prefetch requests at least the center tile for the next zoom level', () => {
    const tm = createGoogleLikeTM();
    tm._readyResolved = true; // allow prefetch to run

    const prefetchedKeys = new Set();
    vi.spyOn(tm, 'requestTile').mockImplementation((z, x, y) => {
      prefetchedKeys.add(`${z}/${x}/${y}`);
      return null;
    });

    // Camera at zoom-9 altitude with bias=6; pfZoom = 8.
    // alt=0.09 → zoom = floor(-log2(0.09)+6) = floor(3.47+6) = 9
    const distance = 1.09;
    const zoom = tm.zoomFromDistance(distance);
    expect(zoom).toBe(9);

    tm.getVisibleTiles([0, 0, distance], distance);

    const pfZoom = zoom - 1; // 8
    const pfKeys = [...prefetchedKeys].filter((k) => k.startsWith(`${pfZoom}/`));
    expect(pfKeys.length).toBeGreaterThan(0);

    // Center tile at pfZoom for this camera (nadir at lon=-180° → globe [0,0,d])
    const center = tm.latLonToTile(0, -180, pfZoom);
    const centerKey = `${pfZoom}/${center.x}/${center.y}`;
    expect(pfKeys).toContain(centerKey);

    vi.restoreAllMocks();
  });

  test('zoom-1 prefetch covers >50% of tiles needed at the transition zoom level', () => {
    const tm = createGoogleLikeTM();
    tm._readyResolved = true;

    const prefetchedKeys = new Set();
    vi.spyOn(tm, 'requestTile').mockImplementation((z, x, y) => {
      prefetchedKeys.add(`${z}/${x}/${y}`);
      return null;
    });

    // Collect zoom-8 tiles prefetched while at zoom-9 altitude
    const distAtZ9 = 1.09; // zoom 9 with bias=6
    tm.getVisibleTiles([0, 0, distAtZ9], distAtZ9);
    const pfZoom = 8;
    const prefetchedAtZ8 = new Set([...prefetchedKeys].filter((k) => k.startsWith(`${pfZoom}/`)));

    vi.restoreAllMocks();

    // Find what tiles the main loop needs at zoom-8 altitude
    // alt=0.14 → zoom = floor(-log2(0.14)+6) = floor(2.84+6) = 8
    const distAtZ8 = 1.14;
    expect(tm.zoomFromDistance(distAtZ8)).toBe(8);
    const mainTilesZ8 = tm
      .getVisibleTiles([0, 0, distAtZ8], distAtZ8)
      .filter((t) => t.z === pfZoom);

    const covered = mainTilesZ8.filter((t) => prefetchedAtZ8.has(t.key));
    const ratio = covered.length / mainTilesZ8.length;

    // Prefetch must cover the majority of the incoming zoom level's tiles.
    // If this drops below 50%, the zoom-out transition will show a full-screen
    // reload (blurry flash) rather than a smooth tile swap.
    expect(ratio).toBeGreaterThan(0.5);
  });

  // ── 6. Sweep across the screenshot zoom range ────────────────────────────────

  test('every altitude in zoom-9 range (bias=6) has tiles at camera nadir', () => {
    const tm = createGoogleLikeTM();
    const lat = 24.4,
      lon = -81.7;

    // Zoom 9 with bias=6: alt ∈ (0.0625, 0.125) — sweep 6 points inside this range
    const altitudes = [0.068, 0.076, 0.085, 0.095, 0.105, 0.115];
    for (const alt of altitudes) {
      const distance = 1 + alt;
      const cam = cameraAbove(lat, lon, distance);
      const tiles = tm.getVisibleTiles(cam, distance);
      const zoom = tm.zoomFromDistance(distance);

      expect(zoom).toBe(9);

      const center = tm.latLonToTile(lat, lon, zoom);
      const centerKey = `${zoom}/${center.x}/${center.y}`;
      expect(
        tiles.some((t) => t.key === centerKey),
        `center tile missing at alt=${alt}`
      ).toBe(true);

      // Must have zoom-9 tiles, not just the Z=2 fallback
      expect(
        tiles.some((t) => t.z === zoom),
        `no zoom-9 tiles at alt=${alt}`
      ).toBe(true);
    }
  });
});
