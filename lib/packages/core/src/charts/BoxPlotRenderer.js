/**
 * BoxPlotRenderer.js — WebGPU-rendered box plot.
 *
 * Renders whiskers, boxes, median lines, and caps via chartQuadPipeline.
 * Colors follow the layer's color ramp based on the median value.
 */

function hexToRGBA(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
    1.0,
  ];
}

const DEFAULT_RAMP = [
  [0.05, 0.2, 0.55, 1.0],
  [0.05, 0.45, 0.75, 1.0],
  [0.1, 0.75, 0.35, 1.0],
  [0.85, 0.85, 0.1, 1.0],
  [0.95, 0.2, 0.1, 1.0],
];

export class BoxPlotRenderer {
  constructor(chartGPU, style = {}) {
    this.chartGPU = chartGPU;
    this.vertexCount = 0;
    this.colorRamp = DEFAULT_RAMP;
    this.domain = style.domain || [0, 60];
    this._vbo = null;
    this._gpuCapacity = 0;
  }

  setColorRamp(hexStops) {
    if (hexStops && hexStops.length >= 2) {
      this.colorRamp = hexStops.map((h) => hexToRGBA(h));
    }
  }

  setData(stats, dataRange, plotArea) {
    if (!stats || stats.length === 0 || !plotArea) {
      this.vertexCount = 0;
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const n = stats.length;
    const binW = plotArea.w / n;
    const yMin = dataRange[0];
    const yRange = dataRange[1] - dataRange[0] || 1;
    const toY = (val) => plotArea.y + ((val - yMin) / yRange) * plotArea.h;
    const domainRange = this.domain[1] - this.domain[0] || 1;
    const toRampT = (val) => Math.max(0, Math.min(1, (val - this.domain[0]) / domainRange));

    // 6 quads per box = 36 verts, 6 floats each
    const verts = new Float32Array(n * 36 * 6);
    let vi = 0;

    const pushQuad = (x0, y0, x1, y1, r, g, b, a) => {
      verts[vi++] = x0;
      verts[vi++] = y0;
      verts[vi++] = r;
      verts[vi++] = g;
      verts[vi++] = b;
      verts[vi++] = a;
      verts[vi++] = x1;
      verts[vi++] = y0;
      verts[vi++] = r;
      verts[vi++] = g;
      verts[vi++] = b;
      verts[vi++] = a;
      verts[vi++] = x0;
      verts[vi++] = y1;
      verts[vi++] = r;
      verts[vi++] = g;
      verts[vi++] = b;
      verts[vi++] = a;
      verts[vi++] = x0;
      verts[vi++] = y1;
      verts[vi++] = r;
      verts[vi++] = g;
      verts[vi++] = b;
      verts[vi++] = a;
      verts[vi++] = x1;
      verts[vi++] = y0;
      verts[vi++] = r;
      verts[vi++] = g;
      verts[vi++] = b;
      verts[vi++] = a;
      verts[vi++] = x1;
      verts[vi++] = y1;
      verts[vi++] = r;
      verts[vi++] = g;
      verts[vi++] = b;
      verts[vi++] = a;
    };

    for (let i = 0; i < n; i++) {
      const s = stats[i];
      if (s.count === 0 || s.median == null || !isFinite(s.median)) continue;

      const cx = plotArea.x + (i + 0.5) * binW;
      const boxHalfW = binW * 0.32;
      const whiskerHalfW = binW * 0.12;
      const lineThick = 1.5 * dpr;

      const yLow = toY(s.whiskerLow ?? s.min ?? s.p5);
      const yQ1 = toY(s.q1);
      const yMed = toY(s.median);
      const yQ3 = toY(s.q3);
      const yHigh = toY(s.whiskerHigh ?? s.max ?? s.p95);

      const t = toRampT(s.median);
      const bc = this._sampleRamp(t, 0.5);
      const lc = this._sampleRamp(t, 0.9);

      pushQuad(cx - lineThick * 0.5, yLow, cx + lineThick * 0.5, yQ1, 1, 1, 1, 0.3);
      pushQuad(cx - lineThick * 0.5, yQ3, cx + lineThick * 0.5, yHigh, 1, 1, 1, 0.3);
      pushQuad(cx - whiskerHalfW, yLow, cx + whiskerHalfW, yLow + lineThick, 1, 1, 1, 0.3);
      pushQuad(cx - whiskerHalfW, yHigh - lineThick, cx + whiskerHalfW, yHigh, 1, 1, 1, 0.3);
      pushQuad(cx - boxHalfW, yQ1, cx + boxHalfW, yQ3, bc[0], bc[1], bc[2], bc[3]);
      pushQuad(
        cx - boxHalfW,
        yMed - lineThick * 0.5,
        cx + boxHalfW,
        yMed + lineThick * 0.5,
        1,
        1,
        1,
        0.95
      );
    }

    this.vertexCount = vi / 6;
    const neededBytes = vi * 4;
    if (!this._vbo || this._gpuCapacity < neededBytes) {
      this._vbo?.destroy();
      this._vbo = this.chartGPU.createBuffer('Boxplot', Math.max(neededBytes, 4096));
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

  _sampleRamp(t, alpha) {
    const ramp = this.colorRamp;
    if (!ramp || ramp.length === 0) return [0.5, 0.5, 0.5, alpha];
    if (!isFinite(t)) t = 0;
    t = Math.max(0, Math.min(1, t));
    const n = ramp.length - 1;
    const idx = t * n;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, n);
    const f = idx - lo;
    return [
      ramp[lo][0] + (ramp[hi][0] - ramp[lo][0]) * f,
      ramp[lo][1] + (ramp[hi][1] - ramp[lo][1]) * f,
      ramp[lo][2] + (ramp[hi][2] - ramp[lo][2]) * f,
      alpha,
    ];
  }

  dispose() {
    this._vbo?.destroy();
  }
}
