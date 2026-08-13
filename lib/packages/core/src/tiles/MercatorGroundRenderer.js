/**
 * MercatorGroundRenderer.js — flat-quad Blue Marble fallback for the 2D
 * Mercator projection.
 *
 * GlobeRenderer already falls back to the Blue Marble texture on the sphere
 * when no satellite tile provider is configured (see `skipBlueMarble` in
 * GlobeTrotterEngine._initSystems). The sphere is skipped entirely in
 * Mercator mode though, so without this renderer a token-less 2D view has
 * nothing behind the (also absent) tiles. This renders one quad per visible
 * world copy (matching MercatorTileRenderer's renderWorldCopies behavior),
 * each covering the standard [0, worldSize]² Mercator world extent and
 * reprojecting the same equirectangular Blue Marble texture GlobeRenderer
 * already loaded (shared via `setTexture`, no second fetch/decode).
 */

import groundWGSL from './shaders/mercator-ground.wgsl?raw';

const TILE_PX = 256;
const UNIFORM_BYTES = 32; // 2 × vec4<f32>
// Generous cap on simultaneously visible world copies (renderWorldCopies).
// _effectiveMinZoom() keeps worldSize >= viewport height, so even an
// ultra-wide viewport needs only a handful — this just bounds the scratch
// buffer, it's never a visible truncation in practice.
const MAX_COPIES = 64;

export class MercatorGroundRenderer {
  /**
   * @param {GPUDevice} device
   * @param {GPUTextureFormat} format
   * @param {GPUTextureFormat} depthFormat
   */
  constructor(device, format, depthFormat) {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
    this.texture = null;
    this._textureBindGroup = null;

    this._uniformScratchBuf = new ArrayBuffer(UNIFORM_BYTES);
    this._uniformScratchF32 = new Float32Array(this._uniformScratchBuf);

    this._copyOffsetsScratchBuf = new ArrayBuffer(MAX_COPIES * 4);
    this._copyOffsetsScratchF32 = new Float32Array(this._copyOffsetsScratchBuf);

    this._buildPipeline();
  }

  _buildPipeline() {
    const device = this.device;

    this.uniformBuffer = device.createBuffer({
      label: 'Mercator ground uniforms',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._uniformBGL = device.createBindGroupLayout({
      label: 'Mercator ground uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this._textureBGL = device.createBindGroupLayout({
      label: 'Mercator ground texture BGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    this._copyOffsetsBGL = device.createBindGroupLayout({
      label: 'Mercator ground copy-offsets BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'Mercator ground pipeline layout',
      bindGroupLayouts: [this._uniformBGL, this._textureBGL, this._copyOffsetsBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'Mercator ground shader',
      code: groundWGSL,
    });

    this._sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 16,
    });

    this.pipeline = device.createRenderPipeline({
      label: 'Mercator ground pipeline',
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
    });

    this._uniformBindGroup = device.createBindGroup({
      label: 'Mercator ground uniform BG',
      layout: this._uniformBGL,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    this._copyOffsetsBuffer = device.createBuffer({
      label: 'Mercator ground copy offsets',
      size: MAX_COPIES * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this._copyOffsetsBindGroup = device.createBindGroup({
      label: 'Mercator ground copy-offsets BG',
      layout: this._copyOffsetsBGL,
      entries: [{ binding: 0, resource: { buffer: this._copyOffsetsBuffer } }],
    });
  }

  /**
   * Bind (or rebind) the equirectangular earth texture. Called with
   * GlobeRenderer's `earthTexture` — first the 1×1 placeholder, then again
   * once the real Blue Marble bitmap replaces it.
   * @param {GPUTexture} texture
   */
  setTexture(texture) {
    if (!texture || this.texture === texture) return;
    this.texture = texture;
    this._textureBindGroup = this.device.createBindGroup({
      label: 'Mercator ground texture BG',
      layout: this._textureBGL,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this._sampler },
      ],
    });
  }

  /**
   * @param {{ lng: number, lat: number, zoom: number, renderWorldCopies?: boolean }} camera
   * @param {number} viewportW - canvas physical width
   * @param {number} viewportH - canvas physical height
   * @returns {number} draw calls (0 or 1)
   */
  render(passEncoder, camera, viewportW, viewportH) {
    if (!this._textureBindGroup) return 0;

    const worldSize = TILE_PX * Math.pow(2, camera.zoom);
    const centerX = ((camera.lng + 180) / 360) * worldSize;
    const sinLat = Math.sin((camera.lat * Math.PI) / 180);
    const centerY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;

    // Same world-copy range the tile renderer covers via getVisibleTilesMercator:
    // one quad per world width visible across the viewport when panning is
    // unbounded, a single quad at copy 0 otherwise (camera longitude is
    // already clamped to one world in that mode).
    let minCopy = 0;
    let maxCopy = 0;
    if (camera.renderWorldCopies) {
      const halfW = viewportW / 2;
      minCopy = Math.floor((centerX - halfW) / worldSize);
      maxCopy = Math.floor((centerX + halfW) / worldSize);
    }
    const copyCount = Math.min(MAX_COPIES, maxCopy - minCopy + 1);

    const uf = this._uniformScratchF32;
    uf[0] = worldSize;
    uf[1] = 0;
    uf[2] = 0;
    uf[3] = 0;
    uf[4] = centerX;
    uf[5] = centerY;
    uf[6] = viewportW;
    uf[7] = viewportH;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformScratchBuf);

    const offsets = this._copyOffsetsScratchF32;
    for (let i = 0; i < copyCount; i++) {
      offsets[i] = (minCopy + i) * worldSize;
    }
    this.device.queue.writeBuffer(
      this._copyOffsetsBuffer,
      0,
      this._copyOffsetsScratchBuf,
      0,
      copyCount * 4
    );

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this._uniformBindGroup);
    passEncoder.setBindGroup(1, this._textureBindGroup);
    passEncoder.setBindGroup(2, this._copyOffsetsBindGroup);
    passEncoder.draw(6, copyCount);

    return 1;
  }

  dispose() {
    this.uniformBuffer?.destroy();
    this._copyOffsetsBuffer?.destroy();
    // `texture` is owned by GlobeRenderer — not destroyed here.
  }
}
