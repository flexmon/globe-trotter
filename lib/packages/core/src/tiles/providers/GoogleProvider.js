/**
 * GoogleProvider — Google Maps Tile API (2D Tiles) basemap provider.
 *
 * Workflow:
 *   1. ensureReady(style) lazily POSTs https://tile.googleapis.com/v1/createSession
 *      to obtain a session token + copyright string. The session is cached in
 *      memory and persisted to localStorage (keyed by style + API-key hash).
 *   2. getTileUrl() returns
 *        https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=...&key=...
 *   3. handleFetchError() invalidates the cached session on 401/403 so the
 *      next ensureReady() call refreshes it.
 *
 * Tile size:
 *   We request scaleFactor2x, but Google returns 256×256 tiles regardless for
 *   this API tier. TileManager reads the actual tileWidth from the session and
 *   adjusts the zoom bias accordingly (256px → bias +4, 512px → bias +5).
 *   The TileRenderer upscales the 256px bitmaps to 512px textures at render time.
 *
 * Attribution:
 *   The `copyright` field returned by createSession (e.g. "Map data ©2026
 *   Google") is mandatory per Google's Map Tiles API Policies. Stored on the
 *   provider after ensureReady() and returned by getAttribution().
 *
 * Session lifetime:
 *   Google states sessions are valid for ~2 weeks. We honor the `expiry`
 *   field in the response and refresh proactively before tiles start failing.
 *
 * @see https://developers.google.com/maps/documentation/tile/2d-tiles-overview
 * @see https://developers.google.com/maps/documentation/tile/session_tokens
 */

import { BasemapProvider } from './BasemapProvider.js';

const CREATE_SESSION_URL = 'https://tile.googleapis.com/v1/createSession';
const TILE_URL_BASE = 'https://tile.googleapis.com/v1/2dtiles';
// v3: invalidates any dark-style sessions, or highDpi:true (mutually exclusive with
// scaleFactor2x — caused 404s at zoom 14+) cached by earlier development builds.
const STORAGE_PREFIX = 'gt:google-tile-session:v3:';

// 1×1 transparent PNG — returned defensively by getTileUrl() if called before
// ensureReady() resolves. The TileManager's _readyResolved gate prevents this
// in normal operation, but having a safe fallback avoids poisoning the loading
// set if anything slips through. The bitmap renders as a transparent tile
// (benign) and the fetch resolves immediately (no network round-trip needed,
// but fetch() of a data URI works in all browsers).
const TRANSPARENT_TILE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Refresh sessions this many seconds before their declared expiry to avoid
 * a tile burst all racing into a 401 the moment the token actually expires.
 */
const EXPIRY_SAFETY_MARGIN_SEC = 60 * 60; // 1 hour

const GOOGLE_DARK_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#1f2937' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#d1d5db' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#111827' }] },
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ color: '#374151' }],
  },
  {
    featureType: 'road',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#e5e7eb' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry',
    stylers: [{ color: '#4b5563' }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#0f172a' }],
  },
  {
    featureType: 'poi',
    elementType: 'geometry',
    stylers: [{ color: '#243244' }],
  },
];

/**
 * Compute a short, non-reversible fingerprint of the API key. Used purely
 * to namespace localStorage keys so swapping the key automatically discards
 * cached sessions tied to the previous key.
 *
 * Not a security boundary — the key is already exposed in the browser since
 * Vite inlines it. We use FNV-1a (32-bit) for portability without WebCrypto.
 *
 * @param {string} key
 * @returns {string} 8-char hex fingerprint
 */
function fingerprintKey(key) {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    // FNV prime multiply, kept inside 32-bit space
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export class GoogleProvider extends BasemapProvider {
  static PROVIDER_ID = 'google';

  /**
   * Three Google map types are exposed. Per Google's docs, `terrain`
   * REQUIRES `layerRoadmap` to be added — we set that automatically below.
   */
  static STYLES = {
    'google-roadmap': { label: 'Google Roadmap', mapType: 'roadmap', layerTypes: [] },
    'google-roadmap-dark': {
      label: 'Google Roadmap (Dark)',
      mapType: 'roadmap',
      layerTypes: [],
      styles: GOOGLE_DARK_STYLES,
    },
    'google-satellite': { label: 'Google Satellite', mapType: 'satellite', layerTypes: [] },
    'google-satellite-dark': {
      label: 'Google Satellite (Dark)',
      mapType: 'satellite',
      layerTypes: ['layerRoadmap'],
      styles: GOOGLE_DARK_STYLES,
    },
    'google-terrain': { label: 'Google Terrain', mapType: 'terrain', layerTypes: ['layerRoadmap'] },
    'google-terrain-dark': {
      label: 'Google Terrain (Dark)',
      mapType: 'terrain',
      layerTypes: ['layerRoadmap'],
      styles: GOOGLE_DARK_STYLES,
    },
  };

  static DEFAULT_STYLE = 'google-satellite';

  /**
   * @param {string} apiKey - Google Maps Platform API key (must have the
   *                          Map Tiles API enabled in Cloud Console)
   */
  constructor(apiKey) {
    super();
    if (!apiKey) {
      throw new Error('[GoogleProvider] apiKey is required');
    }
    this.apiKey = apiKey;
    this._keyFingerprint = fingerprintKey(apiKey);

    /**
     * In-memory cache of session info, keyed by style:
     *   { session, expirySec, copyright, tileWidth, tileHeight, imageFormat }
     * @type {Map<string, object>}
     */
    this._sessions = new Map();

    /**
     * In-flight ensureReady promises, keyed by style. Used to dedupe
     * concurrent requests for the same style.
     * @type {Map<string, Promise<void>>}
     */
    this._pending = new Map();
  }

  _storageKey(style) {
    return `${STORAGE_PREFIX}${style}:${this._keyFingerprint}`;
  }

  /**
   * Try to load a still-valid session from localStorage.
   * @param {string} style
   * @returns {object|null}
   */
  _loadFromStorage(style) {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this._storageKey(style));
      if (!raw) return null;
      const data = JSON.parse(raw);
      const nowSec = Date.now() / 1000;
      if (!data.session || !data.expirySec) return null;
      if (data.expirySec - EXPIRY_SAFETY_MARGIN_SEC <= nowSec) return null;
      return data;
    } catch (_e) {
      return null;
    }
  }

  _saveToStorage(style, data) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this._storageKey(style), JSON.stringify(data));
    } catch (_e) {
      // Storage quota / disabled — non-fatal, just lose persistence
    }
  }

  _clearStorage(style) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(this._storageKey(style));
    } catch (_e) {
      // ignore
    }
  }

  /**
   * Ensure a valid session token exists for the given style. Idempotent:
   * resolves immediately if a cached session is still valid.
   *
   * @param {string} style
   * @returns {Promise<void>}
   */
  async ensureReady(style) {
    const styleInfo = GoogleProvider.STYLES[style];
    if (!styleInfo) {
      throw new Error(`[GoogleProvider] Unknown style: ${style}`);
    }

    // 1. In-memory cache hit?
    const cached = this._sessions.get(style);
    if (cached && cached.expirySec - EXPIRY_SAFETY_MARGIN_SEC > Date.now() / 1000) {
      return;
    }

    // 2. Concurrent-call dedupe — return the in-flight promise if any.
    if (this._pending.has(style)) {
      return this._pending.get(style);
    }

    const promise = (async () => {
      // 3. localStorage hit?
      const fromStorage = this._loadFromStorage(style);
      if (fromStorage) {
        this._sessions.set(style, fromStorage);
        return;
      }

      // 4. Fresh createSession POST.
      // Note: scale and highDpi are mutually exclusive — do not send both.
      // scaleFactor2x alone requests 512px tiles with full zoom-level support.
      const body = {
        mapType: styleInfo.mapType,
        language: (typeof navigator !== 'undefined' && navigator.language) || 'en-US',
        region: 'US',
        scale: 'scaleFactor2x',
      };
      if (styleInfo.layerTypes && styleInfo.layerTypes.length > 0) {
        body.layerTypes = styleInfo.layerTypes;
      }
      if (styleInfo.styles) {
        body.styles = styleInfo.styles;
      }

      const url = `${CREATE_SESSION_URL}?key=${encodeURIComponent(this.apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(
          `[GoogleProvider] createSession failed: HTTP ${res.status} ${res.statusText}`
        );
      }
      const data = await res.json();
      if (!data.session) {
        throw new Error('[GoogleProvider] createSession response missing session field');
      }

      // Google returns expiry as a string of seconds-since-epoch.
      const expirySec = Number(data.expiry) || Date.now() / 1000 + 14 * 24 * 60 * 60;

      const entry = {
        session: data.session,
        expirySec,
        copyright: data.copyright || 'Map data ©Google',
        tileWidth: data.tileWidth || 256,
        tileHeight: data.tileHeight || 256,
        imageFormat: data.imageFormat || 'jpeg',
        maxZoom: data.maxZoom || null,
        savedAtSec: Date.now() / 1000,
      };

      this._sessions.set(style, entry);
      this._saveToStorage(style, entry);
    })().finally(() => {
      this._pending.delete(style);
    });

    this._pending.set(style, promise);
    return promise;
  }

  getTileUrl(z, x, y, style) {
    const entry = this._sessions.get(style);
    if (!entry) {
      // Should not be reached in normal operation: TileManager gates all
      // requestTile() calls via _readyResolved until ensureReady() has
      // resolved. If something slips through, return a transparent tile
      // data URI so the fetch resolves cleanly (no exception, no network
      // round-trip, no poisoned loading set).
      console.warn(
        `[GoogleProvider] getTileUrl called before session ready for "${style}" — ` +
          'returning transparent placeholder. Ensure ensureReady() is awaited first.'
      );
      return TRANSPARENT_TILE_DATA_URI;
    }
    const session = encodeURIComponent(entry.session);
    const key = encodeURIComponent(this.apiKey);
    return `${TILE_URL_BASE}/${z}/${x}/${y}?session=${session}&key=${key}`;
  }

  /**
   * Returns the latest copyright string (from createSession) for the
   * currently-selected style, falling back to a generic Google credit if
   * no session has been established yet.
   *
   * @param {string} style
   * @returns {string}
   */
  getAttribution(style) {
    return this._sessions.get(style)?.copyright || 'Map data ©Google';
  }

  /**
   * Maximum tile zoom level for the given style, as returned by the
   * createSession response. Returns null before the session is ready or when
   * Google does not report a cap (TileManager falls back to its default).
   *
   * @param {string} style
   * @returns {number|null}
   */
  getMaxZoom(style) {
    return this._sessions.get(style)?.maxZoom ?? null;
  }

  /**
   * Tile pixel width for the given style, as returned by the createSession
   * response. Used by TileManager to choose the right zoom bias:
   *   512px tiles → bias +5 (Mapbox @2x equivalent)
   *   256px tiles → bias +4 (one zoom level lower to avoid 404s)
   *
   * Returns null before the session is ready.
   *
   * @param {string} style
   * @returns {number|null}
   */
  getTileWidth(style) {
    return this._sessions.get(style)?.tileWidth ?? null;
  }

  /**
   * On 401/403 the session is no longer valid (expired, revoked, or the
   * key was disabled). Clear all caches for the style and ask the
   * TileManager to re-queue the failed tile after we refresh.
   *
   * @param {Response} res
   * @returns {'fail'|'refresh-and-retry'}
   */
  handleFetchError(res, _key) {
    if (res && (res.status === 401 || res.status === 403)) {
      // Find the affected style — TileManager passes the URL via res.url.
      // Simpler: drop ALL session caches; the next ensureReady() call
      // for whatever style is active will recreate one. This is rare
      // (only on actual auth failures) so the cost is negligible.
      for (const style of Array.from(this._sessions.keys())) {
        this._sessions.delete(style);
        this._clearStorage(style);
      }
      return 'refresh-and-retry';
    }
    return 'fail';
  }
}
