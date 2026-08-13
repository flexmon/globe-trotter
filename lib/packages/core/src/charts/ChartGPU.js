/**
 * ChartGPU.js — WebGPU chart rendering infrastructure.
 *
 * Creates and manages 3 render pipelines:
 *   1. quadPipeline  — colored rectangles (bars, boxes, backgrounds)
 *   2. linePipeline  — anti-aliased lines (grid, axes, whiskers, CDF)
 *   3. textPipeline  — glyph atlas text labels
 *
 * All share a resolution uniform buffer for orthographic projection.
 * Charts render on a separate overlay canvas with their own command encoder,
 * completely decoupled from the globe's render loop.
 */

import chartQuadWGSL from './shaders/chart_quad.wgsl?raw';
import chartLineWGSL from './shaders/chart_line.wgsl?raw';
import chartTextWGSL from './shaders/chart_text.wgsl?raw';

// Characters in glyph atlas
const GLYPH_CHARS = '0123456789$,.%KMBhrs/ -';
const ATLAS_FONT_SIZE = 24;
const ATLAS_PADDING = 2;

export class ChartGPU {
  /**
   * @param {GPUDevice} device
   * @param {GPUTextureFormat} format — canvas texture format (e.g. 'bgra8unorm')
   * @param {HTMLCanvasElement} canvas — overlay canvas for chart rendering
   */
  constructor(device, format, canvas) {
    this.device = device;
    this.format = format;
    this.canvas = canvas;

    // Configure the overlay canvas WebGPU context
    this._ctx = canvas.getContext('webgpu');
    this._ctx.configure({
      device,
      format,
      alphaMode: 'premultiplied', // transparent overlay
    });

    // ─── Shared resolution uniform buffer (8 bytes: vec2f) ───
    this._resolutionBuf = device.createBuffer({
      label: 'Chart resolution',
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // ─── Line uniforms buffer (color: vec4f + lineWidth: f32 = 20 bytes, pad to 32) ───
    this._lineUniformBuf = device.createBuffer({
      label: 'Chart line uniforms',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._initPipelines(device, format);
    this._initGlyphAtlas(device);
  }

  _initPipelines(device, format) {
    const quadModule = device.createShaderModule({
      label: 'Chart quad shader',
      code: chartQuadWGSL,
    });
    const lineModule = device.createShaderModule({
      label: 'Chart line shader',
      code: chartLineWGSL,
    });
    const textModule = device.createShaderModule({
      label: 'Chart text shader',
      code: chartTextWGSL,
    });

    // ─── Blend state: standard alpha blending ───
    const blendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    // ─── Resolution-only bind group layout (quad + text group 0) ───
    this._resolutionBGL = device.createBindGroupLayout({
      label: 'Chart resolution BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this._resolutionBG = device.createBindGroup({
      layout: this._resolutionBGL,
      entries: [{ binding: 0, resource: { buffer: this._resolutionBuf } }],
    });

    // ─── Line bind group layout (resolution + line uniforms) ───
    this._lineBGL = device.createBindGroupLayout({
      label: 'Chart line BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    this._lineBG = device.createBindGroup({
      layout: this._lineBGL,
      entries: [
        { binding: 0, resource: { buffer: this._resolutionBuf } },
        { binding: 1, resource: { buffer: this._lineUniformBuf } },
      ],
    });

    // ─── Text atlas bind group layout (group 1 for texture+sampler) ───
    this._textAtlasBGL = device.createBindGroupLayout({
      label: 'Chart text atlas BGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    // ═══════════════════════════════════════
    // QUAD PIPELINE
    // ═══════════════════════════════════════
    this.quadPipeline = device.createRenderPipeline({
      label: 'Chart quad pipeline',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._resolutionBGL],
      }),
      vertex: {
        module: quadModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 24, // position(2) + color(4) = 6 floats
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
              { shaderLocation: 1, offset: 8, format: 'float32x4' }, // color
            ],
          },
        ],
      },
      fragment: {
        module: quadModule,
        entryPoint: 'fs_main',
        targets: [{ format, blend: blendState }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // ═══════════════════════════════════════
    // LINE PIPELINE
    // ═══════════════════════════════════════
    this.linePipeline = device.createRenderPipeline({
      label: 'Chart line pipeline',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._lineBGL],
      }),
      vertex: {
        module: lineModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 12, // position(2) + edgeDist(1) = 3 floats
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
              { shaderLocation: 1, offset: 8, format: 'float32' }, // edgeDist
            ],
          },
        ],
      },
      fragment: {
        module: lineModule,
        entryPoint: 'fs_main',
        targets: [{ format, blend: blendState }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // ═══════════════════════════════════════
    // TEXT PIPELINE
    // ═══════════════════════════════════════
    this.textPipeline = device.createRenderPipeline({
      label: 'Chart text pipeline',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._resolutionBGL, this._textAtlasBGL],
      }),
      vertex: {
        module: textModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 32, // position(2) + uv(2) + color(4) = 8 floats
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
              { shaderLocation: 1, offset: 8, format: 'float32x2' }, // uv
              { shaderLocation: 2, offset: 16, format: 'float32x4' }, // color
            ],
          },
        ],
      },
      fragment: {
        module: textModule,
        entryPoint: 'fs_main',
        targets: [{ format, blend: blendState }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  // ─────────────────────────────────────────────
  // Glyph Atlas — generated once from Canvas2D
  // ─────────────────────────────────────────────

  _initGlyphAtlas(device) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontSize = ATLAS_FONT_SIZE;
    ctx.font = `${fontSize}px 'Inter', 'Roboto Mono', monospace`;

    // Measure each glyph
    this.glyphMetrics = {};
    let totalWidth = 0;
    for (const ch of GLYPH_CHARS) {
      const m = ctx.measureText(ch);
      const w = Math.ceil(m.width) + ATLAS_PADDING * 2;
      this.glyphMetrics[ch] = { x: totalWidth, w, advanceWidth: m.width };
      totalWidth += w;
    }
    this.atlasHeight = fontSize + ATLAS_PADDING * 2;
    this.atlasFontSize = fontSize;

    // Render atlas
    canvas.width = totalWidth;
    canvas.height = this.atlasHeight;
    ctx.font = `${fontSize}px 'Inter', 'Roboto Mono', monospace`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    for (const ch of GLYPH_CHARS) {
      const m = this.glyphMetrics[ch];
      ctx.fillText(ch, m.x + ATLAS_PADDING, ATLAS_PADDING);
      // Normalize UV coordinates
      m.u0 = m.x / totalWidth;
      m.u1 = (m.x + m.w) / totalWidth;
      m.v0 = 0;
      m.v1 = 1;
    }

    // Upload to GPU texture
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    this._atlasTexture = device.createTexture({
      label: 'Glyph atlas',
      size: [canvas.width, canvas.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.writeTexture(
      { texture: this._atlasTexture },
      imageData.data,
      { bytesPerRow: canvas.width * 4, rowsPerImage: canvas.height },
      { width: canvas.width, height: canvas.height }
    );

    this._atlasSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this._textAtlasBG = device.createBindGroup({
      layout: this._textAtlasBGL,
      entries: [
        { binding: 0, resource: this._atlasTexture.createView() },
        { binding: 1, resource: this._atlasSampler },
      ],
    });

    this.atlasWidth = totalWidth;
  }

  // ─────────────────────────────────────────────
  // Per-frame helpers
  // ─────────────────────────────────────────────

  /**
   * Update the shared resolution uniform. Call once per frame before chart rendering.
   */
  updateResolution(width, height) {
    this.device.queue.writeBuffer(this._resolutionBuf, 0, new Float32Array([width, height]));
    this._width = width;
    this._height = height;
  }

  /**
   * Set line draw parameters (color + width). Call before each line draw.
   */
  setLineStyle(r, g, b, a, lineWidth) {
    this.device.queue.writeBuffer(
      this._lineUniformBuf,
      0,
      new Float32Array([r, g, b, a, lineWidth])
    );
  }

  /**
   * Begin a chart frame. Creates a command encoder and render pass
   * targeting the overlay canvas (clear to transparent).
   * @returns {GPURenderPassEncoder}
   */
  beginFrame() {
    const textureView = this._ctx.getCurrentTexture().createView();
    this._encoder = this.device.createCommandEncoder({ label: 'Charts' });
    this._pass = this._encoder.beginRenderPass({
      label: 'Chart render pass',
      colorAttachments: [
        {
          view: textureView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 }, // transparent
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    return this._pass;
  }

  /**
   * End the chart frame — finishes the render pass and submits.
   * Completely independent of the globe's command encoder.
   */
  endFrame() {
    if (this._pass) {
      this._pass.end();
      this._pass = null;
    }
    if (this._encoder) {
      this.device.queue.submit([this._encoder.finish()]);
      this._encoder = null;
    }
  }

  /**
   * Create a vertex buffer for a chart renderer (reusable).
   */
  createBuffer(label, sizeBytes, usage = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST) {
    return this.device.createBuffer({ label, size: sizeBytes, usage });
  }

  destroy() {
    this._resolutionBuf?.destroy();
    this._lineUniformBuf?.destroy();
    this._atlasTexture?.destroy();
  }
}
