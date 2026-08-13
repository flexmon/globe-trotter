/**
 * PickController — rAF-throttled hover + click picking, source-neutral.
 *
 * PickController owns the interaction lifecycle (pointer tracking, rAF throttling,
 * click pinning, Escape clearing, popup show/hide, visibility + filter gating).
 * Per-layer hit-testing is delegated to a registered adapter (`picker`):
 *
 *   picker.pick(ctx) -> { featureIndex } | null
 *
 * where ctx = { sx, sy, geo: {lng,lat}|null, camera, engine }. Adapters own their
 * own tolerance semantics (degrees for CPU vector, pixels for screen-space/GPU).
 *
 * Usage:
 *   const pick = new PickController(engine, camera, popup);
 *   pick.registerLayer('my-layer', { kind, picker, getProperties, hover, click });
 *   // In render loop: pick.tick();
 *   pick.destroy();
 */

import { normalizeFields, normalizeGroups, buildRows, buildSections } from './PopupFields.js';

/**
 * Assemble the popup payload for a hit. Pure.
 * Legacy shape { layerName, properties } when no popupFields; structured
 * { layerName, title, rows } when popupFields are configured. Raw `properties`
 * is always retained for selection events.
 *
 * @param {{ layerName: string, featureIndex: number, properties: object,
 *           popupFields?: Array, title?: string,
 *           decode?: (name:string, raw:*) => (string|undefined) }} args
 * @returns {{ layerName, featureIndex, properties, title?, rows? }}
 */
export function buildPickPayload({
  layerName,
  featureIndex,
  properties,
  popupFields,
  popupGroups,
  layout,
  title,
  decode,
}) {
  const base = { layerName, featureIndex, properties };
  if (popupGroups && popupGroups.length) {
    return {
      ...base,
      title: title ?? layerName,
      layout,
      sections: buildSections(popupGroups, properties, { decode }),
    };
  }
  if (popupFields && popupFields.length) {
    return {
      ...base,
      title: title ?? layerName,
      layout,
      rows: buildRows(popupFields, properties, { decode }),
    };
  }
  return base;
}

export class PickController {
  /**
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {import('../camera/CameraController.js').CameraController} camera
   * @param {import('../ui/FeaturePopup.js').FeaturePopup} popup
   */
  constructor(engine, _camera, popup) {
    this._engine = engine;
    this._popup = popup;

    /** @type {Map<string, object>} layerName → entry */
    this._layers = new Map();

    this._pendingX = null;
    this._pendingY = null;
    this._lastResult = null;
    this._pinned = null;
    this._lastPinnedTime = null; // normalized time of the last pinned refresh

    this._canvas = engine.canvas;
    this._boundPointer = this._onPointerMove.bind(this);
    this._boundClick = this._onClick.bind(this);
    this._boundEscape = this._onKeyDown.bind(this);

    this._canvas.addEventListener('pointermove', this._boundPointer, { passive: true });
    this._canvas.addEventListener('click', this._boundClick);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._boundEscape);
    }
  }

  /** Always returns the engine's current camera, surviving projection switches. */
  get _camera() {
    return this._engine.camera;
  }

  /**
   * Register a layer for picking with a source-neutral adapter.
   * @param {string} layerName
   * @param {{
   *   kind?: string,
   *   sourceType?: string,
   *   hover?: boolean,
   *   click?: boolean,
   *   picker: { pick: (ctx: object) => ({ featureIndex: number } | null) },
   *   getProperties?: (featureIndex: number, ctx: object) => object,
   *   getTitle?: (() => string) | string,
   *   title?: string,
   *   popupFields?: Array<string|object>,
   *   decode?: (name: string, raw: *) => (string | undefined),
   * }} options
   */
  registerLayer(layerName, options = {}) {
    const {
      kind = null,
      sourceType = 'geojson',
      hover = false,
      click = false,
      picker,
      getProperties,
      getTitle,
      title,
      popupFields,
      popupGroups,
      layout = null,
      decode = null,
    } = options;
    this._layers.set(layerName, {
      kind,
      sourceType,
      hover: hover === true,
      click: click === true,
      picker,
      getProperties:
        getProperties ||
        (picker && picker.getProperties ? picker.getProperties.bind(picker) : null),
      getTitle: getTitle ?? title ?? null,
      popupFields: normalizeFields(popupFields),
      popupGroups: normalizeGroups(popupGroups),
      layout,
      decode,
      filterFn: null,
    });
  }

  /** Get a registered layer entry (used by Layer Manager UI). */
  getLayer(layerName) {
    return this._layers.get(layerName);
  }

  /** Deregister a layer (called when layer is removed). */
  deregisterLayer(layerName) {
    this._layers.delete(layerName);
    if (this._lastResult?.layerName === layerName) {
      this._popup?.clearHover();
      this._lastResult = null;
    }
    if (this._pinned?.layerName === layerName) {
      this._popup?.clearPinned();
      this._pinned = null;
    }
  }

  /** Set the CPU-side filter predicate for a layer (null = no filter). */
  setLayerFilterFn(layerName, fn) {
    const entry = this._layers.get(layerName);
    if (entry) entry.filterFn = fn ?? null;
  }

  /** Enable/disable hover or click picking for a layer. */
  setLayerPickOptions(layerName, opts = {}) {
    const entry = this._layers.get(layerName);
    if (!entry) return;
    if (opts.hover !== undefined) entry.hover = opts.hover;
    if (opts.click !== undefined) entry.click = opts.click;
  }

  /**
   * Called once per animation frame from the render loop.
   * Consumes the stored pointer position and runs the pick query.
   */
  tick() {
    // Keep a pinned popup's values current as time advances (streaming /
    // playback / scrub). Runs before the pointer-movement guard so it
    // refreshes even when the cursor is still.
    this._refreshPinned();

    if (this._pendingX === null) return;
    const sx = this._pendingX;
    const sy = this._pendingY;
    this._pendingX = null;
    this._pendingY = null;

    const hit = this._pickAt(sx, sy, 'hover');
    if (!hit) {
      if (this._lastResult) {
        this._popup?.clearHover();
        this._lastResult = null;
      }
      return;
    }
    const key = `${hit.layerName}:${hit.featureIndex}`;
    const lastKey = this._lastResult
      ? `${this._lastResult.layerName}:${this._lastResult.featureIndex}`
      : null;
    if (key !== lastKey) {
      this._lastResult = hit;
      this._popup?.showHover(hit, sx, sy);
    }
  }

  destroy() {
    this._canvas.removeEventListener('pointermove', this._boundPointer);
    this._canvas.removeEventListener('click', this._boundClick);
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._boundEscape);
    }
    this._layers.clear();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _onPointerMove(e) {
    const rect = this._canvas.getBoundingClientRect();
    this._pendingX = e.clientX - rect.left;
    this._pendingY = e.clientY - rect.top;
  }

  _onClick(e) {
    const rect = this._canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = this._pickAt(sx, sy, 'click');
    if (!hit) {
      this._popup?.clearPinned();
      this._pinned = null;
      // Signal a cleared selection so hosts can dismiss detail panels.
      this._engine?._emit('selection', { layer: null, feature: null, lngLat: null });
      return;
    }
    this._pinned = hit;
    this._lastPinnedTime = this._currentNormalizedTime();
    this._popup?.showPinned(hit, sx, sy);
    // Notify hosts of the selection. lngLat is reserved (null) until a public
    // screen→lngLat unproject is exposed; feature carries the picked properties.
    this._engine?._emit('selection', {
      layer: hit.layerName,
      feature: hit.properties,
      featureIndex: hit.featureIndex,
      lngLat: null,
    });
  }

  _onKeyDown(e) {
    if (e.key === 'Escape') {
      this._popup?.clearPinned();
      this._pinned = null;
    }
  }

  _currentNormalizedTime() {
    const t = this._engine?.time;
    return t?.getNormalized ? t.getNormalized() : null;
  }

  /**
   * Re-materialize the pinned popup's data at the current time and update its
   * content in place (no reposition). Skips when nothing is pinned or the time
   * hasn't changed since the last refresh, so it's free while paused.
   */
  _refreshPinned() {
    const pinned = this._pinned;
    if (!pinned) return;

    const t = this._currentNormalizedTime();
    if (t !== null && t === this._lastPinnedTime) return;
    this._lastPinnedTime = t;

    const entry = this._layers.get(pinned.layerName);
    if (!entry || !entry.getProperties) return;

    const ctx = { camera: this._camera, engine: this._engine };
    const properties = entry.getProperties(pinned.featureIndex, ctx);
    // If the feature is now filtered out, leave the last content in place
    // rather than showing stale-but-valid data as filtered.
    if (entry.filterFn && !entry.filterFn(properties)) return;

    const payload = buildPickPayload({
      layerName: pinned.layerName,
      featureIndex: pinned.featureIndex,
      properties,
      popupFields: entry.popupFields,
      popupGroups: entry.popupGroups,
      layout: entry.layout,
      title: _resolveTitle(entry.getTitle),
      decode: entry.decode,
    });
    this._pinned = { ...payload, sx: pinned.sx, sy: pinned.sy };
    this._popup?.updatePinned(this._pinned);
  }

  /**
   * @param {number} sx  Screen X (pixels, relative to canvas)
   * @param {number} sy  Screen Y
   * @param {'hover'|'click'} mode
   * @returns {object|null}  Popup payload + { sx, sy }, or null.
   */
  _pickAt(sx, sy, mode) {
    const geo = this._screenToGeo(sx, sy);
    const ctx = { sx, sy, geo, camera: this._camera, engine: this._engine };

    for (const [layerName, entry] of this._layers) {
      if (mode === 'hover' && !entry.hover) continue;
      if (mode === 'click' && !entry.click) continue;
      if (!entry.picker) continue;

      // Skip layers hidden at the whole-layer level
      if (!this._engine.layerManager?.layers.get(layerName)?.visible) continue;

      const hit = entry.picker.pick(ctx);
      if (!hit) continue;

      const properties = entry.getProperties
        ? entry.getProperties(hit.featureIndex, ctx)
        : hit.properties || {};

      // Skip features hidden by an active GPU filter (evaluated CPU-side).
      if (entry.filterFn && !entry.filterFn(properties)) continue;

      const payload = buildPickPayload({
        layerName,
        featureIndex: hit.featureIndex,
        properties,
        popupFields: entry.popupFields,
        popupGroups: entry.popupGroups,
        layout: entry.layout,
        title: _resolveTitle(entry.getTitle),
        decode: entry.decode,
      });
      return { ...payload, sx, sy };
    }
    return null;
  }

  _screenToGeo(sx, sy) {
    const cam = this._camera;
    if (!cam?._screenToGlobe) return null;
    const w = this._canvas.clientWidth;
    const h = this._canvas.clientHeight;
    const result = cam._screenToGlobe(sx, sy, w, h);
    if (!result) return null;
    const { theta, phi } = result;
    // theta is in the shader's (lon + 180)·DEG2RAD convention (both cameras);
    // convert back to a real longitude and wrap to [-180, 180]. Matches
    // AcetateFooter's conversion — omitting the −180 offsets every pick by
    // 180° of longitude, so features under the cursor are never hit.
    let lng = theta * (180 / Math.PI) - 180;
    if (lng < -180) lng += 360;
    if (lng > 180) lng -= 360;
    return { lng, lat: phi * (180 / Math.PI) };
  }
}

function _resolveTitle(getTitle) {
  if (typeof getTitle === 'function') return getTitle();
  if (typeof getTitle === 'string') return getTitle;
  return undefined;
}
