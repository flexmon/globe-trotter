/**
 * HeatmapRenderer.js — WebGPU-rendered heatmap chart.
 *
 * X-axis = time of day (columns), Y-axis = data bins (rows).
 * Each cell is colored by count intensity using the layer's color ramp.
 * A vertical "now" indicator line tracks the current time.
 */

/** Parse hex "#RRGGBB" to [r, g, b, a] */
function hexToRGBA(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
    1.0,
  ];
}

/** Default intensity ramp (black → blue → cyan → green → yellow → red) */
const DEFAULT_RAMP = [
  [0.0, 0.0, 0.0, 1.0], // zero → black (no cells)
  [0.05, 0.1, 0.5, 1.0], // low
  [0.05, 0.45, 0.75, 1.0],
  [0.1, 0.75, 0.35, 1.0],
  [0.85, 0.85, 0.1, 1.0],
  [0.95, 0.2, 0.1, 1.0], // high
];

export class HeatmapRenderer {
  /**
   * @param {import('./ChartGPU.js').ChartGPU} chartGPU
   * @param {Object} [style]
   */
  constructor(chartGPU, style = {}) {
    this.chartGPU = chartGPU;
    this.vertexCount = 0;

    // Config
    this.timeBins = style.timeBins || 48; // columns (30-min intervals)
    this.valueBins = style.valueBins || style.binCount || 12; // rows
    this.domain = style.domain || [0, 60];
    this.colorRamp = DEFAULT_RAMP;
    this.maxCount = 1;

    // WebGPU buffers (reused across updates)
    this._vertsCapacity = 0;
    this._verts = null;
    this._vbo = null;
    this._gpuCapacity = 0;

    // Pre-allocated now-indicator buffer (6 vertices * 6 floats)
    this._nowVerts = new Float32Array(36);
    this._nowVbo = null;
  }

  /**
   * Set color ramp from hex stops. Accepts either `string[]` of hex colors
   * or `{value, color}[]` from a layer style (only colors are used here).
   */
  setColorRamp(stops) {
    if (!stops || stops.length < 2) return;
    const first = stops[0];
    const colors = typeof first === 'string' ? stops : stops.map((s) => s.color);
    this.colorRamp = colors.map((h) => hexToRGBA(h));
  }

  /**
   * Build the full heatmap from a 2D grid.
   *
   * @param {number[][]} grid — [timeBin][valueBin] = count
   * @param {{ x, y, w, h }} plotArea
   */
  setData(grid, plotArea) {
    if (!grid || !plotArea) {
      this.vertexCount = 0;
      return;
    }

    const tBins = grid.length;
    const vBins = grid[0].length;

    // Find max count for opacity scaling
    let maxC = 0;
    for (let t = 0; t < tBins; t++) {
      for (let v = 0; v < vBins; v++) {
        if (grid[t][v] > maxC) maxC = grid[t][v];
      }
    }
    this.maxCount = maxC || 1;

    const cellW = plotArea.w / tBins;
    const cellH = plotArea.h / vBins;

    const totalCells = tBins * vBins;
    const neededFloats = totalCells * 6 * 6; // 6 verts, 6 floats (x,y,r,g,b,a)

    if (!this._verts || this._vertsCapacity < neededFloats) {
      this._verts = new Float32Array(neededFloats);
      this._vertsCapacity = neededFloats;
    }

    const verts = this._verts;
    let vi = 0;

    for (let t = 0; t < tBins; t++) {
      for (let v = 0; v < vBins; v++) {
        const count = grid[t][v];

        // Color from VALUE (Y-axis bin position through the ramp)
        const valueT = (v + 0.5) / vBins; // 0 = low, 1 = high
        const rgb = this._sampleRamp(valueT);

        // Opacity from COUNT DENSITY (sqrt for perceptual spread)
        const density = count / this.maxCount;
        const alpha = count === 0 ? 0.0 : 0.15 + 0.8 * Math.sqrt(density);

        const x0 = plotArea.x + t * cellW;
        const x1 = x0 + cellW;
        const y0 = plotArea.y + v * cellH;
        const y1 = y0 + cellH;

        const r = rgb[0],
          g = rgb[1],
          b = rgb[2];

        // Triangle 1
        verts[vi++] = x0;
        verts[vi++] = y0;
        verts[vi++] = r;
        verts[vi++] = g;
        verts[vi++] = b;
        verts[vi++] = alpha;
        verts[vi++] = x1;
        verts[vi++] = y0;
        verts[vi++] = r;
        verts[vi++] = g;
        verts[vi++] = b;
        verts[vi++] = alpha;
        verts[vi++] = x0;
        verts[vi++] = y1;
        verts[vi++] = r;
        verts[vi++] = g;
        verts[vi++] = b;
        verts[vi++] = alpha;
        // Triangle 2
        verts[vi++] = x0;
        verts[vi++] = y1;
        verts[vi++] = r;
        verts[vi++] = g;
        verts[vi++] = b;
        verts[vi++] = alpha;
        verts[vi++] = x1;
        verts[vi++] = y0;
        verts[vi++] = r;
        verts[vi++] = g;
        verts[vi++] = b;
        verts[vi++] = alpha;
        verts[vi++] = x1;
        verts[vi++] = y1;
        verts[vi++] = r;
        verts[vi++] = g;
        verts[vi++] = b;
        verts[vi++] = alpha;
      }
    }

    this.vertexCount = totalCells * 6;

    // Ensure GPU buffer is large enough
    const neededBytes = vi * 4;
    if (!this._vbo || this._gpuCapacity < neededBytes) {
      this._vbo?.destroy();
      this._vbo = this.chartGPU.createBuffer('Heatmap cells', Math.max(neededBytes, 4096));
      this._gpuCapacity = Math.max(neededBytes, 4096);
    }
    this.chartGPU.device.queue.writeBuffer(this._vbo, 0, verts, 0, vi);
  }

  /**
   * Render heatmap cells + now indicator.
   */
  draw(pass) {
    if (this.vertexCount === 0 || !this._vbo) return;

    pass.setPipeline(this.chartGPU.quadPipeline);
    pass.setBindGroup(0, this.chartGPU._resolutionBG);

    // Draw heatmap cells
    pass.setVertexBuffer(0, this._vbo);
    pass.draw(this.vertexCount);

    // We don't implement the "now indicator" here anymore since
    // ChartManager.js already manages `NowIndicator.js` globally for all charts
    // except CDF and Histogram. But wait, Heatmap needs it?
    // Actually ChartManager.js handles it for time-series!
    // `if (chartType !== 'cdf' && chartType !== 'histogram' && chartType !== 'barplot') { chart.nowIndicator.draw(...) }`
    // So ChartManager will draw the NowIndicator for heatmap automatically!
  }

  /**
   * Sample color ramp at position t (0..1).
   * Returns [r, g, b] — alpha is set separately based on count density.
   */
  _sampleRamp(t) {
    const ramp = this.colorRamp;
    const n = ramp.length - 1;
    const idx = t * n;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, n);
    const f = idx - lo;

    return [
      ramp[lo][0] + (ramp[hi][0] - ramp[lo][0]) * f,
      ramp[lo][1] + (ramp[hi][1] - ramp[lo][1]) * f,
      ramp[lo][2] + (ramp[hi][2] - ramp[lo][2]) * f,
    ];
  }

  dispose() {
    this._vbo?.destroy();
    this._nowVbo?.destroy();
  }
}
