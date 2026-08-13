/**
 * PopupFields.test.mjs — normalization + deterministic formatting for popup rows.
 * Run: node --test lib/packages/core/src/picking/PopupFields.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeFields, buildRows, normalizeGroups, buildSections } from './PopupFields.js';

describe('normalizeFields', () => {
  it('expands shorthand string fields to { name, label }', () => {
    const out = normalizeFields(['target_id', 'operator']);
    assert.deepEqual(out, [
      { name: 'target_id', label: 'target_id' },
      { name: 'operator', label: 'operator' },
    ]);
  });

  it('defaults label to name when omitted', () => {
    const out = normalizeFields([{ name: 'altitude', format: 'number' }]);
    assert.equal(out[0].label, 'altitude');
    assert.equal(out[0].format, 'number');
  });

  it('passes through label, decimals, unit, valueMap, fallback', () => {
    const out = normalizeFields([
      {
        name: 'status',
        label: 'Status',
        format: 'number',
        decimals: 2,
        unit: 'ft',
        valueMap: { 0: 'Off', 1: 'On' },
        fallback: '—',
      },
    ]);
    assert.deepEqual(out[0], {
      name: 'status',
      label: 'Status',
      format: 'number',
      decimals: 2,
      unit: 'ft',
      valueMap: { 0: 'Off', 1: 'On' },
      fallback: '—',
    });
  });

  it('returns [] for null/undefined/non-array config', () => {
    assert.deepEqual(normalizeFields(null), []);
    assert.deepEqual(normalizeFields(undefined), []);
    assert.deepEqual(normalizeFields({}), []);
  });

  it('skips empty/invalid field entries', () => {
    const out = normalizeFields(['ok', '', null, { label: 'no name' }]);
    assert.deepEqual(
      out.map((f) => f.name),
      ['ok']
    );
  });
});

describe('buildRows — basic formatting', () => {
  it('renders string values as-is', () => {
    const fields = normalizeFields([{ name: 'op', label: 'Operator' }]);
    const rows = buildRows(fields, { op: 'GlobeTrotter' });
    assert.deepEqual(rows, [{ label: 'Operator', value: 'GlobeTrotter' }]);
  });

  it('formats number with decimals', () => {
    const fields = normalizeFields([
      { name: 'mbps', label: 'Mbps', format: 'number', decimals: 2 },
    ]);
    const rows = buildRows(fields, { mbps: 82.4139 });
    assert.equal(rows[0].value, '82.41');
  });

  it('formats integer by rounding', () => {
    const fields = normalizeFields([{ name: 'n', label: 'N', format: 'integer' }]);
    assert.equal(buildRows(fields, { n: 3.7 })[0].value, '4');
  });

  it('appends unit to numeric values', () => {
    const fields = normalizeFields([{ name: 'alt', label: 'Alt', format: 'integer', unit: 'ft' }]);
    assert.equal(buildRows(fields, { alt: 341200 })[0].value.endsWith(' ft'), true);
  });

  it('formats booleans', () => {
    const fields = normalizeFields([{ name: 'b', label: 'B', format: 'boolean' }]);
    assert.equal(buildRows(fields, { b: true })[0].value, 'true');
    assert.equal(buildRows(fields, { b: false })[0].value, 'false');
  });

  it('formats objects as compact JSON', () => {
    const fields = normalizeFields([{ name: 'j', label: 'J', format: 'json' }]);
    assert.equal(buildRows(fields, { j: { a: 1 } })[0].value, '{"a":1}');
  });

  it('formats bytes human-readable (base 1024)', () => {
    const fields = normalizeFields([{ name: 'sz', label: 'Size', format: 'bytes' }]);
    assert.equal(buildRows(fields, { sz: 1024 })[0].value, '1 KB');
    assert.equal(buildRows(fields, { sz: 1536 })[0].value, '1.5 KB');
  });

  it('formats datetime from epoch millis as ISO', () => {
    const fields = normalizeFields([{ name: 't', label: 'T', format: 'datetime' }]);
    assert.equal(buildRows(fields, { t: 0 })[0].value, '1970-01-01T00:00:00.000Z');
  });

  it('auto-formats numbers when no format given', () => {
    const fields = normalizeFields(['x']);
    assert.equal(buildRows(fields, { x: 5 })[0].value, '5');
  });

  it('formats integer from a BigInt without throwing (i64 columns)', () => {
    const fields = normalizeFields([{ name: 'n', label: 'N', format: 'integer' }]);
    assert.equal(buildRows(fields, { n: 12345n })[0].value, '12,345');
  });

  it('formats number from a BigInt', () => {
    const fields = normalizeFields([{ name: 'n', label: 'N', format: 'number' }]);
    assert.equal(buildRows(fields, { n: 6789n })[0].value, '6,789');
  });
});

describe('buildRows — scale, prefix, list', () => {
  it('applies scale before number formatting (bps → Mbps)', () => {
    const f = normalizeFields([
      { name: 'bps', label: 'Mbps', format: 'number', decimals: 1, scale: 0.000001, unit: 'Mbps' },
    ]);
    assert.equal(buildRows(f, { bps: 900000000 })[0].value, '900.0 Mbps');
  });

  it('applies scale to integer and to BigInt values', () => {
    const f = normalizeFields([{ name: 'bps', label: 'M', format: 'integer', scale: 0.000001 }]);
    assert.equal(buildRows(f, { bps: 900000000 })[0].value, '900');
    assert.equal(buildRows(f, { bps: 900000000n })[0].value, '900');
  });

  it('applies prefix without a space, unit with a space', () => {
    const f = normalizeFields([
      { name: 'x', label: 'Cost', format: 'number', decimals: 2, prefix: '$' },
    ]);
    assert.equal(buildRows(f, { x: 1234.5 })[0].value, '$1,234.50');
  });

  it('formats a list by stripping brackets and rejoining', () => {
    const f = normalizeFields([{ name: 'ids', label: 'IDs', format: 'list' }]);
    assert.equal(buildRows(f, { ids: '[5025, 5023]' })[0].value, '5025, 5023');
  });

  it('applies list format to a decoded dictionary value', () => {
    const f = normalizeFields([{ name: 'regions', label: 'Regions', format: 'list' }]);
    const decode = () => '[R2, R2]';
    assert.equal(buildRows(f, { regions: 3 }, { decode })[0].value, 'R2, R2');
  });
});

describe('buildRows — objectList (JSON array of objects)', () => {
  const raw = JSON.stringify([
    { ChipRate: '2x', FreqOffset_Hz: 20000000 },
    { ChipRate: '4x', FreqOffset_Hz: -15000000 },
  ]);

  it('renders selected keys per object, each on its own line, with per-key formatting', () => {
    const f = normalizeFields([
      {
        name: 'ch',
        label: 'RCG',
        format: 'objectList',
        keys: [
          'ChipRate',
          { key: 'FreqOffset_Hz', label: 'Freq', scale: 0.000001, decimals: 1, unit: 'MHz' },
        ],
      },
    ]);
    assert.equal(
      buildRows(f, { ch: raw })[0].value,
      '1. ChipRate 2x · Freq 20.0 MHz\n2. ChipRate 4x · Freq -15.0 MHz'
    );
  });

  it('defaults to all keys when none specified', () => {
    const f = normalizeFields([{ name: 'ch', label: 'C', format: 'objectList' }]);
    assert.equal(buildRows(f, { ch: JSON.stringify([{ a: 1, b: 2 }]) })[0].value, '1. a 1 · b 2');
  });

  it('works through the decode path (dict-encoded JSON string)', () => {
    const f = normalizeFields([{ name: 'ch', label: 'C', format: 'objectList', keys: ['a'] }]);
    const decode = () => JSON.stringify([{ a: 'x' }, { a: 'y' }]);
    assert.equal(buildRows(f, { ch: 5 }, { decode })[0].value, '1. a x\n2. a y');
  });

  it('omits the row for an empty array', () => {
    const f = normalizeFields([{ name: 'ch', label: 'C', format: 'objectList' }]);
    assert.deepEqual(buildRows(f, { ch: '[]' }), []);
  });

  it('falls back to the raw string on invalid JSON', () => {
    const f = normalizeFields([{ name: 'ch', label: 'C', format: 'objectList' }]);
    assert.equal(buildRows(f, { ch: 'not json' })[0].value, 'not json');
  });
});

describe('normalizeGroups', () => {
  it('returns null when groups is not an array', () => {
    assert.equal(normalizeGroups(undefined), null);
    assert.equal(normalizeGroups({}), null);
  });

  it('normalizes group fields and drops empty groups', () => {
    const g = normalizeGroups([
      { label: 'A', fields: ['x', { name: 'y', label: 'Y' }] },
      { label: 'Empty', fields: [] },
    ]);
    assert.equal(g.length, 1);
    assert.equal(g[0].label, 'A');
    assert.deepEqual(
      g[0].fields.map((f) => f.name),
      ['x', 'y']
    );
  });
});

describe('buildSections', () => {
  it('builds labeled sections and drops sections whose rows are all empty', () => {
    const groups = normalizeGroups([
      { label: 'A', fields: ['x'] },
      { label: 'B', fields: ['missing'] },
    ]);
    const secs = buildSections(groups, { x: 1 });
    assert.equal(secs.length, 1);
    assert.equal(secs[0].label, 'A');
    assert.deepEqual(secs[0].rows, [{ label: 'x', value: '1' }]);
  });
});

describe('buildRows — valueMap and fallback', () => {
  it('maps raw value to label via valueMap', () => {
    const fields = normalizeFields([
      { name: 's', label: 'Status', valueMap: { 0: 'Inactive', 1: 'Active' } },
    ]);
    assert.equal(buildRows(fields, { s: 1 })[0].value, 'Active');
  });

  it('uses fallback when valueMap has no entry', () => {
    const fields = normalizeFields([
      { name: 's', label: 'Status', valueMap: { 1: 'Active' }, fallback: 'Unknown' },
    ]);
    assert.equal(buildRows(fields, { s: 9 })[0].value, 'Unknown');
  });

  it('omits row when valueMap misses and no fallback', () => {
    const fields = normalizeFields([{ name: 's', label: 'Status', valueMap: { 1: 'Active' } }]);
    assert.deepEqual(buildRows(fields, { s: 9 }), []);
  });

  it('omits row for missing/null/NaN values', () => {
    const fields = normalizeFields(['a', 'b', 'c']);
    assert.deepEqual(buildRows(fields, { a: null, b: undefined, c: NaN }), []);
  });

  it('renders fallback for missing value when configured', () => {
    const fields = normalizeFields([{ name: 'a', label: 'A', fallback: 'n/a' }]);
    assert.equal(buildRows(fields, {})[0].value, 'n/a');
  });
});

describe('buildRows — dictionary decode callback', () => {
  it('uses decode() result when provided and no valueMap', () => {
    const fields = normalizeFields([{ name: 'region', label: 'Region' }]);
    const decode = (name, raw) => (name === 'region' ? ['CONUS', 'EU'][raw] : undefined);
    assert.equal(buildRows(fields, { region: 1 }, { decode })[0].value, 'EU');
  });

  it('valueMap takes precedence over decode', () => {
    const fields = normalizeFields([
      { name: 'region', label: 'Region', valueMap: { 1: 'Europe' } },
    ]);
    const decode = (_name, raw) => ['CONUS', 'EU'][raw];
    assert.equal(buildRows(fields, { region: 1 }, { decode })[0].value, 'Europe');
  });

  it('falls through to format when decode returns undefined', () => {
    const fields = normalizeFields([{ name: 'x', label: 'X', format: 'integer' }]);
    const decode = () => undefined;
    assert.equal(buildRows(fields, { x: 42 }, { decode })[0].value, '42');
  });
});
