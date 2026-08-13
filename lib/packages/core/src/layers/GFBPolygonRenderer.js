/**
 * GFBPolygonRenderer.js — WebGPU polygon fill rendering for GFB POLYGON/MULTI_POLYGON geometry.
 *
 * Architecture:
 *   - Pre-triangulated index buffers from the GFB file → single drawIndexed call.
 *   - Coordinates stored as (lon, lat, alt) per vertex; GPU projects to 3D/Mercator.
 *   - Spherical render(): ECEF projection in WGSL, subtle shading, depth test.
 *   - Mercator renderMercator(): per-frame vertex-shader projection (no pre-bake).
 *
 * Antimeridian splitting (Mercator mode): triangles spanning ±180° are split at
 * load time via splitMercatorPolygon() into east + west slivers; the Mercator
 * draw uses its own _merc{Pos,Value,Vis,Index}Buf populated from the split
 * output. Spherical buffers are untouched. Visibility filter updates sync to
 * the Mercator vis buffer via _mercParentVertexMap.
 *
 * Bind groups:
 *   Spherical:  BG0=uniforms(mat4+params), BG1=color_ramp
 *   Mercator:   BG0=merc_uniforms(48B),    BG1=color_ramp (shared)
 */

import { StyleEngine } from '../styles/StyleEngine.js';
import polyMercWGSL from './shaders/gfbpoly.merc.wgsl?raw';
import { splitMercatorPolygon, computeWorldCopies } from '../util/mercatorBake.js';
import { subdivideTriangles } from '../util/greatCircleSubdivide.js';

// ─── Inline spherical WGSL ────────────────────────────────────────────────────
const POLY_SPHERICAL_WGSL = /* wgsl */ `
// gfbpoly.wgsl — WebGPU GFB polygon fill renderer for 3D spherical globe.

struct Uniforms {
    view:            mat4x4f,  // offset 0
    projection:      mat4x4f,  // offset 64
    domain:          vec2f,    // offset 128
    opacity:         f32,      // offset 136
    color_mode:      i32,      // offset 140
    cat_width:       f32,      // offset 144
    extrusion_scale: f32,      // offset 148
    _pad0:           f32,      // offset 152
    _pad1:           f32,      // offset 156
    camera_position: vec3f,    // offset 160 (16-byte aligned)
    _pad2:           f32,      // offset 172 → total: 176 bytes
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(0) var color_ramp:   texture_2d<f32>;
@group(1) @binding(1) var ramp_sampler: sampler;

struct VertexInput {
    @location(0) position: vec3f, // (lon, lat, alt_feet)
    @location(1) value:    f32,
    @location(2) visible:  f32,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4f,
    @location(0) value:   f32,
    @location(1) normal:  vec3f,
    @location(2) visible: f32,
};

const PI:           f32 = 3.14159265359;
const DEG2RAD:      f32 = PI / 180.0;
const GLOBE_RADIUS: f32 = 1.00005;
const Z_FIGHT:      f32 = 0.00003;
const FEET_TO_GLOBE:f32 = 1.0 / 20925525.0;

fn latLonAltToXYZ(lat: f32, lon: f32, alt: f32) -> vec3f {
    let theta = (90.0 - lat) * DEG2RAD;
    let phi   = (lon + 180.0) * DEG2RAD;
    let r     = GLOBE_RADIUS + alt * FEET_TO_GLOBE;
    let st    = sin(theta);
    return vec3f(st * sin(phi), cos(theta), st * cos(phi)) * r;
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.value   = in.value;
    out.visible = in.visible;

    let alt = in.position.z;
    var pos = latLonAltToXYZ(in.position.y, in.position.x, alt);

    // Re-project onto sphere to fix chord geometry for large spans
    let r = GLOBE_RADIUS + alt * FEET_TO_GLOBE;
    pos = normalize(pos) * r;
    out.normal = normalize(pos);

    // Extrude outward along normal
    if (u.extrusion_scale > 0.0) {
        let nv = clamp((in.value - u.domain.x) / (u.domain.y - u.domain.x), 0.0, 1.0);
        let ev = pow(nv, 1.2);
        pos += out.normal * (ev * u.extrusion_scale + Z_FIGHT);
    }

    out.clip_position = u.projection * u.view * vec4f(pos, 1.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    if (in.visible < 0.5) { discard; }

    // Geometric horizon occlusion: discard fragments on the far side of the
    // globe. Per-fragment (not per-vertex) so filled triangles clip cleanly at
    // the limb instead of stretching a horizon vertex across the screen.
    if (dot(normalize(in.normal), u.camera_position) < 1.0) { discard; }

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
        color = vec3f(0.3, 0.5, 0.8);
    }

    // Subtle sun shading
    let sun   = normalize(vec3f(0.3, 0.8, 0.5));
    let shade = 0.7 + 0.3 * max(dot(in.normal, sun), 0.0);
    return vec4f(color * shade, base_alpha * u.opacity);
}
`;

// ─── Uniform sizes ─────────────────────────────────────────────────────────────
// Spherical: mat4(64) + mat4(64) + domain(8) + opacity(4) + color_mode(4) +
//            cat_width(4) + extrusion(4) + _pad0(4) + _pad1(4) +
//            camera_position(12) + _pad2(4) = 176 bytes
const SPHERICAL_UNIFORM_SIZE = 176;

// Mercator: world_size(4) + _pad(4) + camera_offset(8) + viewport_size(8) +
//           domain(8) + opacity(4) + color_mode(4) + cat_width(4) +
//           extrusion_scale(4) + tilt(4) + _pad×3(12) = 64
const MERC_UNIFORM_SIZE = 64;

// Convert spherical ECEF extrusion units → zoom-0 world pixels.
// 256/(2π) ≈ 40.74 — same factor H3F/DGF use so a YAML `extrusion: 0.012`
// produces visually comparable pillar heights across modes.
const MERC_EXTRUSION_FACTOR = 256 / (2 * Math.PI);

export class GFBPolygonRenderer {
  /**
   * @param {GPUDevice} device
   * @param {string} format
   * @param {string} depthFormat
   * @param {Object} data - Decoded GFB data
   * @param {Object} [compiledStyle]
   */
  constructor(device, format, depthFormat, data, compiledStyle) {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
    this.data = data;
    this.featureCount = data.featureCount;
    this.geom = data.geometry;
    this._extrusionScale = 0;

    if (!compiledStyle) {
      compiledStyle = StyleEngine.compileGPU(
        device,
        StyleEngine.categorical({
          attribute: '_none',
          categories: {},
          default: '#4d80cc',
          opacity: 0.7,
        }),
        []
      );
    }
    this.style = compiledStyle;

    this._buildRampBindGroupLayout();
    this._buildGeometry();
    this._buildMercatorGeometry();
    this._buildSphericalPipeline();
    this._rebuildRampBindGroup();
  }

  setStyle(compiledStyle) {
    const old = this.style;
    this.style = compiledStyle;
    this._rebuildRampBindGroup();
    if (old) old.disposeGPU?.();
  }

  setExtrusionScale(scale) {
    this._extrusionScale = Math.max(0, scale);
  }
  get extrusionScale() {
    return this._extrusionScale;
  }

  // ─── Mercator geometry (antimeridian-split) ───────────────────────────────

  /**
   * Build separate Mercator vertex/index buffers with antimeridian splitting.
   * Spherical buffers (_posBuf, _indexBuf, etc.) are untouched — they continue
   * to feed the 3D pipeline; the split slivers are only needed when projecting
   * onto a flat Mercator world.
   */
  _buildMercatorGeometry() {
    const device = this.device;
    const geom = this.geom;
    if (!geom || !this._posBuf || !this.totalIndices) return;

    const fpp = geom.floatsPerPos || 2;
    const coords = geom.coordinates || geom.positions;
    const triangles = geom.triangles ?? geom.indices;
    if (!coords || !triangles) return;

    // Build per-vertex value array the same way _buildGeometry did, so the
    // splitter can carry it through.  (We rely on _featureForVertex already
    // populated by _buildGeometry.)
    const totalVerts = coords.length / fpp;
    const values = new Float32Array(totalVerts);
    const colorAttr = this.style?.color?.attribute;
    const staticCol = colorAttr ? this.data.staticColumns?.[colorAttr] : null;
    for (let v = 0; v < totalVerts; v++) {
      const f = this._featureForVertex[v];
      values[v] = staticCol ? staticCol[f] : f;
    }

    const split = splitMercatorPolygon(coords, fpp, triangles, {
      values,
      visibility: this._visData,
      featureForVertex: this._featureForVertex,
    });

    // mercPositions is [lng, lat] pairs (fpp=2); the shader reads
    // position.x/.y and ignores .z, so pad to vec3 for layout compatibility.
    const mercVertCount = split.mercPositions.length / 2;
    const posData = new Float32Array(mercVertCount * 3);
    for (let i = 0; i < mercVertCount; i++) {
      posData[i * 3] = split.mercPositions[i * 2]; // lng (may be ±360 for split slivers)
      posData[i * 3 + 1] = split.mercPositions[i * 2 + 1]; // lat
      posData[i * 3 + 2] = 0; // alt unused in merc shader
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

    this._mercPosBuf = mkBuf('GFBPoly merc pos', posData, GPUBufferUsage.VERTEX);
    this._mercValueBuf = mkBuf('GFBPoly merc value', split.mercValues, GPUBufferUsage.VERTEX);
    this._mercVisData = split.mercVisibility;
    this._mercVisBuf = device.createBuffer({
      label: 'GFBPoly merc visibility',
      size: this._mercVisData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._mercVisBuf, 0, this._mercVisData);
    this._mercIndexBuf = device.createBuffer({
      label: 'GFBPoly merc indices',
      size: split.mercIndices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._mercIndexBuf, 0, split.mercIndices);
    this._mercIndexFormat = 'uint32';
    this._mercTotalIndices = split.mercIndices.length;
    this._mercParentVertexMap = split.parentVertexMap;
  }

  /** Sync the Mercator visibility buffer from the spherical _visData. */
  _syncMercVisibility() {
    if (!this._mercVisBuf || !this._mercVisData || !this._mercParentVertexMap || !this._visData)
      return;
    for (let i = 0; i < this._mercVisData.length; i++) {
      this._mercVisData[i] = this._visData[this._mercParentVertexMap[i]];
    }
    this.device.queue.writeBuffer(this._mercVisBuf, 0, this._mercVisData);
  }

  // ─── Bind group layout ────────────────────────────────────────────────────

  _buildRampBindGroupLayout() {
    this._rampBGL = this.device.createBindGroupLayout({
      label: 'GFBPoly ramp BGL',
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
      label: 'GFBPoly ramp BG',
      layout: this._rampBGL,
      entries: [
        { binding: 0, resource: tex.createView() },
        { binding: 1, resource: this._rampSampler },
      ],
    });
  }

  // ─── Geometry ─────────────────────────────────────────────────────────────

  _buildGeometry() {
    const device = this.device;
    const geom = this.geom;
    if (!geom) return;

    const fpp = geom.floatsPerPos || 2;
    let coords = geom.coordinates || geom.positions;
    let triangles = geom.triangles ?? geom.indices;
    if (!coords || !triangles) {
      console.warn('[GFBPolygonRenderer] No coordinates or triangle indices');
      return;
    }

    let totalVerts = coords.length / fpp;

    // Build per-vertex value and feature-index arrays
    let values = new Float32Array(totalVerts);
    this._featureForVertex = new Uint32Array(totalVerts);
    const colorAttr = this.style?.color?.attribute;
    const staticCol = colorAttr ? this.data.staticColumns?.[colorAttr] : null;

    if (geom.featureOffsets && geom.ringOffsets) {
      for (let f = 0; f < this.featureCount; f++) {
        const val = staticCol ? staticCol[f] : f;
        const ringStart = geom.featureOffsets[f];
        const ringEnd = geom.featureOffsets[f + 1];
        for (let r = ringStart; r < ringEnd; r++) {
          const vs = geom.ringOffsets[r];
          const ve = geom.ringOffsets[r + 1];
          for (let v = vs; v < ve; v++) {
            values[v] = val;
            this._featureForVertex[v] = f;
          }
        }
      }
    } else if (geom.polygonOffsets) {
      for (let f = 0; f < this.featureCount; f++) {
        const val = staticCol ? staticCol[f] : f;
        const ps = geom.featureOffsets[f];
        const pe = geom.featureOffsets[f + 1];
        for (let p = ps; p < pe; p++) {
          const rs = geom.polygonOffsets[p];
          const re = geom.polygonOffsets[p + 1];
          for (let r = rs; r < re; r++) {
            const vs = geom.ringOffsets[r];
            const ve = geom.ringOffsets[r + 1];
            for (let v = vs; v < ve; v++) {
              values[v] = val;
              this._featureForVertex[v] = f;
            }
          }
        }
      }
    } else {
      // Fallback uniform
      for (let v = 0; v < totalVerts; v++) {
        values[v] = 0;
        this._featureForVertex[v] = 0;
      }
    }

    // Visibility buffer (per-vertex, dynamic)
    // Great-circle subdivision (spherical path): split triangle edges > ~2°
    // so flat triangles hug the globe instead of chording through it. Pure;
    // returns the originals untouched when nothing exceeds the threshold.
    // (Mercator is flat and uses splitMercatorPolygon separately — not this.)
    ({
      coords,
      triangles,
      values,
      featureForVertex: this._featureForVertex,
    } = subdivideTriangles(coords, fpp, triangles, values, this._featureForVertex));
    totalVerts = coords.length / fpp;

    this._visData = new Float32Array(totalVerts);
    this._visData.fill(1.0);

    // Position buffer: upload as vec3 (lon, lat, alt)
    // Pack as float32x3: always 3 floats regardless of fpp,
    // zero-filling alt when fpp < 3.
    const posData = new Float32Array(totalVerts * 3);
    for (let i = 0; i < totalVerts; i++) {
      posData[i * 3] = coords[i * fpp]; // lon
      posData[i * 3 + 1] = coords[i * fpp + 1]; // lat
      posData[i * 3 + 2] = fpp >= 3 ? coords[i * fpp + 2] : 0; // alt
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

    this._posBuf = mkBuf('GFBPoly pos', posData, GPUBufferUsage.VERTEX);
    this._valueBuf = mkBuf('GFBPoly values', values, GPUBufferUsage.VERTEX);
    this._visBuf = device.createBuffer({
      label: 'GFBPoly visibility',
      size: this._visData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._visBuf, 0, this._visData);

    // Index buffer
    this._indexBuf = device.createBuffer({
      label: 'GFBPoly indices',
      size: triangles.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this._indexBuf, 0, triangles);
    this._indexFormat = triangles.constructor === Uint16Array ? 'uint16' : 'uint32';
    this.totalIndices = triangles.length;
  }

  // ─── Shared vertex buffer layout ──────────────────────────────────────────

  _vertexBufferLayouts() {
    return [
      {
        arrayStride: 12,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
      }, // position
      {
        arrayStride: 4,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 1, offset: 0, format: 'float32' }],
      }, // value
      {
        arrayStride: 4,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 2, offset: 0, format: 'float32' }],
      }, // visible
    ];
  }

  _bindVertexBuffers(passEncoder) {
    passEncoder.setVertexBuffer(0, this._posBuf);
    passEncoder.setVertexBuffer(1, this._valueBuf);
    passEncoder.setVertexBuffer(2, this._visBuf);
    passEncoder.setIndexBuffer(this._indexBuf, this._indexFormat);
  }

  // ─── Spherical pipeline ───────────────────────────────────────────────────

  _buildSphericalPipeline() {
    const device = this.device;

    this._sphericalUniformBuf = device.createBuffer({
      label: 'GFBPoly spherical uniforms',
      size: SPHERICAL_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._sphericalUniformBGL = device.createBindGroupLayout({
      label: 'GFBPoly spherical uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'GFBPoly spherical pipeline layout',
      bindGroupLayouts: [this._sphericalUniformBGL, this._rampBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'GFBPoly spherical shader',
      code: POLY_SPHERICAL_WGSL,
    });

    this._sphericalPipeline = device.createRenderPipeline({
      label: 'GFBPoly spherical pipeline',
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
      label: 'GFBPoly spherical uniform BG',
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
      label: 'GFBPoly merc uniforms',
      size: MERC_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._mercUniformBGL = device.createBindGroupLayout({
      label: 'GFBPoly merc uniform BGL',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      label: 'GFBPoly merc pipeline layout',
      bindGroupLayouts: [this._mercUniformBGL, this._rampBGL],
    });

    const shaderModule = device.createShaderModule({
      label: 'GFBPoly merc shader',
      code: polyMercWGSL,
    });

    this._mercPipeline = device.createRenderPipeline({
      label: 'GFBPoly merc pipeline',
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
        // Depth writes enabled so extruded polygons occlude each other
        // correctly. With extrusion_scale=0 the shader emits ndcZ=0 for
        // every vertex, so the depth test degenerates to 'always'.
        depthWriteEnabled: true,
        depthCompare: 'less-equal',
      },
    });

    this._mercUniformBG = device.createBindGroup({
      label: 'GFBPoly merc uniform BG',
      layout: this._mercUniformBGL,
      entries: [{ binding: 0, resource: { buffer: this._mercUniformBuf } }],
    });

    this._mercScratch = new ArrayBuffer(MERC_UNIFORM_SIZE);
    this._mercF32 = new Float32Array(this._mercScratch);
    this._mercI32 = new Int32Array(this._mercScratch);
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
      this._syncMercVisibility();
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
    this._syncMercVisibility();
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
    if (projection?.mode === 'mercator') {
      return this._renderMercator(ctx);
    }
    return this._renderSpherical(ctx);
  }

  /**
   * Spherical render (internal).
   * @param {Object} ctx
   * @param {GPURenderPassEncoder} ctx.passEncoder
   * @param {Float32Array} ctx.viewMatrix
   * @param {Float32Array} ctx.projMatrix
   * @param {[number, number, number]} ctx.cameraPosition
   * @param {number} ctx.normalizedTime
   */
  _renderSpherical(ctx) {
    const { passEncoder, viewMatrix, projMatrix, cameraPosition } = ctx;
    if (!this._posBuf || !this.totalIndices) return;
    if (!this._rampBindGroup) return;

    const colorType = this.style.color?.type;
    let colorMode = 0;
    if (colorType === 'ramp') colorMode = 1;
    else if (colorType === 'categorical' || colorType === 'constant') colorMode = 2;

    const domain = this.style.color?.domain || [0, 1];
    const opacity = this.style.opacity?.type === 'constant' ? this.style.opacity.value : 0.7;

    const f32 = this._sphericalF32;
    const i32 = this._sphericalI32;
    // mat4 view (offset 0)
    f32.set(viewMatrix, 0);
    // mat4 projection (offset 64 bytes / index 16)
    f32.set(projMatrix, 16);
    // offset 128 bytes / index 32
    f32[32] = domain[0]; // domain.x
    f32[33] = domain[1]; // domain.y
    f32[34] = opacity; // opacity
    i32[35] = colorMode; // color_mode
    f32[36] = this.style.color?.width || 256.0; // cat_width
    f32[37] = this._extrusionScale; // extrusion_scale
    // f32[38] = _pad0, f32[39] = _pad1
    // f32[40..42] = camera_position (offset 160)
    if (cameraPosition) {
      f32[40] = cameraPosition[0];
      f32[41] = cameraPosition[1];
      f32[42] = cameraPosition[2];
    }

    this.device.queue.writeBuffer(this._sphericalUniformBuf, 0, this._sphericalScratch);

    passEncoder.setPipeline(this._sphericalPipeline);
    passEncoder.setBindGroup(0, this._sphericalUniformBG);
    passEncoder.setBindGroup(1, this._rampBindGroup);
    this._bindVertexBuffers(passEncoder);
    passEncoder.drawIndexed(this.totalIndices);
  }

  /**
   * Mercator render (internal).
   * @param {Object} ctx
   * @param {GPURenderPassEncoder} ctx.passEncoder
   * @param {{ lng: number, lat: number, zoom: number }} ctx.camera
   * @param {number} ctx.viewportW
   * @param {number} ctx.viewportH
   * @param {number} ctx.normalizedTime
   */
  _renderMercator(ctx) {
    const { passEncoder, camera, viewportW, viewportH } = ctx;
    if (!this._mercPosBuf || !this._mercTotalIndices) return;
    if (!this._rampBindGroup) return;
    if (!this._mercPipeline) this._buildMercPipeline();

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
    const opacity = this.style.opacity?.type === 'constant' ? this.style.opacity.value : 0.7;

    const f32 = this._mercF32;
    const i32 = this._mercI32;
    f32[0] = worldSize;
    f32[1] = 0; // _pad0
    f32[2] = cameraX;
    f32[3] = cameraY;
    f32[4] = viewportW;
    f32[5] = viewportH;
    f32[6] = domain[0];
    f32[7] = domain[1];
    f32[8] = opacity;
    i32[9] = colorMode;
    f32[10] = this.style.color?.width || 256.0; // cat_width
    // Convert spherical extrusion units → zoom-0 world pixels so YAML
    // values stay visually comparable across modes.
    f32[11] = this._extrusionScale * MERC_EXTRUSION_FACTOR;
    f32[12] = camera.tilt ?? 0;

    // Horizontal world copies: draw one instance per visible copy so polygons
    // repeat across the antimeridian like the Mercator tiles do. When the
    // camera bounds navigation to a single world, this collapses to 1 copy.
    const { firstCopy, copyCount } = computeWorldCopies(
      cameraX,
      worldSize,
      viewportW,
      camera.renderWorldCopies
    );
    f32[13] = firstCopy; // offset 52: first_copy
    // f32[14..15] = _pad2, _pad3

    this.device.queue.writeBuffer(this._mercUniformBuf, 0, this._mercScratch);

    passEncoder.setPipeline(this._mercPipeline);
    passEncoder.setBindGroup(0, this._mercUniformBG);
    passEncoder.setBindGroup(1, this._rampBindGroup);
    passEncoder.setVertexBuffer(0, this._mercPosBuf);
    passEncoder.setVertexBuffer(1, this._mercValueBuf);
    passEncoder.setVertexBuffer(2, this._mercVisBuf);
    passEncoder.setIndexBuffer(this._mercIndexBuf, this._mercIndexFormat);
    passEncoder.drawIndexed(this._mercTotalIndices, copyCount);
  }

  // ─── Dispose ──────────────────────────────────────────────────────────────

  dispose() {
    this._posBuf?.destroy();
    this._valueBuf?.destroy();
    this._visBuf?.destroy();
    this._indexBuf?.destroy();
    this._mercPosBuf?.destroy();
    this._mercValueBuf?.destroy();
    this._mercVisBuf?.destroy();
    this._mercIndexBuf?.destroy();
    this._sphericalUniformBuf?.destroy();
    this._mercUniformBuf?.destroy();
    if (this.style) this.style.disposeGPU?.();
    this._visData = null;
    this._featureForVertex = null;
    this._filterPredicates = null;
    this._mercVisData = null;
    this._mercParentVertexMap = null;
    this._sphericalScratch = null;
    this._sphericalF32 = null;
    this._sphericalI32 = null;
    this._mercScratch = null;
    this._mercF32 = null;
    this._mercI32 = null;
  }
}
