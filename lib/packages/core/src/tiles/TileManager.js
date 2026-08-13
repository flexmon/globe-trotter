// TileManager.js — provider-agnostic tile fetching, LOD selection, and caching
//
// This module delegates URL building and one-time auth setup to a pluggable
// BasemapProvider (MapboxProvider, GoogleProvider, etc.). All the LOD math,
// caching, eviction, and queueing remains here and is identical across
// providers because every provider uses Web Mercator XYZ tiling.

import { MapboxProvider } from './providers/MapboxProvider.js';

const DEG2RAD = Math.PI / 180;

export class TileManager {
  /**
   * Backwards-compat: legacy `STYLES` static mirroring the original Mapbox
   * style table. Kept as an alias to MapboxProvider.STYLES so any external
   * code that referenced TileManager.STYLES keeps working.
   */
  static get STYLES() {
    return MapboxProvider.STYLES;
  }

  /**
   * @param {import('./providers/BasemapProvider.js').BasemapProvider | string} providerOrToken
   *   Either a BasemapProvider instance (preferred) or a Mapbox access token
   *   string (legacy — wraps it in a MapboxProvider for back-compat).
   * @param {Object} [options]
   */
  constructor(providerOrToken, options = {}) {
    // Back-compat: if a string is passed, treat it as a Mapbox token and
    // synthesise a MapboxProvider so old call sites keep working.
    if (typeof providerOrToken === 'string') {
      this.provider = new MapboxProvider(providerOrToken);
      this.accessToken = providerOrToken; // legacy property
    } else {
      this.provider = providerOrToken;
      this.accessToken = null;
    }

    this._defaultMaxZoom = options.maxZoom || 19;
    this.maxZoom = this._defaultMaxZoom;
    // After GPU upload the ImageBitmap is freed (entry.image = null), so cache
    // entries are ~200 bytes of metadata — not 1 MB. Keeping 2000 entries costs
    // ~400 KB of CPU, not the ~2 GB it might look like. The limit is about how
    // many tiles stay "registered" (preventing re-fetches) rather than memory.
    // 256 GPU layers + ~120 zoom-1 prefetch tiles are always alive, leaving only
    // ~124 history slots at the old 500 limit — ~1.5 panning positions at zoom 13.
    // 2000 leaves ~1600 history slots = ~20 panning positions, smooth in all directions.
    this.maxCachedTiles = options.maxCachedTiles || 2000;
    this.style = options.style || this.provider.constructor.DEFAULT_STYLE || 'satellite';

    this.cache = new Map();
    this.loading = new Set();
    this.maxConcurrent = 10; // HTTP/2: 24 concurrent causes bandwidth contention; 10 is the sweet spot
    this.queue = [];
    this._queueIdx = 0; // Index pointer for queue (avoids shift())
    this._queueDirty = false; // Deferred sort flag

    // Per-frame dedup map: tile key → tile object. Prevents duplicate entries
    // when the horizon cluster and the main loop both cover the same tile.
    this._visibleTileMap = new Map();

    // Frame timestamp — set once per frame, reused for all lastUsed stamps
    this._frameTime = performance.now();

    // Dirty flag — set when a tile finishes loading, cleared after render.
    // This ensures the engine re-renders to show newly loaded tiles
    // even when the camera is stationary.
    this._dirty = false;

    // Gate flag — true once the active provider's ensureReady() has resolved.
    // While false, requestTile() returns null immediately (without touching
    // this.loading) so the loading Set is never poisoned by pre-ready calls.
    // Mirrors the _readyResolved pattern used in the 2D TileManager.
    this._readyResolved = false;

    // Pre-allocated tile array + object pool to avoid per-frame GC pressure.
    // ~2,000 tile objects reused each frame instead of allocated fresh.
    this._visibleTiles = [];
    this._tilePool = [];
    this._tilePoolIdx = 0;
    this._boundsCache = new Map(); // key → bounds (trig results cached)

    // Prevent infinite queue replication
    this.queued = new Map();

    // Preload baseline full-earth tiles once the provider is ready.
    // Some providers (Google) need an async createSession before any tile
    // request can succeed; calling ensureReady() here gates the initial
    // baseline load on that.
    this._ready = this.provider
      .ensureReady(this.style)
      .then(() => {
        this._readyResolved = true;
        const provMax = this.provider.getMaxZoom(this.style);
        this.maxZoom = provMax != null ? provMax : this._defaultMaxZoom;
        this._dirty = true; // trigger re-render so visible tiles get queued
        this.loadBaseTiles();
      })
      .catch((err) => {
        console.warn('[TileManager] Provider ensureReady failed:', err);
      });
  }

  /**
   * Resolve when the active provider has finished any async setup
   * (e.g. Google session-token bootstrap). Mapbox resolves immediately.
   * @returns {Promise<void>}
   */
  ready() {
    return this._ready || Promise.resolve();
  }

  /**
   * Load the global baseline tiles at Z=2 and Z=3.
   * Z=2 (16 tiles) and Z=3 (64 tiles) are always pushed into the visible tile
   * list as permanent background, so they stay in the GPU texture array and
   * never get evicted. Together they provide a 6-zoom-level fallback for any
   * area the user has not yet visited at high zoom.
   */
  loadBaseTiles() {
    for (let baseZ = 2; baseZ <= 3; baseZ++) {
      const n = Math.pow(2, baseZ);
      // High dist makes these lowest priority — FOV tiles load first.
      // Z=3 slightly lower priority than Z=2 so Z=2 is guaranteed first.
      const priority = baseZ === 2 ? 10000 : 9500;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          this.requestTile(baseZ, x, y, priority);
        }
      }
    }
  }

  /** Update frame timestamp — call once per render loop. */
  setFrameTime(now) {
    this._frameTime = now;
  }

  /** Number of tiles currently being fetched. */
  get pendingCount() {
    return this.loading.size + (this.queue.length - this._queueIdx);
  }

  /** True when new tiles have loaded since last render. Cleared after reading. */
  get dirty() {
    const d = this._dirty;
    this._dirty = false;
    return d;
  }

  setStyle(styleName) {
    const styles = this.provider.constructor.STYLES;
    if (!styles[styleName]) {
      console.warn(
        `[TileManager] Unknown style for provider ${this.provider.constructor.PROVIDER_ID}: ${styleName}`
      );
      return;
    }
    this.style = styleName;
    // Block tile fetches until the new provider/style is ready. Must be
    // set to false BEFORE reassigning _ready so any concurrent requestTile
    // calls that slip in before the promise resolves are gated out.
    this._readyResolved = false;
    // Clear everything — new style needs fresh tiles
    this.cache.clear();
    this.loading.clear();
    this.queued.clear();
    this.queue.length = 0;
    this._queueIdx = 0;
    this._boundsCache.clear();

    // Wait for any provider setup (e.g. Google createSession for the new
    // style) before requesting tiles. Mapbox resolves synchronously.
    this._ready = this.provider
      .ensureReady(styleName)
      .then(() => {
        this._readyResolved = true;
        const provMax = this.provider.getMaxZoom(styleName);
        this.maxZoom = provMax != null ? provMax : this._defaultMaxZoom;
        this._dirty = true; // trigger re-render so visible tiles get queued
        this.loadBaseTiles();
      })
      .catch((err) => {
        console.warn('[TileManager] Provider ensureReady failed:', err);
      });
  }

  /**
   * Get the attribution string for the current style. Pass-through to the
   * active provider; safe to call any time after construction (Google's
   * copyright is only populated after ensureReady() resolves, but
   * getAttribution returns a generic fallback before then).
   * @returns {string}
   */
  getAttribution() {
    return this.provider.getAttribution(this.style);
  }

  /**
   * Walk up the zoom tree to find the best (highest-zoom) cached ancestor
   * tile that covers the given tile's area. Returns { key, bounds } of the
   * ancestor, or null if nothing is cached.
   */
  findBestCachedAncestor(z, x, y) {
    let cz = z,
      cx = x,
      cy = y;
    while (cz > 2) {
      cz--;
      cx = Math.floor(cx / 2);
      cy = Math.floor(cy / 2);
      const key = `${cz}/${cx}/${cy}`;
      if (this.cache.has(key)) {
        const entry = this.cache.get(key);
        if (entry.style !== this.style) {
          this.cache.delete(key); // stale style — evict
          continue;
        }
        if (entry.failed) {
          continue;
        }
        return {
          key,
          z: cz,
          x: cx,
          y: cy,
          entry,
          bounds: this.tileBounds(cx, cy, cz),
        };
      }
    }
    return null;
  }

  getTileUrl(z, x, y) {
    return this.provider.getTileUrl(z, x, y, this.style);
  }

  tileBounds(x, y, z) {
    const n = Math.pow(2, z);
    const lonLeft = (x / n) * 360 - 180;
    const lonRight = ((x + 1) / n) * 360 - 180;
    const mercTop = Math.PI * (1 - (2 * y) / n);
    const mercBottom = Math.PI * (1 - (2 * (y + 1)) / n);
    const latTop = Math.atan(Math.sinh(mercTop)) * (180 / Math.PI);
    const latBottom = Math.atan(Math.sinh(mercBottom)) * (180 / Math.PI);
    return { latTop, latBottom, lonLeft, lonRight, mercTop, mercBottom };
  }

  latLonToTile(lat, lon, z) {
    const n = Math.pow(2, z);
    const x = Math.floor(((lon + 180) / 360) * n);
    const latClamped = Math.max(-85, Math.min(85, lat));
    const latRad = latClamped * DEG2RAD;
    const y = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
  }

  /**
   * Map camera distance to tile zoom level using a continuous logarithmic formula.
   *
   * altitude = distance - 1.0  (height above the globe surface in globe radii)
   * zoom = floor(-log2(altitude) + 5)
   *
   * The +5 constant matches tile pixel density to screen pixel density
   * so labels and features are readable at each altitude.
   *
   * This gives a smooth, continuous mapping:
   *   distance 8.0  → altitude 7.0  → zoom 2   (full globe)
   *   distance 3.0  → altitude 2.0  → zoom 4   (hemisphere)
   *   distance 2.0  → altitude 1.0  → zoom 5   (continent)
   *   distance 1.5  → altitude 0.5  → zoom 6   (country)
   *   distance 1.1  → altitude 0.1  → zoom 8   (region)
   *   distance 1.02 → altitude 0.02 → zoom 11  (metro area)
   *   distance 1.005→ altitude 0.005→ zoom 13  (city)
   *   distance 1.001→ altitude 0.001→ zoom 15  (neighborhood)
   *   distance 1.0003→altitude 0.0003→zoom 17  (block)
   *   distance 1.0001→altitude 0.0001→zoom 18  (street)
   *
   * Clamped to [2, maxZoom].
   */
  zoomFromDistance(distance) {
    const altitude = Math.max(distance - 1.0, 0.00001);
    // Raw-imagery styles (Mapbox V4 satellite, Google satellite) get +5
    // for sharp pixels; labelled/styled maps get +4 for readable annotations.
    const bias = this._zoomBiasForStyle();
    const zoom = Math.floor(-Math.log2(altitude) + bias);
    return Math.max(2, Math.min(this.maxZoom, zoom));
  }

  /**
   * Per-style zoom bias (additive constant in zoomFromDistance).
   *
   * The goal is to request tiles whose native pixel density matches the
   * screen density at the current camera altitude — so tiles render sharp
   * without visible upscaling interpolation.
   *
   * Mapbox @2x tiles are 512px and render as one screen tile → bias +5.
   * Google tiles are 256px (scaleFactor2x is silently ignored for this API
   * tier). To match the geographic pixels-per-unit of a 512px tile at zoom Z,
   * we request a 256px tile at zoom Z+1. That shifts the bias to +6.
   *
   * Labelled/vector styles (both providers) are styled maps where sharp edges
   * matter more than raw pixel count, so they stay at +4 or +5.
   *
   * @private
   * @returns {number}
   */
  _zoomBiasForStyle() {
    // Mapbox: V4 satellite delivers genuine 512px @2x tiles → +5.
    // Styled Mapbox maps: +4 (vector-styled, sharp at native zoom).
    if (typeof this.provider.isV4Style === 'function') {
      return this.provider.isV4Style(this.style) ? 5 : 4;
    }
    // For providers that report actual tile dimensions (e.g. GoogleProvider
    // after ensureReady), use the real tile width to compute the bias:
    //   512px → same as Mapbox @2x → +5
    //   256px → need one extra zoom level to match 512px quality → +6
    const tileWidth = this.provider.getTileWidth?.(this.style);
    if (tileWidth != null) {
      const styleInfo = this.provider.constructor.STYLES?.[this.style];
      const isRawImagery = styleInfo?.mapType === 'satellite';
      if (!isRawImagery) return 4;
      return tileWidth >= 512 ? 5 : 6;
    }
    // Pre-session fallback: satellite → +5, styled → +4.
    const styleInfo = this.provider.constructor.STYLES?.[this.style];
    if (styleInfo?.mapType === 'satellite') return 5;
    return 4;
  }

  /**
   * Convert camera position to geographic lat/lon.
   *
   * CRITICAL: The globe's coordinate system has +Z axis = geographic lon -180° (date line).
   * The raw atan2(x,z) gives the sphere angle, but we must subtract 180° to get
   * the actual geographic longitude the camera is looking at.
   */
  cameraLatLon(cameraPosition) {
    const [x, y, z] = cameraPosition;
    const r = Math.sqrt(x * x + y * y + z * z);
    const lat = Math.asin(y / r) * (180 / Math.PI);
    // Offset by -180° to match globe coordinate convention
    let lon = Math.atan2(x, z) * (180 / Math.PI) - 180;
    if (lon < -180) lon += 360;
    return { lat, lon };
  }

  /**
   * Get tiles that cover the entire visible globe surface.
   * At zoom ≤ 4: load ALL tiles for guaranteed full coverage (max 256 tiles).
   * At zoom 5+: use FOV-based radius with latitude compensation for poles.
   */
  getVisibleTiles(cameraPosition, distance, lookPoint = null, tilt = 0, frustumCorners = null) {
    const zoom = this.zoomFromDistance(distance);
    const n = Math.pow(2, zoom);

    // Reset pool index — reuses existing objects from previous frame
    this._tilePoolIdx = 0;
    this._visibleTiles.length = 0;
    this._visibleTileMap.clear();

    // In oblique views, center tiles at the look-point (where the camera aims)
    // rather than below the camera. Fall back to camera position if not provided.
    const centerPos = tilt > 0.05 && lookPoint ? lookPoint : cameraPosition;
    const { lat: camLat, lon: camLon } = this.cameraLatLon(centerPos);
    const center = this.latLonToTile(camLat, camLon, zoom);

    // At zoom ≤ 4 (max 256 tiles), load ALL tiles for complete coverage.
    // Zoom 5+ uses FOV-based radius to stay within the 256 texture layer
    // budget of the WebGPU instanced renderer.
    if (zoom <= 4) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const dx = x - center.x;
          const dy = y - center.y;
          this._pushTile(zoom, x, y, dx * dx + dy * dy);
        }
      }
      this._visibleTiles.sort((a, b) => a.dist - b.dist);
      return this._visibleTiles;
    }

    // At zoom 5+: compute tile radius from camera FOV footprint.
    // First, ALWAYS push the Z=2 (16 tiles) and Z=3 (64 tiles) global base tiles.
    // These are sorted by zoom ascending in the renderer, so they paint first
    // as a permanent background layer. High-zoom tiles then paint on top.
    // Keeping Z=2+Z=3 in the visible list ensures they stay in the GPU texture
    // array and serve as a 6-zoom-level fallback for any unvisited area.
    for (let by = 0; by < 4; by++) {
      for (let bx = 0; bx < 4; bx++) {
        this._pushTile(2, bx, by, -100); // Z=2: highest priority base layer
      }
    }
    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 8; bx++) {
        this._pushTile(3, bx, by, -90); // Z=3: second background layer
      }
    }

    // Geometric horizon distance (always needed: Zone 3 uses it for deltaZ/horizZoom).
    const invD = 1.0 / distance;
    const maxFov = Math.asin(Math.min(invD, 1.0));
    const horizonDeg = Math.acos(Math.min(invD, 1.0)) * (180 / Math.PI);

    // Ray-sphere arc helper — used only in the fallback path below.
    const _groundArcDeg = (halfFov) => {
      if (halfFov >= maxFov) return horizonDeg;
      const s = Math.sin(halfFov),
        c = Math.cos(halfFov);
      const inner = 1.0 - distance * distance * s * s;
      if (inner <= 0) return horizonDeg;
      const t = distance * c - Math.sqrt(inner);
      return Math.acos(Math.max(-1.0, Math.min(1.0, distance - t * c))) * (180 / Math.PI);
    };

    let horizDeg, vertDeg;

    if (frustumCorners && frustumCorners.length === 4) {
      // ── Accurate path: derive coverage from the actual GPU frustum corners ──
      // Corners arrive in order [BL, BR, TL, TR] from TileRenderer.
      // In a tilted view the top corners (TL/TR) fall on or near the horizon
      // and the bottom corners (BL/BR) land in the near zone.
      // We use the lat/lon bounding box of all 4 corners as the coverage area.
      //
      // Longitudes are normalised relative to camLon to handle the ±180° wrap.
      const normLon = (lon) => {
        let d = lon - camLon;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        return d;
      };
      const lats = frustumCorners.map((c) => c.lat);
      const lonOffs = frustumCorners.map((c) => normLon(c.lon));
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLonOff = Math.min(...lonOffs);
      const maxLonOff = Math.max(...lonOffs);

      // 1.2× safety margin for partially-visible edge tiles; +5° floor so we
      // never collapse to zero at nadir when all corners are nearly coincident.
      vertDeg = Math.min((maxLat - minLat) * 1.2 + 5, 180);
      horizDeg = Math.min((maxLonOff - minLonOff) * 1.2 + 5, 180);
    } else {
      // ── Fallback: heuristic from hardcoded aspect ratio (unit tests / no matrices) ──
      const halfFovV = Math.PI / 8; // 22.5° = (π/4)/2
      const halfFovH = Math.atan(Math.tan(halfFovV) * 2.0); // 2.0 = assumed aspect ratio
      const rawVertHalfDeg = _groundArcDeg(halfFovV);
      const rawHorizHalfDeg = _groundArcDeg(halfFovH);
      const rawVertDeg = rawVertHalfDeg * 2;
      horizDeg = Math.min(rawHorizHalfDeg * 2 * 1.2, 180);
      vertDeg = Math.min(rawVertHalfDeg * 2 * 1.2, 180);

      // Tilt expansion for the fallback path (frustum corners make this unnecessary
      // in the accurate path since they already encode the tilted coverage area).
      if (tilt > 0.05) {
        const tiltFrac = Math.sin(tilt);
        const forwardDeg = horizonDeg * tiltFrac * 1.8 + 15;
        const backwardDeg = rawVertDeg * 1.2;
        vertDeg = Math.min(forwardDeg + backwardDeg, 180);
        const expandedHoriz = horizonDeg * tiltFrac * 2.5 + 15;
        horizDeg = Math.min(Math.max(horizDeg * (1.0 + 1.5 * tiltFrac), expandedHoriz), 180);
      }
    }

    const tileDeg = 360 / n;

    // cosLat compensates for Mercator distortion at high latitudes.
    // Near the poles, each tile covers a tiny sliver of latitude
    // (e.g. ~0.5° at zoom 6 near 85°N vs ~2.8° at equator).
    // Both X and Y radii need this correction to load enough tiles.
    const cosLat = Math.max(Math.cos(Math.abs(camLat) * DEG2RAD), 0.15);
    let radiusY = Math.ceil(vertDeg / tileDeg / 2 / cosLat) + 3;
    let radiusX = Math.ceil(horizDeg / tileDeg / 2 / cosLat) + 3;

    radiusX = Math.min(radiusX, Math.floor(n / 2));
    radiusY = Math.min(radiusY, Math.floor(n / 2));

    // CRITICAL BUG FIX: Prevent O(N^2) catastrophic looping at high zoom + tilt.
    // We only render 256 tiles maximum anyway. Cap the traversal grid symmetrically.
    const MAX_SEARCH_RADIUS = 120; // 240x240 grid
    if (radiusX > MAX_SEARCH_RADIUS) radiusX = MAX_SEARCH_RADIUS;
    if (radiusY > MAX_SEARCH_RADIUS) radiusY = MAX_SEARCH_RADIUS;

    for (let dy = -radiusY; dy <= radiusY; dy++) {
      for (let dx = -radiusX; dx <= radiusX; dx++) {
        let tx = center.x + dx;
        const ty = center.y + dy;
        tx = ((tx % n) + n) % n;
        if (ty < 0 || ty >= n) continue;
        this._pushTile(zoom, tx, ty, dx * dx + dy * dy);
      }
    }

    // ── Zoom-1 prefetch: smooth zoom-out transitions ──────────────────────────
    //
    // When the camera crosses a zoom boundary (e.g. zoom 13 → 12), the new
    // zoom-level tiles haven't been loaded yet. Without pre-loading, the only
    // fallback is the Z=2 base tiles — the globe becomes very blurry for the
    // several seconds it takes the new tiles to arrive.
    //
    // Fix: call requestTile() for zoom−1 tiles every frame at low priority
    // (dist ≥ 80) so they silently warm the cache in the background. These
    // tiles do NOT appear in _visibleTiles (no GPU render-budget cost). When
    // the zoom drops, findBestCachedAncestor() returns them immediately as a
    // clean fallback — one quality level down, not 10 quality levels down.
    //
    // Pre-fetch radius: zoom−1 tiles are 2× larger, so half the tile count
    // covers the same geographic area as the current-zoom near zone.
    if (zoom > 3 && this._readyResolved) {
      // ── Zoom-N-1 prefetch ─────────────────────────────────────────────────
      // Cover the FULL zoom-N-1 viewport ahead of the zoom-out transition.
      // Old formula (ceil(radiusX/2)+2, capped at 10) left the outer 3-tile
      // band of the target viewport uncovered, causing blurry edges on zoom-out.
      // New formula: match the actual radiusX (zoom-N-1 tiles cover 2× the area,
      // so the radius in their coordinate space is roughly half of radiusX in
      // zoom-N space — but the VIEWPORT at zoom-N-1 still needs radiusX tiles
      // from its center, so we use radiusX directly as the cap).
      const pfZoom = zoom - 1;
      const pfN = Math.pow(2, pfZoom);
      const pfCenter = this.latLonToTile(camLat, camLon, pfZoom);
      const pfRadiusX = Math.min(20, radiusX + 3);
      const pfRadiusY = Math.min(15, radiusY + 3);
      for (let pdy = -pfRadiusY; pdy <= pfRadiusY; pdy++) {
        for (let pdx = -pfRadiusX; pdx <= pfRadiusX; pdx++) {
          let ptx = pfCenter.x + pdx;
          const pty = pfCenter.y + pdy;
          ptx = ((ptx % pfN) + pfN) % pfN;
          if (pty < 0 || pty >= pfN) continue;
          this.requestTile(pfZoom, ptx, pty, 80 + pdx * pdx + pdy * pdy);
        }
      }

      // ── Zoom-N-2 prefetch ─────────────────────────────────────────────────
      // Second fallback layer: tiles two zoom levels below current. Ensures
      // that a user who zooms out TWO levels rapidly (e.g. pinch-zoom past a
      // boundary) still has warm cache tiles rather than falling all the way
      // to Z=2/Z=3 base quality. Radius is smaller since each tile covers 4×
      // the geographic area.
      if (zoom > 5) {
        const pf2Zoom = zoom - 2;
        const pf2N = Math.pow(2, pf2Zoom);
        const pf2Center = this.latLonToTile(camLat, camLon, pf2Zoom);
        const pf2RadiusX = Math.min(12, Math.ceil(radiusX / 4) + 3);
        const pf2RadiusY = Math.min(10, Math.ceil(radiusY / 4) + 3);
        for (let pdy = -pf2RadiusY; pdy <= pf2RadiusY; pdy++) {
          for (let pdx = -pf2RadiusX; pdx <= pf2RadiusX; pdx++) {
            let ptx = pf2Center.x + pdx;
            const pty = pf2Center.y + pdy;
            ptx = ((ptx % pf2N) + pf2N) % pf2N;
            if (pty < 0 || pty >= pf2N) continue;
            // dist=200+ ensures this loads after both zoom-N and zoom-N-1 tiles
            this.requestTile(pf2Zoom, ptx, pty, 200 + pdx * pdx + pdy * pdy);
          }
        }
      }
    }

    // ── Distance-based LOD (horizon fix) ────────────────────────────────────
    //
    // Problem: horizon tiles have the largest dx²+dy² dist values and are always
    // truncated off the end of the 256-slot GPU render budget. Z=2 base tiles
    // show through as a blurry band at the horizon.
    //
    // Solution: three-zone LOD scheme when the camera is significantly tilted.
    //
    //   Zone 1 — Near    (main loop above):  full zoom, small inner radius
    //   Zone 2 — Mid     (new):              zoom−1, medium radius
    //   Zone 3 — Horizon (new):              zoom−deltaZ (3-4 levels lower),
    //                                        boosted priority cluster
    //
    // Tiles at the horizon are viewed nearly edge-on due to perspective
    // compression: a 512px tile at zoom 13 projects to just a few screen pixels
    // in the tilt direction — no sharper than a zoom 10 tile. Lower-zoom horizon
    // tiles cover the same geographic band with far fewer tiles, freeing the
    // 256-slot budget for the near area where detail actually matters.
    //
    // The mid zone provides a smooth LOD transition and ensures the mid-distance
    // area has coverage at an appropriate resolution during the horizon loading.
    //
    // LOD formula  (deltaZ based on tilt):
    //   tilt 30° → deltaZ 1  (zoom 13 → zoom 12 horizon)
    //   tilt 45° → deltaZ 2  (zoom 13 → zoom 11 horizon)
    //   tilt 60° → deltaZ 3  (zoom 13 → zoom 10 horizon)  ← user's example
    //   tilt 75° → deltaZ 4  (zoom 13 → zoom  9 horizon)
    if (tilt > 0.3 && lookPoint && cameraPosition) {
      const sinT = Math.sin(tilt);
      const deltaZ = Math.min(4, Math.round(4 * sinT * sinT));

      // ── Zone 2: mid-distance tiles at zoom−1 ────────────────────────────
      if (deltaZ >= 1 && zoom > 3) {
        const midZoom = zoom - 1;
        const midN = Math.pow(2, midZoom);
        const midCenter = this.latLonToTile(camLat, camLon, midZoom);
        const midTileDeg = 360 / midN;
        const midRadiusY = Math.min(10, Math.ceil(vertDeg / midTileDeg / 2 / cosLat) + 2);
        const midRadiusX = Math.min(12, Math.ceil(horizDeg / midTileDeg / 2 / cosLat) + 2);

        for (let dy = -midRadiusY; dy <= midRadiusY; dy++) {
          for (let dx = -midRadiusX; dx <= midRadiusX; dx++) {
            let tx = midCenter.x + dx;
            const ty = midCenter.y + dy;
            tx = ((tx % midN) + midN) % midN;
            if (ty < 0 || ty >= midN) continue;
            // dist 10+ means mid tiles rank after the nearest full-zoom tiles
            // (dist 0-9) but before any far full-zoom tile.
            this._pushTile(midZoom, tx, ty, 10 + dx * dx + dy * dy);
          }
        }
      }

      // ── Zone 3: horizon cluster at zoom−deltaZ ───────────────────────────
      const horizonZoom = Math.max(2, zoom - deltaZ);
      const horizonN = Math.pow(2, horizonZoom);
      const horizTileDeg = 360 / horizonN;

      if (frustumCorners && frustumCorners.length === 4) {
        // ── Accurate path: use the top frustum corners as the horizon band ──
        // The top-left (index 2) and top-right (index 3) NDC corners land on
        // the geometric horizon in a tilted view — they are the screen edges
        // that map closest to (or past) the sphere tangent line.
        const tl = frustumCorners[2]; // top-left screen corner → sphere
        const tr = frustumCorners[3]; // top-right screen corner → sphere

        // Horizon cluster center = midpoint of top corners.
        // Longitudes normalised around camLon to avoid ±180° wrap issues.
        const tlOff = (() => {
          let d = tl.lon - camLon;
          while (d > 180) d -= 360;
          while (d < -180) d += 360;
          return d;
        })();
        const trOff = (() => {
          let d = tr.lon - camLon;
          while (d > 180) d -= 360;
          while (d < -180) d += 360;
          return d;
        })();
        const hLat = (tl.lat + tr.lat) / 2;
        let hLon = camLon + (tlOff + trOff) / 2;
        while (hLon > 180) hLon -= 360;
        while (hLon < -180) hLon += 360;

        const horizTile = this.latLonToTile(hLat, hLon, horizonZoom);

        // Horizontal radius spans the full top-edge width + margin.
        // This replaces the old fixed 3-5 tile radius which was too narrow
        // for wide-FOV / high-aspect-ratio viewports.
        const horizWidthDeg = Math.abs(trOff - tlOff);
        const hRadX = Math.max(4, Math.ceil(horizWidthDeg / horizTileDeg / 2) + 3);
        const hRadY = Math.max(3, Math.min(5, Math.round(6 * sinT)));

        for (let hy = -hRadY; hy <= hRadY; hy++) {
          for (let hx = -hRadX; hx <= hRadX; hx++) {
            let htx = horizTile.x + hx;
            const hty = horizTile.y + hy;
            htx = ((htx % horizonN) + horizonN) % horizonN;
            if (hty < 0 || hty >= horizonN) continue;
            this._pushTile(horizonZoom, htx, hty, -70 + hx * hx + hy * hy);
          }
        }
      } else {
        // ── Fallback: forward-facing nadir-to-horizon direction ──────────────
        const nX = cameraPosition[0] * invD;
        const nY = cameraPosition[1] * invD;
        const nZ = cameraPosition[2] * invD;

        let fX = lookPoint[0] - nX;
        let fY = lookPoint[1] - nY;
        let fZ = lookPoint[2] - nZ;
        const fDot = fX * nX + fY * nY + fZ * nZ;
        fX -= fDot * nX;
        fY -= fDot * nY;
        fZ -= fDot * nZ;
        const fLen = Math.sqrt(fX * fX + fY * fY + fZ * fZ);

        if (fLen > 0.001) {
          fX /= fLen;
          fY /= fLen;
          fZ /= fLen;

          const horizonRad = Math.acos(Math.min(1.0 / distance, 1.0));
          const cosHR = Math.cos(horizonRad),
            sinHR = Math.sin(horizonRad);
          const hX = nX * cosHR + fX * sinHR;
          const hY = nY * cosHR + fY * sinHR;
          const hZ = nZ * cosHR + fZ * sinHR;

          const { lat: horizLat, lon: horizLon } = this.cameraLatLon([hX, hY, hZ]);
          const horizTile = this.latLonToTile(horizLat, horizLon, horizonZoom);
          const horizRadius = Math.max(3, Math.min(5, Math.round(6 * sinT)));

          for (let hy = -horizRadius; hy <= horizRadius; hy++) {
            for (let hx = -horizRadius; hx <= horizRadius; hx++) {
              let htx = horizTile.x + hx;
              const hty = horizTile.y + hy;
              htx = ((htx % horizonN) + horizonN) % horizonN;
              if (hty < 0 || hty >= horizonN) continue;
              this._pushTile(horizonZoom, htx, hty, -70 + hx * hx + hy * hy);
            }
          }
        }
      }
    }

    this._visibleTiles.sort((a, b) => a.dist - b.dist);

    // Leak fix: trim _boundsCache — it grows with every unique tile key
    // across all zoom levels. Cap at 5000 and prune to visible set.
    if (this._boundsCache.size > 5000) {
      const visibleKeys = new Set();
      for (const t of this._visibleTiles) visibleKeys.add(t.key);
      for (const k of this._boundsCache.keys()) {
        if (!visibleKeys.has(k)) this._boundsCache.delete(k);
      }
    }

    // Leak fix: trim tile pool — shrink if pool is >2× current usage.
    // Prevents peak-frame memory from persisting after zooming in.
    this._trimPoolCounter = (this._trimPoolCounter || 0) + 1;
    if (this._trimPoolCounter >= 300 && this._tilePool.length > this._tilePoolIdx * 2 + 100) {
      this._tilePool.length = this._tilePoolIdx * 2;
      this._trimPoolCounter = 0;
    }

    return this._visibleTiles;
  }

  /**
   * Reuse tile objects from a pool instead of allocating new ones.
   * Deduplicates: if the same tile is pushed twice (e.g. once by the main
   * loop and again by the horizon cluster), the lower dist value wins so the
   * tile gets higher priority in the 256-slot GPU budget.
   */
  _pushTile(z, x, y, dist) {
    const key = `${z}/${x}/${y}`;

    // Dedup: if this tile was already pushed this frame, just update its dist.
    const existing = this._visibleTileMap.get(key);
    if (existing) {
      if (dist < existing.dist) existing.dist = dist;
      return;
    }

    // Cache tileBounds — same zoom/x/y always produces the same bounds,
    // avoids recomputing atan(sinh(...)) every frame.
    let bounds = this._boundsCache.get(key);
    if (!bounds) {
      bounds = this.tileBounds(x, y, z);
      this._boundsCache.set(key, bounds);
    }

    // Reuse or grow the object pool
    let tile;
    if (this._tilePoolIdx < this._tilePool.length) {
      tile = this._tilePool[this._tilePoolIdx];
      tile.z = z;
      tile.x = x;
      tile.y = y;
      tile.key = key;
      tile.bounds = bounds;
      tile.dist = dist;
    } else {
      tile = { z, x, y, key, bounds, dist };
      this._tilePool.push(tile);
    }
    this._tilePoolIdx++;
    this._visibleTiles.push(tile);
    this._visibleTileMap.set(key, tile);
  }

  requestTile(z, x, y, dist = 0) {
    // Guard: do not attempt any tile fetch until the provider's async setup
    // (e.g. Google createSession) has completed. Returning null here is safe
    // — the engine will re-request on the next render frame after _dirty is
    // set to true inside the ensureReady .then() chain. Crucially, we bail
    // BEFORE touching this.loading so the Set is never poisoned with keys
    // that have no in-flight fetch attached.
    if (!this._readyResolved) return null;

    const key = `${z}/${x}/${y}`;
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      if (entry.style !== this.style) {
        this.cache.delete(key); // stale style — evict and re-fetch
      } else {
        entry.lastUsed = this._frameTime; // Use cached frame timestamp
        return entry.failed ? null : entry;
      }
    }
    if (this.loading.has(key)) return null;

    if (this.loading.size < this.maxConcurrent) {
      this._loadTile(z, x, y, key);
    } else {
      // Priority O(1) deduplication:
      let qItem = this.queued.get(key);
      if (qItem) {
        if (dist < qItem.dist) {
          qItem.dist = dist;
          this._queueDirty = true;
        }
      } else {
        qItem = { z, x, y, key, dist };
        this.queued.set(key, qItem);
        this.queue.push(qItem);
        this._queueDirty = true;

        if (this.queue.length > 500) {
          this.queue.sort((a, b) => a.dist - b.dist);
          // Discard furthest when queue explodes, but clean up Map
          for (let i = 400; i < this.queue.length; i++) {
            this.queued.delete(this.queue[i].key);
          }
          this.queue.length = 400;
          this._queueIdx = 0;
          this._queueDirty = false;
        }
      }
    }
    return null;
  }

  _loadTile(z, x, y, key, isRetry = false) {
    this.loading.add(key);
    const url = this.getTileUrl(z, x, y);

    // Provider returned a placeholder (e.g. session not yet ready after a
    // 401 refresh). Don't fetch or cache — just free the loading slot and
    // let the engine re-request on the next frame once the session resolves.
    if (url && url.startsWith('data:')) {
      this.loading.delete(key);
      return;
    }

    // Use fetch + createImageBitmap for off-thread JPEG/PNG decode.
    // This moves image decompression off the main thread entirely,
    // eliminating 2-5ms stalls per tile that Image.onload causes.
    let httpResponse = null;
    fetch(url)
      .then((res) => {
        httpResponse = res;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) =>
        createImageBitmap(blob, {
          premultiplyAlpha: 'none',
          resizeWidth: 512,
          resizeHeight: 512,
          resizeQuality: 'high',
        })
      )
      .then((bitmap) => {
        const now = performance.now();
        this.cache.set(key, {
          image: bitmap,
          texture: null,
          lastUsed: now,
          loadedAt: now, // used by TileRenderer to drive the 300 ms fade-in
          z,
          x,
          y,
          style: this.style,
        });
        this.loading.delete(key);
        this._dirty = true; // signal engine to re-render
        this._processQueue();
        this._evictOldTiles();
      })
      .catch(() => {
        this.loading.delete(key);

        // Give the provider a chance to recover (e.g. Google session
        // expired → refresh and retry once). Only attempt once per tile
        // to avoid infinite loops on persistent auth failures.
        if (!isRetry && httpResponse) {
          const decision = this.provider.handleFetchError(httpResponse, key);
          if (decision === 'refresh-and-retry') {
            // Drain the queue with the now-free loading slot while we wait
            // for the session to refresh — other tiles should not stall.
            this._processQueue();
            // Re-run ensureReady, then re-queue this exact tile.
            this.provider
              .ensureReady(this.style)
              .then(() => {
                this._loadTile(z, x, y, key, true);
              })
              .catch(() => {
                this._cacheFailedTile(key, z, x, y);
                this._processQueue();
                this._evictOldTiles();
              });
            return;
          }
        }

        this._cacheFailedTile(key, z, x, y);
        this._processQueue();
        this._evictOldTiles();
      });
  }

  /** @private */
  _cacheFailedTile(key, z, x, y) {
    this.cache.set(key, {
      image: null,
      texture: null,
      lastUsed: performance.now(),
      z,
      x,
      y,
      style: this.style,
      failed: true,
    });
  }

  _processQueue() {
    // Sort once when processing, not on every requestTile call
    if (this._queueDirty) {
      this.queue.sort((a, b) => a.dist - b.dist);
      this._queueIdx = 0;
      this._queueDirty = false;
    }
    // Use index pointer instead of shift() to avoid O(n) re-indexing
    while (this._queueIdx < this.queue.length && this.loading.size < this.maxConcurrent) {
      const next = this.queue[this._queueIdx++];
      this.queued.delete(next.key);
      if (!this.cache.has(next.key) && !this.loading.has(next.key)) {
        this._loadTile(next.z, next.x, next.y, next.key);
      }
    }
    // Compact when fully drained or too large
    if (this._queueIdx >= this.queue.length) {
      this.queue.length = 0;
      this._queueIdx = 0;
    } else if (this._queueIdx > 150) {
      this.queue = this.queue.slice(this._queueIdx);
      this._queueIdx = 0;
    }
  }

  _evictOldTiles() {
    if (this.cache.size <= this.maxCachedTiles) return;
    const now = this._frameTime;
    // 15 s grace: ancestor tiles visited before a rapid zoom-out stay warm long
    // enough to serve as fallback during the inbound tile fetch window.
    const GRACE_MS = 15000;
    const toEvict = this.cache.size - this.maxCachedTiles + 50;

    // Linear scan O(n): find oldest entries without sorting.
    // Collect candidates that are outside the grace window,
    // then evict the oldest ones up to toEvict count.
    let evicted = 0;
    const candidates = [];
    for (const [key, entry] of this.cache) {
      // Never evict the global background pyramid — Z=2 and Z=3 tiles are
      // permanent fallback tiles that stay in the GPU texture array always.
      if (entry.z <= 3) continue;
      if (now - entry.lastUsed >= GRACE_MS) {
        candidates.push([key, entry]);
      }
    }
    // Sort only the small candidate set (not the entire cache)
    if (candidates.length > toEvict) {
      candidates.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    }
    for (let i = 0; i < candidates.length && evicted < toEvict; i++) {
      const [key, entry] = candidates[i];
      // Free cached lat/lon grid (2.3 KB per tile)
      entry._tileLatLon = null;
      entry._projectedPos = null;
      // Close ImageBitmap if still pending upload
      if (entry.image && entry.image.close) entry.image.close();
      entry.image = null;
      this.cache.delete(key);
      evicted++;
    }
  }

  getStats() {
    return { cached: this.cache.size, loading: this.loading.size, queued: this.queue.length };
  }

  /**
   * Compute the list of tiles needed to cover a flat Web Mercator viewport
   * at the given (lng, lat, zoom). Mirrors the 2D project's selection logic.
   * Reuses the same fetch/cache/queue plumbing as `getVisibleTiles()`.
   *
   * The returned descriptors carry `worldX / worldY / worldSize` (in
   * world-pixel space at the fractional zoom) so `MercatorTileRenderer` can
   * place each quad without recomputing the projection.
   *
   * @param {number} lng               Camera center longitude (degrees)
   * @param {number} lat               Camera center latitude (degrees, clamped to ±85.051°)
   * @param {number} zoom              Current (possibly fractional) zoom
   * @param {number} viewportW         Canvas physical width (pixels)
   * @param {number} viewportH         Canvas physical height (pixels)
   * @param {boolean} [renderWorldCopies=false]  Allow tiles outside [0, numTiles) x range
   * @returns {Array<{ z, x, y, key, renderKey, worldX, worldY, worldSize, worldCopy, bounds }>}
   */
  getVisibleTilesMercator(lng, lat, zoom, viewportW, viewportH, renderWorldCopies = false) {
    const TILE_PX = 256;
    const tileZoom = Math.max(0, Math.min(this.maxZoom, Math.floor(zoom)));
    const worldSize = TILE_PX * Math.pow(2, zoom);
    const tileSizeWorld = worldSize / Math.pow(2, tileZoom);

    // Camera center in world pixels
    const centerX = ((lng + 180) / 360) * worldSize;
    const sinLat = Math.sin((lat * Math.PI) / 180);
    const centerY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;

    const halfW = viewportW / 2;
    const halfH = viewportH / 2;
    const numTiles = Math.pow(2, tileZoom);

    const minTileX = Math.floor((centerX - halfW) / tileSizeWorld);
    const maxTileX = Math.floor((centerX + halfW) / tileSizeWorld);
    const minTileY = Math.floor((centerY - halfH) / tileSizeWorld);
    const maxTileY = Math.floor((centerY + halfH) / tileSizeWorld);

    this._tilePoolIdx = 0;
    this._visibleTiles.length = 0;

    for (let y = minTileY; y <= maxTileY; y++) {
      if (y < 0 || y >= numTiles) continue;
      for (let x = minTileX; x <= maxTileX; x++) {
        if (!renderWorldCopies && (x < 0 || x >= numTiles)) continue;

        // Wrap x into [0, numTiles) for canonical tile key and image fetch
        const wx = ((x % numTiles) + numTiles) % numTiles;
        const key = `${tileZoom}/${wx}/${y}`;
        // renderKey is unique per world-copy instance
        const renderKey = renderWorldCopies ? `${tileZoom}/${x}/${y}` : key;

        let bounds = this._boundsCache.get(key);
        if (!bounds) {
          bounds = this.tileBounds(wx, y, tileZoom);
          this._boundsCache.set(key, bounds);
        }

        // Reuse the same tile-object pool used by getVisibleTiles().
        let tile;
        if (this._tilePoolIdx < this._tilePool.length) {
          tile = this._tilePool[this._tilePoolIdx];
          tile.z = tileZoom;
          tile.x = wx;
          tile.y = y;
          tile.key = key;
          tile.bounds = bounds;
          tile.dist = 0;
        } else {
          tile = { z: tileZoom, x: wx, y, key, bounds, dist: 0 };
          this._tilePool.push(tile);
        }
        tile.renderKey = renderKey;
        tile.worldX = x * tileSizeWorld; // actual position (may be outside [0, worldSize))
        tile.worldY = y * tileSizeWorld;
        tile.worldSize = tileSizeWorld;
        tile.worldCopy = Math.floor(x / numTiles);

        this._tilePoolIdx++;
        this._visibleTiles.push(tile);
      }
    }
    return this._visibleTiles;
  }
}
