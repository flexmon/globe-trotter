/**
 * GFBLineRenderer.js — WebGPU SDF-based wide-line rendering for GFB LINE/MULTI_LINE geometry.
 *
 * Architecture:
 *   - Each line segment A→B is a screen-space quad (4 verts, 2 tris) extruded
 *     perpendicular to the projected direction, same as the WebGL2 GFBLineRenderer.
 *   - Per-vertex attribute buffers: geo_a, geo_b, side, value, visible.
 *   - Spherical render(): projects geodetic→ECEF in WGSL, SDF AA at edges.
 *   - Mercator renderMercator(): per-frame vertex-shader projection (no pre-bake),
 *     same screen-space extrusion approach.
 *   - Static geometry only for now (no temporal interpolation for lines).
 *
 * Bind groups:
 *   Spherical:  BG0=uniforms(mat4+params), BG1=color_ramp
 *   Mercator:   BG0=merc_uniforms(48B),    BG1=color_ramp (shared)
 */

import { StyleEngine } from '../styles/StyleEngine.js';
import lineMercWGSL from './shaders/gfbline.merc.wgsl?raw';
import { computeWorldCopies } from '../util/mercatorBake.js';

// ─── Inline spherical WGSL ────────────────────────────────────────────────────
// The WebGL2 line shader logic translated to WGSL for the spherical globe path.
const LINE_SPHERICAL_WGSL = /* wgsl */ `
// gfbline.wgsl — WebGPU GFB wide-line renderer for 3D spherical globe.

struct Uniforms {
    view:        mat4x4f,
    projection:  mat4x4f,
    line_width:  f32,
    _pad0:       f32,
    resolution:  vec2f,
    domain:      vec2f,
    opacity:     f32,
    color_mode:  i32,
    cat_width:   f32,
    _pad1:       f32,
    // total: 128 + 48 = 176 bytes → round to 192
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var color_ramp:   texture_2d<f32>;
@group(1) @binding(1) var ramp_sampler: sampler;

struct VertexInput {
    @location(0) geo_a:   vec3f,
    @location(1) geo_b:   vec3f,
    @location(2) side:    f32,
    @location(3) value:   f32,
    @location(4) visible: f32,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4f,
    @location(0) value: f32,
    @location(1) dist:  f32,
};

const PI:           f32 = 3.14159265359;
const DEG2RAD:      f32 = PI / 180.0;
const GLOBE_RADIUS: f32 = 1.00015;
const FEET_TO_GLOBE:f32 = 1.0 / 20925525.0;

fn latLonAltToXYZ(lat: f32, lon: f32, alt: f32) -> vec3f {
    let theta = (90.0 - lat) * DEG2RAD;
    let phi   = (lon + 180.0) * DEG2RAD;
    let r     = GLOBE_RADIUS + alt * FEET_TO_GLOBE;
    let st    = sin(theta);
    return vec3f(st * sin(phi), cos(theta), st * cos(phi)) * r;
}

@vertex
fn vs_main(in: VertexInput, @builtin(vertex_index) vert_idx: u32) -> VertexOutput {
    var out: VertexOutput;

    if (in.visible < 0.5) {
        out.clip_position = vec4f(2.0, 2.0, 2.0, 1.0);
        return out;
    }

    let posA = latLonAltToXYZ(in.geo_a.y, in.geo_a.x, in.geo_a.z);
    let posB = latLonAltToXYZ(in.geo_b.y, in.geo_b.x, in.geo_b.z);
    let clipA = u.projection * u.view * vec4f(posA, 1.0);
    let clipB = u.projection * u.view * vec4f(posB, 1.0);

    // NDC
    let ndcA = clipA.xy / clipA.w;
    let ndcB = clipB.xy / clipB.w;

    // Screen-space direction and perpendicular
    let screenA = ndcA * u.resolution * 0.5;
    let screenB = ndcB * u.resolution * 0.5;
    let dir  = normalize(screenB - screenA);
    let perp = vec2f(-dir.y, dir.x);

    let half_width = (u.line_width + 1.0) * 0.5;
    let screen_offset = perp * half_width * in.side;

    // Vertices 0,1 are at A; 2,3 at B
    let at_b = f32(vert_idx % 4u) >= 2.0;
    let clip  = select(clipA, clipB, at_b);

    let ndc_offset = screen_offset / (u.resolution * 0.5);
    out.clip_position = vec4f(clip.xy + ndc_offset * clip.w, clip.zw);

    out.value = in.value;
    out.dist  = in.side;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let line_core = u.line_width / (u.line_width + 1.0);
    let dist = abs(in.dist);
    let alpha_aa = 1.0 - smoothstep(line_core, 1.0, dist);

    var color: vec3f;
    var base_alpha: f32 = 1.0;

    if (u.color_mode == 1) {
        let t = clamp((in.value - u.domain.x) / (u.domain.y - u.domain.x), 0.0, 1.0);
        let c = textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5));
        color = c.rgb; base_alpha = c.a;
    } else if (u.color_mode == 2) {
        let t = clamp((in.value + 0.5) / u.cat_width, 0.0, 1.0);
        let c = textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5));
        color = c.rgb; base_alpha = c.a;
    } else {
        color = vec3f(0.0, 0.75, 0.9);
    }

    let alpha = base_alpha * alpha_aa * u.opacity;
    if (alpha < 0.01) { discard; }
    return vec4f(color, alpha);
}
`;

// ─── Uniform layout sizes ─────────────────────────────────────────────────────
// Spherical: mat4x4 view(64) + mat4x4 proj(64) + line_width(4) + _pad(4) +
//            resolution(8) + domain(8) + opacity(4) + color_mode(4) + cat_width(4) + _pad(4) = 176 → 192
const SPHERICAL_UNIFORM_SIZE = 192;

// Mercator: world_size(4) + _pad(4) + camera_offset(8) + viewport_size(8) +
//           domain(8) + opacity(4) + color_mode(4) + cat_width(4) + _pad(4) = 48
const MERC_UNIFORM_SIZE = 48;

export class GFBLineRenderer {
  /**
   * @param {GPUDevice} device
   * @param {string} format - Canvas texture format
   * @param {string} depthFormat - Depth texture format
   * @param {Object} data - Decoded GFB data
   * @param {Object} [compiledStyle] - CompiledStyle from StyleEngine.compileGPU()
   */
  constructor(device, format, depthFormat, data, compiledStyle) {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
    this.data = data;
    this.featureCount = data.featureCount;
    this.geom = data.geometry;

    if (!compiledStyle) {
      compiledStyle = StyleEngine.compileGPU(
        device,
        StyleEngine.categorical({
          attribute: '_none',
          categories: {},
          default: '#00b8cc',
          opacity: 0.8,
        }),
        []
      );
    }
    this.style = compiledStyle;
    this._lineWidth = null; // override; falls back to style.width.value

    this._buildRampBindGroupLayout();
    this._buildGeometry();
    this._buildSphericalPipeline();
    this._rebuildRampBindGroup();
  }

  setStyle(compiledStyle) {
    const old = this.style;
    this.style = compiledStyle;
    this._rebuildRampBindGroup();
    if (old) old.disposeGPU?.();
  }

  setLineWidth(px) {
    this._lineWidth = Math.max(1, px);
  }

  get lineWidth() {
    return this._lineWidth ?? this.style?.width?.value ?? 2;
  }

  // ─── Bind group layouts ───────────────────────────────────────────────────

  _buildRampBindGroupLayout() {
    this._rampBGL = this.device.createBindGroupLayout({
      label: 'GFBLine ramp BGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    this._rampSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  _rebuildRampBindGroup() {
    const tex = this.style.color?.texture;
    if (!tex) return;
    this._rampBindGroup = this.device.createBindGroup({
      label: 'GFBLine ramp BG',
      layout: this._rampBGL,
      entries: [
        { binding: 0, resource: tex.createView() },
        { binding: 1, resource: this._rampSampler },
      ],
    });
  }

  // ─── Geometry ────────────────────────────────────────────────────────────

  _buildGeometry() {
    const device = this.device;
    const geom = this.geom;
    if (!geom) return;

    const fpp = geom.floatsPerPos || 2;
    const coords = geom.coordinates || geom.positions;
    if (!coords) return;

    // Determine line start/end vertex ranges
    let lineStarts, lineEnds;
    if (geom.type === 'line' || geom.type === 'temporal_line') {
      const offsets = geom.offsets;
      lineStarts = [];
      lineEnds = [];
      for (let i = 0; i < this.featureCount; i++) {
        lineStarts.push(offsets[i]);
        lineEnds.push(offsets[i + 1]);
      }
    } else if (geom.type === 'multi_line' || geom.type === 'temporal_multi_line') {
      const lineOffsets = geom.lineOffsets;
      lineStarts = [];
      lineEnds = [];
      for (let i = 0; i < lineOffsets.length - 1; i++) {
        lineStarts.push(lineOffsets[i]);
        lineEnds.push(lineOffsets[i + 1]);
      }
    } else {
      console.warn(`[GFBLineRenderer] Unknown geometry type: ${geom.type}`);
      lineStarts = [];
      lineEnds = [];
    }

    // Feature-per-line mapping for multi_line
    let featureForLine;
    if (geom.featureOffsets) {
      featureForLine = new Uint32Array(lineStarts.length);
      for (let f = 0; f < this.featureCount; f++) {
        for (let l = geom.featureOffsets[f]; l < geom.featureOffsets[f + 1]; l++) {
          featureForLine[l] = f;
        }
      }
    }

    // Count total segments
    let totalSegments = 0;
    for (let i = 0; i < lineStarts.length; i++) {
      const vertCount = lineEnds[i] - lineStarts[i];
      if (vertCount > 1) totalSegments += vertCount - 1;
    }

    if (totalSegments === 0) return;

    const vertsPerSeg = 4;
    const totalVerts = totalSegments * vertsPerSeg;

    // Attribute arrays (separate buffers for clean binding)
    const geoA = new Float32Array(totalVerts * 3);
    const geoB = new Float32Array(totalVerts * 3);
    const sides = new Float32Array(totalVerts);
    const values = new Float32Array(totalVerts);
    const visData = new Float32Array(totalVerts);
    visData.fill(1.0);

    const totalIndices = totalSegments * 6;
    const indices =
      totalIndices > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);

    const colorAttr = this.style?.color?.attribute;
    const staticCol = colorAttr ? this.data.staticColumns?.[colorAttr] : null;

    let vIdx = 0;
    let iIdx = 0;

    for (let li = 0; li < lineStarts.length; li++) {
      const start = lineStarts[li];
      const end = lineEnds[li];
      const featureIdx = featureForLine ? featureForLine[li] : li;
      const val = staticCol ? staticCol[featureIdx] : featureIdx;

      for (let v = start; v < end - 1; v++) {
        const ai = v * fpp;
        const bi = (v + 1) * fpp;
        const lonA = coords[ai],
          latA = coords[ai + 1],
          altA = fpp >= 3 ? coords[ai + 2] : 0;
        const lonB = coords[bi],
          latB = coords[bi + 1],
          altB = fpp >= 3 ? coords[bi + 2] : 0;

        // 4 vertices: (A,-1), (A,+1), (B,-1), (B,+1)
        for (let s = 0; s < 4; s++) {
          const vi3 = vIdx * 3;
          geoA[vi3] = lonA;
          geoA[vi3 + 1] = latA;
          geoA[vi3 + 2] = altA;
          geoB[vi3] = lonB;
          geoB[vi3 + 1] = latB;
          geoB[vi3 + 2] = altB;
          sides[vIdx] = s % 2 === 0 ? -1 : 1;
          values[vIdx] = val;
          vIdx++;
        }

        // 2 triangles: 0-2-1, 1-2-3
        const base = vIdx - 4;
        indices[iIdx++] = base;
        indices[iIdx++] = base + 2;
        indices[iIdx++] = base + 1;
        indices[iIdx++] = base + 1;
        indices[iIdx++] = base + 2;
        indices[iIdx++] = base + 3;
      }
    }

    this.totalVerts = vIdx;
    this.totalIndices = iIdx;

    // Feature→vertex tracking for filter
    this._featureForVertex = new Uint32Array(vIdx);
    let ffvIdx = 0;
    for (let li = 0; li < lineStarts.length; li++) {
      const start = lineStarts[li];
      const end = lineEnds[li];
      const featureIdx = featureForLine ? featureForLine[li] : li;
      for (let v = start; v < end - 1; v++) {
        for (let s = 0; s < 4; s++) {
          this._featureForVertex[ffvIdx++] = featureIdx;
        }
      }
    }

    const mkBuf = (label, data, usage) => {
      const buf = device.createBuffer({
        label,
        size: data.byteLength,
        usage: usage | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, data);
      return buf;
    };

    const VX = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;

    this._geoABuf = mkBuf('GFBLine geoA', geoA.subarray(0, vIdx * 3), GPUBufferUsage.VERTEX);
    this._geoBBuf = mkBuf('GFBLine geoB', geoB.subarray(0, vIdx * 3), GPUBufferUsage.VERTEX);
    this._sideBuf = mkBuf('GFBLine sides', sides.subarray(0, vIdx), GPUBufferUsage.VERTEX);
    this._valueBuf = mkBuf('GFBLine values', values.subarray(0, vIdx), GPUBufferUsage.VERTEX);

    // Visibility — dynamic (updated by setFilter)
    this._visData = visData.subarray(0, vIdx);
    this._visBuf = device.createBuffer({
      label: 'GFBLine visibility',
      size: this._visData.byteLength,
      usage: VX,
    });
    device.queue.writeBuffer(this._visBuf, 0, this._visData);

    // Index buffer
    const idxSlice = indices.subarray(0, iIdx);
    this._indexBuf = device.createBuffer({
      label: 'GFBLine indices',
      size: idxSlice.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._indexBuf, 0, idxSlice);
    this._indexFormat = totalIndices > 65535 ? 'uint32' : 'uint16';
  }

  // ─── Spherical pipeline ───────────────────────────────────────────────────

  _buildSphericalPipeline() {
    const device = this.device;

    this._sphericalUniformBuf = device.createBuffer({
      label: 'GFBLine spherical uniforms',
      size: SPHERICAL_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._sphericalUniformBGL = device.createBindGroupLayout({
      label: 'GFBLine spherical uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'GFBLine spherical pipeline layout',
      bindGroupLayouts: [this._sphericalUniformBGL, this._rampBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'GFBLine spherical shader',
      code: LINE_SPHERICAL_WGSL,
    });

    this._sphericalPipeline = device.createRenderPipeline({
      label: 'GFBLine spherical pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: this._vertexBufferLayouts(),
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
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

    this._sphericalUniformBG = device.createBindGroup({
      label: 'GFBLine spherical uniform BG',
      layout: this._sphericalUniformBGL,
      entries: [{ binding: 0, resource: { buffer: this._sphericalUniformBuf } }],
    });

    this._sphericalScratch = new ArrayBuffer(SPHERICAL_UNIFORM_SIZE);
    this._sphericalF32 = new Float32Array(this._sphericalScratch);
    this._sphericalI32 = new Int32Array(this._sphericalScratch);
  }

  // ─── Mercator pipeline ────────────────────────────────────────────────────

  _buildMercPipeline() {
    const device = this.device;

    this._mercUniformBuf = device.createBuffer({
      label: 'GFBLine merc uniforms',
      size: MERC_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._mercUniformBGL = device.createBindGroupLayout({
      label: 'GFBLine merc uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'GFBLine merc pipeline layout',
      bindGroupLayouts: [this._mercUniformBGL, this._rampBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'GFBLine merc shader',
      code: lineMercWGSL,
    });

    this._mercPipeline = device.createRenderPipeline({
      label: 'GFBLine merc pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: this._vertexBufferLayouts(),
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
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

    this._mercUniformBG = device.createBindGroup({
      label: 'GFBLine merc uniform BG',
      layout: this._mercUniformBGL,
      entries: [{ binding: 0, resource: { buffer: this._mercUniformBuf } }],
    });

    this._mercScratch = new ArrayBuffer(MERC_UNIFORM_SIZE);
    this._mercF32 = new Float32Array(this._mercScratch);
    this._mercI32 = new Int32Array(this._mercScratch);
  }

  // ─── Shared vertex buffer layout ──────────────────────────────────────────

  _vertexBufferLayouts() {
    return [
      {
        arrayStride: 12,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
      }, // geo_a
      {
        arrayStride: 12,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }],
      }, // geo_b
      {
        arrayStride: 4,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 2, offset: 0, format: 'float32' }],
      }, // side
      {
        arrayStride: 4,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 3, offset: 0, format: 'float32' }],
      }, // value
      {
        arrayStride: 4,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 4, offset: 0, format: 'float32' }],
      }, // visible
    ];
  }

  _bindVertexBuffers(passEncoder) {
    passEncoder.setVertexBuffer(0, this._geoABuf);
    passEncoder.setVertexBuffer(1, this._geoBBuf);
    passEncoder.setVertexBuffer(2, this._sideBuf);
    passEncoder.setVertexBuffer(3, this._valueBuf);
    passEncoder.setVertexBuffer(4, this._visBuf);
    passEncoder.setIndexBuffer(this._indexBuf, this._indexFormat);
  }

  // ─── Filter support ───────────────────────────────────────────────────────

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
    if (this._visData) {
      this._visData.fill(1.0);
      this.device.queue.writeBuffer(this._visBuf, 0, this._visData);
    }
  }

  _applyFilter() {
    const preds = this._filterPredicates;
    if (!preds || !this._featureForVertex || !this._visData) return;
    const isOR = this._filterCombinator === 1;
    const featureVis = new Float32Array(this.featureCount);
    for (let i = 0; i < this.featureCount; i++) {
      let pass = !isOR;
      for (const pred of preds) {
        const col = this.data.staticColumns?.[pred.column];
        const val = col ? col[i] : 0;
        const hit = this._evalPredicate(val, pred);
        pass = isOR ? pass || hit : pass && hit;
      }
      featureVis[i] = pass ? 1.0 : 0.0;
    }
    for (let v = 0; v < this._featureForVertex.length; v++) {
      this._visData[v] = featureVis[this._featureForVertex[v]];
    }
    this.device.queue.writeBuffer(this._visBuf, 0, this._visData);
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

  // ─── Render (spherical) ───────────────────────────────────────────────────

  render(projection, ctx) {
    if (projection === 'mercator') {
      return this._renderMercator(ctx);
    }
    return this._renderSpherical(ctx);
  }

  /**
   * Spherical render path (verbatim from render()).
   * @param {Object} ctx
   * @param {GPURenderPassEncoder} ctx.passEncoder
   * @param {Float32Array} ctx.viewMatrix
   * @param {Float32Array} ctx.projMatrix
   * @param {Float32Array} ctx.cameraPosition
   * @param {number} ctx.normalizedTime
   */
  _renderSpherical(ctx) {
    const { passEncoder, viewMatrix, projMatrix, cameraPosition, normalizedTime } = ctx;
    if (!this._geoABuf || this.totalIndices === 0) return;
    if (!this._rampBindGroup) return;

    const colorType = this.style.color?.type;
    let colorMode = 0;
    if (colorType === 'ramp') colorMode = 1;
    else if (colorType === 'categorical' || colorType === 'constant') colorMode = 2;

    const domain = this.style.color?.domain || [0, 1];
    const opacity = this.style.opacity?.type === 'constant' ? this.style.opacity.value : 0.8;

    const f32 = this._sphericalF32;
    const i32 = this._sphericalI32;
    // view mat4 at offset 0 (16 floats)
    f32.set(viewMatrix, 0);
    // proj mat4 at offset 64 bytes (16 floats)
    f32.set(projMatrix, 16);
    // offset 128: line_width(4) + _pad(4) + resolution(8) + domain(8) + opacity(4) + color_mode(4) + cat_width(4) + _pad(4)
    f32[32] = this.lineWidth; // offset 128
    // f32[33] = _pad0
    // resolution: cached from last renderMercator() call; falls back to 1280×720.
    // Thread viewport through render() call chain if precision becomes critical.
    f32[34] = this._viewportW || 1280; // offset 136: resolution.x
    f32[35] = this._viewportH || 720; // offset 140: resolution.y
    f32[36] = domain[0]; // offset 144
    f32[37] = domain[1]; // offset 148
    f32[38] = opacity; // offset 152
    i32[39] = colorMode; // offset 156
    f32[40] = this.style.color?.width || 256.0; // offset 160: cat_width
    // f32[41] = _pad

    this.device.queue.writeBuffer(this._sphericalUniformBuf, 0, this._sphericalScratch);

    passEncoder.setPipeline(this._sphericalPipeline);
    passEncoder.setBindGroup(0, this._sphericalUniformBG);
    passEncoder.setBindGroup(1, this._rampBindGroup);
    this._bindVertexBuffers(passEncoder);
    passEncoder.drawIndexed(this.totalIndices);
  }

  /**
   * Mercator render path (verbatim from renderMercator()).
   * @param {Object} ctx
   * @param {GPURenderPassEncoder} ctx.passEncoder
   * @param {{ lng: number, lat: number, zoom: number }} ctx.camera
   * @param {number} ctx.viewportW
   * @param {number} ctx.viewportH
   * @param {number} ctx.normalizedTime
   */
  _renderMercator(ctx) {
    const { passEncoder, camera, viewportW, viewportH, normalizedTime } = ctx;
    if (!this._geoABuf || this.totalIndices === 0) return;
    if (!this._rampBindGroup) return;
    if (!this._mercPipeline) this._buildMercPipeline();
    // Cache viewport for use in spherical render() which has no viewport params
    this._viewportW = viewportW;
    this._viewportH = viewportH;

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
    const opacity = this.style.opacity?.type === 'constant' ? this.style.opacity.value : 0.8;

    const f32 = this._mercF32;
    const i32 = this._mercI32;
    f32[0] = worldSize;
    f32[1] = this.lineWidth; // _pad0 repurposed as line_width
    f32[2] = cameraX;
    f32[3] = cameraY;
    f32[4] = viewportW;
    f32[5] = viewportH;
    f32[6] = domain[0];
    f32[7] = domain[1];
    f32[8] = opacity;
    i32[9] = colorMode;
    f32[10] = this.style.color?.width || 256.0; // cat_width

    // Horizontal world copies: draw one instance per visible world copy so
    // lines repeat across the antimeridian like the Mercator tiles do.
    const { firstCopy, copyCount } = computeWorldCopies(
      cameraX,
      worldSize,
      viewportW,
      camera.renderWorldCopies
    );
    f32[11] = firstCopy; // first_copy

    this.device.queue.writeBuffer(this._mercUniformBuf, 0, this._mercScratch);

    passEncoder.setPipeline(this._mercPipeline);
    passEncoder.setBindGroup(0, this._mercUniformBG);
    passEncoder.setBindGroup(1, this._rampBindGroup);
    this._bindVertexBuffers(passEncoder);
    passEncoder.drawIndexed(this.totalIndices, copyCount);
  }

  // ─── Dispose ──────────────────────────────────────────────────────────────

  dispose() {
    this._geoABuf?.destroy();
    this._geoBBuf?.destroy();
    this._sideBuf?.destroy();
    this._valueBuf?.destroy();
    this._visBuf?.destroy();
    this._indexBuf?.destroy();
    this._sphericalUniformBuf?.destroy();
    this._mercUniformBuf?.destroy();
    if (this.style) this.style.disposeGPU?.();
    this._visData = null;
    this._featureForVertex = null;
    this._filterPredicates = null;
    this._sphericalScratch = null;
    this._sphericalF32 = null;
    this._sphericalI32 = null;
    this._mercScratch = null;
    this._mercF32 = null;
    this._mercI32 = null;
  }
}
