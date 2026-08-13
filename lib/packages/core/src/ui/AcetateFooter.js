/**
 * AcetateFooter.js — Status bar at the bottom of the map showing
 * LAT/LON/ALT/ZOOM on the left and FPS/draw-calls on the right.
 *
 * Programmatically creates its own DOM and hooks mouse tracking.
 */

export class AcetateFooter {
  /**
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {HTMLElement} container - Parent element to append the footer to
   */
  constructor(engine, container) {
    this.engine = engine;
    this.mouseLat = 0;
    this.mouseLon = 0;

    this._createDOM(container);
    this._bindMouseTracking();
  }

  _createDOM(container) {
    const footer = document.createElement('div');
    footer.className = 'gt-acetate-footer';
    footer.innerHTML = `
            <div class="gt-acetate-left">
                <span class="gt-acetate-item"><span class="gt-acetate-label">LAT</span> <span class="gt-footer-lat gt-mono">0.0000</span></span>
                <span class="gt-acetate-sep">|</span>
                <span class="gt-acetate-item"><span class="gt-acetate-label">LON</span> <span class="gt-footer-lon gt-mono">0.0000</span></span>
                <span class="gt-acetate-sep">|</span>
                <span class="gt-acetate-item"><span class="gt-acetate-label">ALT</span> <span class="gt-footer-alt gt-mono">0.0000</span></span>
                <span class="gt-acetate-sep">|</span>
                <span class="gt-acetate-item"><span class="gt-acetate-label">ALT FT</span> <span class="gt-footer-alt-ft gt-mono">0</span></span>
                <span class="gt-acetate-sep">|</span>
                <span class="gt-acetate-item"><span class="gt-acetate-label">ZOOM</span> <span class="gt-footer-zoom gt-mono">2</span></span>
                <span class="gt-acetate-sep gt-footer-attribution-sep" style="display:none">|</span>
                <span class="gt-acetate-item gt-footer-attribution-wrap" style="display:none">
                    <span class="gt-footer-attribution gt-mono"></span>
                </span>
            </div>
            <div class="gt-acetate-right">
                <span class="gt-acetate-item"><span class="gt-footer-backend gt-mono" style="color:rgba(0,229,255,0.8)"></span></span>
                <span class="gt-acetate-sep">|</span>
                <span class="gt-acetate-item"><span class="gt-footer-fps gt-mono">60</span> <span class="gt-acetate-label">FPS</span></span>
                <span class="gt-acetate-sep">|</span>
                <span class="gt-acetate-item"><span class="gt-footer-draws gt-mono">0</span> <span class="gt-acetate-label">draws</span></span>
            </div>
        `;

    container.appendChild(footer);
    this.el = footer;

    // Cache element references
    this._elLat = footer.querySelector('.gt-footer-lat');
    this._elLon = footer.querySelector('.gt-footer-lon');
    this._elAlt = footer.querySelector('.gt-footer-alt');
    this._elAltFt = footer.querySelector('.gt-footer-alt-ft');
    this._elZoom = footer.querySelector('.gt-footer-zoom');
    this._elFps = footer.querySelector('.gt-footer-fps');
    this._elDraws = footer.querySelector('.gt-footer-draws');
    this._elBackend = footer.querySelector('.gt-footer-backend');

    // Attribution slot — hidden until setAttribution() is called with a non-empty
    // string. The separator is hidden alongside it so we don't get a dangling pipe.
    this._elAttribution = footer.querySelector('.gt-footer-attribution');
    this._elAttributionWrap = footer.querySelector('.gt-footer-attribution-wrap');
    this._elAttributionSep = footer.querySelector('.gt-footer-attribution-sep');

    // Set backend label once (WebGPU is the only backend)
    this._elBackend.textContent = 'WebGPU';
  }

  /**
   * Set the basemap attribution text shown in the footer's left cluster
   * after the ZOOM readout. Pass an empty string (or null/undefined) to hide
   * the slot. Wired up by UIManager via the engine's 'basemap-changed' event.
   *
   * @param {string} text
   */
  setAttribution(text) {
    if (!this._elAttribution) return;
    const trimmed = (text || '').trim();
    if (!trimmed) {
      this._elAttributionWrap.style.display = 'none';
      this._elAttributionSep.style.display = 'none';
      return;
    }
    this._elAttribution.textContent = trimmed;
    this._elAttributionWrap.style.display = '';
    this._elAttributionSep.style.display = '';
  }

  _bindMouseTracking() {
    this._mouseMoveHandler = (e) => {
      const canvas = this.engine.canvas;
      const camera = this.engine.camera;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const sx = (e.clientX - rect.left) * dpr;
      const sy = (e.clientY - rect.top) * dpr;
      const hit = camera._screenToGlobe(sx, sy, canvas.width, canvas.height);
      if (hit) {
        const RAD2DEG = 180 / Math.PI;
        let lon = hit.theta * RAD2DEG - 180;
        if (lon < -180) lon += 360;
        this.mouseLon = lon;
        this.mouseLat = hit.phi * RAD2DEG;
      }
    };
    this.engine.canvas.addEventListener('mousemove', this._mouseMoveHandler);
  }

  /**
   * Update the footer readouts. Called each frame.
   * @param {{ fps: number, drawCalls: number }} frameData
   */
  update(frameData) {
    // Mouse lat/lon (every frame for smooth tracking)
    const lonDir = this.mouseLon >= 0 ? 'E' : 'W';
    const latDir = this.mouseLat >= 0 ? 'N' : 'S';
    this._elLon.textContent = Math.abs(this.mouseLon).toFixed(4) + '° ' + lonDir;
    this._elLat.textContent = Math.abs(this.mouseLat).toFixed(4) + '° ' + latDir;

    // Altitude & zoom (throttled via frameData.throttled flag)
    if (frameData.throttled) {
      this._elFps.textContent = frameData.fps;
      this._elDraws.textContent = frameData.drawCalls;

      const altitude = this.engine.camera.distance - 1.0;
      this._elAlt.textContent = altitude < 0.001 ? altitude.toExponential(2) : altitude.toFixed(4);
      // 20,925,525 ft = Earth radius (matches FEET_TO_GLOBE in shaders)
      this._elAltFt.textContent = Math.round(altitude * 20925525).toLocaleString();

      if (this.engine.tileManager) {
        this._elZoom.textContent = this.engine.tileManager.zoomFromDistance(
          this.engine.camera.distance
        );
      }
    }
  }

  /** Show or hide the footer. */
  setVisible(visible) {
    if (this.el) this.el.style.display = visible ? '' : 'none';
  }

  destroy() {
    this.engine.canvas.removeEventListener('mousemove', this._mouseMoveHandler);
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }
}
