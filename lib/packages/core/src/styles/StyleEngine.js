/**
 * StyleEngine.js — Parses style specifications, compiles them to GPU resources,
 * and provides a programmatic API for building styles.
 *
 * Supports multi-attribute styling: separate ramps/LUTs for color, opacity,
 * size, width, etc. Each visual property can be driven by a different data column.
 *
 * Style types:
 *   - color-ramp:   Continuous value → color via 1D texture (H3Flex cells, line coloring)
 *   - categorical:  Dictionary enum  → color via LUT texture (categories, regions)
 *   - constant:     Fixed color/opacity/width for all features
 *
 * GPU upload methods (WebGL2/WebGPU) are thin wrappers kept in this file for
 * completeness but are not unit-tested — integration-test them in-browser.
 * The pure-CPU helpers (compileRampData, compileCategoricalData, parseColor)
 * are fully unit-tested in tests/StyleEngine.test.js.
 */

import {
  compileRampData,
  uploadRampTexture,
  uploadRampTextureGPU,
  parseColor,
} from './RampCompiler.js';
import {
  compileCategoricalData,
  uploadCategoricalTexture,
  uploadCategoricalTextureGPU,
} from './CategoricalCompiler.js';

// ─────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────

/**
 * Normalise the flat YAML spec format into the canonical nested form.
 *
 * YAML configs may arrive as:
 *   { type: 'ramp', attribute: 'x', domain: [...], stops: [...] }
 * The compiler expects:
 *   { attribute: 'x', style: { type: 'color-ramp', domain: [...], stops: [...] } }
 *
 * Guard: skip normalisation when spec.color is already a nested object
 * (pre-normalised form used by metric-switching code) — but allow through
 * when spec.color is a primitive string (flat constant: { type: 'constant', color: '#hex' }).
 *
 * @param {Object} spec
 * @returns {Object} Normalised spec
 */
function _normalizeSpec(spec) {
  if (!spec.type || spec.style || (spec.color && typeof spec.color === 'object')) {
    return spec;
  }
  const t = spec.type;
  if (t === 'ramp' || t === 'color-ramp') {
    return { attribute: spec.attribute, style: { ...spec, type: 'color-ramp' } };
  }
  if (t === 'categorical') {
    return {
      attribute: spec.attribute,
      style: {
        ...spec,
        type: 'categorical',
        default: typeof spec.default === 'string' ? { color: spec.default } : spec.default,
      },
    };
  }
  if (t === 'constant') {
    return { style: { ...spec } };
  }
  return spec;
}

/**
 * Compile the color portion of a spec to a CPU-side descriptor.
 * Returns { colorSpec, rampData | lutData | null } so the caller can
 * then perform the GPU upload using the appropriate API.
 *
 * @param {Object} spec - Already-normalised spec
 * @param {string[]} dictionary - String dictionary for resolving categorical category names
 * @returns {{ colorSpec: Object, rampData?: Uint8Array, lutData?: Uint8Array, lutWidth?: number }}
 */
function _prepareColor(spec, dictionary) {
  if (spec.style?.type === 'color-ramp' || spec.color?.type === 'ramp') {
    const rampSpec = spec.style || spec.color;
    const domain = rampSpec.domain || [0, 1];
    let opacityStops = rampSpec.opacityStops || null;
    if (!opacityStops && Array.isArray(rampSpec.opacity)) {
      opacityStops = rampSpec.opacity;
    }

    // Normalize plain-string stops to { value, color } evenly across domain
    let stops = rampSpec.stops;
    if (Array.isArray(stops) && stops.length > 0 && typeof stops[0] === 'string') {
      stops = stops.map((color, i) => ({
        value: domain[0] + (domain[1] - domain[0]) * (i / (stops.length - 1)),
        color,
      }));
    }

    const rampData = compileRampData(stops, domain, opacityStops);
    return {
      colorSpec: {
        type: 'ramp',
        attribute: rampSpec.attribute || spec.attribute,
        domain,
        stops,
        opacityStops,
        hasOpacityRamp: !!opacityStops,
        interpolate: rampSpec.interpolate,
      },
      rampData,
    };
  }

  if (spec.style?.type === 'categorical' || spec.color?.type === 'categorical') {
    const catSpec = spec.style || spec.color;
    const { data, width } = compileCategoricalData(
      catSpec.categories,
      dictionary,
      catSpec.default?.color || '#999'
    );
    return {
      colorSpec: {
        type: 'categorical',
        attribute: catSpec.attribute || spec.attribute,
        width,
        categories: catSpec.categories || {},
      },
      lutData: data,
      lutWidth: width,
    };
  }

  if (spec.style?.type === 'constant' || spec.color?.type === 'constant') {
    const constSpec = spec.style || spec.color;
    const colorStr = constSpec.color || constSpec.default || '#FFFFFF';
    return {
      colorSpec: {
        type: 'constant',
        value: parseColor(colorStr),
      },
    };
  }

  return { colorSpec: null };
}

// ─────────────────────────────────────────────────────────
// CompiledStyle — container for GPU-ready resources
// ─────────────────────────────────────────────────────────

/**
 * A CompiledStyle holds GPU-ready resources for one layer.
 *
 * Instances are returned by {@link StyleEngine.compile} and {@link StyleEngine.compileGPU}.
 * Call `dispose()` or `disposeGPU()` when the associated layer is removed to prevent
 * GPU memory leaks.
 *
 * @property {Object|null} color - Color descriptor: `{ type, attribute?, domain?, texture?, value? }`
 * @property {Object|null} opacity - Opacity descriptor: `{ type, value? | attribute?, texture? }`
 * @property {Object|null} size - Point size descriptor: `{ type: 'constant', value: number }`
 * @property {Object|null} width - Line width descriptor: `{ type: 'constant', value: number }`
 * @property {Object|null} outline - Polygon outline: `{ color, width, opacity }`
 * @property {Object|null} icon - Icon descriptor: `{ shape, sdf }` (reserved for future use)
 */
class CompiledStyle {
  /**
   * Create an empty CompiledStyle.
   * All properties are initialized to null and populated by the compile methods.
   */
  constructor() {
    this.color = null; // { type, texture?, uniforms }
    this.opacity = null; // { type, texture?, uniform }
    this.size = null; // { type, uniform } (for points)
    this.width = null; // { type, uniform } (for lines)
    this.outline = null; // { color, width, opacity }
    this.icon = null; // { shape, sdf }
  }

  /**
   * Delete WebGL2 textures owned by this compiled style.
   * Safe to call even if no textures were created (constant-color styles).
   *
   * @param {WebGL2RenderingContext} gl - The WebGL2 context that created the textures
   * @returns {void}
   */
  dispose(gl) {
    if (this.color?.texture) gl.deleteTexture(this.color.texture);
    if (this.opacity?.texture) gl.deleteTexture(this.opacity.texture);
  }

  /**
   * Destroy WebGPU textures owned by this compiled style.
   * Safe to call even if no textures were created (constant-color styles).
   *
   * @returns {void}
   */
  disposeGPU() {
    if (this.color?.texture?.destroy) this.color.texture.destroy();
    if (this.opacity?.texture?.destroy) this.opacity.texture.destroy();
  }
}

// ─────────────────────────────────────────────────────────
// StyleEngine
// ─────────────────────────────────────────────────────────

export class StyleEngine {
  /**
   * Compile a style spec into WebGL2 GPU resources.
   *
   * @param {WebGL2RenderingContext} gl - Active WebGL2 context used to create textures
   * @param {Object} spec - Style specification (from JSON or programmatic API)
   * @param {string[]} [dictionary=[]] - String dictionary from decoded data, required for
   *   categorical styles; maps texel index → category name
   * @returns {CompiledStyle}
   */
  static compile(gl, spec, dictionary = []) {
    spec = _normalizeSpec(spec);
    const compiled = new CompiledStyle();

    // ── Color ──
    const { colorSpec, rampData, lutData, lutWidth } = _prepareColor(spec, dictionary);
    if (colorSpec) {
      compiled.color = colorSpec;
      if (colorSpec.type === 'ramp') {
        compiled.color.texture = uploadRampTexture(gl, rampData);
      } else if (colorSpec.type === 'categorical') {
        compiled.color.texture = uploadCategoricalTexture(gl, lutData, lutWidth);
      } else if (colorSpec.type === 'constant') {
        // Create a minimal 1×1 WebGL2 texture so line/poly renderers can
        // bind it unconditionally (same pattern as compileGPU).
        const rgba = new Uint8Array([
          Math.round(colorSpec.value[0] * 255),
          Math.round(colorSpec.value[1] * 255),
          Math.round(colorSpec.value[2] * 255),
          255,
        ]);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        gl.bindTexture(gl.TEXTURE_2D, null);
        compiled.color.texture = tex;
        // width=1 so categorical LUT sampling (0.5/width) hits the only texel
        compiled.color.width = 1;
      }
    }

    // ── Opacity ──
    if (spec.opacity?.type === 'ramp') {
      const domain = spec.opacity.domain || [0, 1];
      const rampOpacityData = compileRampData(
        spec.opacity.stops.map((s) => ({
          value: s.value,
          color:
            '#ffffff' +
            Math.round(s.opacity * 255)
              .toString(16)
              .padStart(2, '0'),
        })),
        domain
      );
      compiled.opacity = {
        type: 'ramp',
        attribute: spec.opacity.attribute,
        texture: uploadRampTexture(gl, rampOpacityData),
        domain,
      };
    } else {
      const hasRampAlpha = compiled.color?.hasOpacityRamp;
      compiled.opacity = {
        type: 'constant',
        value: hasRampAlpha ? 1.0 : (spec.style?.opacity ?? spec.opacity?.value ?? 0.7),
      };
    }

    // ── Size (points) ──
    compiled.size = {
      type: 'constant',
      value: spec.style?.icon?.radius ?? spec.size?.value ?? 4,
    };

    // ── Width (lines) ──
    compiled.width = {
      type: 'constant',
      value: spec.style?.width ?? spec.width?.value ?? 2,
    };

    // ── Outline (polygons) ──
    if (spec.style?.outline) {
      compiled.outline = {
        color: parseColor(spec.style.outline.color || '#FFFFFF'),
        width: spec.style.outline.width || 1,
        opacity: spec.style.outline.opacity ?? 0.8,
      };
    }

    return compiled;
  }

  /**
   * Compile a style spec for WebGPU — same logic as compile() but creates GPUTextures.
   *
   * @param {GPUDevice} device - Active WebGPU device used to create textures
   * @param {Object} spec - Style specification (from JSON or programmatic API)
   * @param {string[]} [dictionary=[]] - String dictionary from decoded data, required for
   *   categorical styles; maps texel index → category name
   * @returns {CompiledStyle}
   */
  static compileGPU(device, spec, dictionary = []) {
    spec = _normalizeSpec(spec);
    const compiled = new CompiledStyle();

    // ── Color ──
    const { colorSpec, rampData, lutData, lutWidth } = _prepareColor(spec, dictionary);
    if (colorSpec) {
      compiled.color = colorSpec;
      if (colorSpec.type === 'ramp') {
        compiled.color.texture = uploadRampTextureGPU(device, rampData);
      } else if (colorSpec.type === 'categorical') {
        compiled.color.texture = uploadCategoricalTextureGPU(device, lutData, lutWidth);
      } else if (colorSpec.type === 'constant') {
        // For WebGPU, create a minimal 1×1 texture to satisfy the bind group layout
        // which always expects a bound texture even for constant styles.
        const rgba = new Uint8Array([
          Math.round(colorSpec.value[0] * 255),
          Math.round(colorSpec.value[1] * 255),
          Math.round(colorSpec.value[2] * 255),
          255,
        ]);
        const texture = device.createTexture({
          size: [1, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture({ texture }, rgba, { bytesPerRow: 4 }, [1, 1]);
        compiled.color.texture = texture;
        // width=1 so categorical LUT sampling (0.5/width) hits the only texel
        compiled.color.width = 1;
      }
    }

    // ── Opacity (WebGPU path only supports constant for now) ──
    const hasRampAlpha = compiled.color?.hasOpacityRamp;
    compiled.opacity = {
      type: 'constant',
      value: hasRampAlpha ? 1.0 : (spec.style?.opacity ?? spec.opacity?.value ?? 0.7),
    };

    // ── Size / Width ──
    compiled.size = {
      type: 'constant',
      value: spec.style?.icon?.radius ?? spec.size?.value ?? 4,
    };
    compiled.width = {
      type: 'constant',
      value: spec.style?.width ?? spec.width?.value ?? 2,
    };

    return compiled;
  }

  // ─────────────────────────────────────────────────────
  // Programmatic API — build style specs without JSON
  // ─────────────────────────────────────────────────────

  /**
   * Create a color ramp style spec.
   *
   * @param {Object} opts
   * @param {string} opts.attribute - Column name to map
   * @param {number[]} opts.domain - [min, max]
   * @param {string[]|Array<{value:number,color:string}>} opts.stops
   * @param {number} [opts.opacity=0.7] - Global opacity (ignored when opacityStops provided)
   * @param {Array<{value:number,opacity:number}>} [opts.opacityStops] - Graduated alpha
   * @returns {Object} Style spec ready for compile()
   */
  static ramp({ attribute, domain, stops, opacity = 0.7, opacityStops }) {
    // If stops are plain strings, distribute evenly across domain
    const normalizedStops =
      Array.isArray(stops) && typeof stops[0] === 'string'
        ? stops.map((color, i) => ({
            value: domain[0] + (domain[1] - domain[0]) * (i / (stops.length - 1)),
            color,
          }))
        : stops;

    const styleObj = {
      type: 'color-ramp',
      attribute,
      domain,
      stops: normalizedStops,
      opacity: opacityStops ? 1.0 : opacity, // 1.0 when alpha is in the ramp
    };
    if (opacityStops) styleObj.opacityStops = opacityStops;

    return { attribute, style: styleObj };
  }

  /**
   * Create a categorical style spec.
   *
   * @param {Object} opts
   * @param {string} opts.attribute - Column name
   * @param {Object} opts.categories - { name: color } or { name: { color, opacity } }
   * @param {string} [opts.default='#999999']
   * @param {number} [opts.opacity=0.9]
   * @returns {Object} Style spec ready for compile()
   */
  static categorical({ attribute, categories, default: defaultColor = '#999999', opacity = 0.9 }) {
    return {
      attribute,
      style: {
        type: 'categorical',
        attribute,
        categories,
        default: { color: defaultColor },
        opacity,
      },
    };
  }

  /**
   * Create a multi-attribute style spec (separate attributes for color and opacity).
   *
   * @param {Object} opts
   * @param {Object} opts.color - Color spec: { type: 'ramp'|'categorical', attribute, ... }
   * @param {Object} [opts.opacity] - Opacity spec: { type: 'ramp', attribute, domain, stops }
   * @param {Object} [opts.size] - Point size spec: { value: number }
   * @param {Object} [opts.width] - Line width spec: { value: number }
   * @returns {Object} Style spec ready for compile() / compileGPU()
   */
  static multi({ color, opacity, size, width }) {
    return { color, opacity, size, width };
  }

  /**
   * Update just the color ramp of an existing CompiledStyle — no shader recompile.
   * WebGL2 path: overwrites the existing texture via texSubImage2D (~0.1 ms).
   * No-ops if `compiled.color.type` is not `'ramp'`.
   *
   * @param {WebGL2RenderingContext} gl - Active WebGL2 context
   * @param {CompiledStyle} compiled - The compiled style whose ramp texture will be updated
   * @param {Array<{value:number,color:string}>} stops - New color stops
   * @param {number[]} domain - New [min, max] data domain
   * @param {Array<{value:number,opacity:number}>} [opacityStops] - New graduated alpha stops
   * @returns {void}
   */
  static updateRamp(gl, compiled, stops, domain, opacityStops) {
    if (compiled.color?.type !== 'ramp') return;
    const rampData = compileRampData(stops, domain, opacityStops || null);
    uploadRampTexture(gl, rampData, compiled.color.texture);
    compiled.color.domain = domain;
    compiled.color.hasOpacityRamp = !!opacityStops;
  }

  /**
   * Update just the color ramp of an existing CompiledStyle — no shader recompile.
   * WebGPU path: overwrites the existing 256×1 texture via queue.writeTexture()
   * (~0.1 ms CPU + 1 KB GPU upload). GPUTexture was created with COPY_DST so no
   * recreation or bind group rebuild is required.
   * No-ops if `compiled.color.type` is not `'ramp'`.
   *
   * @param {GPUDevice} device - Active WebGPU device
   * @param {CompiledStyle} compiled - The compiled style whose ramp texture will be updated
   * @param {Array<{value:number,color:string}>} stops - New color stops
   * @param {number[]} domain - New [min, max] data domain
   * @param {Array<{value:number,opacity:number}>} [opacityStops] - New graduated alpha stops
   * @returns {void}
   */
  static updateRampGPU(device, compiled, stops, domain, opacityStops) {
    if (compiled.color?.type !== 'ramp') return;
    const rampData = compileRampData(stops, domain, opacityStops || null);
    device.queue.writeTexture(
      { texture: compiled.color.texture },
      rampData,
      { bytesPerRow: rampData.length }, // 256 * 4 = 1 KB
      [rampData.length / 4, 1]
    );
    compiled.color.domain = domain;
    compiled.color.hasOpacityRamp = !!opacityStops;
  }
}
