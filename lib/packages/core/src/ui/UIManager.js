/**
 * UIManager.js — Orchestrator that creates and manages all Globe-Trotter
 * UI widgets (acetate footer, layer manager, geocoder, time panel).
 *
 * Usage:
 *   const ui = new UIManager(engine, document.body, {
 *       footer: true,
 *       layers: true,
 *       geocoder: true,
 *       time: true,
 *   });
 *
 *   // In render loop:
 *   ui.update(frameData, normalizedTime);
 */

import { injectStyles } from './styles.js';
import { AcetateFooter } from './AcetateFooter.js';
import { LayerManagerDialog } from './LayerManagerDialog.js';
import { GeocoderDialog } from './GeocoderDialog.js';
import { MapboxGeocoderProvider } from '../geocoder/providers/MapboxGeocoderProvider.js';
import { GoogleGeocoderProvider } from '../geocoder/providers/GoogleGeocoderProvider.js';
import { TimePanel } from './TimePanel.js';
import { LegendPanel } from './LegendPanel.js';
import { LoadingScreen } from './LoadingScreen.js';
import { ChartManagerDialog } from './ChartManagerDialog.js';
import { ShardLoadingIndicator } from './ShardLoadingIndicator.js';

const DEFAULT_WIDGETS = {
  footer: true,
  layers: true,
  geocoder: true,
  time: true,
  legend: true,
  charts: true,
  chartToggle: true, // floating chart visibility button (also requires charts)
  projection: true, // 2D/3D toggle button
  compass: true, // heading compass
  basemap: true, // basemap selector (nested in the layer manager)
  dropZone: true, // drag-drop GeoJSON overlay
  loadingScreen: false, // opt-in: pass true or { logoUrl, title, subtitle }
};

export class UIManager {
  /**
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {HTMLElement} container - Parent element for all widgets (typically document.body)
   * @param {Object} [widgetOptions] - Which widgets to enable
   */
  constructor(engine, container, widgetOptions = {}) {
    this.engine = engine;
    this.container = container;
    this.widgets = { ...DEFAULT_WIDGETS, ...widgetOptions };

    // Inject CSS once
    injectStyles();

    // Create enabled widgets
    this.footer = null;
    this.layerManager = null;
    this.geocoder = null;
    this.timePanel = null;

    if (this.widgets.footer) {
      this.footer = new AcetateFooter(engine, container);
      // Wire basemap attribution updates from the engine. Both the
      // initial event (fired after provider.ensureReady() resolves) and
      // subsequent setBasemap() calls are handled by the same listener.
      this._basemapChangedHandler = ({ attribution }) => {
        this.footer?.setAttribution(attribution);
      };
      engine.on('basemap-changed', this._basemapChangedHandler);
      // If the tile system is already ready by the time UIManager mounts
      // (rare but possible — e.g. Mapbox provider, no async wait), seed
      // the footer with the current attribution so it's not blank.
      if (engine.tileManager) {
        this.footer.setAttribution(engine.tileManager.getAttribution());
      }
    }
    if (this.widgets.layers) {
      this.layerManager = new LayerManagerDialog(engine, container, {
        basemap: this.widgets.basemap,
      });
    }
    // Build ordered provider list for the geocoder.
    // Preference when both keys are present: Mapbox first (preserves existing behavior).
    // The user may override via engine.options.geocoderProvider ('mapbox' | 'google').
    //
    // Gating: show the widget whenever at least one provider has credentials.
    // Previously gated on Mapbox-only (Option A). This is now Option C.
    if (this.widgets.geocoder) {
      const explicitId = engine.options.geocoderProvider || null;
      const providers = _buildGeocoderProviders(engine, explicitId);
      const hasAny = providers.some((p) => p.isAvailable());
      if (hasAny) {
        this.geocoder = new GeocoderDialog(engine, container, providers);
      } else {
        console.info(
          '[UIManager] Geocoder hidden — no VITE_MAPBOX_TOKEN or VITE_GOOGLE_MAPS_API_KEY configured'
        );
      }
    }
    if (this.widgets.time) {
      this.timePanel = new TimePanel(engine, container);
    }
    if (this.widgets.legend) {
      this.legend = new LegendPanel(engine, container);
    }
    if (this.widgets.charts) {
      this.chartDialog = new ChartManagerDialog(engine, container);
    }

    // Chart visibility toggle — upper-right floating button
    this.chartToggleBtn = null;
    this._chartToggleHandler = null;
    this._chartToggleEnabled = this.widgets.chartToggle; // host gate (runtime-toggleable)
    this._chartToggleShown = false; // charts loaded → button relevant
    if (this.widgets.charts && this.widgets.chartToggle) {
      this._createChartToggle(engine, container);
    }

    // 2D/3D projection toggle — sits left of the chart toggle.
    this.projectionToggleBtn = null;
    this._projectionToggleHandler = null;
    this._projectionKeyHandler = null;
    if (this.widgets.projection) {
      this._create2D3DToggle(engine, container);
    }

    // Compass widget — shows heading; visible only in spherical mode.
    this.compassEl = null;
    this.compassNeedle = null;
    this._compassEnabled = this.widgets.compass; // host gate (runtime-toggleable)
    if (this.widgets.compass) {
      this._createCompass(engine, container);
    }

    // Loading screen — branded splash with CSS heartbeat animation.
    // Pass branding options if loadingScreen is an object.
    this.loadingScreen = null;
    if (this.widgets.loadingScreen) {
      const lsOpts =
        typeof this.widgets.loadingScreen === 'object' ? this.widgets.loadingScreen : {};
      this.loadingScreen = new LoadingScreen(container, lsOpts);
    }

    // Shard loading progress indicator — shown when user scrubs into unloaded time region
    this.shardLoading = new ShardLoadingIndicator(container);

    // Drag-drop GeoJSON overlay
    this._dropZone = null;
    this._dragDepth = 0;
    if (this.widgets.dropZone) {
      this._boundDragEnter = this._onDragEnter.bind(this);
      this._boundDragOver = this._onDragOver.bind(this);
      this._boundDragLeave = this._onDragLeave.bind(this);
      this._boundDrop = this._onDrop.bind(this);
      container.addEventListener('dragenter', this._boundDragEnter);
      container.addEventListener('dragover', this._boundDragOver);
      container.addEventListener('dragleave', this._boundDragLeave);
      container.addEventListener('drop', this._boundDrop);
      this._createDropZone(container);
    }

    // Build the runtime widget-visibility registry now that all widgets exist.
    this._buildWidgetRegistry();
  }

  // ─── Widget visibility ─────────────────────────────────

  /**
   * Build the name → visibility-handler registry and the initial state map.
   * Called once at the end of construction. Widgets that weren't created
   * (disabled, or unavailable like a credential-less geocoder) map to false
   * and are inert to setWidgetVisible.
   * @private
   */
  _buildWidgetRegistry() {
    const handlers = {};
    const state = {};

    const addInstance = (name, inst) => {
      if (inst && typeof inst.setVisible === 'function') {
        handlers[name] = (vis) => inst.setVisible(vis);
        state[name] = true;
      } else {
        state[name] = false;
      }
    };
    addInstance('footer', this.footer);
    addInstance('layers', this.layerManager);
    addInstance('geocoder', this.geocoder);
    addInstance('time', this.timePanel);
    addInstance('legend', this.legend);
    addInstance('charts', this.chartDialog);

    const addEl = (name, el) => {
      if (el) {
        handlers[name] = (vis) => {
          el.style.display = vis ? '' : 'none';
        };
        state[name] = el.style.display !== 'none';
      } else {
        state[name] = false;
      }
    };
    addEl('projection', this.projectionToggleBtn);
    addEl('dropZone', this._dropZone);

    // Compass: per-frame _updateCompass owns its display, so gate via a flag
    // that _updateCompass respects rather than fighting it each frame.
    if (this.compassEl) {
      handlers['compass'] = (vis) => {
        this._compassEnabled = vis;
        if (!vis) this.compassEl.style.display = 'none';
      };
      state['compass'] = !!this._compassEnabled;
    } else {
      state['compass'] = false;
    }

    // Chart toggle button: _showChartToggle may re-show it after charts load,
    // so gate via a flag that _showChartToggle honors.
    if (this.chartToggleBtn) {
      handlers['chartToggle'] = (vis) => {
        this._chartToggleEnabled = vis;
        this.chartToggleBtn.style.display = vis && this._chartToggleShown ? '' : 'none';
      };
      state['chartToggle'] = this.chartToggleBtn.style.display !== 'none';
    } else {
      state['chartToggle'] = false;
    }

    // Basemap selector lives inside the layer manager dialog.
    if (this.layerManager && typeof this.layerManager.setBasemapVisible === 'function') {
      handlers['basemap'] = (vis) => this.layerManager.setBasemapVisible(vis);
      state['basemap'] = this.widgets.basemap !== false;
    } else {
      state['basemap'] = false;
    }

    this._widgetHandlers = handlers;
    this._widgetVisible = state;
  }

  /**
   * Show or hide a UI widget at runtime.
   * @param {string} name - Canonical widget name (e.g. 'time', 'layers', 'projection', 'basemap')
   * @param {boolean} visible
   * @returns {boolean} true if the widget exists and was toggled, false otherwise
   */
  setWidgetVisible(name, visible) {
    const handler = this._widgetHandlers?.[name];
    if (!handler) return false;
    handler(!!visible);
    this._widgetVisible[name] = !!visible;
    return true;
  }

  /**
   * Get the current visibility state of every toggleable widget.
   * Widgets that were never created report false.
   * @returns {Record<string, boolean>}
   */
  getWidgetVisibility() {
    return { ...this._widgetVisible };
  }

  /**
   * Update all widgets with current frame data.
   * @param {{ fps: number, drawCalls: number, throttled: boolean }} frameData
   * @param {number} normalizedTime
   */
  update(frameData, normalizedTime) {
    if (this.footer) this.footer.update(frameData);
    if (this.layerManager) this.layerManager.update();
    if (this.geocoder) this.geocoder.update();
    if (this.timePanel) this.timePanel.update(normalizedTime);
    if (this.legend) this.legend.update();
    this._updateCompass();
  }

  /**
   * Hide the loading screen with a fade-out transition.
   * @param {number} [delay=400] - Delay before fade starts (ms)
   */
  hideLoadingScreen(delay = 400) {
    if (this.loadingScreen) {
      this.loadingScreen.hide(delay);
    }
  }

  /** Destroy all widgets and remove DOM elements. */
  destroy() {
    // Unsubscribe basemap event listener before tearing down the footer
    if (this._basemapChangedHandler) {
      this.engine.off('basemap-changed', this._basemapChangedHandler);
      this._basemapChangedHandler = null;
    }
    if (this.footer) this.footer.destroy();
    if (this.layerManager) this.layerManager.destroy();
    if (this.geocoder) this.geocoder.destroy();
    if (this.timePanel) this.timePanel.destroy();
    if (this.legend) this.legend.destroy();
    if (this.loadingScreen) this.loadingScreen.destroy();
    if (this.shardLoading) this.shardLoading.destroy();
    if (this.chartDialog) this.chartDialog.destroy();
    if (this.chartToggleBtn) {
      this.chartToggleBtn.remove();
      this.chartToggleBtn = null;
    }
    if (this.projectionToggleBtn) {
      this.projectionToggleBtn.remove();
      this.projectionToggleBtn = null;
    }
    if (this._projectionKeyHandler) {
      window.removeEventListener('keydown', this._projectionKeyHandler);
      this._projectionKeyHandler = null;
    }
    this.container.removeEventListener('dragenter', this._boundDragEnter);
    this.container.removeEventListener('dragover', this._boundDragOver);
    this.container.removeEventListener('dragleave', this._boundDragLeave);
    this.container.removeEventListener('drop', this._boundDrop);
    if (this._dropZone) {
      this._dropZone.remove();
      this._dropZone = null;
    }

    this.footer = null;
    this.layerManager = null;
    this.geocoder = null;
    this.timePanel = null;
    this.legend = null;
    this.loadingScreen = null;
  }

  // ─── Chart Toggle Button ───────────────────────────────

  /**
   * Create the upper-right chart visibility toggle button.
   * Starts hidden; `_showChartToggle()` is called once charts load from config.
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {HTMLElement} container
   * @private
   */
  _createChartToggle(engine, container) {
    const btn = document.createElement('button');
    btn.className = 'gt-glass-panel gt-chart-toggle-btn';
    btn.title = 'Toggle charts';
    btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="12" width="4" height="9"></rect>
              <rect x="10" y="7" width="4" height="14"></rect>
              <rect x="17" y="3" width="4" height="18"></rect>
            </svg>
        `;
    container.appendChild(btn);
    this.chartToggleBtn = btn;

    this._chartToggleHandler = () => {
      if (!engine.chartManager || engine.chartManager.charts.length === 0) return;
      const nowVisible = engine.chartManager.toggleAllVisibility();
      btn.classList.toggle('gt-chart-toggle-off', !nowVisible);
    };
    btn.addEventListener('click', this._chartToggleHandler);

    // Start hidden until charts are actually loaded
    btn.style.display = 'none';
  }

  /** Show the chart toggle button (called after charts load from config). */
  _showChartToggle() {
    if (this.chartToggleBtn) {
      this._chartToggleShown = true;
      if (this._chartToggleEnabled === false) return; // host has hidden it
      this.chartToggleBtn.style.display = '';
      // Sync initial state
      const vis = this.engine.chartManager?.chartsVisible ?? true;
      this.chartToggleBtn.classList.toggle('gt-chart-toggle-off', !vis);
    }
  }

  // ─── 2D/3D Projection Toggle ──────────────────────────

  /**
   * Create the 2D/3D projection toggle button and bind the `m` keyboard shortcut.
   * The button icon swaps between a globe and a map grid based on current mode
   * (showing the icon for the mode you'd toggle TO). The `m` shortcut is
   * suppressed when modifier keys are held or focus is in an editable element.
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {HTMLElement} container
   * @private
   */
  _create2D3DToggle(engine, container) {
    const btn = document.createElement('button');
    btn.className = 'gt-glass-panel gt-projection-toggle-btn';
    btn.title = 'Toggle 2D / 3D projection (press M)';
    btn.dataset.testid = 'projection-toggle';

    const updateIcon = () => {
      // Show the icon for the mode we'd toggle TO (i.e. opposite of current).
      const targetIs2D = engine.projectionMode === 'spherical';
      btn.innerHTML = targetIs2D
        ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                     <rect x="3" y="5" width="18" height="14" rx="1"></rect>
                     <line x1="3" y1="10" x2="21" y2="10"></line>
                     <line x1="3" y1="14" x2="21" y2="14"></line>
                     <line x1="9" y1="5" x2="9" y2="19"></line>
                     <line x1="15" y1="5" x2="15" y2="19"></line>
                   </svg>`
        : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                     <circle cx="12" cy="12" r="9"></circle>
                     <path d="M3 12 h18"></path>
                     <path d="M12 3 a 9 4.5 0 0 1 0 18"></path>
                     <path d="M12 3 a 9 4.5 0 0 0 0 18"></path>
                   </svg>`;
      btn.title = targetIs2D ? 'Switch to 2D Mercator (press M)' : 'Switch to 3D globe (press M)';
    };
    updateIcon();
    container.appendChild(btn);
    this.projectionToggleBtn = btn;

    this._projectionToggleHandler = () => {
      const next = engine.projectionMode === 'spherical' ? 'mercator' : 'spherical';
      if (engine.setProjectionMode(next)) {
        updateIcon();
      }
    };
    btn.addEventListener('click', this._projectionToggleHandler);
    engine.on?.('projection-changed', updateIcon);

    // Keyboard 'm' shortcut (Mapbox convention). Skip when typing in inputs.
    this._projectionKeyHandler = (e) => {
      if (e.key !== 'm' && e.key !== 'M') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
        return;
      e.preventDefault();
      this._projectionToggleHandler();
    };
    window.addEventListener('keydown', this._projectionKeyHandler);
  }

  // ─── Compass widget ──────────────────────────────────────────────────────

  /**
   * Create the compass widget — a small needle that indicates camera heading.
   * The widget is only meaningful in spherical mode (Mercator is always
   * north-up); `_updateCompass()` hides it when heading and tilt are both
   * near zero, or whenever the engine is in mercator mode. Click resets
   * the camera's target heading to 0 (north).
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {HTMLElement} container
   * @private
   */
  _createCompass(engine, container) {
    this._compassEngine = engine;

    const el = document.createElement('div');
    el.className = 'gt-compass';
    el.title = 'Click to reset heading north';
    el.style.cssText = [
      'position:absolute',
      'bottom:52px',
      'right:12px',
      'width:36px',
      'height:36px',
      'border-radius:50%',
      'background:rgba(20,20,30,0.72)',
      'backdrop-filter:blur(6px)',
      'border:1px solid rgba(255,255,255,0.15)',
      'cursor:pointer',
      'display:none', // hidden until heading != 0
      'align-items:center',
      'justify-content:center',
      'overflow:hidden',
      'z-index:20',
      'user-select:none',
    ].join(';');

    // Needle: red (north) + white (south) triangle pair, rotates with heading
    const needle = document.createElement('div');
    needle.style.cssText = [
      'position:absolute',
      'width:4px',
      'height:28px',
      'left:calc(50% - 2px)',
      'top:calc(50% - 14px)',
      'transform-origin:50% 50%',
      'pointer-events:none',
    ].join(';');
    needle.innerHTML =
      '<svg width="4" height="28" viewBox="0 0 4 28" xmlns="http://www.w3.org/2000/svg">' +
      '<polygon points="2,0 4,14 0,14" fill="#e84040"/>' +
      '<polygon points="0,14 4,14 2,28" fill="#d0d0d0"/>' +
      '</svg>';

    // Small 'N' label at the top so users know which end is north
    const label = document.createElement('span');
    label.textContent = 'N';
    label.style.cssText = [
      'position:absolute',
      'top:1px',
      'left:50%',
      'transform:translateX(-50%)',
      'font-size:8px',
      'font-weight:700',
      'color:rgba(255,255,255,0.7)',
      'pointer-events:none',
      'letter-spacing:0',
    ].join(';');

    el.appendChild(needle);
    el.appendChild(label);
    container.appendChild(el);

    el.addEventListener('click', () => {
      const cam = engine.camera;
      if (cam && cam.targetHeading !== undefined) cam.targetHeading = 0;
    });

    this.compassEl = el;
    this.compassNeedle = needle;
  }

  /**
   * Per-frame compass update — toggle visibility based on projection mode
   * and rotate the needle to match camera heading. Called from `update()`.
   * @private
   */
  _updateCompass() {
    if (!this.compassEl || !this._compassEngine) return;
    if (this._compassEnabled === false) {
      this.compassEl.style.display = 'none';
      return;
    }
    const engine = this._compassEngine;
    const cam = engine.camera;
    if (!cam) return;

    // Compass only meaningful in spherical mode (Mercator is always north-up).
    const inSpherical = engine.projectionMode === 'spherical';
    const heading = cam.heading ?? 0;
    const tilt = cam.tilt ?? 0;
    const visible = inSpherical && (Math.abs(heading) > 0.01 || tilt > 0.05);

    this.compassEl.style.display = visible ? 'flex' : 'none';
    if (visible) {
      const deg = heading * (180 / Math.PI);
      this.compassNeedle.style.transform = `rotate(${deg}deg)`;
    }
  }

  // ─── Drag-drop GeoJSON ─────────────────────────────────

  _createDropZone(container) {
    const el = document.createElement('div');
    el.className = 'gt-upload-zone';
    el.innerHTML = `
            <div class="gt-upload-zone-label">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                Drop GeoJSON to add layer
            </div>`;
    container.appendChild(el);
    this._dropZone = el;
  }

  _hasGeoJSONFiles(dt) {
    if (!dt) return false;
    for (const item of dt.items || []) {
      if (item.kind === 'file') return true;
    }
    return false;
  }

  _onDragEnter(e) {
    if (!this._hasGeoJSONFiles(e.dataTransfer)) return;
    e.preventDefault();
    this._dragDepth++;
    this._dropZone?.classList.add('gt-upload-zone-active');
  }

  _onDragOver(e) {
    if (!this._hasGeoJSONFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  _onDragLeave(e) {
    this._dragDepth--;
    if (this._dragDepth <= 0) {
      this._dragDepth = 0;
      this._dropZone?.classList.remove('gt-upload-zone-active');
    }
  }

  _onDrop(e) {
    e.preventDefault();
    this._dragDepth = 0;
    this._dropZone?.classList.remove('gt-upload-zone-active');
    const files = [...(e.dataTransfer?.files || [])].filter(
      (f) => f.name.endsWith('.geojson') || f.name.endsWith('.json')
    );
    for (const file of files) {
      this._ingestGeoJSONFile(file);
    }
  }

  async _ingestGeoJSONFile(file) {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn('[UIManager] Invalid JSON dropped:', file.name);
      return;
    }
    const name = file.name.replace(/\.(geo)?json$/i, '');
    try {
      this.engine.addGeoJSONLayer(name, parsed);
      if (this.layerManager) this.layerManager._populateLayers?.();
    } catch (err) {
      console.warn('[UIManager] GeoJSON ingest failed:', err);
    }
  }
}

// ─── Module-level helpers ──────────────────────────────────────────────────

/**
 * Build a prioritized list of GeocoderProvider instances for the given engine.
 *
 * Default order (when no explicit preference): Mapbox → Google.
 * This preserves existing behavior for users who have both keys configured.
 *
 * When `explicitId` is provided, the matching provider is moved to the front.
 *
 * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
 * @param {string|null} explicitId  'mapbox' | 'google' | null
 * @returns {import('../geocoder/providers/GeocoderProvider.js').GeocoderProvider[]}
 */
function _buildGeocoderProviders(engine, explicitId) {
  const mapboxProvider = engine.options.mapboxToken
    ? new MapboxGeocoderProvider(engine.options.mapboxToken)
    : null;
  const googleProvider = engine.options.googleMapsApiKey
    ? new GoogleGeocoderProvider(engine.options.googleMapsApiKey)
    : null;

  // Default order: Mapbox first (backward-compatible default).
  const defaultOrder = [mapboxProvider, googleProvider].filter(Boolean);

  if (!explicitId) return defaultOrder;

  // Explicit preference: move the requested provider to the front.
  const preferred = defaultOrder.find((p) => p.constructor.PROVIDER_ID === explicitId);
  const rest = defaultOrder.filter((p) => p !== preferred);
  return preferred ? [preferred, ...rest] : defaultOrder;
}
