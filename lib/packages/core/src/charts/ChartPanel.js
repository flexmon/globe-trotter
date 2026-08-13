/**
 * ChartPanel.js — Layout container and background renderer for a single chart.
 *
 * Manages position, size, padding, and renders the semi-transparent
 * glassmorphism background panel using the WebGPU quad pipeline.
 *
 * IMPORTANT: YAML config sizes are in CSS pixels. This class converts
 * to device pixels internally by reading window.devicePixelRatio.
 */

/** Screen anchor positions (all in device pixels) */
const ANCHORS = {
  'bottom-right': (cw, ch, w, h, margin, marginBottom, marginTop) => [
    cw - w - margin,
    marginBottom,
  ],
  'bottom-left': (cw, ch, w, h, margin, marginBottom, marginTop) => [margin, marginBottom],
  'top-right': (cw, ch, w, h, margin, marginBottom, marginTop) => [
    cw - w - margin,
    ch - h - marginTop,
  ],
  'top-left': (cw, ch, w, h, margin, marginBottom, marginTop) => [margin, ch - h - marginTop],
  center: (cw, ch, w, h) => [(cw - w) / 2, (ch - h) / 2],
};

export class ChartPanel {
  /**
   * @param {import('./ChartGPU.js').ChartGPU} chartGPU
   * @param {Object} config
   */
  constructor(chartGPU, config) {
    this.chartGPU = chartGPU;
    this.name = config.name;
    this.position = config.position || 'bottom-right';
    // CSS pixel sizes from config — will be scaled by DPR in getRect()
    this._cssWidth = (config.size && config.size[0]) || 400;
    this._cssHeight = (config.size && config.size[1]) || 200;
    this.visible = config.visible !== false;
    this._cssMargin = 20;
    this._cssMarginBottom = 65;
    this._cssMarginTop = 20;
    this._cssPadding = { top: 30, right: 20, bottom: 35, left: 55 };
    this._cssStackGap = 10;

    // Stack offset — set by ChartManager for multi-chart stacking (CSS pixels)
    this._stackOffset = 0;

    // Drag offset — null means use anchor position, [x,y] means user-dragged
    this._dragOffset = null;

    // Style
    const s = config.style || {};
    this.bgColor = s.background ? this._parseRGBA(s.background) : [0.016, 0.024, 0.048, 0.88];
    this.borderColor = [0.0, 0.9, 1.0, 0.25];
    this.borderWidth = 1.0;

    // Background quad vertex buffer: 6 vertices × 24 bytes (pos2 + color4)
    // Plus border quads: 4 edges × 6 vertices = 24 vertices
    // Total: 30 vertices × 24 bytes = 720 bytes
    this._vbo = chartGPU.createBuffer('Chart panel bg', 30 * 24);
    this._vertexData = new Float32Array(30 * 6);
    this._vertexCount = 0;
  }

  /** Current device pixel ratio */
  get dpr() {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  /**
   * Compute the device-pixel rectangle for this chart panel.
   */
  getRect(canvasWidth, canvasHeight) {
    const d = this.dpr;
    const w = this._cssWidth * d;
    const h = this._cssHeight * d;

    if (this._dragOffset) {
      return { x: this._dragOffset[0], y: this._dragOffset[1], w, h };
    }

    const margin = this._cssMargin * d;
    const marginBottom = this._cssMarginBottom * d;
    const marginTop = this._cssMarginTop * d;
    const stackShift = this._stackOffset * d;

    const anchor = ANCHORS[this.position] || ANCHORS['top-right'];
    const [x, y] = anchor(canvasWidth, canvasHeight, w, h, margin, marginBottom, marginTop);

    const isBottom = this.position.startsWith('bottom');
    const adjustedY = isBottom ? y + stackShift : y - stackShift;

    return { x, y: adjustedY, w, h };
  }

  /**
   * Get the inner plot area (excluding padding) in device pixels.
   */
  getPlotArea(canvasWidth, canvasHeight) {
    const d = this.dpr;
    const r = this.getRect(canvasWidth, canvasHeight);
    const p = this._cssPadding;
    return {
      x: r.x + p.left * d,
      y: r.y + p.bottom * d,
      w: r.w - (p.left + p.right) * d,
      h: r.h - (p.top + p.bottom) * d,
    };
  }

  /**
   * Build background vertex data. Call when position/size changes.
   */
  updateBackground(canvasWidth, canvasHeight) {
    if (!this.visible) return;

    const r = this.getRect(canvasWidth, canvasHeight);
    const d = this._vertexData;
    let i = 0;
    const bg = this.bgColor;
    const bc = this.borderColor;
    const bw = this.borderWidth * this.dpr;

    // Helper: write a quad (2 triangles, 6 vertices)
    const quad = (x0, y0, x1, y1, cr, cg, cb, ca) => {
      // Triangle 1
      d[i++] = x0;
      d[i++] = y0;
      d[i++] = cr;
      d[i++] = cg;
      d[i++] = cb;
      d[i++] = ca;
      d[i++] = x1;
      d[i++] = y0;
      d[i++] = cr;
      d[i++] = cg;
      d[i++] = cb;
      d[i++] = ca;
      d[i++] = x0;
      d[i++] = y1;
      d[i++] = cr;
      d[i++] = cg;
      d[i++] = cb;
      d[i++] = ca;
      // Triangle 2
      d[i++] = x0;
      d[i++] = y1;
      d[i++] = cr;
      d[i++] = cg;
      d[i++] = cb;
      d[i++] = ca;
      d[i++] = x1;
      d[i++] = y0;
      d[i++] = cr;
      d[i++] = cg;
      d[i++] = cb;
      d[i++] = ca;
      d[i++] = x1;
      d[i++] = y1;
      d[i++] = cr;
      d[i++] = cg;
      d[i++] = cb;
      d[i++] = ca;
    };

    // Fill background
    quad(r.x, r.y, r.x + r.w, r.y + r.h, bg[0], bg[1], bg[2], bg[3]);

    // Border edges (4 thin quads)
    quad(r.x, r.y, r.x + r.w, r.y + bw, bc[0], bc[1], bc[2], bc[3]); // bottom
    quad(r.x, r.y + r.h - bw, r.x + r.w, r.y + r.h, bc[0], bc[1], bc[2], bc[3]); // top
    quad(r.x, r.y, r.x + bw, r.y + r.h, bc[0], bc[1], bc[2], bc[3]); // left
    quad(r.x + r.w - bw, r.y, r.x + r.w, r.y + r.h, bc[0], bc[1], bc[2], bc[3]); // right

    this._vertexCount = i / 6; // 6 floats per vertex
    this.chartGPU.device.queue.writeBuffer(this._vbo, 0, d, 0, i);
  }

  /**
   * Draw the background. Call within a render pass.
   * @param {GPURenderPassEncoder} pass
   */
  draw(pass) {
    if (!this.visible || this._vertexCount === 0) return;
    pass.setPipeline(this.chartGPU.quadPipeline);
    pass.setBindGroup(0, this.chartGPU._resolutionBG);
    pass.setVertexBuffer(0, this._vbo);
    pass.draw(this._vertexCount);
  }

  _parseRGBA(str) {
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(',').map(Number);
      return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts[3] ?? 1.0];
    }
    return [0.016, 0.024, 0.048, 0.88];
  }

  dispose() {
    this._vbo?.destroy();
  }
}
