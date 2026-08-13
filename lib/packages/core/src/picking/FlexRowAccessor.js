/**
 * FlexRowAccessor — read display values from columnar Flex data (GFB/H3F/MFB).
 *
 * Zero-copy: reads directly from the decoded typed arrays; never materializes a
 * denormalized row table. Resolves a value's storage location by column kind:
 *
 *   entity id   → data.entityIds        (data.entityKey.name, e.g. 'target_id')
 *   temporal    → data.temporalColumns[field][epochIndex * featureCount + featureIndex]
 *   static      → data.staticColumns[field][featureIndex]
 *
 * Dictionary/enum columns store numeric indices; `decode()` maps them to labels
 * via the per-column `data.dictionaries[field]` the decoder produces (it already
 * seeds this from the legacy global dictionary for dict/enum columns, so no
 * separate global fallback is needed). Values are returned raw so callers
 * (PopupFields) can apply per-field valueMap overrides before decoding.
 *
 * Temporal values use whatever integer `epochIndex` the caller passes — nearest-
 * epoch resolution is the caller's responsibility (geometry interpolates to match
 * the render; factual values snap to an epoch).
 */

export class FlexRowAccessor {
  /**
   * @param {object} data  Decoded GFB/H3F/MFB data object. Sub-fields are read
   * live on each call, so this stays correct when a streaming/sharded loader
   * mutates the same data object in place across shard swaps.
   */
  constructor(data) {
    this._data = data;
    // Bound so it can be passed directly as PopupFields' `decode` callback.
    this.decode = this.decode.bind(this);
  }

  /** entityKey is an object { name } (GFBDecoder) or a bare string (streaming). */
  _entityKeyName() {
    const ek = this._data.entityKey;
    return typeof ek === 'string' ? ek : (ek?.name ?? null);
  }

  _featureCount() {
    const d = this._data;
    // GFB/MFB use featureCount/entityCount; H3F uses dataCount (temporal stride).
    return d.featureCount ?? d.dataCount ?? d.entityCount ?? d.cellCount ?? 0;
  }

  /**
   * Raw value for a field at (featureIndex, epochIndex). Epoch is ignored for
   * static/entity columns. Returns undefined when the field is absent.
   * @param {string} field
   * @param {number} featureIndex
   * @param {number} [epochIndex=0]
   * @returns {number|bigint|string|undefined}
   */
  getValue(field, featureIndex, epochIndex = 0) {
    const d = this._data;
    if (field === this._entityKeyName()) {
      return d.entityIds ? d.entityIds[featureIndex] : undefined;
    }
    const temporal = d.temporalColumns?.[field];
    if (temporal) {
      return temporal[epochIndex * this._featureCount() + featureIndex];
    }
    const stat = d.staticColumns?.[field];
    if (stat) {
      return stat[featureIndex];
    }
    return undefined;
  }

  /**
   * Materialize a raw-value map for the given normalized fields.
   * @param {number} featureIndex
   * @param {number} epochIndex
   * @param {Array<{name:string}>} fields
   * @returns {object}
   */
  getRow(featureIndex, epochIndex, fields) {
    const row = {};
    for (const f of fields) {
      row[f.name] = this.getValue(f.name, featureIndex, epochIndex);
    }
    return row;
  }

  /**
   * Materialize every column (entity id + static + temporal at epoch) as raw
   * values. Used when no explicit popup fields are configured, so the legacy
   * "show all properties" popup path works for Flex layers too.
   * @param {number} featureIndex
   * @param {number} [epochIndex=0]
   * @returns {object}
   */
  getAllRaw(featureIndex, epochIndex = 0) {
    const d = this._data;
    const row = {};
    const ekName = this._entityKeyName();
    if (ekName && d.entityIds) {
      row[ekName] = d.entityIds[featureIndex];
    }
    const stat = d.staticColumns || {};
    for (const k in stat) row[k] = stat[k][featureIndex];
    const temporal = d.temporalColumns || {};
    const base = epochIndex * this._featureCount() + featureIndex;
    for (const k in temporal) row[k] = temporal[k][base];
    return row;
  }

  /**
   * Decode a dictionary/enum index to its display string, or undefined if the
   * field is not a dictionary column or the index is out of range.
   * @param {string} field
   * @param {number|bigint} raw
   * @returns {string|undefined}
   */
  decode(field, raw) {
    const dict = this._data.dictionaries?.[field] || null;
    if (!dict) return undefined;
    const idx = typeof raw === 'bigint' ? Number(raw) : raw;
    if (!Number.isInteger(idx) || idx < 0 || idx >= dict.length) return undefined;
    return dict[idx];
  }
}
