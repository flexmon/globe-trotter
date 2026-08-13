/**
 * LayerManagerDialog.js — Draggable layer manager panel with basemap select,
 * data layer toggles, and color ramp previews.
 *
 * Basemap dropdown options are derived at render time from the active
 * tile provider's STYLES table (MapboxProvider, GoogleProvider, ...).
 * If no tile system is initialised the basemap section is omitted.
 */

/**
 * Build the [{value, label}] list for the basemap dropdown from the engine's
 * active TileManager. Returns an empty array when the tile system isn't
 * initialised (e.g. neither Mapbox nor Google credentials were provided).
 *
 * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
 * @returns {Array<{value: string, label: string}>}
 */
function getBasemapOptions(engine) {
  const provider = engine?.tileManager?.provider;
  if (!provider) return [];
  const styles = provider.constructor.STYLES || {};
  return Object.keys(styles).map((value) => ({
    value,
    label: styles[value].label || value,
  }));
}

/**
 * Resolve the display label for a metric/attribute.
 * Looks up metricsMap[attr].label when available; falls back to the raw column name.
 * This is the single source of truth used by all UI render sites.
 *
 * @param {Object|null} layer - Layer info entry (has metricsMap)
 * @param {string} attr - Raw column name (used as the lookup key AND the fallback)
 * @returns {string}
 */
function metricLabel(layer, attr) {
  return layer?.metricsMap?.[attr]?.label || attr;
}

/**
 * Linearly interpolate between two CSS hex colors.
 * @param {string} hex1 - Start color (e.g. '#ff0000')
 * @param {string} hex2 - End color (e.g. '#0000ff')
 * @param {number} t - Interpolation factor 0..1
 * @returns {string} Interpolated hex color
 */
function lerpHex(hex1, hex2, t) {
  const r1 = parseInt(hex1.slice(1, 3), 16);
  const g1 = parseInt(hex1.slice(3, 5), 16);
  const b1 = parseInt(hex1.slice(5, 7), 16);
  const r2 = parseInt(hex2.slice(1, 3), 16);
  const g2 = parseInt(hex2.slice(3, 5), 16);
  const b2 = parseInt(hex2.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

export class LayerManagerDialog {
  /**
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {HTMLElement} container
   */
  constructor(engine, container, opts = {}) {
    this.engine = engine;
    this._stickyPos = null;
    this._showBasemap = opts.basemap !== false;
    this._createDOM(container);
    this._bindEvents();
  }

  _createDOM(container) {
    // Layers toggle button
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'gt-glass-panel gt-layers-btn';
    this.toggleBtn.title = 'Layer Manager';
    this.toggleBtn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
              <polyline points="2 17 12 22 22 17"></polyline>
              <polyline points="2 12 12 17 22 12"></polyline>
            </svg>
            <span>Layers</span>
        `;
    container.appendChild(this.toggleBtn);

    // Layer manager panel
    this.panel = document.createElement('div');
    this.panel.className = 'gt-glass-panel gt-layer-manager-panel';
    this.panel.style.display = 'none';

    // Restore sticky zoom from localStorage
    const savedZoom = localStorage.getItem('gt-dialog-zoom') || '1.0';
    this.panel.style.zoom = savedZoom;

    // Build basemap select options from the active provider's STYLES.
    // When no tile system is initialised the basemap section is hidden.
    const basemapOptions = getBasemapOptions(this.engine);
    const currentStyle = this.engine?.tileManager?.style;
    const basemapOptionsHtml = basemapOptions
      .map(
        (o) =>
          `<option value="${o.value}"${o.value === currentStyle ? ' selected' : ''}>${o.label}</option>`
      )
      .join('');
    const basemapSectionHtml =
      basemapOptions.length === 0 || !this._showBasemap
        ? ''
        : `
            <div class="gt-lm-section gt-lm-basemap-section">
                <div class="gt-lm-section-label">Basemap</div>
                <div class="gt-lm-basemap-row">
                    <select class="gt-stats-select gt-lm-basemap-select">
                        ${basemapOptionsHtml}
                    </select>
                </div>
            </div>
        `;

    this.panel.innerHTML = `
            <div class="gt-lm-header">
                <h3 class="gt-lm-title">Layer Manager</h3>
                <select class="gt-lm-zoom-select" title="UI zoom scale">
                    <option value="1.0"${savedZoom === '1.0' ? ' selected' : ''}>1.0×</option>
                    <option value="1.2"${savedZoom === '1.2' ? ' selected' : ''}>1.2×</option>
                    <option value="1.4"${savedZoom === '1.4' ? ' selected' : ''}>1.4×</option>
                    <option value="1.6"${savedZoom === '1.6' ? ' selected' : ''}>1.6×</option>
                    <option value="1.8"${savedZoom === '1.8' ? ' selected' : ''}>1.8×</option>
                    <option value="2.0"${savedZoom === '2.0' ? ' selected' : ''}>2.0×</option>
                </select>
                <button class="gt-lm-close-btn" title="Close">&times;</button>
            </div>
            ${basemapSectionHtml}
            <div class="gt-lm-section">
                <div class="gt-lm-section-label">Data Layers</div>
                <div class="gt-lm-upload-bar">
                    <button class="gt-lm-add-geojson-btn" title="Upload a .geojson or .json file">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19"></line>
                          <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Add GeoJSON…
                    </button>
                    <span class="gt-lm-upload-status"></span>
                    <input type="file" class="gt-lm-file-input" accept=".geojson,.json,application/geo+json,application/json" style="display:none">
                </div>
                <div class="gt-lm-layer-list"></div>
            </div>
        `;
    document.body.appendChild(this.panel);

    // Cache refs
    this._header = this.panel.querySelector('.gt-lm-header');
    this._closeBtn = this.panel.querySelector('.gt-lm-close-btn');
    this._basemapSelect = this.panel.querySelector('.gt-lm-basemap-select');
    this._basemapSection = this.panel.querySelector('.gt-lm-basemap-section');
    this._layerList = this.panel.querySelector('.gt-lm-layer-list');
    this._addGeoJSONBtn = this.panel.querySelector('.gt-lm-add-geojson-btn');
    this._fileInput = this.panel.querySelector('.gt-lm-file-input');
    this._uploadStatus = this.panel.querySelector('.gt-lm-upload-status');

    // Zoom selector
    const zoomSelect = this.panel.querySelector('.gt-lm-zoom-select');
    zoomSelect.addEventListener('change', (e) => {
      this.panel.style.zoom = e.target.value;
      localStorage.setItem('gt-dialog-zoom', e.target.value);
    });

    // Add GeoJSON button → open file picker
    this._addGeoJSONBtn.addEventListener('click', () => {
      this._fileInput.value = '';
      this._fileInput.click();
    });

    // File picker → ingest
    this._fileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) await this._ingestGeoJSONFile(file);
    });
  }

  async _ingestGeoJSONFile(file) {
    this._uploadStatus.textContent = `Loading ${file.name}…`;
    this._uploadStatus.style.color = 'var(--gt-text-secondary)';
    try {
      const text = await file.text();
      const geojson = JSON.parse(text);
      const basename = file.name.replace(/\.(geo)?json$/i, '');
      const created = this.engine.addGeoJSONLayer(basename, geojson);
      this._uploadStatus.textContent = `✓ ${created.length} layer${created.length !== 1 ? 's' : ''} added`;
      this._uploadStatus.style.color = '#7CB518';
      this._populateLayers();
      setTimeout(() => {
        this._uploadStatus.textContent = '';
      }, 3000);
    } catch (err) {
      this._uploadStatus.textContent = `✗ ${err.message}`;
      this._uploadStatus.style.color = '#FF4081';
    }
  }

  _bindEvents() {
    // Toggle open/close
    this.toggleBtn.addEventListener('click', () => {
      const isOpen = this.panel.style.display !== 'none';
      if (isOpen) {
        this.panel.style.display = 'none';
      } else {
        this._populateLayers();
        if (this._stickyPos) {
          this.panel.style.left = this._stickyPos.left;
          this.panel.style.top = this._stickyPos.top;
          this.panel.style.right = 'auto';
        } else {
          // Position to the right of the button with 10px gap (fixed to viewport)
          const btnRect = this.toggleBtn.getBoundingClientRect();
          this.panel.style.left = btnRect.right + 10 + 'px';
          this.panel.style.top = btnRect.top + 'px';
          this.panel.style.right = 'auto';
        }
        this.panel.style.display = '';
      }
    });

    this._closeBtn.addEventListener('click', () => {
      this.panel.style.display = 'none';
    });

    // Basemap selector — may be absent if no tile system is initialised
    if (this._basemapSelect) {
      this._basemapSelect.addEventListener('change', (e) => {
        this.engine.setBasemap(e.target.value);
      });
    }

    // Drag-to-reposition (container-relative coordinates)
    const dragState = { dragging: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 };
    this._header.style.cursor = 'grab';

    this._header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.gt-lm-close-btn') || e.target.closest('.gt-lm-zoom-select')) return;
      e.preventDefault();
      const zoom = parseFloat(this.panel.style.zoom) || 1;
      dragState.dragging = true;
      dragState.zoom = zoom;
      dragState.startX = e.clientX;
      dragState.startY = e.clientY;
      const rect = this.panel.getBoundingClientRect();
      const cRect = this.panel.parentElement
        ? this.panel.parentElement.getBoundingClientRect()
        : { left: 0, top: 0 };
      dragState.startLeft = (rect.left - cRect.left) / zoom;
      dragState.startTop = (rect.top - cRect.top) / zoom;
      this._header.style.cursor = 'grabbing';
    });

    this._mouseMoveHandler = (e) => {
      if (!dragState.dragging) return;
      const zoom = dragState.zoom;
      const dx = (e.clientX - dragState.startX) / zoom;
      const dy = (e.clientY - dragState.startY) / zoom;
      const cRect = this.panel.parentElement
        ? this.panel.parentElement.getBoundingClientRect()
        : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const containerW = cRect.width || window.innerWidth;
      const containerH = cRect.height || window.innerHeight;
      const panelW = this.panel.offsetWidth * zoom;
      const panelH = this.panel.offsetHeight * zoom;
      const margin = 10;
      const newLeft = Math.max(
        margin / zoom,
        Math.min((containerW - panelW - margin) / zoom, dragState.startLeft + dx)
      );
      const newTop = Math.max(
        margin / zoom,
        Math.min((containerH - panelH - margin) / zoom, dragState.startTop + dy)
      );
      this.panel.style.left = newLeft + 'px';
      this.panel.style.top = newTop + 'px';
      this.panel.style.right = 'auto';
    };

    this._mouseUpHandler = () => {
      if (!dragState.dragging) return;
      dragState.dragging = false;
      this._header.style.cursor = 'grab';
      this._stickyPos = {
        left: this.panel.style.left,
        top: this.panel.style.top,
      };
    };

    window.addEventListener('mousemove', this._mouseMoveHandler);
    window.addEventListener('mouseup', this._mouseUpHandler);
  }

  _populateLayers() {
    this._layerList.innerHTML = '';

    const layers = this.engine.layerManager.getLayerInfo();

    for (const layer of layers) {
      const row = document.createElement('div');
      row.className = 'gt-lm-layer-row';

      const top = document.createElement('div');
      top.className = 'gt-lm-layer-top';

      // Toggle switch
      const toggle = document.createElement('label');
      toggle.className = 'gt-lm-toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = layer.visible;
      checkbox.addEventListener('change', () => {
        this.engine.layerManager.toggleLayerVisibility(layer.name);
      });
      const track = document.createElement('span');
      track.className = 'gt-lm-toggle-track';
      toggle.appendChild(checkbox);
      toggle.appendChild(track);

      // Info block
      const info = document.createElement('div');
      info.className = 'gt-lm-layer-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'gt-lm-layer-name';
      nameEl.textContent = layer.name;

      // ── Info button (ⓘ) ──
      const infoBtn = document.createElement('button');
      infoBtn.className = 'gt-lm-info-btn';
      infoBtn.title = 'Dataset Info';
      infoBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>`;
      infoBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showLayerInfo(layer.name);
      });

      const metaEl = document.createElement('div');
      metaEl.className = 'gt-lm-layer-meta';
      const count = layer.featureCount.toLocaleString();
      const typeLabel = layer.type.startsWith('h3f')
        ? 'cells'
        : layer.type === 'mfb'
          ? 'entities'
          : 'features';
      metaEl.textContent = `${count} ${typeLabel} · ${layer.epochCount} epochs`;

      const nameRow = document.createElement('div');
      nameRow.className = 'gt-lm-layer-name-row';
      nameRow.appendChild(nameEl);
      nameRow.appendChild(infoBtn);
      info.appendChild(nameRow);
      info.appendChild(metaEl);
      top.appendChild(toggle);
      top.appendChild(info);
      row.appendChild(top);

      // ─── Symbology button ───
      const hasRamp = layer.stops && layer.domain;
      const isGfb = layer.type.startsWith('gfb');
      const isH3f = layer.type.startsWith('h3f');
      const isDgf = layer.type.startsWith('dgf');
      const isGeoJSON = layer.type === 'geojson';
      const isGrid = isH3f || isDgf;

      if (isGrid || isGfb || isGeoJSON) {
        const symSection = document.createElement('div');
        symSection.className = 'gt-lm-extrude-section';

        // Format-specific styled attribute preview pipeline
        if (hasRamp) {
          // Continuous gradient preview bar for data-driven grid heatmaps and vector ramps
          const previewRow = document.createElement('div');
          previewRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';

          if (layer.attribute) {
            const attrEl = document.createElement('span');
            attrEl.className = 'gt-lm-ramp-attr';
            attrEl.style.marginBottom = '0';
            attrEl.textContent = metricLabel(layer, layer.attribute);
            previewRow.appendChild(attrEl);
          }

          const miniRamp = document.createElement('div');
          miniRamp.style.cssText = 'flex:1;height:6px;border-radius:3px';
          const sorted = [...layer.stops].sort((a, b) => a.value - b.value);
          const range = layer.domain[1] - layer.domain[0] || 1;
          const gradStops = sorted
            .map((s) => {
              const pct = (((s.value - layer.domain[0]) / range) * 100).toFixed(1);
              return `${s.color} ${pct}%`;
            })
            .join(', ');
          miniRamp.style.background = `linear-gradient(to right, ${gradStops})`;
          previewRow.appendChild(miniRamp);
          symSection.appendChild(previewRow);
        } else if (isGfb && layer.attribute) {
          // Discrete Vector representation string (prevents gradient injection on unique points)
          const previewRow = document.createElement('div');
          previewRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';

          const attrEl = document.createElement('span');
          attrEl.className = 'gt-lm-ramp-attr';
          attrEl.style.marginBottom = '0';
          attrEl.textContent = `Categorical by: ${metricLabel(layer, layer.attribute)}`;
          previewRow.appendChild(attrEl);
          symSection.appendChild(previewRow);
        }

        // Symbology button
        const symBtn = document.createElement('button');
        symBtn.className = 'gt-lm-symbology-btn';
        symBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg> Symbology`;
        symBtn.title = 'Open symbology editor';

        symBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this._activeSymbologyDialog) {
            this._activeSymbologyDialog.destroy();
            this._activeSymbologyDialog = null;
          }

          if (isGfb || isGeoJSON) {
            const ld = this.engine.layerManager.layers.get(layer.name);
            const geomType = ld?.data?.geomType;
            if (geomType === 3 || geomType === 4) {
              import('./LineSymbologyDialog.js').then(({ LineSymbologyDialog }) => {
                this._activeSymbologyDialog = new LineSymbologyDialog(this.engine, layer.name);
              });
            } else if (geomType === 5 || geomType === 6) {
              import('./PolygonSymbologyDialog.js').then(({ PolygonSymbologyDialog }) => {
                this._activeSymbologyDialog = new PolygonSymbologyDialog(this.engine, layer.name);
              });
            } else {
              import('./SymbologyDialog.js').then(({ SymbologyDialog }) => {
                this._activeSymbologyDialog = new SymbologyDialog(this.engine, layer.name);
              });
            }
          } else if (isH3f || isDgf) {
            import('./H3SymbologyDialog.js').then(({ H3SymbologyDialog }) => {
              const _attr = layer.activeMetric || layer.attribute;
              this._activeSymbologyDialog = new H3SymbologyDialog(this.engine, layer.name, {
                stops:
                  layer.stops ||
                  (layer.metrics &&
                    layer.metrics[layer.activeMetric] &&
                    layer.metrics[layer.activeMetric].style.stops),
                domain:
                  layer.domain ||
                  (layer.metrics &&
                    layer.metrics[layer.activeMetric] &&
                    layer.metrics[layer.activeMetric].style.domain),
                attribute: _attr,
                label: metricLabel(layer, _attr),
              });
            });
          }
        });

        symSection.appendChild(symBtn);
        row.appendChild(symSection);
      }

      // ─── Attribute selector (Temporal Attributes) ───
      // When the YAML declares an explicit metrics block, restrict the
      // dropdown to those keys — the YAML is authoritative over which
      // metrics the user should be able to choose from. The dropdown is
      // hidden entirely when only one metric is visible (no real choice).
      const _declared = layer.metricsMap ? Object.keys(layer.metricsMap) : null;
      const _allTemporal = layer.temporalAttributes || [];
      const _visibleAttrs =
        _declared && _declared.length > 0
          ? _allTemporal.filter((a) => _declared.includes(a))
          : _allTemporal;
      if (
        ['h3f', 'dgf', 'gfb', 'mfb'].some((t) => layer.type.startsWith(t)) &&
        _visibleAttrs.length >= 2
      ) {
        const attrSection = document.createElement('div');
        attrSection.className = 'gt-lm-extrude-section';

        const attrRow = document.createElement('div');
        attrRow.className = 'gt-lm-extrude-row';

        const attrLabel = document.createElement('span');
        attrLabel.className = 'gt-lm-extrude-label';
        attrLabel.textContent = 'Metric';

        const attrSelect = document.createElement('select');
        attrSelect.className = 'gt-stats-select gt-lm-attr-select';
        const currentAttr = layer.activeMetric || layer.attribute || _visibleAttrs[0];

        // Restrict the dropdown to the declared metric subset. develop-tristan
        // declares this explicitly via layer.metricAttributes; the catalog-driven
        // metrics config declares it via layer.metricsMap (already applied above in
        // _visibleAttrs). Compose both so either declaration narrows the list.
        const attrsToShow = layer.metricAttributes?.length
          ? _visibleAttrs.filter((a) => layer.metricAttributes.includes(a))
          : _visibleAttrs;
        for (const attrName of attrsToShow) {
          const opt = document.createElement('option');
          opt.value = attrName; // raw column name — used by setActiveMetric
          opt.textContent = metricLabel(layer, attrName); // friendly label when available
          if (attrName === currentAttr) opt.selected = true;
          attrSelect.appendChild(opt);
        }

        attrSelect.addEventListener('change', async () => {
          // Destroy any open symbology dialog — its internal stops/domain/attribute
          // are now stale because they were cloned from the previous metric at
          // construction time and have no live connection to the layer's style.
          if (this._activeSymbologyDialog) {
            this._activeSymbologyDialog.destroy();
            this._activeSymbologyDialog = null;
          }
          // Await the full async metric switch (shard load + style recompile)
          // before repopulating the panel.  Without the await, _populateLayers()
          // runs while layer.style still reflects the old metric, so the ramp
          // preview and any newly opened H3SymbologyDialog receive stale data.
          await this.engine.layerManager.setActiveMetric(layer.name, attrSelect.value);
          // Refresh panel to update ramp preview and gradient bar
          this._populateLayers();
        });

        attrRow.appendChild(attrLabel);
        attrRow.appendChild(attrSelect);
        attrSection.appendChild(attrRow);
        row.appendChild(attrSection);
      }

      // ─── SQL Query button removed — now global via UIManager ───
      // ─── GPU Filter input with autocomplete (H3F, GFB, MFB, and GeoJSON layers) ───
      if (
        layer.type.startsWith('h3f') ||
        layer.type.startsWith('gfb') ||
        layer.type === 'mfb' ||
        layer.type === 'geojson'
      ) {
        const filterSection = document.createElement('div');
        filterSection.className = 'gt-lm-filter-section';

        const filterRow = document.createElement('div');
        filterRow.className = 'gt-lm-filter-row';

        // Autocomplete wrapper (takes full width)
        const acWrapper = document.createElement('div');
        acWrapper.className = 'gt-ac-wrapper';

        const filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.className = 'gt-lm-filter-input';
        filterInput.setAttribute('autocomplete', 'off');
        filterInput.setAttribute('spellcheck', 'false');

        // Gather schema info
        const layerData = this.engine.layerManager.layers.get(layer.name);
        const schemaCols = [];
        const enumCols = new Set();
        const dictValues = layerData?.data?.dictionary || [];
        if (layerData?.data?.schema) {
          for (const s of layerData.data.schema) {
            schemaCols.push({ name: s.name, type: s.type, temporal: s.temporal });
            if (
              s.type === 6 ||
              s.type === 8 ||
              s.type === 9 ||
              s.type === 14 ||
              String(s.type).includes('enum')
            )
              enumCols.add(s.name); // ENUM16/32
          }
        }

        filterInput.placeholder =
          schemaCols.length > 0 ? `Filter: ${schemaCols[0].name} > 50` : 'Filter: column > value';

        // Restore active filter
        if (layerData?.activeFilter) {
          filterInput.value = layerData.activeFilter;
        }

        // Dropdown
        const dropdown = document.createElement('div');
        dropdown.className = 'gt-ac-dropdown';
        dropdown.style.display = 'none';

        let activeIdx = -1;
        let currentItems = [];
        const OPERATORS = ['>', '<', '>=', '<=', '=', '..'];
        const COMBINATORS = ['AND', 'OR'];

        // ── Determine suggestion context from current input ──
        function getSuggestions(text) {
          if (!text || !text.trim()) {
            // Empty → show all columns
            return {
              type: 'column',
              items: schemaCols.map((c) => ({
                label: c.name,
                badge: c.type === 6 || c.type === 8 || c.type === 9 ? 'enum' : 'numeric',
                value: c.name,
              })),
            };
          }

          const tokens = text.trimEnd().split(/\s+/);
          const lastChar = text[text.length - 1];
          const endsWithSpace = lastChar === ' ';

          // Token count logic for context detection
          // Pattern: COLUMN OP VALUE [COMBINATOR COLUMN OP VALUE ...]
          // After combinator, we restart the pattern
          const isCombinator = (t) => t === 'AND' || t === 'OR';

          // Find how many tokens into the current predicate we are
          let predTokens = [];
          for (let i = tokens.length - 1; i >= 0; i--) {
            if (isCombinator(tokens[i].toUpperCase()) && i > 0) {
              predTokens = tokens.slice(i + 1);
              break;
            }
            if (i === 0) predTokens = tokens;
          }

          const predLen = predTokens.length;

          // If we have a trailing space, we've committed the last token
          if (endsWithSpace) {
            if (predLen === 0) {
              // After combinator + space → show columns
              return {
                type: 'column',
                items: schemaCols.map((c) => ({
                  label: c.name,
                  badge:
                    c.type === 6 ||
                    c.type === 8 ||
                    c.type === 9 ||
                    c.type === 14 ||
                    String(c.type).includes('enum')
                      ? 'enum'
                      : 'numeric',
                  value: c.name,
                })),
              };
            }
            if (predLen === 1) {
              // After column name + space → show operators
              return {
                type: 'operator',
                items: OPERATORS.map((op) => ({
                  label: op,
                  badge: 'op',
                  value: op,
                })),
              };
            }
            if (predLen === 2) {
              // After column + operator + space → show enum values if applicable
              const colName = predTokens[0];
              const op = predTokens[1];
              if (enumCols.has(colName) && (op === '=' || op === '==')) {
                return {
                  type: 'enum',
                  items: dictValues.map((v) => ({
                    label: v,
                    badge: 'value',
                    value: v,
                  })),
                };
              }
              // Numeric → no suggestions (user types number)
              return { type: 'none', items: [] };
            }
            if (predLen >= 3) {
              // Complete predicate → suggest combinators
              return {
                type: 'combinator',
                items: COMBINATORS.map((c) => ({
                  label: c,
                  badge: 'logic',
                  value: c,
                })),
              };
            }
          } else {
            // Still typing a token — filter based on what it could be
            const partial = predTokens[predLen - 1] || '';
            const partialUpper = partial.toUpperCase();

            if (predLen === 1) {
              // Typing column name — filter
              const filtered = schemaCols
                .filter((c) => c.name.toLowerCase().includes(partial.toLowerCase()))
                .map((c) => ({
                  label: c.name,
                  badge:
                    c.type === 6 ||
                    c.type === 8 ||
                    c.type === 9 ||
                    c.type === 14 ||
                    String(c.type).includes('enum')
                      ? 'enum'
                      : 'numeric',
                  value: c.name,
                }));
              return { type: 'column', items: filtered };
            }
            if (predLen === 2) {
              // Typing operator
              const filtered = OPERATORS.filter((op) => op.startsWith(partial)).map((op) => ({
                label: op,
                badge: 'op',
                value: op,
              }));
              return { type: 'operator', items: filtered };
            }
            if (predLen === 3) {
              // Typing value — check if enum
              const colName = predTokens[0];
              if (enumCols.has(colName)) {
                const filtered = dictValues
                  .filter((v) => v.toUpperCase().includes(partialUpper))
                  .map((v) => ({ label: v, badge: 'value', value: v }));
                return { type: 'enum', items: filtered };
              }
              return { type: 'none', items: [] };
            }
            if (predLen >= 4) {
              // Might be typing a combinator
              const filtered = COMBINATORS.filter((c) => c.startsWith(partialUpper)).map((c) => ({
                label: c,
                badge: 'logic',
                value: c,
              }));
              return { type: 'combinator', items: filtered };
            }
          }

          return { type: 'none', items: [] };
        }

        function renderDropdown(suggestions) {
          dropdown.innerHTML = '';
          currentItems = suggestions.items;
          activeIdx = -1;

          if (currentItems.length === 0) {
            dropdown.style.display = 'none';
            return;
          }

          const maxShow = 8;
          const items = currentItems.slice(0, maxShow);
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const el = document.createElement('div');
            el.className = 'gt-ac-item';
            el.dataset.index = i;

            const label = document.createElement('span');
            label.className = 'gt-ac-label';
            label.textContent = item.label;
            el.appendChild(label);

            if (item.badge) {
              const badge = document.createElement('span');
              badge.className = 'gt-ac-badge gt-ac-badge-' + item.badge;
              badge.textContent = item.badge;
              el.appendChild(badge);
            }

            el.addEventListener('mousedown', (ev) => {
              ev.preventDefault(); // Keep focus on input
              acceptSuggestion(i);
            });

            dropdown.appendChild(el);
          }

          if (currentItems.length > maxShow) {
            const more = document.createElement('div');
            more.className = 'gt-ac-more';
            more.textContent = `+${currentItems.length - maxShow} more`;
            dropdown.appendChild(more);
          }

          // Flip upward if near bottom of panel
          const panelEl = filterInput.closest('.gt-layer-manager-panel');
          if (panelEl) {
            const panelRect = panelEl.getBoundingClientRect();
            const inputRect = filterInput.getBoundingClientRect();
            const spaceBelow = panelRect.bottom - inputRect.bottom;
            dropdown.classList.toggle('gt-ac-dropdown-up', spaceBelow < 200);
          }

          dropdown.style.display = 'block';
        }

        function acceptSuggestion(idx) {
          if (idx < 0 || idx >= currentItems.length) return;
          const item = currentItems[idx];
          const text = filterInput.value;
          const tokens = text.trimEnd().split(/\s+/);
          const endsWithSpace = text.length > 0 && text[text.length - 1] === ' ';

          if (endsWithSpace || tokens.length === 0) {
            // Append new token
            filterInput.value = text + item.value + ' ';
          } else {
            // Replace partial last token
            tokens[tokens.length - 1] = item.value;
            filterInput.value = tokens.join(' ') + ' ';
          }

          // Trigger suggestions for next context
          const newSuggestions = getSuggestions(filterInput.value);
          renderDropdown(newSuggestions);

          // Also trigger debounced filter
          filterInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        function highlightItem(newIdx) {
          const items = dropdown.querySelectorAll('.gt-ac-item');
          items.forEach((el) => el.classList.remove('active'));
          activeIdx = Math.max(-1, Math.min(newIdx, currentItems.length - 1));
          if (activeIdx >= 0 && items[activeIdx]) {
            items[activeIdx].classList.add('active');
            items[activeIdx].scrollIntoView({ block: 'nearest' });
          }
        }

        // ── Event listeners ──
        filterInput.addEventListener('input', () => {
          const suggestions = getSuggestions(filterInput.value);
          renderDropdown(suggestions);
        });

        filterInput.addEventListener('focus', () => {
          const suggestions = getSuggestions(filterInput.value);
          renderDropdown(suggestions);
        });

        filterInput.addEventListener('blur', () => {
          // Delay hide to allow click events on dropdown
          setTimeout(() => {
            dropdown.style.display = 'none';
          }, 150);
        });

        filterInput.addEventListener('keydown', (e) => {
          const isOpen = dropdown.style.display !== 'none';

          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (isOpen) {
              highlightItem(activeIdx + 1);
            } else {
              const suggestions = getSuggestions(filterInput.value);
              renderDropdown(suggestions);
            }
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (isOpen) highlightItem(activeIdx - 1);
          } else if ((e.key === 'Enter' || e.key === 'Tab') && isOpen && activeIdx >= 0) {
            e.preventDefault();
            acceptSuggestion(activeIdx);
          } else if (e.key === 'Escape') {
            if (isOpen) {
              dropdown.style.display = 'none';
              e.stopPropagation();
            } else {
              filterInput.value = '';
              this.engine.clearFilter(layer.name);
            }
          }
        });

        // ── Debounced filter application ──
        let filterTimeout;
        filterInput.addEventListener('input', () => {
          clearTimeout(filterTimeout);
          filterTimeout = setTimeout(() => {
            const query = filterInput.value.trim();
            if (query) {
              this.engine.setFilter(layer.name, query);
            } else {
              this.engine.clearFilter(layer.name);
            }
          }, 300);
        });

        acWrapper.appendChild(filterInput);
        acWrapper.appendChild(dropdown);
        filterRow.appendChild(acWrapper);

        // Clear filter button (outside acWrapper, to the right)
        const clearBtn = document.createElement('button');
        clearBtn.className = 'gt-lm-filter-clear-btn';
        clearBtn.textContent = '✕';
        clearBtn.title = 'Clear filter';
        clearBtn.style.display = filterInput.value ? '' : 'none';
        clearBtn.addEventListener('click', () => {
          filterInput.value = '';
          clearBtn.style.display = 'none';
          this.engine.clearFilter(layer.name);
          if (layerData) layerData.activeFilter = null;
          dropdown.style.display = 'none';
          filterInput.focus();
        });

        // Show/hide clear button on input
        filterInput.addEventListener('input', () => {
          clearBtn.style.display = filterInput.value ? '' : 'none';
        });

        filterRow.appendChild(clearBtn);
        filterSection.appendChild(filterRow);
        row.appendChild(filterSection);
      }

      // ─── Hover / click picking toggles (any layer registered for picking) ───
      const pc = this.engine._pickController;
      const entry = pc?.getLayer(layer.name);
      if (entry) {
        const pickSection = document.createElement('div');
        pickSection.className = 'gt-lm-filter-section';
        pickSection.style.paddingTop = '4px';

        const pickRow = document.createElement('div');
        pickRow.style.cssText = 'display:flex;gap:14px;align-items:center;';

        for (const mode of ['hover', 'click']) {
          const label = document.createElement('label');
          label.style.cssText =
            'display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;color:var(--gt-text-secondary);';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = entry[mode];
          cb.addEventListener('change', () => {
            pc.setLayerPickOptions(layer.name, { [mode]: cb.checked });
          });
          label.appendChild(cb);
          label.appendChild(
            document.createTextNode(mode.charAt(0).toUpperCase() + mode.slice(1) + ' info')
          );
          pickRow.appendChild(label);
        }
        pickSection.appendChild(pickRow);
        row.appendChild(pickSection);
      }

      this._layerList.appendChild(row);
    }
  }

  /**
   * Show a metadata info overlay for a layer.
   */
  _showLayerInfo(layerName) {
    // Remove any existing info overlay
    document.querySelector('.gt-layer-info-overlay')?.remove();

    const layerData = this.engine.layerManager.layers.get(layerName);
    if (!layerData) return;

    const data = layerData.data;
    const manifest = layerData.shardedLoader?.manifest;
    const schema = data.schema || [];
    const dict = data.dictionary || [];

    // Type name mapping
    const TYPE_NAMES = {
      1: 'Float32',
      2: 'Float64',
      3: 'Int8',
      4: 'Int16',
      5: 'Int32',
      6: 'Enum16',
      7: 'UInt8',
      8: 'UInt16',
      9: 'UInt32',
      10: 'String',
    };

    // Format description
    const fmt = layerData.type || 'unknown';
    const fmtDesc = fmt.startsWith('h3f')
      ? 'H3Flex Binary (H3F)'
      : fmt.startsWith('gfb')
        ? 'GeoFlex Binary (GFB)'
        : fmt;

    // Build overlay
    const overlay = document.createElement('div');
    overlay.className = 'gt-glass-panel gt-layer-info-overlay';

    let html = `
            <div class="gt-info-header">
                <h3 class="gt-info-title">${layerName}</h3>
                <button class="gt-info-close" title="Close">&times;</button>
            </div>
            <div class="gt-info-body">
                <div class="gt-info-badge">${fmtDesc}</div>

                <div class="gt-info-stats">
                    <div class="gt-info-stat">
                        <span class="gt-info-stat-value">${(data.featureCount || data.cellCount || 0).toLocaleString()}</span>
                        <span class="gt-info-stat-label">${fmt.startsWith('h3f') ? 'Cells' : 'Features'}</span>
                    </div>
                    <div class="gt-info-stat">
                        <span class="gt-info-stat-value">${(data.epochCount || 0).toLocaleString()}</span>
                        <span class="gt-info-stat-label">Epochs</span>
                    </div>`;

    if (manifest?.epochInterval) {
      const interval = manifest.epochInterval;
      const label = interval >= 60 ? `${interval / 60}m` : `${interval}s`;
      html += `
                    <div class="gt-info-stat">
                        <span class="gt-info-stat-value">${label}</span>
                        <span class="gt-info-stat-label">Interval</span>
                    </div>`;
    }

    if (manifest?.bbox) {
      const b = manifest.bbox;
      html += `
                    <div class="gt-info-stat gt-info-stat-wide">
                        <span class="gt-info-stat-value" style="font-size:11px">
                            ${b.minLat.toFixed(1)}°, ${b.minLon.toFixed(1)}° → ${b.maxLat.toFixed(1)}°, ${b.maxLon.toFixed(1)}°
                        </span>
                        <span class="gt-info-stat-label">Bounding Box</span>
                    </div>`;
    }

    html += `</div>`; // close stats

    // Column schema table
    if (schema.length > 0) {
      html += `
                <div class="gt-info-section-title">Columns</div>
                <table class="gt-info-table">
                    <thead><tr>
                        <th>Name</th><th>Type</th><th>Role</th>
                    </tr></thead>
                    <tbody>`;
      for (const col of schema) {
        const typeName = TYPE_NAMES[col.type] || `Type ${col.type}`;
        const role = col.temporal
          ? '<span class="gt-info-badge-sm gt-info-badge-temporal">temporal</span>'
          : '<span class="gt-info-badge-sm gt-info-badge-static">static</span>';
        html += `<tr>
                    <td class="gt-info-col-name">${col.name}</td>
                    <td class="gt-info-col-type">${typeName}</td>
                    <td>${role}</td>
                </tr>`;
      }
      html += `</tbody></table>`;
    }

    // Dictionary values — grouped by Enum16 column
    const enumCols = schema.filter(
      (col) =>
        col.type === 6 ||
        col.type === 8 ||
        col.type === 9 ||
        col.type === 14 ||
        String(col.type).includes('enum')
    ); // enum8/16/32
    if (dict.length > 0 && enumCols.length > 0) {
      html += `<div class="gt-info-section-title">Enum Columns</div>`;

      const MAX_PREVIEW = 10;

      for (const col of enumCols) {
        const colData = data.staticColumns?.[col.name];
        if (!colData) continue;

        // Single-pass: collect first MAX_PREVIEW unique string values and count total unique
        // (samples values in data order to avoid Uint16 overflow artifacts from sorted indices)
        const preview = [];
        const seenStrings = new Set();
        let stableCount = 0; // consecutive features with no new unique values
        for (let i = 0; i < colData.length; i++) {
          const idx = colData[i];
          if (idx >= dict.length) continue;
          const val = dict[idx];
          const prevSize = seenStrings.size;
          seenStrings.add(val);
          if (seenStrings.size > prevSize) {
            stableCount = 0;
            if (preview.length < MAX_PREVIEW) preview.push(val);
          } else {
            stableCount++;
          }
          // Early exit: if no new values seen in 5000 consecutive features,
          // all unique values have likely been encountered
          if (stableCount > 5000 && seenStrings.size < colData.length / 2) break;
        }
        const totalUnique = seenStrings.size;

        html += `<div class="gt-info-section-subtitle">${col.name} <span class="gt-info-count">(${totalUnique.toLocaleString()} unique)</span></div>`;
        html += `<div class="gt-info-dict-grid">`;
        for (const val of preview) {
          html += `<span class="gt-info-dict-item">${val}</span>`;
        }
        if (totalUnique > MAX_PREVIEW) {
          html += `<span class="gt-info-dict-item" style="opacity:0.5;font-style:italic">… +${(totalUnique - MAX_PREVIEW).toLocaleString()} more</span>`;
        }
        html += `</div>`;
      }
    }

    html += `</div>`; // close body
    overlay.innerHTML = html;
    const _t = (this.engine && this.engine.uiContainer) || document.body;
    _t.appendChild(overlay);

    // Close handler
    overlay.querySelector('.gt-info-close').addEventListener('click', () => {
      overlay.remove();
    });

    // Animate in
    requestAnimationFrame(() => overlay.classList.add('gt-info-visible'));
  }

  update() {
    // Layer manager doesn't need per-frame updates
  }

  /** Show or hide the layer manager (toggle button + panel). */
  setVisible(visible) {
    this.toggleBtn.style.display = visible ? '' : 'none';
    if (!visible) this.panel.style.display = 'none';
  }

  /** Show or hide the basemap selector section within the panel. */
  setBasemapVisible(visible) {
    if (this._basemapSection) this._basemapSection.style.display = visible ? '' : 'none';
  }

  destroy() {
    window.removeEventListener('mousemove', this._mouseMoveHandler);
    window.removeEventListener('mouseup', this._mouseUpHandler);
    // Clean up any open info overlay
    document.querySelector('.gt-layer-info-overlay')?.remove();
    // Clean up any open symbology dialog
    if (this._activeSymbologyDialog) {
      this._activeSymbologyDialog.destroy();
      this._activeSymbologyDialog = null;
    }
    if (this.toggleBtn.parentNode) this.toggleBtn.parentNode.removeChild(this.toggleBtn);
    if (this.panel.parentNode) this.panel.parentNode.removeChild(this.panel);
  }
}
