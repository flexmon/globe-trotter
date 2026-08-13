// tests/mat4.test.js — Unit tests for 4x4 matrix operations
import * as mat4 from '../src/math/mat4.js';

describe('mat4', () => {
  describe('create / identity', () => {
    test('create returns identity matrix', () => {
      const m = mat4.create();
      expect(m[0]).toBe(1);
      expect(m[5]).toBe(1);
      expect(m[10]).toBe(1);
      expect(m[15]).toBe(1);
      expect(m[1]).toBe(0);
      expect(m[4]).toBe(0);
    });

    test('identity resets matrix', () => {
      const m = new Float32Array(16);
      m.fill(7);
      mat4.identity(m);
      expect(m[0]).toBe(1);
      expect(m[5]).toBe(1);
      expect(m[10]).toBe(1);
      expect(m[15]).toBe(1);
      expect(m[1]).toBe(0);
      expect(m[2]).toBe(0);
    });
  });

  describe('multiply', () => {
    test('identity × identity = identity', () => {
      const a = mat4.create();
      const b = mat4.create();
      const out = mat4.create();
      mat4.multiply(out, a, b);
      for (let i = 0; i < 16; i++) {
        expect(out[i]).toBeCloseTo(a[i], 10);
      }
    });

    test('identity × M = M', () => {
      const id = mat4.create();
      const m = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const out = mat4.create();
      mat4.multiply(out, id, m);
      for (let i = 0; i < 16; i++) {
        expect(out[i]).toBeCloseTo(m[i], 10);
      }
    });

    test('M × identity = M', () => {
      const id = mat4.create();
      const m = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const out = mat4.create();
      mat4.multiply(out, m, id);
      for (let i = 0; i < 16; i++) {
        expect(out[i]).toBeCloseTo(m[i], 10);
      }
    });
  });

  describe('perspective', () => {
    test('produces valid projection matrix', () => {
      const out = mat4.create();
      mat4.perspective(out, Math.PI / 4, 16 / 9, 0.1, 100);

      // Check key properties
      expect(out[0]).toBeGreaterThan(0); // f/aspect
      expect(out[5]).toBeGreaterThan(0); // f
      expect(out[11]).toBe(-1); // perspective divide
      expect(out[15]).toBe(0); // perspective
    });

    test('different aspect ratios produce different x-scale', () => {
      const wide = mat4.create();
      const narrow = mat4.create();
      mat4.perspective(wide, Math.PI / 4, 2.0, 0.1, 100);
      mat4.perspective(narrow, Math.PI / 4, 0.5, 0.1, 100);
      expect(narrow[0]).toBeGreaterThan(wide[0]);
    });
  });

  describe('lookAt', () => {
    test('looking along -Z from origin', () => {
      const out = mat4.create();
      mat4.lookAt(
        out,
        new Float32Array([0, 0, 5]),
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0])
      );

      // Should produce a valid view matrix
      expect(out[15]).toBeCloseTo(1, 5);
      // Translation should move camera back
      expect(out[14]).toBeCloseTo(-5, 5);
    });

    test('camera position affects translation', () => {
      const out1 = mat4.create();
      const out2 = mat4.create();
      mat4.lookAt(
        out1,
        new Float32Array([0, 0, 3]),
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0])
      );
      mat4.lookAt(
        out2,
        new Float32Array([0, 0, 10]),
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0])
      );
      expect(Math.abs(out2[14])).toBeGreaterThan(Math.abs(out1[14]));
    });
  });

  describe('rotateY', () => {
    test('rotateY by 0 radians leaves identity unchanged', () => {
      const a = mat4.create();
      const out = mat4.create();
      mat4.rotateY(out, a, 0);
      for (let i = 0; i < 16; i++) {
        expect(out[i]).toBeCloseTo(a[i], 10);
      }
    });

    test('rotateY by π/2 maps +Z axis to +X', () => {
      // Rotate the identity matrix 90° around Y.
      // Column-major: col 2 (indices 8,9,10,11) represents what happens to +Z input.
      // After 90° Y-rotation: +Z maps to +X → out col 2 should be [1,0,0,0] in col-major.
      const a = mat4.create();
      const out = mat4.create();
      mat4.rotateY(out, a, Math.PI / 2);
      // out[0]=cos, out[8]=sin, out[10]=cos
      expect(out[0]).toBeCloseTo(0, 5); // cos(π/2)
      expect(out[8]).toBeCloseTo(1, 5); // sin(π/2)
      expect(out[10]).toBeCloseTo(0, 5); // cos(π/2)
      expect(out[5]).toBeCloseTo(1, 5); // Y unchanged
    });

    test('rotateY by π produces -I on X/Z block', () => {
      const a = mat4.create();
      const out = mat4.create();
      mat4.rotateY(out, a, Math.PI);
      expect(out[0]).toBeCloseTo(-1, 5);
      expect(out[10]).toBeCloseTo(-1, 5);
      expect(out[5]).toBeCloseTo(1, 5); // Y unchanged
    });

    test('rotateY in-place (out === a) is supported', () => {
      const m = mat4.create();
      mat4.rotateY(m, m, Math.PI / 2);
      expect(m[0]).toBeCloseTo(0, 5);
      expect(m[8]).toBeCloseTo(1, 5);
    });

    test('two rotateY by π/2 each = one rotation by π', () => {
      const a = mat4.create();
      const tmp = mat4.create();
      const out = mat4.create();
      mat4.rotateY(tmp, a, Math.PI / 2);
      mat4.rotateY(out, tmp, Math.PI / 2);
      const ref = mat4.create();
      mat4.rotateY(ref, a, Math.PI);
      for (let i = 0; i < 16; i++) {
        expect(out[i]).toBeCloseTo(ref[i], 4);
      }
    });
  });

  describe('rotateX', () => {
    test('rotateX by 0 radians leaves identity unchanged', () => {
      const a = mat4.create();
      const out = mat4.create();
      mat4.rotateX(out, a, 0);
      for (let i = 0; i < 16; i++) {
        expect(out[i]).toBeCloseTo(a[i], 10);
      }
    });

    test('rotateX by π/2 maps +Z to -Y', () => {
      // After 90° X-rotation: col 2 (Z input) → [0, -sin, cos, 0] = [0,-1,0,0]
      const a = mat4.create();
      const out = mat4.create();
      mat4.rotateX(out, a, Math.PI / 2);
      expect(out[0]).toBeCloseTo(1, 5); // X unchanged
      expect(out[5]).toBeCloseTo(0, 5); // cos(π/2)
      expect(out[6]).toBeCloseTo(1, 5); // sin(π/2) — [2] col of row 1
      expect(out[9]).toBeCloseTo(-1, 5); // -sin(π/2)
      expect(out[10]).toBeCloseTo(0, 5); // cos(π/2)
    });

    test('rotateX by π produces -I on Y/Z block', () => {
      const a = mat4.create();
      const out = mat4.create();
      mat4.rotateX(out, a, Math.PI);
      expect(out[0]).toBeCloseTo(1, 5); // X unchanged
      expect(out[5]).toBeCloseTo(-1, 5); // cos(π)
      expect(out[10]).toBeCloseTo(-1, 5); // cos(π)
    });

    test('rotateX in-place (out === a) is supported', () => {
      const m = mat4.create();
      mat4.rotateX(m, m, Math.PI / 2);
      expect(m[5]).toBeCloseTo(0, 5);
      expect(m[6]).toBeCloseTo(1, 5);
    });

    test('rotateX then rotateY does not commute', () => {
      const identity = mat4.create();
      const xy = mat4.create();
      const yx = mat4.create();
      const tmp = mat4.create();

      mat4.rotateX(tmp, identity, Math.PI / 4);
      mat4.rotateY(xy, tmp, Math.PI / 4);

      mat4.rotateY(tmp, identity, Math.PI / 4);
      mat4.rotateX(yx, tmp, Math.PI / 4);

      // xy !== yx for non-commuting rotations around different axes
      let equal = true;
      for (let i = 0; i < 16; i++) {
        if (Math.abs(xy[i] - yx[i]) > 1e-5) {
          equal = false;
          break;
        }
      }
      expect(equal).toBe(false);
    });
  });

  describe('invert', () => {
    test('inverse of identity is identity', () => {
      const m = mat4.create();
      const out = mat4.create();
      mat4.invert(out, m);
      for (let i = 0; i < 16; i++) {
        expect(out[i]).toBeCloseTo(m[i], 10);
      }
    });

    test('M × M⁻¹ ≈ identity', () => {
      const m = mat4.create();
      mat4.perspective(m, Math.PI / 4, 1.5, 0.1, 100);
      const inv = mat4.create();
      mat4.invert(inv, m);
      const result = mat4.create();
      mat4.multiply(result, m, inv);

      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const expected = i === j ? 1 : 0;
          expect(result[j * 4 + i]).toBeCloseTo(expected, 4);
        }
      }
    });
  });
});
