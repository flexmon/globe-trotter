/**
 * ChartManager.js — Orchestrates all WebGPU chart panels.
 *
 * Creates and manages ChartPanel instances, coordinates their rendering
 * in a second render pass (after the globe) on the same WebGPU canvas.
 * Drag is handled by ChartOverlay (DOM title bar).
 */

import { ChartPanel } from './ChartPanel.js';
import { HistogramRenderer } from './HistogramRenderer.js';
import { CDFRenderer } from './CDFRenderer.js';
import { BoxPlotRenderer } from './BoxPlotRenderer.js';
import { BarPlotRenderer } from './BarPlotRenderer.js';
import { ChartLabelRenderer } from './ChartLabelRenderer.js';
import { TimeSeriesRenderer } from './TimeSeriesRenderer.js';
import { HeatmapRenderer } from './HeatmapRenderer.js';
import { AxisRenderer } from './AxisRenderer.js';
import { NowIndicator } from './NowIndicator.js';
import { ChartDataAdapter } from './ChartDataAdapter.js';
import { ChartOverlay } from './ChartOverlay.js';

export class ChartManager {
  /**
   * @param {import('./ChartGPU.js').ChartGPU} chartGPU
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   */
  constructor(chartGPU, engine) {
    this.chartGPU = chartGPU;
    this.engine = engine;
    this.charts = [];
    this.dataAdapter = new ChartDataAdapter(engine.layerManager);
    this._lastEpochMinute = -1;
    this._rampApplied = false;
    this._labelScratch = []; // reusable label array (zero per-frame alloc)
    this._warnedDomains = {}; // suppress repeated console.warn per chart

    // Render-loop dirty flag — set whenever chart state changes and a new
    // GPU frame must be submitted.  Cleared by the chart loop after render.
    this.dirty = true; // always render the first frame
  }

  /**
   * Signal that the chart loop must submit a GPU frame.
   * Call whenever chart structure, data, or appearance changes.
   */
  markDirty() {
    this.dirty = true;
  }

  // ──────────────────────────────────────────────
  // Chart management
  // ──────────────────────────────────────────────

  addChart(config) {
    const chartGPU = this.chartGPU;

    let nowIndicator = null;
    if (
      config.style?.nowIndicator !== false &&
      config.type !== 'histogram' &&
      config.type !== 'barplot'
    ) {
      try {
        nowIndicator = new NowIndicator(chartGPU);
      } catch (e) {
        console.error('[ChartManager] NowIndicator failed:', e.message);
      }
    }

    const panel = new ChartPanel(chartGPU, config);
    const chart = {
      config: { ...config },
      panel,
      dataRenderer: null,
      axes: new AxisRenderer(chartGPU),
      nowIndicator,
      overlay: null,
      dataLoaded: false,
      isLive: false,
    };

    // Create overlay with callbacks for drag and minimize
    chart.overlay = new ChartOverlay(
      this.engine.canvas,
      panel,
      config,
      // onDrag — force a re-render at the new position
      () => {
        chart.dataLoaded = false;
        this.markDirty();
      },
      // onMinimize — show/hide the chart panel
      (isMinimized) => {
        chart._minimized = isMinimized;
        this.markDirty();
      }
    );

    // Wire scale dropdown to resize the chart panel
    const baseW = panel._cssWidth;
    const baseH = panel._cssHeight;
    const basePad = { ...panel._cssPadding };
    chart.overlay.onScale = (factor) => {
      panel._cssWidth = Math.round(baseW * factor);
      panel._cssHeight = Math.round(baseH * factor);
      panel._cssPadding = {
        top: Math.round(basePad.top * factor),
        right: Math.round(basePad.right * factor),
        bottom: Math.round(basePad.bottom * factor),
        left: Math.round(basePad.left * factor),
      };
      chart.dataLoaded = false; // force re-render at new size
      chart._lastPlotArea = null; // force grid rebuild
      this._computeStackOffsets();
      this.markDirty();
    };

    // Apply saved scale on creation
    const savedFactor = chart.overlay._scaleFactor;
    if (savedFactor > 1.0) {
      panel._cssWidth = Math.round(baseW * savedFactor);
      panel._cssHeight = Math.round(baseH * savedFactor);
      panel._cssPadding = {
        top: Math.round(basePad.top * savedFactor),
        right: Math.round(basePad.right * savedFactor),
        bottom: Math.round(basePad.bottom * savedFactor),
        left: Math.round(basePad.left * savedFactor),
      };
    }

    this._createRenderer(chart, config.type);

    this.charts.push(chart);

    // Honor initial visibility from config (default: true)
    if (config.visible === false) {
      chart.panel.visible = false;
      if (chart.overlay) chart.overlay.setVisible(false);
    }

    console.debug(`[ChartManager] Added chart "${config.name}" (${config.type})`);
    this._computeStackOffsets();
    this.markDirty();
    return chart;
  }

  removeChart(name) {
    const idx = this.charts.findIndex((c) => c.config.name === name);
    if (idx < 0) return;
    const chart = this.charts[idx];
    chart.panel.dispose();
    if (chart.dataRenderer) chart.dataRenderer.dispose();
    if (chart.labelRenderer) chart.labelRenderer.dispose();
    chart.axes.dispose();
    if (chart.nowIndicator) chart.nowIndicator.dispose();
    chart.overlay.dispose();
    this.charts.splice(idx, 1);
    this._computeStackOffsets();
    this.markDirty();
  }

  loadFromConfig(chartConfigs) {
    if (!chartConfigs || !Array.isArray(chartConfigs)) return;
    for (const config of chartConfigs) {
      this.addChart(config);
    }
    // Recompute after all charts are added (addChart calls it individually,
    // but a final pass ensures correct cumulative offsets)
    this._computeStackOffsets();
  }

  /**
   * Compute vertical stack offsets for charts sharing the same anchor position.
   * Charts are stacked in config order — first chart at the anchor base,
   * each subsequent chart offset by the cumulative height + gap of predecessors.
   */
  _computeStackOffsets() {
    const groups = new Map(); // position → cumulative CSS offset
    for (const chart of this.charts) {
      const pos = chart.panel.position;
      const offset = groups.get(pos) || 0;
      chart.panel._stackOffset = offset;
      // Accumulate: panel CSS height + gap
      groups.set(pos, offset + chart.panel._cssHeight + chart.panel._cssStackGap);
    }
  }

  /**
   * Create a renderer for the given chart type.
   */
  _createRenderer(chart, type) {
    const chartGPU = this.chartGPU;
    const style = chart.config.style || {};

    switch (type) {
      case 'histogram':
        chart.dataRenderer = new HistogramRenderer(chartGPU, style);
        chart.isLive = true;
        if (style.showBarLabels !== false) {
          chart.labelRenderer = new ChartLabelRenderer(chartGPU, style);
        }
        break;
      case 'cdf':
        chart.dataRenderer = new CDFRenderer(chartGPU, style);
        chart.isLive = true;
        break;
      case 'boxplot':
        chart.dataRenderer = new BoxPlotRenderer(chartGPU, style);
        chart.isLive = true;
        break;
      case 'barplot':
        chart.dataRenderer = new BarPlotRenderer(chartGPU, style);
        chart.isLive = true;
        if (style.showBarLabels !== false) {
          chart.labelRenderer = new ChartLabelRenderer(chartGPU, style);
        }
        break;
      case 'time-series':
        chart.dataRenderer = new TimeSeriesRenderer(chartGPU, style);
        chart.isLive = true;
        break;
      case 'heatmap':
        chart.dataRenderer = new HeatmapRenderer(chartGPU, style);
        chart.isLive = true;
        break;
      default:
        console.warn(`[ChartManager] Unknown chart type "${type}", skipping`);
        chart.isLive = false;
        return;
    }

    chart.config.type = type;
    chart.dataLoaded = false;
  }

  /**
   * Hot-swap chart type at runtime (called from overlay dropdown).
   */
  _switchChartType(chart, newType) {
    if (chart.config.type === newType) return;

    // Dispose old renderer + label renderer
    if (chart.dataRenderer) {
      chart.dataRenderer.dispose();
      chart.dataRenderer = null;
    }
    if (chart.labelRenderer) {
      chart.labelRenderer.dispose();
      chart.labelRenderer = null;
    }

    // Create new renderer
    this._createRenderer(chart, newType);

    // Re-apply color ramp
    this._rampApplied = false;
    this.markDirty();

    // Update labels based on new type
    const style = chart.config.style || {};
    if (newType === 'heatmap') {
      chart.overlay.setLabels(style.xLabel || 'Time of Day (UTC)', style.yLabel || 'Value');
    } else if (newType === 'histogram') {
      chart.overlay.setLabels(style.xLabel || chart.overlay._autoXLabel(), style.yLabel || 'Count');
    } else if (newType === 'cdf') {
      chart.overlay.setLabels(
        style.xLabel || chart.overlay._autoXLabel(),
        style.yLabel || 'Probability (0→1)'
      );
    } else {
      chart.overlay.setLabels(
        style.xLabel || chart.overlay._autoXLabel(),
        style.yLabel || chart.overlay._autoYLabel()
      );
    }

    console.debug(`[ChartManager] Switched "${chart.config.name}" to ${newType}`);
  }

  // ──────────────────────────────────────────────
  // Rendering
  // ──────────────────────────────────────────────

  /**
   * Render all charts into the given render pass.
   * Called by GlobeTrotterEngine after the globe render pass.
   *
   * @param {GPURenderPassEncoder} pass
   * @param {number} normalizedTime
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   */
  render(normalizedTime, canvasWidth, canvasHeight) {
    if (this.charts.length === 0) return;

    // One-time: apply layer ramp colors to chart renderers
    if (!this._rampApplied) {
      this._applyLayerRamps();
    }

    // Update shared resolution uniform
    this.chartGPU.updateResolution(canvasWidth, canvasHeight);

    // Own command encoder + render pass (independent of globe)
    const pass = this.chartGPU.beginFrame();

    for (const chart of this.charts) {
      if (!chart.panel.visible) continue;

      if (chart._minimized) {
        chart.overlay.updatePosition();
        continue;
      }

      const plotArea = chart.panel.getPlotArea(canvasWidth, canvasHeight);

      // Re-build grid if panel position changed
      const prev = chart._lastPlotArea;
      if (
        !prev ||
        prev.x !== plotArea.x ||
        prev.y !== plotArea.y ||
        prev.w !== plotArea.w ||
        prev.h !== plotArea.h
      ) {
        const dataRange = chart._lastDataRange || [0, 60];
        const startHour = chart._lastStartHour || 0;
        chart.axes.buildGrid(plotArea, dataRange, startHour);
        chart._lastPlotArea = { ...plotArea };
      }

      // Update background vertex data
      chart.panel.updateBackground(canvasWidth, canvasHeight);

      // Draw: background → grid → data → labels → now indicator
      chart.panel.draw(pass);
      chart.axes.draw(pass);

      if (chart.dataRenderer) {
        chart.dataRenderer.draw(pass);
      }

      if (chart.labelRenderer && chart._labelsVisible !== false) {
        chart.labelRenderer.draw(pass);
      }

      if (chart.nowIndicator) {
        const chartType = chart.config.type;
        if (chartType !== 'cdf' && chartType !== 'histogram' && chartType !== 'barplot') {
          chart.nowIndicator.draw(pass, plotArea, normalizedTime);
        }
      }

      chart.overlay.updatePosition();
    }

    // Submit chart command buffer (independent of globe)
    this.chartGPU.endFrame();
  }

  /**
   * Synchronous epoch-change handler for the WebGL2 render path.
   *
   * The WebGPU path spreads chart updates across frames via queueEpochUpdate()
   * + drainOneUpdate() to stay within the per-frame budget of the independent
   * chart loop.  The WebGL2 path does not have an independent chart loop —
   * onEpochChange is called once per epoch boundary inside the main render
   * loop, immediately before render().  We therefore update ALL visible charts
   * in one shot (no spreading).
   *
   * Charts are WebGPU-only (ChartGPU uses GPUDevice + WGSL); the engine is
   * WebGPU-only (D5), so charts are always available.
   *
   * @param {number} normalizedTime  0→1 within the loaded time range
   * @param {number} canvasWidth     canvas pixel width
   * @param {number} canvasHeight    canvas pixel height
   */
  onEpochChange(normalizedTime, canvasWidth, canvasHeight) {
    // Skip during shard transitions — charts keep rendering cached data
    if (this.engine.layerManager?._shardTransitionFrame) return;

    for (const chart of this.charts) {
      if (!chart.panel.visible || chart._minimized) continue;
      if (!chart.isLive && chart.dataLoaded) continue;
      this._loadChartData(chart, normalizedTime, canvasWidth, canvasHeight);
      chart.dataLoaded = true;
    }

    this.markDirty();
  }

  /**
   * Queue chart data updates for the given epoch.
   * Called by the chart loop when the epoch-minute boundary is crossed.
   * Does NOT process immediately — charts are updated one-per-frame
   * via drainOneUpdate() to stay within the frame budget.
   */
  queueEpochUpdate(normalizedTime, canvasWidth, canvasHeight) {
    // Skip during shard transitions — charts keep rendering cached data
    if (this.engine.layerManager?._shardTransitionFrame) return;

    this._updateQueue = [];
    this._updateTime = normalizedTime;
    this._updateW = canvasWidth;
    this._updateH = canvasHeight;

    for (const chart of this.charts) {
      if (!chart.panel.visible || chart._minimized) continue;
      if (!chart.isLive && chart.dataLoaded) continue;
      this._updateQueue.push(chart);
    }
  }

  /**
   * Process ONE chart from the update queue.
   * Called once per chart-loop frame → spreads CPU work across frames.
   * Returns true if work was done (queue had items).
   */
  drainOneUpdate() {
    if (!this._updateQueue || this._updateQueue.length === 0) return false;
    const chart = this._updateQueue.shift();
    this._loadChartData(chart, this._updateTime, this._updateW, this._updateH);
    chart.dataLoaded = true;
    this.markDirty(); // new data was loaded — must render this frame
    return true;
  }

  _applyLayerRamps() {
    const layerInfo = this.engine.layerManager.getLayerInfo();

    for (const chart of this.charts) {
      if (!chart.dataRenderer?.setColorRamp) continue;
      if (
        chart.config.type !== 'histogram' &&
        chart.config.type !== 'heatmap' &&
        chart.config.type !== 'cdf'
      )
        continue;

      // If the chart explicitly defines a custom color ramp, prioritize it
      if (chart.config.style?.colorRamp) {
        chart.dataRenderer.setColorRamp(chart.config.style.colorRamp);
        continue;
      }

      // Otherwise, pull default color ramp from the specific metric on the layer
      const source = chart.config.source;
      const attr = chart.config.attribute;
      const layerObj = this.engine.layerManager?.layers?.get(source);

      // Forward the full {value, color} stops so the histogram can map
      // bin value → color the same way the globe does. Falls back to
      // bare hex colors if only those are available.
      let rampStops;
      if (layerObj?.metricsMap && attr && layerObj.metricsMap[attr]?.style?.stops) {
        rampStops = layerObj.metricsMap[attr].style.stops;
      } else {
        const info = this.engine.layerManager.getLayerInfo().find((l) => l.name === source);
        if (info?.stops) rampStops = info.stops;
      }

      if (rampStops) {
        chart.dataRenderer.setColorRamp(rampStops);
        console.debug(
          `[ChartManager] Applied ${rampStops.length} ramp stops from "${source}" (attr: ${attr || 'active'})`
        );
        this._rampApplied = true;
        this.markDirty();
      }
    }
  }

  _buildGrid(chart, plotArea, dataRange, startHour) {
    chart._lastDataRange = dataRange;
    chart._lastStartHour = startHour;
    chart._lastPlotArea = { ...plotArea };
    chart.axes.buildGrid(plotArea, dataRange, startHour);
  }

  _loadChartData(chart, normalizedTime, canvasWidth, canvasHeight) {
    const { config } = chart;
    const source = config.source;
    const plotArea = chart.panel.getPlotArea(canvasWidth, canvasHeight);
    const startHour = this.engine.time?.startHourUTC || 0;

    if (config.type === 'histogram') {
      const domain = config.style?.domain;
      if (!domain && !this._warnedDomains[config.name]) {
        console.warn(
          `[ChartManager] histogram "${config.name}" missing style.domain — using auto range`
        );
        this._warnedDomains[config.name] = true;
      }
      const binCount = config.style?.binCount || 12;
      const includeZeros = config.style?.includeZeros ?? false;
      const result = this.dataAdapter.getHistogram(
        source,
        binCount,
        domain || [0, 100],
        normalizedTime,
        config.attribute,
        includeZeros
      );
      if (!result) return;

      const { counts, effectiveDomain } = result;
      chart.dataRenderer.setData(counts, plotArea, effectiveDomain);

      let maxCount = 0;
      for (let i = 0; i < counts.length; i++) if (counts[i] > maxCount) maxCount = counts[i];
      this._buildGrid(chart, plotArea, [0, maxCount * 1.2], startHour);
      chart.overlay.updateYTicks(Math.round(maxCount * 1.2));
      chart.overlay.updateXTicks(effectiveDomain, binCount);

      // GPU bar labels for histogram bins (reuse scratch array)
      if (chart.labelRenderer && counts.length > 0) {
        const binW = plotArea.w / counts.length;
        const yScale = config.style?.yScale || 'log';
        const logMax = Math.log10(maxCount + 1) || 1;
        const linMax = maxCount * 1.2 || 1;
        const labels = this._labelScratch;
        labels.length = 0;
        for (let b = 0; b < counts.length; b++) {
          if (counts[b] === 0) continue;
          const cx = plotArea.x + (b + 0.5) * binW;
          let barH;
          if (yScale === 'log') {
            const logVal = Math.log10(counts[b] + 1);
            barH = (logVal / logMax) * plotArea.h;
          } else {
            barH = (counts[b] / linMax) * plotArea.h;
          }
          const topY = plotArea.y + Math.max(barH, 1);
          labels.push({
            text: chart.labelRenderer.formatValue(counts[b]),
            cx,
            topY,
            baseY: plotArea.y,
          });
        }
        chart.labelRenderer.setLabels(labels);
      }
    } else if (config.type === 'heatmap') {
      const domain = config.style?.domain;
      if (!domain) {
        console.warn(
          `[ChartManager] heatmap "${config.name}" missing style.domain — using auto range`
        );
      }
      const timeBins = config.style?.timeBins || 48;
      const valueBins = config.style?.valueBins || config.style?.binCount || 12;

      const hmResult = this.dataAdapter.getHeatmapGrid(
        source,
        timeBins,
        valueBins,
        domain || [0, 100]
      );
      if (!hmResult) return;

      chart.dataRenderer.setData(hmResult.grid, plotArea);

      // Y ticks = value bins, X ticks = actual shard time range
      this._buildGrid(chart, plotArea, domain, startHour);
      chart.overlay.updateYTicks(domain[1]);
      const hmDurationHours = (hmResult.shardEpochCount * hmResult.epochInterval) / 3600;
      const hmStartHour = startHour + (hmResult.shardEpochStart * hmResult.epochInterval) / 3600;
      chart.overlay.updateHeatmapXTicks(timeBins, hmStartHour, hmDurationHours);
    } else if (config.type === 'cdf') {
      const attribute = config.attribute || '';
      const sortedValues = this.dataAdapter.getCDFValues(
        source,
        [0, Infinity],
        normalizedTime,
        attribute
      );
      if (!sortedValues || sortedValues.length === 0) return;

      // Auto-scale domain to actual data range (with 10% headroom)
      const dataMax = sortedValues[sortedValues.length - 1];
      const domain = [0, Math.ceil(dataMax * 1.1)];
      chart.dataRenderer.domain = domain;
      chart.dataRenderer.setData(sortedValues, plotArea);

      // ─── Stats labels (μ, σ, median) — lightweight text update ───
      if (!chart._statsEl) {
        chart._statsEl = document.createElement('div');
        chart._statsEl.style.cssText = `
                    position: absolute; bottom: 48px; right: 12px;
                    font-family: 'Inter', 'Roboto Mono', monospace;
                    font-size: 10px; color: rgba(255,255,255,0.7);
                    line-height: 1.6; pointer-events: none; text-align: right;
                    text-shadow: 0 1px 3px rgba(0,0,0,0.8);
                `;
        chart.overlay.container.appendChild(chart._statsEl);
      }
      const μ = chart.dataRenderer.mean;
      const σ = chart.dataRenderer.stdDev;
      const med = chart.dataRenderer.median;
      const statsText = `μ = ${μ.toFixed(2)}  σ = ${σ.toFixed(2)}  med = ${med.toFixed(2)}`;
      if (chart._lastStatsText !== statsText) {
        chart._lastStatsText = statsText;
        chart._statsEl.innerHTML = `
                    <span style="color:#fff">μ = ${μ.toFixed(2)}</span>&nbsp;&nbsp;
                    <span style="color:rgba(255,255,255,0.5)">σ = ${σ.toFixed(2)}</span>&nbsp;&nbsp;
                    <span style="color:rgba(100,200,255,0.7)">med = ${med.toFixed(2)}</span>
                `;
      }

      // ─── Axes (only rebuild once, not every frame) ───
      if (!chart._axesBuilt) {
        this._buildGrid(chart, plotArea, [0, 1], startHour);

        // CDF: probability Y-ticks (0.00 to 1.00)
        chart.overlay.yTicksEl.innerHTML = '';
        const pad = chart.panel._cssPadding;
        const dpr = chart.panel.dpr;
        const r = chart.panel.getRect(canvasWidth, canvasHeight);
        const cssH = r.h / dpr;
        const plotTop = 28;
        const plotBot = cssH - pad.bottom;
        const plotH = plotBot - plotTop;

        for (const prob of [0.0, 0.25, 0.5, 0.75, 1.0]) {
          const yCSS = plotBot - prob * plotH;
          const el = document.createElement('div');
          el.style.cssText = `
                        position: absolute; left: 4px; top: ${yCSS - 5}px;
                        width: ${pad.left - 8}px; text-align: right;
                        font-size: 9px; color: rgba(255, 255, 255, 0.45);
                        pointer-events: none;
                    `;
          el.textContent = prob.toFixed(2);
          chart.overlay.yTicksEl.appendChild(el);
        }
        chart._axesBuilt = true;
      }

      chart.overlay.updateXTicks(domain, 6);
    } else if (config.type === 'boxplot') {
      const attribute = config.attribute || '';

      // Current-epoch-only boxplot: sort 26K values from current epoch.
      // This takes <0.5ms vs the old multi-epoch approach (2.5s).
      const { attrData, cellCount, epochCount, shardEpochStart, shardEpochCount } =
        this.dataAdapter._getTemporalData(this.dataAdapter._findLayer(source), attribute);
      if (!attrData) return;

      const globalEpoch = Math.floor(normalizedTime * (epochCount - 1));
      const localEpoch = Math.max(0, Math.min(globalEpoch - shardEpochStart, shardEpochCount - 1));
      const offset = localEpoch * cellCount;

      // Collect and sort non-zero values from current epoch
      if (!this._boxScratch || this._boxScratch.length < cellCount) {
        this._boxScratch = new Float32Array(cellCount);
      }
      let count = 0,
        sum = 0;
      for (let c = 0; c < cellCount; c++) {
        const val = attrData[offset + c];
        if (val === 0 || val !== val) continue;
        this._boxScratch[count] = val;
        sum += val;
        count++;
      }

      if (count > 0) {
        const values = this._boxScratch.subarray(0, count);
        values.sort(); // <0.5ms for 26K values

        const n = count;
        const pct = (p) => {
          const idx = (p / 100) * (n - 1);
          const lo = Math.floor(idx);
          const hi = Math.min(lo + 1, n - 1);
          return values[lo] + (values[hi] - values[lo]) * (idx - lo);
        };

        const s = {
          min: values[0],
          p5: pct(5),
          q1: pct(25),
          median: pct(50),
          q3: pct(75),
          p95: pct(95),
          max: values[n - 1],
          mean: sum / n,
          count: n,
          whiskerLow: pct(5),
          whiskerHigh: pct(95),
        };

        const dataRange = [0, s.p95 * 1.1];
        chart.dataRenderer.setData([s], dataRange, plotArea);
        this._buildGrid(chart, plotArea, dataRange, startHour);
        chart.overlay.updateYTicks(dataRange[1]);
        chart._lastPlotArea = { ...plotArea };

        // Stats text
        if (!chart._statsEl) {
          chart._statsEl = document.createElement('div');
          chart._statsEl.style.cssText = `
                        position: absolute; bottom: 48px; right: 12px;
                        font-family: 'Inter', 'Roboto Mono', monospace;
                        font-size: 10px; color: rgba(255,255,255,0.7);
                        line-height: 1.6; pointer-events: none; text-align: right;
                        text-shadow: 0 1px 3px rgba(0,0,0,0.8);
                    `;
          chart.overlay.container.appendChild(chart._statsEl);
        }
        const statsText = `${s.p5.toFixed(1)}|${s.mean.toFixed(1)}|${s.median.toFixed(1)}|${s.p95.toFixed(1)}`;
        if (chart._lastStatsText !== statsText) {
          chart._lastStatsText = statsText;
          chart._statsEl.innerHTML =
            `<span style="color:#88ccff">p5</span> = ${s.p5.toFixed(1)}` +
            `&nbsp;&nbsp;<span style="color:#ffffff">μ</span> = ${s.mean.toFixed(1)}` +
            `&nbsp;&nbsp;<span style="color:#ffcc44">med</span> = ${s.median.toFixed(1)}` +
            `&nbsp;&nbsp;<span style="color:#ff8866">p95</span> = ${s.p95.toFixed(1)}`;
        }
      }
    } else if (config.type === 'barplot') {
      const groupBy = config.groupBy;
      const attribute = config.attribute;
      if (!groupBy || !attribute) {
        console.warn(
          `[ChartManager] barplot "${config.name}" requires groupBy and attribute in config`
        );
        return;
      }
      const aggregation = config.aggregation || 'sum';
      const topN = config.topN || 0;
      const filterMode = config.style?.filterMode || 'aggregate';
      const timeWindow = config.style?.timeWindow || 1; // minutes to aggregate

      const barData = this.dataAdapter.getBarPlotData(
        source,
        groupBy,
        attribute,
        aggregation,
        normalizedTime,
        topN,
        filterMode,
        timeWindow
      );
      if (!barData) return;

      chart.dataRenderer.setData(barData, plotArea);

      // Axes: Y = value range, use buildGrid for gridlines
      this._buildGrid(chart, plotArea, barData.dataRange, startHour);
      chart.overlay.updateYTicks(barData.dataRange[1]);

      // Category labels on the X axis
      if (chart.dataRenderer.categories && chart.overlay.updateCategoryLabels) {
        chart.overlay.updateCategoryLabels(chart.dataRenderer.categories, plotArea);
      }

      // GPU bar labels for barplot values (reuse scratch array)
      if (chart.labelRenderer && barData.categories.length > 0) {
        const n = chart.dataRenderer.categories.length;
        const vals = chart.dataRenderer.values;
        const yMax = chart.dataRenderer.maxValue || 1;
        const barFullWidth = plotArea.w / n;
        const labelFormat = config.style?.labelFormat || 'currency';
        const labels = this._labelScratch;
        labels.length = 0;
        for (let i = 0; i < n; i++) {
          if (vals[i] === 0) continue;
          const cx = plotArea.x + (i + 0.5) * barFullWidth;
          const barH = (vals[i] / yMax) * plotArea.h;
          const topY = plotArea.y + Math.max(barH, 1);
          labels.push({
            text: chart.labelRenderer.formatValue(vals[i], labelFormat),
            cx,
            topY,
            baseY: plotArea.y,
          });
        }
        chart.labelRenderer.setLabels(labels);
      }
    } else {
      const attribute = config.attribute || '';
      const aggregation = config.aggregation || 'sum';
      const series = this.dataAdapter.getTimeSeries(source, attribute, aggregation);
      if (!series) return;

      const { values, dataRange } = series;
      chart.dataRenderer.setData(values, dataRange, [0, 1], plotArea);
      this._buildGrid(chart, plotArea, dataRange, startHour);
    }

    if (!chart.dataLoaded) {
      console.debug(`[ChartManager] Loaded "${config.name}" (${config.type})`);
    }
    chart.dataLoaded = true;
  }

  invalidateData() {
    for (const chart of this.charts) {
      chart.dataLoaded = false;
    }
  }

  setVisibility(name, visible) {
    const chart = this.charts.find((c) => c.config.name === name);
    if (chart) {
      chart.panel.visible = visible;
      if (chart.overlay) chart.overlay.setVisible(visible);
    }
  }

  /**
   * Toggle visibility of ALL charts at once.
   * @returns {boolean} New visibility state (true = visible)
   */
  toggleAllVisibility() {
    const anyVisible = this.charts.some((c) => c.panel.visible);
    const newState = !anyVisible;
    for (const chart of this.charts) {
      chart.panel.visible = newState;
      if (chart.overlay) chart.overlay.setVisible(newState);
    }
    return newState;
  }

  /** @returns {boolean} Whether any chart is currently visible */
  get chartsVisible() {
    return this.charts.some((c) => c.panel.visible);
  }

  dispose() {
    for (const chart of this.charts) {
      chart.panel.dispose();
      if (chart.dataRenderer) chart.dataRenderer.dispose();
      if (chart.labelRenderer) chart.labelRenderer.dispose();
      chart.axes.dispose();
      if (chart.nowIndicator) chart.nowIndicator.dispose();
      chart.overlay.dispose();
    }
    this.charts = [];
    this.dataAdapter.dispose();
  }
}
