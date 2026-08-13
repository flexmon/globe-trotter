/**
 * HistogramRenderer.js — WebGPU-rendered live histogram for chart panels.
 *
 * Renders colored vertical bars showing the distribution of values
 * across configurable bins. Bar colors follow the layer's color ramp.
 * Uses the shared chartQuadPipeline from ChartGPU.
 */

/** Parse hex "#RRGGBB" to [r, g, b, a] in 0..1 */
function hexToRGBA(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
    1.0,
  ];
}

/** Default fallback ramp — uniformly spaced over [0,1] */
const DEFAULT_RAMP = [
  { t: 0.0, rgba: [0.05, 0.1, 0.5, 1.0] },
  { t: 0.25, rgba: [0.05, 0.45, 0.75, 1.0] },
  { t: 0.5, rgba: [0.1, 0.75, 0.35, 1.0] },
  { t: 0.75, rgba: [0.85, 0.85, 0.1, 1.0] },
  { t: 1.0, rgba: [0.95, 0.2, 0.1, 1.0] },
];

export class HistogramRenderer {
  /**
   * @param {import('./ChartGPU.js').ChartGPU} chartGPU
   * @param {Object} [style]
   */
  constructor(chartGPU, style = {}) {
    this.chartGPU = chartGPU;
    this.vertexCount = 0;

    // Config
    this.binCount = style.binCount || 12;
    this.domain = style.domain || [0, 60];
    this.barGap = style.barGap || 0.15;
    this.barOpacity = style.barOpacity ?? 0.9;
    this.yScale = style.yScale || 'log';
    // Normalized ramp stops in {t: 0..1, rgba} form, sorted by t.
    // When the layer provides value-anchored stops, they're remapped onto
    // [0,1] using the ramp's own value domain so that bin value → color
    // matches the globe exactly.
    this.colorRamp = DEFAULT_RAMP;
    // Value range over which the layer's color ramp is defined (from YAML).
    // Bin values are clamped to this range before color sampling.
    this.rampValueDomain = null;
    this.maxCount = 1;

    // Pre-allocated vertex buffer — reused across setData() calls
    this._vertsCapacity = 0;
    this._verts = null;
    this._vbo = null;
    this._gpuCapacity = 0;
  }

  /**
   * Accepts either:
   *   - `string[]` of hex colors (legacy; spread uniformly over [0,1])
   *   - `{value: number, color: string}[]` from the layer style (preferred;
   *     value positions are remapped onto [0,1] using the min/max value as
   *     the ramp domain so bin value → color matches the globe)
   */
  setColorRamp(stops) {
    if (!stops || stops.length < 2) return;

    const first = stops[0];
    if (typeof first === 'string') {
      const n = stops.length - 1;
      this.colorRamp = stops.map((h, i) => ({ t: i / n, rgba: hexToRGBA(h) }));
      this.rampValueDomain = null;
      return;
    }

    if (first && typeof first === 'object' && 'value' in first && 'color' in first) {
      const sorted = stops.slice().sort((a, b) => a.value - b.value);
      const vmin = sorted[0].value;
      const vmax = sorted[sorted.length - 1].value;
      const span = vmax - vmin || 1;
      this.colorRamp = sorted.map((s) => ({
        t: (s.value - vmin) / span,
        rgba: hexToRGBA(s.color),
      }));
      this.rampValueDomain = [vmin, vmax];
    }
  }

  setData(counts, plotArea, binDomain) {
    if (!counts || counts.length === 0 || !plotArea) {
      this.vertexCount = 0;
      return;
    }

    const n = counts.length;
    let maxC = 0;
    for (let i = 0; i < n; i++) if (counts[i] > maxC) maxC = counts[i];
    this.maxCount = maxC || 1;
    const logMax = Math.log10(maxC + 1);

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

    // Pick the value range to use for bar coloring. Prefer the layer
    // ramp's value domain (so colors match the globe). Fall back to the
    // bin domain (legacy behavior: rainbow spread across visible bars).
    const colorDomain = this.rampValueDomain || binDomain || this.domain;
    const valueDomain = binDomain || this.domain;
    const [vmin, vmax] = valueDomain;
    const binSpan = vmax - vmin || 1;
    const [cmin, cmax] = colorDomain;
    const colorSpan = cmax - cmin || 1;

    for (let i = 0; i < n; i++) {
      if (counts[i] === 0) continue;

      let barH;
      if (this.yScale === 'log') {
        const logVal = counts[i] > 0 ? Math.log10(counts[i] + 1) : 0;
        barH = (logVal / logMax) * plotArea.h;
      } else {
        barH = (counts[i] / maxC) * plotArea.h;
      }

      const x0 = plotArea.x + i * barFullWidth + gap * 0.5;
      const x1 = x0 + barWidth;
      const y0 = plotArea.y;
      const y1 = y0 + Math.max(barH, 1);

      const binCenterValue = vmin + ((i + 0.5) * binSpan) / n;
      const tRaw = (binCenterValue - cmin) / colorSpan;
      const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
      const color = this._sampleRamp(t);

      // 2 triangles per bar
      verts[vi++] = x0;
      verts[vi++] = y0;
      verts[vi++] = color[0];
      verts[vi++] = color[1];
      verts[vi++] = color[2];
      verts[vi++] = color[3];
      verts[vi++] = x1;
      verts[vi++] = y0;
      verts[vi++] = color[0];
      verts[vi++] = color[1];
      verts[vi++] = color[2];
      verts[vi++] = color[3];
      verts[vi++] = x0;
      verts[vi++] = y1;
      verts[vi++] = color[0];
      verts[vi++] = color[1];
      verts[vi++] = color[2];
      verts[vi++] = color[3];
      verts[vi++] = x0;
      verts[vi++] = y1;
      verts[vi++] = color[0];
      verts[vi++] = color[1];
      verts[vi++] = color[2];
      verts[vi++] = color[3];
      verts[vi++] = x1;
      verts[vi++] = y0;
      verts[vi++] = color[0];
      verts[vi++] = color[1];
      verts[vi++] = color[2];
      verts[vi++] = color[3];
      verts[vi++] = x1;
      verts[vi++] = y1;
      verts[vi++] = color[0];
      verts[vi++] = color[1];
      verts[vi++] = color[2];
      verts[vi++] = color[3];
    }

    this.vertexCount = Math.floor(vi / 6);

    // Ensure GPU buffer is large enough
    const neededBytes = vi * 4;
    if (!this._vbo || this._gpuCapacity < neededBytes) {
      this._vbo?.destroy();
      this._vbo = this.chartGPU.createBuffer('Histogram bars', Math.max(neededBytes, 4096));
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

  _sampleRamp(t) {
    const ramp = this.colorRamp;
    if (t <= ramp[0].t) {
      const c = ramp[0].rgba;
      return [c[0], c[1], c[2], 0.9 * this.barOpacity];
    }
    const last = ramp[ramp.length - 1];
    if (t >= last.t) {
      return [last.rgba[0], last.rgba[1], last.rgba[2], 0.9 * this.barOpacity];
    }
    for (let i = 1; i < ramp.length; i++) {
      if (t <= ramp[i].t) {
        const lo = ramp[i - 1],
          hi = ramp[i];
        const span = hi.t - lo.t || 1;
        const f = (t - lo.t) / span;
        return [
          lo.rgba[0] + (hi.rgba[0] - lo.rgba[0]) * f,
          lo.rgba[1] + (hi.rgba[1] - lo.rgba[1]) * f,
          lo.rgba[2] + (hi.rgba[2] - lo.rgba[2]) * f,
          0.9 * this.barOpacity,
        ];
      }
    }
    const c = last.rgba;
    return [c[0], c[1], c[2], 0.9 * this.barOpacity];
  }

  dispose() {
    this._vbo?.destroy();
  }
}
