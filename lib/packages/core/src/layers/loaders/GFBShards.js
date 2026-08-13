/**
 * GFBShards.js — Multi-file loader for temporally sharded GFB data.
 *
 * Extends ShardLoader (§C.1) for shared state + dispose(). GFB has no metric
 * switching; its load()/decode are format-specific (selective column fetch +
 * RGBA32F packed positions) and stay in this subclass VERBATIM. Eviction is
 * floor-only (current + next 3) — GFB does NOT use the base _evict()'s
 * maxResidentBytes ceiling, preserving its exact pre-migration memory behavior.
 *
 * Loads a manifest.json, then fetches:
 *   1. Base file (header + schema + dictionary + static attributes, epochCount=0)
 *   2. Temporal shards on demand (positions + temporal attribute columns)
 *
 * Keeps at most 2 shards in memory (current + next) to bound memory usage.
 * Each shard contains:
 *   Float32[epochCount × featureCount × floatsPerPos]   — positions
 *   Float32[epochCount × featureCount]                  — per temporal attribute column
 *
 * Exposes the same data interface as GFBDecoder for seamless renderer integration.
 *
 * Performance optimizations:
 *   - Pre-fetch gated: only one background fetch at a time to avoid
 *     bandwidth contention during user interaction
 *   - Shard activation is non-blocking
 */

import { decodeGFB, packRGBA32F_deinterleaved } from '../GFBDecoder.js';
import {
  fetchColumns,
  isShardV3,
  decodeShardV3,
} from '../../../../data-sdk/src/decoders/ShardV3Decoder.js';
import { maybeDecompress } from '../../util/compression.js';
import { ShardLoader } from './ShardLoader.js';

export class GFBShards extends ShardLoader {
  /**
   * @param {string} manifestUrl - URL to the .manifest.json file
   * @param {Object} [options] - Accepted for interface symmetry with the other
   *   sharded loaders (LoaderRegistry passes opts uniformly). GFB ignores
   *   maxResidentBytes — its eviction is floor-only.
   */
  constructor(manifestUrl, options = {}) {
    super(manifestUrl, options);
    // Base class owns: manifest, baseData, _shards, _activeShardIdx,
    // _pendingFetches, _failedShards, _shardDirty, _activeFetchCount,
    // _abortController.
    this._boundaryExtended = false; // Set when next shard's first epoch is appended
    this._temporalSchema = []; // Temporal column names from schema/manifest
    this.baseData = null; // Decoded GFB base (header + static, no positions)
  }

  /**
   * Load manifest + base + first shard. Returns decoded base data
   * augmented with temporal info from the first shard.
   * @returns {Promise<Object>} Decoded GFB data object
   */
  async load() {
    // 1. Fetch manifest
    const resp = await fetch(this.manifestUrl);
    if (!resp.ok) throw new Error(`Failed to fetch GFB manifest: ${resp.status}`);
    this.manifest = await resp.json();

    console.debug(`${this.manifest.epochCount} epochs, ${this.manifest.shards.length} shards`);

    // 2. Fetch base file
    const baseUrl = this.baseUrl + this.manifest.base;
    const baseBufferRaw = await (
      await fetch(baseUrl).then((r) => {
        if (!r.ok) throw new Error(`Failed to fetch GFB base: ${r.status}`);
        return r;
      })
    ).arrayBuffer();

    const firstShardUrl = this.baseUrl + this.manifest.shards[0].file;

    // Auto-decompress if gzip (CDN may not set Content-Encoding: gzip)
    const baseBuffer = await maybeDecompress(baseBufferRaw);

    // 3. Decode base (header + schema + dictionary + static attrs, epochCount=0)
    this.baseData = await decodeGFB(baseBuffer, this.manifest);

    // 4. Augment baseData with manifest's epoch metadata
    //    so the renderer and LayerManager see the full timeline
    this.baseData.epochCount = this.manifest.epochCount;
    this.baseData.epochInterval = this.manifest.epochInterval;

    // Determine floatsPerPos from base data flags (needed by _decodeShard)
    this._floatsPerPos = this.baseData.hasAltitude ? 3 : 2;

    // Determine temporal attribute columns from manifest or schema (needed by _decodeShard)
    this._temporalSchema =
      this.manifest.temporalAttributes ||
      this.baseData.schema?.filter((c) => c.temporal).map((c) => c.name) ||
      [];
    if (this._temporalSchema.length > 0) {
      /* temporal attribute columns detected — nothing further to precompute here */
    }

    // 5. Decode + store first shard (positions + temporal attrs)
    //    For v2: use selective column fetch via ShardV2RangeReader
    //    This downloads only needed columns via Range Requests
    const shard0 = await this._fetchAndDecodeShard(
      firstShardUrl,
      this.manifest.shards[0].epochCount
    );
    // Pre-pack positions into RGBA32F for zero-copy GPU uploads
    shard0.packedPositions = packRGBA32F_deinterleaved(
      shard0.lon,
      shard0.lat,
      shard0.alt,
      this.manifest.featureCount,
      this.manifest.shards[0].epochCount
    );
    this._shards.set(0, shard0);
    this._activeShardIdx = 0;

    // 6. Build initial geometry view from shard 0
    this._buildPositionView(0);

    // 7. Pre-fetch shard 1 in background (immediate for aggressive loading)
    if (this.manifest.shards.length > 1) {
      setTimeout(() => this._preloadShard(1), 0);
    }

    return this.baseData;
  }

  /**
   * Fetch and decode a shard — uses selective Range Requests for SHD3 shards.
   * Returns { positions, temporalAttrs }.
   */
  async _fetchAndDecodeShard(url, shardEpochCount) {
    // Selective column fetch: only positions + temporal attrs
    const colsPrefix = this.baseData.hasAltitude
      ? ['longitude', 'latitude', 'altitude']
      : ['longitude', 'latitude'];
    const neededCols = [...colsPrefix, ...this._temporalSchema];
    const result = await fetchColumns(url, neededCols);

    if (result.columns) {
      const featureCount = this.manifest.featureCount;
      const temporalAttrs = new Map();

      let lon, lat, alt;
      if (result.columns.has('longitude')) {
        const lonBuf = result.columns.get('longitude');
        lon = new Float32Array(
          lonBuf.buffer || lonBuf,
          lonBuf.byteOffset || 0,
          lonBuf.byteLength / 4
        );
        const latBuf = result.columns.get('latitude');
        lat = new Float32Array(
          latBuf.buffer || latBuf,
          latBuf.byteOffset || 0,
          latBuf.byteLength / 4
        );

        if (result.columns.has('altitude')) {
          const altBuf = result.columns.get('altitude');
          alt = new Float32Array(
            altBuf.buffer || altBuf,
            altBuf.byteOffset || 0,
            altBuf.byteLength / 4
          );
        }
      } else {
        lon = new Float32Array(shardEpochCount * featureCount);
        lat = new Float32Array(shardEpochCount * featureCount);
        if (this.baseData.hasAltitude) alt = new Float32Array(shardEpochCount * featureCount);
      }

      for (const colName of this._temporalSchema) {
        if (result.columns.has(colName)) {
          const colBuf = result.columns.get(colName);
          temporalAttrs.set(colName, new Float32Array(colBuf, 0, colBuf.byteLength / 4));
        }
      }

      return { lon, lat, alt, temporalAttrs };
    }

    // Fallback: range not supported — full decode
    if (result.rawBuffer) {
      return this._decodeShard(result.rawBuffer, shardEpochCount);
    }
  }

  /**
   * Decode a shard buffer into positions + temporal attribute columns.
   * Only supports SHD3 format.
   * @returns {Promise<{ positions: Float32Array, temporalAttrs: Map<string, Float32Array> }>}
   */
  async _decodeShard(buffer, shardEpochCount) {
    const colsPrefix = this.baseData.hasAltitude
      ? ['longitude', 'latitude', 'altitude']
      : ['longitude', 'latitude'];
    const neededNames = new Set([...colsPrefix, ...this._temporalSchema]);
    const { columns } = await decodeShardV3(buffer, neededNames);
    const featureCount = this.manifest.featureCount;
    const temporalAttrs = new Map();

    let lon, lat, alt;
    if (columns.has('longitude')) {
      const lonBuf = columns.get('longitude');
      lon = new Float32Array(lonBuf, 0, lonBuf.byteLength / 4);
      const latBuf = columns.get('latitude');
      lat = new Float32Array(latBuf, 0, latBuf.byteLength / 4);
      if (columns.has('altitude')) {
        const altBuf = columns.get('altitude');
        alt = new Float32Array(altBuf, 0, altBuf.byteLength / 4);
      }
    } else {
      lon = new Float32Array(shardEpochCount * featureCount);
      lat = new Float32Array(shardEpochCount * featureCount);
      if (this.baseData.hasAltitude) alt = new Float32Array(shardEpochCount * featureCount);
    }

    for (const colName of this._temporalSchema) {
      if (columns.has(colName)) {
        const colBuf = columns.get(colName);
        temporalAttrs.set(colName, new Float32Array(colBuf, 0, colBuf.byteLength / 4));
      }
    }

    return { lon, lat, alt, temporalAttrs };
  }

  /**
   * Build/update the geometry.packedPositions on baseData to point to the active shard.
   * The renderer reads from data.geometry.packedPositions for interpolation.
   * For sharded data, epochs are relative to the shard start.
   */
  _buildPositionView(shardIdx) {
    const shard = this._shards.get(shardIdx);
    if (!shard) return;

    const shardInfo = this.manifest.shards[shardIdx];

    // Create or update the geometry object
    if (!this.baseData.geometry) {
      this.baseData.geometry = {
        type: 'temporal_point',
        floatsPerPos: this._floatsPerPos,
        hasAltitude: this.baseData.hasAltitude,
        featureCount: this.manifest.featureCount,
      };
    }

    // Point packedPositions to the shard's data
    this.baseData.geometry.packedPositions = shard.packedPositions;
    this.baseData.geometry.epochCount = shardInfo.epochCount;

    // Attach pre-packed RGBA32F positions (computed at fetch time in background)
    this.baseData.geometry.packedPositions = shard.packedPositions || null;

    // Update temporal attribute columns from shard data
    if (shard.temporalAttrs && shard.temporalAttrs.size > 0) {
      if (!this.baseData.temporalColumns) this.baseData.temporalColumns = {};
      for (const [name, data] of shard.temporalAttrs) {
        this.baseData.temporalColumns[name] = data;
      }
    }

    // Store shard metadata for the renderer to compute correct offsets
    this.baseData._shardEpochStart = shardInfo.epochs[0];
    this.baseData._shardEpochEnd = shardInfo.epochs[1];
    this.baseData._shardEpochCount = shardInfo.epochCount;
    this._boundaryExtended = false;

    // Reset boundary references
    this.baseData._boundaryPackedPositions = null;
    this.baseData._boundaryPositions = null;
    this.baseData._boundaryTemporalCols = null;
  }

  /**
   * Get the shard index for a given global epoch.
   */
  getShardIndex(epoch) {
    for (let i = 0; i < this.manifest.shards.length; i++) {
      const s = this.manifest.shards[i];
      if (epoch >= s.epochs[0] && epoch <= s.epochs[1]) return i;
    }
    return this.manifest.shards.length - 1;
  }

  /**
   * Ensure the correct shard is loaded for the given normalizedTime.
   * Called each frame from the render loop. Returns true if shard changed.
   * @param {number} normalizedTime - Time in [0, 1]
   * @returns {boolean} Whether the active shard changed
   */
  updateForTime(normalizedTime) {
    if (!this.manifest) return false;

    // Use same epoch formula as renderers: normalizedTime * (epochCount-1)
    // IMPORTANT: Math.floor (not round) — ensures shard swap only triggers AFTER
    // the renderer has crossed the epoch boundary, preventing a visual jump.
    const epoch = Math.floor(normalizedTime * (this.manifest.epochCount - 1));
    const neededShard = this.getShardIndex(Math.min(epoch, this.manifest.epochCount - 1));

    // ─── Rate-aware pre-fetch ───
    // Same logic as ShardedH3FlexLoader: compute real seconds until
    // shard boundary, dynamically decide lookahead (1-3 shards).
    const shardInfo = this.manifest.shards[neededShard];
    const shardProgress = (epoch - shardInfo.epochs[0]) / shardInfo.epochCount;
    const speed = this.baseData._playbackSpeed || 60;
    const epochInterval = this.manifest.epochInterval || 300;
    const epochsLeft = Math.max(shardInfo.epochs[1] - epoch, 0);
    const realSecondsLeft = epochsLeft * (epochInterval / speed);

    const FETCH_BUDGET_S = 15;
    const epochsPerShard = shardInfo.epochCount;
    const shardDuration = epochsPerShard * (epochInterval / speed);
    const lookahead =
      shardDuration > 0 ? Math.min(Math.ceil(FETCH_BUDGET_S / shardDuration) + 1, 5) : 1;

    const triggerThreshold = FETCH_BUDGET_S * lookahead;
    const shouldPrefetch = realSecondsLeft < triggerThreshold || shardProgress > 0.05;

    if (shouldPrefetch) {
      for (let i = 1; i <= lookahead; i++) {
        const futureIdx = (neededShard + i) % this.manifest.shards.length;
        this._preloadShard(futureIdx);
      }
    }

    if (neededShard === this._activeShardIdx) return false;

    // Check if needed shard is already loaded
    if (this._shards.has(neededShard)) {
      this._activateShard(neededShard);
      return true;
    }

    // Shard not ready — renderer will clamp to last available epoch.
    // No stall: time keeps advancing, visual holds at boundary.
    this._preloadShard(neededShard);
    return false;
  }

  /**
   * Activate a loaded shard and evict old ones.
   * Keep only current shard and the one immediately ahead.
   */
  _activateShard(shardIdx) {
    this._activeShardIdx = shardIdx;
    this._buildPositionView(shardIdx);
    this._shardDirty = true;
    this._extendWithBoundaryEpoch();

    // Defer shard eviction to avoid GC pressure on the swap frame.
    // Keep current + next 3 shards (matches pre-fetch lookahead window)
    setTimeout(() => {
      const keep = new Set();
      for (let i = 0; i <= 3; i++) {
        keep.add((this._activeShardIdx + i) % this.manifest.shards.length);
      }
      for (const [idx] of this._shards) {
        if (!keep.has(idx)) this._shards.delete(idx);
      }
    }, 2000);
  }

  /**
   * Seamlessly append the first epoch of the next shard strictly for interpolation.
   */
  _extendWithBoundaryEpoch() {
    if (this._boundaryExtended) return;

    const activeIdx = this._activeShardIdx;
    if (activeIdx === -1) return;

    const nextIdx = (activeIdx + 1) % this.manifest.shards.length;
    const nextShard = this._shards.get(nextIdx);
    if (!nextShard) return;

    const activeShard = this._shards.get(activeIdx);
    if (!activeShard) return;

    const featureCount = this.manifest.featureCount;
    const fpp = this._floatsPerPos;

    // Zero-copy: store boundary epoch reference instead of extending the array.
    // The renderer's _uploadEpochToTex checks _boundaryPackedPositions for the boundary epoch.
    if (nextShard.packedPositions) {
      const texelsPerEpoch = nextShard.packedPositions._texelsPerEpoch;
      this.baseData._boundaryPackedPositions = nextShard.packedPositions.subarray(
        0,
        texelsPerEpoch * 4
      );
    } else if (nextShard.positions) {
      const oneEpochPosFloats = featureCount * fpp;
      this.baseData._boundaryPositions = nextShard.positions.subarray(0, oneEpochPosFloats);
    }

    // Extend temporal attributes (small — typically just category indices and velocities)
    const oneEpochFeatures = featureCount;
    for (const colName of this._temporalSchema) {
      const activeAttr = activeShard.temporalAttrs?.get(colName);
      const nextAttr = nextShard.temporalAttrs?.get(colName);
      if (activeAttr && nextAttr) {
        if (!this.baseData._boundaryTemporalCols) {
          this.baseData._boundaryTemporalCols = {};
        }
        this.baseData._boundaryTemporalCols[colName] = nextAttr.subarray(0, oneEpochFeatures);
      }
    }

    this.baseData._shardEpochCount += 1;
    this._boundaryExtended = true;
    this._shardDirty = true;
  }

  /**
   * Pre-fetch a shard in the background.
   * Gated to one concurrent fetch at a time.
   */
  _preloadShard(shardIdx) {
    if (
      this._failedShards.has(shardIdx) ||
      this._shards.has(shardIdx) ||
      this._pendingFetches.has(shardIdx)
    )
      return;

    const shardInfo = this.manifest.shards[shardIdx];
    const url = this.baseUrl + shardInfo.file;

    this._activeFetchCount++;

    const promise = this._fetchAndDecodeShard(url, shardInfo.epochCount)
      .then((data) => {
        // Pre-pack positions into RGBA32F in background (not on render frame)
        const featureCount = this.manifest.featureCount;
        data.packedPositions = packRGBA32F_deinterleaved(
          data.lon,
          data.lat,
          data.alt,
          featureCount,
          shardInfo.epochCount
        );

        this._shards.set(shardIdx, data);
        this._pendingFetches.delete(shardIdx);
        this._activeFetchCount--;

        if (shardIdx === (this._activeShardIdx + 1) % this.manifest.shards.length) {
          this._extendWithBoundaryEpoch();
        }
      })
      .catch((err) => {
        console.error(`[ShardedGFBLoader] Failed to load shard ${shardIdx}:`, err);
        this._failedShards.add(shardIdx);
        this._pendingFetches.delete(shardIdx);
        this._activeFetchCount--;
      });

    this._pendingFetches.set(shardIdx, promise);
  }

  /**
   * Get the active shard index.
   */
  get activeShardIndex() {
    return this._activeShardIdx;
  }

  /**
   * Release all shard memory for cleanup.
   * Delegates shared teardown to ShardLoader.dispose() (clears shard maps,
   * nulls manifest/baseData, aborts the AbortController). GFB's in-flight
   * shard fetches go through fetchColumns() and are not signal-cancellable,
   * but their results are dropped because _shards/_pendingFetches are cleared.
   */
  destroy() {
    super.dispose();
  }
}
