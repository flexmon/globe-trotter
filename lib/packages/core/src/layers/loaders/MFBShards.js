/**
 * MFBShards.js — Adaptive shard loader for temporally sharded MFB data.
 *
 * Extends ShardLoader (§C.1). Its constructor takes (manifestUrl, opts) to match
 * the other sharded loaders; load() owns manifest fetch + base decode (relocated
 * VERBATIM from LayerManager.addMFBLayer) and primes the first shard.
 *
 * Per-frame interface (unchanged, verbatim):
 *   - updateForTime(normalizedTime)  — called per-frame, swaps shards as needed
 *   - getShardIndex(epoch)           — maps epoch → shard index
 *   - _preloadShard(idx)             — async background fetch + decompress
 *   - _activateShard(idx)            — swap data pointers, evict old shards
 *
 * Supports both v1 (per-attribute shard files) and v2 (single SHD2 shard file
 * per time window with per-column gzip compression).
 *
 * v2 shards use HTTP Range Requests to download only the needed columns,
 * reducing bandwidth when only a subset of temporal attributes is active.
 */

import {
  fetchColumns,
  isShardV3,
  decodeShardV3,
} from '../../../../data-sdk/src/decoders/ShardV3Decoder.js';
import { decodeMFB } from '../MFBDecoder.js';
import { ShardLoader } from './ShardLoader.js';

export class MFBShards extends ShardLoader {
  /**
   * @param {string} manifestUrl - URL to the .manifest.json file
   * @param {Object} [options] - Accepted for interface symmetry with the other
   *   sharded loaders. MFB eviction is floor-only (maxResidentBytes unused).
   */
  constructor(manifestUrl, options = {}) {
    super(manifestUrl, options);
    // Base class owns: manifest, baseData, _shards, _activeShardIdx,
    // _failedShards, _shardDirty, _activeFetchCount, _abortController.
    this.baseDir = ''; // URL directory prefix (set in load())
    this._attrs = []; // temporal attribute names extracted from manifest.columns
    this._temporalNames = [];
    this._shardList = [];
    // MFB tracks pending fetches as a Set of indices (not a Map of promises).
    this._pendingFetches = new Set();
    this.baseData = null;
  }

  /**
   * Fetch manifest + decode base + prime first shard. Returns decoded MFB data.
   *
   * Manifest fetch + base fetch/decode are relocated VERBATIM from the previous
   * LayerManager.addMFBLayer body (decodeMFB itself is untouched).
   *
   * @returns {Promise<Object>} Decoded MFB base data (from decodeMFB)
   */
  async load() {
    // 1. Fetch manifest (preserve the MFB-specific error message)
    const manifestResp = await fetch(this.manifestUrl, { signal: this._abortController.signal });
    if (!manifestResp.ok)
      throw new Error(`Failed to fetch MFB manifest ${this.manifestUrl}: ${manifestResp.status}`);
    const manifest = await manifestResp.json();
    this.manifest = manifest;

    // 2. Resolve URLs relative to manifest
    const baseDir = this.manifestUrl.substring(0, this.manifestUrl.lastIndexOf('/') + 1);
    this.baseDir = baseDir;

    // Support both simple MFB (manifest.data) and sharded MFB (manifest.base + temporalAttributes)
    const dataFile = manifest.data || manifest.base;
    if (!dataFile) throw new Error(`MFB manifest has neither 'data' nor 'base' field`);
    const dataUrl = dataFile.startsWith('./')
      ? baseDir + dataFile.substring(2)
      : baseDir + dataFile;

    // 3. Fetch and decode base file (contains static columns + entity IDs)
    const dataResp = await fetch(dataUrl, { signal: this._abortController.signal });
    if (!dataResp.ok) throw new Error(`Failed to fetch MFB data ${dataUrl}: ${dataResp.status}`);
    let buffer = await dataResp.arrayBuffer();

    // Auto-decompress if buffer starts with gzip magic bytes (0x1f 0x8b).
    // The URL may end with .gz, but CDN or dev server may have already
    // decompressed via Content-Encoding — check actual bytes, not the URL.
    const baseHeader = new Uint8Array(buffer, 0, 2);
    if (baseHeader[0] === 0x1f && baseHeader[1] === 0x8b) {
      const ds = new DecompressionStream('gzip');
      const decompressed = new Response(new Blob([buffer]).stream().pipeThrough(ds));
      buffer = await decompressed.arrayBuffer();
    } else {
      /* not gzip-compressed — use buffer as-is */
    }

    // 4. Decode base
    const data = await decodeMFB(buffer, manifest);
    this.baseData = data;

    // 5. Extract temporal schema + shard list now that the manifest is loaded
    this._temporalNames = (manifest.columns || []).filter((c) => c.temporal).map((c) => c.name);
    this._shardList = manifest.shards || [];

    // 6. For sharded format: prime the first shard (like GFB/H3F)
    //    v1: manifest.temporalAttributes (per-attribute shard files)
    //    v2: manifest.shards + manifest.shardFormat === 'v2' (single SHD2 files)
    const hasV1Shards = manifest.temporalAttributes && manifest.temporalAttributes.length > 0;
    const hasV2Shards =
      (manifest.shardFormat === 'v2' || manifest.shardFormat === 'v3') &&
      manifest.shards &&
      manifest.shards.length > 0;
    if (hasV1Shards || hasV2Shards) {
      data.epochCount = manifest.epochCount || data.epochCount;
      data.epochInterval = manifest.epochInterval || data.epochInterval;
      await this.loadFirstShard();
    }

    return data;
  }

  /**
   * True when this MFB layer has temporal shards (vs a static single-file MFB).
   * LayerManager uses this to decide whether to wire a per-frame shardedLoader.
   */
  get hasShards() {
    return this._shardList.length > 0;
  }

  /**
   * Load the first shard (called during init).
   */
  async loadFirstShard() {
    if (this._shardList.length === 0) return;
    await this._fetchAndStoreShard(0);
    this._activateShard(0);
  }

  /**
   * Get the shard index for a given global epoch.
   */
  getShardIndex(epoch) {
    for (let i = 0; i < this._shardList.length; i++) {
      const s = this._shardList[i];
      if (epoch >= s.epochs[0] && epoch <= s.epochs[1]) return i;
    }
    return this._shardList.length - 1;
  }

  /**
   * Ensure the correct shard is loaded for the given normalizedTime.
   * Called each frame from the render loop. Returns true if shard changed.
   * @param {number} normalizedTime - Time in [0, 1]
   * @returns {boolean}
   */
  updateForTime(normalizedTime) {
    if (this._shardList.length === 0) return false;

    const epochCount = this.manifest.epochCount || 1;
    const epoch = Math.floor(normalizedTime * (epochCount - 1));
    const neededShard = this.getShardIndex(Math.min(epoch, epochCount - 1));

    // ─── Rate-aware pre-fetch ───
    const shardInfo = this._shardList[neededShard];
    const speed = this.baseData._playbackSpeed || 60;
    const epochInterval = this.manifest.epochInterval || 60;
    const epochsLeft = Math.max(shardInfo.epochs[1] - epoch, 0);
    const realSecondsLeft = epochsLeft * (epochInterval / speed);

    const FETCH_BUDGET_S = 15;
    const shardProgress =
      shardInfo.epochCount > 0 ? (epoch - shardInfo.epochs[0]) / shardInfo.epochCount : 0;
    const shardDuration = shardInfo.epochCount * (epochInterval / speed);
    const lookahead =
      shardDuration > 0 ? Math.min(Math.ceil(FETCH_BUDGET_S / shardDuration) + 1, 5) : 1;

    const triggerThreshold = FETCH_BUDGET_S * lookahead;
    const shouldPrefetch = realSecondsLeft < triggerThreshold || shardProgress > 0.05;

    if (shouldPrefetch) {
      for (let i = 1; i <= lookahead; i++) {
        const futureIdx = (neededShard + i) % this._shardList.length;
        this._preloadShard(futureIdx);
      }
    }

    if (neededShard === this._activeShardIdx) return false;

    // Shard is already loaded? Activate immediately.
    if (this._shards.has(neededShard)) {
      this._activateShard(neededShard);
      return true;
    }

    // Shard not ready — no stall, time keeps advancing.
    // MFB consumers clamp to last available epoch.
    this._preloadShard(neededShard);
    return false;
  }

  /**
   * Activate a loaded shard — swap temporal data pointers.
   */
  _activateShard(shardIdx) {
    const shardData = this._shards.get(shardIdx);
    if (!shardData) return;

    this._activeShardIdx = shardIdx;
    this._shardDirty = true;
    const shard = this._shardList[shardIdx];
    const shardEpochCount = shard.epochCount || shard.epochs[1] - shard.epochs[0] + 1;

    // Swap temporal column references to point to this shard's data
    for (const [attrName, values] of shardData) {
      this.baseData.temporalColumns[attrName] = values;
    }
    this.baseData._shardEpochStart = shard.epochs[0];
    this.baseData._shardEpochCount = shardEpochCount;

    // Activated shard

    // Evict old shards — keep current + next 3 (matches pre-fetch window)
    setTimeout(() => {
      const keep = new Set();
      for (let i = 0; i <= 3; i++) {
        keep.add((this._activeShardIdx + i) % this._shardList.length);
      }
      for (const [idx] of this._shards) {
        if (!keep.has(idx)) this._shards.delete(idx);
      }
    }, 2000);
  }

  /**
   * Pre-fetch a shard in the background.
   */
  _preloadShard(shardIdx) {
    if (
      this._failedShards.has(shardIdx) ||
      this._shards.has(shardIdx) ||
      this._pendingFetches.has(shardIdx)
    )
      return;
    if (this._activeFetchCount >= 3) return; // max concurrent fetches (aggressive)

    this._pendingFetches.add(shardIdx);
    this._activeFetchCount++;

    this._fetchAndStoreShard(shardIdx)
      .then(() => {
        // If this shard is what we need now and we're stalling, activate it
        const epochCount = this.manifest.epochCount || 1;
        const currentTime = this.baseData._currentNormalizedTime || 0;
        const epoch = Math.floor(currentTime * (epochCount - 1));
        const neededShard = this.getShardIndex(epoch);
        if (shardIdx === neededShard && this._activeShardIdx !== shardIdx) {
          this._activateShard(shardIdx);
        }
      })
      .catch((e) => {
        console.warn(`[MFBLoader] Failed to load shard ${shardIdx}:`, e);
        this._failedShards.add(shardIdx);
      })
      .finally(() => {
        this._pendingFetches.delete(shardIdx);
        this._activeFetchCount--;
      });
  }

  /**
   * Fetch, decompress, and store a shard's data.
   */
  async _fetchAndStoreShard(shardIdx) {
    if (this._shards.has(shardIdx)) return;
    const shard = this._shardList[shardIdx];
    const entityCount = this.baseData.entityCount;
    const shardEpochCount = shard.epochCount || shard.epochs[1] - shard.epochs[0] + 1;
    const totalValues = shardEpochCount * entityCount;

    const shardData = new Map();

    // ── V3: selective column fetch via Range Requests ──
    const shardFile = shard.file;
    const shardUrl = shardFile.startsWith('./')
      ? this.baseDir + shardFile.substring(2)
      : this.baseDir + shardFile;

    const result = await fetchColumns(shardUrl, this._temporalNames);

    if (result.columns) {
      // Range fetch succeeded — extract typed arrays
      for (const colName of this._temporalNames) {
        if (result.columns.has(colName)) {
          const ab = result.columns.get(colName);
          const values = new Float32Array(ab, 0, Math.min(totalValues, ab.byteLength / 4));
          shardData.set(colName, values);
        }
      }
    } else if (result.rawBuffer) {
      // Range not supported — full-file fallback, parse SHD3
      const buf = result.rawBuffer;
      const { columns } = await decodeShardV3(buf);
      for (const cn of this._temporalNames) {
        if (columns.has(cn)) {
          const colBuf = columns.get(cn);
          shardData.set(
            cn,
            new Float32Array(colBuf, 0, Math.min(totalValues, colBuf.byteLength / 4))
          );
        }
      }
    }

    this._shards.set(shardIdx, shardData);
    // Shard stored
  }

  /** Get the active shard index. */
  activeShardIndex() {
    return this._activeShardIdx;
  }

  /**
   * Release all shard memory. Delegates to ShardLoader.dispose(), which clears
   * shard maps, nulls manifest/baseData, and aborts in-flight manifest/base
   * fetches via the AbortController. (Shard fetches use fetchColumns() and are
   * not signal-cancellable; their results are dropped via cleared _shards.)
   */
  destroy() {
    super.dispose();
  }
}
