/**
 * StreamingGFBLoader.js — Live data loader for GFB-streaming format.
 *
 * Implements a ring buffer of decoded shards with:
 *   - Deterministic shard_idx computation from manifest metadata (no
 *     discovery/listing calls — production is a self-contained static
 *     build with no backend, so shard URLs must be fully computable)
 *   - Configurable polling interval & TTL
 *   - FIFO eviction when ring exceeds capacity
 *   - TimeController live edge advancement
 *
 * The streaming manifest (gfb-streaming) provides:
 *   - format: "gfb-streaming"
 *   - live.epochInterval: seconds per shard file (e.g., 60)
 *   - live.filePattern: template with {window_start}, {shard_idx}, {partition}
 *   - live.ttl: how long data is available (e.g., "1h")
 *   - start_timestamp: window_start of shard_idx 0 (only needed when
 *     filePattern uses {shard_idx}; defaults to shard_idx == window slot)
 *   - geometryType, hasAltitude, entityKey, columns
 *
 * Data contract: each shard file is a self-contained GFB with
 * epochCount epochs of position + temporal attribute data.
 */

import { decodeGFB } from '../GFBDecoder.js';

export class StreamingGFBLoader {
  /**
   * @param {string} manifestUrl - URL to the streaming manifest JSON
   * @param {Object} [options]
   * @param {number} [options.ttlSeconds] - Override TTL from globe-config (fallback: manifest)
   * @param {number} [options.pollIntervalMs=10000] - How often to poll for new shards
   * @param {number} [options.maxShards] - Max shards in ring buffer (computed from TTL if not set)
   */
  constructor(manifestUrl, options = {}) {
    this.manifestUrl = manifestUrl;
    this.baseUrl = manifestUrl.replace(/[^/]+$/, '');

    this.manifest = null;
    this.baseData = null;

    // Ring buffer of decoded shards, ordered oldest → newest
    this._ring = [];
    this._knownWindows = new Set(); // window_start timestamps we've fetched

    // Config (set after manifest load)
    this._pollIntervalMs = options.pollIntervalMs || 10000;
    this._ttlSeconds = options.ttlSeconds || null; // globe-config override
    this._maxShards = options.maxShards || null; // computed from TTL
    this._shardEpochInterval = 60; // seconds per shard (from manifest)
    this._shardEpochCount = 6; // epochs per shard file

    // Adaptive on-demand loading guard
    this._adaptiveFetching = false;

    // Shard discovery
    this._filePattern = '';
    this._pollTimer = null;
    this._fetching = false;
    this._shardIdxOffset = null; // Resolved deterministically from manifest during load()
    this._shardIdxPadding = 4; // Zero-pad width for shard_idx

    // State for shard dirty tracking (same interface as ShardedGFBLoader)
    this._shardDirty = false;
    this._activeRingIdx = -1;
    this._activeWindowStart = -1; // windowStart of the currently active shard
    this._floatsPerPos = 2;
    this._temporalSchema = [];
    this._bootstrapWindowStart = 0; // Window start of the first bootstrap shard

    // Stable per-column dictionaries — each enum column accumulates its own
    // entries across shards so the categorical color LUT index never changes.
    this._perColDictionaries = {}; // colName → string[]
    this._perColDictLookups = {}; // colName → Map<string, number>
    // Legacy flat global dictionary (union of all per-column dicts for backward compat)
    this._globalDictionary = [];
    this._globalDictLookup = new Map();

    // Live edge tracking
    this._liveEdgeEpoch = 0;
    this._oldestEpoch = 0;
    this._windowEpochCount = 0; // total epochs across all ring shards

    // Callbacks
    this._onLiveEdgeAdvance = null; // (liveEdge, oldestEpoch) => void
  }

  /**
   * Load the streaming manifest and bootstrap the ring buffer.
   * @returns {Promise<Object>} Base data object for the renderer
   */
  async load() {
    // 1. Fetch streaming manifest
    const resp = await fetch(this.manifestUrl);
    if (!resp.ok) throw new Error(`Failed to fetch streaming manifest: ${resp.status}`);
    this.manifest = await resp.json();

    console.debug(`pipeline=${this.manifest.pipeline}, table=${this.manifest.table}`);

    // 2. Extract configuration from manifest
    const live = this.manifest.live;
    // Manifest epochInterval = shard window duration (one shard file every N seconds)
    // GFB header epochInterval = per-epoch interval within a shard
    this._shardWindowDuration = live.epochInterval; // e.g. 60s
    this._shardEpochCount = live.shardEpochs || 1; // e.g. 6 epochs per shard
    this._shardEpochInterval = this._shardWindowDuration / this._shardEpochCount; // e.g. 10s
    this._filePattern = live.filePattern;
    this._resolveShardIdxOffset();

    // TTL: globe-config override → manifest → fallback 1h
    const ttlSec = this._ttlSeconds || this._parseTTL(live.ttl) || 3600;
    this._ttlSeconds = ttlSec; // Store resolved TTL for engine access
    this._maxShards = this._maxShards || Math.ceil(ttlSec / this._shardWindowDuration);
    console.debug(
      `(${this._shardEpochCount} epochs × ${this._shardEpochInterval}s/epoch), ` +
        `ring: ${this._maxShards} shards (${ttlSec}s TTL)`
    );

    // 3. Build synthetic base data from manifest (no base file for streaming)
    this.baseData = this._buildBaseData();

    // 4. Bootstrap: fetch the latest shard first for instant display
    await this._bootstrapLatest();

    // 5. Start polling (discovers new shards as they arrive;
    //    older shards are loaded on-demand when navigating time)
    this._startPolling();

    return this.baseData;
  }

  /**
   * Build synthetic base data from the streaming manifest.
   */
  _buildBaseData() {
    const m = this.manifest;
    const hasAltitude = m.hasAltitude || false;
    const geomType = m.geometryType || 1; // default: point
    this._floatsPerPos = hasAltitude ? 3 : 2;

    // Parse column schema
    const columns = m.columns || [];
    const temporalCols = columns.filter((c) => c.temporal);
    this._temporalSchema = temporalCols.map((c) => c.name);

    const data = {
      magic: 'GFB1',
      version: 1,
      featureCount: 0, // updated when first shard loads
      geomType,
      hasAltitude,
      hasTemporal: true,
      hasDictionary: false,
      hasEntityIds: !!m.entityKey,
      epochCount: 0, // dynamic — updated as ring grows
      epochInterval: this._shardEpochInterval,
      dictionary: [],
      schema: columns.map((c) => ({
        name: c.name,
        type: this._typeCodeFromString(c.col_type || c.type),
        temporal: c.temporal,
      })),
      staticColumns: {},
      temporalColumns: {},
      dictionaries: {},
      geometry: null,
      // Streaming metadata
      _streaming: true,
      _shardEpochStart: 0,
      _shardEpochCount: 0,
      _playbackSpeed: 1,
      _currentNormalizedTime: 0,
      _boundaryPositions: null,
      _boundaryTemporalCols: null,
    };

    if (m.entityKey) {
      data.entityKey = m.entityKey.name;
    }

    return data;
  }

  /**
   * Bootstrap: find and load only the latest shard for instant display.
   * Scans backwards from wall clock time until a shard is found.
   */
  async _bootstrapLatest() {
    const now = Math.floor(Date.now() / 1000);
    const windowDur = this._shardWindowDuration;
    // Align to the nearest shard boundary at or before now
    const latestBoundary = Math.floor(now / windowDur) * windowDur;

    console.debug(
      `${new Date(latestBoundary * 1000).toISOString()} ` +
        `(now=${new Date(now * 1000).toISOString()}, window=${windowDur}s)`
    );

    // Fast scan — try recent windows within TTL range using deterministic
    // direct URLs (shard_idx is already resolved from the manifest).
    const maxProbes = Math.min(20, Math.ceil(this._ttlSeconds / windowDur));
    for (let i = 0; i < maxProbes; i++) {
      const windowStart = latestBoundary - i * windowDur;
      if (windowStart <= 0) break;
      console.debug(`w=${windowStart} (${new Date(windowStart * 1000).toISOString()})`);
      const ok = await this._tryFetchShard(windowStart);
      if (ok) {
        this._bootstrapWindowStart = windowStart;
        console.debug(`${new Date(windowStart * 1000).toISOString()} (probe ${i + 1})`);
        return;
      }
    }

    console.warn(`[StreamingGFBLoader] No shards found during bootstrap. Will retry via polling.`);
  }

  /**
   * Resolve the deterministic shard_idx offset from manifest metadata.
   * shard_idx = (windowStart / shardWindowDuration) + offset.
   *
   * manifest.start_timestamp (window_start of shard_idx 0) pins the offset;
   * without it, offset defaults to 0 (shard_idx == window slot number).
   * Either way this requires no discovery/listing call — production is a
   * self-contained static build with no server-side listing endpoint.
   */
  _resolveShardIdxOffset() {
    if (!this._filePattern.includes('{shard_idx}')) {
      this._shardIdxOffset = 0;
      return;
    }

    const startTimestamp = this.manifest.start_timestamp;
    this._shardIdxOffset =
      typeof startTimestamp === 'number' ? -(startTimestamp / this._shardWindowDuration) : 0;

    console.debug(`shardIdxOffset=${this._shardIdxOffset}, pad=${this._shardIdxPadding}`);
  }

  /**
   * Background-load previous N epochs for smooth stepping.
   * Fires and forgets — each shard load updates the ring and live edge.
   */
  _backfillPrevious(count) {
    if (!this._bootstrapWindowStart) return;
    const windowDur = this._shardWindowDuration;
    const startFrom = this._bootstrapWindowStart;

    // Load in staggered fashion to avoid hammering the server
    let loaded = 0;
    const loadNext = async (offset) => {
      if (offset > count) return;
      const w = startFrom - offset * windowDur;
      if (w <= 0) return;
      if (this._knownWindows.has(w)) {
        // Already loaded, skip to next
        loadNext(offset + 1);
        return;
      }
      const ok = await this._tryFetchShard(w);
      if (ok) {
        loaded++;
        console.debug(`${new Date(w * 1000).toISOString()} (${loaded}/${count})`);
      }
      // Small delay between requests to avoid hammering
      setTimeout(() => loadNext(offset + 1), 200);
    };

    // Start backfilling from the epoch just before the bootstrap epoch
    loadNext(1);
  }

  /**
   * Try to fetch a shard for a given window_start timestamp, using the
   * deterministic direct URL (shard_idx is resolved once at load() time).
   * The GCS proxy returns 204 (not 404) for missing files, so Chrome
   * DevTools won't log red console errors during polling probes.
   */
  async _tryFetchShard(windowStart) {
    if (this._knownWindows.has(windowStart)) return false;

    const directUrl = this._buildDirectUrl(windowStart);
    try {
      const resp = await fetch(directUrl);
      if (resp.status === 200) {
        return this._fetchAndDecodeShard(windowStart, null, resp);
      }
      return false; // 204 = not found yet
    } catch {
      return false; // Network error
    }
  }

  /**
   * Fetch (if needed) and decode a GFB shard, add to ring.
   * @param {number} windowStart
   * @param {string|null} url - URL to fetch (null if resp already provided)
   * @param {Response|null} resp - Pre-fetched response
   */
  async _fetchAndDecodeShard(windowStart, url, resp = null) {
    if (!resp) {
      resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`[StreamingGFBLoader] Shard fetch ${resp.status}: ${url}`);
        return false;
      }
    }

    let buffer = await resp.arrayBuffer();

    // Auto-decompress gzip if Content-Encoding didn't handle it
    const header = new Uint8Array(buffer, 0, 2);
    if (header[0] === 0x1f && header[1] === 0x8b) {
      const ds = new DecompressionStream('gzip');
      buffer = await new Response(new Blob([buffer]).stream().pipeThrough(ds)).arrayBuffer();
    }

    // Decode the GFB shard (which inherently dispatches SHD3 async worker decompression)
    let decoded;
    try {
      decoded = await decodeGFB(buffer, this.manifest);
    } catch (err) {
      console.warn(`[StreamingGFBLoader] Shard w=${windowStart} decode failed: ${err.message}`);
      return false;
    }

    // First shard: update baseData from actual decoded GFB header
    if (this.baseData.featureCount === 0 && decoded.featureCount > 0) {
      this.baseData.featureCount = decoded.featureCount;
      if (decoded.hasAltitude) {
        this.baseData.hasAltitude = true;
        this._floatsPerPos = 3;
      }
      console.debug(
        `altitude=${decoded.hasAltitude}, fpp=${this._floatsPerPos}, ` +
          `geom=${decoded.geometry?.type}, posLen=${decoded.geometry?.positions?.length}, ` +
          `epochs=${decoded.epochCount}`
      );
    }

    // Merge per-column dictionaries into stable per-column global dicts.
    // decodeGFB returns `dictionaries` as {colName: string[]} — NOT a flat array.
    // Each column's dict is merged independently so indices stay stable across shards.
    const perColDicts = decoded.dictionaries || {};
    const remappedStatic = this._mergePerColumnDictionaries(
      perColDicts,
      decoded.staticColumns || {}
    );

    const shard = {
      windowStart,
      featureCount: decoded.featureCount,
      epochCount: decoded.epochCount,
      positions: decoded.geometry?.positions || null,
      packedPositions: decoded.geometry?.packedPositions || null,
      temporalAttrs: new Map(),
      staticColumns: remappedStatic,
      dictionary: this._globalDictionary,
      // Entity ids (e.g. modem_mac) are per-shard and self-contained
      // (decoded to strings), kept in sync with this shard's geometry.
      entityIds: decoded.entityIds || null,
    };

    if (decoded.temporalColumns) {
      for (const [name, data] of Object.entries(decoded.temporalColumns)) {
        shard.temporalAttrs.set(name, data);
      }
    }

    this._insertIntoRing(shard);
    this._knownWindows.add(windowStart);

    // Expose per-column dictionaries on baseData for extractStyleDictionary
    this.baseData.dictionaries = this._perColDictionaries;
    // Also set globalDictionary for backwards compat (union of all per-col dicts)
    this.baseData.dictionary = this._globalDictionary;
    this.baseData.hasDictionary = this._globalDictionary.length > 0;

    if (remappedStatic && Object.keys(this.baseData.staticColumns).length === 0) {
      Object.assign(this.baseData.staticColumns, remappedStatic);
    }

    if (this.baseData.featureCount === 0 && decoded.featureCount > 0) {
      this.baseData.featureCount = decoded.featureCount;
      // Provide representative temporal schema proxies for renderer feature-detection (velocity etc.)
      if (decoded.temporalColumns) {
        this.baseData.temporalColumns = decoded.temporalColumns;
      }
    }

    this._updateLiveEdge();

    const src = url || '(direct)';
    console.debug(
      `(${new Date(windowStart * 1000).toISOString()}) from ${src} ` +
        `(${decoded.featureCount} features, ${decoded.epochCount} epochs, ` +
        `ring=${this._ring.length}, globalDict=${this._globalDictionary.length})`
    );
    return true;
  }

  // ────────────────────────────────────────────────
  // URL Construction
  // ────────────────────────────────────────────────

  /**
   * Build a direct shard URL with the deterministic shard_idx (resolved via
   * _resolveShardIdxOffset() during load()).
   */
  _buildDirectUrl(windowStart) {
    const windowSlot = windowStart / this._shardWindowDuration;
    const idx = windowSlot + this._shardIdxOffset;
    const shardIdx = String(Math.max(0, idx)).padStart(this._shardIdxPadding, '0');

    const filename = this._filePattern
      .replace('{window_start}', String(windowStart))
      .replace('{shard_idx}', shardIdx)
      .replace('{partition}', '0000');
    return this.baseUrl + filename;
  }

  // ────────────────────────────────────────────────
  // Ring Buffer Management
  // ────────────────────────────────────────────────

  /**
   * Insert a shard into the ring in sorted order and evict if over capacity.
   */
  _insertIntoRing(shard) {
    let idx = this._ring.findIndex((s) => s.windowStart > shard.windowStart);
    if (idx === -1) idx = this._ring.length;
    this._ring.splice(idx, 0, shard);

    const excess = this._ring.length - this._maxShards;
    if (excess > 0) {
      const evicted = this._ring.splice(0, excess);
      for (const e of evicted) this._knownWindows.delete(e.windowStart);
    }

    // NOTE: do NOT set _shardDirty here. Background shard insertions
    // should not trigger renderer re-uploads. Only explicit shard
    // switches (_activateLatestShard / updateForTime) set it.
  }

  /**
   * Merge each column's per-shard dictionary into a stable per-column global
   * dictionary and remap the corresponding static column indices.
   *
   * Each enum column has its OWN dictionary (e.g. realm: ["dal.vscar.example.com", ...],
   * encoding: ["PER_FIELD_ENCRYPTION"]). Indices in each column are only valid
   * against that column's dictionary, so we must remap each column independently.
   *
   * @param {Object} perColDicts - Per-column dictionaries { colName: string[] }
   * @param {Object} staticColumns - Static columns from this shard (mutated in-place)
   * @returns {Object} staticColumns with indices remapped to per-column global dicts
   */
  _mergePerColumnDictionaries(perColDicts, staticColumns) {
    if (!perColDicts || Object.keys(perColDicts).length === 0) return staticColumns;

    for (const [colName, shardDict] of Object.entries(perColDicts)) {
      if (!Array.isArray(shardDict) || shardDict.length === 0) continue;

      // Ensure per-column global dict exists
      if (!this._perColDictionaries[colName]) {
        this._perColDictionaries[colName] = [];
        this._perColDictLookups[colName] = new Map();
      }
      const globalDict = this._perColDictionaries[colName];
      const globalLookup = this._perColDictLookups[colName];

      // Build remap: shard index → per-column global index
      const remap = new Int32Array(shardDict.length);
      let dictGrew = false;

      for (let i = 0; i < shardDict.length; i++) {
        const entry = shardDict[i];
        if (globalLookup.has(entry)) {
          remap[i] = globalLookup.get(entry);
        } else {
          const globalIdx = globalDict.length;
          globalDict.push(entry);
          globalLookup.set(entry, globalIdx);
          remap[i] = globalIdx;
          dictGrew = true;

          // Also add to legacy flat global dict (union)
          if (!this._globalDictLookup.has(entry)) {
            this._globalDictLookup.set(entry, this._globalDictionary.length);
            this._globalDictionary.push(entry);
          }
        }
      }

      // Check if remap is identity (no reordering needed)
      let isIdentity = true;
      for (let i = 0; i < remap.length; i++) {
        if (remap[i] !== i) {
          isIdentity = false;
          break;
        }
      }

      // Remap ONLY this column's indices
      if (!isIdentity && staticColumns[colName]) {
        const colData = staticColumns[colName];
        if (
          colData instanceof Float32Array ||
          colData instanceof Int32Array ||
          colData instanceof Uint32Array ||
          colData instanceof Uint16Array ||
          colData instanceof Uint8Array
        ) {
          for (let i = 0; i < colData.length; i++) {
            const oldIdx = colData[i];
            if (oldIdx >= 0 && oldIdx < remap.length) {
              colData[i] = remap[oldIdx];
            }
          }
        }
      }

      if (dictGrew) {
        console.debug(`[StreamingGFBLoader] ${colName} dict: ${globalDict.length} entries`);
      }
    }

    return staticColumns;
  }

  /**
   * Update the live edge and epoch window after ring changes.
   */
  _updateLiveEdge() {
    if (this._ring.length === 0) return;

    let totalEpochs = 0;
    for (const shard of this._ring) {
      totalEpochs += shard.epochCount;
    }

    this._windowEpochCount = totalEpochs;
    this._liveEdgeEpoch = totalEpochs - 1;
    this._oldestEpoch = 0;

    this.baseData.epochCount = totalEpochs;

    // Only snap to latest shard when following live — otherwise the user
    // is navigating historical epochs and we don't want to disturb them
    const isFollowing = this._timeController ? this._timeController.isFollowingLive : true;
    if (isFollowing) {
      this._activateLatestShard();
    }

    // Only update TimeController epoch window when following live.
    // During historical navigation, shifting the window would remap
    // currentTime to a different epoch → visible jump.
    if (this._onLiveEdgeAdvance && isFollowing) {
      const oldest = this._ring[0];
      const newest = this._ring[this._ring.length - 1];
      const liveEdgeTimestamp = newest.windowStart + this._shardWindowDuration;
      const oldestTimestamp = oldest.windowStart;
      this._onLiveEdgeAdvance(liveEdgeTimestamp, oldestTimestamp, totalEpochs);
    }
  }

  /**
   * Activate the latest shard for rendering.
   */
  _activateLatestShard() {
    if (this._ring.length === 0) return;

    const latest = this._ring[this._ring.length - 1];

    // If the latest shard is already active, skip entirely.
    // Track by windowStart (not ring index) because insertions shift indices.
    if (this._activeWindowStart === latest.windowStart) {
      this._activeRingIdx = this._ring.length - 1;
      return;
    }

    this._activeRingIdx = this._ring.length - 1;
    this._activeWindowStart = latest.windowStart;

    if (!this.baseData.geometry) {
      this.baseData.geometry = {
        type: 'temporal_point',
        floatsPerPos: this._floatsPerPos,
        hasAltitude: this.baseData.hasAltitude,
        featureCount: latest.featureCount,
      };
    }

    this.baseData.geometry.positions = latest.positions;
    this.baseData.geometry.packedPositions = latest.packedPositions;
    this.baseData.geometry.epochCount = latest.epochCount;
    this.baseData.geometry.featureCount = latest.featureCount;
    this.baseData.featureCount = latest.featureCount;
    // Keep entity ids aligned with the active shard's geometry for picking.
    this.baseData.entityIds = latest.entityIds;

    console.debug(
      `fpp=${this.baseData.geometry.floatsPerPos}, ` +
        `alt=${this.baseData.geometry.hasAltitude}, ` +
        `positions=${!!this.baseData.geometry.positions} ` +
        `(len=${this.baseData.geometry.positions?.length}), ` +
        `fc=${this.baseData.geometry.featureCount}, ` +
        `ec=${this.baseData.geometry.epochCount}, ` +
        `ring=${this._ring.length} shards`
    );

    if (!this.baseData.temporalColumns) this.baseData.temporalColumns = {};
    for (const [name, data] of latest.temporalAttrs) {
      this.baseData.temporalColumns[name] = data;
    }

    // Swap static columns — each shard has features in a different order
    if (latest.staticColumns) {
      this.baseData.staticColumns = latest.staticColumns;
    }
    // Dictionary is always the global dictionary (set in _fetchAndDecodeShard)
    this.baseData.dictionary = this._globalDictionary;

    let epochsBefore = 0;
    for (let i = 0; i < this._activeRingIdx; i++) epochsBefore += this._ring[i].epochCount;
    this.baseData._shardEpochStart = epochsBefore;
    this.baseData._shardEpochCount = latest.epochCount;

    // Mark dirty so the renderer picks up new data on initial activation
    this._shardDirty = true;
    if (this.onDataUpdated) this.onDataUpdated();
  }

  // ────────────────────────────────────────────────
  // Per-Frame Update
  // ────────────────────────────────────────────────

  /**
   * Called each frame from the render loop.
   * Ensures the correct shard is active for the given normalizedTime.
   */
  /**
   * Called each frame from the render loop.
   * Ensures the correct shard is active for the given time.
   * @param {number} normalizedTime - [0,1] across the window (unused in timestamp mode)
   * @param {number} [absoluteTimeSec] - UNIX timestamp to select the shard for
   */
  updateForTime(normalizedTime, absoluteTimeSec) {
    if (this._ring.length === 0) return false;

    // Auto-read absolute time from TimeController in live mode
    if (!absoluteTimeSec && this._timeController && this._timeController.mode === 'live') {
      absoluteTimeSec = this._timeController.currentTime;
    }

    // If absolute time is provided, find the shard by timestamp
    let targetIdx = this._ring.length - 1;
    if (absoluteTimeSec && absoluteTimeSec > 0) {
      // Check if requested time is BEFORE the oldest shard
      if (absoluteTimeSec < this._ring[0].windowStart) {
        targetIdx = 0; // Clamp to oldest — adaptive fetch will load the needed shard
      } else if (
        absoluteTimeSec >=
        this._ring[this._ring.length - 1].windowStart + this._shardWindowDuration
      ) {
        targetIdx = this._ring.length - 1; // Beyond newest — clamp to latest
      } else {
        // Find the shard containing this timestamp.
        // Binary search for the first shard whose window end exceeds absoluteTimeSec.
        // Invariant: ring is sorted ascending by windowStart; all shards have equal duration.
        let lo = 0,
          hi = this._ring.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (this._ring[mid].windowStart + this._shardWindowDuration <= absoluteTimeSec) {
            lo = mid + 1;
          } else {
            hi = mid;
          }
        }
        const shardStart = this._ring[lo].windowStart;
        if (absoluteTimeSec >= shardStart) {
          targetIdx = lo;
        } else {
          // Time falls in a gap before this shard's start. Hold on the
          // last loaded shard while adaptive fetch fills the gap.
          targetIdx = Math.max(0, lo - 1);
        }
      }
    } else {
      // Fallback: use normalizedTime epoch mapping
      const epoch = Math.floor(normalizedTime * Math.max(this._windowEpochCount - 1, 0));
      let epochOffset = 0;
      for (let i = 0; i < this._ring.length; i++) {
        if (epoch < epochOffset + this._ring[i].epochCount) {
          targetIdx = i;
          break;
        }
        epochOffset += this._ring[i].epochCount;
      }
    }

    // ── Adaptive loading: if requested time has no loaded shard, fetch on-demand ──
    // Must run BEFORE the early-return below, otherwise clamped-to-edge
    // requests never trigger a fetch for the missing shard.
    if (absoluteTimeSec && absoluteTimeSec > 0) {
      const checkShard = this._ring[targetIdx];
      const shardStart = checkShard.windowStart;
      const shardEnd = shardStart + this._shardWindowDuration;
      if (absoluteTimeSec < shardStart || absoluteTimeSec >= shardEnd) {
        const neededWindow =
          Math.floor(absoluteTimeSec / this._shardWindowDuration) * this._shardWindowDuration;
        if (!this._knownWindows.has(neededWindow) && !this._adaptiveFetching) {
          this._adaptiveFetching = true;
          console.debug(`${new Date(neededWindow * 1000).toISOString()} on-demand`);
          this._tryFetchShard(neededWindow)
            .then((ok) => {
              this._adaptiveFetching = false;
              if (ok) {
                console.debug(`${new Date(neededWindow * 1000).toISOString()}`);
              }
            })
            .catch(() => {
              this._adaptiveFetching = false;
            });
        }
      }
    }

    // Skip if the target shard is already active (compare by windowStart,
    // not ring index, since insertions shift indices)
    const targetShard = this._ring[targetIdx];
    if (targetShard.windowStart === this._activeWindowStart) return false;

    this._activeRingIdx = targetIdx;
    this._activeWindowStart = targetShard.windowStart;
    const shard = targetShard;

    this.baseData.geometry.positions = shard.positions;
    this.baseData.geometry.packedPositions = shard.packedPositions;
    this.baseData.geometry.epochCount = shard.epochCount;
    this.baseData.geometry.featureCount = shard.featureCount;
    this.baseData.featureCount = shard.featureCount;

    if (!this.baseData.temporalColumns) this.baseData.temporalColumns = {};
    for (const [name, data] of shard.temporalAttrs) {
      this.baseData.temporalColumns[name] = data;
    }

    // Update static columns — each shard has features in a different order
    // so the category-to-color mapping must match the new shard's features
    if (shard.staticColumns) {
      this.baseData.staticColumns = shard.staticColumns;
    }
    // Swap dictionary — each shard may have different dictionary ordering
    if (shard.dictionary && shard.dictionary.length > 0) {
      this.baseData.dictionary = shard.dictionary;
    }

    let epochsBefore = 0;
    for (let i = 0; i < targetIdx; i++) epochsBefore += this._ring[i].epochCount;
    this.baseData._shardEpochStart = epochsBefore;
    this.baseData._shardEpochCount = shard.epochCount;
    this._shardDirty = true;
    if (this.onDataUpdated) this.onDataUpdated();

    console.debug(`w=${shard.windowStart}, ec=${shard.epochCount}, fc=${shard.featureCount}`);

    return true;
  }

  // ────────────────────────────────────────────────
  // Polling
  // ────────────────────────────────────────────────

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._poll(), this._pollIntervalMs);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    // Don't fetch in a hidden tab — avoids unnecessary network activity and
    // the engine.dirty wakeup that would follow a successful shard fetch.
    if (typeof document !== 'undefined' && document.hidden) return;

    if (this._fetching) return;

    // Don't fetch new shards while user is navigating historical epochs
    // They must click LIVE to resume live polling
    if (this._timeController && !this._timeController.isFollowingLive) return;

    this._fetching = true;

    try {
      const now = Math.floor(Date.now() / 1000);
      const windowDur = this._shardWindowDuration;
      const latestWindow = Math.floor(now / windowDur) * windowDur;

      // Try the current window plus a few recent past windows to account
      // for pipeline latency (typically 1-2 minutes behind wall clock).
      const maxLookback = 3;
      for (let i = 0; i <= maxLookback; i++) {
        const w = latestWindow - i * windowDur;
        if (this._knownWindows.has(w)) continue;

        console.debug(`(${new Date(w * 1000).toISOString()})${i > 0 ? ` (lookback ${i})` : ''}`);
        const ok = await this._tryFetchShard(w);
        if (ok) {
          console.debug(`${new Date(w * 1000).toISOString()} (ring: ${this._ring.length} shards)`);
          break; // Got one — stop scanning
        }
      }
    } finally {
      this._fetching = false;
    }
  }

  // ────────────────────────────────────────────────
  // Utilities
  // ────────────────────────────────────────────────

  _parseTTL(ttl) {
    if (!ttl) return null;
    if (typeof ttl === 'number') return ttl;
    const match = ttl.match(/^(\d+)\s*(s|m|h|d)?$/i);
    if (!match) return null;
    const val = parseInt(match[1], 10);
    switch ((match[2] || 's').toLowerCase()) {
      case 's':
        return val;
      case 'm':
        return val * 60;
      case 'h':
        return val * 3600;
      case 'd':
        return val * 86400;
      default:
        return val;
    }
  }

  _typeCodeFromString(type) {
    const map = {
      float32: 0x01,
      float: 0x01,
      float64: 0x02,
      double: 0x02,
      int32: 0x03,
      int: 0x03,
      uint32: 0x04,
      string: 0x06,
      uint8: 0x07,
    };
    return map[type] || 0x01;
  }

  get ringInfo() {
    return {
      count: this._ring.length,
      maxShards: this._maxShards,
      windowEpochs: this._windowEpochCount,
      liveEdge: this._liveEdgeEpoch,
      oldest: this._oldestEpoch,
      windows: this._ring.map((s) => s.windowStart),
    };
  }

  /**
   * Free buffers, stop polling. Idempotent. Conforms to the §C.1 loader
   * surface (load()/dispose()); StreamingGFBLoader does NOT extend ShardLoader
   * because its live-polling / ring-buffer lifecycle differs from sharded
   * loaders, but it exposes the same dispose() entry point.
   */
  dispose() {
    this._stopPolling();
    this._ring = [];
    this._knownWindows.clear();
    this.baseData = null;
    this.manifest = null;
  }

  /** @deprecated alias for dispose() — kept for call-site compatibility. */
  destroy() {
    this.dispose();
  }
}
