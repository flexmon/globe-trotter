/**
 * CDFRenderer.js — WebGPU-rendered Cumulative Distribution Function chart.
 *
 * X-axis = data value, Y-axis = cumulative probability (0 → 1)
 * CDF line + mean/sigma annotation lines via chartQuadPipeline.
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

export class CDFRenderer {
  constructor(chartGPU, style = {}) {
    this.chartGPU = chartGPU;
    this.lineVertexCount = 0;
    this.annoVertexCount = 0;

    this.domain = style.domain || [0, 60];
    this.resolution = style.cdfResolution || 200;
    this.colorRamp = DEFAULT_RAMP;
    this.mean = 0;
    this.stdDev = 0;
    this.median = 0;
    this._statsContainer = null;

    const maxLineFloats = this.resolution * 6 * 6;
    this._lineVerts = new Float32Array(maxLineFloats);
    this._annoVerts = new Float32Array(108);
    this._rampOut = [0, 0, 0, 1];

    this._lineVbo = null;
    this._annoVbo = null;
    this._lineGpuCapacity = 0;
    this._annoGpuCapacity = 0;
  }

  setColorRamp(stops) {
    if (!stops || stops.length < 2) return;
    const first = stops[0];
    const colors = typeof first === 'string' ? stops : stops.map((s) => s.color);
    this.colorRamp = colors.map((h) => hexToRGBA(h));
  }

  setData(sortedValues, plotArea) {
    if (!sortedValues || sortedValues.length === 0 || !plotArea) {
      this.lineVertexCount = 0;
      this.annoVertexCount = 0;
      return;
    }

    const n = sortedValues.length;
    const domain = this.domain;
    const range = domain[1] - domain[0];
    const steps = this.resolution;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Compute statistics
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sortedValues[i];
    this.mean = sum / n;
    this.median =
      n % 2 === 0
        ? (sortedValues[n / 2 - 1] + sortedValues[n / 2]) / 2
        : sortedValues[Math.floor(n / 2)];

    let sumSqDiff = 0;
    for (let i = 0; i < n; i++) {
      const diff = sortedValues[i] - this.mean;
      sumSqDiff += diff * diff;
    }
    this.stdDev = Math.sqrt(sumSqDiff / n);

    // Build CDF line-quads
    const neededLineFloats = steps * 6 * 6;
    if (this._lineVerts.length < neededLineFloats) {
      this._lineVerts = new Float32Array(neededLineFloats);
    }
    const lineVerts = this._lineVerts;
    let li = 0;
    const lineW = 3.0 * dpr;
    let prevPx = 0,
      prevPy = 0;

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const xVal = domain[0] + t * range;
      let lo = 0,
        hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedValues[mid] <= xVal) lo = mid + 1;
        else hi = mid;
      }
      const cdfY = lo / n;
      const px = plotArea.x + t * plotArea.w;
      const py = plotArea.y + cdfY * plotArea.h;

      if (i > 0) {
        const prevT = (i - 1) / steps;
        this._sampleRampInto((prevT + t) / 2, 1.0);
        const cr = this._rampOut[0],
          cg = this._rampOut[1],
          cb = this._rampOut[2],
          ca = this._rampOut[3];
        const dx = px - prevPx,
          dy = py - prevPy;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = (-dy / len) * lineW * 0.5;
        const ny = (dx / len) * lineW * 0.5;

        lineVerts[li++] = prevPx + nx;
        lineVerts[li++] = prevPy + ny;
        lineVerts[li++] = cr;
        lineVerts[li++] = cg;
        lineVerts[li++] = cb;
        lineVerts[li++] = ca;
        lineVerts[li++] = prevPx - nx;
        lineVerts[li++] = prevPy - ny;
        lineVerts[li++] = cr;
        lineVerts[li++] = cg;
        lineVerts[li++] = cb;
        lineVerts[li++] = ca;
        lineVerts[li++] = px + nx;
        lineVerts[li++] = py + ny;
        lineVerts[li++] = cr;
        lineVerts[li++] = cg;
        lineVerts[li++] = cb;
        lineVerts[li++] = ca;

        lineVerts[li++] = px + nx;
        lineVerts[li++] = py + ny;
        lineVerts[li++] = cr;
        lineVerts[li++] = cg;
        lineVerts[li++] = cb;
        lineVerts[li++] = ca;
        lineVerts[li++] = prevPx - nx;
        lineVerts[li++] = prevPy - ny;
        lineVerts[li++] = cr;
        lineVerts[li++] = cg;
        lineVerts[li++] = cb;
        lineVerts[li++] = ca;
        lineVerts[li++] = px - nx;
        lineVerts[li++] = py - ny;
        lineVerts[li++] = cr;
        lineVerts[li++] = cg;
        lineVerts[li++] = cb;
        lineVerts[li++] = ca;
      }
      prevPx = px;
      prevPy = py;
    }

    this.lineVertexCount = steps * 6;
    const lineBytes = li * 4;
    if (!this._lineVbo || this._lineGpuCapacity < lineBytes) {
      this._lineVbo?.destroy();
      this._lineVbo = this.chartGPU.createBuffer('CDF line', Math.max(lineBytes, 4096));
      this._lineGpuCapacity = Math.max(lineBytes, 4096);
    }
    this.chartGPU.device.queue.writeBuffer(this._lineVbo, 0, lineVerts, 0, li);

    // Annotation lines: mean, mean±σ
    const meanT = (this.mean - domain[0]) / range;
    const sigLoT = (this.mean - this.stdDev - domain[0]) / range;
    const sigHiT = (this.mean + this.stdDev - domain[0]) / range;
    const lineHalfW = 1.0 * dpr;
    const y0 = plotArea.y,
      y1 = plotArea.y + plotArea.h;
    const annoVerts = this._annoVerts;
    let ai = 0;

    if (meanT >= 0 && meanT <= 1) {
      const x = plotArea.x + meanT * plotArea.w;
      ai = this._writeVertLine(annoVerts, ai, x, y0, y1, lineHalfW, 1.0, 1.0, 1.0, 0.8);
    }
    if (sigLoT >= 0 && sigLoT <= 1) {
      const x = plotArea.x + sigLoT * plotArea.w;
      ai = this._writeVertLine(annoVerts, ai, x, y0, y1, lineHalfW * 0.7, 1.0, 1.0, 1.0, 0.3);
    }
    if (sigHiT >= 0 && sigHiT <= 1) {
      const x = plotArea.x + sigHiT * plotArea.w;
      ai = this._writeVertLine(annoVerts, ai, x, y0, y1, lineHalfW * 0.7, 1.0, 1.0, 1.0, 0.3);
    }

    this.annoVertexCount = ai / 6;
    if (ai > 0) {
      const annoBytes = ai * 4;
      if (!this._annoVbo || this._annoGpuCapacity < annoBytes) {
        this._annoVbo?.destroy();
        this._annoVbo = this.chartGPU.createBuffer('CDF anno', Math.max(annoBytes, 1024));
        this._annoGpuCapacity = Math.max(annoBytes, 1024);
      }
      this.chartGPU.device.queue.writeBuffer(this._annoVbo, 0, annoVerts, 0, ai);
    }
  }

  _writeVertLine(verts, offset, x, y0, y1, halfW, r, g, b, a) {
    let i = offset;
    verts[i++] = x - halfW;
    verts[i++] = y0;
    verts[i++] = r;
    verts[i++] = g;
    verts[i++] = b;
    verts[i++] = a;
    verts[i++] = x + halfW;
    verts[i++] = y0;
    verts[i++] = r;
    verts[i++] = g;
    verts[i++] = b;
    verts[i++] = a;
    verts[i++] = x - halfW;
    verts[i++] = y1;
    verts[i++] = r;
    verts[i++] = g;
    verts[i++] = b;
    verts[i++] = a;
    verts[i++] = x - halfW;
    verts[i++] = y1;
    verts[i++] = r;
    verts[i++] = g;
    verts[i++] = b;
    verts[i++] = a;
    verts[i++] = x + halfW;
    verts[i++] = y0;
    verts[i++] = r;
    verts[i++] = g;
    verts[i++] = b;
    verts[i++] = a;
    verts[i++] = x + halfW;
    verts[i++] = y1;
    verts[i++] = r;
    verts[i++] = g;
    verts[i++] = b;
    verts[i++] = a;
    return i;
  }

  draw(pass) {
    // Annotation lines (behind the CDF curve)
    if (this.annoVertexCount > 0 && this._annoVbo) {
      pass.setPipeline(this.chartGPU.quadPipeline);
      pass.setBindGroup(0, this.chartGPU._resolutionBG);
      pass.setVertexBuffer(0, this._annoVbo);
      pass.draw(this.annoVertexCount);
    }

    // CDF line
    if (this.lineVertexCount > 0 && this._lineVbo) {
      pass.setPipeline(this.chartGPU.quadPipeline);
      pass.setBindGroup(0, this.chartGPU._resolutionBG);
      pass.setVertexBuffer(0, this._lineVbo);
      pass.draw(this.lineVertexCount);
    }
  }

  _sampleRampInto(t, alpha) {
    const ramp = this.colorRamp;
    const n = ramp.length - 1;
    const idx = t * n;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, n);
    const f = idx - lo;
    this._rampOut[0] = ramp[lo][0] + (ramp[hi][0] - ramp[lo][0]) * f;
    this._rampOut[1] = ramp[lo][1] + (ramp[hi][1] - ramp[lo][1]) * f;
    this._rampOut[2] = ramp[lo][2] + (ramp[hi][2] - ramp[lo][2]) * f;
    this._rampOut[3] = alpha;
  }

  dispose() {
    this._lineVbo?.destroy();
    this._annoVbo?.destroy();
  }
}
