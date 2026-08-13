/**
 * AxisRenderer.js — WebGPU-rendered axes and gridlines for chart panels.
 *
 * Renders horizontal gridlines (value axis) and vertical gridlines (time axis)
 * using the chartLinePipeline. Axis labels rendered as DOM overlays.
 */

export class AxisRenderer {
  /**
   * @param {import('./ChartGPU.js').ChartGPU} chartGPU
   */
  constructor(chartGPU) {
    this.chartGPU = chartGPU;
    this.gridVertexCount = 0;
    this.axisVertexCount = 0;
    this._vbo = null;
    this._gpuCapacity = 0;
    this._yTickValues = [];
    this._xTickValues = [];
    this._labels = [];
  }

  _buildLineQuad(verts, x0, y0, x1, y1, halfWidth) {
    const dx = x1 - x0,
      dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = (-dy / len) * halfWidth;
    const ny = (dx / len) * halfWidth;
    verts.push(x0 + nx, y0 + ny, halfWidth);
    verts.push(x0 - nx, y0 - ny, -halfWidth);
    verts.push(x1 + nx, y1 + ny, halfWidth);
    verts.push(x1 + nx, y1 + ny, halfWidth);
    verts.push(x0 - nx, y0 - ny, -halfWidth);
    verts.push(x1 - nx, y1 - ny, -halfWidth);
  }

  buildGrid(plotArea, dataRange, startHourUTC = 0) {
    const { x, y, w, h } = plotArea;
    const gridVerts = [];
    const axisVerts = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const halfW = 0.5 * dpr;

    this._yTickValues = [];
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      const py = y + t * h;
      const value = dataRange[0] + t * (dataRange[1] - dataRange[0]);
      this._yTickValues.push({ py, value });
      this._buildLineQuad(gridVerts, x, py, x + w, py, halfW);
    }

    this._xTickValues = [];
    for (let hour = 0; hour <= 24; hour += 3) {
      const t = hour / 24;
      const px = x + t * w;
      const label = String((hour + startHourUTC) % 24).padStart(2, '0') + ':00';
      this._xTickValues.push({ px, label });
      this._buildLineQuad(gridVerts, px, y, px, y + h, halfW);
    }

    this.gridVertexCount = gridVerts.length / 3;

    const axisHalfW = 1.0 * dpr;
    this._buildLineQuad(axisVerts, x, y, x, y + h, axisHalfW);
    this._buildLineQuad(axisVerts, x, y, x + w, y, axisHalfW);
    this.axisVertexCount = axisVerts.length / 3;

    const all = new Float32Array([...gridVerts, ...axisVerts]);
    const neededBytes = all.byteLength;
    if (!this._vbo || this._gpuCapacity < neededBytes) {
      this._vbo?.destroy();
      this._vbo = this.chartGPU.createBuffer('Axis grid', Math.max(neededBytes, 4096));
      this._gpuCapacity = Math.max(neededBytes, 4096);
    }
    this.chartGPU.device.queue.writeBuffer(this._vbo, 0, all);
  }

  /**
   * Draw gridlines and axis borders.
   * @param {GPURenderPassEncoder} pass
   */
  draw(pass) {
    if (this.gridVertexCount === 0 && this.axisVertexCount === 0) return;

    pass.setPipeline(this.chartGPU.linePipeline);
    pass.setBindGroup(0, this.chartGPU._lineBG);
    pass.setVertexBuffer(0, this._vbo);

    // Gridlines (subtle)
    if (this.gridVertexCount > 0) {
      this.chartGPU.setLineStyle(1.0, 1.0, 1.0, 0.18, 1.0);
      pass.draw(this.gridVertexCount, 1, 0);
    }

    // Axis borders (brighter)
    if (this.axisVertexCount > 0) {
      this.chartGPU.setLineStyle(1.0, 1.0, 1.0, 0.3, 1.5);
      pass.draw(this.axisVertexCount, 1, this.gridVertexCount);
    }
  }

  updateLabels(container, canvasHeight) {
    this._labels.forEach((el) => el.remove());
    this._labels = [];

    const baseStyle = `
            position: absolute;
            font-family: 'Inter', 'Roboto', monospace;
            font-size: 10px;
            color: rgba(255, 255, 255, 0.5);
            pointer-events: none;
            white-space: nowrap;
        `;

    for (const { py, value } of this._yTickValues) {
      const el = document.createElement('div');
      el.style.cssText = baseStyle + 'text-align: right;';
      el.style.left = '0px';
      el.style.top = canvasHeight - py - 5 + 'px';
      el.textContent = value >= 1000 ? (value / 1000).toFixed(1) + 'K' : Math.round(value);
      container.appendChild(el);
      this._labels.push(el);
    }

    for (const { px, label } of this._xTickValues) {
      const el = document.createElement('div');
      el.style.cssText = baseStyle;
      el.style.left = px - 15 + 'px';
      el.style.bottom = '2px';
      el.textContent = label;
      container.appendChild(el);
      this._labels.push(el);
    }
  }

  dispose() {
    this._vbo?.destroy();
    this._labels.forEach((el) => el.remove());
    this._labels = [];
  }
}
