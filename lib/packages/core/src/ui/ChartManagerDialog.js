/**
 * ChartManagerDialog.js — Multi-chart manager dialog with chart list sidebar.
 *
 * Left panel: scrollable list of chart name pills + "+" add button.
 * Right panel: property form for the selected chart with Apply / Remove.
 */

export class ChartManagerDialog {
  /**
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {HTMLElement} container
   */
  constructor(engine, container) {
    this.engine = engine;
    this._stickyPos = null;
    this._selectedIdx = 0;
    this._createDOM(container);
    this._bindEvents();
  }

  // ─────────────────────────── DOM ───────────────────────────

  _createDOM(container) {
    // ── Charts toggle button ──
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'gt-glass-panel gt-charts-btn';
    this.toggleBtn.title = 'Chart Manager';
    this.toggleBtn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="12" width="4" height="9"></rect>
              <rect x="10" y="7" width="4" height="14"></rect>
              <rect x="17" y="3" width="4" height="18"></rect>
            </svg>
            <span>Charts</span>
        `;
    container.appendChild(this.toggleBtn);

    // ── Panel ──
    this.panel = document.createElement('div');
    this.panel.className = 'gt-glass-panel gt-chart-manager-panel';
    this.panel.style.display = 'none';

    // Restore sticky zoom from localStorage
    const savedZoom = localStorage.getItem('gt-dialog-zoom') || '1.0';
    this.panel.style.zoom = savedZoom;

    this.panel.innerHTML = `
            <div class="gt-cm-header">
                <h3 class="gt-cm-title">Chart Manager</h3>
                <select class="gt-lm-zoom-select" title="UI zoom scale">
                    <option value="1.0"${savedZoom === '1.0' ? ' selected' : ''}>1.0×</option>
                    <option value="1.2"${savedZoom === '1.2' ? ' selected' : ''}>1.2×</option>
                    <option value="1.4"${savedZoom === '1.4' ? ' selected' : ''}>1.4×</option>
                    <option value="1.6"${savedZoom === '1.6' ? ' selected' : ''}>1.6×</option>
                    <option value="1.8"${savedZoom === '1.8' ? ' selected' : ''}>1.8×</option>
                    <option value="2.0"${savedZoom === '2.0' ? ' selected' : ''}>2.0×</option>
                </select>
                <button class="gt-cm-close-btn" title="Close">&times;</button>
            </div>
            <div class="gt-cm-layout">
                <div class="gt-cm-chart-list"></div>
                <div class="gt-cm-body"></div>
            </div>
        `;
    document.body.appendChild(this.panel);

    // Cache refs
    this._header = this.panel.querySelector('.gt-cm-header');
    this._closeBtn = this.panel.querySelector('.gt-cm-close-btn');
    this._chartList = this.panel.querySelector('.gt-cm-chart-list');
    this._body = this.panel.querySelector('.gt-cm-body');

    // Zoom selector
    const zoomSelect = this.panel.querySelector('.gt-lm-zoom-select');
    zoomSelect.addEventListener('change', (e) => {
      this.panel.style.zoom = e.target.value;
      localStorage.setItem('gt-dialog-zoom', e.target.value);
    });
  }

  /**
   * Rebuild the entire panel content (chart list + form).
   */
  _refresh() {
    this._buildChartList();
    this._populateForm();
  }

  /**
   * Build the left chart list pills + "+" button.
   */
  _buildChartList() {
    const charts = this._getCharts();
    let html = '';

    for (let i = 0; i < charts.length; i++) {
      const c = charts[i];
      const active = i === this._selectedIdx ? ' gt-cm-pill-active' : '';
      const icon = this._chartIcon(c.config.type);
      const source = c.config.source || '';
      html += `<button class="gt-cm-chart-pill${active}" data-idx="${i}" title="${c.config.name} — ${source}">
                <span class="gt-cm-pill-icon">${icon}</span>
                <span class="gt-cm-pill-text">
                    <span class="gt-cm-pill-name">${this._truncate(c.config.name, 14)}</span>
                    <span class="gt-cm-pill-source">${this._truncate(source, 16)}</span>
                </span>
            </button>`;
    }

    html += `<button class="gt-cm-add-btn" title="Add Chart">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
              stroke-linecap="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
        </button>`;

    this._chartList.innerHTML = html;

    // Bind pill clicks
    this._chartList.querySelectorAll('.gt-cm-chart-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._selectedIdx = parseInt(btn.dataset.idx);
        this._refresh();
      });
    });

    // Bind add button
    this._chartList.querySelector('.gt-cm-add-btn')?.addEventListener('click', () => {
      this._addNewChart();
    });
  }

  /**
   * Populate the property form from the selected chart's config.
   */
  _populateForm() {
    const charts = this._getCharts();
    if (charts.length === 0) {
      this._body.innerHTML = `
                <div style="text-align:center; padding:24px 0; color:rgba(255,255,255,0.4); font-size:12px;">
                    No charts. Click <strong>+</strong> to add one.
                </div>`;
      return;
    }

    // Clamp selected index
    if (this._selectedIdx >= charts.length) this._selectedIdx = charts.length - 1;
    if (this._selectedIdx < 0) this._selectedIdx = 0;

    const chart = charts[this._selectedIdx];
    const c = chart.config;
    const s = c.style || {};

    this._body.innerHTML = this._buildFormHTML(c, s);
    this._bindFormEvents();
  }

  _buildFormHTML(c, s) {
    const sources = this._getLayerNames();
    const sourceOptions = sources
      .map((n) => `<option value="${n}"${n === c.source ? ' selected' : ''}>${n}</option>`)
      .join('');

    return `
            <div class="gt-cm-section">
                <label class="gt-cm-label">Chart Type</label>
                <select class="gt-cm-select" id="gt-cm-type">
                    <option value="heatmap"${c.type === 'heatmap' ? ' selected' : ''}>🟦 Heatmap</option>
                    <option value="histogram"${c.type === 'histogram' ? ' selected' : ''}>📊 Histogram</option>
                    <option value="boxplot"${c.type === 'boxplot' ? ' selected' : ''}>📦 Box Plot</option>
                    <option value="barplot"${c.type === 'barplot' ? ' selected' : ''}>📊 Bar Plot</option>
                    <option value="cdf"${c.type === 'cdf' ? ' selected' : ''}>📈 CDF</option>
                </select>
            </div>

            <div class="gt-cm-section">
                <label class="gt-cm-label">Data Source</label>
                <select class="gt-cm-select" id="gt-cm-source">
                    ${sourceOptions}
                </select>
            </div>

            <div class="gt-cm-section">
                <label class="gt-cm-label">Attribute</label>
                <input class="gt-cm-input" id="gt-cm-attribute" type="text" value="${c.attribute || ''}" placeholder="Auto-detect" />
            </div>

            <div class="gt-cm-divider"></div>

            <div class="gt-cm-row">
                <div class="gt-cm-section gt-cm-half">
                    <label class="gt-cm-label">Title</label>
                    <input class="gt-cm-input" id="gt-cm-title" type="text" value="${s.title || c.name || 'Chart'}" />
                </div>
            </div>

            <div class="gt-cm-row">
                <div class="gt-cm-section gt-cm-half">
                    <label class="gt-cm-label">X Axis Label</label>
                    <input class="gt-cm-input" id="gt-cm-xlabel" type="text" value="${s.xLabel || ''}" placeholder="Auto" />
                </div>
                <div class="gt-cm-section gt-cm-half">
                    <label class="gt-cm-label">Y Axis Label</label>
                    <input class="gt-cm-input" id="gt-cm-ylabel" type="text" value="${s.yLabel || ''}" placeholder="Auto" />
                </div>
            </div>

            <div class="gt-cm-divider"></div>

            <div class="gt-cm-row" id="gt-cm-domain-row"
                 style="display:${c.type === 'heatmap' || c.type === 'histogram' ? '' : 'none'}">
                <div class="gt-cm-section gt-cm-half">
                    <label class="gt-cm-label">Domain Min</label>
                    <input class="gt-cm-input" id="gt-cm-domain-min" type="number" value="${(s.domain || [0, 60])[0]}" />
                </div>
                <div class="gt-cm-section gt-cm-half">
                    <label class="gt-cm-label">Domain Max</label>
                    <input class="gt-cm-input" id="gt-cm-domain-max" type="number" value="${(s.domain || [0, 60])[1]}" />
                </div>
            </div>

            <div class="gt-cm-row" id="gt-cm-bins-row"
                 style="display:${c.type === 'heatmap' || c.type === 'histogram' ? '' : 'none'}">
                <div class="gt-cm-section gt-cm-half">
                    <label class="gt-cm-label">Bins</label>
                    <input class="gt-cm-input" id="gt-cm-bins" type="number" value="${s.binCount || s.valueBins || 12}" min="2" max="100" />
                </div>
                <div class="gt-cm-section gt-cm-half">
                    <label class="gt-cm-label">Y Scale</label>
                    <select class="gt-cm-select" id="gt-cm-yscale">
                        <option value="linear"${s.yScale === 'linear' ? ' selected' : ''}>Linear</option>
                        <option value="log"${s.yScale === 'log' ? ' selected' : ''}>Logarithmic</option>
                    </select>
                </div>
            </div>

            <div class="gt-cm-section gt-cm-type-specific" id="gt-cm-timebins-opts"
                 style="display:${c.type === 'heatmap' || c.type === 'boxplot' ? '' : 'none'}">
                <div class="gt-cm-row">
                    <div class="gt-cm-section gt-cm-half">
                        <label class="gt-cm-label">Time Bins</label>
                        <input class="gt-cm-input" id="gt-cm-time-bins" type="number" value="${s.timeBins || (c.type === 'boxplot' ? 24 : 48)}" min="4" max="144" />
                    </div>
                </div>
            </div>

            <div class="gt-cm-section" id="gt-cm-barplot-opts"
                 style="display:${c.type === 'barplot' ? '' : 'none'}">
                <div class="gt-cm-row">
                    <div class="gt-cm-section gt-cm-half">
                        <label class="gt-cm-label">Group By</label>
                        <input class="gt-cm-input" id="gt-cm-groupby" type="text" value="${c.groupBy || ''}" placeholder="e.g. airline" />
                    </div>
                    <div class="gt-cm-section gt-cm-half">
                        <label class="gt-cm-label">Top N</label>
                        <input class="gt-cm-input" id="gt-cm-topn" type="number" value="${c.topN || 10}" min="1" max="50" />
                    </div>
                </div>
                <div class="gt-cm-row">
                    <div class="gt-cm-section gt-cm-half">
                        <label class="gt-cm-label">Aggregation</label>
                        <select class="gt-cm-select" id="gt-cm-aggregation">
                            <option value="sum"${c.aggregation === 'sum' ? ' selected' : ''}>Sum</option>
                            <option value="avg"${c.aggregation === 'avg' ? ' selected' : ''}>Average</option>
                            <option value="count"${c.aggregation === 'count' ? ' selected' : ''}>Count</option>
                        </select>
                    </div>
                    <div class="gt-cm-section gt-cm-half">
                        <label class="gt-cm-label">Time Window (min)</label>
                        <input class="gt-cm-input" id="gt-cm-time-window" type="number" value="${s.timeWindow || 1}" min="1" max="1440" title="Snaps to fixed windows (e.g. 60 = hourly sums)" />
                    </div>
                </div>
            </div>

            <div class="gt-cm-section" id="gt-cm-labels-opts"
                 style="display:${c.type === 'barplot' || c.type === 'histogram' ? '' : 'none'}">
                <div class="gt-cm-divider"></div>
                <div class="gt-cm-row" style="align-items:center;margin-bottom:4px">
                    <label class="gt-cm-label" style="flex:0;white-space:nowrap;margin-right:8px">Bar Labels</label>
                    <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;color:rgba(255,255,255,0.6)">
                        <input type="checkbox" id="gt-cm-show-labels" ${s.showBarLabels !== false ? 'checked' : ''}
                               style="accent-color:#00e5ff;cursor:pointer" />
                        Show
                    </label>
                </div>
                <div class="gt-cm-row">
                    <div class="gt-cm-section gt-cm-half">
                        <label class="gt-cm-label">Format</label>
                        <select class="gt-cm-select" id="gt-cm-label-format">
                            <option value="currency"${(s.labelFormat || 'number') === 'currency' ? ' selected' : ''}>Currency ($)</option>
                            <option value="number"${(s.labelFormat || 'number') === 'number' ? ' selected' : ''}>Number</option>
                            <option value="percent"${(s.labelFormat || 'number') === 'percent' ? ' selected' : ''}>Percent (%)</option>
                        </select>
                    </div>
                    <div class="gt-cm-section gt-cm-half">
                        <label class="gt-cm-label">Label Size</label>
                        <input class="gt-cm-input" id="gt-cm-label-size" type="number" value="${s.labelSize || 10}" min="6" max="24" />
                    </div>
                </div>
                <div class="gt-cm-row">
                    <div class="gt-cm-section gt-cm-half">
                        <label class="gt-cm-label">Label Color</label>
                        <input id="gt-cm-label-color" type="color" value="${s.labelColor || '#ffffff'}"
                               style="width:100%;height:22px;border:1px solid rgba(255,255,255,0.15);border-radius:3px;background:transparent;cursor:pointer" />
                    </div>
                </div>
            </div>

            <div class="gt-cm-divider"></div>

            <div class="gt-cm-actions">
                <button class="gt-cm-apply-btn" id="gt-cm-apply">Apply</button>
                <button class="gt-cm-remove-btn" id="gt-cm-remove">Remove</button>
            </div>
        `;
  }

  // ─────────────────────────── Events ───────────────────────────

  _bindEvents() {
    // Toggle open/close
    this.toggleBtn.addEventListener('click', () => {
      const isOpen = this.panel.style.display !== 'none';
      if (isOpen) {
        this.panel.style.display = 'none';
      } else {
        this._refresh();
        if (this._stickyPos) {
          this.panel.style.left = this._stickyPos.left;
          this.panel.style.top = this._stickyPos.top;
          this.panel.style.right = 'auto';
        } else {
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

    // ── Drag header (container-relative coordinates) ──
    let dragState = { dragging: false };
    this._header.style.cursor = 'grab';

    this._header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.gt-cm-close-btn') || e.target.closest('.gt-lm-zoom-select')) return;
      e.preventDefault();
      const rect = this.panel.getBoundingClientRect();
      const cRect = this.panel.parentElement
        ? this.panel.parentElement.getBoundingClientRect()
        : { left: 0, top: 0 };
      dragState = {
        dragging: true,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: rect.left - cRect.left,
        startTop: rect.top - cRect.top,
      };
      this._header.style.cursor = 'grabbing';
    });

    this._mouseMoveHandler = (e) => {
      if (!dragState.dragging) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      this.panel.style.left = dragState.startLeft + dx + 'px';
      this.panel.style.top = dragState.startTop + dy + 'px';
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

  _bindFormEvents() {
    const typeSelect = this.panel.querySelector('#gt-cm-type');
    const attrInput = this.panel.querySelector('#gt-cm-attribute');
    const domainRow = this.panel.querySelector('#gt-cm-domain-row');
    const binsRow = this.panel.querySelector('#gt-cm-bins-row');
    const timeBinsOpts = this.panel.querySelector('#gt-cm-timebins-opts');
    const barplotOpts = this.panel.querySelector('#gt-cm-barplot-opts');
    const applyBtn = this.panel.querySelector('#gt-cm-apply');
    const removeBtn = this.panel.querySelector('#gt-cm-remove');
    const titleInput = this.panel.querySelector('#gt-cm-title');
    const xLabelInput = this.panel.querySelector('#gt-cm-xlabel');
    const yLabelInput = this.panel.querySelector('#gt-cm-ylabel');

    // Track which fields the user has manually edited
    this._userEdited = { title: false, xLabel: false, yLabel: false };
    titleInput?.addEventListener('input', () => {
      this._userEdited.title = true;
    });
    xLabelInput?.addEventListener('input', () => {
      this._userEdited.xLabel = true;
    });
    yLabelInput?.addEventListener('input', () => {
      this._userEdited.yLabel = true;
    });

    // Auto-update labels and input visibility when type or attribute changes
    const autoUpdate = () => {
      const type = typeSelect?.value || 'heatmap';
      const attr = attrInput?.value || '';
      const aggSelect = this.panel.querySelector('#gt-cm-aggregation');
      const labels = this._getAutoLabels(type, attr, groupByInput?.value, aggSelect?.value);

      if (!this._userEdited.title && titleInput) titleInput.value = labels.title;
      if (!this._userEdited.xLabel && xLabelInput) xLabelInput.value = labels.xLabel;
      if (!this._userEdited.yLabel && yLabelInput) yLabelInput.value = labels.yLabel;

      // Show/hide inputs based on chart type
      const showDomain = type === 'heatmap' || type === 'histogram';
      const showBins = type === 'heatmap' || type === 'histogram';
      const showTimeBins = type === 'heatmap' || type === 'boxplot';
      const showBarplot = type === 'barplot';
      const showLabels = type === 'barplot' || type === 'histogram';

      if (domainRow) domainRow.style.display = showDomain ? '' : 'none';
      if (binsRow) binsRow.style.display = showBins ? '' : 'none';
      if (timeBinsOpts) timeBinsOpts.style.display = showTimeBins ? '' : 'none';
      if (barplotOpts) barplotOpts.style.display = showBarplot ? '' : 'none';
      const labelsOpts = this.panel.querySelector('#gt-cm-labels-opts');
      if (labelsOpts) labelsOpts.style.display = showLabels ? '' : 'none';
    };

    if (typeSelect) {
      typeSelect.addEventListener('change', () => {
        this._userEdited = { title: false, xLabel: false, yLabel: false };
        autoUpdate();
      });
    }
    if (attrInput) {
      attrInput.addEventListener('change', () => {
        this._userEdited.title = false;
        this._userEdited.xLabel = false;
        autoUpdate();
      });
    }

    // Also refresh labels when groupBy changes
    const groupByInput = this.panel.querySelector('#gt-cm-groupby');
    if (groupByInput) {
      groupByInput.addEventListener('change', () => {
        this._userEdited.xLabel = false;
        autoUpdate();
      });
    }

    // Refresh labels when aggregation changes
    const aggSelect = this.panel.querySelector('#gt-cm-aggregation');
    if (aggSelect) {
      aggSelect.addEventListener('change', () => {
        this._userEdited.yLabel = false;
        autoUpdate();
      });
    }

    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        this._applyChart();
      });
    }
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        this._removeChart();
      });
    }

    // Real-time label toggle — enable/disable without needing Apply
    const showLabelsCheckbox = this.panel.querySelector('#gt-cm-show-labels');
    if (showLabelsCheckbox) {
      showLabelsCheckbox.addEventListener('change', () => {
        const charts = this._getCharts();
        if (this._selectedIdx < charts.length) {
          const chart = charts[this._selectedIdx];
          if (chart.labelRenderer) {
            chart._labelsVisible = showLabelsCheckbox.checked;
          }
        }
      });
    }

    autoUpdate();
  }

  /**
   * Generate smart default labels based on chart type and attribute.
   */
  _getAutoLabels(type, attribute, groupBy, aggregation) {
    const prettyAttr = this._prettyAttribute(attribute);

    switch (type) {
      case 'cdf':
        return { title: `CDF of ${prettyAttr}`, xLabel: prettyAttr, yLabel: 'Probability' };
      case 'heatmap':
        return {
          title: `24h ${prettyAttr} Heatmap`,
          xLabel: 'Time of Day (UTC)',
          yLabel: prettyAttr,
        };
      case 'histogram':
        return { title: `${prettyAttr} Distribution`, xLabel: prettyAttr, yLabel: 'H3 Cell Count' };
      case 'boxplot':
        return { title: `${prettyAttr} Box Plot`, xLabel: 'Time of Day', yLabel: prettyAttr };
      case 'barplot': {
        const prettyGroup = groupBy ? this._prettyAttribute(groupBy) : 'Category';
        const aggPrefix =
          aggregation === 'avg' ? 'Average' : aggregation === 'count' ? 'Count of' : 'Total';
        return {
          title: `${prettyAttr} by ${prettyGroup}`,
          xLabel: prettyGroup,
          yLabel: `${aggPrefix} ${prettyAttr}`,
        };
      }
      default:
        return { title: `${prettyAttr} Chart`, xLabel: prettyAttr, yLabel: 'Value' };
    }
  }

  _prettyAttribute(attr) {
    if (!attr) return 'Value';
    const parts = attr.split('_');
    if (parts.length > 1) {
      const unit = parts.pop();
      const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
      const unitDisplay =
        unit.toLowerCase() === 'mbps'
          ? 'Mbps'
          : unit.toLowerCase() === 'hz'
            ? 'Hz'
            : unit.toUpperCase();
      return `${name} (${unitDisplay})`;
    }
    return attr.charAt(0).toUpperCase() + attr.slice(1);
  }

  // ─────────────────────────── Apply / Remove / Add ───────────────────────────

  _applyChart() {
    const v = (id) => this.panel.querySelector(id)?.value || '';
    const type = v('#gt-cm-type');

    // Get existing chart config to preserve YAML-specified values
    const charts = this._getCharts();
    const oldConfig = this._selectedIdx < charts.length ? charts[this._selectedIdx].config : {};
    const oldStyle = oldConfig.style || {};

    const config = {
      name: v('#gt-cm-title') || oldConfig.name || 'Chart',
      type,
      source: v('#gt-cm-source') || oldConfig.source,
      attribute: v('#gt-cm-attribute') || oldConfig.attribute,
      position: oldConfig.position || 'top-right',
      size: oldConfig.size || [420, 180],
      visible: oldConfig.visible,
      style: {
        title: v('#gt-cm-title'),
        xLabel: v('#gt-cm-xlabel') || undefined,
        yLabel: v('#gt-cm-ylabel') || undefined,
        domain: [
          parseFloat(v('#gt-cm-domain-min')) || (oldStyle.domain || [0, 100])[0],
          parseFloat(v('#gt-cm-domain-max')) || (oldStyle.domain || [0, 100])[1],
        ],
        binCount: parseInt(v('#gt-cm-bins')) || oldStyle.binCount || 12,
        valueBins: parseInt(v('#gt-cm-bins')) || oldStyle.valueBins || 12,
        yScale: v('#gt-cm-yscale') || oldStyle.yScale || 'linear',
        timeBins: parseInt(v('#gt-cm-time-bins')) || oldStyle.timeBins || 48,
        barGap: oldStyle.barGap ?? 0.15,
        barOpacity: oldStyle.barOpacity ?? 0.9,
        background: oldStyle.background || 'rgba(4, 6, 12, 0.88)',
        nowIndicator: oldStyle.nowIndicator,
        timeWindow:
          parseInt(this.panel.querySelector('#gt-cm-time-window')?.value) ||
          oldStyle.timeWindow ||
          1,
        yAutoScale: oldStyle.yAutoScale,
      },
    };

    // Barplot-specific fields
    if (type === 'barplot') {
      config.groupBy = v('#gt-cm-groupby') || oldConfig.groupBy || '';
      config.aggregation = v('#gt-cm-aggregation') || oldConfig.aggregation || 'sum';
      config.topN = parseInt(v('#gt-cm-topn')) || oldConfig.topN || 10;
    }

    // Label settings (barplot + histogram)
    if (type === 'barplot' || type === 'histogram') {
      const showLabels = this.panel.querySelector('#gt-cm-show-labels');
      config.style.showBarLabels = showLabels
        ? showLabels.checked
        : oldStyle.showBarLabels !== false;
      config.style.labelFormat = v('#gt-cm-label-format') || oldStyle.labelFormat || 'number';
      config.style.labelSize = parseInt(v('#gt-cm-label-size')) || oldStyle.labelSize || 10;
      const colorInput = this.panel.querySelector('#gt-cm-label-color');
      config.style.labelColor = colorInput ? colorInput.value : oldStyle.labelColor || '#ffffff';
    }

    const cm = this.engine.chartManager;
    if (!cm) return;

    // Remove the currently selected chart, then add the updated one
    if (this._selectedIdx < charts.length) {
      const oldName = charts[this._selectedIdx].config.name;
      cm.removeChart(oldName);
    }

    cm.addChart(config);
    cm._rampApplied = false;

    // Re-select the chart (it's now at the end)
    this._selectedIdx = cm.charts.length - 1;

    // Flash the Apply button
    const btn = this.panel.querySelector('#gt-cm-apply');
    if (btn) {
      btn.textContent = '✓ Applied';
      btn.style.background = 'rgba(0, 200, 100, 0.3)';
      setTimeout(() => {
        btn.textContent = 'Apply';
        btn.style.background = '';
      }, 1200);
    }

    this._refresh();
  }

  _removeChart() {
    const cm = this.engine.chartManager;
    if (!cm) return;

    const charts = this._getCharts();
    if (this._selectedIdx < charts.length) {
      cm.removeChart(charts[this._selectedIdx].config.name);
    }

    // Select previous chart or first
    if (this._selectedIdx > 0) this._selectedIdx--;
    this._refresh();
  }

  _addNewChart() {
    const cm = this.engine.chartManager;
    if (!cm) return;

    const sources = this._getLayerNames();
    const defaultSource = sources[0] || '';
    const idx = cm.charts.length + 1;

    const config = {
      name: `Chart ${idx}`,
      type: 'histogram',
      source: defaultSource,
      attribute: '',
      position: 'top-right',
      size: [420, 180],
      style: {
        title: `Chart ${idx}`,
        xLabel: '',
        yLabel: '',
        domain: [0, 60],
        binCount: 12,
        yScale: 'log',
        background: 'rgba(4, 6, 12, 0.88)',
      },
    };

    cm.addChart(config);
    cm._rampApplied = false;

    // Select the new chart
    this._selectedIdx = cm.charts.length - 1;
    this._refresh();
  }

  // ─────────────────────────── Helpers ───────────────────────────

  _getCharts() {
    return this.engine.chartManager?.charts || [];
  }

  _getLayerNames() {
    try {
      return this.engine.layerManager.getLayerInfo().map((l) => l.name);
    } catch {
      return [];
    }
  }

  _chartIcon(type) {
    switch (type) {
      case 'heatmap':
        return '🟦';
      case 'histogram':
        return '📊';
      case 'boxplot':
        return '📦';
      case 'barplot':
        return '📊';
      case 'cdf':
        return '📈';
      default:
        return '📉';
    }
  }

  _truncate(str, max) {
    return str && str.length > max ? str.slice(0, max - 1) + '…' : str || '';
  }

  update() {
    // no periodic update needed
  }

  /** Show or hide the chart manager (toggle button + panel). */
  setVisible(visible) {
    if (this.toggleBtn) this.toggleBtn.style.display = visible ? '' : 'none';
    if (!visible && this.panel) this.panel.style.display = 'none';
  }

  destroy() {
    window.removeEventListener('mousemove', this._mouseMoveHandler);
    window.removeEventListener('mouseup', this._mouseUpHandler);
    this.toggleBtn.remove();
    this.panel.remove();
  }
}
