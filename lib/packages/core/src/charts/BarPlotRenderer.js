/**
 * BarPlotRenderer.js — WebGPU-rendered categorical bar chart.
 *
 * Renders colored vertical bars for each category via chartQuadPipeline.
 */

/** Curated color palette for categorical data */
const CATEGORY_COLORS = [
  [0.0, 0.65, 0.85, 1.0], // cyan
  [0.95, 0.55, 0.15, 1.0], // orange
  [0.35, 0.8, 0.4, 1.0], // green
  [0.9, 0.25, 0.3, 1.0], // red
  [0.55, 0.4, 0.9, 1.0], // purple
  [0.95, 0.8, 0.2, 1.0], // gold
  [0.2, 0.5, 0.9, 1.0], // blue
  [0.85, 0.35, 0.7, 1.0], // pink
  [0.45, 0.75, 0.8, 1.0], // teal
  [0.7, 0.55, 0.35, 1.0], // brown
];

export class BarPlotRenderer {
  constructor(chartGPU, style = {}) {
    this.chartGPU = chartGPU;
    this.vertexCount = 0;

    this.barGap = style.barGap || 0.15;
    this.barOpacity = style.barOpacity ?? 0.9;
    this.sortBars = style.sortBars !== false;

    this.categories = [];
    this.values = [];
    this.maxValue = 1;

    this._vertsCapacity = 0;
    this._verts = null;
    this._vbo = null;
    this._gpuCapacity = 0;
  }

  setData(barData, plotArea) {
    if (!barData || !barData.categories || barData.categories.length === 0 || !plotArea) {
      this.vertexCount = 0;
      this.categories = [];
      this.values = [];
      return;
    }

    const { categories, values, dataRange } = barData;
    const n = categories.length;

    const indices = Array.from({ length: n }, (_, i) => i);
    if (this.sortBars) {
      indices.sort((a, b) => values[b] - values[a]);
    }

    this.categories = indices.map((i) => categories[i]);
    this.values = indices.map((i) => values[i]);

    this.maxValue = Math.max(...this.values) || 1;
    if (dataRange && dataRange[1] > 0) {
      this.maxValue = Math.max(this.maxValue, dataRange[1]);
    }

    const barFullWidth = plotArea.w / n;
    const gap = barFullWidth * this.barGap;
    const barWidth = barFullWidth - gap;

    const neededFloats = n * 6 * 6;
    if (!this._verts || this._vertsCapacity < neededFloats) {
      this._verts = new Float32Array(neededFloats);
      this._vertsCapacity = neededFloats;
    }
    const verts = this._verts;
    let vi = 0;

    for (let i = 0; i < n; i++) {
      const val = this.values[i];
      const barH = (val / this.maxValue) * plotArea.h;
      const x0 = plotArea.x + i * barFullWidth + gap * 0.5;
      const x1 = x0 + barWidth;
      const y0 = plotArea.y;
      const y1 = y0 + Math.max(barH, 1);

      const cc = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
      const c = [cc[0], cc[1], cc[2], cc[3] * this.barOpacity];

      verts[vi++] = x0;
      verts[vi++] = y0;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
      verts[vi++] = x1;
      verts[vi++] = y0;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
      verts[vi++] = x0;
      verts[vi++] = y1;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
      verts[vi++] = x0;
      verts[vi++] = y1;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
      verts[vi++] = x1;
      verts[vi++] = y0;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
      verts[vi++] = x1;
      verts[vi++] = y1;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
    }

    this.vertexCount = n * 6;
    const neededBytes = vi * 4;
    if (!this._vbo || this._gpuCapacity < neededBytes) {
      this._vbo?.destroy();
      this._vbo = this.chartGPU.createBuffer('Barplot', Math.max(neededBytes, 4096));
      this._gpuCapacity = Math.max(neededBytes, 4096);
    }
    this.chartGPU.device.queue.writeBuffer(this._vbo, 0, verts, 0, vi);
  }

  draw(pass) {
    if (this.vertexCount === 0 || !this._vbo) return;
    pass.setPipeline(this.chartGPU.quadPipeline);
    pass.setBindGroup(0, this.chartGPU._resolutionBG);
    pass.setVertexBuffer(0, this._vbo);
    pass.draw(this.vertexCount);
  }

  dispose() {
    this._vbo?.destroy();
  }
}
