/**
 * NowIndicator.js — WebGPU-rendered "current time" vertical line.
 *
 * Renders a glowing cyan vertical line at the current normalizedTime position.
 * Uses the chartQuadPipeline (renders as a colored quad with glow via alpha).
 */

export class NowIndicator {
  /**
   * @param {import('./ChartGPU.js').ChartGPU} chartGPU
   */
  constructor(chartGPU) {
    this.chartGPU = chartGPU;
    this.glowWidth = 8.0 * Math.min(window.devicePixelRatio || 1, 2);
    this.color = [0.0, 0.9, 1.0, 0.9]; // cyan accent

    // 6 vertices × 24 bytes (pos2 + color4)
    this._vbo = chartGPU.createBuffer('Now indicator', 6 * 24);
    this._verts = new Float32Array(6 * 6);
  }

  /**
   * Update and draw the now indicator.
   * @param {GPURenderPassEncoder} pass
   * @param {{ x, y, w, h }} plotArea
   * @param {number} normalizedTime — 0..1
   */
  draw(pass, plotArea, normalizedTime) {
    const { x, y, w, h } = plotArea;
    const nowX = x + normalizedTime * w;
    const halfGlow = this.glowWidth;
    const c = this.color;

    // Center bright line (narrow quad, full alpha)
    const v = this._verts;
    let i = 0;
    const hw = 1.0; // 1px center line

    // Quad for center line
    v[i++] = nowX - hw;
    v[i++] = y;
    v[i++] = c[0];
    v[i++] = c[1];
    v[i++] = c[2];
    v[i++] = c[3];
    v[i++] = nowX + hw;
    v[i++] = y;
    v[i++] = c[0];
    v[i++] = c[1];
    v[i++] = c[2];
    v[i++] = c[3];
    v[i++] = nowX - hw;
    v[i++] = y + h;
    v[i++] = c[0];
    v[i++] = c[1];
    v[i++] = c[2];
    v[i++] = c[3];
    v[i++] = nowX - hw;
    v[i++] = y + h;
    v[i++] = c[0];
    v[i++] = c[1];
    v[i++] = c[2];
    v[i++] = c[3];
    v[i++] = nowX + hw;
    v[i++] = y;
    v[i++] = c[0];
    v[i++] = c[1];
    v[i++] = c[2];
    v[i++] = c[3];
    v[i++] = nowX + hw;
    v[i++] = y + h;
    v[i++] = c[0];
    v[i++] = c[1];
    v[i++] = c[2];
    v[i++] = c[3];

    this.chartGPU.device.queue.writeBuffer(this._vbo, 0, v);

    pass.setPipeline(this.chartGPU.quadPipeline);
    pass.setBindGroup(0, this.chartGPU._resolutionBG);
    pass.setVertexBuffer(0, this._vbo);
    pass.draw(6);
  }

  dispose() {
    this._vbo?.destroy();
  }
}
