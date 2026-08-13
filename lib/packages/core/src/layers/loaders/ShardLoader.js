/**
 * ShardLoader.js — Base class for temporally sharded data loaders.
 *
 * Provides shared utilities from §C.1:
 *   - Manifest fetching
 *   - Shard list/encoding helpers (v2/v3 manifest structure)
 *   - Shard eviction using maxResidentBytes
 *   - AbortController-based disposal
 *
 * Subclasses implement load(), updateForTime(), etc. using these utilities.
 * Format-specific decode stays in subclasses verbatim.
 */

export class ShardLoader {
  /**
   * @param {string} manifestUrl - URL to the .manifest.json file
   * @param {Object} [opts]
   * @param {number} [opts.maxResidentBytes=500MB] - Soft cache budget
   * @param {boolean} [opts.decodeInWorker=false] - Future: decode in Web Worker
   * @param {AbortSignal} [opts.signal] - External abort signal
   */
  constructor(manifestUrl, opts = {}) {
    this.manifestUrl = manifestUrl;
    this.baseUrl = manifestUrl.replace(/[^/]+$/, '');
    this.opts = opts;

    this.manifest = null;
    this.baseData = null;

    this._shards = new Map();
    this._activeShardIdx = -1;
    this._pendingFetches = new Map();
    this._failedShards = new Set();
    this._shardDirty = false;
    this._activeFetchCount = 0;
    this._activeMetric = null;
    this._activeMetricDef = null;
    this._isCombined = false;

    // Memory budget for resident shards (floor: current + next 3)
    this._maxResidentBytes = opts.maxResidentBytes ?? 500 * 1024 * 1024;

    // AbortController for in-flight fetches (disposed on dispose())
    this._abortController = new AbortController();
    this._disposed = false;

    // Link external signal if provided
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => this.dispose());
    }
  }

  /**
   * Free buffers, abort in-flight fetches. Idempotent.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    this._abortController.abort();
    this._shards.clear();
    this._pendingFetches.clear();
    this._failedShards.clear();
    this.manifest = null;
    this.baseData = null;
    this._activeShardIdx = -1;
    this._activeFetchCount = 0;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Shared utilities (used by subclass load() methods)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Fetch the manifest JSON. §C.2: rejection on manifest failure.
   * @param {string} url
   * @returns {Promise<Object>}
   */
  async _fetchManifest(url) {
    const resp = await fetch(url || this.manifestUrl, { signal: this._abortController.signal });
    if (!resp.ok) throw new Error(`Failed to fetch manifest: ${resp.status}`);
    return resp.json();
  }

  /**
   * Get the shard list for the active metric.
   * v3: per-metric shard lists; v2 / v3-combined: top-level shards.
   *
   * Behavior matches the pre-migration ShardedH3Flex/DGFlex loaders exactly:
   * returns manifest.shards directly (callers index [0] right after a
   * successful manifest load, so the shard list is always present in practice).
   *
   * @returns {Array<{file: string, epochs: [number, number], epochCount: number}>}
   */
  _getShardList() {
    // v3 per-metric
    if (this._activeMetricDef?.shards) {
      return this._activeMetricDef.shards;
    }
    // v2 / v3 combined
    return this.manifest.shards;
  }

  /**
   * Get the encoding for the active metric.
   * Heuristic matches the pre-migration loaders: a present _activeMetricDef
   * (v3 per-metric) takes precedence and returns its .encoding directly
   * (per-metric defs always carry an encoding); otherwise fall back to
   * manifest-level flags, then 'dense'.
   *
   * @returns {string} 'dense' | 'sparse' | 'rle'
   */
  _getEncoding() {
    if (this._activeMetricDef) {
      return this._activeMetricDef.encoding;
    }
    if (this.manifest.rleEncoding) return 'rle';
    if (this.manifest.sparseFormat) return 'sparse';
    return 'dense';
  }

  /**
   * Evict old shards using LRU + maxResidentBytes.
   * Floor: keep current + next 3 regardless of budget.
   * Ceiling: if total fits under budget, keep everything.
   */
  _evict() {
    const shardList = this._getShardList();
    const keep = new Set();

    // Floor: current + next 3
    for (let i = 0; i <= 3; i++) {
      keep.add((this._activeShardIdx + i) % shardList.length);
    }

    // Ceiling: if total bytes fit, keep all
    let totalBytes = 0;
    for (const shard of this._shards.values()) {
      if (!shard) continue;
      if (shard instanceof Map) {
        for (const col of shard.values()) {
          totalBytes += col.byteLength || 0;
        }
      } else if (shard.byteLength) {
        totalBytes += shard.byteLength;
      } else if (shard.temporalAttrs) {
        // GFB shard shape
        for (const col of shard.temporalAttrs.values()) {
          totalBytes += col.byteLength || 0;
        }
        if (shard.packedPositions) totalBytes += shard.packedPositions.byteLength;
      }
    }

    if (totalBytes <= this._maxResidentBytes) {
      for (const idx of this._shards.keys()) keep.add(idx);
    }

    // Evict everything not in the keep set
    for (const [idx] of this._shards) {
      if (!keep.has(idx)) this._shards.delete(idx);
    }
  }
}
