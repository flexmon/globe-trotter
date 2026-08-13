/**
 * H3CellAdapter — CPU pick adapter for H3F cell layers.
 *
 * H3 cells sit on the globe surface (radius ~1.0), so the surface lat/lon from
 * screen→globe ray intersection is accurate for them (unlike elevated GFB
 * points). Picking is: screen lat/lon → H3 cell id at the layer's resolution
 * (h3-js) → dataset row via the cell-id map. This mirrors the loader's own
 * cell→index mapping, so it selects the same cell the renderer draws.
 *
 * (A GPU id-readback path would additionally be pixel-exact for extruded pillars
 * under extreme tilt; deferred — surface picking is correct for flat cells.)
 *
 * Reads the layer's current data lazily so sharded H3F stays correct as the
 * dataset cell list / columns update.
 */

import { latLngToCell, getResolution } from 'h3-js';
import { FlexRowAccessor } from './FlexRowAccessor.js';
import { resolveEpoch } from './GFBPointAdapter.js';

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/**
 * Build a map from H3 cell id (bigint) → dataset row index.
 * @param {BigUint64Array|Array<bigint>|null} cellIds
 * @returns {Map<bigint, number>}
 */
export function buildCellIndex(cellIds) {
  const map = new Map();
  if (!cellIds) return map;
  for (let i = 0; i < cellIds.length; i++) map.set(cellIds[i], i);
  return map;
}

/**
 * Derive the H3 resolution from the first cell id, or -1 if unavailable.
 * @param {BigUint64Array|Array<bigint>|null} cellIds
 * @returns {number}
 */
export function deriveResolution(cellIds) {
  if (!cellIds || cellIds.length === 0) return -1;
  return getResolution(cellIds[0].toString(16));
}

/**
 * Resolve a lat/lon to a dataset row via the H3 cell at `resolution`.
 * @returns {number} row index, or -1 if the cell is not in the dataset.
 */
export function lookupCellRow(lat, lng, resolution, cellIndex) {
  if (resolution < 0 || !cellIndex) return -1;
  const key = BigInt('0x' + latLngToCell(lat, lng, resolution));
  const row = cellIndex.get(key);
  return row === undefined ? -1 : row;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class H3CellAdapter {
  /** @param {{ engine: object, layerName: string }} opts */
  constructor({ engine, layerName }) {
    this._engine = engine;
    this._layerName = layerName;
    this._accessor = null;
    this._accessorData = null;
    this._cellIndex = null;
    this._cellIndexSrc = null;
    this._resolution = -1;
    this.decode = (field, raw) => this._acc()?.decode(field, raw);
  }

  /**
   * @param {{ geo: { lat:number, lng:number } | null }} ctx
   * @returns {{ featureIndex: number } | null}
   */
  pick(ctx) {
    const data = this._data();
    const geo = ctx?.geo;
    if (!data?.cellIds || !geo) return null;
    this._ensureIndex(data);
    const row = lookupCellRow(geo.lat, geo.lng, this._resolution, this._cellIndex);
    return row >= 0 ? { featureIndex: row } : null;
  }

  getProperties(featureIndex) {
    const acc = this._acc();
    const data = this._data();
    if (!acc || !data) return {};
    const { nearest } = resolveEpoch(this._normalizedTime(), data.epochCount ?? 1);
    return acc.getAllRaw(featureIndex, nearest);
  }

  // ─── Internal ───

  _data() {
    return this._engine?.layerManager?.layers?.get(this._layerName)?.data || null;
  }

  _acc() {
    const data = this._data();
    if (!data) return null;
    if (data !== this._accessorData) {
      this._accessor = new FlexRowAccessor(data);
      this._accessorData = data;
    }
    return this._accessor;
  }

  /** Rebuild the cell-id map + resolution only when the cellIds array changes. */
  _ensureIndex(data) {
    if (data.cellIds !== this._cellIndexSrc) {
      this._cellIndex = buildCellIndex(data.cellIds);
      this._resolution = deriveResolution(data.cellIds);
      this._cellIndexSrc = data.cellIds;
    }
  }

  _normalizedTime() {
    const t = this._engine?.time;
    return t?.getNormalized ? t.getNormalized() : 0;
  }
}
