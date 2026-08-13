/**
 * TileRenderer.js — Instanced WebGPU tile rendering.
 *
 * Optimization: single drawIndexedInstanced() per frame instead of ~150
 * per-tile draw calls. Uses:
 *   - texture_2d_array: 256 layers × 256×256 rgba8unorm
 *   - Storage buffer: per-tile lat/lon bounds + array layer index
 *   - Instance index: vertex shader looks up tile bounds, computes lat/lon
 *   - Free list: recycled array layers when tiles are evicted
 */

import tileWGSL from './shaders/tile.wgsl?raw';
import * as mat4 from '../math/mat4.js';

const TILE_SUBDIVISIONS = 64;
const TILE_RADIUS = 1.0005;
const MAX_TILE_LAYERS = 256;
const TILE_TEX_SIZE = 512; // Mapbox @2x tiles are 512×512
const FADE_DURATION_MS = 300; // tile fade-in duration when it first arrives

// Per-tile storage buffer entry: 4 floats (bounds) + 1 u32 (layer) + 1 f32 (opacity) + 2 u32 pad = 32 bytes
const TILE_DATA_STRIDE = 32;

export class TileRenderer {
  constructor(device, format, depthFormat, tileManager) {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
    this.tileManager = tileManager;

    // Tile key → { layerIndex } mapping
    this.tileLayerMap = new Map();
    // Free layer indices
    this._freeLayers = [];
    for (let i = MAX_TILE_LAYERS - 1; i >= 0; i--) this._freeLayers.push(i);
    this._nextLayer = 0;

    this._tilesToRender = [];
    this._renderedAreas = new Set();

    // Pre-allocated scratch buffers (eliminates per-frame GC pressure)
    this._uniformScratchBuf = new ArrayBuffer(144);
    this._uniformScratchF32 = new Float32Array(this._uniformScratchBuf);
    this._tileDataScratchBuf = new ArrayBuffer(MAX_TILE_LAYERS * TILE_DATA_STRIDE);
    this._tileDataScratchF32 = new Float32Array(this._tileDataScratchBuf);
    this._tileDataScratchU32 = new Uint32Array(this._tileDataScratchBuf);
    // Frustum corner computation scratch (reused every frame)
    this._vpScratch = new Float32Array(16);
    this._invVPScratch = new Float32Array(16);

    // Amortize texture uploads: cap per frame to prevent jank
    this._uploadsThisFrame = 0;
    this._maxUploadsPerFrame = 2;

    this._buildPipeline();
    this._buildTileMesh();
  }

  _buildPipeline() {
    const device = this.device;

    // Uniform buffer: view(64) + projection(64) + sunDirection(12) + tileRadius(4) = 144
    this._uniformBufferSize = 144;
    this.uniformBuffer = device.createBuffer({
      label: 'Tile uniforms',
      size: this._uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._uniformBGL = device.createBindGroupLayout({
      label: 'Tile uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Texture array bind group layout
    this._textureBGL = device.createBindGroupLayout({
      label: 'Tile texture array BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float', viewDimension: '2d-array' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });

    // Per-tile data storage buffer bind group layout
    this._tileDataBGL = device.createBindGroupLayout({
      label: 'Tile data BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'Tile pipeline layout',
      bindGroupLayouts: [this._uniformBGL, this._textureBGL, this._tileDataBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'Tile shader',
      code: tileWGSL,
    });

    // Shared sampler
    this._tileSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 16,
    });

    // Texture 2D array: MAX_TILE_LAYERS × 256×256
    this._tileArray = device.createTexture({
      label: 'Tile texture array',
      size: [TILE_TEX_SIZE, TILE_TEX_SIZE, MAX_TILE_LAYERS],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this._textureBindGroup = device.createBindGroup({
      label: 'Tile texture array BG',
      layout: this._textureBGL,
      entries: [
        { binding: 0, resource: this._tileArray.createView() },
        { binding: 1, resource: this._tileSampler },
      ],
    });

    // Per-tile data storage buffer
    this._tileDataBuffer = device.createBuffer({
      label: 'Tile instance data',
      size: MAX_TILE_LAYERS * TILE_DATA_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this._tileDataBindGroup = device.createBindGroup({
      label: 'Tile data BG',
      layout: this._tileDataBGL,
      entries: [{ binding: 0, resource: { buffer: this._tileDataBuffer } }],
    });

    this.pipeline = device.createRenderPipeline({
      label: 'Tile render pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            // UV buffer (static, shared by all instances)
            arrayStride: 2 * 4,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
          },
        ],
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
        cullMode: 'back',
        frontFace: 'ccw',
      },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false,
        depthCompare: 'less-equal',
        depthBias: -40,
        depthBiasSlopeScale: -2.0,
      },
    });

    this._uniformBindGroup = device.createBindGroup({
      label: 'Tile uniform BG',
      layout: this._uniformBGL,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  _buildTileMesh() {
    const device = this.device;
    const n = TILE_SUBDIVISIONS;

    const indices = [];
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const tl = row * (n + 1) + col;
        const tr = tl + 1;
        const bl = (row + 1) * (n + 1) + col;
        const br = bl + 1;
        indices.push(tl, bl, tr, tr, bl, br);
      }
    }
    this.indexCount = indices.length;
    this.vertexCount = (n + 1) * (n + 1);

    // Static UVs — same for every tile instance
    const staticUVs = new Float32Array(this.vertexCount * 2);
    let ui = 0;
    for (let row = 0; row <= n; row++) {
      const v = row / n;
      for (let col = 0; col <= n; col++) {
        staticUVs[ui++] = col / n;
        staticUVs[ui++] = v;
      }
    }

    this.uvBuffer = device.createBuffer({
      label: 'Tile UVs',
      size: staticUVs.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.uvBuffer, 0, staticUVs);

    // Index buffer
    const indexData = new Uint16Array(indices);
    this.indexBuffer = device.createBuffer({
      label: 'Tile indices',
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, indexData);
  }

  /**
   * Allocate a layer in the texture array for a tile.
   * If no free layers, evict the least recently used tile.
   */
  _allocLayer() {
    if (this._freeLayers.length > 0) {
      return this._freeLayers.pop();
    }
    // LRU eviction: find the layer that was used longest ago
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
    return -1; // shouldn't happen
  }

  _freeLayer(index) {
    this._freeLayers.push(index);
  }

  /**
   * Upload a tile image to the texture array at the given layer index.
   * Note: image sizes are guaranteed to be 512x512 by the TileManager decode step.
   */
  _uploadTileToArray(image, layerIndex) {
    this.device.queue.copyExternalImageToTexture(
      { source: image },
      { texture: this._tileArray, origin: { x: 0, y: 0, z: layerIndex } },
      [TILE_TEX_SIZE, TILE_TEX_SIZE]
    );
  }

  /**
   * Get or create a layer mapping for a tile entry.
   * Returns { layerIndex } or null if image not ready / array full.
   */
  _getTileLayer(entry) {
    const key = entry.key || `${entry.z}/${entry.x}/${entry.y}`;
    if (this.tileLayerMap.has(key)) {
      const mapping = this.tileLayerMap.get(key);
      mapping._lastUsedFrame = this._frameCounter;
      return mapping;
    }
    if (entry.image) {
      const layerIndex = this._allocLayer();
      if (layerIndex < 0) return null;

      this._uploadTileToArray(entry.image, layerIndex);
      this._uploadsThisFrame++;

      // Free the decoded RGBA pixels immediately after GPU upload.
      // A 512×512 tile = 1 MB; keeping 3000+ decoded tiles causes OOM ("Aw, Snap").
      // When _allocLayer later LRU-evicts this GPU layer, the cache entry will have
      // image=null and !tileLayerMap entry; isGpuReady detects that zombie state and
      // deletes it from TileManager cache so requestTile queues a fresh fetch.
      if (entry.image.close) entry.image.close();
      entry.image = null;

      const mapping = { layerIndex, _lastUsedFrame: this._frameCounter };
      this.tileLayerMap.set(key, mapping);
      return mapping;
    }

    return null;
  }

  /**
   * Unproject the 4 NDC screen corners through inv(proj × view) and intersect
   * each ray with the unit sphere. Returns [{lat, lon}] × 4 in order
   * [bottom-left, bottom-right, top-left, top-right], or null on failure.
   *
   * When a corner ray misses the sphere (tilted view looking past the horizon),
   * the closest point on the sphere surface in that ray direction is used — this
   * gives the best approximation of the visible horizon point at that corner.
   */
  _computeFrustumCorners(viewMatrix, projMatrix, cameraPosition) {
    mat4.multiply(this._vpScratch, projMatrix, viewMatrix);
    if (!mat4.invert(this._invVPScratch, this._vpScratch)) return null;

    const m = this._invVPScratch;
    const ox = cameraPosition[0],
      oy = cameraPosition[1],
      oz = cameraPosition[2];
    const corners = [];

    // NDC corners at far plane (WebGPU: z=1, w=1). Order: BL, BR, TL, TR.
    // In a tilted view the top corners land on the horizon, bottom on the near zone.
    for (const [nx, ny] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      // Transform NDC (nx, ny, 1, 1) → world space using inv(proj × view)
      const wx = m[0] * nx + m[4] * ny + m[8] + m[12];
      const wy = m[1] * nx + m[5] * ny + m[9] + m[13];
      const wz = m[2] * nx + m[6] * ny + m[10] + m[14];
      const ww = m[3] * nx + m[7] * ny + m[11] + m[15];
      const iw = 1.0 / ww;

      // Ray direction from camera through this world point
      let rdx = wx * iw - ox,
        rdy = wy * iw - oy,
        rdz = wz * iw - oz;
      const rl = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
      if (rl < 1e-6) return null; // degenerate
      rdx /= rl;
      rdy /= rl;
      rdz /= rl;

      // Ray-sphere intersection: |O + t·D|² = 1, D is unit length so a=1
      const b = 2 * (ox * rdx + oy * rdy + oz * rdz);
      const c = ox * ox + oy * oy + oz * oz - 1.0;
      const disc = b * b - 4 * c;

      let hx, hy, hz;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) * 0.5;
        hx = ox + t * rdx;
        hy = oy + t * rdy;
        hz = oz + t * rdz;
      } else {
        // Ray misses sphere (tilted past horizon) — use closest sphere surface
        // point in that direction: project the closest-approach point onto sphere.
        const tc = -b * 0.5;
        const cx = ox + tc * rdx,
          cy = oy + tc * rdy,
          cz = oz + tc * rdz;
        const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
        hx = cx / cl;
        hy = cy / cl;
        hz = cz / cl;
      }

      const lat = Math.asin(Math.max(-1, Math.min(1, hy))) * (180 / Math.PI);
      let lon = Math.atan2(hx, hz) * (180 / Math.PI) - 180;
      if (lon < -180) lon += 360;
      corners.push({ lat, lon });
    }

    return corners.length === 4 ? corners : null;
  }

  /**
   * Render visible tiles — single instanced draw call.
   * Capped at MAX_TILE_LAYERS (256) tiles per frame — tiles are sorted by
   * distance so nearest tiles always render first.
   */
  render(
    passEncoder,
    viewMatrix,
    projMatrix,
    sunDirection,
    cameraPosition,
    cameraDistance,
    lookPoint = null,
    tilt = 0
  ) {
    const tm = this.tileManager;
    this._frameCounter = (this._frameCounter || 0) + 1;
    this._uploadsThisFrame = 0;
    const now = performance.now();

    // Compute actual frustum corners from the GPU matrices so TileManager can
    // use the true visible area instead of the hardcoded aspectRatio=2.0 heuristic.
    const frustumCorners = this._computeFrustumCorners(viewMatrix, projMatrix, cameraPosition);
    const visibleTiles = tm.getVisibleTiles(
      cameraPosition,
      cameraDistance,
      lookPoint,
      tilt,
      frustumCorners
    );

    const tilesToRender = this._tilesToRender;
    tilesToRender.length = 0;
    const renderedAreas = this._renderedAreas;
    renderedAreas.clear();

    let simulatedUploads = 0;
    const isGpuReady = (entry) => {
      const key = entry.key || `${entry.z}/${entry.x}/${entry.y}`;
      if (this.tileLayerMap.has(key)) return true;
      if (!entry.image) {
        // Zombie: image was released after GPU upload but the GPU layer was
        // subsequently evicted by _allocLayer. TileManager cache still holds a
        // stale entry with image=null that blocks re-fetch. Delete it so the
        // next requestTile call queues a fresh fetch.
        this.tileManager.cache.delete(key);
        return false;
      }

      if (this._uploadsThisFrame + simulatedUploads >= this._maxUploadsPerFrame) {
        // We have decoded images ready, but hit the per-frame upload cap.
        // Signal the engine to run ANOTHER frame immediately so the upload
        // pipeline doesn't stall when the camera is stationary!
        this.tileManager._dirty = true;
        return false;
      }

      simulatedUploads++; // Claim the slot, but defer actual mapping/allocation
      return true;
    };

    // Opacity for a tile entry: 0→1 over FADE_DURATION_MS after first arrival.
    // Base/ancestor tiles (no loadedAt) are always fully opaque.
    const tileOpacity = (entry) => {
      if (!entry.loadedAt) return 1.0;
      return Math.min(1.0, (now - entry.loadedAt) / FADE_DURATION_MS);
    };

    for (const tile of visibleTiles) {
      const entry = tm.requestTile(tile.z, tile.x, tile.y, tile.dist || 0);
      if (entry && isGpuReady(entry)) {
        tile.entry = entry;
        tile.opacity = tileOpacity(entry);
        tilesToRender.push(tile);
        renderedAreas.add(tile.key);
      } else {
        // Tile not ready — show best available ancestor at full opacity.
        const parent = tm.findBestCachedAncestor(tile.z, tile.x, tile.y);
        if (parent && !renderedAreas.has(parent.key) && isGpuReady(parent.entry)) {
          parent.entry.key = parent.key;
          parent.opacity = 1.0;
          tilesToRender.push(parent);
          renderedAreas.add(parent.key);
        }
      }
    }

    // Keep rendering every frame while any tile is fading in (opacity < 1).
    // The Z=2/Z=3 base layer already renders underneath (lower zoom = first in
    // the sorted draw order), so fading tiles correctly blend over the background.
    let hasFading = false;
    for (let i = 0; i < tilesToRender.length; i++) {
      if (tilesToRender[i].opacity < 1.0) {
        hasFading = true;
        break;
      }
    }
    if (hasFading) tm._dirty = true;

    if (tilesToRender.length === 0) return 0;

    // Truncate to the 256 nearest tiles FIRST before sorting by zoom.
    // The visibleTiles loop added them in dist order (nearest first).
    // Truncating furthest tiles prevents us from thrashing the LRU cache with
    // tiles that will never be drawn anyway.
    if (tilesToRender.length > MAX_TILE_LAYERS) {
      tilesToRender.length = MAX_TILE_LAYERS;
    }

    // Sort by zoom level ascending: Parents (low zoom) render first,
    // Children (high zoom) render last. This enforces the painter's algorithm
    // correctly and prevents Z-fighting flashing when tile distances flutter.
    tilesToRender.sort((a, b) => a.z - b.z);

    // Write uniforms (reuse scratch — zero GC)
    const f32 = this._uniformScratchF32;
    f32.set(viewMatrix, 0);
    f32.set(projMatrix, 16);
    f32.set(sunDirection, 32);
    f32[35] = TILE_RADIUS;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformScratchBuf);

    // Build per-tile data for the storage buffer (reuse scratch)
    const maxTiles = Math.min(tilesToRender.length, MAX_TILE_LAYERS);
    const tileF32 = this._tileDataScratchF32;
    const tileU32 = this._tileDataScratchU32;
    // Zero only the region we'll use
    tileF32.fill(0, 0, maxTiles * 8);
    let instanceCount = 0;

    for (let i = 0; i < maxTiles; i++) {
      const tile = tilesToRender[i];
      const mapping = this._getTileLayer(tile.entry);
      if (!mapping) continue;

      const bounds = tile.bounds;
      const zoom = tile.z;
      if (!bounds) continue;

      // Use exact spherical Mercator bounds. We no longer bloat the edges
      // to cover seams, as that physically distorted the image mapping.
      const mercBottom = bounds.mercBottom;
      const mercTop = bounds.mercTop;

      // Web Mercator X perfectly matches longitude (in radians)
      const mercLeft = bounds.lonLeft * (Math.PI / 180);
      const mercRight = bounds.lonRight * (Math.PI / 180);

      const offset = instanceCount * 8; // 8 values per tile (32 bytes / 4)
      tileF32[offset + 0] = mercBottom;
      tileF32[offset + 1] = mercTop;
      tileF32[offset + 2] = mercLeft;
      tileF32[offset + 3] = mercRight;
      tileU32[offset + 4] = mapping.layerIndex;
      tileF32[offset + 5] = tile.opacity ?? 1.0; // fade-in opacity (slot reuses _pad0)
      // pad slots [6..7] are zero
      instanceCount++;
    }

    if (instanceCount === 0) return 0;

    // Upload tile data (from scratch buffer)
    this.device.queue.writeBuffer(
      this._tileDataBuffer,
      0,
      this._tileDataScratchBuf,
      0,
      instanceCount * TILE_DATA_STRIDE
    );

    // Single instanced draw call
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this._uniformBindGroup);
    passEncoder.setBindGroup(1, this._textureBindGroup);
    passEncoder.setBindGroup(2, this._tileDataBindGroup);
    passEncoder.setVertexBuffer(0, this.uvBuffer);
    passEncoder.setIndexBuffer(this.indexBuffer, 'uint16');
    passEncoder.drawIndexed(this.indexCount, instanceCount);

    return 1;
  }

  cleanup() {
    const tm = this.tileManager;
    const now = performance.now();
    const GRACE_MS = 15000; // matches TileManager eviction grace period
    for (const [key, mapping] of this.tileLayerMap) {
      if (!tm.cache.has(key)) {
        if (!mapping._evictedAt) {
          mapping._evictedAt = now;
        } else if (now - mapping._evictedAt > GRACE_MS) {
          this._freeLayer(mapping.layerIndex);
          this.tileLayerMap.delete(key);
        }
      } else {
        if (mapping._evictedAt) delete mapping._evictedAt;
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
    this.uvBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this._tileDataBuffer?.destroy();
  }
}
