/**
 * QueryParser.test.mjs — Characterization tests for the filter query parser (B-3b).
 * Covers parseQuery, flattenForCPU (added in the develop merge), and flattenForGPU.
 * Run: node --test src/query/QueryParser.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseQuery, flattenForCPU, flattenForGPU, FilterOp } from './QueryParser.js';

// Minimal schema: a column "exists" when present (truthy) in staticColumns.
const schema = { staticColumns: { served_mbps: [1, 2, 3] }, temporalColumns: {}, dictionary: [] };
const enumSchema = {
  staticColumns: {},
  temporalColumns: {},
  schemaList: [{ name: 'region', type: 6 }], // ENUM type
  dictionary: ['CONUS', 'EMEA'],
};

describe('parseQuery — basic shapes', () => {
  it('returns null for empty / whitespace input', () => {
    assert.equal(parseQuery('', schema), null);
    assert.equal(parseQuery('   ', schema), null);
  });

  it('parses a single comparison predicate', () => {
    const spec = parseQuery('served_mbps > 50', schema);
    assert.equal(spec.raw, 'served_mbps > 50');
    assert.equal(spec.groups.length, 1);
    assert.deepEqual(spec.groups[0][0], {
      column: 'served_mbps',
      op: FilterOp.GT,
      value: 50,
      isEnum: false,
    });
  });

  it('maps every comparison operator', () => {
    const op = (q) => parseQuery(q, schema).groups[0][0].op;
    assert.equal(op('served_mbps = 5'), FilterOp.EQ);
    assert.equal(op('served_mbps > 5'), FilterOp.GT);
    assert.equal(op('served_mbps < 5'), FilterOp.LT);
    assert.equal(op('served_mbps >= 5'), FilterOp.GTE);
    assert.equal(op('served_mbps <= 5'), FilterOp.LTE);
  });

  it('parses BETWEEN shorthand (low..high)', () => {
    const pred = parseQuery('served_mbps 100..500', schema).groups[0][0];
    assert.equal(pred.op, FilterOp.BETWEEN);
    assert.equal(pred.value, 100);
    assert.equal(pred.high, 500);
  });
});

describe('parseQuery — AND / OR grouping', () => {
  it('AND yields one group with multiple predicates', () => {
    const spec = parseQuery('served_mbps > 50 AND served_mbps < 100', schema);
    assert.equal(spec.groups.length, 1);
    assert.equal(spec.groups[0].length, 2);
  });
  it('OR yields multiple groups', () => {
    const spec = parseQuery('served_mbps > 200 OR served_mbps < 10', schema);
    assert.equal(spec.groups.length, 2);
    assert.equal(spec.groups[0].length, 1);
    assert.equal(spec.groups[1].length, 1);
  });
});

describe('parseQuery — enum dictionary lookup', () => {
  it('resolves a dictionary string to its index', () => {
    const pred = parseQuery('region = EMEA', enumSchema).groups[0][0];
    assert.equal(pred.isEnum, true);
    assert.equal(pred.value, 1); // index of EMEA
    assert.equal(pred.rawValue, 'EMEA');
  });
  it('returns null for an unknown dictionary value', () => {
    assert.equal(parseQuery('region = ANTARCTICA', enumSchema), null);
  });
});

describe('parseQuery — invalid / incomplete', () => {
  it('returns null for an unknown column', () => {
    assert.equal(parseQuery('bogus > 5', schema), null);
  });
  it('returns null for an incomplete predicate (still typing)', () => {
    assert.equal(parseQuery('served_mbps =', schema), null);
  });
});

describe('flattenForCPU — predicate evaluation', () => {
  const cpu = (op, value, high) => flattenForCPU({ groups: [[{ column: 'a', op, value, high }]] });

  it('empty spec passes everything', () => {
    assert.equal(flattenForCPU(null)({ a: 1 }), true);
    assert.equal(flattenForCPU({ groups: [] })({ a: 1 }), true);
  });

  it('evaluates each FilterOp', () => {
    assert.equal(cpu(FilterOp.EQ, 5)({ a: 5 }), true);
    assert.equal(cpu(FilterOp.EQ, 5)({ a: 6 }), false);
    assert.equal(cpu(FilterOp.GT, 5)({ a: 6 }), true);
    assert.equal(cpu(FilterOp.GT, 5)({ a: 5 }), false);
    assert.equal(cpu(FilterOp.LT, 5)({ a: 4 }), true);
    assert.equal(cpu(FilterOp.GTE, 5)({ a: 5 }), true);
    assert.equal(cpu(FilterOp.LTE, 5)({ a: 5 }), true);
    assert.equal(cpu(FilterOp.BETWEEN, 10, 20)({ a: 15 }), true);
    assert.equal(cpu(FilterOp.BETWEEN, 10, 20)({ a: 25 }), false);
    assert.equal(cpu(FilterOp.BETWEEN, 10, 20)({ a: 10 }), true); // inclusive low
    assert.equal(cpu(FilterOp.BETWEEN, 10, 20)({ a: 20 }), true); // inclusive high
  });

  it('treats a missing/null property as failing', () => {
    assert.equal(cpu(FilterOp.GT, 5)({}), false);
    assert.equal(cpu(FilterOp.GT, 5)({ a: null }), false);
  });

  it('AND requires all predicates; OR requires any group', () => {
    const and = flattenForCPU({
      groups: [
        [
          { column: 'a', op: FilterOp.GT, value: 0 },
          { column: 'b', op: FilterOp.LT, value: 10 },
        ],
      ],
    });
    assert.equal(and({ a: 5, b: 5 }), true);
    assert.equal(and({ a: 5, b: 50 }), false);

    const or = flattenForCPU({
      groups: [
        [{ column: 'a', op: FilterOp.GT, value: 100 }],
        [{ column: 'b', op: FilterOp.LT, value: 0 }],
      ],
    });
    assert.equal(or({ a: 200, b: 5 }), true); // first group passes
    assert.equal(or({ a: 5, b: -5 }), true); // second group passes
    assert.equal(or({ a: 5, b: 5 }), false); // neither
  });
});

describe('flattenForGPU', () => {
  it('returns null for null / empty spec', () => {
    assert.equal(flattenForGPU(null), null);
    assert.equal(flattenForGPU({ groups: [] }), null);
  });
  it('single AND group → up to 2 predicates, combinator AND', () => {
    const spec = { groups: [[{ column: 'a' }, { column: 'b' }, { column: 'c' }]] };
    const out = flattenForGPU(spec);
    assert.equal(out.combinator, 'AND');
    assert.equal(out.predicates.length, 2);
  });
  it('multiple OR groups → first predicate of each (up to 2), combinator OR', () => {
    const spec = { groups: [[{ column: 'a' }], [{ column: 'b' }], [{ column: 'c' }]] };
    const out = flattenForGPU(spec);
    assert.equal(out.combinator, 'OR');
    assert.deepEqual(
      out.predicates.map((p) => p.column),
      ['a', 'b']
    );
  });
});
