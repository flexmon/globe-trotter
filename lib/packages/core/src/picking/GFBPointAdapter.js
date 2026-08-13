/**
 * GFBPointAdapter — CPU screen-space pick adapter for GFB point layers.
 *
 * Projects each candidate point into screen space (via camera.project, which
 * mirrors the render shaders) and returns the nearest point within a pixel
 * radius. This is accurate for elevated/tilted views and needs no spatial index
 * to invalidate as points move — a rAF-throttled linear scan is cheap for the
 * sparse point layers this targets (e.g. satellites).
 *
 * Geometry is interpolated between bracketing epochs to match the render; popup
 * VALUES snap to the nearest epoch (see getProperties) so no fabricated
 * between-epoch numbers appear in the detail panel.
 *
 * Limitation (v1): reads positions from the geometry epochs currently resident
 * in data.geometry.packedPositions. For multi-shard sharded layers where not all
 * epochs are resident, picking covers the active shard's epoch window.
 */

import { FlexRowAccessor } from './FlexRowAccessor.js';

const DEFAULT_RADIUS_PX = 12;

// ─── Pure hit-test core (unit-tested) ────────────────────────────────────────

/**
 * Resolve a normalized time [0,1] to bracketing epoch indices + interpolation
 * fraction, and the nearest epoch (for snapped value display).
 * @param {number} normalizedTime
 * @param {number} epochCount
 * @returns {{ e0: number, e1: number, frac: number, nearest: number }}
 */
export function resolveEpoch(normalizedTime, epochCount) {
  if (!(epochCount > 1)) return { e0: 0, e1: 0, frac: 0, nearest: 0 };
  const t = Math.min(Math.max(normalizedTime, 0), 1);
  const g = t * (epochCount - 1);
  const e0 = Math.floor(g);
  const e1 = Math.min(e0 + 1, epochCount - 1);
  return { e0, e1, frac: g - e0, nearest: Math.round(g) };
}

/**
 * Read a point's lng/lat/alt from packed RGBA32F positions, linearly
 * interpolated between epochs e0 and e1 by frac.
 * @returns {{ lng: number, lat: number, alt: number }}
 */
export function readInterpolatedPosition(packed, texelsPerEpoch, featureIndex, e0, e1, frac) {
  const i0 = (e0 * texelsPerEpoch + featureIndex) * 4;
  const i1 = (e1 * texelsPerEpoch + featureIndex) * 4;
  const lng = packed[i0] + (packed[i1] - packed[i0]) * frac;
  const lat = packed[i0 + 1] + (packed[i1 + 1] - packed[i0 + 1]) * frac;
  const alt = packed[i0 + 2] + (packed[i1 + 2] - packed[i0 + 2]) * frac;
  return { lng, lat, alt };
}

/**
 * Linear scan for the nearest projected point within radiusPx of the cursor.
 * @param {{ sx:number, sy:number, featureCount:number, radiusPx:number,
 *           getPoint:(i:number)=>({lng,lat,alt}|null),
 *           project:(lng:number,lat:number,alt:number)=>({sx,sy,visible}) }} args
 * @returns {{ featureIndex: number, dist: number } | null}
 */
export function pickNearestPoint({ sx, sy, featureCount, radiusPx, getPoint, project }) {
  const r2 = radiusPx * radiusPx;
  let bestD = r2 + 1;
  let bestI = -1;
  for (let i = 0; i < featureCount; i++) {
    const p = getPoint(i);
    if (!p) continue;
    const s = project(p.lng, p.lat, p.alt);
    if (!s || !s.visible) continue;
    const dx = s.sx - sx;
    const dy = s.sy - sy;
    const d = dx * dx + dy * dy;
    if (d <= r2 && d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI >= 0 ? { featureIndex: bestI, dist: Math.sqrt(bestD) } : null;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class GFBPointAdapter {
  /**
   * Reads the layer's current data lazily so sharded/streaming layers that swap
   * or grow their geometry stay correct without re-registration.
   * @param {{ engine: object, layerName: string, radiusPx?: number }} opts
   */
  constructor({ engine, layerName, radiusPx = DEFAULT_RADIUS_PX }) {
    this._engine = engine;
    this._layerName = layerName;
    this._radiusPx = radiusPx;
    this._accessor = null;
    this._accessorData = null;
    // Bound decode for PopupFields; resolves against the current data.
    this.decode = (field, raw) => this._acc()?.decode(field, raw);
  }

  /**
   * @param {{ sx:number, sy:number, camera:object }} ctx
   * @returns {{ featureIndex: number } | null}
   */
  pick(ctx) {
    const data = this._data();
    const cam = ctx?.camera;
    if (!data || !cam?.project) return null;

    const { packed, texelsPerEpoch, featureCount, epochCount } = this._resident(data);
    if (!packed || !featureCount) return null;

    const w = this._engine?.canvas?.clientWidth ?? 0;
    const h = this._engine?.canvas?.clientHeight ?? 0;
    if (!w || !h) return null;

    const { e0, e1, frac } = resolveEpoch(this._normalizedTime(), epochCount);
    const getPoint = (i) => readInterpolatedPosition(packed, texelsPerEpoch, i, e0, e1, frac);
    const project = (lng, lat, alt) => cam.project(lat, lng, alt, w, h);

    return pickNearestPoint({
      sx: ctx.sx,
      sy: ctx.sy,
      featureCount,
      radiusPx: this._radiusPx,
      getPoint,
      project,
    });
  }

  /** Materialize raw column values at the nearest epoch (values snap; geometry interpolates). */
  getProperties(featureIndex) {
    const acc = this._acc();
    const data = this._data();
    if (!acc || !data) return {};
    const { epochCount } = this._resident(data);
    const { nearest } = resolveEpoch(this._normalizedTime(), epochCount);
    return acc.getAllRaw(featureIndex, nearest);
  }

  // ─── Internal ───

  _data() {
    return this._engine?.layerManager?.layers?.get(this._layerName)?.data || null;
  }

  /** FlexRowAccessor bound to the current data object (rebuilt on data swap). */
  _acc() {
    const data = this._data();
    if (!data) return null;
    if (data !== this._accessorData) {
      this._accessor = new FlexRowAccessor(data);
      this._accessorData = data;
    }
    return this._accessor;
  }

  /** Geometry/epoch info resident in the current data object. */
  _resident(data) {
    const packed = data.geometry?.packedPositions || null;
    const texelsPerEpoch = packed?._texelsPerEpoch ?? 0;
    const featureCount = data.featureCount ?? data.geometry?.featureCount ?? 0;
    const geomEpochs =
      packed && texelsPerEpoch ? Math.floor(packed.length / (texelsPerEpoch * 4)) : 1;
    const epochCount = Math.min(data.epochCount ?? geomEpochs, geomEpochs);
    return { packed, texelsPerEpoch, featureCount, epochCount };
  }

  _normalizedTime() {
    const t = this._engine?.time;
    return t?.getNormalized ? t.getNormalized() : 0;
  }
}
