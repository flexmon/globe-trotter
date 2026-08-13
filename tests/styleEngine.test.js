// tests/styleEngine.test.js — Unit tests for StyleEngine compile paths
//
// Focuses on constant-color style compilation (Bug 3 fix) and the
// _normalizeSpec / _prepareColor helpers via the public compile() API.
//
// GL/GPU texture creation is mocked at the object level — we verify that
// the correct methods are called with the right pixel data, and that the
// CompiledStyle object has the expected shape.

// Mock GPUTextureUsage (WebGPU global not available in Node.js test environment)
global.GPUTextureUsage = { TEXTURE_BINDING: 0x04, COPY_DST: 0x08 };

import { StyleEngine } from '../src/styles/StyleEngine.js';

// ─── Minimal WebGL2 mock ───────────────────────────────────────────────────
function makeGLMock() {
  const textures = [];
  let boundTexture = null;

  return {
    _textures: textures,
    _lastTexImage2D: null,

    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,

    MAX_TEXTURE_SIZE: 0x0d33,

    createTexture() {
      const t = { id: textures.length };
      textures.push(t);
      return t;
    },
    bindTexture(target, tex) {
      boundTexture = tex;
    },
    texParameteri() {},
    texImage2D(target, level, internalFmt, w, h, border, fmt, type, pixels) {
      this._lastTexImage2D = { w, h, pixels: pixels ? new Uint8Array(pixels) : null };
    },
    texSubImage2D() {},
    getParameter(param) {
      if (param === this.MAX_TEXTURE_SIZE) return 4096;
      return null;
    },
    getAttribLocation() {
      return -1;
    },
    deleteTexture() {},
  };
}

// ─── Constant color — StyleEngine.compile() (WebGL2) ──────────────────────

describe('StyleEngine.compile — constant style', () => {
  let gl;

  beforeEach(() => {
    gl = makeGLMock();
  });

  test('produces colorSpec with type=constant and parsed value', () => {
    const compiled = StyleEngine.compile(gl, { type: 'constant', color: '#ffffff' });
    expect(compiled.color.type).toBe('constant');
    expect(compiled.color.value).toEqual([1, 1, 1, 1]);
  });

  test('creates a 1×1 WebGL texture for constant style', () => {
    StyleEngine.compile(gl, { type: 'constant', color: '#ff0000' });
    expect(gl._textures.length).toBe(1);
    expect(gl._lastTexImage2D).not.toBeNull();
    expect(gl._lastTexImage2D.w).toBe(1);
    expect(gl._lastTexImage2D.h).toBe(1);
  });

  test('1×1 texture pixel matches the constant color (red)', () => {
    StyleEngine.compile(gl, { type: 'constant', color: '#ff0000' });
    const px = gl._lastTexImage2D.pixels;
    expect(px[0]).toBe(255); // R
    expect(px[1]).toBe(0); // G
    expect(px[2]).toBe(0); // B
    expect(px[3]).toBe(255); // A (fully opaque)
  });

  test('1×1 texture pixel matches the constant color (white)', () => {
    StyleEngine.compile(gl, { type: 'constant', color: '#ffffff' });
    const px = gl._lastTexImage2D.pixels;
    expect(px[0]).toBe(255);
    expect(px[1]).toBe(255);
    expect(px[2]).toBe(255);
    expect(px[3]).toBe(255);
  });

  test('sets color.texture to the created WebGL texture object', () => {
    const compiled = StyleEngine.compile(gl, { type: 'constant', color: '#00ff00' });
    expect(compiled.color.texture).toBeDefined();
    expect(compiled.color.texture).toBe(gl._textures[0]);
  });

  test('sets color.width = 1 so LUT sampling hits the single texel', () => {
    const compiled = StyleEngine.compile(gl, { type: 'constant', color: '#0000ff' });
    expect(compiled.color.width).toBe(1);
  });

  test('does NOT create a texture for ramp style (sanity check)', () => {
    // ramp path creates its own texture — ensure we haven't broken it
    const compiled = StyleEngine.compile(gl, {
      type: 'ramp',
      attribute: 'x',
      domain: [0, 100],
      stops: [
        { value: 0, color: '#000000' },
        { value: 100, color: '#ffffff' },
      ],
    });
    expect(compiled.color.type).toBe('ramp');
    // ramp also creates a texture — but it's a 256×1 texture, not 1×1
    expect(compiled.color.texture).toBeDefined();
    if (gl._lastTexImage2D) {
      // ramp texture should be wider than 1
      expect(gl._lastTexImage2D.w).toBeGreaterThan(1);
    }
  });

  test('opacity is set from spec.style.opacity', () => {
    const compiled = StyleEngine.compile(gl, { type: 'constant', color: '#ffffff', opacity: 0.5 });
    expect(compiled.opacity.value).toBeCloseTo(0.5);
  });
});

// ─── Constant color — StyleEngine.compileGPU() (WebGPU) ───────────────────

describe('StyleEngine.compileGPU — constant style', () => {
  function makeGPUMock() {
    const textures = [];
    let lastWriteTexture = null;

    return {
      _textures: textures,
      _lastWriteTexture: () => lastWriteTexture,

      createTexture({ size, format, usage }) {
        const t = { size, format, usage, id: textures.length, destroy() {} };
        textures.push(t);
        return t;
      },
      queue: {
        writeTexture(dest, data, layout, extents) {
          lastWriteTexture = { dest, data: new Uint8Array(data), layout, extents };
        },
      },
    };
  }

  test('produces colorSpec with type=constant', () => {
    const device = makeGPUMock();
    const compiled = StyleEngine.compileGPU(device, { type: 'constant', color: '#ffffff' });
    expect(compiled.color.type).toBe('constant');
    expect(compiled.color.value).toEqual([1, 1, 1, 1]);
  });

  test('creates a 1×1 GPUTexture for constant style', () => {
    const device = makeGPUMock();
    StyleEngine.compileGPU(device, { type: 'constant', color: '#ff0000' });
    expect(device._textures.length).toBe(1);
    expect(device._textures[0].size).toEqual([1, 1]);
  });

  test('writes correct RGBA pixel to the GPU texture (red)', () => {
    const device = makeGPUMock();
    StyleEngine.compileGPU(device, { type: 'constant', color: '#ff0000' });
    const px = device._lastWriteTexture().data;
    expect(px[0]).toBe(255); // R
    expect(px[1]).toBe(0); // G
    expect(px[2]).toBe(0); // B
    expect(px[3]).toBe(255); // A
  });

  test('writes correct RGBA pixel to the GPU texture (white)', () => {
    const device = makeGPUMock();
    StyleEngine.compileGPU(device, { type: 'constant', color: '#ffffff' });
    const px = device._lastWriteTexture().data;
    expect(px[0]).toBe(255);
    expect(px[1]).toBe(255);
    expect(px[2]).toBe(255);
    expect(px[3]).toBe(255);
  });

  test('sets color.texture to the created GPUTexture', () => {
    const device = makeGPUMock();
    const compiled = StyleEngine.compileGPU(device, { type: 'constant', color: '#00ff00' });
    expect(compiled.color.texture).toBe(device._textures[0]);
  });

  test('sets color.width = 1 so categorical LUT sampling hits the single texel', () => {
    const device = makeGPUMock();
    const compiled = StyleEngine.compileGPU(device, { type: 'constant', color: '#0000ff' });
    expect(compiled.color.width).toBe(1);
  });
});

// ─── Spec normalisation ────────────────────────────────────────────────────

describe('StyleEngine spec normalisation', () => {
  let gl;
  beforeEach(() => {
    gl = makeGLMock();
  });

  test('flat constant spec {type,color} is normalised correctly', () => {
    const compiled = StyleEngine.compile(gl, { type: 'constant', color: '#123456' });
    expect(compiled.color.type).toBe('constant');
  });

  test('flat ramp spec is normalised correctly', () => {
    const compiled = StyleEngine.compile(gl, {
      type: 'ramp',
      attribute: 'foo',
      domain: [0, 1],
      stops: [
        { value: 0, color: '#000000' },
        { value: 1, color: '#ffffff' },
      ],
    });
    expect(compiled.color.type).toBe('ramp');
    expect(compiled.color.attribute).toBe('foo');
  });

  test('flat categorical spec is normalised correctly', () => {
    const compiled = StyleEngine.compile(
      gl,
      {
        type: 'categorical',
        attribute: 'airline',
        categories: { Delta: '#001E70' },
        default: '#999',
      },
      ['Delta', 'United']
    );
    expect(compiled.color.type).toBe('categorical');
    expect(compiled.color.attribute).toBe('airline');
  });
});
