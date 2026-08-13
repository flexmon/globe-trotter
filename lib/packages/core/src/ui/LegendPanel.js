/**
 * LegendPanel.js — Toggle button + popup legend showing symbology for each layer.
 * Displays category name + color swatch for GFB categorical layers,
 * and color ramp preview for H3F layers.
 *
 * PERFORMANCE NOTES:
 * - Panel uses visibility:hidden/visible rather than display:none/block to avoid
 *   layout reflow when toggling (the element stays in the compositor layer tree).
 * - Legend HTML is built once and cached.  Population is deferred via setTimeout(0)
 *   so it never blocks the rAF render loop.
 */

// Single fallback color for unconfigured layers (matches shader DEFAULT_POINT_COLOR)
const DEFAULT_FALLBACK_COLOR = '#00BFE6';

export class LegendPanel {
  constructor(engine, container) {
    this.engine = engine;
    this.container = container;
    this._visible = false;
    this._populated = false;
    this._populatedLayerCount = 0;
    this._populatedStyleVersion = 0;
    this._destroyed = false;
    this._deferredTimer = null;
    this._createDOM();
    this._bindEvents();

    // Defer initial population so it doesn't block engine startup
    this._deferredTimer = setTimeout(() => {
      this._deferredTimer = null;
      this._ensurePopulated();
    }, 0);
  }

  _createDOM() {
    // Legend toggle button
    this.btn = document.createElement('button');
    this.btn.className = 'gt-glass-panel gt-legend-btn';
    this.btn.title = 'Legend';
    this.btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1"></rect>
              <line x1="14" y1="6.5" x2="21" y2="6.5"></line>
              <rect x="3" y="14" width="7" height="7" rx="1"></rect>
              <line x1="14" y1="17.5" x2="21" y2="17.5"></line>
            </svg>
            <span>Legend</span>
        `;
    this.container.appendChild(this.btn);

    // Legend panel — always in DOM, toggled via visibility (no layout reflow)
    this.panel = document.createElement('div');
    this.panel.className = 'gt-glass-panel gt-legend-panel';
    this.panel.style.visibility = 'hidden';
    this.panel.style.pointerEvents = 'none';

    // Restore sticky zoom from localStorage
    const savedZoom = localStorage.getItem('gt-dialog-zoom') || '1.0';
    this.panel.style.zoom = savedZoom;

    this.panel.innerHTML = `
            <div class="gt-legend-header">
                <h3 class="gt-legend-title">Legend</h3>
                <select class="gt-lm-zoom-select" title="UI zoom scale">
                    <option value="1.0"${savedZoom === '1.0' ? ' selected' : ''}>1.0×</option>
                    <option value="1.2"${savedZoom === '1.2' ? ' selected' : ''}>1.2×</option>
                    <option value="1.4"${savedZoom === '1.4' ? ' selected' : ''}>1.4×</option>
                    <option value="1.6"${savedZoom === '1.6' ? ' selected' : ''}>1.6×</option>
                    <option value="1.8"${savedZoom === '1.8' ? ' selected' : ''}>1.8×</option>
                    <option value="2.0"${savedZoom === '2.0' ? ' selected' : ''}>2.0×</option>
                </select>
                <button class="gt-legend-close" title="Close">&times;</button>
            </div>
            <div class="gt-legend-body"></div>
        `;
    this.container.appendChild(this.panel);

    this._body = this.panel.querySelector('.gt-legend-body');
    this._closeBtn = this.panel.querySelector('.gt-legend-close');

    // Zoom selector
    const zoomSelect = this.panel.querySelector('.gt-lm-zoom-select');
    zoomSelect.addEventListener('change', (e) => {
      this.panel.style.zoom = e.target.value;
      localStorage.setItem('gt-dialog-zoom', e.target.value);
    });
  }

  _bindEvents() {
    this.btn.addEventListener('click', () => {
      this._visible = !this._visible;
      if (this._visible) {
        // Position to the right of the button
        if (!this._dragged) {
          const btnRect = this.btn.getBoundingClientRect();
          const cR = this.engine.uiContainer
            ? this.engine.uiContainer.getBoundingClientRect()
            : { left: 0, top: 0 };
          this.panel.style.left = `${btnRect.right - cR.left + 8}px`;
          this.panel.style.top = `${btnRect.top - cR.top}px`;
        }
        this.panel.style.visibility = 'visible';
        this.panel.style.pointerEvents = 'auto';
      } else {
        this.panel.style.visibility = 'hidden';
        this.panel.style.pointerEvents = 'none';
      }
    });
    this._closeBtn.addEventListener('click', () => {
      this._visible = false;
      this.panel.style.visibility = 'hidden';
      this.panel.style.pointerEvents = 'none';
    });

    // ─── Drag on header (container-relative coordinates) ───
    const header = this.panel.querySelector('.gt-legend-header');
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.gt-legend-close') || e.target.closest('.gt-lm-zoom-select')) return;
      e.preventDefault();
      const startX = e.clientX,
        startY = e.clientY;
      const rect = this.panel.getBoundingClientRect();
      const cRect = this.panel.parentElement
        ? this.panel.parentElement.getBoundingClientRect()
        : { left: 0, top: 0 };
      const origLeft = rect.left - cRect.left,
        origTop = rect.top - cRect.top;
      header.style.cursor = 'grabbing';

      const onMove = (ev) => {
        this.panel.style.left = `${origLeft + (ev.clientX - startX)}px`;
        this.panel.style.top = `${origTop + (ev.clientY - startY)}px`;
      };
      const onUp = () => {
        header.style.cursor = 'grab';
        this._dragged = true;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  /** Populate legend if not already done, or if layer count or style version changed. */
  _ensurePopulated() {
    if (this._destroyed) return;
    const lm = this.engine?.layerManager;
    if (!lm) return;
    // Cheap check: raw layer count + style version counter (no full iteration)
    const rawCount = lm.layers.size;
    const styleVer = lm._styleVersion ?? 0;
    if (rawCount === 0) return;
    if (
      this._populated &&
      rawCount === this._populatedLayerCount &&
      styleVer === this._populatedStyleVersion
    )
      return;
    // Something changed — do the full (expensive) info gather
    const layers = lm.getLayerInfo();
    this._populate(layers);
    this._populated = true;
    this._populatedLayerCount = rawCount;
    this._populatedStyleVersion = styleVer;
  }

  /** Call when layers change to force a rebuild on next open */
  invalidate() {
    this._populated = false;
    // Rebuild in next idle frame
    if (this._deferredTimer) clearTimeout(this._deferredTimer);
    this._deferredTimer = setTimeout(() => {
      this._deferredTimer = null;
      this._ensurePopulated();
    }, 0);
  }

  _populate(layers) {
    const parts = [];

    for (const layer of layers) {
      if (!layer.visible) continue;
      // Skip MFB (metric-only) layers — they have no spatial rendering
      if (layer.type === 'mfb' || layer.type === 'mfb-sharded') continue;

      parts.push(`<div class="gt-legend-section">`);
      parts.push(`<div class="gt-legend-section-title">${layer.name}</div>`);

      const layerData = this.engine.layerManager.layers.get(layer.name);
      const style = layerData?.style || layerData?.compiledStyle;
      const styleColor = style?.color;
      const rampStops = layer.stops || styleColor?.stops;
      const domain = layer.domain || styleColor?.domain;
      const hasRamp = rampStops && rampStops.length > 0 && domain;

      if (hasRamp) {
        const attr = layer.attribute || styleColor?.attribute || 'value';
        const attrDisplay = layer.metricsMap?.[attr]?.label || attr;
        parts.push(`<div class="gt-legend-attr-label">${attrDisplay}</div>`);
        const colors = rampStops.map((s) => (typeof s === 'string' ? s : s.color));
        parts.push(
          `<div class="gt-legend-ramp-row">` +
            `<div class="gt-legend-ramp-bar" style="background:linear-gradient(to right,${colors.join(',')})"></div>` +
            `<div class="gt-legend-ramp-labels"><span>${domain[0]}</span><span>${domain[1]}</span></div>` +
            `</div>`
        );
      } else {
        let renderedCategorical = false;
        if (layer.type.startsWith('gfb')) {
          const fullDict = layerData?.data?.dictionary || [];
          const attr = layer.attribute || styleColor?.attribute;

          if (attr) {
            const styleCategories = styleColor?.categories || {};
            const colData = layerData?.data?.staticColumns?.[attr];
            let entries = [];

            if (colData && fullDict.length > 0) {
              const seen = new Set();
              for (let i = 0; i < colData.length; i++) {
                seen.add(colData[i]);
              }
              entries = [...seen]
                .sort((a, b) => a - b)
                .filter((idx) => idx < fullDict.length)
                .map((idx) => ({ index: idx, label: fullDict[idx] }));
            } else if (fullDict.length > 0) {
              entries = fullDict.map((label, i) => ({ index: i, label }));
            }

            if (entries.length > 0) {
              const attrDisplayCat = layer.metricsMap?.[attr]?.label || attr;
              parts.push(`<div class="gt-legend-attr-label">${attrDisplayCat}</div>`);
              parts.push(`<div class="gt-legend-grid">`);
              for (let i = 0; i < entries.length; i++) {
                const { label } = entries[i];
                const catEntry = styleCategories[label];
                const c = catEntry
                  ? typeof catEntry === 'string'
                    ? catEntry
                    : catEntry.color || '#999'
                  : DEFAULT_FALLBACK_COLOR;
                const shapeHtml = this._getSymbolSVG(layer.type, layerData.symbolType, c);
                parts.push(
                  `<div class="gt-legend-item">` +
                    `<div style="width:20px;display:flex;justify-content:center;align-items:center;">${shapeHtml}</div>` +
                    `<span class="gt-legend-label">${label}</span></div>`
                );
              }
              parts.push(`</div>`);
              renderedCategorical = true;
            }
          }
        }

        // Fallback to a single uniform-color swatch if not Ramp and not Categorical
        if (!renderedCategorical) {
          let c = DEFAULT_FALLBACK_COLOR;
          if (typeof styleColor === 'string') {
            c = styleColor;
          } else if (style?.color?.value) {
            const val = style.color.value;
            if (Array.isArray(val) || val instanceof Float32Array || val instanceof Float64Array) {
              c = `rgba(${Math.round(val[0] * 255)}, ${Math.round(val[1] * 255)}, ${Math.round(val[2] * 255)}, ${val[3] ?? 1.0})`;
            } else {
              c = val;
            }
          } else if (styleColor?.color) {
            c = styleColor.color;
          } else if (typeof layerData?._yamlStyle?.color === 'string') {
            c = layerData._yamlStyle.color;
          }

          const shapeHtml = this._getSymbolSVG(layer.type, layerData.symbolType, c);

          parts.push(
            `<div class="gt-legend-grid">` +
              `<div class="gt-legend-item">` +
              `<div style="width:20px;display:flex;justify-content:center;align-items:center;">${shapeHtml}</div>` +
              `<span class="gt-legend-label">Uniform</span></div>` +
              `</div>`
          );
        }
      }

      parts.push(`</div>`);
    }

    this._body.innerHTML = parts.join('');
  }

  _getSymbolSVG(layerType, symbolType, color) {
    if (!layerType.startsWith('gfb')) {
      return `<div class="gt-legend-swatch" style="background:${color};border-radius:50%"></div>`;
    }

    const svgSize = 16;
    const fill = color;
    // 0=circle+chevron, 1=arrow, 2=diamond, 3=circle
    if (symbolType === 0) {
      return `<svg width="${svgSize}" height="${svgSize}" viewBox="-1 -1 2 2" style="display:block;flex-shrink:0;"><circle cx="0" cy="0" r="0.88" fill="${fill}" opacity="0.6"/><path d="M -0.55,0.7 L 0,-0.6 L 0.55,0.7 L 0,0.4 Z" fill="${fill}"/></svg>`;
    } else if (symbolType === 1) {
      return `<svg width="${svgSize}" height="${svgSize}" viewBox="-1 -1 2 2" style="display:block;flex-shrink:0;"><path d="M -0.6,0.8 L 0,-0.9 L 0.6,0.8 L 0,0.3 Z" fill="${fill}"/></svg>`;
    } else if (symbolType === 2) {
      return `<svg width="${svgSize}" height="${svgSize}" viewBox="-1 -1 2 2" style="display:block;flex-shrink:0;"><polygon points="0,-0.8 0.6,0 0,0.8 -0.6,0" fill="${fill}"/></svg>`;
    } else {
      // default to plain circle (type 3 or unknown)
      return `<svg width="${svgSize}" height="${svgSize}" viewBox="-1 -1 2 2" style="display:block;flex-shrink:0;"><circle cx="0" cy="0" r="0.8" fill="${fill}"/></svg>`;
    }
  }

  update() {
    // Always check — _ensurePopulated has its own fast-path guard
    // (skips if layer count hasn't changed since last build)
    this._ensurePopulated();
  }

  /** Show or hide the legend (toggle button + panel). */
  setVisible(visible) {
    if (this.btn) this.btn.style.display = visible ? '' : 'none';
    if (!visible && this.panel) this.panel.style.display = 'none';
  }

  destroy() {
    this._destroyed = true;
    if (this._deferredTimer) {
      clearTimeout(this._deferredTimer);
      this._deferredTimer = null;
    }
    this.btn?.remove();
    this.panel?.remove();
    this.engine = null;
    this.container = null;
    this._body = null;
  }
}
