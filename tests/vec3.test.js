// tests/vec3.test.js — Unit tests for vec3 operations
import * as vec3 from '../src/math/vec3.js';

describe('vec3', () => {
  describe('create / fromValues', () => {
    test('create defaults to (0, 0, 0)', () => {
      const v = vec3.create();
      expect(v).toBeInstanceOf(Float32Array);
      expect(v[0]).toBe(0);
      expect(v[1]).toBe(0);
      expect(v[2]).toBe(0);
    });

    test('create with values', () => {
      const v = vec3.create(1, 2, 3);
      expect(v[0]).toBe(1);
      expect(v[1]).toBe(2);
      expect(v[2]).toBe(3);
    });

    test('fromValues is equivalent to create with args', () => {
      const a = vec3.create(4, 5, 6);
      const b = vec3.fromValues(4, 5, 6);
      expect(Array.from(a)).toEqual(Array.from(b));
    });
  });

  describe('add', () => {
    test('adds component-wise', () => {
      const out = vec3.create();
      const a = vec3.fromValues(1, 2, 3);
      const b = vec3.fromValues(4, 5, 6);
      vec3.add(out, a, b);
      expect(out[0]).toBe(5);
      expect(out[1]).toBe(7);
      expect(out[2]).toBe(9);
    });

    test('adding zero is identity', () => {
      const out = vec3.create();
      const a = vec3.fromValues(10, 20, 30);
      const zero = vec3.create();
      vec3.add(out, a, zero);
      expect(Array.from(out)).toEqual([10, 20, 30]);
    });
  });

  describe('subtract', () => {
    test('subtracts component-wise', () => {
      const out = vec3.create();
      vec3.subtract(out, vec3.fromValues(5, 7, 9), vec3.fromValues(1, 2, 3));
      expect(out[0]).toBe(4);
      expect(out[1]).toBe(5);
      expect(out[2]).toBe(6);
    });

    test('subtracting self gives zero', () => {
      const out = vec3.create();
      const a = vec3.fromValues(3, 4, 5);
      vec3.subtract(out, a, a);
      expect(out[0]).toBe(0);
      expect(out[1]).toBe(0);
      expect(out[2]).toBe(0);
    });
  });

  describe('scale', () => {
    test('scales by scalar', () => {
      const out = vec3.create();
      vec3.scale(out, vec3.fromValues(1, 2, 3), 2);
      expect(out[0]).toBe(2);
      expect(out[1]).toBe(4);
      expect(out[2]).toBe(6);
    });

    test('scaling by 0 gives zero vector', () => {
      const out = vec3.create();
      vec3.scale(out, vec3.fromValues(10, 20, 30), 0);
      expect(out[0]).toBe(0);
      expect(out[1]).toBe(0);
      expect(out[2]).toBe(0);
    });

    test('scaling by -1 negates', () => {
      const out = vec3.create();
      vec3.scale(out, vec3.fromValues(3, -4, 5), -1);
      expect(out[0]).toBe(-3);
      expect(out[1]).toBe(4);
      expect(out[2]).toBe(-5);
    });
  });

  describe('dot', () => {
    test('dot product of orthogonal vectors is 0', () => {
      expect(vec3.dot(vec3.fromValues(1, 0, 0), vec3.fromValues(0, 1, 0))).toBe(0);
    });

    test('dot product of parallel vectors is product of lengths', () => {
      expect(vec3.dot(vec3.fromValues(3, 0, 0), vec3.fromValues(4, 0, 0))).toBe(12);
    });

    test('dot product is symmetric', () => {
      const a = vec3.fromValues(1, 2, 3);
      const b = vec3.fromValues(4, 5, 6);
      expect(vec3.dot(a, b)).toBe(vec3.dot(b, a));
    });

    test('standard calculation', () => {
      // 1*4 + 2*5 + 3*6 = 4+10+18 = 32
      expect(vec3.dot(vec3.fromValues(1, 2, 3), vec3.fromValues(4, 5, 6))).toBe(32);
    });
  });

  describe('cross', () => {
    test('x × y = z', () => {
      const out = vec3.create();
      vec3.cross(out, vec3.fromValues(1, 0, 0), vec3.fromValues(0, 1, 0));
      expect(out[0]).toBeCloseTo(0);
      expect(out[1]).toBeCloseTo(0);
      expect(out[2]).toBeCloseTo(1);
    });

    test('y × x = -z', () => {
      const out = vec3.create();
      vec3.cross(out, vec3.fromValues(0, 1, 0), vec3.fromValues(1, 0, 0));
      expect(out[0]).toBeCloseTo(0);
      expect(out[1]).toBeCloseTo(0);
      expect(out[2]).toBeCloseTo(-1);
    });

    test('cross product of parallel vectors is zero', () => {
      const out = vec3.create();
      vec3.cross(out, vec3.fromValues(2, 0, 0), vec3.fromValues(5, 0, 0));
      expect(out[0]).toBe(0);
      expect(out[1]).toBe(0);
      expect(out[2]).toBe(0);
    });
  });

  describe('length', () => {
    test('unit vector has length 1', () => {
      expect(vec3.length(vec3.fromValues(1, 0, 0))).toBe(1);
      expect(vec3.length(vec3.fromValues(0, 1, 0))).toBe(1);
      expect(vec3.length(vec3.fromValues(0, 0, 1))).toBe(1);
    });

    test('zero vector has length 0', () => {
      expect(vec3.length(vec3.create())).toBe(0);
    });

    test('3-4-5 triangle', () => {
      expect(vec3.length(vec3.fromValues(3, 4, 0))).toBeCloseTo(5);
    });
  });

  describe('normalize', () => {
    test('normalizing a vector gives length 1', () => {
      const out = vec3.create();
      vec3.normalize(out, vec3.fromValues(3, 4, 0));
      expect(vec3.length(out)).toBeCloseTo(1, 5);
    });

    test('normalizing unit vector returns same direction', () => {
      const out = vec3.create();
      vec3.normalize(out, vec3.fromValues(0, 0, 5));
      expect(out[0]).toBeCloseTo(0);
      expect(out[1]).toBeCloseTo(0);
      expect(out[2]).toBeCloseTo(1);
    });

    test('normalizing zero vector does not crash', () => {
      const out = vec3.create();
      vec3.normalize(out, vec3.create());
      // Should remain zero (no NaN)
      expect(out[0]).toBe(0);
    });
  });

  describe('lerp', () => {
    test('t=0 returns first vector', () => {
      const out = vec3.create();
      const a = vec3.fromValues(0, 0, 0);
      const b = vec3.fromValues(10, 20, 30);
      vec3.lerp(out, a, b, 0);
      expect(Array.from(out)).toEqual([0, 0, 0]);
    });

    test('t=1 returns second vector', () => {
      const out = vec3.create();
      vec3.lerp(out, vec3.fromValues(0, 0, 0), vec3.fromValues(10, 20, 30), 1);
      expect(Array.from(out)).toEqual([10, 20, 30]);
    });

    test('t=0.5 returns midpoint', () => {
      const out = vec3.create();
      vec3.lerp(out, vec3.fromValues(0, 0, 0), vec3.fromValues(10, 20, 30), 0.5);
      expect(out[0]).toBeCloseTo(5);
      expect(out[1]).toBeCloseTo(10);
      expect(out[2]).toBeCloseTo(15);
    });
  });

  describe('copy', () => {
    test('copies values without reference', () => {
      const a = vec3.fromValues(1, 2, 3);
      const out = vec3.create();
      vec3.copy(out, a);
      expect(Array.from(out)).toEqual([1, 2, 3]);
      // Mutation of original should not affect copy
      a[0] = 99;
      expect(out[0]).toBe(1);
    });
  });

  describe('negate', () => {
    test('negates all components', () => {
      const out = vec3.create();
      vec3.negate(out, vec3.fromValues(1, -2, 3));
      expect(out[0]).toBe(-1);
      expect(out[1]).toBe(2);
      expect(out[2]).toBe(-3);
    });
  });

  describe('distance', () => {
    test('distance between same point is 0', () => {
      const a = vec3.fromValues(5, 5, 5);
      expect(vec3.distance(a, a)).toBe(0);
    });

    test('distance along axis', () => {
      const a = vec3.fromValues(0, 0, 0);
      const b = vec3.fromValues(3, 4, 0);
      expect(vec3.distance(a, b)).toBeCloseTo(5);
    });

    test('symmetry: d(a,b) = d(b,a)', () => {
      const a = vec3.fromValues(1, 2, 3);
      const b = vec3.fromValues(7, 8, 9);
      expect(vec3.distance(a, b)).toBeCloseTo(vec3.distance(b, a));
    });
  });
});
