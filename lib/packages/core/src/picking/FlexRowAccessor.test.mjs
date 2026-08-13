/**
 * FlexRowAccessor.test.mjs — read display values from columnar GFB/H3F/MFB data.
 * Run: node --test lib/packages/core/src/picking/FlexRowAccessor.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { FlexRowAccessor } from './FlexRowAccessor.js';
import { normalizeFields, buildRows } from './PopupFields.js';

function gfbData() {
  return {
    featureCount: 2,
    staticColumns: {
      altitude: new Float32Array([341200, 550000]),
      operator_idx: new Uint32Array([0, 1]), // dictionary column
      missing: new Float32Array([NaN, 5]),
    },
    temporalColumns: {
      // 2 epochs × 2 features: epoch0=[10,20], epoch1=[30,40]
      served_mbps: new Float32Array([10, 20, 30, 40]),
      status_idx: new Uint32Array([0, 1, 1, 0]), // temporal dictionary column
    },
    dictionaries: {
      operator_idx: ['GlobeTrotter', 'SES'],
      status_idx: ['Inactive', 'Active'],
    },
    entityKey: { name: 'target_id', type: 4 },
    entityIds: new Uint32Array([12345, 67890]),
    epochCount: 2,
  };
}

describe('FlexRowAccessor.getValue', () => {
  it('reads static columns (epoch ignored)', () => {
    const a = new FlexRowAccessor(gfbData());
    assert.equal(a.getValue('altitude', 0, 1), 341200);
    assert.equal(a.getValue('altitude', 1, 0), 550000);
  });

  it('reads temporal columns at epochIndex * featureCount + featureIndex', () => {
    const a = new FlexRowAccessor(gfbData());
    assert.equal(a.getValue('served_mbps', 0, 0), 10);
    assert.equal(a.getValue('served_mbps', 1, 0), 20);
    assert.equal(a.getValue('served_mbps', 0, 1), 30);
    assert.equal(a.getValue('served_mbps', 1, 1), 40);
  });

  it('reads the entity-id column from entityIds', () => {
    const a = new FlexRowAccessor(gfbData());
    assert.equal(a.getValue('target_id', 0, 0), 12345);
    assert.equal(a.getValue('target_id', 1, 0), 67890);
  });

  it('returns raw dictionary index (decode is separate)', () => {
    const a = new FlexRowAccessor(gfbData());
    assert.equal(a.getValue('operator_idx', 1, 0), 1);
  });

  it('returns undefined for unknown fields', () => {
    const a = new FlexRowAccessor(gfbData());
    assert.equal(a.getValue('nope', 0, 0), undefined);
  });
});

describe('FlexRowAccessor.decode', () => {
  it('decodes static dictionary columns', () => {
    const a = new FlexRowAccessor(gfbData());
    assert.equal(a.decode('operator_idx', 0), 'GlobeTrotter');
    assert.equal(a.decode('operator_idx', 1), 'SES');
  });

  it('decodes temporal dictionary columns', () => {
    const a = new FlexRowAccessor(gfbData());
    assert.equal(a.decode('status_idx', 1), 'Active');
  });

  it('returns undefined for non-dictionary columns', () => {
    const a = new FlexRowAccessor(gfbData());
    assert.equal(a.decode('altitude', 0), undefined);
  });

  it('returns undefined for out-of-range indices', () => {
    const a = new FlexRowAccessor(gfbData());
    assert.equal(a.decode('operator_idx', 99), undefined);
  });
});

describe('FlexRowAccessor.getRow', () => {
  it('materializes raw values for the requested fields', () => {
    const a = new FlexRowAccessor(gfbData());
    const fields = normalizeFields(['target_id', 'altitude', 'served_mbps', 'operator_idx']);
    assert.deepEqual(a.getRow(0, 0, fields), {
      target_id: 12345,
      altitude: 341200,
      served_mbps: 10,
      operator_idx: 0,
    });
  });
});

describe('FlexRowAccessor — entityKey as a bare string (streaming shape)', () => {
  function streamingData() {
    return {
      featureCount: 2,
      staticColumns: {},
      temporalColumns: {},
      dictionaries: {},
      entityKey: 'modem_mac', // string, not { name }
      entityIds: ['AA:BB:CC', 'DD:EE:FF'], // already-decoded strings
    };
  }

  it('resolves the entity id when entityKey is a string', () => {
    const a = new FlexRowAccessor(streamingData());
    assert.equal(a.getValue('modem_mac', 0, 0), 'AA:BB:CC');
    assert.equal(a.getValue('modem_mac', 1, 0), 'DD:EE:FF');
  });

  it('includes the entity id in getAllRaw', () => {
    const a = new FlexRowAccessor(streamingData());
    assert.equal(a.getAllRaw(1, 0).modem_mac, 'DD:EE:FF');
  });
});

describe('FlexRowAccessor — reads live data (streaming in-place mutation)', () => {
  it('reflects entityIds/columns swapped on the same data object', () => {
    const data = {
      featureCount: 1,
      staticColumns: { s: new Float32Array([1]) },
      temporalColumns: {},
      dictionaries: {},
      entityKey: 'id',
      entityIds: ['old'],
    };
    const a = new FlexRowAccessor(data);
    assert.equal(a.getValue('id', 0, 0), 'old');
    assert.equal(a.getValue('s', 0, 0), 1);

    // Shard swap: same object, new sub-arrays.
    data.entityIds = ['new'];
    data.staticColumns = { s: new Float32Array([2]) };
    assert.equal(a.getValue('id', 0, 0), 'new');
    assert.equal(a.getValue('s', 0, 0), 2);
  });
});

describe('FlexRowAccessor — H3F count fallback (dataCount)', () => {
  it('uses dataCount as the temporal stride when featureCount is absent', () => {
    const data = {
      dataCount: 2,
      cellCount: 2,
      staticColumns: {},
      temporalColumns: { x: new Float32Array([1, 2, 3, 4]) }, // 2 epochs × 2 rows
      dictionaries: {},
    };
    const a = new FlexRowAccessor(data);
    assert.equal(a.getValue('x', 0, 0), 1);
    assert.equal(a.getValue('x', 1, 1), 4); // epoch 1, row 1 → 1*2+1 = 3 → 4
  });
});

describe('FlexRowAccessor.getAllRaw', () => {
  it('returns every column (entity id, static, temporal at epoch) as raw values', () => {
    const a = new FlexRowAccessor(gfbData());
    assert.deepEqual(a.getAllRaw(0, 1), {
      target_id: 12345,
      altitude: 341200,
      operator_idx: 0,
      missing: NaN,
      served_mbps: 30, // epoch 1, feature 0 → index 1*2+0 = 2 → 30
      status_idx: 1, // index 2 → 1
    });
  });
});

describe('FlexRowAccessor + PopupFields composition', () => {
  it('decodes dictionary columns into labels', () => {
    const a = new FlexRowAccessor(gfbData());
    const fields = normalizeFields([{ name: 'operator_idx', label: 'Operator' }]);
    const rows = buildRows(fields, a.getRow(0, 0, fields), { decode: a.decode });
    assert.deepEqual(rows, [{ label: 'Operator', value: 'GlobeTrotter' }]);
  });

  it('valueMap overrides dictionary decode', () => {
    const a = new FlexRowAccessor(gfbData());
    const fields = normalizeFields([
      { name: 'operator_idx', label: 'Operator', valueMap: { 0: 'GLOBETROTTER INC' } },
    ]);
    const rows = buildRows(fields, a.getRow(0, 0, fields), { decode: a.decode });
    assert.deepEqual(rows, [{ label: 'Operator', value: 'GLOBETROTTER INC' }]);
  });

  it('renders temporal values at the given (nearest) epoch', () => {
    const a = new FlexRowAccessor(gfbData());
    const fields = normalizeFields([
      { name: 'served_mbps', label: 'Mbps', format: 'number', decimals: 1 },
    ]);
    const rows = buildRows(fields, a.getRow(1, 1, fields), { decode: a.decode });
    assert.deepEqual(rows, [{ label: 'Mbps', value: '40.0' }]);
  });

  it('omits missing (NaN) values', () => {
    const a = new FlexRowAccessor(gfbData());
    const fields = normalizeFields([{ name: 'missing', label: 'M' }]);
    const rows = buildRows(fields, a.getRow(0, 0, fields), { decode: a.decode });
    assert.deepEqual(rows, []);
  });
});
