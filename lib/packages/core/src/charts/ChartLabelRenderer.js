/**
 * ChartLabelRenderer.js — WebGPU-rendered text labels for chart panels.
 *
 * Uses the shared glyph atlas from ChartGPU, renders labels as textured
 * quads via chartTextPipeline. Supports numeric formatting and 90° rotation
 * for in-bar labels.
 */

const ATLAS_FONT_SIZE = 24;

export class ChartLabelRenderer {
  /**
   * @param {import('./ChartGPU.js').ChartGPU} chartGPU
   * @param {Object} [style]
   */
  constructor(chartGPU, style = {}) {
    this.chartGPU = chartGPU;
    this.vertexCount = 0;

    // Config
    this.fontSize = style.labelSize || 14;
    this.color = this._parseLabelColor(style.labelColor);
    this.format = style.labelFormat || 'number';

    // Use shared glyph atlas from ChartGPU
    this.glyphMap = chartGPU.glyphMetrics;
    this._atlasCharHeight = chartGPU.atlasHeight / Math.min(window.devicePixelRatio || 1, 2);

    this._vertsCapacity = 0;
    this._verts = null;
    this._vbo = null;
    this._gpuCapacity = 0;
  }

  _parseLabelColor(val) {
    if (!val) return [1, 1, 1, 0.9];
    if (Array.isArray(val)) return val;
    if (typeof val === 'string' && val.startsWith('#')) {
      const hex = val.replace('#', '');
      if (hex.length === 3) {
        return [
          parseInt(hex[0] + hex[0], 16) / 255,
          parseInt(hex[1] + hex[1], 16) / 255,
          parseInt(hex[2] + hex[2], 16) / 255,
          0.9,
        ];
      }
      return [
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
        hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 0.9,
      ];
    }
    return [1, 1, 1, 0.9];
  }

  formatValue(value, format) {
    const fmt = format || this.format;
    if (fmt === 'currency') {
      if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
      if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
      if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
      if (Math.abs(value) >= 1) return `$${Math.round(value)}`;
      if (Math.abs(value) > 0) return `$${value.toFixed(2)}`;
      return '$0';
    }
    if (fmt === 'percent') {
      return `${(value * 100).toFixed(1)}%`;
    }
    if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
    return `${Math.round(value)}`;
  }

  setLabels(labels) {
    if (!labels || labels.length === 0) {
      this.vertexCount = 0;
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = (this.fontSize * dpr) / ATLAS_FONT_SIZE;
    const maxChars = labels.reduce((sum, l) => sum + l.text.length, 0);
    const neededFloats = maxChars * 6 * 8;

    if (!this._verts || this._vertsCapacity < neededFloats) {
      this._verts = new Float32Array(neededFloats);
      this._vertsCapacity = neededFloats;
    }
    const verts = this._verts;
    let vi = 0;

    for (const label of labels) {
      const { text, cx, topY, color } = label;
      const baseY = label.baseY || 0;
      const c = color || this.color;

      const charH = this._atlasCharHeight * scale;
      const visibleGlyphH = charH * (1.0 / 1.4);
      const descenderPad = charH - visibleGlyphH;

      let totalW = 0;
      for (const ch of text) {
        const g = this.glyphMap[ch];
        if (g) totalW += (g.advanceWidth || g.w) * scale;
      }

      const barH = topY - baseY;
      if (barH < totalW * 0.5) continue;

      const pivotX = cx;
      const pivotY = baseY + barH * 0.5;
      let startX = pivotX - totalW * 0.5;
      const hY0 = pivotY - charH * 0.5 - descenderPad * 0.5;

      for (const ch of text) {
        const g = this.glyphMap[ch];
        if (!g) continue;

        const w = (g.advanceWidth || g.w) * scale;
        const hx0 = startX,
          hx1 = startX + w;
        const hy0 = hY0,
          hy1 = hY0 + charH;

        // Rotate 90° CCW around pivot
        const corners = [
          [hx0, hy0],
          [hx1, hy0],
          [hx0, hy1],
          [hx1, hy1],
        ];
        const r = corners.map(([x, y]) => [-(y - pivotY) + pivotX, x - pivotX + pivotY]);

        // Triangle 1
        verts[vi++] = r[0][0];
        verts[vi++] = r[0][1];
        verts[vi++] = g.u0;
        verts[vi++] = g.v1;
        verts[vi++] = c[0];
        verts[vi++] = c[1];
        verts[vi++] = c[2];
        verts[vi++] = c[3];
        verts[vi++] = r[1][0];
        verts[vi++] = r[1][1];
        verts[vi++] = g.u1;
        verts[vi++] = g.v1;
        verts[vi++] = c[0];
        verts[vi++] = c[1];
        verts[vi++] = c[2];
        verts[vi++] = c[3];
        verts[vi++] = r[2][0];
        verts[vi++] = r[2][1];
        verts[vi++] = g.u0;
        verts[vi++] = g.v0;
        verts[vi++] = c[0];
        verts[vi++] = c[1];
        verts[vi++] = c[2];
        verts[vi++] = c[3];

        // Triangle 2
        verts[vi++] = r[2][0];
        verts[vi++] = r[2][1];
        verts[vi++] = g.u0;
        verts[vi++] = g.v0;
        verts[vi++] = c[0];
        verts[vi++] = c[1];
        verts[vi++] = c[2];
        verts[vi++] = c[3];
        verts[vi++] = r[1][0];
        verts[vi++] = r[1][1];
        verts[vi++] = g.u1;
        verts[vi++] = g.v1;
        verts[vi++] = c[0];
        verts[vi++] = c[1];
        verts[vi++] = c[2];
        verts[vi++] = c[3];
        verts[vi++] = r[3][0];
        verts[vi++] = r[3][1];
        verts[vi++] = g.u1;
        verts[vi++] = g.v0;
        verts[vi++] = c[0];
        verts[vi++] = c[1];
        verts[vi++] = c[2];
        verts[vi++] = c[3];

        startX += w;
      }
    }

    this.vertexCount = vi / 8;
    const neededBytes = vi * 4;
    if (!this._vbo || this._gpuCapacity < neededBytes) {
      this._vbo?.destroy();
      this._vbo = this.chartGPU.createBuffer('Chart labels', Math.max(neededBytes, 4096));
      this._gpuCapacity = Math.max(neededBytes, 4096);
    }
    this.chartGPU.device.queue.writeBuffer(this._vbo, 0, verts, 0, vi);
  }

  draw(pass) {
    if (this.vertexCount === 0 || !this._vbo) return;
    pass.setPipeline(this.chartGPU.textPipeline);
    pass.setBindGroup(0, this.chartGPU._resolutionBG);
    pass.setBindGroup(1, this.chartGPU._textAtlasBG);
    pass.setVertexBuffer(0, this._vbo);
    pass.draw(this.vertexCount);
  }

  dispose() {
    this._vbo?.destroy();
  }
}
