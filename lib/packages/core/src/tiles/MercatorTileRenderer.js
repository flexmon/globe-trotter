/**
 * MercatorTileRenderer.js — WebGPU flat-quad raster tile renderer for the
 * 2D Mercator projection. WebGPU sibling of MercatorTileRenderer (WebGL2) and
 * spherical sibling of TileRenderer.
 *
 * Same single-instanced-draw / texture-array pattern as TileRenderer; the
 * only difference is the vertex transform — instead of unprojecting tile UVs
 * to spherical positions through view/projection matrices, each tile is a
 * flat quad placed in world-pixel space and projected with a simple 2D
 * camera-offset / viewport-half divide (matching MercatorCameraController).
 */

import tileWGSL from './shaders/mercator-tile.wgsl?raw';

const TILE_PX = 256;
const MAX_TILE_LAYERS = 256;
const TILE_TEX_SIZE = 512; // Mapbox/Google @2x tiles are 512×512

// Per-tile storage entry: vec4f rect + vec4u layer = 32 bytes
const TILE_DATA_STRIDE = 32;

// Uniforms: 2 × vec4f = 32 bytes
const UNIFORM_BYTES = 32;

export class MercatorTileRenderer {
  /**
   * @param {GPUDevice} device
   * @param {GPUTextureFormat} format
   * @param {GPUTextureFormat} depthFormat
   * @param {import('./TileManager.js').TileManager} tileManager
   */
  constructor(device, format, depthFormat, tileManager) {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
    this.tileManager = tileManager;

    // Tile key → { layerIndex, _lastUsedFrame, _evictedAt }
    this.tileLayerMap = new Map();
    this._freeLayers = [];
    for (let i = MAX_TILE_LAYERS - 1; i >= 0; i--) this._freeLayers.push(i);

    this._tilesToRender = [];
    this._renderedAreas = new Set();

    this._uniformScratchBuf = new ArrayBuffer(UNIFORM_BYTES);
    this._uniformScratchF32 = new Float32Array(this._uniformScratchBuf);

    this._tileDataScratchBuf = new ArrayBuffer(MAX_TILE_LAYERS * TILE_DATA_STRIDE);
    this._tileDataScratchF32 = new Float32Array(this._tileDataScratchBuf);
    this._tileDataScratchU32 = new Uint32Array(this._tileDataScratchBuf);

    this._uploadsThisFrame = 0;
    this._maxUploadsPerFrame = 2;

    this._buildPipeline();
  }

  _buildPipeline() {
    const device = this.device;

    this.uniformBuffer = device.createBuffer({
      label: 'Mercator tile uniforms',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._uniformBGL = device.createBindGroupLayout({
      label: 'Mercator tile uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this._textureBGL = device.createBindGroupLayout({
      label: 'Mercator tile texture BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d-array' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    this._tileDataBGL = device.createBindGroupLayout({
      label: 'Mercator tile data BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'Mercator tile pipeline layout',
      bindGroupLayouts: [this._uniformBGL, this._textureBGL, this._tileDataBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'Mercator tile shader',
      code: tileWGSL,
    });

    this._tileSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 16,
    });

    this._tileArray = device.createTexture({
      label: 'Mercator tile texture array',
      size: [TILE_TEX_SIZE, TILE_TEX_SIZE, MAX_TILE_LAYERS],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this._textureBindGroup = device.createBindGroup({
      label: 'Mercator tile texture BG',
      layout: this._textureBGL,
      entries: [
        { binding: 0, resource: this._tileArray.createView() },
        { binding: 1, resource: this._tileSampler },
      ],
    });

    this._tileDataBuffer = device.createBuffer({
      label: 'Mercator tile instance data',
      size: MAX_TILE_LAYERS * TILE_DATA_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this._tileDataBindGroup = device.createBindGroup({
      label: 'Mercator tile data BG',
      layout: this._tileDataBGL,
      entries: [{ binding: 0, resource: { buffer: this._tileDataBuffer } }],
    });

    this.pipeline = device.createRenderPipeline({
      label: 'Mercator tile pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
    });

    this._uniformBindGroup = device.createBindGroup({
      label: 'Mercator tile uniform BG',
      layout: this._uniformBGL,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  _allocLayer() {
    if (this._freeLayers.length > 0) return this._freeLayers.pop();
    // LRU eviction
    let oldestKey = null;
    let oldestFrame = Infinity;
    for (const [key, mapping] of this.tileLayerMap) {
      if ((mapping._lastUsedFrame || 0) < oldestFrame) {
        oldestFrame = mapping._lastUsedFrame || 0;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const evicted = this.tileLayerMap.get(oldestKey);
      this.tileLayerMap.delete(oldestKey);
      return evicted.layerIndex;
    }
    return -1;
  }

  _freeLayer(index) {
    this._freeLayers.push(index);
  }

  _uploadTileToArray(image, layerIndex) {
    this.device.queue.copyExternalImageToTexture(
      { source: image },
      { texture: this._tileArray, origin: { x: 0, y: 0, z: layerIndex } },
      [TILE_TEX_SIZE, TILE_TEX_SIZE]
    );
  }

  _getTileLayer(key, image) {
    if (this.tileLayerMap.has(key)) {
      const mapping = this.tileLayerMap.get(key);
      mapping._lastUsedFrame = this._frameCounter;
      return mapping;
    }
    if (!image) return null;
    const layerIndex = this._allocLayer();
    if (layerIndex < 0) return null;
    this._uploadTileToArray(image, layerIndex);
    this._uploadsThisFrame++;
    const mapping = { layerIndex, _lastUsedFrame: this._frameCounter };
    this.tileLayerMap.set(key, mapping);
    return mapping;
  }

  /**
   * Render visible Mercator tiles via one instanced draw call.
   *
   * @param {GPURenderPassEncoder} passEncoder
   * @param {{ lng: number, lat: number, zoom: number }} camera
   * @param {number} viewportW - canvas physical width
   * @param {number} viewportH - canvas physical height
   * @param {number} [opacity=1]
   * @returns {number} draw calls (0 or 1)
   */
  render(passEncoder, camera, viewportW, viewportH, opacity = 1) {
    const tm = this.tileManager;
    this._frameCounter = (this._frameCounter || 0) + 1;
    this._uploadsThisFrame = 0;

    const tiles = tm.getVisibleTilesMercator(
      camera.lng,
      camera.lat,
      camera.zoom,
      viewportW,
      viewportH,
      camera.renderWorldCopies ?? false
    );

    const worldSize = TILE_PX * Math.pow(2, camera.zoom);
    const centerX = ((camera.lng + 180) / 360) * worldSize;
    const sinLat = Math.sin((camera.lat * Math.PI) / 180);
    const centerY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;

    const tilesToRender = this._tilesToRender;
    tilesToRender.length = 0;
    const renderedAreas = this._renderedAreas;
    renderedAreas.clear();

    let simulatedUploads = 0;
    const isGpuReady = (key, image) => {
      if (this.tileLayerMap.has(key)) return true;
      if (!image) return false;
      if (this._uploadsThisFrame + simulatedUploads >= this._maxUploadsPerFrame) {
        this.tileManager._dirty = true;
        return false;
      }
      simulatedUploads++;
      return true;
    };

    for (const tile of tiles) {
      const renderKey = tile.renderKey || tile.key;
      const entry = tm.requestTile(tile.z, tile.x, tile.y, tile.dist || 0);
      if (entry && entry.image && isGpuReady(tile.key, entry.image)) {
        tilesToRender.push({
          key: tile.key,
          z: tile.z,
          worldX: tile.worldX,
          worldY: tile.worldY,
          worldSize: tile.worldSize,
          image: entry.image,
        });
        renderedAreas.add(renderKey);
      } else {
        const parent = tm.findBestCachedAncestor(tile.z, tile.x, tile.y);
        if (parent && parent.entry && parent.entry.image) {
          const worldCopy = tile.worldCopy ?? 0;
          const parentNumTiles = Math.pow(2, parent.z);
          const parentActualX = parent.x + worldCopy * parentNumTiles;
          const parentRenderKey =
            worldCopy !== 0 ? `${parent.z}/${parentActualX}/${parent.y}` : parent.key;
          if (!renderedAreas.has(parentRenderKey) && isGpuReady(parent.key, parent.entry.image)) {
            const pTileSize = worldSize / Math.pow(2, parent.z);
            tilesToRender.push({
              key: parent.key,
              z: parent.z,
              worldX: parentActualX * pTileSize,
              worldY: parent.y * pTileSize,
              worldSize: pTileSize,
              image: parent.entry.image,
            });
            renderedAreas.add(parentRenderKey);
          }
        }
      }
    }

    if (tilesToRender.length === 0) return 0;

    // Painter's algorithm: parents first.
    if (tilesToRender.length > MAX_TILE_LAYERS) {
      tilesToRender.length = MAX_TILE_LAYERS;
    }
    tilesToRender.sort((a, b) => a.z - b.z);

    // Uniforms — pack worldSize/opacity/cameraOffset/viewport.
    const uf = this._uniformScratchF32;
    uf[0] = worldSize;
    uf[1] = opacity;
    uf[2] = 0;
    uf[3] = 0;
    uf[4] = centerX;
    uf[5] = centerY;
    uf[6] = viewportW;
    uf[7] = viewportH;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformScratchBuf);

    // Per-tile data.
    const tileF32 = this._tileDataScratchF32;
    const tileU32 = this._tileDataScratchU32;
    let instanceCount = 0;
    for (let i = 0; i < tilesToRender.length; i++) {
      const t = tilesToRender[i];
      const mapping = this._getTileLayer(t.key, t.image);
      if (!mapping) continue;
      const offset = instanceCount * 8; // 8 × 4 bytes = 32
      tileF32[offset + 0] = t.worldX;
      tileF32[offset + 1] = t.worldY;
      tileF32[offset + 2] = t.worldSize;
      tileF32[offset + 3] = 0;
      tileU32[offset + 4] = mapping.layerIndex;
      tileU32[offset + 5] = 0;
      tileU32[offset + 6] = 0;
      tileU32[offset + 7] = 0;
      instanceCount++;
    }

    if (instanceCount === 0) return 0;

    this.device.queue.writeBuffer(
      this._tileDataBuffer,
      0,
      this._tileDataScratchBuf,
      0,
      instanceCount * TILE_DATA_STRIDE
    );

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this._uniformBindGroup);
    passEncoder.setBindGroup(1, this._textureBindGroup);
    passEncoder.setBindGroup(2, this._tileDataBindGroup);
    passEncoder.draw(6, instanceCount);

    return 1;
  }

  cleanup() {
    const tm = this.tileManager;
    const now = performance.now();
    const GRACE_MS = 5000;
    for (const [key, mapping] of this.tileLayerMap) {
      if (!tm.cache.has(key)) {
        if (!mapping._evictedAt) {
          mapping._evictedAt = now;
        } else if (now - mapping._evictedAt > GRACE_MS) {
          this._freeLayer(mapping.layerIndex);
          this.tileLayerMap.delete(key);
        }
      } else if (mapping._evictedAt) {
        delete mapping._evictedAt;
      }
    }
  }

  flushTextures() {
    for (const [, mapping] of this.tileLayerMap) {
      this._freeLayer(mapping.layerIndex);
    }
    this.tileLayerMap.clear();
  }

  dispose() {
    this.flushTextures();
    this._tileArray?.destroy();
    this.uniformBuffer?.destroy();
    this._tileDataBuffer?.destroy();
  }
}
