/**
 * TimeSeriesRenderer.js — GPU-rendered time-series line chart.
 *
 * Takes a Float32Array of per-epoch values, builds pre-computed pixel-space
 * quads on the CPU, and renders thick lines via WebGPU quadPipeline.
 */

export class TimeSeriesRenderer {
  /**
   * @param {import('./ChartGPU.js').ChartGPU} chartGPU
   * @param {Object} [style]
   */
  constructor(chartGPU, style = {}) {
    this.chartGPU = chartGPU;
    this.vertexCount = 0;

    // Style — scale line width by DPR for Retina
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.lineColor = this._parseColor(style.lineColor || '#00E5FF');
    this.lineWidth = (style.lineWidth || 2.0) * dpr;

    this.dataRange = [0, 1];
    this.timeRange = [0, 1];

    this._vertsCapacity = 0;
    this._verts = null;
    this._vbo = null;
    this._gpuCapacity = 0;
  }

  /**
   * Upload time-series data — pre-compute pixel-space quads.
   * @param {Float32Array} values - One value per epoch
   * @param {number[]} dataRange - [min, max]
   * @param {number[]} [timeRange=[0, 1]]
   * @param {{ x, y, w, h }} plotArea - pixel-space plot area
   */
  setData(values, dataRange, timeRange = [0, 1], plotArea) {
    this.dataRange = dataRange;
    this.timeRange = timeRange;

    if (!values || values.length < 2 || !plotArea) {
      this.vertexCount = 0;
      return;
    }

    const epochCount = values.length;
    const segCount = epochCount - 1;
    const halfW = this.lineWidth * 0.5;
    // 6 verts per segment (2 triangles), 6 floats per vert [x,y, r,g,b,a]
    const neededFloats = segCount * 6 * 6;

    if (!this._verts || this._vertsCapacity < neededFloats) {
      this._verts = new Float32Array(neededFloats);
      this._vertsCapacity = neededFloats;
    }

    const verts = this._verts;
    let vi = 0;
    const c = this.lineColor;

    for (let i = 0; i < segCount; i++) {
      const tA = i / (epochCount - 1);
      const tB = (i + 1) / (epochCount - 1);
      const vA = values[i],
        vB = values[i + 1];

      if (isNaN(vA) || isNaN(vB)) continue;

      // Normalize values
      const range = dataRange[1] - dataRange[0] || 1;
      const nA = (vA - dataRange[0]) / range;
      const nB = (vB - dataRange[0]) / range;

      // Data → pixel
      const pxA = plotArea.x + tA * plotArea.w;
      const pyA = plotArea.y + nA * plotArea.h;
      const pxB = plotArea.x + tB * plotArea.w;
      const pyB = plotArea.y + nB * plotArea.h;

      // Line direction + normal
      const dx = pxB - pxA,
        dy = pyB - pyA;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = (-dy / len) * halfW;
      const ny = (dx / len) * halfW;

      // Triangle 1: A+n, A-n, B+n
      verts[vi++] = pxA + nx;
      verts[vi++] = pyA + ny;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
      verts[vi++] = pxA - nx;
      verts[vi++] = pyA - ny;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
      verts[vi++] = pxB + nx;
      verts[vi++] = pyB + ny;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];

      // Triangle 2: B+n, A-n, B-n
      verts[vi++] = pxB + nx;
      verts[vi++] = pyB + ny;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
      verts[vi++] = pxA - nx;
      verts[vi++] = pyA - ny;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
      verts[vi++] = pxB - nx;
      verts[vi++] = pyB - ny;
      verts[vi++] = c[0];
      verts[vi++] = c[1];
      verts[vi++] = c[2];
      verts[vi++] = c[3];
    }

    this.vertexCount = Math.floor(vi / 6);

    // Ensure GPU buffer is large enough
    const neededBytes = vi * 4;
    if (!this._vbo || this._gpuCapacity < neededBytes) {
      this._vbo?.destroy();
      this._vbo = this.chartGPU.createBuffer('TimeSeries lines', Math.max(neededBytes, 4096));
      this._gpuCapacity = Math.max(neededBytes, 4096);
    }
    this.chartGPU.device.queue.writeBuffer(this._vbo, 0, verts, 0, vi);
  }

  /**
   * Render the line chart using the shared quad pipeline.
   */
  draw(pass) {
    if (this.vertexCount === 0 || !this._vbo) return;
    pass.setPipeline(this.chartGPU.quadPipeline);
    pass.setBindGroup(0, this.chartGPU._resolutionBG);
    pass.setVertexBuffer(0, this._vbo);
    pass.draw(this.vertexCount);
  }

  _parseColor(str) {
    if (str.startsWith('#')) {
      const hex = str.slice(1);
      return [
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
        1.0,
      ];
    }
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(',').map(Number);
      return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1.0];
    }
    return [0.0, 0.9, 1.0, 1.0];
  }

  dispose() {
    this._vbo?.destroy();
  }
}
