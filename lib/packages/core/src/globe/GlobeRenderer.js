/**
 * GlobeRenderer.js — WebGPU implementation of the globe renderer.
 *
 * Same public interface as GlobeRenderer (WebGL2) so the engine can swap
 * between backends transparently.
 *
 * Pipeline:
 *   1. Build UV sphere geometry → GPUBuffers (vertex + index)
 *   2. Load Blue Marble texture → GPUTexture (via createImageBitmap + copyExternalImageToTexture)
 *   3. Create render pipeline with globe.wgsl shaders
 *   4. Per frame: write uniforms → set bind groups → drawIndexed
 */

import globeWGSL from './shaders/globe.wgsl?raw';

export class GlobeRenderer {
  /**
   * @param {GPUDevice} device
   * @param {GPUTextureFormat} format - Canvas swap chain format (e.g. 'bgra8unorm')
   * @param {string} basePath - Base URL for texture loading
   * @param {Function} [onReady] - Called when textures finish loading
   * @param {boolean} [skipBlueMarble=false] - When true, skip the Blue Marble texture fetch
   *   and use a solid ocean-blue placeholder instead. Pass true when a tile provider
   *   (Google / Mapbox) is active — tiles paint over the globe surface anyway, so the
   *   ~20 MB JPEG is pure wasted bandwidth and memory.
   */
  constructor(device, format, basePath = '/', onReady, skipBlueMarble = false) {
    this.device = device;
    this.format = format;
    this.basePath = basePath;
    this.ready = false;
    this.onReady = onReady;
    this.terrainScale = 0;
    this.darkMode = false;

    this._buildGeometry();
    this._buildPipeline();
    if (skipBlueMarble) {
      this._skipBlueMarble();
    } else {
      this._loadTextures();
    }

    // Pre-allocated scratch buffer for per-frame uniform writes (zero GC pressure)
    this._uniformScratch = new ArrayBuffer(this._uniformBufferSize);
    this._uniformF32 = new Float32Array(this._uniformScratch);
  }

  // ─── Geometry ───

  _buildGeometry() {
    const latBands = 256;
    const lonBands = 512;
    const vertexCount = (latBands + 1) * (lonBands + 1);

    // Interleaved: position(3) + normal(3) + uv(2) = 8 floats per vertex
    const stride = 8;
    const vertices = new Float32Array(vertexCount * stride);
    const indices = [];

    let vi = 0;
    for (let lat = 0; lat <= latBands; lat++) {
      const theta = (lat * Math.PI) / latBands;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      for (let lon = 0; lon <= lonBands; lon++) {
        const phi = (lon * 2 * Math.PI) / lonBands;
        const sinPhi = Math.sin(phi);
        const cosPhi = Math.cos(phi);

        const x = sinTheta * sinPhi;
        const y = cosTheta;
        const z = sinTheta * cosPhi;

        vertices[vi++] = x; // position
        vertices[vi++] = y;
        vertices[vi++] = z;
        vertices[vi++] = x; // normal (= position for unit sphere)
        vertices[vi++] = y;
        vertices[vi++] = z;
        vertices[vi++] = lon / lonBands; // uv
        vertices[vi++] = lat / latBands;
      }
    }

    for (let lat = 0; lat < latBands; lat++) {
      for (let lon = 0; lon < lonBands; lon++) {
        const first = lat * (lonBands + 1) + lon;
        const second = first + lonBands + 1;
        indices.push(first, second, first + 1);
        indices.push(second, second + 1, first + 1);
      }
    }

    this.indexCount = indices.length;

    this.vertexBuffer = this.device.createBuffer({
      label: 'Globe vertices',
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

    const indexData = new Uint32Array(indices);
    this.indexBuffer = this.device.createBuffer({
      label: 'Globe indices',
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, indexData);
  }

  // ─── Pipeline ───

  _buildPipeline() {
    const device = this.device;

    // Uniform buffer: must be 16-byte aligned
    // mat4(64) + mat4(64) + mat4(64) + vec3(12) + f32(4) + f32(4) + f32(4) + f32(4) + f32(4) = 220
    // Round up to 224 (multiple of 16)
    this._uniformBufferSize = 224;
    this.uniformBuffer = device.createBuffer({
      label: 'Globe uniforms',
      size: this._uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Bind group layouts
    this._uniformBGL = device.createBindGroupLayout({
      label: 'Globe uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this._textureBGL = device.createBindGroupLayout({
      label: 'Globe texture BGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'Globe pipeline layout',
      bindGroupLayouts: [this._uniformBGL, this._textureBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'Globe shader',
      code: globeWGSL,
    });

    this.pipeline = device.createRenderPipeline({
      label: 'Globe render pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 8 * 4, // 8 floats × 4 bytes
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
              { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
              { shaderLocation: 2, offset: 24, format: 'float32x2' }, // uv
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'back',
        frontFace: 'ccw',
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
    });

    // Create uniform bind group (static — buffer doesn't change, only contents)
    this._uniformBindGroup = device.createBindGroup({
      label: 'Globe uniform bind group',
      layout: this._uniformBGL,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer },
        },
      ],
    });

    // Texture bind group is created after textures load
    this._textureBindGroup = null;
  }

  // ─── Textures ───

  // NASA Blue Marble Next Generation — one file per calendar month.
  // Filenames are not perfectly regular (different resolutions, abbreviated names)
  // so they are enumerated explicitly here, indexed 0 (Jan) → 11 (Dec).
  static BLUE_MARBLE_BY_MONTH = [
    'world.200401.3x21600x10800_january.jpg',
    'world.200402.3x21600x10800_february.jpg',
    'world.200403.3x21600x10800_march.jpg',
    'world.200404.3x21600x10800_april.jpg',
    'world.200405.3x21600x10800_may.jpg',
    'world.200406.3x21600x10800_june.jpg',
    'world.200407.3x21600x10800_july.jpg',
    'world.200408.3x21600x10800_august.jpg',
    'world.200409.3x21600x10800_sept.jpg',
    'world.200410.3x21600x10800_october.jpg',
    'world.200411.3x21600x10800_november.jpg',
    'world.200412.3x21600x10800_dec.jpg',
  ];

  /**
   * Skip the Blue Marble fetch when a tile provider is active. The globe still
   * renders (needed for the atmospheric rim, depth buffer, and ocean areas between
   * tile zoom transitions), but uses a solid ocean-blue 1×1 texture instead of
   * the 20 MB monthly JPEG. Tiles paint over the surface anyway.
   */
  _skipBlueMarble() {
    this.earthTexture = this._create1x1Texture([10, 30, 80, 255], 'Ocean blue (tile mode)');
    this.elevationTexture = this._create1x1Texture([0, 0, 0, 255], 'Elevation placeholder');
    this._buildTextureBindGroup();
    this.ready = true;
    if (this.onReady) this.onReady();
  }

  _loadTextures() {
    const device = this.device;

    // Create 1×1 placeholder textures so the globe renders immediately
    this.earthTexture = this._create1x1Texture([40, 80, 160, 255], 'Earth placeholder');
    this.elevationTexture = this._create1x1Texture([0, 0, 0, 255], 'Elevation placeholder');
    this._buildTextureBindGroup();

    // Pick the Blue Marble image for the current calendar month
    const month = new Date().getMonth(); // 0 = January … 11 = December
    const filename = GlobeRenderer.BLUE_MARBLE_BY_MONTH[month];
    const url = `${this.basePath}textures/${filename}`;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      try {
        // WebGPU max texture size is 8192. For the high-res NASA images (21600×10800)
        // we MUST NOT use canvas.drawImage() — that requires decoding the full ~932 MB
        // intermediate raster and reliably crashes the tab. Instead, pass resize options
        // directly to createImageBitmap() so the browser decodes straight to target size.
        const MAX_TEX = 8192;
        const scale = Math.min(MAX_TEX / img.naturalWidth, MAX_TEX / img.naturalHeight, 1.0);
        const w = Math.min(MAX_TEX, Math.round(img.naturalWidth * scale));
        const h = Math.min(MAX_TEX, Math.round(img.naturalHeight * scale));
        const bitmapOpts =
          scale < 1.0 ? { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' } : {};
        const bitmap = await createImageBitmap(img, bitmapOpts);
        console.log(`[WebGPU] Blue Marble loaded: ${bitmap.width}×${bitmap.height} (${filename})`);
        this.earthTexture = this._createTextureFromBitmap(bitmap, `Blue Marble (${filename})`);
        this._buildTextureBindGroup();
        this.ready = true;
        if (this.onReady) this.onReady();
      } catch (e) {
        console.warn('[WebGPU] Blue Marble bitmap failed:', e.message);
        this._buildProceduralEarthTexture();
        this.ready = true;
        if (this.onReady) this.onReady();
      }
    };
    img.onerror = () => {
      console.warn(`[WebGPU] Blue Marble failed to load from "${url}", using procedural fallback`);
      this._buildProceduralEarthTexture();
      this.ready = true;
      if (this.onReady) this.onReady();
    };
    img.src = url;
  }

  _create1x1Texture(rgba, label) {
    const device = this.device;
    const texture = device.createTexture({
      label,
      size: [1, 1],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
    return texture;
  }

  _createTextureFromBitmap(bitmap, label) {
    const device = this.device;
    const texture = device.createTexture({
      label,
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
      mipLevelCount: 1,
    });
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [
      bitmap.width,
      bitmap.height,
    ]);
    return texture;
  }

  _buildProceduralEarthTexture() {
    const size = 2048;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const oceanGrad = ctx.createLinearGradient(0, 0, 0, size);
    oceanGrad.addColorStop(0, '#0a1628');
    oceanGrad.addColorStop(0.5, '#0f3460');
    oceanGrad.addColorStop(1, '#0a1628');
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#d4dce8';
    ctx.fillRect(0, 0, size, size * 0.06);
    ctx.fillRect(0, size * 0.94, size, size * 0.06);

    createImageBitmap(canvas).then((bitmap) => {
      this.earthTexture = this._createTextureFromBitmap(bitmap, 'Procedural Earth');
      this._buildTextureBindGroup();
    });
  }

  _buildTextureBindGroup() {
    const device = this.device;
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      maxAnisotropy: 16,
    });

    this._textureBindGroup = device.createBindGroup({
      label: 'Globe texture bind group',
      layout: this._textureBGL,
      entries: [
        { binding: 0, resource: this.earthTexture.createView() },
        { binding: 1, resource: sampler },
        { binding: 2, resource: this.elevationTexture.createView() },
        { binding: 3, resource: sampler },
      ],
    });
  }

  // ─── Render ───

  /**
   * Render the globe into the given render pass.
   * Same signature as WebGL2 GlobeRenderer.render() for easy swapping.
   *
   * @param {GPURenderPassEncoder} passEncoder - Active render pass
   * @param {Float32Array} modelMatrix
   * @param {Float32Array} viewMatrix
   * @param {Float32Array} projMatrix
   * @param {Float32Array} sunDirection - vec3
   * @param {Float32Array} cameraPosition - vec3 (unused in globe shader, but kept for API compat)
   * @param {number} time
   */
  render(passEncoder, modelMatrix, viewMatrix, projMatrix, sunDirection, cameraPosition, time) {
    if (!this._textureBindGroup) return;

    // Pack uniforms into pre-allocated scratch buffer (zero GC pressure)
    // Layout: model(64) + view(64) + projection(64) + sunDirection(12) + time(4) + terrainScale(4) + darkMode(4) + pad(8)
    const f32 = this._uniformF32;
    f32.set(modelMatrix, 0); // offset 0:  model mat4
    f32.set(viewMatrix, 16); // offset 64: view mat4
    f32.set(projMatrix, 32); // offset 128: projection mat4
    f32.set(sunDirection, 48); // offset 192: sun_direction vec3
    f32[51] = time; // offset 204: time f32
    f32[52] = this.terrainScale; // offset 208: terrain_scale f32
    f32[53] = this.darkMode ? 1.0 : 0.0; // offset 212: dark_mode f32

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformScratch);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this._uniformBindGroup);
    passEncoder.setBindGroup(1, this._textureBindGroup);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.setIndexBuffer(this.indexBuffer, 'uint32');
    passEncoder.drawIndexed(this.indexCount);
  }

  // ─── Cleanup ───

  dispose() {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.earthTexture?.destroy();
    this.elevationTexture?.destroy();
    // Release pre-allocated scratch buffers
    this._uniformScratch = null;
    this._uniformF32 = null;
  }
}
