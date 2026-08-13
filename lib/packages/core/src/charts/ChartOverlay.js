/**
 * ChartOverlay.js — DOM-based overlay for chart title bar, axis labels,
 * ticks, and minimize/maximize.
 *
 * Positioned absolutely over the WebGL canvas. The title bar is draggable
 * and contains a minimize button. Chart type switching is handled by
 * the ChartManagerDialog.
 */

const TITLE_BAR_HEIGHT = 28;

export class ChartOverlay {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./ChartPanel.js').ChartPanel} panel
   * @param {Object} config
   * @param {Function} [onDrag]
   * @param {Function} [onMinimize] — called with boolean (isMinimized)
   */
  constructor(canvas, panel, config, onDrag, onMinimize) {
    this.canvas = canvas;
    this.panel = panel;
    this.config = config;
    this.onDrag = onDrag || (() => {});
    this.onMinimize = onMinimize || (() => {});
    this._minimized = false;

    // Container
    this.container = document.createElement('div');
    this.container.className = 'gt-chart-overlay';
    this.container.style.cssText = `
            position: absolute;
            pointer-events: none;
            font-family: 'Inter', 'Roboto', sans-serif;
            z-index: 10;
        `;

    // ─── Title bar ───
    this.titleBar = document.createElement('div');
    this.titleBar.style.cssText = `
            position: absolute;
            top: 0; left: 0; right: 0;
            height: ${TITLE_BAR_HEIGHT}px;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0 6px 0 10px;
            cursor: grab;
            pointer-events: auto;
            user-select: none;
            border-bottom: 1px solid rgba(0, 229, 255, 0.15);
        `;

    // Title text
    // Auto-generate title: Source — Attribute — Type (if no explicit title)
    let autoTitle = config.name || 'Chart';
    if (!config.style?.title && config.source) {
      const typeName =
        {
          heatmap: 'Heatmap',
          boxplot: 'Box Plot',
          cdf: 'CDF',
          histogram: 'Histogram',
          barplot: 'Bar Plot',
        }[config.type] || config.type;
      const attr = config.attribute || '';
      autoTitle = attr
        ? `${config.source} — ${attr} — ${typeName}`
        : `${config.source} — ${typeName}`;
    }
    const titleSpan = document.createElement('span');
    titleSpan.textContent = config.style?.title || autoTitle;
    titleSpan.style.cssText = `
            font-size: 11px; font-weight: 600;
            color: rgba(255, 255, 255, 0.85);
            letter-spacing: 0.5px; text-transform: uppercase;
            flex: 1;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        `;
    this._titleSpan = titleSpan;

    // Minimize button
    this.minBtn = document.createElement('button');
    this.minBtn.style.cssText = `
            background: none; border: none; cursor: pointer;
            color: rgba(255, 255, 255, 0.5);
            font-size: 16px; line-height: 1;
            padding: 0 2px;
            transition: color 0.2s;
        `;
    this.minBtn.textContent = '−';
    this.minBtn.title = 'Minimize chart';
    this.minBtn.addEventListener('mouseenter', () => {
      this.minBtn.style.color = 'rgba(0, 229, 255, 0.8)';
    });
    this.minBtn.addEventListener('mouseleave', () => {
      this.minBtn.style.color = 'rgba(255, 255, 255, 0.5)';
    });
    this.minBtn.addEventListener('click', (e) => {
      this._minimized = !this._minimized;
      this.minBtn.textContent = this._minimized ? '+' : '−';
      this.minBtn.title = this._minimized ? 'Expand chart' : 'Minimize chart';
      this.onMinimize(this._minimized);
      this._updateMinimizedState();
      e.stopPropagation();
    });

    // Scale select dropdown
    const savedZoom = localStorage.getItem(`gt-chart-zoom-${config.name}`) || '1.0';
    this.scaleSelect = document.createElement('select');
    this.scaleSelect.title = 'Chart scale';
    this.scaleSelect.style.cssText = `
            background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
            color: rgba(255,255,255,0.7); font-size: 9px; border-radius: 3px;
            padding: 1px 2px; cursor: pointer; outline: none;
        `;
    for (const v of ['1.0', '1.2', '1.4', '1.6', '1.8', '2.0']) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = `${v}×`;
      if (v === savedZoom) opt.selected = true;
      this.scaleSelect.appendChild(opt);
    }
    this._scaleFactor = parseFloat(savedZoom);
    this.onScale = null; // set by ChartManager

    this.scaleSelect.addEventListener('change', (e) => {
      const factor = parseFloat(e.target.value);
      this._scaleFactor = factor;
      localStorage.setItem(`gt-chart-zoom-${config.name}`, e.target.value);
      if (this.onScale) this.onScale(factor);
      e.stopPropagation();
    });

    // Drag handle
    const dragHint = document.createElement('span');
    dragHint.textContent = '⠿';
    dragHint.style.cssText = 'font-size: 14px; color: rgba(255, 255, 255, 0.2);';

    this.titleBar.appendChild(titleSpan);
    this.titleBar.appendChild(this.scaleSelect);
    this.titleBar.appendChild(this.minBtn);
    this.titleBar.appendChild(dragHint);
    this.container.appendChild(this.titleBar);

    // ─── Y-axis label (rotated) ───
    this.yLabel = document.createElement('div');
    this.yLabel.style.cssText = `
            position: absolute;
            font-size: 9px; color: rgba(255, 255, 255, 0.45);
            letter-spacing: 0.3px; text-transform: uppercase;
            transform: rotate(-90deg); transform-origin: left top;
            white-space: nowrap;
        `;
    this.yLabel.textContent = config.style?.yLabel || this._autoYLabel();
    this.container.appendChild(this.yLabel);

    // ─── X-axis label ───
    this.xLabel = document.createElement('div');
    this.xLabel.style.cssText = `
            position: absolute;
            font-size: 9px; color: rgba(255, 255, 255, 0.45);
            letter-spacing: 0.3px; text-transform: uppercase;
            text-align: center; white-space: nowrap;
        `;
    this.xLabel.textContent = config.style?.xLabel || this._autoXLabel();
    this.container.appendChild(this.xLabel);

    // Tick containers
    this.yTicksEl = document.createElement('div');
    this.xTicksEl = document.createElement('div');
    this.container.appendChild(this.yTicksEl);
    this.container.appendChild(this.xTicksEl);

    // Insert into DOM
    const parent = canvas.parentElement;
    if (parent) {
      parent.style.position = parent.style.position || 'relative';
      parent.appendChild(this.container);
    }

    this._setupDrag();
  }

  get minimized() {
    return this._minimized;
  }

  _updateMinimizedState() {
    const show = !this._minimized;
    this.yLabel.style.display = show ? '' : 'none';
    this.xLabel.style.display = show ? '' : 'none';
    this.yTicksEl.style.display = show ? '' : 'none';
    this.xTicksEl.style.display = show ? '' : 'none';
  }

  setLabels(xLabel, yLabel) {
    if (xLabel) this.xLabel.textContent = xLabel;
    if (yLabel) this.yLabel.textContent = yLabel;
  }

  setTitle(title) {
    this._titleSpan.textContent = title;
  }

  _autoYLabel() {
    return 'Count';
  }

  _autoXLabel() {
    const attr = this.config.attribute || 'Value';
    const parts = attr.split('_');
    if (parts.length > 1) {
      const unit = parts.pop();
      const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
      const unitDisplay = unit.toLowerCase() === 'mbps' ? 'Mbps' : unit.toUpperCase();
      return `${name} (${unitDisplay})`;
    }
    return attr.charAt(0).toUpperCase() + attr.slice(1);
  }

  _setupDrag() {
    let dragging = false;
    let startX, startY, origX, origY;

    this.titleBar.addEventListener('mousedown', (e) => {
      if (e.target === this.minBtn || e.target === this.scaleSelect) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const r = this.panel.getRect(this.canvas.width, this.canvas.height);
      origX = r.x;
      origY = r.y;
      this.titleBar.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dpr = this.panel.dpr;
      const dx = (e.clientX - startX) * dpr;
      const dy = -(e.clientY - startY) * dpr;
      this.panel._dragOffset = [origX + dx, origY + dy];
      this.onDrag();
      this.updatePosition();
      e.preventDefault();
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        this.titleBar.style.cursor = 'grab';
      }
    });
  }

  updatePosition() {
    const dpr = this.panel.dpr;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const r = this.panel.getRect(cw, ch);
    const pad = this.panel._cssPadding;

    const cssX = r.x / dpr;
    const cssY = (ch - r.y - r.h) / dpr;
    const cssW = r.w / dpr;
    const cssH = r.h / dpr;

    const displayH = this._minimized ? TITLE_BAR_HEIGHT : cssH;

    this.container.style.left = cssX + 'px';
    this.container.style.top = cssY + 'px';
    this.container.style.width = cssW + 'px';
    this.container.style.height = displayH + 'px';

    if (this._minimized) return;

    const plotTop = TITLE_BAR_HEIGHT;
    const plotBot = cssH - pad.bottom;
    const plotH = plotBot - plotTop;
    this.yLabel.style.left = '3px';
    // Position the rotated label so it's vertically centered in the plot area.
    // With rotate(-90deg) + transform-origin:left top, the text grows upward
    // from this anchor point. Offset by half the plot height for centering.
    this.yLabel.style.top = plotBot - plotH * 0.15 + 'px';
    this.yLabel.style.maxWidth = plotH + 'px';

    this.xLabel.style.bottom = '1px';
    this.xLabel.style.left = pad.left + 'px';
    this.xLabel.style.width = cssW - pad.left - pad.right + 'px';
  }

  updateYTicks(maxValue) {
    this.yTicksEl.innerHTML = '';
    const pad = this.panel._cssPadding;
    const dpr = this.panel.dpr;
    const r = this.panel.getRect(this.canvas.width, this.canvas.height);
    const cssH = r.h / dpr;
    const plotTop = TITLE_BAR_HEIGHT;
    const plotBot = cssH - pad.bottom;
    const plotH = plotBot - plotTop;

    const yScale = this.config.style?.yScale || 'linear';

    if (yScale === 'log') {
      // Power-of-10 ticks: evenly spaced on log axis
      const logMax = Math.log10(maxValue + 1);
      const ticks = [0];
      let power = 0;
      while (Math.pow(10, power) <= maxValue) {
        ticks.push(Math.pow(10, power));
        power++;
      }
      for (const value of ticks) {
        const logVal = value > 0 ? Math.log10(value + 1) : 0;
        const t = logVal / logMax;
        this._addTickLabel(this._formatCount(value), plotBot - t * plotH, pad);
      }
    } else {
      // Linear: 5 evenly spaced count ticks
      const tickCount = 5;
      for (let i = 0; i <= tickCount; i++) {
        const t = i / tickCount;
        const value = maxValue * t;
        this._addTickLabel(this._formatCount(value), plotBot - t * plotH, pad);
      }
    }
  }

  _formatCount(value) {
    if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M';
    if (value >= 10_000) return Math.round(value / 1000) + 'K';
    if (value >= 1_000) return (value / 1000).toFixed(1) + 'K';
    if (value >= 100) return Math.round(value).toString();
    if (value >= 10) return value.toFixed(1);
    if (value >= 1) return value.toFixed(2);
    if (value > 0) return value.toPrecision(2);
    return '0';
  }

  _addTickLabel(value, yCSS, pad) {
    const el = document.createElement('div');
    el.style.cssText = `
            position: absolute; left: 4px; top: ${yCSS - 5}px;
            width: ${pad.left - 8}px; text-align: right;
            font-size: 9px; color: rgba(255, 255, 255, 0.45);
            pointer-events: none;
        `;
    el.textContent = value;
    this.yTicksEl.appendChild(el);
  }

  updateXTicks(domain, binCount) {
    this.xTicksEl.innerHTML = '';
    const pad = this.panel._cssPadding;
    const dpr = this.panel.dpr;
    const r = this.panel.getRect(this.canvas.width, this.canvas.height);
    const cssW = r.w / dpr;
    const cssH = r.h / dpr;
    const plotLeft = pad.left;
    const plotWidth = cssW - pad.left - pad.right;
    const binWidth = (domain[1] - domain[0]) / binCount;
    // Perfect centering logic for symmetrically padded zero-variance arrays (-1 to +1)
    if (domain[1] - domain[0] === 2) {
      const renderCentricTick = (t, label) => {
        const xCSS = plotLeft + t * plotWidth;
        const el = document.createElement('div');
        el.style.cssText = `
                    position: absolute; left: ${xCSS - 10}px;
                    top: ${cssH - pad.bottom + 2}px;
                    width: 20px; text-align: center;
                    font-size: 9px; color: rgba(255, 255, 255, 0.45);
                    pointer-events: none;
                `;
        el.textContent = label;
        this.xTicksEl.appendChild(el);
      };
      renderCentricTick(0.0, Math.round(domain[0]));
      renderCentricTick(0.5, Math.round((domain[0] + domain[1]) / 2));
      renderCentricTick(1.0, Math.round(domain[1]));
      return;
    }

    const step = binCount > 8 ? 2 : 1;
    const tickDelta = step * binWidth;
    const isArtificiallyPadded = false; // removed as logic branches above

    let lastLabel = null;
    for (let i = 0; i <= binCount; i += step) {
      const t = i / binCount;
      const xCSS = plotLeft + t * plotWidth;
      const raw = domain[0] + i * binWidth;

      // Choose precision based on the delta between ticks
      let label;
      if (tickDelta >= 1 || isArtificiallyPadded) {
        label = Math.round(raw);
      } else if (tickDelta >= 0.1) {
        label = parseFloat(raw.toFixed(1));
      } else {
        label = parseFloat(raw.toFixed(2));
      }

      // Deduplicate to avoid rendering identical labels over top of each other
      if (label === lastLabel) continue;
      lastLabel = label;

      const el = document.createElement('div');
      el.style.cssText = `
                position: absolute; left: ${xCSS - 10}px;
                top: ${cssH - pad.bottom + 2}px;
                width: 20px; text-align: center;
                font-size: 9px; color: rgba(255, 255, 255, 0.45);
                pointer-events: none;
            `;
      el.textContent = label;
      this.xTicksEl.appendChild(el);
    }
  }

  /**
   * Generate X-axis time tick labels reflecting the actual data range.
   * @param {number} timeBins — number of time bins
   * @param {number} startHour — hour offset of the data start (UTC)
   * @param {number} [durationHours=24] — how many hours the data spans
   */
  updateHeatmapXTicks(timeBins, startHour = 0, durationHours = 24) {
    this.xTicksEl.innerHTML = '';
    const pad = this.panel._cssPadding;
    const dpr = this.panel.dpr;
    const r = this.panel.getRect(this.canvas.width, this.canvas.height);
    const cssW = r.w / dpr;
    const cssH = r.h / dpr;
    const plotLeft = pad.left;
    const plotWidth = cssW - pad.left - pad.right;

    // Choose tick interval: aim for ~6-9 ticks
    let tickIntervalHours;
    if (durationHours <= 2)
      tickIntervalHours = 0.25; // 15 min ticks
    else if (durationHours <= 6)
      tickIntervalHours = 1; // hourly ticks
    else if (durationHours <= 12)
      tickIntervalHours = 2; // every 2h
    else tickIntervalHours = 3; // every 3h

    // Generate ticks from 0 to durationHours
    for (let h = 0; h <= durationHours; h += tickIntervalHours) {
      const t = h / durationHours;
      const xCSS = plotLeft + t * plotWidth;
      const actualHour = (startHour + h) % 24;
      const hh = Math.floor(actualHour);
      const mm = Math.round((actualHour - hh) * 60);
      const hourLabel = hh.toString().padStart(2, '0') + ':' + mm.toString().padStart(2, '0');

      const el = document.createElement('div');
      el.style.cssText = `
                position: absolute; left: ${xCSS - 14}px;
                top: ${cssH - pad.bottom + 2}px;
                width: 28px; text-align: center;
                font-size: 8px; color: rgba(255, 255, 255, 0.45);
                pointer-events: none;
            `;
      el.textContent = hourLabel;
      this.xTicksEl.appendChild(el);
    }
  }

  /** Show or hide the overlay DOM elements. */
  setVisible(visible) {
    if (this.container) {
      this.container.style.display = visible ? '' : 'none';
    }
  }

  /**
   * Update X-axis with category labels for bar plots.
   * @param {string[]} categories — category names
   */
  updateCategoryLabels(categories) {
    this.xTicksEl.innerHTML = '';
    if (!categories || categories.length === 0) return;

    const pad = this.panel._cssPadding;
    const dpr = this.panel.dpr;
    const r = this.panel.getRect(this.canvas.width, this.canvas.height);
    const cssW = r.w / dpr;
    const cssH = r.h / dpr;
    const plotLeft = pad.left;
    const plotWidth = cssW - pad.left - pad.right;

    const n = categories.length;
    const barWidth = plotWidth / n;

    for (let i = 0; i < n; i++) {
      const xCSS = plotLeft + (i + 0.5) * barWidth;
      const el = document.createElement('div');
      el.style.cssText = `
                position: absolute; left: ${xCSS}px;
                top: ${cssH - pad.bottom + 4}px;
                transform: translateX(-50%) rotate(-35deg);
                transform-origin: top center;
                font-size: 8px; color: rgba(255, 255, 255, 0.6);
                pointer-events: none; white-space: nowrap;
                max-width: ${barWidth * 1.5}px; overflow: hidden;
                text-overflow: ellipsis;
            `;
      el.textContent = categories[i];
      this.xTicksEl.appendChild(el);
    }
  }

  dispose() {
    this.container.remove();
  }
}
