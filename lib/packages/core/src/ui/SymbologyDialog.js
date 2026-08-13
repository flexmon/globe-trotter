/**
 * SymbologyDialog.js — Rich symbology editor for GFB vector layers.
 * Provides controls for symbol type/scale, per-category color, and opacity.
 * All changes hot-swap via StyleEngine → renderer.setStyle().
 *
 * Generic: works with any GFB layer regardless of field names or dataset.
 * Dynamically discovers enum columns, dictionary values, and current style state.
 *
 * Opened from the LayerManagerDialog via a "Symbology" button per GFB layer.
 */

import { StyleEngine } from '../styles/StyleEngine.js';
import { RampEditorWidget } from './RampEditorWidget.js';

const SYMBOLS = [
  { value: 0, label: '◉ Chevron' },
  { value: 1, label: '▲ Arrow' },
  { value: 2, label: '◆ Diamond' },
  { value: 3, label: '● Circle' },
];

// Single fallback color for unconfigured layers (matches shader DEFAULT_POINT_COLOR)
const DEFAULT_FALLBACK_COLOR = '#00BFE6';

export function resolveSymbologyMode(layerData) {
  const colorType = layerData?.style?.color?.type;
  const yamlType = layerData?._yamlStyle?.type;

  if (layerData?.style?.type === 'ramp' || colorType === 'ramp' || yamlType === 'ramp') {
    return 'ramp';
  }
  if (colorType === 'categorical' || yamlType === 'categorical') {
    return 'custom';
  }
  return 'default';
}

export function mergeCategoryEntries(observedCategories, configuredCategories = {}) {
  const merged = [];
  const seen = new Set();

  for (const name of Object.keys(configuredCategories || {})) {
    if (!seen.has(name)) {
      seen.add(name);
      merged.push({ index: null, name });
    }
  }

  for (const cat of observedCategories || []) {
    if (!seen.has(cat.name)) {
      seen.add(cat.name);
      merged.push(cat);
    }
  }

  return merged;
}

export class SymbologyDialog {
  /**
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {string} layerName - Name of the GFB layer to edit
   */
  constructor(engine, layerName) {
    this.engine = engine;
    this.layerName = layerName;
    this._mode = 'default';
    this._uniformColor = DEFAULT_FALLBACK_COLOR;
    this._categoryColors = {}; // { categoryName: '#hex' }
    this._attrColorCache = {}; // { attrName: { catName: '#hex' } } — preserves colors across attr switches
    this._rampStops = [];
    this._rampDomain = [0, 100];
    this._rampWidget = null;
    this._rampAttr = null;
    this._opacity = 0.9;
    this._selectedAttr = null;
    this._overlay = null;
    this._closeTimer = null;
    this._destroyed = false;

    this._init();
  }

  _getLayerData() {
    if (this._destroyed || !this.engine) return null;
    return this.engine.layerManager.layers.get(this.layerName);
  }

  _init() {
    const layerData = this._getLayerData();
    if (!layerData) return;

    const renderer = layerData.renderer;
    const data = layerData.data;
    const dict = data.dictionary || [];
    const schema = data.schema || [];

    // Discover all enum columns from schema
    const enumCols = schema.filter((c) => c.type === 6 || c.type === 8 || c.type === 9); // Enum16
    // And all static columns for attribute dropdown
    const staticColNames = data.staticColumns ? Object.keys(data.staticColumns) : [];

    // Ramp attribute — preserved from the compiled style directly (may be a temporal column,
    // which is not in staticColNames, so it's tracked separately from the categorical _selectedAttr).
    this._rampAttr = layerData.style?.color?.attribute || layerData._yamlStyle?.attribute || null;

    // Current styled attribute for categorical mode — must be a static column.
    const candidateAttr = layerData.style?.color?.attribute;
    this._selectedAttr =
      candidateAttr && staticColNames.includes(candidateAttr)
        ? candidateAttr
        : staticColNames.length > 0
          ? staticColNames[0]
          : null;

    // Gather categories for the selected attribute
    const categories = mergeCategoryEntries(
      this._gatherCategories(data, dict, this._selectedAttr),
      layerData.style?.color?.categories || layerData._yamlStyle?.categories
    );

    // Init category colors: either from existing custom style or auto-assign
    this._initCategoryColors(categories, layerData);

    // Read current state from renderer
    const currentSymbol = renderer?._symbolType ?? 0;
    const currentScale = renderer?._symbolScale ?? 1.0;

    // Detect default mode vs custom (categorical) vs ramp
    this._mode = resolveSymbologyMode(layerData);

    // Initialise uniform color from existing constant style, falling back to the default
    const constColor = layerData.style?.color;
    if (constColor?.type === 'constant' && Array.isArray(constColor.value)) {
      const toHex = (v) =>
        Math.round(Math.max(0, Math.min(1, v)) * 255)
          .toString(16)
          .padStart(2, '0');
      this._uniformColor = `#${toHex(constColor.value[0])}${toHex(constColor.value[1])}${toHex(constColor.value[2])}`;
    }

    // Cache existing ramp properties if available (to resume edits)
    this._rampStops = layerData.style?.color?.stops || layerData.stops || [];
    this._rampDomain = layerData.style?.color?.domain || layerData.domain || [0, 100];

    this._opacity = layerData.style?.opacity?.value ?? 0.9;

    this._buildOverlay(categories, enumCols, staticColNames, currentSymbol, currentScale);
  }

  /** Discover unique category values for an attribute from static column data */
  _gatherCategories(data, dict, attrName) {
    const colData = data.staticColumns?.[attrName];
    const categories = [];
    if (!colData) return categories;

    const colDict = data.dictionaries?.[attrName] || data.dictionary || dict || [];
    const dictLen = colDict.length ?? colDict.size ?? 999999;

    const schemaType = data.schema?.find((c) => c.name === attrName)?.type;
    const isEnum =
      schemaType === 6 ||
      schemaType === 8 ||
      schemaType === 9 ||
      schemaType === 14 ||
      String(schemaType).includes('enum');

    const seen = new Set();
    for (let i = 0; i < colData.length && categories.length < 200; i++) {
      const idx = colData[i];
      const getD = (r) => (colDict.getString ? colDict.getString(r) : colDict[r]);
      const name = isEnum && idx < dictLen ? getD(idx) || String(idx) : String(idx);

      if (!seen.has(name)) {
        seen.add(name);
        categories.push({ index: idx, name: name });
      }
    }
    return categories;
  }

  /** Initialize category colors from cache, existing style, or auto-assign from palette */
  _initCategoryColors(categories, layerData) {
    this._categoryColors = {};

    // Restore from per-attribute cache first (preserves user edits across attr switches)
    const cached = this._attrColorCache[this._selectedAttr];
    if (cached) {
      Object.assign(this._categoryColors, cached);
    }

    // If there's an existing compiled style, read its colors for anything not cached
    const existingCats = layerData.style?.color?.categories;
    if (existingCats && Object.keys(existingCats).length > 0) {
      for (const [name, entry] of Object.entries(existingCats)) {
        if (!this._categoryColors[name]) {
          this._categoryColors[name] = typeof entry === 'string' ? entry : entry.color || '#999999';
        }
      }
    }

    // Auto-assign color from palette for any categories not yet assigned
    const DEFAULT_PALETTE = [
      '#E6194B',
      '#3CB44B',
      '#FFE119',
      '#4363D8',
      '#F58231',
      '#911EB4',
      '#42D4F4',
      '#F032E6',
      '#BFEF45',
      '#FABEBE',
      '#469990',
      '#E6BEFF',
      '#9A6324',
      '#800000',
      '#AAFFC3',
      '#808000',
      '#FFD8B1',
      '#000075',
      '#A9A9A9',
      '#00BFE6',
    ];
    for (let i = 0; i < categories.length; i++) {
      const name = categories[i].name;
      if (!this._categoryColors[name]) {
        this._categoryColors[name] = DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
      }
    }
  }

  _buildOverlay(categories, enumCols, staticColNames, currentSymbol, currentScale) {
    // Remove any existing
    document.querySelector('.gt-sym-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'gt-glass-panel gt-sym-overlay';
    this._overlay = overlay;

    let html = `
            <div class="gt-sym-header">
                <h3 class="gt-sym-title">Symbology</h3>
                <span class="gt-sym-layer-name">${this.layerName}</span>
                <select class="gt-lm-zoom-select" title="UI zoom scale">
                    <option value="1.0">1.0×</option>
                    <option value="1.2">1.2×</option>
                    <option value="1.4">1.4×</option>
                    <option value="1.6">1.6×</option>
                    <option value="1.8">1.8×</option>
                    <option value="2.0">2.0×</option>
                </select>
                <button class="gt-sym-close" title="Close">&times;</button>
            </div>
            <div class="gt-sym-body">
        `;

    // ── Symbol Section ──
    html += `
            <div class="gt-sym-section">
                <div class="gt-sym-section-title">Symbol</div>
                <div class="gt-sym-row">
                    <label class="gt-sym-label">Type</label>
                    <select class="gt-sym-select" data-control="symbolType">`;
    for (const sym of SYMBOLS) {
      html += `<option value="${sym.value}"${sym.value === currentSymbol ? ' selected' : ''}>${sym.label}</option>`;
    }
    html += `</select>
                </div>
                <div class="gt-sym-row">
                    <label class="gt-sym-label">Scale</label>
                    <div class="gt-sym-slider-row">
                        <input type="range" class="gt-sym-slider" data-control="symbolScale"
                            min="0.3" max="4" step="0.1" value="${currentScale}">
                        <span class="gt-sym-value" data-display="symbolScale">${currentScale.toFixed(1)}×</span>
                    </div>
                </div>
            </div>
        `;

    // ── Color Section ──
    html += `
            <div class="gt-sym-section">
                <div class="gt-sym-section-title">Color</div>
                <div class="gt-sym-row">
                    <div class="gt-sym-mode-toggle">
                        <button class="gt-sym-mode-btn${this._mode === 'default' ? ' gt-sym-mode-active' : ''}" data-mode="default">Uniform</button>
                        <button class="gt-sym-mode-btn${this._mode === 'custom' ? ' gt-sym-mode-active' : ''}" data-mode="custom">Categorical</button>
                        <button class="gt-sym-mode-btn${this._mode === 'ramp' ? ' gt-sym-mode-active' : ''}" data-mode="ramp">Ramp</button>
                    </div>
                </div>
                
                <div class="gt-sym-row gt-sym-uniform-panel" data-section="uniformPanel" style="display:${this._mode === 'default' ? 'flex' : 'none'}; margin-top:6px">
                    <label class="gt-sym-label">Color</label>
                    <input type="color" class="gt-sym-uniform-color" data-control="uniformColor" value="${this._uniformColor}">
                </div>

                <div class="gt-sym-attr-panel" data-section="attrPanel" style="display:${this._mode === 'custom' ? 'block' : 'none'}">
        `;

    // Attribute selector (only if there are enum columns)
    if (staticColNames.length > 0) {
      html += `
                    <div class="gt-sym-row" style="margin-bottom:8px">
                        <label class="gt-sym-label">Attribute</label>
                        <select class="gt-sym-select" data-control="colorAttribute">`;
      for (const col of staticColNames) {
        html += `<option value="${col}"${col === this._selectedAttr ? ' selected' : ''}>${col}</option>`;
      }
      html += `</select>
                    </div>`;
    }

    html += `</div>`; // End attrPanel

    html += `
                <div class="gt-sym-custom-panel" data-section="customPanel" style="display:${this._mode === 'custom' ? 'block' : 'none'}">
        `;

    // Category color list
    html += `<div class="gt-sym-category-list" data-section="categoryList">`;
    for (const cat of categories) {
      const color = this._categoryColors[cat.name] || '#999999';
      html += `
                    <div class="gt-sym-cat-row" data-category="${cat.name}">
                        <input type="color" class="gt-sym-color-input" value="${color}" data-cat="${cat.name}">
                        <span class="gt-sym-cat-name">${cat.name}</span>
                    </div>`;
    }
    html += `</div>`; // End categoryList
    html += `</div>`; // End customPanel

    html += `
                <div class="gt-sym-ramp-panel" data-section="rampPanel" style="display:${this._mode === 'ramp' ? 'block' : 'none'}">
                </div>
            </div>
        `;

    // ── Opacity Section ──
    html += `
            <div class="gt-sym-section">
                <div class="gt-sym-section-title">Opacity</div>
                <div class="gt-sym-row">
                    <div class="gt-sym-slider-row">
                        <input type="range" class="gt-sym-slider" data-control="opacity"
                            min="0" max="1" step="0.05" value="${this._opacity}">
                        <span class="gt-sym-value" data-display="opacity">${this._opacity.toFixed(2)}</span>
                    </div>
                </div>
            </div>
        `;

    // ── Reset Button ──
    html += `
                <button class="gt-sym-reset-btn" data-control="reset">Reset to Default</button>
            </div>
        `;

    overlay.innerHTML = html;
    const _t = (this.engine && this.engine.uiContainer) || document.body;
    _t.appendChild(overlay);

    // Apply and bind zoom select
    const savedZoom = localStorage.getItem('gt-dialog-zoom') || '1.0';
    overlay.style.zoom = savedZoom;
    const zoomSelect = overlay.querySelector('.gt-lm-zoom-select');
    zoomSelect.value = savedZoom;
    zoomSelect.addEventListener('change', (e) => {
      overlay.style.zoom = e.target.value;
      localStorage.setItem('gt-dialog-zoom', e.target.value);
    });

    // Conditionally mount Ramp widget immediately if initialized in Ramp mode
    if (this._mode === 'ramp') {
      this._mountRampWidget(overlay.querySelector('[data-section="rampPanel"]'));
    }

    this._bindEvents(overlay);

    // Animate in
    requestAnimationFrame(() => overlay.classList.add('gt-sym-visible'));
  }

  _bindEvents(overlay) {
    // Close
    overlay.querySelector('.gt-sym-close').addEventListener('click', () => this.close());

    // Drag by header (container-relative coordinates)
    const hdr = overlay.querySelector('.gt-sym-header');
    hdr.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('button, select, input')) return;
      ev.preventDefault();
      const rect = overlay.getBoundingClientRect();
      const cRect = overlay.parentElement
        ? overlay.parentElement.getBoundingClientRect()
        : { left: 0, top: 0 };
      const ox = ev.clientX - (rect.left - cRect.left),
        oy = ev.clientY - (rect.top - cRect.top);
      overlay.style.transform = 'none';
      overlay.style.left = rect.left - cRect.left + 'px';
      overlay.style.top = rect.top - cRect.top + 'px';
      const move = (e) => {
        overlay.style.left = e.clientX - ox + 'px';
        overlay.style.top = e.clientY - oy + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    overlay.querySelector('[data-control="symbolType"]').addEventListener('change', (e) => {
      const renderer = this._getLayerData()?.renderer;
      if (renderer?.setSymbolType) {
        renderer.setSymbolType(parseInt(e.target.value));
        this.engine.requestRender();
        this.engine.layerManager._styleVersion++; // sync UI state
      }
    });

    // Symbol scale
    const scaleSlider = overlay.querySelector('[data-control="symbolScale"]');
    const scaleDisplay = overlay.querySelector('[data-display="symbolScale"]');
    scaleSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      scaleDisplay.textContent = `${val.toFixed(1)}×`;
      const renderer = this._getLayerData()?.renderer;
      if (renderer?.setSymbolScale) {
        renderer.setSymbolScale(val);
        this.engine.requestRender();
        this.engine.layerManager._styleVersion++; // sync UI state
      }
    });

    // Color mode toggle
    const modeBtns = overlay.querySelectorAll('.gt-sym-mode-btn');
    const customPanel = overlay.querySelector('[data-section="customPanel"]');
    const attrPanel = overlay.querySelector('[data-section="attrPanel"]');
    const rampPanel = overlay.querySelector('[data-section="rampPanel"]');
    const uniformPanel = overlay.querySelector('[data-section="uniformPanel"]');

    modeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const newMode = btn.dataset.mode;
        if (this._mode === newMode) return;
        this._mode = newMode;

        modeBtns.forEach((b) =>
          b.classList.toggle('gt-sym-mode-active', b.dataset.mode === this._mode)
        );
        uniformPanel.style.display = this._mode === 'default' ? 'flex' : 'none';
        customPanel.style.display = this._mode === 'custom' ? 'block' : 'none';
        attrPanel.style.display = this._mode === 'custom' ? 'block' : 'none';
        rampPanel.style.display = this._mode === 'ramp' ? 'block' : 'none';

        if (this._mode === 'ramp') {
          this._mountRampWidget(rampPanel);
          this._applyRampStyle();
        } else if (this._mode === 'custom') {
          this._applyCustomStyle();
        } else {
          this._applyUniformStyle();
        }
      });
    });

    // Uniform color picker
    const uniformColorInput = overlay.querySelector('[data-control="uniformColor"]');
    uniformColorInput.addEventListener('input', (e) => {
      this._uniformColor = e.target.value;
      this._applyUniformStyle();
    });

    // Attribute selector change → save current colors to cache then rebuild
    const attrSelect = overlay.querySelector('[data-control="colorAttribute"]');
    if (attrSelect) {
      attrSelect.addEventListener('change', (e) => {
        // Persist the outgoing attribute's custom colors before switching
        if (this._selectedAttr && Object.keys(this._categoryColors).length > 0) {
          this._attrColorCache[this._selectedAttr] = { ...this._categoryColors };
        }
        this._selectedAttr = e.target.value;
        this._rebuildCategoryList(overlay);

        if (this._mode === 'custom') {
          this._applyCustomStyle();
        } else if (this._mode === 'ramp') {
          this._applyRampStyle();
        }
      });
    }

    // Per-category color pickers (delegated)
    const catListEl = overlay.querySelector('[data-section="categoryList"]');
    catListEl.addEventListener('input', (e) => {
      if (e.target.classList.contains('gt-sym-color-input')) {
        this._categoryColors[e.target.dataset.cat] = e.target.value;
        if (this._mode === 'custom') this._applyStyleDebounced();
      }
    });

    // Opacity slider
    const opacitySlider = overlay.querySelector('[data-control="opacity"]');
    const opacityDisplay = overlay.querySelector('[data-display="opacity"]');
    opacitySlider.addEventListener('input', (e) => {
      this._opacity = parseFloat(e.target.value);
      opacityDisplay.textContent = this._opacity.toFixed(2);
      this._applyStyleDebounced();
    });

    // Reset
    overlay.querySelector('[data-control="reset"]').addEventListener('click', () => {
      this._mode = 'default';
      this._uniformColor = DEFAULT_FALLBACK_COLOR;
      this._opacity = 0.9;
      modeBtns.forEach((b) =>
        b.classList.toggle('gt-sym-mode-active', b.dataset.mode === 'default')
      );
      uniformPanel.style.display = 'flex';
      customPanel.style.display = 'none';
      attrPanel.style.display = 'none';
      rampPanel.style.display = 'none';
      uniformColorInput.value = DEFAULT_FALLBACK_COLOR;
      opacitySlider.value = '0.9';
      opacityDisplay.textContent = '0.90';

      // Reset scale and symbol
      const renderer = this._getLayerData()?.renderer;
      if (renderer) {
        renderer.setSymbolType?.(0);
        renderer.setSymbolScale?.(1.0);
        this.engine.layerManager._styleVersion++; // force render
      }
      overlay.querySelector('[data-control="symbolType"]').value = '0';
      scaleSlider.value = '1';
      scaleDisplay.textContent = '1.0×';

      this._applyUniformStyle();
    });
  }

  /** Rebuild the category list when attribute changes */
  _rebuildCategoryList(overlay) {
    const layerData = this._getLayerData();
    if (!layerData) return;

    const data = layerData.data;
    const dict = data.dictionary || [];
    const categories = mergeCategoryEntries(
      this._gatherCategories(data, dict, this._selectedAttr),
      layerData.style?.color?.categories || layerData._yamlStyle?.categories
    );
    this._initCategoryColors(categories, layerData);

    const catListEl = overlay.querySelector('[data-section="categoryList"]');
    let html = '';
    for (const cat of categories) {
      const color = this._categoryColors[cat.name] || '#999999';
      html += `
                <div class="gt-sym-cat-row" data-category="${cat.name}">
                    <input type="color" class="gt-sym-color-input" value="${color}" data-cat="${cat.name}">
                    <span class="gt-sym-cat-name">${cat.name}</span>
                </div>`;
    }
    catListEl.innerHTML = html;
  }

  _applyUniformStyle() {
    this.engine.layerManager.setLayerUniformColor(
      this.layerName,
      this._uniformColor,
      this._opacity
    );
  }

  _applyCustomStyle() {
    const layerData = this._getLayerData();
    if (!layerData) return;

    const attr = this._selectedAttr || '_none';

    const spec = {
      type: 'categorical',
      attribute: attr,
      categories: this._categoryColors,
      default: '#999999',
      opacity: this._opacity,
    };

    this.engine.layerManager.setLayerStyle(this.layerName, spec);
  }

  _mountRampWidget(container) {
    if (!this._rampWidget || this._rampStops.length === 0) {
      if (this._rampStops.length === 0) {
        // Supply a synthetic fallback 2-stop interpolated linear ramp
        this._rampStops = [
          { value: this._rampDomain[0], color: '#002C5E', opacity: 0.8 },
          { value: this._rampDomain[1], color: '#F23319', opacity: 0.8 },
        ];
      }
      container.innerHTML = '';
      this._rampWidget = new RampEditorWidget(container, {
        stops: this._rampStops,
        domain: this._rampDomain,
        onChange: (stops, domain) => {
          this._rampStops = stops;
          this._rampDomain = domain;
          this._applyRampStyle();
        },
      });
    }
  }

  _applyRampStyle() {
    const layerData = this._getLayerData();
    if (!layerData) return;

    const attr = this._rampAttr || this._selectedAttr || '_none';

    let opacityStops = null;
    if (this._rampStops.some((s) => s.opacity !== undefined)) {
      opacityStops = this._rampStops.map((s) => ({
        value: s.value,
        opacity: s.opacity ?? 1.0,
      }));
    }

    const spec = {
      type: 'ramp',
      attribute: attr,
      domain: this._rampDomain,
      stops: this._rampStops,
      opacity: this._opacity,
      opacityStops: opacityStops || undefined,
    };

    this.engine.layerManager.setLayerStyle(this.layerName, spec);
  }

  _applyDefaultStyle() {
    const layerData = this._getLayerData();
    if (!layerData) return;

    const attr = this._selectedAttr || '_none';

    // Empty categories → renderer uses its default coloring
    const spec = StyleEngine.categorical({
      attribute: attr,
      categories: {},
      default: '#999999',
      opacity: this._opacity,
    });

    this.engine.layerManager.setLayerStyle(this.layerName, spec);
  }

  /** Debounced wrapper — batches rapid slider/picker changes to 1 compile per 50ms */
  _applyStyleDebounced() {
    if (this._styleTimer) clearTimeout(this._styleTimer);
    this._styleTimer = setTimeout(() => {
      this._styleTimer = null;
      if (this._mode === 'custom') {
        this._applyCustomStyle();
      } else if (this._mode === 'ramp') {
        this._applyRampStyle();
      } else {
        this._applyUniformStyle();
      }
    }, 50);
  }

  close() {
    if (this._overlay) {
      this._overlay.classList.remove('gt-sym-visible');
      this._closeTimer = setTimeout(() => {
        this._closeTimer = null;
        this._overlay?.remove();
        this._overlay = null;
      }, 200);
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    if (this._styleTimer) {
      clearTimeout(this._styleTimer);
      this._styleTimer = null;
    }
    this._overlay?.remove();
    this._overlay = null;
    this.engine = null;
  }
}
