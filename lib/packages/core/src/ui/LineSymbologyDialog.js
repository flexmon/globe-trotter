/**
 * LineSymbologyDialog.js — Symbology editor for GFB LINE and MULTI_LINE geometry.
 *
 * Controls: Color mode (Ramp / Discrete), attribute selector, color stops or
 * per-value pickers, opacity slider, line width slider.
 *
 * Reuses gt-sym-* CSS classes from styles.js.
 */

import { StyleEngine } from '../styles/StyleEngine.js';
import { RampEditorWidget } from './RampEditorWidget.js';

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

export class LineSymbologyDialog {
  constructor(engine, layerName) {
    this.engine = engine;
    this.layerName = layerName;
    this._mode = 'default';
    this._uniformColor = '#00BFE6';
    this._selectedAttr = null;
    this._opacity = 0.7;
    this._lineWidth = 2;
    this._categoryColors = {};
    this._rampStops = [];
    this._rampDomain = [0, 100];
    this._rampWidget = null;
    this._overlay = null;
    this._closeTimer = null;
    this._destroyed = false;
    this._styleTimer = null;

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
    const schema = data.schema || [];

    // Gather all columns
    this._allCols = schema.map((c) => ({ name: c.name, type: c.type }));
    this._numericCols = this._allCols.filter((c) => c.type !== 6);
    this._staticCols = data.staticColumns || {};
    this._dictionary = data.dictionary || [];

    // Current state from renderer/style
    this._selectedAttr = layerData.style?.color?.attribute || (this._allCols[0]?.name ?? null);
    this._opacity = layerData.style?.opacity?.value ?? 0.7;
    this._lineWidth = renderer?.lineWidth ?? 2;

    // Detect current color mode
    const compiledCategories = layerData.style?.color?.categories;
    const hasCustom = compiledCategories && Object.keys(compiledCategories).length > 0;
    const isRampStyle =
      layerData.style?.type === 'ramp' ||
      layerData.style?.color?.type === 'ramp' ||
      layerData._yamlStyle?.type === 'ramp';

    if (isRampStyle) {
      this._mode = 'ramp';
    } else if (hasCustom) {
      this._mode = 'custom';
    } else {
      this._mode = 'default';
    }

    // Initialise uniform color from existing constant style
    const constColor = layerData.style?.color;
    if (constColor?.type === 'constant' && Array.isArray(constColor.value)) {
      const toHex = (v) =>
        Math.round(Math.max(0, Math.min(1, v)) * 255)
          .toString(16)
          .padStart(2, '0');
      this._uniformColor = `#${toHex(constColor.value[0])}${toHex(constColor.value[1])}${toHex(constColor.value[2])}`;
    }

    // Init ramp stops from current style
    if (layerData.style?.color?.domain) {
      this._rampDomain = [...layerData.style.color.domain];
    }
    if (layerData._yamlStyle?.stops) {
      this._rampStops = layerData._yamlStyle.stops.map((s) => ({
        value: s.value,
        color: s.color,
        opacity: s.opacity ?? 1.0,
      }));
      if (layerData._yamlStyle.domain) this._rampDomain = [...layerData._yamlStyle.domain];
    }

    if (this._rampStops.length === 0) {
      this._rampStops = [
        { value: this._rampDomain[0], color: '#002C5E', opacity: 1.0 },
        { value: this._rampDomain[1], color: '#F23319', opacity: 1.0 },
      ];
    }

    // Init categorical colors
    this._initCategoricalColors();

    this._buildOverlay();
  }

  _getUniqueValues(attrName) {
    const colData = this._staticCols[attrName];
    if (!colData) return [];

    const schema = this._allCols.find((c) => c.name === attrName);
    const isEnum =
      schema?.type === 6 ||
      schema?.type === 8 ||
      schema?.type === 9 ||
      schema?.type === 14 ||
      String(schema?.type).includes('enum');
    const seen = new Map();

    const layerData = this._getLayerData();
    const dict = layerData?.data?.dictionaries?.[attrName] || layerData?.data?.dictionary || [];

    for (let i = 0; i < colData.length && seen.size < 200; i++) {
      const raw = colData[i];
      const getD = (r) => (dict.getString ? dict.getString(r) : dict[r]);
      const dictLen = dict.length ?? dict.size ?? 999999;
      const label = isEnum && raw < dictLen ? getD(raw) || String(raw) : String(raw);
      if (!seen.has(label)) seen.set(label, raw);
    }

    // Sort: numeric values numerically, strings alphabetically
    const entries = [...seen.entries()];
    entries.sort((a, b) => {
      const na = Number(a[0]),
        nb = Number(b[0]);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a[0].localeCompare(b[0]);
    });

    return entries.map(([label]) => label);
  }

  _initCategoricalColors() {
    const values = this._getUniqueValues(this._selectedAttr);
    // Preserve existing assignments
    const existing = { ...this._categoryColors };
    this._categoryColors = {};
    for (let i = 0; i < values.length; i++) {
      this._categoryColors[values[i]] =
        existing[values[i]] || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
    }
  }

  _buildOverlay() {
    document.querySelector('.gt-sym-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'gt-glass-panel gt-sym-overlay';
    this._overlay = overlay;

    let html = `
            <div class="gt-sym-header">
                <h3 class="gt-sym-title">Line Symbology</h3>
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

    // ── Line Width ──
    html += `
            <div class="gt-sym-section">
                <div class="gt-sym-section-title">Line Width</div>
                <div class="gt-sym-row">
                    <div class="gt-sym-slider-row">
                        <input type="range" class="gt-sym-slider" data-control="lineWidth"
                            min="1" max="20" step="0.5" value="${this._lineWidth}">
                        <span class="gt-sym-value" data-display="lineWidth">${this._lineWidth.toFixed(1)}px</span>
                    </div>
                </div>
            </div>
        `;

    // ── Color Mode Toggle ──
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
        `;

    // Attribute selector
    html += `
                <div class="gt-sym-attr-panel" data-section="attrPanel" style="display:${this._mode !== 'default' ? 'block' : 'none'}">
                    <div class="gt-sym-row" style="margin-top:6px">
                        <label class="gt-sym-label">Attribute</label>
                        <select class="gt-sym-select" data-control="colorAttribute">`;
    for (const col of this._allCols) {
      html += `<option value="${col.name}"${col.name === this._selectedAttr ? ' selected' : ''}>${col.name}</option>`;
    }
    html += `</select>
                </div>
            </div>`;

    // ── Ramp panel ──
    html += `<div class="gt-sym-ramp-panel" data-section="rampPanel" style="display:${this._mode === 'ramp' ? 'block' : 'none'}"></div>`;

    // ── Categorical panel ──
    const values = this._getUniqueValues(this._selectedAttr);
    html += `<div data-section="customPanel" style="display:${this._mode === 'custom' ? 'block' : 'none'}">`;
    html += `<div class="gt-sym-category-list" data-section="categoryList">`;
    for (const val of values) {
      const color = this._categoryColors[val] || '#999999';
      html += `
                    <div class="gt-sym-cat-row" data-category="${val}">
                        <input type="color" class="gt-sym-color-input" value="${color}" data-cat="${val}">
                        <span class="gt-sym-cat-name">${val}</span>
                    </div>`;
    }
    html += `</div></div>`;

    html += `</div>`; // close color section

    // ── Opacity ──
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

    // ── Reset ──
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

    if (this._mode === 'ramp') {
      this._mountRampWidget(overlay.querySelector('[data-section="rampPanel"]'));
    }

    this._bindEvents(overlay);
    requestAnimationFrame(() => overlay.classList.add('gt-sym-visible'));
  }

  _mountRampWidget(container) {
    if (!this._rampWidget || this._rampStops.length === 0) {
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

    // Line width
    const lwSlider = overlay.querySelector('[data-control="lineWidth"]');
    const lwDisplay = overlay.querySelector('[data-display="lineWidth"]');
    lwSlider.addEventListener('input', (e) => {
      this._lineWidth = parseFloat(e.target.value);
      lwDisplay.textContent = `${this._lineWidth.toFixed(1)}px`;
      const renderer = this._getLayerData()?.renderer;
      renderer?.setLineWidth?.(this._lineWidth);
    });

    // Color mode toggle
    const modeBtns = overlay.querySelectorAll('.gt-sym-mode-btn');
    const rampPanel = overlay.querySelector('[data-section="rampPanel"]');
    const customPanel = overlay.querySelector('[data-section="customPanel"]');
    const attrPanel = overlay.querySelector('[data-section="attrPanel"]');
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
        rampPanel.style.display = this._mode === 'ramp' ? 'block' : 'none';
        customPanel.style.display = this._mode === 'custom' ? 'block' : 'none';
        attrPanel.style.display = this._mode !== 'default' ? 'block' : 'none';

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

    // Attribute selector
    const attrSelect = overlay.querySelector('[data-control="colorAttribute"]');
    if (attrSelect) {
      attrSelect.addEventListener('change', (e) => {
        this._selectedAttr = e.target.value;
        this._initCategoricalColors();
        this._rebuildDiscreteList(overlay);
        this._autoDetectDomain();

        // Fallback stops reconstruction on attr change
        this._rampStops = [
          { value: this._rampDomain[0], color: '#002C5E', opacity: 1.0 },
          { value: this._rampDomain[1], color: '#F23319', opacity: 1.0 },
        ];
        if (this._rampWidget) {
          this._rampWidget.stops = this._rampStops;
          this._rampWidget.domain = this._rampDomain;
          // force DOM rebuild
          this._mountRampWidget(rampPanel);
        }

        if (this._mode === 'custom') {
          this._applyCustomStyle();
        } else if (this._mode === 'ramp') {
          this._applyRampStyle();
        }
      });
    }

    // Discrete color pickers (delegated)
    const catListEl = overlay.querySelector('[data-section="categoryList"]');
    if (catListEl) {
      catListEl.addEventListener('input', (e) => {
        if (e.target.classList.contains('gt-sym-color-input')) {
          this._categoryColors[e.target.dataset.cat] = e.target.value;
          this._applyStyleDebounced();
        }
      });
    }

    // Opacity
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
      this._uniformColor = '#00BFE6';
      this._opacity = 0.7;
      this._lineWidth = 2;
      modeBtns.forEach((b) =>
        b.classList.toggle('gt-sym-mode-active', b.dataset.mode === 'default')
      );
      uniformPanel.style.display = 'flex';
      rampPanel.style.display = 'none';
      customPanel.style.display = 'none';
      attrPanel.style.display = 'none';
      uniformColorInput.value = '#00BFE6';
      lwSlider.value = '2';
      lwDisplay.textContent = '2.0px';
      opacitySlider.value = '0.7';
      opacityDisplay.textContent = '0.70';

      const renderer = this._getLayerData()?.renderer;
      renderer?.setLineWidth?.(2);
      this._applyUniformStyle();
    });
  }

  _autoDetectDomain() {
    const colData = this._staticCols[this._selectedAttr];
    if (!colData) return;
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < colData.length; i++) {
      const v = colData[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min < max) {
      this._rampDomain = [min, max];
    }
  }

  _rebuildDiscreteList(overlay) {
    const catListEl = overlay.querySelector('[data-section="categoryList"]');
    if (!catListEl) return;
    const values = this._getUniqueValues(this._selectedAttr);
    let html = '';
    for (const val of values) {
      const color = this._categoryColors[val] || '#999999';
      html += `
                <div class="gt-sym-cat-row" data-category="${val}">
                    <input type="color" class="gt-sym-color-input" value="${color}" data-cat="${val}">
                    <span class="gt-sym-cat-name">${val}</span>
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
    const spec = StyleEngine.categorical({
      attribute: this._selectedAttr,
      categories: { ...this._categoryColors },
      default: '#999999',
      opacity: this._opacity,
    });
    this.engine.layerManager.setLayerStyle(this.layerName, spec);
  }

  _applyRampStyle() {
    let opacityStops = null;
    if (this._rampStops.some((s) => s.opacity !== undefined)) {
      opacityStops = this._rampStops.map((s) => ({ value: s.value, opacity: s.opacity ?? 1.0 }));
    }
    const spec = {
      type: 'ramp',
      attribute: this._selectedAttr,
      domain: this._rampDomain,
      stops: this._rampStops,
      opacity: this._opacity,
      opacityStops: opacityStops || undefined,
    };
    this.engine.layerManager.setLayerStyle(this.layerName, spec);
  }

  _applyDefaultStyle() {
    const spec = StyleEngine.categorical({
      attribute: this._selectedAttr,
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
