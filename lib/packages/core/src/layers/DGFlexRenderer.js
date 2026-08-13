/**
 * DGFlexRenderer.js — WebGPU implementation of DGFlex hexagonal rendering.
 *
 * Architecture (matching WebGL2’s per-epoch approach):
 *   - Pre-computed mesh from the generator (zero CPU geometry work)
 *   - Dual R32F data textures for ping-pong temporal interpolation
 *   - Direct CPU→texture writes for epoch data (~5.7MB per epoch)
 *   - GPU filter support (up to 2 predicates with AND/OR combinator)
 *   - 3D pillar extrusion via vertex shader
 *   - GPU compute histogram (on-demand temporary storage buffer)
 *
 * Key optimization: only the 1-2 epochs needed per frame are uploaded
 * via queue.writeTexture. Pre-upload writes the next shard’s first
 * epochs to spare textures for zero-stall shard swaps.
 */

import { StyleEngine } from '../styles/StyleEngine.js';
import { splitMercatorMesh } from '../util/mercatorBake.js';
import hexWGSL from './shaders/dgflex.wgsl?raw';
import hexMercWGSL from './shaders/dgflex.merc.wgsl?raw';
import histogramWGSL from './shaders/histogram_reduce.wgsl?raw';

// Mercator uniform buffer: 24 × f32 = 96 bytes.
const MERC_UB_SIZE = 96;
// Headroom for antimeridian-split extra verts/indices in Mercator buffers.
const MERC_SPLIT_HEADROOM = 0.01;
const MERC_SPLIT_MIN = 1024;

// Unit conversion: spherical extrusion_scale (ECEF, Earth-radius = 1) → world-pixels at zoom-0.
// At zoom 0, worldSize = 256 px = Earth circumference = 2π Earth-radii.
// So 1 ECEF unit = 256 / (2π) ≈ 40.74 zoom-0 world-pixels.
const MERC_EXTRUSION_FACTOR = 256 / (2 * Math.PI);

export class DGFlexRenderer {
  /**
   * @param {GPUDevice} device
   * @param {string} format - Canvas texture format
   * @param {string} depthFormat - Depth texture format
   * @param {Object} data - Decoded DGFlex data from DGFlexDecoder
   * @param {Object} [compiledStyle] - CompiledStyle from StyleEngine.compileGPU()
   */
  constructor(device, format, depthFormat, data, compiledStyle) {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
    this.data = data;
    this.cellCount = data.cellCount;
    this.epochCount = data.epochCount;

    if (!data.mesh) {
      throw new Error('[DGFlexRenderer] DGFlex data has no pre-computed mesh.');
    }

    // Default style fallback
    if (!compiledStyle) {
      const temporalAttrs = data.temporalAttributes || [];
      const firstAttr = temporalAttrs[0]?.name || 'value';
      const defaultSpec = StyleEngine.ramp({
        attribute: firstAttr,
        domain: [0, 100],
        stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319'],
        opacityStops: [
          { value: 0, opacity: 0.0 },
          { value: 5, opacity: 0.3 },
          { value: 25, opacity: 0.55 },
          { value: 60, opacity: 0.75 },
          { value: 100, opacity: 0.9 },
        ],
      });
      compiledStyle = StyleEngine.compileGPU(device, defaultSpec, data.dictionary || []);
    }

    this.style = compiledStyle;
    this._colorAttr = compiledStyle.color?.attribute || 'value';
    this._domain = compiledStyle.color?.domain || [0, 100];
    this._opacity = compiledStyle.opacity?.type === 'constant' ? compiledStyle.opacity.value : 0.7;

    this._buildPipeline();
    this._buildMesh();
    this._buildMercPipeline(); // Mercator flat-map pipeline (reuses data/ramp BGLs)
    this._buildDataTextures();
    this._initShardMetadata();

    this._currentEpoch = -1;
    this._initialized = false;
    this._extrusionScale = 0.012;
    this._pendingCompute = []; // queued compute dispatches

    // Pre-allocated scratch buffer for per-frame uniform writes (zero GC pressure)
    this._uniformScratch = new ArrayBuffer(this._uniformBufferSize);
    this._uniformF32 = new Float32Array(this._uniformScratch);
    this._uniformI32 = new Int32Array(this._uniformScratch);

    // Mercator uniform scratch (24 × f32 = 96 bytes)
    this._mercUniformScratch = new ArrayBuffer(MERC_UB_SIZE);
    this._mercUniformF32 = new Float32Array(this._mercUniformScratch);
    this._mercUniformI32 = new Int32Array(this._mercUniformScratch);

    // Histogram compute pipeline
    this._buildHistogramPipeline();

    // Filter state
    this._filterPredicates = null;
    this._filterCombinator = 0;
  }

  setExtrusionScale(scale) {
    this._extrusionScale = Math.max(0, scale);
  }
  get extrusionScale() {
    return this._extrusionScale;
  }
  get activeAttribute() {
    return this._colorAttr;
  }

  setActiveAttribute(attrName) {
    if (attrName === this._colorAttr) return;
    this._colorAttr = attrName;
    this._currentEpoch = -1;
    this._initialized = false;
  }

  setStyle(compiledStyle) {
    const oldStyle = this.style;
    this.style = compiledStyle;
    this._colorAttr = compiledStyle.color?.attribute || 'value';
    this._domain = compiledStyle.color?.domain || [0, 100];
    this._opacity = compiledStyle.opacity?.type === 'constant' ? compiledStyle.opacity.value : 0.7;

    // Rebuild ramp bind group with new texture
    this._rebuildRampBindGroup();

    if (oldStyle) oldStyle.disposeGPU();
    this._currentEpoch = -1;
    this._initialized = false;
    this._pendingCompute = [];
    this._initShardMetadata();
  }

  setFilter(gpuFilter) {
    if (!gpuFilter || gpuFilter.predicates.length === 0) {
      this.clearFilter();
      return;
    }
    this._filterCombinator = gpuFilter.combinator === 'OR' ? 1 : 0;
    this._filterPredicates = gpuFilter.predicates.map((pred) => {
      const isActiveMetric = pred.column === this._colorAttr;
      const target = isActiveMetric ? 0 : 1;
      if (!isActiveMetric) {
        this._uploadFilterColumn(pred.column);
      }
      return { op: pred.op, value: pred.value, high: pred.high || 0, target };
    });
  }

  clearFilter() {
    this._filterPredicates = null;
    this._filterCombinator = 0;
    this._sqlMaskActive = false;
  }

  /**
   * Set a SQL-driven visibility mask. Writes to filter texture and sets
   * filter uniforms to use mask values (>= 1.0 = visible).
   * @param {Float32Array} mask - Float32Array[cellCount], 1.0=visible, 0.0=hidden
   */
  setVisibilityMask(mask) {
    // Write mask to filter texture
    if (!this._filterTexBuf) return;
    this._filterTexBuf.fill(0);
    this._filterTexBuf.set(mask.subarray(0, Math.min(mask.length, this.cellCount)));

    this.device.queue.writeTexture(
      { texture: this._filterTex },
      this._filterTexBuf,
      { bytesPerRow: this._texSize * 4 },
      [this._texSize, this._texSize]
    );

    // Set filter to: filterTarget=1 (filter texture), op >= 1.0
    this._filterPredicates = [{ op: 5, value: 0.5, high: 0, target: 1 }];
    this._filterCombinator = 0;
    this._sqlMaskActive = true;
  }

  /**
   * Clear a SQL-driven visibility mask.
   */
  clearVisibilityMask() {
    this._sqlMaskActive = false;
    this.clearFilter();
  }

  /**
   * Write one epoch's data directly to a texture from CPU data.
   * Lightweight alternative to compute scatter (~5.7MB vs storage buffer upload).
   * Mirrors WebGL2's _uploadEpochToTexImmediate approach.
   * Uses a fast slice-copy into a 16900-float direct-write buffer.
   */
  _directWriteToTex(texture, globalEpoch) {
    const colorAttr = this._colorAttr;
    const texArea = this._texSize * this._texSize;

    // ── Fast path: direct write from CPU slice ──
    // Only allocates one 16,900-float buffer per layer instead of ~4MB per shard.
    // Slice copy (16,807 floats) takes <0.1ms per frame — zero jitter.
    if (!this._directWriteBuf || this._directWriteBuf.length !== texArea) {
      this._directWriteBuf = new Float32Array(texArea);
    }
    const buf = this._directWriteBuf;
    const cellCount = this.cellCount;

    if (this._shardIsStatic) {
      const attrData = this.data.staticColumns?.[colorAttr];
      if (attrData) {
        buf.set(attrData.subarray(0, Math.min(cellCount, attrData.length)));
      }
    } else {
      const attrData = this.data.temporalColumns?.[colorAttr];
      if (attrData) {
        const shardStart = this.data._shardEpochStart || 0;
        const localEpoch = globalEpoch - shardStart;
        const origShardCount =
          (this.data._shardEpochCount || this.epochCount) -
          (this.data._boundaryEpochs?.[colorAttr] ? 1 : 0);

        let slice;
        if (localEpoch >= origShardCount && this.data._boundaryEpochs?.[colorAttr]) {
          const colBoundary = this.data._boundaryEpochs[colorAttr];
          buf.set(colBoundary.subarray(0, this.cellCount));
        } else {
          const clamped = Math.max(0, Math.min(localEpoch, origShardCount - 1));
          const off = clamped * cellCount;
          slice = attrData.subarray(off, off + cellCount);
          buf.set(slice);
        }
      }
    }
    this.device.queue.writeTexture(
      { texture },
      buf,
      { bytesPerRow: this._texSize * 4, rowsPerImage: this._texSize },
      { width: this._texSize, height: this._texSize }
    );
  }
  /**
   * Initialize shard metadata without any GPU uploads.
   * All epoch data is uploaded per-frame via _directWriteToTex,
   * so no bulk storage buffer is needed.
   */
  _initShardMetadata() {
    this._shardIsStatic = !this.data.temporalColumns?.[this._colorAttr];
    this._shardStart = this.data._shardEpochStart || 0;
    this._shardEpochCount = this._shardIsStatic
      ? 1
      : (this.data._shardEpochCount || this.epochCount) -
        (this.data._boundaryEpochs?.[this._colorAttr] ? 1 : 0);

    // Ensure _currentEpoch forces a full write-through on shard cycle
    this._currentEpoch = -1;
  }

  // ─── Pipeline ───

  _buildPipeline() {
    const device = this.device;

    // Uniform buffer layout (aligned to 16 bytes):
    // mat4 view(64) + mat4 proj(64) + vec2 domain(8) + f32 texSize(4) + f32 epochFrac(4)
    // + f32 opacity(4) + f32 extrusionScale(4) + i32 filterCombinator(4) + i32 filter1Op(4)
    // + f32 filter1Value(4) + f32 filter1High(4) + i32 filter1Target(4) + i32 filter2Op(4)
    // + f32 filter2Value(4) + f32 filter2High(4) + i32 filter2Target(4) + f32 pad(4)
    // Total: 64+64+8+4+4+4+4+4+4+4+4+4+4+4+4+4+4 = 192 bytes
    this._uniformBufferSize = 192;
    this.uniformBuffer = device.createBuffer({
      label: 'DGFlex uniforms',
      size: this._uniformBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._uniformBGL = device.createBindGroupLayout({
      label: 'DGFlex uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this._dataBGL = device.createBindGroupLayout({
      label: 'DGFlex data BGL',
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
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX,
          texture: { sampleType: 'unfilterable-float' },
        },
        { binding: 3, visibility: GPUShaderStage.VERTEX, sampler: { type: 'non-filtering' } },
      ],
    });

    this._rampBGL = device.createBindGroupLayout({
      label: 'DGFlex ramp BGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'DGFlex pipeline layout',
      bindGroupLayouts: [this._uniformBGL, this._dataBGL, this._rampBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'DGFlex shader',
      code: hexWGSL,
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
      label: 'DGFlex render pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            // Position buffer
            arrayStride: 3 * 4,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
          {
            // Cell index buffer
            arrayStride: 4,
            attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' }],
          },
          {
            // Extrude flag buffer
            arrayStride: 4,
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
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
      },
    });

    this._uniformBindGroup = device.createBindGroup({
      label: 'DGFlex uniform BG',
      layout: this._uniformBGL,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  // ─── Mesh ───

  /**
   * Build GPU mesh buffers. If maxVertexCount/maxIndexCount are provided,
   * buffers are pre-allocated at that size for incremental tile appends.
   * Otherwise, buffers are sized exactly to the mesh data.
   *
   * Mercator buffers are sized with MERC_SPLIT_HEADROOM extra capacity to
   * absorb antimeridian-split vertices that splitMercatorMesh() may emit.
   */
  _buildMesh(maxVertexCount, maxIndexCount) {
    const device = this.device;
    const mesh = this.data.mesh;

    const allocVerts = maxVertexCount || mesh.vertexCount;
    const allocIndices = maxIndexCount || mesh.indexCount;

    // Headroom for antimeridian-split extra verts/indices in Mercator buffers.
    const mercHeadroom = Math.max(MERC_SPLIT_MIN, Math.ceil(allocVerts * MERC_SPLIT_HEADROOM));
    const allocMercVerts = allocVerts + mercHeadroom;
    const allocMercIndices =
      allocIndices + Math.max(MERC_SPLIT_MIN, Math.ceil(allocIndices * MERC_SPLIT_HEADROOM));

    // Position buffer (vec3 × allocVerts)
    this.positionBuffer = device.createBuffer({
      label: 'DGFlex positions',
      size: allocVerts * 12, // 3 floats × 4 bytes
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.positionBuffer, 0, mesh.positions);

    // Cell index buffer (float × allocVerts)
    this.cellIndexBuffer = device.createBuffer({
      label: 'DGFlex cell indices',
      size: allocVerts * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.cellIndexBuffer, 0, mesh.cellIndices);

    // Extrude flag buffer (float × allocVerts)
    const extrudeData = mesh.extrudeFlags || new Float32Array(mesh.cellIndices.length);
    this.extrudeBuffer = device.createBuffer({
      label: 'DGFlex extrude flags',
      size: allocVerts * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.extrudeBuffer, 0, extrudeData);

    // Index buffer (uint32 × allocIndices) — spherical draw
    this.indexBuffer = device.createBuffer({
      label: 'DGFlex indices',
      size: allocIndices * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, mesh.indices);

    this._indexCount = mesh.indexCount;

    // ── Mercator buffers (separate from spherical) ──────────────────────
    // splitMercatorMesh() converts XYZ→world-px and splits antimeridian-
    // crossing triangles into two slivers, each with freshly duplicated
    // vertices.  Pre-baked once so projection toggles remain zero-cost.
    // Pass extrudeFlags through the split so top vertices carry their flag.
    // extrudeData was declared above for the spherical extrude buffer; reuse it.
    const { mercPositions, mercIndices, mercCellIndices, mercExtrudeFlags } = splitMercatorMesh(
      mesh.positions,
      mesh.indices,
      mesh.cellIndices,
      extrudeData
    );

    // Mercator position buffer (vec2 × allocMercVerts)
    this._mercPositionBuffer = device.createBuffer({
      label: 'DGFlex merc positions',
      size: allocMercVerts * 8,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._mercPositionBuffer, 0, mercPositions);

    // Mercator cell-index buffer — parallel to _mercPositionBuffer.
    this._mercCellIndexBuffer = device.createBuffer({
      label: 'DGFlex merc cell indices',
      size: allocMercVerts * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._mercCellIndexBuffer, 0, mercCellIndices);

    // Mercator extrude-flag buffer — carries 0/1 per Mercator vertex for 2.5D.
    // Populated from the split result so top vertices retain their flag even
    // after antimeridian duplication.
    this._mercExtrudeBuffer = device.createBuffer({
      label: 'DGFlex merc extrude flags',
      size: allocMercVerts * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._mercExtrudeBuffer, 0, mercExtrudeFlags);

    // Mercator index buffer — may reference extra split vertices.
    this._mercIndexBuffer = device.createBuffer({
      label: 'DGFlex merc indices',
      size: allocMercIndices * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._mercIndexBuffer, 0, mercIndices);

    this._mercIndexCount = mercIndices.length;
    this._mercVertexWriteHead = mercPositions.length / 2;
    this._mercIndexWriteHead = mercIndices.length;
  }

  /**
   * Hot-swap the mesh with new data (progressive tile loading).
   * Destroys old GPU buffers and creates new ones.
   */
  updateMesh(newMesh) {
    this.positionBuffer?.destroy();
    this.cellIndexBuffer?.destroy();
    this.extrudeBuffer?.destroy();
    this.indexBuffer?.destroy();
    this._mercPositionBuffer?.destroy();
    this._mercCellIndexBuffer?.destroy();
    this._mercExtrudeBuffer?.destroy();
    this._mercIndexBuffer?.destroy();
    this.data.mesh = newMesh;
    this._buildMesh();
  }

  /**
   * Incrementally append tile data to pre-allocated GPU buffers.
   * Only writes the NEW data at the given offsets — no buffer
   * destruction, no full re-upload. ~2-20 MB per batch vs 500+ MB.
   *
   * The Mercator buffers are written via splitMercatorMesh(), which performs
   * antimeridian splitting for this batch.  The Mercator vertex/index offsets
   * are tracked separately from the spherical ones because split triangles
   * emit extra vertices.
   *
   * @param {Float32Array} positions — new positions (vec3, length = newVerts × 3)
   * @param {Float32Array} cellIndices — new cell indices (length = newVerts)
   * @param {Float32Array} extrudeFlags — new extrude flags (length = newVerts)
   * @param {Uint32Array} indices — new indices (already offset-adjusted, length = newIndices)
   * @param {number} vertexOffset — number of existing vertices (determines write offset)
   * @param {number} indexOffset — number of existing indices (determines write offset)
   * @param {number} totalIndexCount — new total index count for draw call
   */
  appendMeshData(
    positions,
    cellIndices,
    extrudeFlags,
    indices,
    vertexOffset,
    indexOffset,
    totalIndexCount
  ) {
    const device = this.device;
    device.queue.writeBuffer(this.positionBuffer, vertexOffset * 12, positions);
    device.queue.writeBuffer(this.cellIndexBuffer, vertexOffset * 4, cellIndices);
    device.queue.writeBuffer(this.extrudeBuffer, vertexOffset * 4, extrudeFlags);
    device.queue.writeBuffer(this.indexBuffer, indexOffset * 4, indices);
    this._indexCount = totalIndexCount;

    // Keep Mercator buffers in sync with antimeridian splitting.
    if (this._mercPositionBuffer && this._mercIndexBuffer) {
      // Re-base incoming (absolute) indices to be relative to this batch,
      // then re-absolute them against the Mercator write head.
      const batchRelIndices = new Uint32Array(indices.length);
      for (let i = 0; i < indices.length; i++) {
        batchRelIndices[i] = indices[i] - vertexOffset;
      }

      const { mercPositions, mercIndices, mercCellIndices, mercExtrudeFlags } = splitMercatorMesh(
        positions,
        batchRelIndices,
        cellIndices,
        extrudeFlags
      );

      // Shift mercIndices to absolute Mercator vertex indices.
      const mercVertBase = this._mercVertexWriteHead;
      for (let i = 0; i < mercIndices.length; i++) {
        mercIndices[i] += mercVertBase;
      }

      const mercVertCount = mercPositions.length / 2;
      device.queue.writeBuffer(this._mercPositionBuffer, mercVertBase * 8, mercPositions);
      device.queue.writeBuffer(this._mercCellIndexBuffer, mercVertBase * 4, mercCellIndices);
      if (this._mercExtrudeBuffer) {
        device.queue.writeBuffer(this._mercExtrudeBuffer, mercVertBase * 4, mercExtrudeFlags);
      }
      device.queue.writeBuffer(this._mercIndexBuffer, this._mercIndexWriteHead * 4, mercIndices);

      this._mercVertexWriteHead += mercVertCount;
      this._mercIndexWriteHead += mercIndices.length;
      this._mercIndexCount = this._mercIndexWriteHead;
    }
  }

  // ─── Data Textures (R32F) ───

  _buildDataTextures() {
    const device = this.device;
    this._texSize = Math.ceil(Math.sqrt(this.cellCount));

    const createR32F = (label) =>
      device.createTexture({
        label,
        size: [this._texSize, this._texSize],
        format: 'r32float',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.STORAGE_BINDING, // for compute shader textureStore()
      });

    this.dataTexA = createR32F('DGFlex data A');
    this.dataTexB = createR32F('DGFlex data B');
    this._texCurrent = this.dataTexA;
    this._texNext = this.dataTexB;

    // Filter texture (still uses writeTexture — filters change infrequently)
    this._filterTex = device.createTexture({
      label: 'DGFlex filter',
      size: [this._texSize, this._texSize],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this._filterTexBuf = new Float32Array(this._texSize * this._texSize);

    this._rebuildDataBindGroup();
    this._rebuildRampBindGroup();
  }

  _rebuildDataBindGroup() {
    this._dataBindGroup = this.device.createBindGroup({
      label: 'DGFlex data BG',
      layout: this._dataBGL,
      entries: [
        { binding: 0, resource: this._texCurrent.createView() },
        { binding: 1, resource: this._texNext.createView() },
        { binding: 2, resource: this._filterTex.createView() },
        { binding: 3, resource: this._dataSampler },
      ],
    });
  }

  _rebuildRampBindGroup() {
    if (!this.style.color?.texture) return;
    this._rampBindGroup = this.device.createBindGroup({
      label: 'DGFlex ramp BG',
      layout: this._rampBGL,
      entries: [
        { binding: 0, resource: this.style.color.texture.createView() },
        { binding: 1, resource: this._rampSampler },
      ],
    });
  }

  // ─── Compute Shader Data Path ───

  // ─── GPU Histogram Compute ───────────────────────────────

  _buildHistogramPipeline() {
    const device = this.device;

    this._histogramBGL = device.createBindGroupLayout({
      label: 'Histogram BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
        },
      ],
    });

    this._histogramPipeline = device.createComputePipeline({
      label: 'Histogram compute',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._histogramBGL],
      }),
      compute: {
        module: device.createShaderModule({
          label: 'Histogram shader',
          code: histogramWGSL,
        }),
        entryPoint: 'main',
      },
    });

    // Params uniform: 8 x u32/f32 = 32 bytes
    this._histUniformBuf = device.createBuffer({
      label: 'Histogram params',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Output buffer: 256 max bins = 1024 bytes
    const MAX_BINS = 256;
    this._histMaxBins = MAX_BINS;
    this._histOutputSize = MAX_BINS * 4;
    this._histOutputBuf = device.createBuffer({
      label: 'Histogram output',
      size: this._histOutputSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, // for writeBuffer clear
    });

    // Staging buffer for readback
    this._histStagingBuf = device.createBuffer({
      label: 'Histogram staging',
      size: this._histOutputSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    this._histPending = false;

    // Pre-allocated histogram params scratch (reused per compute call)
    this._histParamsBuf = new ArrayBuffer(32);
    this._histParamsU32 = new Uint32Array(this._histParamsBuf);
    this._histParamsF32 = new Float32Array(this._histParamsBuf);
  }

  /**
   * Compute a histogram on the GPU for the given epoch.
   * Domain (min/max) is computed on CPU from the cached previous result
   * or from the temporal column directly. GPU does the expensive binning.
   *
   * @param {number} normalizedTime - 0..1
   * @param {number} binCount - number of bins (max 256)
   * @param {number[]|null} domain - [min, max] or null for auto
   * @param {string} [attribute] - attribute name (defaults to active attribute)
   * @returns {Promise<{ counts: Uint32Array, effectiveDomain: number[] } | null>}
   */
  async computeHistogram(normalizedTime, binCount, domain = null, attribute = null) {
    if (this._histPending) return null;
    const device = this.device;

    // Create a temporary single-epoch storage buffer on-demand.
    // This avoids keeping the full shard in GPU memory permanently.
    const colorAttr = attribute || this._colorAttr;
    const attrData = this.data.temporalColumns[colorAttr] || this.data.staticColumns[colorAttr];
    if (!attrData) return null;

    const isStatic = !this.data.temporalColumns[colorAttr];
    const e = isStatic
      ? 0
      : Math.max(
          0,
          Math.min(
            Math.floor(normalizedTime * (this.epochCount - 1)) - this._shardStart,
            this._shardEpochCount - 1
          )
        );
    const epochOffset = 0; // epoch data starts at offset 0 in the temp buffer

    // Upload just the one epoch to a temporary storage buffer
    const start = e * this.cellCount;
    const epochSlice = attrData.subarray(start, start + this.cellCount);
    const tempBuf = device.createBuffer({
      label: 'Histogram temp storage',
      size: epochSlice.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(tempBuf, 0, epochSlice);
    binCount = Math.min(binCount, this._histMaxBins);

    let dataMin, dataMax;
    const cachedDomain = this._histCachedDomain;
    if (cachedDomain && Math.abs(e - cachedDomain.epoch) <= 1) {
      // Reuse cached domain for adjacent epochs — avoids 1.4M scan
      dataMin = cachedDomain.min;
      dataMax = cachedDomain.max;
    } else {
      dataMin = Infinity;
      dataMax = -Infinity;
      const offset = e * this.cellCount;
      for (let c = 0; c < this.cellCount; c++) {
        const val = attrData[offset + c];
        if (val === 0 || val !== val) continue;
        if (val < dataMin) dataMin = val;
        if (val > dataMax) dataMax = val;
      }
      if (dataMin === Infinity) return null;
      this._histCachedDomain = { epoch: e, min: dataMin, max: dataMax };
    }

    const effectiveDomain = [
      domain ? Math.max(domain[0], dataMin) : dataMin,
      domain?.[1] != null ? domain[1] : dataMax,
    ];
    if (effectiveDomain[0] >= effectiveDomain[1]) effectiveDomain[1] = effectiveDomain[0] + 1;

    // Clear bin counts
    const clearBins = new Uint32Array(binCount);
    device.queue.writeBuffer(this._histOutputBuf, 0, clearBins);

    // Set params (reuse pre-allocated scratch)
    const u32 = this._histParamsU32;
    const f32 = this._histParamsF32;
    u32[0] = this.cellCount;
    u32[1] = epochOffset;
    u32[2] = binCount;
    u32[3] = 0; // pad
    f32[4] = effectiveDomain[0];
    f32[5] = effectiveDomain[1];
    device.queue.writeBuffer(this._histUniformBuf, 0, this._histParamsBuf);

    const bindGroup = device.createBindGroup({
      layout: this._histogramBGL,
      entries: [
        { binding: 0, resource: { buffer: this._histUniformBuf } },
        { binding: 1, resource: { buffer: tempBuf } },
        { binding: 2, resource: { buffer: this._histOutputBuf } },
      ],
    });

    const workgroups = Math.ceil(this.cellCount / 256);
    const encoder = device.createCommandEncoder({ label: 'Histogram' });

    const pass = encoder.beginComputePass({ label: 'Histogram binning' });
    pass.setPipeline(this._histogramPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    // Copy bins to staging
    const binBytes = binCount * 4;
    encoder.copyBufferToBuffer(this._histOutputBuf, 0, this._histStagingBuf, 0, binBytes);

    device.queue.submit([encoder.finish()]);

    // Async readback
    this._histPending = true;
    try {
      await this._histStagingBuf.mapAsync(GPUMapMode.READ, 0, binBytes);
      const result = new Uint32Array(this._histStagingBuf.getMappedRange(0, binBytes).slice(0));
      this._histStagingBuf.unmap();
      this._histPending = false;
      tempBuf.destroy(); // Free temporary GPU buffer
      return { counts: result, effectiveDomain };
    } catch (err) {
      this._histPending = false;
      tempBuf.destroy(); // Free temporary GPU buffer
      return null;
    }
  }

  /**
   * Determine epoch, write data to textures, and update bind groups.
   * Called BEFORE beginRenderPass() on the same commandEncoder.
   * @param {GPUCommandEncoder} commandEncoder - unused (kept for API compat)
   * @param {number} normalizedTime - 0..1 time position
   */
  prepareCompute(commandEncoder, normalizedTime) {
    // Epoch calculation
    let e0, e1, frac;
    if (this.epochCount <= 1) {
      e0 = 0;
      e1 = 0;
      frac = 0.0;
    } else {
      const t = normalizedTime * (this.epochCount - 1);
      e0 = Math.max(0, Math.min(Math.floor(t), this.epochCount - 2));
      e1 = e0 + 1;
      frac = t - e0;
    }

    // Store for render() to use
    this._computedE0 = e0;
    this._computedE1 = e1;
    this._computedFrac = frac;

    // Ensure textures perfectly match the computed epochs.
    // Direct texture writes are O(1) <0.1ms, easily executing synchronously per frame.
    if (e0 !== this._currentEpoch) {
      if (this._currentEpoch < 0) {
        // First frame initialization
        this._directWriteToTex(this._texCurrent, e0);
        this._directWriteToTex(this._texNext, e1);
      } else if (e0 === this._currentEpoch + 1) {
        // Sequential advance: old _texNext becomes new _texCurrent
        const temp = this._texCurrent;
        this._texCurrent = this._texNext;
        this._texNext = temp;

        this._directWriteToTex(this._texNext, e1);
        this._rebuildDataBindGroup();
      } else {
        // Non-sequential scrub or shard transition edge case: immediately upload both
        this._directWriteToTex(this._texCurrent, e0);
        this._directWriteToTex(this._texNext, e1);
      }
      this._currentEpoch = e0;
    }
  }

  _uploadFilterColumn(columnName) {
    const data = this.data;
    let colData = data.staticColumns?.[columnName];
    if (!colData) {
      colData = data.temporalColumns?.[columnName];
      if (colData && colData.length > this.cellCount) {
        const epoch = Math.max(0, this._currentEpoch || 0);
        const start = epoch * this.cellCount;
        colData = colData.subarray(start, start + this.cellCount);
      }
    }
    if (!colData) return;

    this._filterTexBuf.fill(0);
    if (colData instanceof Uint16Array) {
      for (let i = 0; i < Math.min(colData.length, this.cellCount); i++) {
        this._filterTexBuf[i] = colData[i];
      }
    } else {
      this._filterTexBuf.set(colData.subarray(0, Math.min(colData.length, this.cellCount)));
    }

    this.device.queue.writeTexture(
      { texture: this._filterTex },
      this._filterTexBuf,
      { bytesPerRow: this._texSize * 4 },
      [this._texSize, this._texSize]
    );
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

    this._mercUniformBGL = device.createBindGroupLayout({
      label: 'DGFlex merc uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this._mercUniformBuffer = device.createBuffer({
      label: 'DGFlex merc uniforms',
      size: MERC_UB_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._mercUniformBindGroup = device.createBindGroup({
      label: 'DGFlex merc uniform BG',
      layout: this._mercUniformBGL,
      entries: [{ binding: 0, resource: { buffer: this._mercUniformBuffer } }],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'DGFlex merc pipeline layout',
      bindGroupLayouts: [this._mercUniformBGL, this._dataBGL, this._rampBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'DGFlex merc shader',
      code: hexMercWGSL,
    });

    this._mercPipeline = device.createRenderPipeline({
      label: 'DGFlex merc pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            // Mercator position buffer — vec2 (8 bytes/vertex)
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
          },
          {
            // Cell index buffer — float (4 bytes/vertex)
            arrayStride: 4,
            attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' }],
          },
          {
            // Extrude flag buffer — float (4 bytes/vertex)
            //   0.0 = base vertex (no Z lift), 1.0 = top vertex (full extrusion)
            arrayStride: 4,
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
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this.depthFormat,
        // Enable depth writes so extruded pillars correctly occlude each other.
        // When extrusion_scale = 0 the shader emits ndcZ = 0 for all vertices,
        // so depth testing degenerates to the same behaviour as 'always'.
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
      },
    });
  }

  _renderSpherical(ctx) {
    const { passEncoder, viewMatrix, projMatrix, normalizedTime } = ctx;

    // Epoch values computed by prepareCompute()
    const frac = this._computedFrac ?? 0;

    if (!this._rampBindGroup) return;
    if (this._indexCount === 0) return;

    // Write uniforms (reuse pre-allocated scratch buffer — zero GC pressure)
    const f32 = this._uniformF32;
    const i32 = this._uniformI32;

    f32.set(viewMatrix, 0); // offset 0: view mat4
    f32.set(projMatrix, 16); // offset 64: projection mat4
    const liveDomain = this.style.color?.domain || this._domain;
    f32[32] = liveDomain[0]; // offset 128: domain.x
    f32[33] = liveDomain[1]; // offset 132: domain.y
    f32[34] = this._texSize; // offset 136: texSize
    f32[35] = frac; // offset 140: epochFrac
    const liveOpacity = this.style.color?.hasOpacityRamp ? 1.0 : this._opacity;
    f32[36] = liveOpacity; // offset 144: opacity
    f32[37] = this._extrusionScale; // offset 148: extrusionScale

    // Filter uniforms
    const preds = this._filterPredicates;
    i32[38] = this._filterCombinator; // offset 152
    if (preds && preds.length > 0) {
      const p0 = preds[0];
      i32[39] = p0.op; // offset 156
      f32[40] = p0.value; // offset 160
      f32[41] = p0.high; // offset 164
      i32[42] = p0.target; // offset 168
      if (preds.length > 1) {
        const p1 = preds[1];
        i32[43] = p1.op; // offset 172
        f32[44] = p1.value; // offset 176
        f32[45] = p1.high; // offset 180
        i32[46] = p1.target; // offset 184
      } else {
        i32[43] = 0;
      }
    } else {
      i32[39] = 0; // filter1_op = 0 (none)
      i32[43] = 0; // filter2_op = 0 (none)
    }

    const colorType = this.style.color?.type;
    const colorMode =
      colorType === 'categorical' ||
      colorType === 'constant' ||
      this.style.color?.interpolate === false
        ? 2
        : 1;
    i32[47] = colorMode; // offset 188: color_mode

    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformScratch);

    // Draw
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this._uniformBindGroup);
    passEncoder.setBindGroup(1, this._dataBindGroup);
    passEncoder.setBindGroup(2, this._rampBindGroup);
    passEncoder.setVertexBuffer(0, this.positionBuffer);
    passEncoder.setVertexBuffer(1, this.cellIndexBuffer);
    passEncoder.setVertexBuffer(2, this.extrudeBuffer);
    passEncoder.setIndexBuffer(this.indexBuffer, 'uint32');
    passEncoder.drawIndexed(this._indexCount);
  }

  /**
   * Mercator render path (relocated from renderMercator()).
   * Body is VERBATIM — no behavior changes.
   * @private
   */
  _renderMercator(ctx) {
    const { passEncoder, camera, viewportW, viewportH, normalizedTime } = ctx;

    if (!this._mercPipeline || !this._mercPositionBuffer) return;
    if (!this._mercIndexBuffer || !this._mercCellIndexBuffer) return;
    if (!this._rampBindGroup) return;
    if (this._mercIndexCount === 0) return;

    const frac = this._computedFrac ?? 0;

    const TILE_PX = 256;
    const worldSize = TILE_PX * Math.pow(2, camera.zoom);
    const sinLat = Math.sin((camera.lat * Math.PI) / 180);
    const cameraX = ((camera.lng + 180) / 360) * worldSize;
    const cameraY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;

    const liveDomain = this.style.color?.domain || this._domain;
    const liveOpacity = this.style.color?.hasOpacityRamp ? 1.0 : this._opacity;
    const colorType = this.style.color?.type;
    const colorMode =
      colorType === 'categorical' ||
      colorType === 'constant' ||
      this.style.color?.interpolate === false
        ? 2
        : 1;

    const f32 = this._mercUniformF32;
    const i32 = this._mercUniformI32;

    f32[0] = worldSize;
    f32[1] = this._texSize;
    f32[2] = cameraX;
    f32[3] = cameraY;
    f32[4] = viewportW;
    f32[5] = viewportH;
    f32[6] = liveDomain[0];
    f32[7] = liveDomain[1];
    f32[8] = frac;
    f32[9] = liveOpacity;
    i32[10] = colorMode;
    i32[11] = 0;

    const preds = this._filterPredicates;
    i32[12] = this._filterCombinator;
    if (preds && preds.length > 0) {
      const p0 = preds[0];
      i32[13] = p0.op;
      f32[14] = p0.value;
      f32[15] = p0.high;
      i32[16] = p0.target;
      if (preds.length > 1) {
        const p1 = preds[1];
        i32[17] = p1.op;
        f32[18] = p1.value;
        f32[19] = p1.high;
        i32[20] = p1.target;
      } else {
        i32[17] = 0;
      }
    } else {
      i32[13] = 0;
      i32[17] = 0;
    }
    // extrusion_scale (slot 21): convert spherical ECEF units → zoom-0 world pixels.
    // MERC_EXTRUSION_FACTOR = 256 / (2π) ≈ 40.74 so that `extrusion: 0.012` in YAML
    // produces visually similar pillar heights in both spherical and Mercator modes.
    f32[21] = this._extrusionScale * MERC_EXTRUSION_FACTOR;
    // tilt (slot 22): camera tilt in radians — drives the sin(tilt) projection in WGSL.
    f32[22] = camera.tilt ?? 0;
    i32[23] = 0;

    this.device.queue.writeBuffer(this._mercUniformBuffer, 0, this._mercUniformScratch);

    passEncoder.setPipeline(this._mercPipeline);
    passEncoder.setBindGroup(0, this._mercUniformBindGroup);
    passEncoder.setBindGroup(1, this._dataBindGroup);
    passEncoder.setBindGroup(2, this._rampBindGroup);
    passEncoder.setVertexBuffer(0, this._mercPositionBuffer);
    // Use Mercator-specific buffers — parallel to _mercPositionBuffer and
    // include entries for antimeridian-split duplicate vertices.
    passEncoder.setVertexBuffer(1, this._mercCellIndexBuffer);
    // Extrude flag buffer — carries 0/1 per Mercator vertex for 2.5D pillar tops.
    passEncoder.setVertexBuffer(2, this._mercExtrudeBuffer);
    passEncoder.setIndexBuffer(this._mercIndexBuffer, 'uint32');
    passEncoder.drawIndexed(this._mercIndexCount);
  }

  // ─── Lifecycle ───

  dispose() {
    // GPU textures
    this.dataTexA?.destroy();
    this.dataTexB?.destroy();
    this._filterTex?.destroy();

    // GPU buffers
    this.positionBuffer?.destroy();
    this.cellIndexBuffer?.destroy();
    this.extrudeBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this._mercPositionBuffer?.destroy();
    this._mercCellIndexBuffer?.destroy();
    this._mercExtrudeBuffer?.destroy();
    this._mercIndexBuffer?.destroy();
    this._mercUniformBuffer?.destroy();

    // Histogram GPU resources
    this._histUniformBuf?.destroy();
    this._histOutputBuf?.destroy();
    this._histStagingBuf?.destroy();

    // Style GPU resources
    if (this.style) this.style.disposeGPU();

    // CPU buffers — null to release for GC
    this._directWriteBuf = null;
    this._filterTexBuf = null;
    this._uniformScratch = null;
    this._uniformF32 = null;
    this._uniformI32 = null;
    this._mercUniformScratch = null;
    this._mercUniformF32 = null;
    this._mercUniformI32 = null;
    this._pendingCompute = null;
  }
}
