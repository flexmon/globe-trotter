/**
 * H3SymbologyDialog.js — Ramp editor for H3Flex layers.
 * Provides interactive color-stop editing, domain inputs, add/reset controls.
 * Opened from LayerManagerDialog via a "Symbology" button per H3 layer.
 */

import { RampEditorWidget } from './RampEditorWidget.js';

export class H3SymbologyDialog {
  /**
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {string} layerName
   * @param {{ stops: Array, domain: number[], attribute?: string, label?: string }} layerMeta
   */
  constructor(engine, layerName, layerMeta) {
    this.engine = engine;
    this.layerName = layerName;
    this._overlay = null;
    this._closeTimer = null;
    this._destroyed = false;

    // Deep-clone stops and domain from layer metadata
    this._stops = (layerMeta.stops || []).map((s) => ({
      value: s.value,
      color: s.color,
      opacity: s.opacity ?? 1.0,
    }));
    this._domain = [...(layerMeta.domain || [0, 100])];
    this._attribute = layerMeta.attribute || '';
    // Friendly display label — falls back to raw column name when not provided
    this._label = layerMeta.label || this._attribute;
    this._originalStops = this._stops.map((s) => ({ ...s }));
    this._originalDomain = [...this._domain];

    this._buildOverlay();
  }

  _buildOverlay() {
    document.querySelector('.gt-h3-sym-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'gt-glass-panel gt-sym-overlay gt-h3-sym-overlay';
    this._overlay = overlay;

    overlay.innerHTML = `
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
                ${this._label ? `<div class="gt-lm-ramp-attr">${this._label}</div>` : ''}
                <div class="gt-lm-ramp-editor" data-section="editor"></div>
                <div data-section="extrusion"></div>
            </div>
        `;

    const _t = (this.engine && this.engine.uiContainer) || document.body;
    _t.appendChild(overlay);

    // Trigger CSS transition
    requestAnimationFrame(() => overlay.classList.add('gt-sym-visible'));

    // Apply zoom
    const savedZoom = localStorage.getItem('gt-dialog-zoom') || '1.0';
    overlay.style.zoom = savedZoom;
    const zoomSelect = overlay.querySelector('.gt-lm-zoom-select');
    zoomSelect.value = savedZoom;
    zoomSelect.addEventListener('change', (e) => {
      overlay.style.zoom = e.target.value;
      localStorage.setItem('gt-dialog-zoom', e.target.value);
    });

    // Close button
    overlay.querySelector('.gt-sym-close').addEventListener('click', () => this.close());

    // Drag by header (container-relative coordinates)
    const header = overlay.querySelector('.gt-sym-header');
    header.addEventListener('mousedown', (ev) => {
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

    // Build ramp editor inside the body
    const container = overlay.querySelector('[data-section="editor"]');
    new RampEditorWidget(container, {
      stops: this._stops,
      domain: this._domain,
      onChange: (newStops, newDomain) => {
        this._stops = newStops;
        this._domain = newDomain;
        this.engine.layerManager.updateLayerRamp(this.layerName, newStops, newDomain);
      },
    });

    // Build extrusion controls if renderer supports it
    const layerData = this.engine.layerManager.layers.get(this.layerName);
    const extRenderer = layerData?.renderer;
    if (!extRenderer?.setExtrusionScale) return;

    const currentScale = extRenderer.extrusionScale ?? 0;

    const section = document.createElement('div');
    section.className = 'gt-lm-extrude-section';
    section.style.marginTop = '8px';

    const title = document.createElement('div');
    title.className = 'gt-sym-section-title';
    title.textContent = '3D Extrusion';
    title.style.marginBottom = '4px';
    section.appendChild(title);

    const controlRow = document.createElement('div');
    controlRow.className = 'gt-lm-extrude-row';

    const extToggle = document.createElement('label');
    extToggle.className = 'gt-lm-toggle gt-lm-toggle-small';
    const extCheckbox = document.createElement('input');
    extCheckbox.type = 'checkbox';
    extCheckbox.checked = currentScale > 0;
    const extTrack = document.createElement('span');
    extTrack.className = 'gt-lm-toggle-track';
    extToggle.appendChild(extCheckbox);
    extToggle.appendChild(extTrack);

    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'gt-lm-extrude-slider-wrap';
    sliderWrap.style.display = extCheckbox.checked ? 'flex' : 'none';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'gt-lm-extrude-slider';
    slider.min = '50';
    slider.max = '500';
    slider.value = String(Math.round((currentScale / 0.012) * 100));

    const valLabel = document.createElement('span');
    valLabel.className = 'gt-lm-extrude-val';
    valLabel.textContent = `${(currentScale / 0.012).toFixed(1)}×`;

    sliderWrap.appendChild(slider);
    sliderWrap.appendChild(valLabel);

    controlRow.appendChild(extToggle);
    controlRow.appendChild(sliderWrap);
    section.appendChild(controlRow);

    // Events
    extCheckbox.addEventListener('change', () => {
      if (extCheckbox.checked) {
        const mult = parseInt(slider.value) / 100;
        extRenderer.setExtrusionScale(0.012 * mult);
        sliderWrap.style.display = 'flex';
      } else {
        extRenderer.setExtrusionScale(0);
        sliderWrap.style.display = 'none';
      }
    });

    slider.addEventListener('input', () => {
      const mult = parseInt(slider.value) / 100;
      valLabel.textContent = `${mult.toFixed(1)}×`;
      if (extCheckbox.checked) {
        extRenderer.setExtrusionScale(0.012 * mult);
      }
    });

    container.appendChild(section);
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
    this._overlay?.remove();
    this._overlay = null;
    this.engine = null;
  }
}
