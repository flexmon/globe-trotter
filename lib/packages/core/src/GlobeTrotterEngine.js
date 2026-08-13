/**
 * GlobeTrotterEngine.js — Framework-agnostic core API for the Globe-Trotter engine.
 *
 * This is the main entry point for embedding a GPU-accelerated 4D globe into
 * any web context: vanilla HTML, Vue.js, React.js, or Jupyter notebook widgets.
 *
 * Usage:
 *   const globe = new GlobeTrotterEngine(canvasElement, { mapboxToken: 'pk.xxx' });
 *   await globe.addLayer('Supply', 'h3f', '/data/supply.h3f');
 *   globe.setView({ lat: 39.8, lon: -98.5, distance: 2.5 });
 *   globe.play();
 */

import { GlobeRenderer } from './globe/GlobeRenderer.js';
import { initWebGPU } from './gpu/WebGPUDevice.js';
import { CameraController } from './camera/CameraController.js';
import { MercatorCameraController } from './camera/MercatorCameraController.js';
import { TimeController } from './time/TimeController.js';
import { TileManager } from './tiles/TileManager.js';
import { TileRenderer } from './tiles/TileRenderer.js';
import { MercatorTileRenderer } from './tiles/MercatorTileRenderer.js';
import { MercatorGroundRenderer } from './tiles/MercatorGroundRenderer.js';
import { SphericalProjection } from './projection/SphericalProjection.js';
import { WebMercatorProjection } from './projection/WebMercatorProjection.js';
import { MapboxProvider } from './tiles/providers/MapboxProvider.js';
import { GoogleProvider } from './tiles/providers/GoogleProvider.js';
import { LayerManager } from './layers/LayerManager.js';
import { StyleEngine } from './styles/StyleEngine.js';
import * as mat4 from './math/mat4.js';
import { UIManager } from './ui/UIManager.js';
import { FeaturePopup } from './ui/FeaturePopup.js';
import { PickController } from './picking/PickController.js';
import { CPUSpatialAdapter } from './picking/CPUSpatialAdapter.js';
import { GFBPointAdapter } from './picking/GFBPointAdapter.js';
import { H3CellAdapter } from './picking/H3CellAdapter.js';
import { parseGeoJSON } from './loaders/parseGeoJSON.js';
import { parseQuery, flattenForCPU } from './query/QueryParser.js';
import { ChartManager } from './charts/ChartManager.js';
import { ChartGPU } from './charts/ChartGPU.js';

// Deterministic color from layer name hash so repeat uploads of the same file
// get the same color while distinct uploads visually separate.
const GEOJSON_PALETTE = [
  '#00BFE6',
  '#FF6B35',
  '#7CB518',
  '#E040FB',
  '#FFD600',
  '#00E5C3',
  '#FF4081',
  '#40C4FF',
];

function _geoJSONDefaultStyle(name, kind) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const color = GEOJSON_PALETTE[hash % GEOJSON_PALETTE.length];
  if (kind === 'points') return { type: 'constant', color, opacity: 0.9 };
  if (kind === 'lines') return { type: 'constant', color, opacity: 0.85, width: 2 };
  return { type: 'constant', color, opacity: 0.6 };
}

const DEFAULT_OPTIONS = {
  mapboxToken: null,
  googleMapsApiKey: null,
  basemapProvider: null, // null | 'mapbox' | 'google' — null = auto (Google preferred, falls back to Mapbox)
  geocoderProvider: null, // null | 'mapbox' | 'google' — null = auto (Mapbox preferred)
  basemap: null, // null = use provider's DEFAULT_STYLE; otherwise a provider-specific style key
  antialias: true,
  background: [0.008, 0.016, 0.032, 1.0],
  powerPreference: 'high-performance',
  maxDpr: 2,
  autoStart: true,
  camera: {}, // passed to CameraController: { center, altitude, tilt, heading }
  time: {}, // passed to TimeController: { enabled, autoplay, speed, startOffset, loop, window }
  ui: true,
  // Which UI widgets to create. Any omitted key defaults to true (loadingScreen false).
  // Toggleable at runtime via engine.setWidgetVisible(name, bool).
  uiWidgets: {
    footer: true,
    layers: true,
    geocoder: true,
    time: true,
    legend: true,
    charts: true,
    chartToggle: true,
    projection: true,
    compass: true,
    basemap: true,
    dropZone: true,
  },
  uiContainer: null, // defaults to document.body
  onProgress: null, // (message: string, percent: number) => void
  projectionMode: 'spherical', // 'spherical' (3D globe) or 'mercator' (2D flat). Phase 2.
};

/**
 * Parse HH:MM:SS string to seconds.
 * @param {string|number} offset
 * @returns {number}
 */
function parseTimeOffset(offset) {
  if (typeof offset === 'number') return offset;
  if (typeof offset !== 'string') return 0;
  const parts = offset.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/**
 * Parse an absolute time into UNIX epoch seconds.
 * Accepts a number (already epoch seconds) or an ISO date string.
 * @param {string|number} value
 * @returns {number}
 */
function parseEpochSec(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Math.floor(new Date(value).getTime() / 1000);
  return 0;
}

/**
 * Thrown during engine init when WebGPU is required but unavailable.
 * WebGPU is a hard requirement (no WebGL2 fallback) — hosts can catch this
 * (or listen for the `'unsupported'` event) to show a "WebGPU required" message.
 */
export class WebGPURequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebGPURequiredError';
  }
}

export class GlobeTrotterEngine {
  /**
   * Create a new Globe-Trotter engine instance.
   *
   * @param {HTMLCanvasElement} canvas - The canvas element to render into
   * @param {Object} [options] - Configuration options (or parsed YAML config)
   * @param {string} [options.mapboxToken] - Mapbox access token for satellite tiles
   * @param {string} [options.basemap='satellite-v9'] - Mapbox basemap style
   * @param {Object} [options.camera] - Initial camera: { center, altitude, tilt, heading }
   * @param {Object} [options.time] - Time config: { enabled, autoplay, speed, startOffset, loop }
   * @param {Object} [options.uiWidgets] - UI widgets: { footer, layers, geocoder, time }
   * @param {Function} [options.onProgress] - Loading progress callback
   */
  constructor(canvas, options = {}) {
    if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error('[GlobeTrotter] First argument must be an HTMLCanvasElement');
    }

    this.canvas = canvas;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Legacy YAML alias: `view: '2d' | '3d'` → projectionMode. The catalog
    // schema documents `view`, but internally we standardize on projectionMode.
    if (options.view === '2d') this.options.projectionMode = 'mercator';
    else if (options.view === '3d') this.options.projectionMode = 'spherical';

    // Normalize time.startOffset from HH:MM:SS to seconds
    if (this.options.time?.startOffset !== undefined) {
      this.options.time = {
        ...this.options.time,
        startOffset: parseTimeOffset(this.options.time.startOffset),
      };
    }

    this._listeners = new Map();
    this._running = false;
    this._destroyed = false;
    this._isReady = false; // true once _initBackend resolves (see ready()/isReady)
    this._suspended = false; // true when tab is hidden
    this._userScrubbing = false;
    this._scrubCommitTime = 0; // timestamp of last scrub commit
    this.backend = 'webgpu'; // WebGPU is the only backend (D5)

    // Public capability flags. WebGPU is required (D5); _initBackend throws
    // WebGPURequiredError if it's unavailable. Set synchronously so hosts can
    // read engine.capabilities immediately after construction.
    this.capabilities = { webgpu: !!(typeof navigator !== 'undefined' && navigator.gpu) };

    // Bind handlers so we can remove them later and avoid per-frame closures
    this._visibilityHandler = () => this._onVisibilityChange();
    this._boundRenderLoop = () => this._renderLoop();

    // Stationary frame detection — skip GPU pass when nothing changed
    this._renderDirty = true; // always render first frame
    this._lastRenderCamX = NaN;
    this._lastRenderCamY = NaN;
    this._lastRenderCamZ = NaN;
    this._lastRenderTime = -1;
    this._lastRenderStyleVer = -1;

    // Initialize the WebGPU backend (required — see _initBackend).
    this._initPromise = this._initBackend();
  }

  /**
   * Async backend initialization. WebGPU is required (D5) — throws
   * WebGPURequiredError if it is unavailable; there is no WebGL2 fallback.
   */
  async _initBackend() {
    // WebGPU is required (D5). No WebGL2 fallback: fail fast with a clear,
    // catchable error so embedding hosts can surface "WebGPU required"
    // instead of silently rendering a degraded (chart-less) WebGL2 engine.
    if (!navigator.gpu) {
      this.capabilities.webgpu = false;
      this._emit('unsupported', { reason: 'webgpu-unavailable' });
      throw new WebGPURequiredError('WebGPU is required but not available in this browser.');
    }

    this._progress('Initializing WebGPU engine...', 10);
    const gpu = await initWebGPU(this.canvas);
    if (!gpu) {
      this.capabilities.webgpu = false;
      this._emit('unsupported', { reason: 'webgpu-init-failed' });
      throw new WebGPURequiredError('WebGPU adapter/device initialization failed.');
    }

    this.gpuDevice = gpu.device;
    this.gpuContext = gpu.context;
    this.gpuFormat = gpu.format;
    this.gpuDepthFormat = gpu.depthFormat;
    this._gpuDepthTexture = null;
    console.log('[GlobeTrotter] Using WebGPU backend');

    // Observe the canvas for size changes and perform an initial resize.
    // A ResizeObserver (not a window 'resize' listener) catches panel-level
    // resizes — an embedding host resizing/relayouting the panel without the
    // window changing size (e.g. a dashboard grid). It also fires for window
    // resizes, so it fully supersedes the old window listener.
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(this.canvas);
    this._resize();

    // Update browser title with backend indicator
    const baseTitle = document.title.replace(
      /\s*[|—–-]\s*(WebGL2|WebGPU|WebGL2 \+ WebGPU)\s*$/,
      ''
    );
    document.title = `${baseTitle} | WebGPU`;

    this._progress('Initializing systems...', 20);
    this._initSystems();

    this._progress('Loading globe textures...', 30);

    if (this.options.autoStart) {
      this.start();
    }

    // Backend + systems are up: the engine is ready. Hosts can await ready()
    // or listen for the 'ready' event instead of reaching for _initPromise.
    this._isReady = true;
    this._emit('ready', {});
  }

  // ──────────────────────────────────────────────
  // Initialization (private)
  // ──────────────────────────────────────────────

  _initSystems() {
    this.projectionMode = this.options.projectionMode === 'mercator' ? 'mercator' : 'spherical';
    this.projection =
      this.projectionMode === 'mercator' ? new WebMercatorProjection() : new SphericalProjection();

    this.camera = this._createCamera(this.projectionMode);
    this.time = new TimeController(this.options.time);

    // Optional declarative animation window: time.window = { start, end }
    // (each an absolute UNIX epoch-sec number or an ISO date string). Applied
    // once epoch metadata loads (see TimeController.setWindow / _deriveWindowBounds).
    const win = this.options.time?.window;
    if (win && win.start != null && win.end != null) {
      this.time.setWindow(parseEpochSec(win.start), parseEpochSec(win.end));
    }

    // Satellite tile system — build provider first so we know whether to skip
    // the Blue Marble texture (tiles will paint over it anyway, so fetching the
    // 20+ MB JPEG wastes bandwidth and memory when a tile provider is active).
    const providerName = this.options.basemapProvider || 'google';
    const provider = this._buildBasemapProvider(providerName, this.options);

    const skipBlueMarble = provider != null;
    this.globe = new GlobeRenderer(
      this.gpuDevice,
      this.gpuFormat,
      this.options.basePath || '/',
      () => this._syncMercatorGroundTexture(),
      skipBlueMarble
    );

    if (provider) {
      this.tileManager = new TileManager(provider);
      this.tileRenderer = this._createTileRenderer(this.projectionMode);

      const styles = provider.constructor.STYLES;
      if (this.options.basemap && styles?.[this.options.basemap]) {
        this.tileManager.setStyle(this.options.basemap);
      }
    } else {
      // No credentials for either provider — the sphere already falls back to
      // Blue Marble (skipBlueMarble=false above); give the Mercator (2D) view
      // the same fallback via a flat ground quad that reprojects the same
      // texture, instead of leaving it blank.
      this.mercatorGround = new MercatorGroundRenderer(
        this.gpuDevice,
        this.gpuFormat,
        this.gpuDepthFormat
      );
      this._syncMercatorGroundTexture();
    }

    // LayerManager gets the device for the GPU renderers.
    this.layerManager = new LayerManager({
      device: this.gpuDevice,
      format: this.gpuFormat,
      depthFormat: this.gpuDepthFormat,
    });

    // call engine.requestRender() to wake the render loop after async
    // data arrivals.
    this.layerManager.engine = this;
    this.layerManager.time = this.time;

    // Charts render on a separate transparent overlay canvas (total decoupling)
    this._chartOverlayCanvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, this.options.maxDpr);
    this._chartOverlayCanvas.width = this.canvas.clientWidth * dpr;
    this._chartOverlayCanvas.height = this.canvas.clientHeight * dpr;
    this._chartOverlayCanvas.style.cssText = `
            position: absolute;
            top: ${this.canvas.offsetTop}px;
            left: ${this.canvas.offsetLeft}px;
            width: ${this.canvas.clientWidth}px;
            height: ${this.canvas.clientHeight}px;
            pointer-events: none;
            background: none;
        `;
    this.canvas.parentElement.appendChild(this._chartOverlayCanvas);

    this.chartGPU = new ChartGPU(this.gpuDevice, this.gpuFormat, this._chartOverlayCanvas);
    this.chartManager = new ChartManager(this.chartGPU, this);

    this.modelMatrix = mat4.create();
    this.sunDirection = new Float32Array([0.5, 0.3, 0.8]);
    this._normalizeSun();

    // UI widgets (opt-in, default enabled)
    this.ui = null;
    this._lastHudUpdate = 0;
    if (this.options.ui) {
      const container = this.options.uiContainer || document.body;
      this.uiContainer = container; // expose for LayerManagerDialog positioning
      this.ui = new UIManager(this, container, this.options.uiWidgets);
    }

    // GeoJSON feature picking (hover + click popup)
    this._pickController = null;
    this._featurePopup = null;
    const pickContainer = this.options.uiContainer || (this.canvas.parentElement ?? document.body);
    this._featurePopup = new FeaturePopup(pickContainer);
    this._pickController = new PickController(this, this.camera, this._featurePopup);
  }

  /**
   * Build a BasemapProvider instance from `this.options.basemapProvider`.
   * Returns null (and warns) if the credentials for the requested provider
   * are missing — callers should treat that as "no tile system this run".
   *
   * @private
   * @returns {import('./tiles/providers/BasemapProvider.js').BasemapProvider|null}
   */
  _buildBasemapProvider() {
    const explicitId = this.options.basemapProvider;
    const googleKey = this.options.googleMapsApiKey;
    const mapboxToken = this.options.mapboxToken;

    if (explicitId === 'google') {
      if (!googleKey) {
        console.warn(
          '[GlobeTrotter] basemapProvider=google but no googleMapsApiKey provided — tile system disabled'
        );
        return null;
      }
      return new GoogleProvider(googleKey);
    }
    if (explicitId === 'mapbox') {
      if (!mapboxToken) {
        console.warn(
          '[GlobeTrotter] basemapProvider=mapbox but no mapboxToken provided — tile system disabled'
        );
        return null;
      }
      return new MapboxProvider(mapboxToken);
    }

    // Auto mode (no explicit provider): prefer Google, fall back to Mapbox.
    if (googleKey) return new GoogleProvider(googleKey);
    if (mapboxToken) return new MapboxProvider(mapboxToken);
    console.warn(
      '[GlobeTrotter] No basemap credentials configured — set VITE_GOOGLE_MAPS_API_KEY or VITE_MAPBOX_TOKEN'
    );
    return null;
  }

  /**
   * Push the globe's current earthTexture (1×1 placeholder, then the real
   * Blue Marble bitmap once loaded) into the Mercator ground renderer.
   * Called once synchronously right after GlobeRenderer is constructed, and
   * again from its onReady callback when the placeholder is replaced.
   * @private
   */
  _syncMercatorGroundTexture() {
    if (this.mercatorGround && this.globe?.earthTexture) {
      this.mercatorGround.setTexture(this.globe.earthTexture);
    }
    this.requestRender();
  }

  _normalizeSun() {
    const s = this.sunDirection;
    const len = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]) || 1;
    s[0] /= len;
    s[1] /= len;
    s[2] /= len;
  }

  /**
   * Build a camera matching the projection mode. Pulls existing camera state
   * (lat/lon/altitude/tilt/heading) from `this.camera` if it already exists,
   * otherwise from options.camera.
   */
  _createCamera(mode) {
    const opts = this._cameraStateFromCurrent() || this.options.camera || {};
    opts.useZeroToOneZ = true; // WebGPU NDC z ∈ [0,1]
    const Ctor = mode === 'mercator' ? MercatorCameraController : CameraController;
    return new Ctor(this.canvas, opts);
  }

  /** Snapshot existing camera state into the `{center, altitude, tilt, heading}` constructor shape. */
  _cameraStateFromCurrent() {
    if (!this.camera) return null;
    const cam = this.camera;
    const RAD2DEG = 180 / Math.PI;

    // ── Position ──────────────────────────────────────────────────────────
    // MercatorCameraController: stores lat/lng in degrees directly.
    // CameraController (spherical): stores phi (lat radians) and theta (lon
    //   radians), where theta = (lon + 180) * DEG2RAD → lon = theta*RAD2DEG - 180.
    let lat, lon;
    if (cam.lat != null && cam.lng != null) {
      // Mercator controller path
      lat = cam.lat;
      lon = cam.lng;
    } else if (cam.phi != null && cam.theta != null) {
      // Spherical controller path
      lat = cam.phi * RAD2DEG;
      lon = cam.theta * RAD2DEG - 180;
    } else {
      lat = 0;
      lon = 0;
    }

    // ── Altitude ──────────────────────────────────────────────────────────
    const altKm =
      cam.distance != null
        ? Math.max(1, (cam.distance - 1.0) * 6371.0)
        : (this.options.camera?.altitude ?? 12000);

    // ── Tilt / heading ────────────────────────────────────────────────────
    // cam.tilt and cam.heading are in RADIANS at runtime (both controllers).
    // The constructors expect DEGREES, so convert here for an exact round-trip.
    const tiltDeg = (cam.tilt ?? 0) * RAD2DEG;
    const headingDeg = (cam.heading ?? 0) * RAD2DEG;

    return {
      center: [lat, lon],
      altitude: altKm,
      tilt: tiltDeg,
      heading: headingDeg,
    };
  }

  /** Build the right tile renderer for the active backend + projection mode. */
  _createTileRenderer(mode) {
    if (!this.tileManager) return null;
    return mode === 'mercator'
      ? new MercatorTileRenderer(
          this.gpuDevice,
          this.gpuFormat,
          this.gpuDepthFormat,
          this.tileManager
        )
      : new TileRenderer(this.gpuDevice, this.gpuFormat, this.gpuDepthFormat, this.tileManager);
  }

  /**
   * Toggle between the 3D globe ('spherical') and 2D Mercator basemap ('mercator').
   * State preservation: existing camera center/altitude/tilt/heading carry over.
   *
   * Both MercatorCameraController and CameraController support tilt natively,
   * so tilt transfers directly across the toggle without animation or translation.
   * Tilt-as-angle is projection-agnostic: 30° means the same camera pitch in
   * both spherical and Mercator frames.
   *
   * @param {'spherical'|'mercator'} mode
   * @returns {boolean} true if mode changed
   */
  setProjectionMode(mode) {
    if (mode !== 'spherical' && mode !== 'mercator') {
      console.warn(`[GlobeTrotter] Unknown projection mode: ${mode}`);
      return false;
    }
    if (mode === this.projectionMode) return false;

    this._doSwapProjection(mode);
    return true;
  }

  /** Perform the actual projection swap (camera, tile renderer, projection object). */
  _doSwapProjection(mode) {
    // Swap camera. _createCamera() calls _cameraStateFromCurrent() internally so
    // lat/lon/altitude/tilt/heading carry over automatically. Detach first to
    // avoid duplicate event listeners.
    if (this.camera?.detach) this.camera.detach();
    this.camera = this._createCamera(mode);

    // Resize the new camera so viewport-dependent state is correct on first frame.
    if (this.camera.resize) this.camera.resize(this.canvas.width, this.canvas.height);

    // Swap projection strategy.
    this.projection = mode === 'mercator' ? new WebMercatorProjection() : new SphericalProjection();

    // Swap tile renderer. Clear the cache so bitmaps are re-fetched.
    if (this.tileRenderer) {
      if (this.tileRenderer.dispose) this.tileRenderer.dispose();
      if (this.tileManager) {
        this.tileManager.cache.clear();
        this.tileManager._boundsCache?.clear();
      }
      this.tileRenderer = this._createTileRenderer(mode);
    }

    this.projectionMode = mode;
    this._renderDirty = true;
    this._emit('projection-changed', { mode });
  }

  /**
   * Get the current projection mode. Pairs with {@link setProjectionMode}.
   * @returns {'spherical' | 'mercator'}
   */
  getProjectionMode() {
    return this.projectionMode;
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.options.maxDpr);
    const width = this.canvas.clientWidth * dpr;
    const height = this.canvas.clientHeight * dpr;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      if (this.camera) this.camera.resize(width, height);
      this._renderDirty = true; // force GPU re-render at new resolution

      // Sync chart overlay canvas
      if (this._chartOverlayCanvas) {
        this._chartOverlayCanvas.width = width;
        this._chartOverlayCanvas.height = height;
        this._chartOverlayCanvas.style.width = `${this.canvas.clientWidth}px`;
        this._chartOverlayCanvas.style.height = `${this.canvas.clientHeight}px`;
        this._chartOverlayCanvas.style.top = `${this.canvas.offsetTop}px`;
        this._chartOverlayCanvas.style.left = `${this.canvas.offsetLeft}px`;
      }

      // Invalidate all chart data so GPU content repositions at new plot areas
      if (this.chartManager) {
        for (const chart of this.chartManager.charts) {
          chart.dataLoaded = false;
          chart._lastPlotArea = null;
          chart._axesBuilt = false;
        }
        // Force immediate sync update on resize to prevent out-of-bounds rendering
        const et = this._lastEffectiveTime || 0;
        this.chartManager.queueEpochUpdate(et, width, height);
        while (this.chartManager.drainOneUpdate()) {
          /* drain synchronously until the queue is empty */
        }
        this._lastChartEpochMinute = Math.floor(et * 1440);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Render Loop
  // ──────────────────────────────────────────────

  /**
   * Shared stationary-frame check for both WebGL2 and WebGPU paths.
   *
   * Compares camera position, normalized time, layer style version, tile
   * pending/dirty state, layer dirty flag, and shard-paused playback against
   * the values from the previous rendered frame.  When all are unchanged the
   * current frame is "stationary" and the GPU draw can be skipped.
   *
   * Side-effects (intentional — mirror WebGPU path behaviour exactly):
   *   - Reads and clears this.layerManager.dirty
   *   - Reads and clears this.tileManager.dirty (auto-clears on read)
   *   - Updates this._lastRenderCam{X,Y,Z}, this._lastRenderTime,
   *     this._lastRenderStyleVer, and this._renderDirty when NOT stationary
   *
   * @param {object} cam            Camera state from CameraController.update()
   * @param {number} normalizedTime Current normalised playhead time [0, 1]
   * @returns {boolean}             true → frame is stationary, skip GPU draw
   */
  _checkStationary(cam, normalizedTime) {
    const cx = cam.position[0],
      cy = cam.position[1],
      cz = cam.position[2];
    const ct = cam.tilt ?? 0; // tilt changes view matrix in Mercator mode without moving cameraPosition
    const sv = this.layerManager?._styleVersion || 0;
    const tilePending = this.tileManager?.pendingCount > 0;
    const tileDirty = this.tileManager?.dirty; // auto-clears on read

    let layerDirty = false;
    if (this.layerManager?.dirty) {
      layerDirty = true;
      this.layerManager.dirty = false;
    }

    if (
      !this._renderDirty &&
      cx === this._lastRenderCamX &&
      cy === this._lastRenderCamY &&
      cz === this._lastRenderCamZ &&
      ct === this._lastRenderCamTilt &&
      normalizedTime === this._lastRenderTime &&
      sv === this._lastRenderStyleVer &&
      !tilePending &&
      !tileDirty &&
      !layerDirty &&
      !this._shardPausedPlayback
    ) {
      return true; // stationary — caller should skip GPU draw
    }

    // Not stationary — record current state for next frame comparison
    this._lastRenderCamX = cx;
    this._lastRenderCamY = cy;
    this._lastRenderCamZ = cz;
    this._lastRenderCamTilt = ct;
    this._lastRenderTime = normalizedTime;
    this._lastRenderStyleVer = sv;
    this._renderDirty = false; // cleared; re-set by any dirty source

    return false;
  }

  _renderLoop() {
    if (this._destroyed || !this._running || this._suspended) return;

    const now = performance.now();
    const normalizedTime = this.time.update();
    const cam = this.camera.update();

    // rAF-throttled GeoJSON hover picking
    if (this._pickController) this._pickController.tick();

    // Point sun at camera position for midday lighting
    const cx = cam.position[0],
      cy = cam.position[1],
      cz = cam.position[2];
    const clen = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
    this.sunDirection[0] = cx / clen;
    this.sunDirection[1] = cy / clen;
    this.sunDirection[2] = cz / clen;

    // Terrain displacement control
    if (this.tileManager) {
      this.globe.terrainScale = 0;
    } else {
      const dist = this.camera.distance;
      const closeup = Math.max(0, 1.0 - (dist - 1.0) / 2.0);
      this.globe.terrainScale = 0.018 + closeup * 0.06;
    }

    this._renderWebGPU(cam, normalizedTime, now);
    requestAnimationFrame(this._boundRenderLoop);
  }

  // ─── WebGPU Render ───

  /**
   * Ensure the depth texture matches the current canvas size.
   * Creates or recreates on resize.
   */
  _ensureDepthTexture() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this._gpuDepthTexture && this._gpuDepthW === w && this._gpuDepthH === h) {
      return this._gpuDepthTexture;
    }
    if (this._gpuDepthTexture) this._gpuDepthTexture.destroy();
    this._gpuDepthTexture = this.gpuDevice.createTexture({
      label: 'Depth texture',
      size: [w, h],
      format: this.gpuDepthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this._gpuDepthW = w;
    this._gpuDepthH = h;
    return this._gpuDepthTexture;
  }

  /**
   * WebGPU render path — called from _renderLoop when backend is 'webgpu'.
   */
  _renderWebGPU(cam, normalizedTime, now) {
    const device = this.gpuDevice;
    const context = this.gpuContext;

    // ─── Stationary frame detection ───
    // Skip entire GPU pass when camera, time, and data are unchanged.
    // Camera inertia (thetaVel/phiVel != 0), playing time, pending tile
    // loads, style changes, and shard swaps all correctly force re-render.
    const cx = cam.position[0],
      cy = cam.position[1],
      cz = cam.position[2];
    const ct = cam.tilt ?? 0; // tilt changes view matrix without moving cameraPosition
    const sv = this.layerManager?._styleVersion || 0;
    const tilePending = this.tileManager?.pendingCount > 0;
    const tileDirty = this.tileManager?.dirty; // auto-clears on read

    let layerDirty = false;
    if (this.layerManager?.dirty) {
      layerDirty = true;
      this.layerManager.dirty = false;
    }

    if (
      !this._renderDirty &&
      cx === this._lastRenderCamX &&
      cy === this._lastRenderCamY &&
      cz === this._lastRenderCamZ &&
      ct === this._lastRenderCamTilt &&
      normalizedTime === this._lastRenderTime &&
      sv === this._lastRenderStyleVer &&
      !tilePending &&
      !tileDirty &&
      !layerDirty &&
      !this._shardPausedPlayback
    ) {
      // Frame identical — skip GPU work, still update UI/FPS at throttled rate
      this._frameCount++;
      const fps = this._computeFps(now);
      const throttled = now - this._lastHudUpdate > 500;
      if (throttled) {
        this._lastHudUpdate = now;
        if (this.ui) {
          this.ui.update({ fps: Math.round(fps), drawCalls: 0, throttled: true }, normalizedTime);
        }
      }
      // Still check shard loading status during frame-skip
      // so auto-resume works when shards finish loading
      this._updateShardLoadingIndicator(normalizedTime);
      return;
    }
    this._lastRenderCamX = cx;
    this._lastRenderCamY = cy;
    this._lastRenderCamZ = cz;
    this._lastRenderCamTilt = ct;
    this._lastRenderTime = normalizedTime;
    this._lastRenderStyleVer = sv;
    this._renderDirty = false; // cleared; will be set if any dirty source fires

    const colorTexture = context.getCurrentTexture();
    const colorView = colorTexture.createView();
    const depthView = this._ensureDepthTexture().createView();

    const commandEncoder = device.createCommandEncoder({ label: 'Frame' });

    // 0. Compute pass: H3 epoch scatter (before render pass).
    if (this.layerManager && this.layerManager.layers.size > 0) {
      this.layerManager.prepareH3Compute(
        commandEncoder,
        normalizedTime,
        this.time?.speed || 60,
        cam.lookPoint
      );
    }

    const isMercator = this.projection.mode === 'mercator';
    // In mercator mode the UV sphere globe is meaningless — use a flat
    // ocean clear so basemap tiles paint over a sensible background.
    const clearColor = isMercator
      ? { r: 0.85, g: 0.88, b: 0.92, a: 1.0 }
      : {
          r: this.options.background[0],
          g: this.options.background[1],
          b: this.options.background[2],
          a: this.options.background[3],
        };

    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorView,
          clearValue: clearColor,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // 1. Globe — spherical only. In Mercator mode with no tile provider, draw
    // the flat Blue Marble ground quad instead so the 2D projection falls
    // back the same way the sphere already does.
    if (!isMercator) {
      this.globe.render(
        passEncoder,
        this.modelMatrix,
        cam.view,
        cam.projection,
        this.sunDirection,
        cam.position,
        normalizedTime
      );
    } else if (this.mercatorGround) {
      this.mercatorGround.render(passEncoder, this.camera, this.canvas.width, this.canvas.height);
    }

    // 2. Satellite tiles
    let tileDrawCalls = 0;
    if (this.tileRenderer) {
      this.tileManager.setFrameTime(now);
      if (isMercator) {
        tileDrawCalls = this.tileRenderer.render(
          passEncoder,
          this.camera,
          this.canvas.width,
          this.canvas.height,
          1.0
        );
      } else {
        tileDrawCalls = this.tileRenderer.render(
          passEncoder,
          cam.view,
          cam.projection,
          this.sunDirection,
          cam.position,
          this.camera.distance,
          cam.lookPoint,
          cam.tilt
        );
      }
      if (this._frameCount % 60 === 0) {
        this.tileRenderer.cleanup();
      }
    }

    // 3. H3Flex layers — both spherical and Mercator modes supported.
    // GFB/DGFlex Mercator support lands in Phase 5.
    let layerDrawCalls = 0;
    let effectiveTime = normalizedTime;
    if (this.layerManager && this.layerManager.layers.size > 0) {
      // Single polymorphic dispatch — each renderer's render(projection, ctx)
      // picks the spherical vs Mercator path from projection.mode.
      const ctx = {
        passEncoder,
        viewMatrix: cam.view,
        projMatrix: cam.projection,
        cameraPosition: cam.position,
        camera: this.camera,
        viewportW: this.canvas.width,
        viewportH: this.canvas.height,
        normalizedTime,
        playbackSpeed: this.time?.speed || 60,
      };
      const result = this.layerManager.render(this.projection, ctx);
      layerDrawCalls = result.drawCalls;
      effectiveTime = result.effectiveTime;
    }

    passEncoder.end();
    device.queue.submit([commandEncoder.finish()]);

    // Charts are completely decoupled — rendered on separate overlay canvas
    // via _chartLoop(). Store effectiveTime for the chart loop to read.
    this._lastEffectiveTime = effectiveTime;

    // Stall-rewind: if any loader stalled, rewind the time controller
    // Skip during shard transitions (heavy frame with temporary time mismatch)
    const scrubGrace = performance.now() - (this._scrubCommitTime || 0) < 3000;
    const transitioning = this.layerManager?._shardTransitionFrame;
    if (effectiveTime < normalizedTime && !this._userScrubbing && !scrubGrace && !transitioning) {
      this.time.scrubTo(effectiveTime);
    }

    this._frameCount++;
    const fps = this._computeFps(now);
    const totalDrawCalls = 1 + tileDrawCalls + layerDrawCalls;

    const throttled = now - this._lastHudUpdate > 500;
    if (throttled) this._lastHudUpdate = now;

    // Show effectiveTime in UI during stalls (matches WebGL2 path)
    const uiTime = this._userScrubbing || scrubGrace ? normalizedTime : effectiveTime;
    if (this.ui) {
      this.ui.update({ fps: Math.round(fps), drawCalls: totalDrawCalls, throttled }, uiTime);
    }

    // Shard loading progress indicator
    this._updateShardLoadingIndicator(normalizedTime);

    this._emit('frame', {
      time: now,
      normalizedTime: effectiveTime,
      fps,
      drawCalls: totalDrawCalls,
      features: this.layerManager?.totalFeatures || 0,
    });

    this._emitViewAndTimeChanges();
  }

  /**
   * Emit `viewChanged`/`timeChanged` when the camera view or the playhead epoch
   * has actually changed since the last emit (so listeners aren't spammed every
   * frame while stationary). Called once per rendered frame.
   * @private
   */
  _emitViewAndTimeChanges() {
    if (this._listeners.get('viewChanged')?.size) {
      const v = this.getView();
      const p = this._lastEmittedView;
      if (
        !p ||
        v.lat !== p.lat ||
        v.lon !== p.lon ||
        v.distance !== p.distance ||
        v.heading !== p.heading ||
        v.tilt !== p.tilt
      ) {
        this._lastEmittedView = v;
        this._emit('viewChanged', v);
      }
    }
    if (this._listeners.get('timeChanged')?.size) {
      const epochSec = this.time.getCurrentEpoch();
      if (epochSec !== this._lastEmittedEpoch) {
        this._lastEmittedEpoch = epochSec;
        this._emit('timeChanged', { epochSec, normalized: this.time.getNormalized() });
      }
    }
  }

  _computeFps(now) {
    if (!this._lastFrameTime) {
      this._lastFrameTime = now;
      this._smoothFps = 60;
      return 60;
    }
    const dt = now - this._lastFrameTime;
    this._lastFrameTime = now;
    if (dt <= 0) return this._smoothFps || 60;
    const instantFps = Math.min(1000 / dt, 240); // Cap at 240Hz (no monitor exceeds this)
    // Exponential moving average — α=0.1 for stable readout
    this._smoothFps = this._smoothFps * 0.9 + instantFps * 0.1;
    return this._smoothFps;
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — Lifecycle
  // ──────────────────────────────────────────────

  /**
   * Strongly request a re-render next frame.
   * Useful for async data loaders or UI changes that dirty the render state
   * without triggering native camera interactions.
   */
  requestRender() {
    this._renderDirty = true;
  }

  /**
   * Resolve once the engine has finished initializing (WebGPU backend + core
   * systems up). The supported way for hosts to wait for readiness — replaces
   * reaching for the private `_initPromise`.
   *
   * Rejects with {@link WebGPURequiredError} if WebGPU is unavailable or init
   * fails (also surfaced via the `'unsupported'` event). Safe to await multiple
   * times; resolves immediately once already ready.
   *
   * @returns {Promise<void>}
   */
  async ready() {
    await this._initPromise;
  }

  /**
   * Whether the engine has finished initializing. `false` until {@link ready}
   * resolves; never becomes `true` if init failed.
   * @returns {boolean}
   */
  get isReady() {
    return this._isReady;
  }

  /**
   * Whether the engine has been destroyed. Once `true`, the instance is inert
   * and should be discarded. Replaces host reliance on the private `_destroyed`.
   * @returns {boolean}
   */
  get isDestroyed() {
    return this._destroyed;
  }

  /** Start the render loop. */
  start() {
    if (this._running) return;
    this._running = true;
    this._frameCount = 0;
    document.addEventListener('visibilitychange', this._visibilityHandler);
    this._renderLoop();
    this._startChartLoop();
  }

  /** Stop the render loop. */
  stop() {
    this._running = false;
  }

  /**
   * Independent chart render loop — totally decoupled from the globe.
   * Runs its own rAF loop, renders on the overlay canvas, and handles
   * epoch detection + data computation independently.
   */
  _startChartLoop() {
    if (!this.chartManager || !this.chartGPU) return;
    const chartLoop = () => {
      if (!this._running || this._suspended) {
        requestAnimationFrame(chartLoop);
        return;
      }
      if (!this.chartManager.charts.length) {
        requestAnimationFrame(chartLoop);
        return;
      }

      const et = this._lastEffectiveTime || 0;
      const w = this._chartOverlayCanvas.width;
      const h = this._chartOverlayCanvas.height;

      // Epoch change → queue chart updates and drain all at once.
      // Draining all charts per epoch change (not one per frame) prevents
      // queue starvation when time advances faster than one chart per frame —
      // which happens with short datasets (e.g. 2 epochs) at normal playback
      // speed, causing the queue to reset every frame before histograms get
      // their turn. With typical chart counts (4–8 charts × ~0.3ms each),
      // processing all at once adds < 3ms per epoch change — well within budget.
      const epochMinute = Math.floor(et * 1440);
      if (epochMinute !== this._lastChartEpochMinute) {
        this._lastChartEpochMinute = epochMinute;
        this.chartManager.queueEpochUpdate(et, w, h);
        while (this.chartManager.drainOneUpdate()) {
          /* empty */
        }
      } else {
        // Between epoch changes drain any residual one-at-a-time (safety net)
        this.chartManager.drainOneUpdate();
      }

      // Render charts on overlay canvas (own command encoder)
      try {
        this.chartManager.render(et, w, h);
      } catch (e) {
        console.error('[GlobeTrotter] Chart render error:', e);
      }

      requestAnimationFrame(chartLoop);
    };
    requestAnimationFrame(chartLoop);
  }

  /**
   * Handle tab visibility changes.
   * Suspends the render loop + time controller when hidden,
   * cleanly resumes when visible — no catch-up burst.
   */
  _onVisibilityChange() {
    if (document.hidden) {
      // Tab went to background — suspend
      this._suspended = true;
      this.time.suspend();
      console.debug('[GlobeTrotter] Tab hidden — render loop suspended');
    } else {
      // Tab returned — clean resume
      this._suspended = false;
      this._lastFrameTime = null; // reset FPS computation
      this.time.resume();
      console.debug('[GlobeTrotter] Tab visible — render loop resumed');
      // Restart the render loop (it stopped scheduling rAF while suspended)
      if (this._running) {
        requestAnimationFrame(this._boundRenderLoop);
      }
    }
  }

  /**
   * Destroy the engine and free all GPU resources. Idempotent — calling it
   * again after the first is a no-op. After destroy the instance is inert
   * ({@link isDestroyed} is `true`) and should be discarded.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._isReady = false;
    this._running = false;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    document.removeEventListener('visibilitychange', this._visibilityHandler);
    this._listeners.clear();

    // Free all GPU resources
    if (this.tileRenderer) {
      this.tileRenderer.dispose();
      this.tileRenderer = null;
    }
    if (this.tileManager) {
      this.tileManager.cache.clear();
      this.tileManager._boundsCache.clear();
      this.tileManager._tilePool.length = 0;
      this.tileManager = null;
    }
    // Remove all layers (disposes renderers + styles + sharded loaders)
    if (this.layerManager) {
      for (const name of this.layerManager.layers.keys()) {
        this.layerManager.removeLayer(name);
      }
      this.layerManager = null;
    }
    // Globe textures + buffers
    if (this.globe?.dispose) this.globe.dispose();
    this.globe = null;
    if (this.mercatorGround?.dispose) this.mercatorGround.dispose();
    this.mercatorGround = null;

    // WebGPU-specific cleanup
    if (this._gpuDepthTexture) {
      this._gpuDepthTexture.destroy();
      this._gpuDepthTexture = null;
    }
    if (this.gpuDevice) {
      this.gpuDevice.destroy();
      this.gpuDevice = null;
    }

    if (this.camera) {
      this.camera.destroy?.();
      this.camera = null;
    }

    if (this.chartManager) {
      this.chartManager.dispose();
      this.chartManager = null;
    }

    if (this._chartOverlayCanvas) {
      this._chartOverlayCanvas.remove();
      this._chartOverlayCanvas = null;
      this._chartOverlayGL = null;
    }

    if (this.ui) {
      this.ui.destroy();
      this.ui = null;
    }

    if (this._pickController) {
      this._pickController.destroy();
      this._pickController = null;
    }
    if (this._featurePopup) {
      this._featurePopup.destroy();
      this._featurePopup = null;
    }
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — Data Layers
  // ──────────────────────────────────────────────

  /**
   * Report progress via the onProgress callback (if provided).
   * @param {string} message
   * @param {number} percent - 0-100
   */
  _progress(message, percent) {
    if (typeof this.options.onProgress === 'function') {
      this.options.onProgress(message, percent);
    }
    // Also feed the library's LoadingScreen widget (if active)
    if (this.ui?.loadingScreen) {
      this.ui.loadingScreen.update(message, percent);
    }
  }

  /** Sync epoch range from loaded layers into TimeController. */
  _syncEpochRange() {
    const epochDuration = this.layerManager.getEpochDuration();
    if (epochDuration > 0) {
      this.time.setEpochRange(
        this.layerManager.maxEpochCount,
        this.layerManager.maxEpochInterval,
        this.layerManager.startHourUTC ?? 0,
        this.layerManager.startTimestamp
      );
      // Refresh time panel labels now that epoch range is known
      if (this.ui?.timePanel) {
        this.ui.timePanel.updateLabels();
      }
    }
  }

  /**
   * Add a data layer from a URL.
   * @param {string} name - Layer display name
   * @param {'h3f'|'gfb'} type - Data format
   * @param {string} url - URL to fetch binary data from
   * @param {Object} [options] - { style, styleUrl }
   * @returns {Promise<void>}
   */
  async addLayer(name, type, url, options = {}) {
    await this.layerManager.addLayer(name, type, url, options);
    this._syncEpochRange();
    this._registerFlexPicking(name, options);
    this._emit('layerAdded', { name, type });
  }

  /**
   * Register a decoded Flex layer for hover/click picking, if its `interaction`
   * config enables it. Self-gating: no-op unless interaction opts in and the
   * layer is a supported pickable kind (currently GFB points, geomType 1/2).
   * @param {string} name
   * @param {object} options  Layer options; reads options.interaction.
   */
  _registerFlexPicking(name, options = {}) {
    if (!this._pickController) return;
    const interaction = options.interaction;
    if (!interaction) return;
    const hover = interaction.hover === true;
    const click = interaction.click === true;
    if (!hover && !click) return; // explicit opt-in only

    const data = this.layerManager.layers.get(name)?.data;
    if (!data) return;

    let adapter, kind, sourceType;
    if (data.cellIds) {
      // H3F cell layer (surface cells — CPU screen→cell picking).
      adapter = new H3CellAdapter({ engine: this, layerName: name });
      kind = 'cells';
      sourceType = 'h3f';
    } else if (data.geomType === 1 || data.geomType === 2) {
      // GFB points (1 = POINT, 2 = MULTIPOINT).
      adapter = new GFBPointAdapter({ engine: this, layerName: name });
      kind = 'points';
      sourceType = 'gfb';
    } else {
      return; // GFB lines/polygons and DGF not yet pickable
    }

    const popup = interaction.popup || {};
    this._pickController.registerLayer(name, {
      kind,
      sourceType,
      hover,
      click,
      picker: adapter,
      decode: adapter.decode,
      popupFields: popup.fields,
      popupGroups: popup.groups,
      layout: popup.layout,
      title: popup.title,
    });
  }

  /**
   * Add a sharded H3Flex layer.
   * @param {string} name
   * @param {string} manifestUrl
   * @param {Object} [options]
   * @returns {Promise<void>}
   */
  async addShardedLayer(name, manifestUrl, options = {}) {
    await this.layerManager.addShardedLayer(name, manifestUrl, options);
    this._syncEpochRange();
    this._registerFlexPicking(name, options);
    this._emit('layerAdded', { name, type: 'h3f-sharded' });
  }

  /**
   * Add a sharded DGFlex layer.
   * @param {string} name
   * @param {string} manifestUrl
   * @param {Object} [options]
   * @returns {Promise<void>}
   */
  async addShardedDGFlexLayer(name, manifestUrl, options = {}) {
    await this.layerManager.addShardedDGFlexLayer(name, manifestUrl, options);
    this._syncEpochRange();
    this._emit('layerAdded', { name, type: 'dgf-sharded' });
  }

  /**
   * Add a sharded GFB layer.
   * @param {string} name
   * @param {string} manifestUrl
   * @param {Object} [options]
   * @returns {Promise<void>}
   */
  async addShardedGFBLayer(name, manifestUrl, options = {}) {
    await this.layerManager.addShardedGFBLayer(name, manifestUrl, options);
    this._syncEpochRange();
    this._registerFlexPicking(name, options);
    this._emit('layerAdded', { name, type: 'gfb-sharded' });
  }

  /**
   * Add a streaming GFB layer (live data with ring buffer).
   * Switches TimeController to live mode and connects the live edge callback.
   * @param {string} name
   * @param {string} manifestUrl
   * @param {Object} [options] - { style, ttl, pollInterval }
   * @returns {Promise<void>}
   */
  async addStreamingGFBLayer(name, manifestUrl, options = {}) {
    await this.layerManager.addStreamingGFBLayer(name, manifestUrl, options);

    // Switch TimeController to live mode with manifest-driven params
    const layer = this.layerManager.layers.get(name);
    const manifest = layer?.streamingLoader?.manifest;
    const ttlSec =
      layer?.streamingLoader?._ttlSeconds ||
      (manifest?.live?.ttl ? layer.streamingLoader._parseTTL(manifest.live.ttl) : 3600);
    const epochSec =
      layer?.streamingLoader?._shardEpochInterval || manifest?.live?.epochInterval || 60;
    this.time.setLiveMode(ttlSec, epochSec);

    // Connect the streaming loader's live edge callback to TimeController
    if (layer?.streamingLoader) {
      // Store TimeController reference for per-frame shard selection
      layer.streamingLoader._timeController = this.time;
      layer.streamingLoader._onLiveEdgeAdvance = (liveEdgeTs, oldestTs, totalEpochs) => {
        this.time.advanceLiveEdge(liveEdgeTs, oldestTs, totalEpochs);
      };
      // Trigger initial live edge update — load() already bootstrapped the ring
      // but _onLiveEdgeAdvance wasn't wired yet, so replay the current state
      layer.streamingLoader._updateLiveEdge();
    }

    this._registerFlexPicking(name, options);
    this._emit('layerAdded', { name, type: 'gfb-streaming' });
  }

  /**
   * Load all layers and settings from a parsed YAML config object.
   * This is the primary entry point for YAML-driven initialization.
   *
   * @param {Object} config - Parsed globe-config.yaml content
   * @param {Object[]} config.layers - Array of layer definitions
   * @returns {Promise<{ ok: boolean, layersLoaded: number, layersFailed: number, errors: string[] }>}
   */
  async loadConfig(config) {
    // Store full config for UI dialogs to read
    this.config = config;

    // Apply basemap block if present — sets provider (google/mapbox) and style
    if (config.basemap) {
      this._applyBasemapConfig(config.basemap);
    }

    // In WebGPU mode, charts aren't available yet (but layers are)
    if (!this.layerManager) {
      console.debug('[GlobeTrotter] No LayerManager available');
      this._progress('Ready (WebGPU)', 100);
      if (this.ui) this.ui.hideLoadingScreen();
      return { ok: true, layersLoaded: 0, layersFailed: 0, errors: [] };
    }

    const layers = config.layers || [];
    const errors = [];
    let loaded = 0;

    this._progress('Loading data layers...', 50);

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const progress = 50 + ((i + 1) / layers.length) * 40;
      this._progress(`Loading ${layer.name}...`, progress);
      this._emit('layerLoad', { name: layer.name, status: 'loading' });

      const layerOpts = {};
      if (layer.style) layerOpts.style = layer.style;
      if (layer.styles) layerOpts.styles = layer.styles;
      if (layer.extrusionScale !== undefined) layerOpts.extrusionScale = layer.extrusionScale;
      if (layer.shardCacheMB != null) layerOpts.maxResidentBytes = layer.shardCacheMB * 1024 * 1024;
      if (layer.metrics) layerOpts.metrics = layer.metrics;
      if (layer.activeMetric) layerOpts.activeMetric = layer.activeMetric;
      if (layer.symbol) layerOpts.symbol = layer.symbol;
      if (config.camera?.center) layerOpts.cameraCenter = config.camera.center;
      if (layer.heading) layerOpts.heading = layer.heading;
      // Forward picking/popup config; consumed when layers register with PickController (Stage C+).
      if (layer.interaction) layerOpts.interaction = layer.interaction;
      if (layer.metricAttributes) layerOpts.metricAttributes = layer.metricAttributes;
      if (layer.style_presets) layerOpts.stylePresets = layer.style_presets;
      try {
        // All layer types now loadable in WebGPU mode
        // (H3F/GFB have GPU renderers; MFB is geometry-free data)
        if (layer.type === 'h3f-sharded') {
          await this.addShardedLayer(layer.name, layer.url, layerOpts);
        } else if (layer.type === 'dgf-sharded') {
          await this.addShardedDGFlexLayer(layer.name, layer.url, layerOpts);
        } else if (layer.type === 'gfb-sharded') {
          await this.addShardedGFBLayer(layer.name, layer.url, layerOpts);
        } else if (layer.type === 'gfb-streaming') {
          // Forward streaming-specific options
          if (layer.ttl) layerOpts.ttl = layer.ttl;
          if (layer.poll_interval) layerOpts.pollInterval = layer.poll_interval;
          await this.addStreamingGFBLayer(layer.name, layer.url, layerOpts);
        } else if (layer.type === 'h3f-virtual') {
          // Virtual H3 layer: query-driven from FlexDB (no shard files)
          const epochIntervalSec = layer.epoch_interval_seconds ?? 60;
          const vOpts = {
            flexdbUrl: layer.flexdb_url,
            table: layer.table,
            h3Field: layer.h3_field,
            metrics: layer.metrics || [],
            resolution: layer.resolution ?? 5,
            aggregation: layer.aggregation || 'SUM',
            epochIntervalSeconds: epochIntervalSec,
            epochWindowMinutes: layer.epoch_window_minutes ?? 1440,
            activeMetric: layer.active_metric || (layer.metrics || [])[0],
            style: layer.style || null,
            metrics_styles: layer.metrics_styles || {},
            extrusionScale: layer.extrusionScale,
            meshUrl: layer.mesh_url || null,
            extraWhere: layer.extra_where || null,
            epochCacheSize: layer.epoch_cache_size || 30,
            findLatest: layer.find_latest ?? true,
          };

          // Critical: Lock TimeController into live mode to stop the playhead from free-running
          // AND establish proper windowDur BEFORE the layer issues its first findLatest ping
          if (vOpts.findLatest && this.time?.setLiveMode) {
            const ttlSec = (layer.epoch_window_minutes ?? 1440) * 60;
            this.time.setLiveMode(ttlSec, epochIntervalSec);
          }

          await this.layerManager.addVirtualH3Layer(layer.name, vOpts);

          this._syncEpochRange();
          this._emit('layerAdded', { name: layer.name, type: 'h3f-virtual' });
        } else if (layer.type === 'mfb') {
          await this.layerManager.addMFBLayer(layer.name, layer.url, layerOpts);
        } else {
          await this.addLayer(layer.name, layer.type, layer.url, layerOpts);
        }
        // Apply visibility from config
        if (layer.visible === false) {
          this.layerManager.setLayerVisibility(layer.name, false);
        }
        // Apply filter from config (e.g. filter: "demand_mbps > 5")
        if (layer.filter) {
          this.setFilter(layer.name, layer.filter);
        }
        loaded++;
        this._emit('layerLoad', { name: layer.name, status: 'ready' });
      } catch (err) {
        const msg = `Layer "${layer.name}": ${err.message}`;
        errors.push(msg);
        console.error(`[GlobeTrotter] ${msg}`);
        this._emit('layerLoad', { name: layer.name, status: 'error', error: err });
        this._emit('error', { error: err });
      }
    }

    // Load charts from config
    try {
      if (config.charts && this.chartManager) {
        this.chartManager.loadFromConfig(config.charts);
        // Show the chart toggle button now that charts exist
        if (this.ui) this.ui._showChartToggle();
      }
    } catch (err) {
      const errDiv = document.createElement('div');
      errDiv.style.cssText =
        'position:absolute;top:200px;left:20px;background:red;color:white;padding:20px;z-index:9999;font-family:monospace;';
      errDiv.textContent = 'Chart Load Error: ' + err.message + '\n' + err.stack;
      (this.uiContainer || document.body).appendChild(errDiv);
      console.error('Chart Load Error', err);
    }

    const ok = errors.length === 0;
    this._progress(ok ? 'Ready!' : `Ready (${errors.length} layer(s) failed)`, 100);

    // Auto-hide the library's loading screen now that layers are loaded
    if (this.ui) {
      this.ui.hideLoadingScreen();
    }

    // Force a render on the very next frame so newly-loaded layers are
    // visible immediately — without waiting for the user to interact.
    this._renderDirty = true;

    return { ok, layersLoaded: loaded, layersFailed: errors.length, errors };
  }

  /**
   * Add a GeoJSON layer from a parsed GeoJSON object or JSON string.
   * Mixed-geometry FeatureCollections auto-split into per-kind sub-layers
   * named "<name> (points)", "<name> (lines)", "<name> (polygons)".
   *
   * @param {string} name - Base layer name
   * @param {object|string} geojson - GeoJSON FeatureCollection, Feature, or Geometry
   * @param {object} [opts] - { style } per-layer style override
   * @returns {string[]} Names of the created sub-layers
   */
  addGeoJSONLayer(name, geojson, opts = {}) {
    const subLayers = parseGeoJSON(geojson);
    const created = [];

    // Optional picking/popup config, shared across the layer's sub-layers.
    const interaction = opts.interaction || {};
    const hover = interaction.hover === true;
    const click = interaction.click === true;
    const popup = interaction.popup || {};

    for (const { kind, data } of subLayers) {
      const subName = subLayers.length === 1 ? name : `${name} (${kind})`;
      const style = opts.style || _geoJSONDefaultStyle(name, kind);
      this.layerManager.addInMemoryLayer(subName, kind, data, { style });

      if (this._pickController) {
        this._pickController.registerLayer(subName, {
          kind,
          sourceType: 'geojson',
          hover,
          click,
          picker: new CPUSpatialAdapter(data, kind),
          popupFields: popup.fields,
          popupGroups: popup.groups,
          layout: popup.layout,
          title: popup.title,
        });
      }

      created.push(subName);
      this._emit('layerAdded', { name: subName, type: 'geojson', kind });
    }

    this._renderDirty = true;
    return created;
  }

  /**
   * Remove a data layer.
   * @param {string} name - Layer name
   */
  removeLayer(name) {
    this.layerManager.removeLayer(name);
    if (this._pickController) this._pickController.deregisterLayer(name);
    this._emit('layerRemoved', { name });
  }

  /**
   * Hot-swap the style for a named layer.
   * @param {string} name - Layer name
   * @param {Object} styleSpec - Style spec (from JSON or StyleEngine.ramp() etc.)
   */
  setLayerStyle(name, styleSpec) {
    this.layerManager.setLayerStyle(name, styleSpec);
  }

  /**
   * Set visibility of a named layer.
   * @param {string} name - Layer name
   * @param {boolean} visible
   */
  setLayerVisibility(name, visible) {
    this.layerManager.setLayerVisibility(name, visible);
  }

  /**
   * Toggle visibility of a named layer.
   * @param {string} name - Layer name
   * @returns {boolean} New visibility state
   */
  toggleLayerVisibility(name) {
    return this.layerManager.toggleLayerVisibility(name);
  }

  /**
   * Apply a filter expression to a named layer.
   * Updates both the GPU renderer and the CPU picking predicate so that
   * filtered-out features are not returned by hover/click picking.
   * @param {string} name - Layer name
   * @param {string} queryStr - Filter expression (e.g. "population > 1000000")
   */
  setFilter(name, queryStr) {
    this.layerManager.setFilter(name, queryStr);
    if (this._pickController) {
      const layer = this.layerManager.layers.get(name);
      if (layer?.data) {
        const schema = {
          staticColumns: layer.data.staticColumns || {},
          temporalColumns: layer.data.temporalColumns || {},
          dictionary: layer.data.dictionary || [],
          schemaList: layer.data.schema || [],
        };
        const spec = parseQuery(queryStr, schema);
        this._pickController.setLayerFilterFn(name, spec ? flattenForCPU(spec) : null);
      }
    }
  }

  /**
   * Clear the active filter on a named layer.
   * @param {string} name - Layer name
   */
  clearFilter(name) {
    this.layerManager.clearFilter(name);
    if (this._pickController) {
      this._pickController.setLayerFilterFn(name, null);
    }
  }

  /**
   * Get the active filter expression on a named layer, or null if none.
   * Pairs with {@link setFilter}/{@link clearFilter} — the returned string can
   * be passed straight back to `setFilter`.
   * @param {string} name - Layer name
   * @returns {string | null}
   */
  getFilter(name) {
    return this.layerManager?.layers.get(name)?.activeFilter ?? null;
  }

  /**
   * Get detailed info about all loaded layers.
   * @returns {Array<{ name, type, visible, featureCount, epochCount, styleSpec }>}
   */
  getLayerInfo() {
    return this.layerManager.getLayerInfo();
  }

  /**
   * Get the names of all loaded layers.
   * @returns {string[]}
   */
  getLayerNames() {
    return Array.from(this.layerManager.layers.keys());
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — Charts
  // ──────────────────────────────────────────────

  /**
   * Add a GPU chart panel.
   * @param {string} name - Chart display name
   * @param {Object} config - Chart definition (type, source, attribute, etc.)
   */
  addChart(name, config) {
    if (this.chartManager) {
      this.chartManager.addChart({ name, ...config });
      if (this.ui) this.ui._showChartToggle();
    }
  }

  /**
   * Remove a chart panel.
   * @param {string} name
   */
  removeChart(name) {
    if (this.chartManager) {
      this.chartManager.removeChart(name);
    }
  }

  /**
   * Set visibility of a chart panel.
   * @param {string} name
   * @param {boolean} visible
   */
  setChartVisibility(name, visible) {
    if (this.chartManager) {
      this.chartManager.setVisibility(name, visible);
    }
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — Camera
  // ──────────────────────────────────────────────

  /**
   * Set the camera view. lat/lon/distance are applied via the camera's `flyTo`
   * (immediate on Mercator; eased on the spherical globe — the target is set
   * exactly). Optional `heading`/`tilt` (degrees) apply to the spherical camera.
   * @param {Object} view - { lat, lon, distance, heading?, tilt? } (heading/tilt in degrees)
   */
  setView({ lat, lon, distance, heading, tilt }) {
    const cam = this.camera;
    if (lat !== undefined || lon !== undefined || distance !== undefined) {
      const cur = this.getView();
      cam.flyTo(
        lat !== undefined ? lat : cur.lat,
        lon !== undefined ? lon : cur.lon,
        distance !== undefined ? distance : cur.distance
      );
    }
    if (heading !== undefined && cam.targetHeading !== undefined) {
      cam.targetHeading = (heading * Math.PI) / 180;
    }
    if (tilt !== undefined && cam.targetTilt !== undefined) {
      cam.targetTilt = (tilt * Math.PI) / 180;
    }
  }

  /**
   * Get the current camera view. Heading/tilt are in degrees (0 when the
   * active camera has no heading/tilt, e.g. Mercator).
   * @returns {{ lat: number, lon: number, distance: number, heading: number, tilt: number }}
   */
  getView() {
    const cam = this.camera;
    const RAD2DEG = 180 / Math.PI;
    let lat, lon;
    if (cam.targetPhi !== undefined) {
      // Spherical camera: theta/phi in radians (theta = (lon+180)°).
      lat = cam.targetPhi * RAD2DEG;
      lon = cam.targetTheta * RAD2DEG - 180;
    } else {
      // Mercator camera: lat/lng in degrees.
      lat = cam.lat;
      lon = cam.lng;
    }
    return {
      lat,
      lon,
      distance: cam.targetDistance ?? cam.distance,
      heading: (cam.targetHeading ?? 0) * RAD2DEG,
      tilt: (cam.targetTilt ?? 0) * RAD2DEG,
    };
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — Time
  // ──────────────────────────────────────────────

  /** Start time playback. */
  play() {
    this.time.play();
  }

  /** Pause time playback. */
  pause() {
    this.time.pause();
  }

  /** Toggle play/pause. @returns {boolean} isPlaying */
  togglePlay() {
    return this.time.togglePlay();
  }

  /** Set playback speed multiplier. */
  setSpeed(speed) {
    this.time.setSpeed(speed);
  }

  /** Get current speed label (e.g. '10x'). */
  getSpeedLabel() {
    return this.time.getSpeedLabel();
  }

  /** Scrub to a normalized time position (0..1). */
  scrubTo(normalized) {
    this.time.scrubTo(normalized);
    this._renderDirty = true;
  }

  /**
   * Update the shard loading progress indicator.
   * Shows progress when any layer is waiting for shard data.
   * Auto-pauses playback to prevent animation artifacts (e.g. GFB
   * animating while H3F is frozen at the old shard boundary).
   * Auto-resumes when all shards are ready.
   * @param {number} normalizedTime
   */
  _updateShardLoadingIndicator(normalizedTime) {
    const indicator = this.ui?.shardLoading;
    if (!indicator || !this.layerManager) return;

    const status = this.layerManager.getShardLoadingStatus(normalizedTime);
    if (status.loading) {
      indicator.show();
      indicator.updateProgress(status.layersReady, status.layersTotal, status.layersPending);

      // Auto-pause playback to prevent animation artifacts
      if (this.time.playing && !this._shardPausedPlayback) {
        this._shardPausedPlayback = true;
        this.time.playing = false;
        if (this.ui?.timePanel) {
          this.ui.timePanel._playBtn.textContent = '▶';
        }
      }
    } else if (indicator.visible) {
      indicator.hide(true);

      // Auto-resume playback if we paused it
      if (this._shardPausedPlayback) {
        this._shardPausedPlayback = false;
        this.time.playing = true;
        if (this.ui?.timePanel) {
          this.ui.timePanel._playBtn.textContent = '⏸';
        }
      }
    }
  }

  /** Get current normalized time (0..1). */
  getNormalizedTime() {
    return this.time.getNormalized();
  }

  /** Get formatted time string (HH:MM:SS). */
  getFormattedTime() {
    return this.time.getFormatted();
  }

  /** Check if time playback is active. @returns {boolean} */
  isPlaying() {
    return this.time.playing;
  }

  /**
   * Set a looping animation window using absolute UNIX timestamps (seconds).
   * Designed for dashboard integration: the host supplies a start and end
   * epoch and the globe loop-animates between them, with the time bar
   * representing exactly that window (not the whole loaded dataset).
   *
   * Replay only. The bounds share the same absolute-epoch space as
   * {@link getCurrentEpoch}. If set before layer data has loaded, the window
   * is stored and applied once the epoch range is known. No-op in live mode,
   * or when `startEpochSec >= endEpochSec` (a warning is logged).
   *
   * @param {number} startEpochSec - Window start as UNIX epoch seconds
   * @param {number} endEpochSec  - Window end as UNIX epoch seconds
   */
  setTimeWindow(startEpochSec, endEpochSec) {
    this.time.setWindow(startEpochSec, endEpochSec);
    this._renderDirty = true;
  }

  /**
   * Clear the animation window, restoring the full-dataset timeline.
   */
  clearTimeWindow() {
    this.time.clearWindow();
    this._renderDirty = true;
  }

  /**
   * Get the active animation window in absolute UNIX seconds, or null if none.
   * @returns {{ startEpochSec: number, endEpochSec: number } | null}
   */
  getTimeWindow() {
    return this.time.getWindow();
  }

  /**
   * Jump the playhead to a specific absolute UNIX timestamp (seconds).
   * Single-point scrub; does not set a window.
   * @param {number} epochSec - Target time as UNIX epoch seconds
   */
  setTime(epochSec) {
    // Lossless: writes the absolute epoch directly (no 0..1 round-trip).
    this.time.setEpoch(epochSec);
    this._renderDirty = true;
  }

  /**
   * Select who drives the playhead:
   * - `'internal'` — the engine self-advances (play/pause/scrub/window). Default.
   * - `'external'` — the host owns the clock; self-advance is off and play/pause
   *   are no-ops. Drive the playhead with {@link pushEpoch} (multi-panel / master-clock sync).
   * - `'live'` — the engine follows the data live edge.
   * @param {'internal'|'external'|'live'} source
   */
  setClockSource(source) {
    this.time.setClockSource(source);
    this._renderDirty = true;
  }

  /**
   * Push an absolute playhead position (UNIX seconds) from the host. Valid only
   * when the clock source is `'external'` (see {@link setClockSource}); ignored
   * otherwise. Lossless — no normalized round-trip.
   * @param {number} epochSec
   */
  pushEpoch(epochSec) {
    this.time.pushEpoch(epochSec);
    this._renderDirty = true;
  }

  /**
   * Symmetric time getter. Absolute `epochSec` is the source of truth;
   * `normalized` is derived from it.
   * @returns {{ epochSec: number, normalized: number, source: string, playing: boolean }}
   */
  getTime() {
    return {
      epochSec: this.time.getCurrentEpoch(),
      normalized: this.time.getNormalized(),
      source: this.time.clockSource,
      playing: this.time.playing,
    };
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — State round-trip
  // ──────────────────────────────────────────────

  /**
   * Snapshot the current **view state** (never data sources or layer existence).
   * Composes the individual getters; pairs with {@link applyState}. Use to
   * persist/restore a view (e.g. a saved dashboard layout, a shareable link).
   *
   * `layers[]` carries adjustments to ALREADY-LOADED layers only. `style` is
   * the programmatic override set via {@link setLayerStyle} (null if the layer
   * still uses its config/default style).
   *
   * @returns {{
   *   version: number,
   *   camera: { lat, lon, distance, heading, tilt },
   *   time: { epochSec: number, source: string },
   *   basemap: string | null,
   *   projection: 'spherical' | 'mercator',
   *   layers: Array<{ name: string, visible: boolean, filter: string | null, style: object | null }>
   * }}
   */
  getState() {
    const layers = [];
    if (this.layerManager) {
      for (const [name, layer] of this.layerManager.layers) {
        layers.push({
          name,
          visible: layer.visible !== false,
          filter: layer.activeFilter ?? null,
          style: layer._appliedStyleSpec ?? null,
        });
      }
    }
    const t = this.getTime();
    return {
      version: 1,
      camera: this.getView(),
      time: { epochSec: t.epochSec, source: t.source },
      basemap: this.getBasemap(),
      projection: this.getProjectionMode(),
      layers,
    };
  }

  /**
   * Restore a (partial) view state produced by {@link getState}. **View-state
   * only** — never creates layers or fetches data; that stays {@link loadConfig}'s
   * job. Restore flow: `await ready()` → `await loadConfig(yaml)` → `await applyState(saved)`.
   *
   * This is the single place restore-ordering is encoded. It applies the
   * setters in dependency order: projection → camera → basemap → layers
   * (visibility, style) → filters → time. Partial-tolerant (applies only the
   * keys present; unknown fields are ignored) and versioned (older/newer
   * `version` values are accepted best-effort).
   *
   * @param {Partial<ReturnType<GlobeTrotterEngine['getState']>>} state
   * @returns {Promise<void>}
   */
  async applyState(state = {}) {
    if (!state || typeof state !== 'object') return;

    if (state.projection) this.setProjectionMode(state.projection);
    if (state.camera) this.setView(state.camera);
    if (state.basemap != null) this.setBasemap(state.basemap);

    if (Array.isArray(state.layers)) {
      // Layer visibility + style first...
      for (const l of state.layers) {
        if (!l || !l.name) continue;
        if (l.visible != null) this.setLayerVisibility(l.name, l.visible);
        if (l.style != null) this.setLayerStyle(l.name, l.style);
      }
      // ...then filters (kept as a distinct ordered step per the contract).
      for (const l of state.layers) {
        if (!l || !l.name || !('filter' in l)) continue;
        if (l.filter) this.setFilter(l.name, l.filter);
        else this.clearFilter(l.name);
      }
    }

    // Time last: set the clock source, then position the playhead using the
    // matching setter (pushEpoch for external, setTime otherwise).
    if (state.time) {
      if (state.time.source) this.setClockSource(state.time.source);
      if (state.time.epochSec != null) {
        if ((state.time.source || this.time.clockSource) === 'external') {
          this.pushEpoch(state.time.epochSec);
        } else {
          this.setTime(state.time.epochSec);
        }
      }
    }
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — Layout
  // ──────────────────────────────────────────────

  /**
   * Programmatically trigger a resize check.
   * Call this when the canvas container changes size (e.g. dashboard
   * grid drag, panel collapse/expand) but `window.resize` did not fire.
   */
  resize() {
    this._resize();
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — UI visibility
  // ──────────────────────────────────────────────

  /**
   * Show or hide a UI widget at runtime. Complements the construction-time
   * `uiWidgets` option so an embedding host can adjust chrome after load.
   *
   * Canonical names: `footer`, `layers`, `geocoder`, `time`, `legend`,
   * `charts`, `chartToggle`, `projection`, `compass`, `basemap`, `dropZone`.
   *
   * @param {string} name - Canonical widget name
   * @param {boolean} visible
   * @returns {boolean} true if the widget exists and was toggled; false if the
   *   name is unknown, the widget wasn't created, or UI is disabled (`ui:false`)
   */
  setWidgetVisible(name, visible) {
    return this.ui?.setWidgetVisible(name, visible) ?? false;
  }

  /**
   * Get the current visibility of every toggleable widget. Widgets that were
   * never created (disabled or unavailable) report false. Returns `{}` when
   * UI is disabled.
   * @returns {Record<string, boolean>}
   */
  getWidgetVisibility() {
    return this.ui?.getWidgetVisibility() ?? {};
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — Events
  // ──────────────────────────────────────────────

  /**
   * Subscribe to engine events.
   * @param {'frame'|'layerAdded'|'layerRemoved'|'click'|'projection-changed'} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    // Return an unsubscribe function so hosts don't have to stash the callback
    // reference to call off() later.
    return () => this.off(event, callback);
  }

  /**
   * Unsubscribe from engine events.
   */
  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) set.delete(callback);
  }

  _emit(event, data) {
    const set = this._listeners.get(event);
    if (set) set.forEach((cb) => cb(data));
  }

  // ──────────────────────────────────────────────
  // PRIVATE — Tile system helpers
  // ──────────────────────────────────────────────

  _initTileSystem(providerName, style) {
    let provider = null;
    if (providerName === 'google' && this.options.googleMapsApiKey) {
      provider = new GoogleProvider(this.options.googleMapsApiKey);
    } else if (providerName === 'mapbox' && this.options.mapboxToken) {
      provider = new MapboxProvider(this.options.mapboxToken);
    }
    if (!provider) return;

    this.tileManager = new TileManager(provider);
    if (this.backend === 'webgpu') {
      this.tileRenderer = new TileRendererGPU(
        this.gpuDevice,
        this.gpuFormat,
        this.gpuDepthFormat,
        this.tileManager
      );
    } else {
      this.tileRenderer = new TileRenderer(this.gl, this.tileManager);
    }

    const styles = provider.constructor.STYLES;
    if (style && styles?.[style]) {
      this.tileManager.setStyle(style);
    }
  }

  _applyBasemapConfig({ provider: providerName, style } = {}) {
    if (!providerName && !style) return;

    const currentProviderName = this.tileManager?.provider?.constructor?.PROVIDER_ID;
    const targetProvider = providerName || currentProviderName || 'mapbox';

    if (this.tileManager && currentProviderName === targetProvider) {
      if (style) this.setBasemap(style);
      return;
    }

    // Provider switch or first-time setup: dispose old renderer, build fresh
    if (this.tileRenderer) {
      this.tileRenderer.dispose();
      this.tileRenderer = null;
    }
    this.tileManager = null;
    this._initTileSystem(targetProvider, style);
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — Basemap
  // ──────────────────────────────────────────────

  /**
   * Change the basemap style.
   * @param {string} style - Mapbox style ID (e.g. 'satellite-v9', 'dark-v11')
   */
  setBasemap(style) {
    if (this.tileManager) {
      this.tileManager.setStyle(style);
      // Flush GPU textures from old style immediately
      if (this.tileRenderer) {
        this.tileRenderer.flushTextures();
      }
      // Force re-render so TileRenderer requests the new tiles
      // (bypassing the stationary frame detection)
      this._renderDirty = true;
    }
  }

  /**
   * Get the current basemap style, or null if there is no tile system.
   * Pairs with {@link setBasemap}.
   * @returns {string | null}
   */
  getBasemap() {
    return this.tileManager?.style ?? null;
  }

  // ──────────────────────────────────────────────
  // PUBLIC API — Navigation
  // ──────────────────────────────────────────────

  /**
   * Smoothly fly to a lat/lon position.
   * @param {number} lat - Latitude in degrees
   * @param {number} lon - Longitude in degrees
   * @param {number} [distance=1.05] - Camera distance from globe center
   */
  flyTo(lat, lon, distance = 1.05) {
    this.camera.flyTo(lat, lon, distance);
  }
}
