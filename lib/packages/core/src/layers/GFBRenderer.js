/**
 * GFBRenderer.js — WebGPU instanced billboard rendering for GFB temporal point data.
 *
 * Same architecture as the WebGL2 GFBRenderer:
 *   - Instanced billboards (6 quad verts × N instances)
 *   - RGBA32F position textures for temporal interpolation
 *   - SDF-based symbols in fragment shader (4 types)
 *   - CPU-side filter with visibility buffer
 *   - Geometric horizon test (no depth test)
 *   - Additive blending for glow effects
 *
 * WebGPU changes:
 *   - Bind groups for uniforms, data textures, color ramp
 *   - device.queue.writeTexture() for position texture uploads
 *   - Pipeline-level blend/depth config
 *   - Instance stepping via buffer layout (stepMode: 'instance')
 */

import { StyleEngine } from '../styles/StyleEngine.js';
import pointWGSL from './shaders/gfbpoint.wgsl?raw';
import pointMercWGSL from './shaders/gfbpoint.merc.wgsl?raw';
import { computeWorldCopies } from '../util/mercatorBake.js';

export class GFBRenderer {
  /**
   * @param {GPUDevice} device
   * @param {string} format - Canvas texture format
   * @param {string} depthFormat - Depth texture format
   * @param {Object} data - Decoded GFB data from GFBDecoder
   * @param {Object} [compiledStyle] - CompiledStyle from StyleEngine.compileGPU()
   */
  constructor(device, format, depthFormat, data, compiledStyle) {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
    this.data = data;
    this.featureCount = data.featureCount;
    this.epochCount = data.epochCount;

    if (!compiledStyle) {
      const dict = data.dictionary || [];
      const firstAttr = data.staticColumns ? Object.keys(data.staticColumns)[0] : null;
      if (firstAttr && dict.length > 0) {
        compiledStyle = StyleEngine.compileGPU(
          device,
          StyleEngine.categorical({
            attribute: firstAttr,
            categories: {},
            default: '#999999',
            opacity: 0.9,
          }),
          dict
        );
      } else {
        compiledStyle = StyleEngine.compileGPU(
          device,
          StyleEngine.categorical({
            attribute: '_none',
            categories: {},
            default: '#ffffff',
            opacity: 0.8,
          }),
          []
        );
      }
    }
    this.style = compiledStyle;

    // Save the original dictionary used to compile the LUT.
    // On shard switch, indices must be remapped from the shard's dictionary
    // to the original ordering so the LUT lookup returns the correct color.
    this._origDictionary = [...(data.dictionary || [])];

    // Filter state
    this._filterPredicates = null;
    this._filterCombinator = 0;
    this._visibility = new Float32Array(this.featureCount);
    this._visibility.fill(1.0);

    this._buildPipeline();
    this._buildBuffers();
    this._buildDataTextures();
    this._rebuildRampBindGroup();

    // Pre-pack velocity data into RGBA32F layout (same pattern as positions)
    if (this._hasVelocity) {
      this._packedVelocity = this._packVelocityRGBA32F();
    }

    this._currentEpoch = -1;
    this._shardEpochStart = 0;
    this._shardEpochCount = data.epochCount;
    this._symbolScale = 1.0;
    this._symbolType = 0;
    this._baseSize = 0.003; // Default base size in globe units
    this._zoomNear = 1.05; // Camera dist where symbols smallest
    this._zoomFar = 3.0; // Camera dist where symbols largest
    this._zoomMinScale = 0.25; // Min scale fraction at close zoom
    this._extrusionScale = 1.0;

    // Velocity-based heading: look for ewvelocity/nsvelocity in temporal columns
    this._ewVelocityCol = null;
    this._nsVelocityCol = null;
    this._hasVelocity = false;

    if (compiledStyle && compiledStyle._headingConfig) {
      const hCfg = compiledStyle._headingConfig;
      this._ewVelocityCol = hCfg.ew || 'ewvelocity';
      this._nsVelocityCol = hCfg.ns || 'nsvelocity';
    } else {
      // Auto-detect from temporal columns
      if (data.temporalColumns?.['ewvelocity'] && data.temporalColumns?.['nsvelocity']) {
        this._ewVelocityCol = 'ewvelocity';
        this._nsVelocityCol = 'nsvelocity';
      }
    }

    if (
      this._ewVelocityCol &&
      this._nsVelocityCol &&
      data.temporalColumns?.[this._ewVelocityCol] &&
      data.temporalColumns?.[this._nsVelocityCol]
    ) {
      this._hasVelocity = true;
    }

    // Pre-allocated scratch buffers for per-frame uniform writes (zero GC pressure)
    this._uniformScratch = new ArrayBuffer(this._uniformBufferSize);
    this._uniformF32 = new Float32Array(this._uniformScratch);
    this._uniformI32 = new Int32Array(this._uniformScratch);
    this._camRight = new Float32Array(3);
    this._camUp = new Float32Array(3);
  }

  setStyle(compiledStyle) {
    const oldStyle = this.style;
    this.style = compiledStyle;
    this._rebuildRampBindGroup();
    if (oldStyle) {
      // Defer disposal until all in-flight GPU work referencing the old ramp
      // texture has completed. Destroying it synchronously causes a WebGPU
      // validation error when the current frame's command buffer is submitted.
      if (this.device?.queue?.onSubmittedWorkDone) {
        this.device.queue.onSubmittedWorkDone().then(() => oldStyle.disposeGPU());
      } else {
        oldStyle.disposeGPU();
      }
    }
  }

  setSymbolScale(scale) {
    this._symbolScale = Math.max(0.1, scale);
  }
  setSymbolType(type) {
    this._symbolType = Math.max(0, Math.min(3, type));
  }
  setBaseSize(size) {
    this._baseSize = Math.max(0.0001, size);
  }
  setZoomAttenuation({ near, far, minScale } = {}) {
    if (near !== undefined) this._zoomNear = near;
    if (far !== undefined) this._zoomFar = far;
    if (minScale !== undefined) this._zoomMinScale = Math.max(0, Math.min(1, minScale));
  }
  setExtrusionScale(scale) {
    this._extrusionScale = Math.max(0, scale);
  }

  setFilter(gpuFilter) {
    if (!gpuFilter || gpuFilter.predicates.length === 0) {
      this.clearFilter();
      return;
    }
    this._filterPredicates = gpuFilter.predicates;
    this._filterCombinator = gpuFilter.combinator === 'OR' ? 1 : 0;
    this._applyFilter();
  }

  clearFilter() {
    this._filterPredicates = null;
    this._filterCombinator = 0;
    this._visibility.fill(1.0);
    this.device.queue.writeBuffer(this._visBuffer, 0, this._visibility);
  }

  setActiveAttribute(attrName) {
    if (!this.style.color) this.style.color = {};
    if (this.style.color.attribute === attrName) return;
    this.style.color.attribute = attrName;
    this.updateValueBuffer();
  }

  /**
   * Set a SQL-driven visibility mask directly.
   * @param {Float32Array} mask - Float32Array[featureCount], 1.0=visible, 0.0=hidden
   */
  setVisibilityMask(mask) {
    if (mask.length !== this.featureCount) {
      console.warn(
        `[GFBRenderer] Mask length ${mask.length} !== featureCount ${this.featureCount}`
      );
    }
    this._visibility.set(mask.subarray(0, Math.min(mask.length, this.featureCount)));
    this.device.queue.writeBuffer(this._visBuffer, 0, this._visibility);
  }

  _applyFilter() {
    const preds = this._filterPredicates;
    if (!preds) return;
    const isOR = this._filterCombinator === 1;
    const data = this.data;
    for (let i = 0; i < this.featureCount; i++) {
      let hit = isOR ? false : true;
      for (const pred of preds) {
        const col = data.staticColumns?.[pred.column];
        const val = col ? col[i] : 0;
        const res = this._evalPredicate(val, pred);
        if (isOR) {
          hit = hit || res;
        } else {
          hit = hit && res;
        }
      }
      this._visibility[i] = hit ? 1.0 : 0.0;
    }
    this.device.queue.writeBuffer(this._visBuffer, 0, this._visibility);
  }

  _evalPredicate(val, pred) {
    switch (pred.op) {
      case 1:
        return val === pred.value;
      case 2:
        return val > pred.value;
      case 3:
        return val < pred.value;
      case 4:
        return val >= pred.value;
      case 5:
        return val <= pred.value;
      case 6:
        return val >= pred.value && val <= pred.high;
      default:
        return true;
    }
  }

  setShardMetadata() {
    this.featureCount = this.data.featureCount || 0;

    // Dynamically initialize or resize GPU data textures if feature count changes
    // This natively handles the transition from an empty boot-stream to real data
    const requiredSize = Math.max(1, Math.ceil(Math.sqrt(this.featureCount)));
    if (requiredSize > this._texSize || !this._posTexA) {
      if (this._posTexA) {
        // Garbage collect old undersized texture rings
        this._posTexA.destroy();
        this._posTexB.destroy();
        this._posTexC.destroy();
        this._posTexD.destroy();
        if (this._hasVelocity) {
          this._velTexA.destroy();
          this._velTexB.destroy();
        }
      }
      this._buildDataTextures();
      this.updateValueBuffer();
    }

    const shardEpochCount = this.data._shardEpochCount || this.epochCount;
    this._shardEpochStart = this.data._shardEpochStart || 0;
    this._shardEpochCount = shardEpochCount;

    // Slow path: force full texture re-upload
    this._currentEpoch = -1;
    if (this._hasVelocity) {
      this._packedVelocity = this._packVelocityRGBA32F();
    }

    // Defer distinct-epoch scan off the swap frame
    this._lastDistinctEpoch = shardEpochCount - 1;
    const geom = this.data.geometry;
    if (geom?.positions && shardEpochCount > 1) {
      setTimeout(() => {
        const n = this.data.featureCount;
        const fpp = this.floatsPerPos;
        for (let epoch = shardEpochCount - 1; epoch > 0; epoch--) {
          const off0 = (epoch - 1) * n * fpp;
          const off1 = epoch * n * fpp;
          let distinct = false;
          for (let i = 0; i < Math.min(3, n) && !distinct; i++) {
            const a = off0 + i * fpp;
            const b = off1 + i * fpp;
            if (
              geom.positions[a] !== geom.positions[b] ||
              geom.positions[a + 1] !== geom.positions[b + 1]
            ) {
              distinct = true;
            }
          }
          if (distinct) {
            this._lastDistinctEpoch = epoch;
            break;
          }
        }
      }, 0);
    }
  }

  /**
   * Re-upload the per-instance value buffer.
   * Must be called on shard switch or when temporal metric epoch changes.
   */
  updateValueBuffer(epochIndex = -1) {
    const colorAttr =
      this.style.color?.attribute ||
      (this.data.staticColumns ? Object.keys(this.data.staticColumns)[0] : null);

    let categoryData = null;
    let isTemporal = false;

    if (colorAttr) {
      if (this.data.staticColumns?.[colorAttr]) {
        categoryData = this.data.staticColumns[colorAttr];
      } else if (this.data.temporalColumns?.[colorAttr]) {
        categoryData = this.data.temporalColumns[colorAttr];
        isTemporal = true;
      }
    }

    this._isTemporalColor = isTemporal;

    const n = this.data.featureCount;
    // Reuse scratch buffer — avoid GC pressure on shard switch
    if (!this._valueScratch || this._valueScratch.length < n) {
      this._valueScratch = new Float32Array(n);
    }
    const valueFloat = this._valueScratch;
    valueFloat.fill(0);
    if (categoryData) {
      // Build remap: shard dictionary index → original dictionary index
      const shardDict = this.data.dictionary || [];
      const origDict = this._origDictionary || [];
      let remap = null;
      if (shardDict.length > 0 && origDict.length > 0 && shardDict !== origDict && !isTemporal) {
        const origLookup = new Map();
        for (let i = 0; i < origDict.length; i++) origLookup.set(origDict[i], i);
        remap = new Int32Array(shardDict.length);
        for (let i = 0; i < shardDict.length; i++) {
          remap[i] = origLookup.has(shardDict[i]) ? origLookup.get(shardDict[i]) : i;
        }
      }

      let offset = 0;
      if (isTemporal) {
        const hasBoundary = !!(this.data._boundaryPackedPositions || this.data._boundaryPositions);
        const origEpochCount = this._shardEpochCount - (hasBoundary ? 1 : 0);
        const e = epochIndex >= 0 ? epochIndex : Math.max(0, this._currentEpoch);
        offset = e >= origEpochCount && this.data._boundaryTemporalCols ? 0 : e * n;
        categoryData =
          e >= origEpochCount && this.data._boundaryTemporalCols
            ? this.data._boundaryTemporalCols[colorAttr]
            : categoryData;
      }

      for (let i = 0; i < n; i++) {
        const raw = categoryData ? categoryData[offset + i] || 0 : 0;
        valueFloat[i] = remap ? remap[raw] : raw;
      }
    }

    // Re-create buffer if feature count changed, otherwise just update
    if (this._valueBuf && valueFloat.byteLength <= this._valueBuf.size) {
      this.device.queue.writeBuffer(this._valueBuf, 0, valueFloat);
    } else {
      if (this._valueBuf) this._valueBuf.destroy();
      this._valueBuf = this.device.createBuffer({
        label: 'GFB values',
        size: valueFloat.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this._valueBuf, 0, valueFloat);
    }

    // Also update visibility buffer if feature count changed
    if (n !== this._visibility.length) {
      this._visibility = new Float32Array(n);
      this._visibility.fill(1.0);
      if (this._visBuffer) this._visBuffer.destroy();
      this._visBuffer = this.device.createBuffer({
        label: 'GFB visibility',
        size: this._visibility.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this._visBuffer, 0, this._visibility);
    }

    this.featureCount = n;
  }

  // ─── Pipeline ───

  _buildPipeline() {
    const device = this.device;

    // Uniform buffer layout (WGSL struct, 16-byte aligned):
    // mat4x4f view        = 64 bytes  (offset 0)
    // mat4x4f projection  = 64 bytes  (offset 64)
    // vec3f camera_right  = 12 bytes  (offset 128)
    // f32 _pad0           = 4 bytes   (offset 140)
    // vec3f camera_up     = 12 bytes  (offset 144)
    // f32 _pad1           = 4 bytes   (offset 156)
    // vec3f camera_pos    = 12 bytes  (offset 160)
    // f32 symbol_scale    = 4 bytes   (offset 172)
    // vec2f domain        = 8 bytes   (offset 176)
    // f32 opacity         = 4 bytes   (offset 184)
    // f32 time            = 4 bytes   (offset 188)
    // f32 tex_size        = 4 bytes   (offset 192)
    // f32 epoch_frac      = 4 bytes   (offset 196)
    // f32 cat_width       = 4 bytes   (offset 200)
    // i32 color_mode      = 4 bytes   (offset 204)
    // i32 symbol_type     = 4 bytes   (offset 208)
    // f32 base_size       = 4 bytes   (offset 212)
    // f32 zoom_near       = 4 bytes   (offset 216)
    // f32 zoom_far        = 4 bytes   (offset 220)
    // f32 zoom_min_scale  = 4 bytes   (offset 224)
    // i32 has_velocity    = 4 bytes   (offset 228)
    // f32 extrusion_scale = 4 bytes   (offset 232)
    // f32 _pad3           = 4 bytes   (offset 236)
    // f32 _pad4           = 4 bytes   (offset 240)
    // Total = 244, rounded to 16 = 256 bytes
    this._uniformBufferSize = 256;
    this.uniformBuffer = device.createBuffer({
      label: 'GFB uniforms',
      size: this._uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._uniformBGL = device.createBindGroupLayout({
      label: 'GFB uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this._dataBGL = device.createBindGroupLayout({
      label: 'GFB data BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 2, visibility: GPUShaderStage.VERTEX, sampler: { type: 'non-filtering' } },
        {
          binding: 3,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float' },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float' },
        },
      ],
    });

    this._rampBGL = device.createBindGroupLayout({
      label: 'GFB ramp BGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'GFB pipeline layout',
      bindGroupLayouts: [this._uniformBGL, this._dataBGL, this._rampBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'GFB shader',
      code: pointWGSL,
    });

    this._dataSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    });
    this._rampSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.pipeline = device.createRenderPipeline({
      label: 'GFB render pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            // Quad vertices (per-vertex)
            arrayStride: 2 * 4,
            stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
          },
          {
            // Value attribute (per-instance)
            arrayStride: 4,
            stepMode: 'instance',
            attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' }],
          },
          {
            // Visibility (per-instance)
            arrayStride: 4,
            stepMode: 'instance',
            attributes: [{ shaderLocation: 2, offset: 0, format: 'float32' }],
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
              // Additive blending — matches WebGL's glBlendFunc(SRC_ALPHA, ONE)
              color: { srcFactor: 'src-alpha', dstFactor: 'one' },
              alpha: { srcFactor: 'src-alpha', dstFactor: 'one' },
            },
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none', // Billboards face camera
      },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false, // No depth write
        depthCompare: 'always', // No depth test (horizon check in shader)
      },
    });

    this._uniformBindGroup = device.createBindGroup({
      label: 'GFB uniform BG',
      layout: this._uniformBGL,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  // ─── Buffers ───

  _buildBuffers() {
    const device = this.device;

    // Quad vertices (2 triangles = 6 verts)
    const quadVerts = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
    this._quadBuffer = device.createBuffer({
      label: 'GFB quad',
      size: quadVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._quadBuffer, 0, quadVerts);

    // Value attribute (per-instance)
    this.floatsPerPos = this.data.geometry?.floatsPerPos || 2;
    const colorAttr =
      this.style.color?.attribute ||
      (this.data.staticColumns ? Object.keys(this.data.staticColumns)[0] : null);

    let categoryData = null;
    if (colorAttr) {
      if (this.data.staticColumns?.[colorAttr]) {
        categoryData = this.data.staticColumns[colorAttr];
      } else if (this.data.temporalColumns?.[colorAttr]) {
        categoryData = this.data.temporalColumns[colorAttr];
      }
    }

    const valueFloat = new Float32Array(this.featureCount);
    if (categoryData) {
      for (let i = 0; i < this.featureCount; i++) {
        valueFloat[i] = categoryData[i];
      }
    }
    this._valueBuf = device.createBuffer({
      label: 'GFB values',
      size: valueFloat.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._valueBuf, 0, valueFloat);

    // Visibility (per-instance, dynamic)
    this._visBuffer = device.createBuffer({
      label: 'GFB visibility',
      size: this._visibility.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._visBuffer, 0, this._visibility);
  }

  // ─── Data Textures (RGBA32F) ───

  _buildDataTextures() {
    const device = this.device;
    // Always fall back to 1x1 if featureCount is 0 to avoid NaN size errors
    this._texSize = Math.max(1, Math.ceil(Math.sqrt(this.featureCount || 0)));

    const createPosTex = (label) =>
      device.createTexture({
        label,
        size: [this._texSize, this._texSize, 1], // Explicit depth 1 for strict WebIDL compliance
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });

    this._posTexA = createPosTex('GFB pos A');
    this._posTexB = createPosTex('GFB pos B');
    this._posTexC = createPosTex('GFB pos C');
    this._posTexD = createPosTex('GFB pos D');

    // Rolling window: 4 texture slots for Catmull-Rom
    // _posTex[0]=prev, [1]=current, [2]=next, [3]=next2
    this._posTex = [this._posTexA, this._posTexB, this._posTexC, this._posTexD];
    this._posSlot = [0, 1, 2, 3]; // which physical texture is in which logical slot

    this._posTexBuf = new Float32Array(this._texSize * this._texSize * 4);

    // Velocity textures (for heading from ewvelocity/nsvelocity)
    this._velTexA = createPosTex('GFB vel A');
    this._velTexB = createPosTex('GFB vel B');
    this._velCurrent = this._velTexA;
    this._velNext = this._velTexB;
    if (this._hasVelocity) {
      this._velTexBuf = new Float32Array(this._texSize * this._texSize * 4);
    }

    this._rebuildDataBindGroup();
    this._rebuildRampBindGroup();

    // Pre-build all 4 rotated bind groups for zero-alloc epoch advances.
    // Each represents a different rotation of the 4 position textures.
    this._buildAllRotatedBindGroups();
  }

  _rebuildDataBindGroup() {
    // Logical slots: [0]=prev, [1]=current, [2]=next, [3]=next2
    const s = this._posSlot;
    this._dataBindGroup = this.device.createBindGroup({
      label: 'GFB data BG',
      layout: this._dataBGL,
      entries: [
        { binding: 0, resource: this._posTex[s[1]].createView() }, // current (e0)
        { binding: 1, resource: this._posTex[s[2]].createView() }, // next (e1)
        { binding: 2, resource: this._dataSampler },
        { binding: 3, resource: this._velCurrent.createView() },
        { binding: 4, resource: this._velNext.createView() },
        { binding: 5, resource: this._posTex[s[0]].createView() }, // prev (e-1)
        { binding: 6, resource: this._posTex[s[3]].createView() }, // next2 (e+2)
      ],
    });
  }

  /**
   * Pre-build bind groups for all 4 rotation states of the position texture ring.
   * Sequential epoch advances just pick the next pre-built bind group — zero allocation.
   * Called once at init and after any jump (which resets slot order).
   */
  _buildAllRotatedBindGroups() {
    this._rotatedBindGroups = this._buildRotatedBindGroupsFor(this._posTex);
    this._rotationIdx = 0;
  }

  /**
   * Build rotated bind groups for a given texture array.
   * Used for both primary textures and spare (pre-upload) textures.
   */
  _buildRotatedBindGroupsFor(texArray) {
    const groups = [];
    const base = [0, 1, 2, 3];
    for (let r = 0; r < 4; r++) {
      const s = [base[(r + 0) % 4], base[(r + 1) % 4], base[(r + 2) % 4], base[(r + 3) % 4]];
      groups.push({
        slot: s,
        bg: this.device.createBindGroup({
          label: `GFB data BG rot${r}`,
          layout: this._dataBGL,
          entries: [
            { binding: 0, resource: texArray[s[1]].createView() },
            { binding: 1, resource: texArray[s[2]].createView() },
            { binding: 2, resource: this._dataSampler },
            { binding: 3, resource: this._velCurrent.createView() },
            { binding: 4, resource: this._velNext.createView() },
            { binding: 5, resource: texArray[s[0]].createView() },
            { binding: 6, resource: texArray[s[3]].createView() },
          ],
        }),
      });
    }
    return groups;
  }

  _rebuildRampBindGroup() {
    const tex = this.style.color?.texture;
    if (!tex) return;
    this._rampBindGroup = this.device.createBindGroup({
      label: 'GFB ramp BG',
      layout: this._rampBGL,
      entries: [
        { binding: 0, resource: tex.createView() },
        { binding: 1, resource: this._rampSampler },
      ],
    });
  }

  // ─── Position Texture Upload ───

  _uploadEpochToTex(texture, epochIndex) {
    const geom = this.data.geometry;
    if (!geom) return;

    const packed = geom.packedPositions;
    if (packed) {
      // Zero-copy: subarray from pre-packed RGBA32F data
      const texelsPerEpoch = packed._texelsPerEpoch;

      // Check if this is the boundary epoch (beyond original shard data)
      const hasBoundary = !!(this.data._boundaryPackedPositions || this.data._boundaryPositions);
      const origEpochCount = this._shardEpochCount - (hasBoundary ? 1 : 0);
      let slice;
      if (epochIndex >= origEpochCount && this.data._boundaryPackedPositions) {
        // Boundary epoch: pre-packed from next shard's first epoch
        slice = this.data._boundaryPackedPositions;
      } else {
        const off = epochIndex * texelsPerEpoch * 4;
        slice = packed.subarray(off, off + texelsPerEpoch * 4);
      }

      // Guard: skip if slice is empty (shard not yet loaded)
      if (!slice || slice.length === 0) return;

      let uploadSlice = slice;
      const expectedLen = this._texSize * this._texSize * 4;
      if (slice.length !== expectedLen) {
        // Re-align smaller or mismatched shard byte boundaries to the global texture stride.
        // WebGPU will violently panic if bytesPerRow (or array length) fails the 2D stride check.
        // Reuse a cached scratch buffer to avoid per-frame GC pressure.
        if (!this._padScratch || this._padScratch.length < expectedLen) {
          this._padScratch = new Float32Array(expectedLen);
        }
        this._padScratch.fill(0);
        this._padScratch.set(slice.subarray(0, Math.min(slice.length, expectedLen)));
        uploadSlice = this._padScratch.subarray(0, expectedLen);
      }

      this.device.queue.writeTexture(
        { texture },
        uploadSlice,
        { bytesPerRow: this._texSize * 4 * 4 },
        [this._texSize, this._texSize, 1]
      );
      return;
    }

    // Fallback: original CPU loop for non-packed data
    if (!geom.positions) return;
    const n = this.featureCount;
    const fpp = this.floatsPerPos;
    const buf = this._posTexBuf;
    const hasBoundary = !!(this.data._boundaryPackedPositions || this.data._boundaryPositions);
    const origEpochCount = this._shardEpochCount - (hasBoundary ? 1 : 0);
    let positions, off;
    if (epochIndex >= origEpochCount && this.data._boundaryPositions) {
      positions = this.data._boundaryPositions;
      off = 0;
    } else {
      positions = geom.positions;
      off = epochIndex * n * fpp;
    }
    for (let i = 0; i < n; i++) {
      const src = off + i * fpp;
      const dst = i * 4;
      buf[dst] = positions[src];
      buf[dst + 1] = positions[src + 1];
      buf[dst + 2] = fpp >= 3 ? positions[src + 2] : 0;
    }
    this.device.queue.writeTexture({ texture }, buf, { bytesPerRow: this._texSize * 4 * 4 }, [
      this._texSize,
      this._texSize,
    ]);
  }

  /**
   * Upload one epoch's velocity data (ewvelocity, nsvelocity) to an RGBA32F texture.
   */
  _uploadVelocityToTex(texture, epochIndex) {
    if (!this._hasVelocity) return;

    const packed = this._packedVelocity;
    if (packed) {
      // Zero-copy: subarray from pre-packed RGBA32F velocity data
      const texelsPerEpoch = packed._texelsPerEpoch;
      const off = epochIndex * texelsPerEpoch * 4;
      const slice = packed.subarray(off, off + texelsPerEpoch * 4);
      this.device.queue.writeTexture({ texture }, slice, { bytesPerRow: this._texSize * 4 * 4 }, [
        this._texSize,
        this._texSize,
      ]);
      return;
    }

    // Fallback: original CPU loop
    if (!this._velTexBuf) {
      this._velTexBuf = new Float32Array(this._texSize * this._texSize * 4);
    }
    const n = this.featureCount;
    const buf = this._velTexBuf;
    const ewCol = this.data.temporalColumns?.[this._ewVelocityCol];
    const nsCol = this.data.temporalColumns?.[this._nsVelocityCol];
    if (!ewCol || !nsCol) return;
    const off = epochIndex * n;
    for (let i = 0; i < n; i++) {
      const dst = i * 4;
      buf[dst] = ewCol[off + i] || 0;
      buf[dst + 1] = nsCol[off + i] || 0;
    }
    this.device.queue.writeTexture({ texture }, buf, { bytesPerRow: this._texSize * 4 * 4 }, [
      this._texSize,
      this._texSize,
    ]);
  }

  /**
   * Pre-pack velocity columns into RGBA32F layout at init time.
   */
  _packVelocityRGBA32F() {
    const ewCol = this.data.temporalColumns?.[this._ewVelocityCol];
    const nsCol = this.data.temporalColumns?.[this._nsVelocityCol];
    if (!ewCol || !nsCol) return null;

    const n = this.featureCount;
    const epochCount = this._shardEpochCount || this.epochCount;
    const origEpochCount = this.data._boundaryTemporalCols ? epochCount - 1 : epochCount;
    const texSize = this._texSize;
    const texelsPerEpoch = texSize * texSize;
    const totalFloats = epochCount * texelsPerEpoch * 4;

    // Reuse existing buffer if size matches (avoids allocation on shard switch)
    let packed = this._packedVelocity;
    if (!packed || packed.length !== totalFloats) {
      packed = new Float32Array(totalFloats);
    } else {
      packed.fill(0); // Clear for reuse
    }

    for (let e = 0; e < epochCount; e++) {
      const isBoundary = e >= origEpochCount;
      const srcEwCol = isBoundary ? this.data._boundaryTemporalCols?.[this._ewVelocityCol] : ewCol;
      const srcNsCol = isBoundary ? this.data._boundaryTemporalCols?.[this._nsVelocityCol] : nsCol;

      if (!srcEwCol || !srcNsCol) continue;

      const srcBase = isBoundary ? 0 : e * n;
      const dstBase = e * texelsPerEpoch * 4;
      for (let i = 0; i < n; i++) {
        const dst = dstBase + i * 4;
        packed[dst] = srcEwCol[srcBase + i] || 0;
        packed[dst + 1] = srcNsCol[srcBase + i] || 0;
      }
    }

    packed._texSize = texSize;
    packed._texelsPerEpoch = texelsPerEpoch;
    return packed;
  }

  // ─── Pre-render texture preparation ───
  // Must be called BEFORE beginRenderPass() so that writeTexture
  // completes before the render pass reads the data.

  prepareTextures(normalizedTime) {
    const geom = this.data.geometry;
    if (!geom || (!geom.positions && !geom.packedPositions)) return;

    // Live-sync: ring growth from _updateLiveEdge changes data.epochCount
    // between shard switches — keep our mapping in sync every frame.
    if (this.data.epochCount) this.epochCount = this.data.epochCount;

    const shardEpochCount = this._shardEpochCount;
    const globalEpoch = normalizedTime * (this.epochCount - 1);
    const localEpoch = globalEpoch - this._shardEpochStart;

    const t = Math.max(0, Math.min(localEpoch, shardEpochCount - 1));
    let e0 = Math.min(Math.floor(t), Math.max(shardEpochCount - 2, 0));
    let e1 = Math.min(e0 + 1, shardEpochCount - 1);
    const frac = t - e0;

    // Live-edge fix: clamp to the last distinct epoch pair (pre-computed
    // in setShardMetadata to avoid per-frame position comparisons).
    if (e1 > this._lastDistinctEpoch && this._lastDistinctEpoch > 0) {
      e1 = this._lastDistinctEpoch;
      e0 = e1 - 1;
    }

    // Catmull-Rom: compute the 4 epoch indices
    // ePrev = e0-1 (clamp to 0), eNext2 = e1+1 (clamp to last)
    const ePrev = Math.max(0, e0 - 1);
    const eNext2 = Math.min(e1 + 1, shardEpochCount - 1);

    // Store for render() to use
    this._computedFrac = frac;

    // 4-texture rolling window epoch management
    if (e0 !== this._currentEpoch) {
      if (this._currentEpoch === -1 || Math.abs(e0 - this._currentEpoch) > 1) {
        // Jump: upload all 4 epochs
        this._uploadEpochToTex(this._posTex[0], ePrev);
        this._uploadEpochToTex(this._posTex[1], e0);
        this._uploadEpochToTex(this._posTex[2], e1);
        this._uploadEpochToTex(this._posTex[3], eNext2);
        this._posSlot = [0, 1, 2, 3];

        if (this._hasVelocity) {
          this._uploadVelocityToTex(this._velTexA, e0);
          this._uploadVelocityToTex(this._velTexB, e1);
          this._velCurrent = this._velTexA;
          this._velNext = this._velTexB;
        }
      } else {
        // Sequential advance: rotate slots left.
        // Old prev texture is freed; becomes the new next2.
        const freedSlot = this._posSlot[0];
        this._posSlot[0] = this._posSlot[1]; // prev ← old current
        this._posSlot[1] = this._posSlot[2]; // current ← old next
        this._posSlot[2] = this._posSlot[3]; // next ← old next2
        this._posSlot[3] = freedSlot; // next2 ← freed (was prev)
        // Upload only the new next2 epoch
        this._uploadEpochToTex(this._posTex[freedSlot], eNext2);

        if (this._hasVelocity) {
          const vtmp = this._velCurrent;
          this._velCurrent = this._velNext;
          this._velNext = vtmp;
          this._uploadVelocityToTex(this._velNext, e1);
        }
      }
      this._rebuildDataBindGroup();
      this._currentEpoch = e0;
      if (this._isTemporalColor) {
        this.updateValueBuffer(e0);
      }
    }
  }

  // ─── Render ───

  render(projection, ctx) {
    if (projection.mode === 'spherical') {
      this._renderSpherical(ctx);
    } else if (projection.mode === 'mercator') {
      this._renderMercator(ctx);
    }
  }

  /**
   * Spherical render path (relocated from render()).
   * Body is VERBATIM — no behavior changes.
   * @private
   */
  _buildMercPipeline() {
    const device = this.device;

    // 80-byte uniform buffer (20 × f32) — includes first_copy for world copies
    this._mercUniformBufferSize = 80;
    this._mercUniformBuffer = device.createBuffer({
      label: 'GFB Merc uniforms',
      size: this._mercUniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._mercUniformBGL = device.createBindGroupLayout({
      label: 'GFB Merc uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'GFB Merc pipeline layout',
      bindGroupLayouts: [this._mercUniformBGL, this._dataBGL, this._rampBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'GFB Merc shader',
      code: pointMercWGSL,
    });

    this._mercPipeline = device.createRenderPipeline({
      label: 'GFB Merc render pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        // No quad vertex buffer: the merc shader derives the billboard
        // corner from @builtin(vertex_index) so world copies can be packed
        // into the vertex dimension (6 × copyCount verts per instance).
        buffers: [
          {
            // Value attribute (per-instance)
            arrayStride: 4,
            stepMode: 'instance',
            attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' }],
          },
          {
            // Visibility (per-instance)
            arrayStride: 4,
            stepMode: 'instance',
            attributes: [{ shaderLocation: 2, offset: 0, format: 'float32' }],
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
              color: { srcFactor: 'src-alpha', dstFactor: 'one' },
              alpha: { srcFactor: 'src-alpha', dstFactor: 'one' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
    });

    this._mercUniformBindGroup = device.createBindGroup({
      label: 'GFB Merc uniform BG',
      layout: this._mercUniformBGL,
      entries: [{ binding: 0, resource: { buffer: this._mercUniformBuffer } }],
    });

    this._mercUniformScratch = new ArrayBuffer(this._mercUniformBufferSize);
    this._mercF32 = new Float32Array(this._mercUniformScratch);
    this._mercI32 = new Int32Array(this._mercUniformScratch);
  }

  _renderSpherical(ctx) {
    const { passEncoder, viewMatrix, projMatrix, cameraPosition, normalizedTime } = ctx;

    const geom = this.data.geometry;
    if (!geom || (!geom.positions && !geom.packedPositions)) return;
    if (!this._rampBindGroup) return;

    let frac;
    if (this._computedFrac !== undefined) {
      // prepareTextures() already ran — textures are ready, use pre-computed frac
      frac = this._computedFrac;
      this._computedFrac = undefined; // consumed
    } else {
      // WebGL2 fallback: do texture uploads inline
      // Live-sync epochCount from ring total
      if (this.data.epochCount) this.epochCount = this.data.epochCount;

      const shardEpochCount = this._shardEpochCount;
      const globalEpoch = normalizedTime * (this.epochCount - 1);
      const localEpoch = globalEpoch - this._shardEpochStart;

      const t = Math.max(0, Math.min(localEpoch, shardEpochCount - 1));
      const e0 = Math.min(Math.floor(t), Math.max(shardEpochCount - 2, 0));
      const e1 = Math.min(e0 + 1, shardEpochCount - 1);
      frac = t - e0;

      const ePrev = Math.max(0, e0 - 1);
      const eNext2 = Math.min(e1 + 1, shardEpochCount - 1);

      // 4-texture rolling window (same as prepareTextures)
      if (e0 !== this._currentEpoch) {
        if (this._currentEpoch === -1 || Math.abs(e0 - this._currentEpoch) > 1) {
          this._uploadEpochToTex(this._posTex[0], ePrev);
          this._uploadEpochToTex(this._posTex[1], e0);
          this._uploadEpochToTex(this._posTex[2], e1);
          this._uploadEpochToTex(this._posTex[3], eNext2);
          this._posSlot = [0, 1, 2, 3];
          if (this._hasVelocity) {
            this._uploadVelocityToTex(this._velTexA, e0);
            this._uploadVelocityToTex(this._velTexB, e1);
            this._velCurrent = this._velTexA;
            this._velNext = this._velTexB;
          }
        } else {
          const freedSlot = this._posSlot[0];
          this._posSlot[0] = this._posSlot[1];
          this._posSlot[1] = this._posSlot[2];
          this._posSlot[2] = this._posSlot[3];
          this._posSlot[3] = freedSlot;
          this._uploadEpochToTex(this._posTex[freedSlot], eNext2);
          if (this._hasVelocity) {
            const vtmp = this._velCurrent;
            this._velCurrent = this._velNext;
            this._velNext = vtmp;
            this._uploadVelocityToTex(this._velNext, e1);
          }
        }
        this._rebuildDataBindGroup();
        this._currentEpoch = e0;
      }
    }

    // Camera billboard vectors from view matrix (reuse pre-allocated — zero GC)
    const camRight = this._camRight;
    const camUp = this._camUp;
    camRight[0] = viewMatrix[0];
    camRight[1] = viewMatrix[4];
    camRight[2] = viewMatrix[8];
    camUp[0] = viewMatrix[1];
    camUp[1] = viewMatrix[5];
    camUp[2] = viewMatrix[9];

    // Color mode
    const colorType = this.style.color?.type;
    let colorMode = 0;
    if (colorType === 'ramp') colorMode = 1;
    else if (colorType === 'categorical' || colorType === 'constant') colorMode = 2;

    // Write uniforms (reuse pre-allocated scratch buffer — zero GC pressure)
    const f32 = this._uniformF32;
    const i32 = this._uniformI32;

    f32.set(viewMatrix, 0); // offset 0: view mat4
    f32.set(projMatrix, 16); // offset 64: projection mat4
    f32[32] = camRight[0]; // offset 128: camera_right
    f32[33] = camRight[1];
    f32[34] = camRight[2];
    // f32[35] = _pad0
    f32[36] = camUp[0]; // offset 144: camera_up
    f32[37] = camUp[1];
    f32[38] = camUp[2];
    // f32[39] = _pad1
    f32[40] = cameraPosition[0]; // offset 160: camera_position
    f32[41] = cameraPosition[1];
    f32[42] = cameraPosition[2];
    f32[43] = this._symbolScale; // offset 172: symbol_scale
    const domain = this.style.color?.domain || [0, 1];
    f32[44] = domain[0]; // offset 176: domain.x
    f32[45] = domain[1]; // offset 180: domain.y
    const opacity = this.style.opacity?.type === 'constant' ? this.style.opacity.value : 0.9;
    f32[46] = opacity; // offset 184: opacity
    f32[47] = performance.now() / 1000.0; // offset 188: time
    f32[48] = this._texSize; // offset 192: tex_size
    f32[49] = frac; // offset 196: epoch_frac
    f32[50] = this.style.color?.width || 256.0; // offset 200: cat_width
    i32[51] = colorMode; // offset 204: color_mode
    i32[52] = this._symbolType; // offset 208: symbol_type
    f32[53] = this._baseSize; // offset 212: base_size
    f32[54] = this._zoomNear; // offset 216: zoom_near
    f32[55] = this._zoomFar; // offset 220: zoom_far
    f32[56] = this._zoomMinScale; // offset 224: zoom_min_scale
    i32[57] = this._hasVelocity ? 1 : 0; // offset 228: has_velocity
    f32[58] = this._extrusionScale; // offset 232: extrusion_scale
    // f32[59,60] = padding

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformScratch);

    // Draw
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this._uniformBindGroup);
    passEncoder.setBindGroup(1, this._dataBindGroup);
    passEncoder.setBindGroup(2, this._rampBindGroup);
    passEncoder.setVertexBuffer(0, this._quadBuffer);
    passEncoder.setVertexBuffer(1, this._valueBuf);
    passEncoder.setVertexBuffer(2, this._visBuffer);
    passEncoder.draw(6, this.featureCount);
  }

  /**
   * Mercator render path (relocated from renderMercator()).
   * Body is VERBATIM — no behavior changes.
   * @private
   */
  _renderMercator(ctx) {
    const { passEncoder, camera, viewportW, viewportH, normalizedTime } = ctx;

    if (!this._mercPipeline) this._buildMercPipeline();
    if (!this._rampBindGroup) return;
    const geom = this.data.geometry;
    if (!geom || (!geom.positions && !geom.packedPositions)) return;

    // Use frac from prepareTextures() if available (called by LayerManager)
    const frac = this._computedFrac ?? 0;

    // Camera → world pixels
    const TILE_PX = 256;
    const worldSize = TILE_PX * Math.pow(2, camera.zoom);
    const sinLat = Math.sin((camera.lat * Math.PI) / 180);
    const cameraX = ((camera.lng + 180) / 360) * worldSize;
    const cameraY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;

    const colorType = this.style.color?.type;
    let colorMode = 0;
    if (colorType === 'ramp') colorMode = 1;
    else if (colorType === 'categorical' || colorType === 'constant') colorMode = 2;

    const domain = this.style.color?.domain || [0, 1];
    const opacity = this.style.opacity?.type === 'constant' ? this.style.opacity.value : 0.9;
    // pixel_size: linear-in-zoom ramp so points stay readable at low zoom and
    // grow at high zoom (matches the spherical near/far attenuation feel).
    // Clamp so points neither vanish at world view nor swamp the screen close in.
    const zoomScale = Math.max(0.5, Math.min(2.5, 0.5 + 0.18 * camera.zoom));
    const pixelSize = 8.0 * zoomScale * this._symbolScale;

    const f32 = this._mercF32;
    const i32 = this._mercI32;
    f32[0] = worldSize;
    f32[1] = this._texSize;
    f32[2] = cameraX;
    f32[3] = cameraY;
    f32[4] = viewportW;
    f32[5] = viewportH;
    f32[6] = domain[0];
    f32[7] = domain[1];
    f32[8] = frac;
    f32[9] = opacity;
    i32[10] = colorMode;
    f32[11] = this.style.color?.width || 256.0; // cat_width
    f32[12] = pixelSize;
    i32[13] = this._symbolType;
    f32[14] = performance.now() / 1000.0;
    i32[15] = this._hasVelocity ? 1 : 0;

    // Horizontal world copies: repeat each billboard once per visible world
    // copy so points wrap across the antimeridian like the Mercator tiles.
    // Copies live in the vertex dimension (6 verts each); the shader derives
    // corner = vi % 6 and copy = vi / 6.
    const { firstCopy, copyCount } = computeWorldCopies(
      cameraX,
      worldSize,
      viewportW,
      camera.renderWorldCopies
    );
    f32[16] = firstCopy; // offset 64: first_copy

    this.device.queue.writeBuffer(this._mercUniformBuffer, 0, this._mercUniformScratch);

    passEncoder.setPipeline(this._mercPipeline);
    passEncoder.setBindGroup(0, this._mercUniformBindGroup);
    passEncoder.setBindGroup(1, this._dataBindGroup);
    passEncoder.setBindGroup(2, this._rampBindGroup);
    passEncoder.setVertexBuffer(0, this._valueBuf);
    passEncoder.setVertexBuffer(1, this._visBuffer);
    passEncoder.draw(6 * copyCount, this.featureCount);
  }

  // ─── Lifecycle ───

  dispose() {
    this._posTexA?.destroy();
    this._posTexB?.destroy();
    this._posTexC?.destroy();
    this._posTexD?.destroy();
    this._velTexA?.destroy();
    this._velTexB?.destroy();
    this._quadBuffer?.destroy();
    this._valueBuf?.destroy();
    this._visBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this._mercUniformBuffer?.destroy();
    if (this.style) this.style.disposeGPU();
    this._posTexBuf = null;
    this._velTexBuf = null;
    this._packedVelocity = null;
    this._posTex = null;
    this._posSlot = null;
    this._rotatedBindGroups = null;
    this._visibility = null;
    this._filterPredicates = null;
    this._uniformScratch = null;
    this._uniformF32 = null;
    this._uniformI32 = null;
    this._camRight = null;
    this._camUp = null;
    this._mercUniformScratch = null;
    this._mercF32 = null;
    this._mercI32 = null;
  }
}
