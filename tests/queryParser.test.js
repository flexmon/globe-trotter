// tests/queryParser.test.js — Unit tests for GPU query filter parser
import { parseQuery, flattenForGPU, FilterOp } from '../src/query/QueryParser.js';

// Mock schema for testing
const mockSchema = {
  staticColumns: {
    custom_region: new Uint16Array([0, 1, 2, 3]),
  },
  temporalColumns: {
    served_mbps: new Float32Array([10, 20, 30]),
    desired_demand_mbps: new Float32Array([5, 10, 15]),
  },
  dictionary: ['GLOBAL', 'CONUS', 'EMEA', 'APAC'],
  schemaList: [
    { name: 'custom_region', type: 6, temporal: 0 },
    { name: 'served_mbps', type: 1, temporal: 1 },
    { name: 'desired_demand_mbps', type: 1, temporal: 1 },
  ],
};

describe('QueryParser', () => {
  describe('FilterOp enum', () => {
    test('has expected values', () => {
      expect(FilterOp.NONE).toBe(0);
      expect(FilterOp.EQ).toBe(1);
      expect(FilterOp.GT).toBe(2);
      expect(FilterOp.LT).toBe(3);
      expect(FilterOp.GTE).toBe(4);
      expect(FilterOp.LTE).toBe(5);
      expect(FilterOp.BETWEEN).toBe(6);
    });
  });

  describe('parseQuery — basic operators', () => {
    test('equals (=)', () => {
      const result = parseQuery('served_mbps = 50', mockSchema);
      expect(result).not.toBeNull();
      expect(result.groups.length).toBe(1);
      expect(result.groups[0][0].column).toBe('served_mbps');
      expect(result.groups[0][0].op).toBe(FilterOp.EQ);
      expect(result.groups[0][0].value).toBe(50);
    });

    test('greater than (>)', () => {
      const result = parseQuery('served_mbps > 100', mockSchema);
      expect(result.groups[0][0].op).toBe(FilterOp.GT);
      expect(result.groups[0][0].value).toBe(100);
    });

    test('less than (<)', () => {
      const result = parseQuery('served_mbps < 200', mockSchema);
      expect(result.groups[0][0].op).toBe(FilterOp.LT);
      expect(result.groups[0][0].value).toBe(200);
    });

    test('greater than or equal (>=)', () => {
      const result = parseQuery('served_mbps >= 50', mockSchema);
      expect(result.groups[0][0].op).toBe(FilterOp.GTE);
      expect(result.groups[0][0].value).toBe(50);
    });

    test('less than or equal (<=)', () => {
      const result = parseQuery('served_mbps <= 500', mockSchema);
      expect(result.groups[0][0].op).toBe(FilterOp.LTE);
      expect(result.groups[0][0].value).toBe(500);
    });
  });

  describe('parseQuery — BETWEEN shorthand', () => {
    test('range with .. syntax', () => {
      const result = parseQuery('served_mbps 50..200', mockSchema);
      expect(result).not.toBeNull();
      expect(result.groups[0][0].op).toBe(FilterOp.BETWEEN);
      expect(result.groups[0][0].value).toBe(50);
      expect(result.groups[0][0].high).toBe(200);
    });

    test('range with decimal values', () => {
      const result = parseQuery('served_mbps 0.5..99.9', mockSchema);
      expect(result.groups[0][0].value).toBeCloseTo(0.5);
      expect(result.groups[0][0].high).toBeCloseTo(99.9);
    });
  });

  describe('parseQuery — enum/dictionary resolution', () => {
    test('resolves string value to dictionary index', () => {
      const result = parseQuery('custom_region = CONUS', mockSchema);
      expect(result).not.toBeNull();
      expect(result.groups[0][0].column).toBe('custom_region');
      expect(result.groups[0][0].value).toBe(1); // CONUS is index 1
      expect(result.groups[0][0].isEnum).toBe(true);
      expect(result.groups[0][0].rawValue).toBe('CONUS');
    });

    test('returns null for unknown dictionary value', () => {
      const result = parseQuery('custom_region = UNKNOWN_REGION', mockSchema);
      expect(result).toBeNull();
    });
  });

  describe('parseQuery — AND combinator', () => {
    test('two predicates with AND', () => {
      const result = parseQuery('served_mbps > 50 AND custom_region = CONUS', mockSchema);
      expect(result).not.toBeNull();
      expect(result.groups.length).toBe(1);
      expect(result.groups[0].length).toBe(2);
      expect(result.groups[0][0].column).toBe('served_mbps');
      expect(result.groups[0][0].op).toBe(FilterOp.GT);
      expect(result.groups[0][1].column).toBe('custom_region');
      expect(result.groups[0][1].value).toBe(1);
    });
  });

  describe('parseQuery — OR combinator', () => {
    test('two predicates with OR', () => {
      const result = parseQuery('served_mbps > 200 OR served_mbps < 10', mockSchema);
      expect(result).not.toBeNull();
      expect(result.groups.length).toBe(2);
      expect(result.groups[0][0].op).toBe(FilterOp.GT);
      expect(result.groups[0][0].value).toBe(200);
      expect(result.groups[1][0].op).toBe(FilterOp.LT);
      expect(result.groups[1][0].value).toBe(10);
    });
  });

  describe('parseQuery — edge cases', () => {
    test('empty string returns null', () => {
      expect(parseQuery('', mockSchema)).toBeNull();
    });

    test('whitespace-only returns null', () => {
      expect(parseQuery('   ', mockSchema)).toBeNull();
    });

    test('null input returns null', () => {
      expect(parseQuery(null, mockSchema)).toBeNull();
    });

    test('invalid syntax returns null', () => {
      expect(parseQuery('this is not valid', mockSchema)).toBeNull();
    });

    test('preserves raw query string', () => {
      const result = parseQuery('served_mbps > 50', mockSchema);
      expect(result.raw).toBe('served_mbps > 50');
    });
  });

  describe('flattenForGPU', () => {
    test('single predicate returns AND with 1 predicate', () => {
      const parsed = parseQuery('served_mbps > 50', mockSchema);
      const flat = flattenForGPU(parsed);
      expect(flat.predicates.length).toBe(1);
      expect(flat.combinator).toBe('AND');
    });

    test('AND query returns AND combinator', () => {
      const parsed = parseQuery('served_mbps > 50 AND custom_region = CONUS', mockSchema);
      const flat = flattenForGPU(parsed);
      expect(flat.predicates.length).toBe(2);
      expect(flat.combinator).toBe('AND');
    });

    test('OR query returns OR combinator', () => {
      const parsed = parseQuery('served_mbps > 200 OR served_mbps < 10', mockSchema);
      const flat = flattenForGPU(parsed);
      expect(flat.predicates.length).toBe(2);
      expect(flat.combinator).toBe('OR');
    });

    test('null spec returns null', () => {
      expect(flattenForGPU(null)).toBeNull();
    });

    test('empty groups returns null', () => {
      expect(flattenForGPU({ groups: [] })).toBeNull();
    });

    test('limits to 2 predicates', () => {
      // Build a spec with 3 predicates manually
      const spec = {
        groups: [
          [
            { column: 'a', op: FilterOp.GT, value: 1 },
            { column: 'b', op: FilterOp.LT, value: 2 },
            { column: 'c', op: FilterOp.EQ, value: 3 },
          ],
        ],
        raw: 'test',
      };
      const flat = flattenForGPU(spec);
      expect(flat.predicates.length).toBe(2);
    });
  });
});
