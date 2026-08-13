/**
 * GeocoderDialog.js — Search button and geocoder panel with typeahead
 * results and fly-to-location on selection.
 *
 * Provider-aware: accepts a list of GeocoderProvider instances (ranked by
 * preference) and delegates all geocoding calls to the first available one.
 * GeocoderDialog is responsible for the two-step Google resolve flow so that
 * individual providers stay simple and stateless with respect to the UI.
 */

import { flyToDistanceForType } from '../geocoder/providers/GeocoderProvider.js';

export class GeocoderDialog {
  /**
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {HTMLElement} container
   * @param {import('../geocoder/providers/GeocoderProvider.js').GeocoderProvider[]} providers
   *   Ordered list of providers; the first available one is used.
   */
  constructor(engine, container, providers = []) {
    this.engine = engine;
    this._geocoderTimer = null;
    this._abort = null;

    // Pick the first available provider.
    this._provider = providers.find((p) => p.isAvailable()) || null;

    if (!this._provider) {
      console.warn('[GeocoderDialog] No geocoder provider available — widget disabled');
      return;
    }

    this._createDOM(container);
    this._bindEvents();
  }

  _createDOM(container) {
    // Search toggle button
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'gt-glass-panel gt-search-btn';
    this.toggleBtn.title = 'Find Location';
    this.toggleBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <span>Find Location</span>
        `;
    container.appendChild(this.toggleBtn);

    // Geocoder panel
    this.panel = document.createElement('div');
    this.panel.className = 'gt-glass-panel gt-geocoder-panel';
    this.panel.style.display = 'none';
    this.panel.innerHTML = `
            <div class="gt-geocoder-input-row">
                <svg class="gt-geocoder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="8"></circle>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                </svg>
                <input class="gt-geocoder-input" type="text" placeholder="Search for a place..." autocomplete="off" spellcheck="false">
                <button class="gt-geocoder-clear-btn" title="Clear" style="display:none;">&times;</button>
            </div>
            <div class="gt-geocoder-results"></div>
        `;
    container.appendChild(this.panel);

    // Cache refs
    this._input = this.panel.querySelector('.gt-geocoder-input');
    this._clearBtn = this.panel.querySelector('.gt-geocoder-clear-btn');
    this._results = this.panel.querySelector('.gt-geocoder-results');
  }

  _bindEvents() {
    // Toggle open/close
    this.toggleBtn.addEventListener('click', () => {
      const isOpen = this.panel.style.display !== 'none';
      if (isOpen) {
        this._close();
      } else {
        this.panel.style.display = '';
        this._input.focus();
      }
    });

    // Typeahead input
    this._input.addEventListener('input', () => {
      const query = this._input.value.trim();
      this._clearBtn.style.display = query.length > 0 ? '' : 'none';

      if (this._geocoderTimer) clearTimeout(this._geocoderTimer);
      if (query.length < 2) {
        this._results.innerHTML = '';
        return;
      }

      this._geocoderTimer = setTimeout(() => this._geocode(query), 300);
    });

    // Clear button
    this._clearBtn.addEventListener('click', () => {
      this._input.value = '';
      this._clearBtn.style.display = 'none';
      this._results.innerHTML = '';
      this._input.focus();
    });
  }

  /**
   * Compute a rough viewport bbox from the current camera state.
   * Used for Google Places locationBias.
   *
   * The angular "half-width" is estimated from the camera distance
   * (distance - 1 in globe-radius units maps to km above ground).
   * At nadir (top-down), the visible arc is proportional to altitude.
   *
   * @returns {{ minLat: number, maxLat: number, minLon: number, maxLon: number }}
   */
  _getCameraViewport() {
    const cam = this.engine.camera;
    const RAD2DEG = 180 / Math.PI;
    const lat = cam.phi * RAD2DEG;
    const lon = cam.theta * RAD2DEG - 180;

    // Clamp alt to a sensible range. At distance=1.002 (street), alt≈0.002;
    // at distance=1.8 (country), alt≈0.8. Convert to angular degrees:
    // 0.002 globe-radius ≈ 12 km ≈ ~0.1°; 0.8 ≈ 5000 km ≈ ~45°.
    const altFraction = Math.max(cam.distance - 1.0, 0.001);
    const halfDeg = Math.min(altFraction * 60, 80); // ~60 deg per globe unit, capped

    return {
      minLat: Math.max(lat - halfDeg, -90),
      maxLat: Math.min(lat + halfDeg, 90),
      minLon: lon - halfDeg,
      maxLon: lon + halfDeg,
    };
  }

  async _geocode(query) {
    if (!this._provider) return;

    // Cancel any in-flight request.
    if (this._abort) this._abort.abort();
    this._abort = new AbortController();

    let results;
    try {
      const viewport = this._getCameraViewport();
      results = await this._provider.autocomplete(query, {
        signal: this._abort.signal,
        viewport,
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[GeocoderDialog] autocomplete error:', err);
      }
      return;
    }

    this._renderResults(results);
  }

  /**
   * @param {import('../geocoder/providers/GeocoderProvider.js').NormalizedResult[]} results
   */
  _renderResults(results) {
    this._results.innerHTML = '';
    for (const result of results) {
      const item = document.createElement('div');
      item.className = 'gt-geocoder-result-item';
      item.innerHTML = `
                <svg class="gt-geocoder-result-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    <circle cx="12" cy="10" r="3"></circle>
                </svg>
                <div class="gt-geocoder-result-text">
                    <div class="gt-geocoder-result-name">${_escapeHtml(result.name)}</div>
                    <div class="gt-geocoder-result-context">${_escapeHtml(result.displayName)}</div>
                </div>
            `;
      item.addEventListener('click', () => {
        this._selectResult(result);
      });
      this._results.appendChild(item);
    }
  }

  /**
   * Handle a result selection.
   *
   * For Google results (result._needsResolve = true) this calls
   * resolvePlace() to fetch lat/lon before flying. For Mapbox results,
   * the coordinates are already in the result object.
   *
   * @param {import('../geocoder/providers/GeocoderProvider.js').NormalizedResult} result
   */
  async _selectResult(result) {
    // Two-step Google flow: autocomplete gives us placeId only, no coordinates.
    if (result._needsResolve) {
      const details = await this._provider.resolvePlace(result.id);
      if (!details) {
        console.warn('[GeocoderDialog] Could not resolve place details for', result.id);
        return;
      }
      Object.assign(result, details);
    }

    if (result.lat == null || result.lon == null) {
      console.warn('[GeocoderDialog] Result has no coordinates after resolve:', result);
      return;
    }

    this._input.value = result.displayName || result.name;
    this._results.innerHTML = '';

    this.engine.camera.flyTo(result.lat, result.lon, flyToDistanceForType(result.type));

    // Close panel after brief delay.
    setTimeout(() => this._close(), 600);
  }

  /** Close the panel and reset any open provider session. */
  _close() {
    this.panel.style.display = 'none';
    // Let the provider clean up any open session state (e.g. unused Google session token).
    if (this._provider) this._provider.resetSession();
  }

  update() {
    // Geocoder doesn't need per-frame updates.
  }

  /** Show or hide the geocoder (toggle button + panel). */
  setVisible(visible) {
    if (this.toggleBtn) this.toggleBtn.style.display = visible ? '' : 'none';
    if (!visible && this.panel) this.panel.style.display = 'none';
  }

  destroy() {
    if (this._geocoderTimer) clearTimeout(this._geocoderTimer);
    if (this._abort) this._abort.abort();
    if (this.toggleBtn?.parentNode) this.toggleBtn.parentNode.removeChild(this.toggleBtn);
    if (this.panel?.parentNode) this.panel.parentNode.removeChild(this.panel);
  }
}

/**
 * Minimal HTML escaping for text injected into innerHTML.
 * @param {string} str
 * @returns {string}
 */
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
