/**
 * H3FlexShards.js — Multi-file loader for temporally sharded H3Flex data.
 *
 * Extends ShardLoader (§C.1): the base class owns the shared lifecycle helpers
 * (_fetchManifest, _getShardList, _getEncoding, _evict, dispose). Format-specific
 * decode (RLE/sparse/dense/combined shards, mesh tiles) is relocated here
 * VERBATIM behind the subclass — no decode logic was rewritten.
 *
 * Loads a manifest.json, then fetches:
 *   1. Base file (mesh + static attributes)
 *   2. Temporal shards on demand (pre-fetches next shard during playback)
 *
 * v3 manifests support per-metric shard files:
 *   Each temporalAttribute has its own shard file set, loaded independently.
 *   Only the active metric's shards are in memory — switchMetric() evicts
 *   the old metric's shards and fetches the new metric's.
 *
 * Keeps at most 2 shards in memory (current + next) to bound memory usage.
 * Exposes the same data interface as H3FlexDecoder for seamless renderer integration.
 *
 * Supports sparse shard format:
 *   Per epoch: uint32 count, uint32[count] indices, float32[count] values
 *   Expands to dense Float32Array for GPU texture upload.
 *
 * Supports RLE shard format:
 *   Cell-major: uint32 activeCellCount, then per cell:
 *   uint32 cellIndex, uint16 runCount, (uint16 runLength, float32 value)×runCount
 *   Expands to dense Float32Array for GPU texture upload.
 *
 * Performance optimizations:
 *   - Pre-fetch gated: only one background fetch at a time to avoid
 *     bandwidth contention during user interaction
 *   - Shard activation is non-blocking (uses amortized texture uploads)
 */

import { decodeH3Flex, decodeH3Mesh } from '../H3FlexDecoder.js';
import {
  fetchColumns,
  isShardV3,
  decodeShardV3,
  createTypedArray,
} from '../../../../data-sdk/src/decoders/ShardV3Decoder.js';
import { getMeshFromCache, putMeshInCache } from '../MeshCache.js';
import { maybeDecompress } from '../../util/compression.js';
import { ShardLoader } from './ShardLoader.js';

// Enable verbose client-side logging for troubleshooting
const DEBUG = true;

export class H3FlexShards extends ShardLoader {
  /**
   * @param {string} manifestUrl - URL to the .manifest.json file
   * @param {Object} [options]
   * @param {number} [options.maxResidentBytes=500MB] - Soft cache budget for
   *   keeping decoded shards resident. Floor of "current + next 3" is always
   *   honored regardless of budget.
   */
  constructor(manifestUrl, options = {}) {
    super(manifestUrl, options);
    // Base class owns: manifest, baseData, _shards, _activeShardIdx,
    // _pendingFetches, _failedShards, _shardDirty, _activeFetchCount,
    // _activeMetric, _activeMetricDef, _isCombined, _maxResidentBytes,
    // _abortController.
    this._preUploadPending = null; // Pre-upload signal for LayerManager
    this._boundaryExtended = false; // Whether current shard has been extended with next shard's first epoch
    this.baseData = null; // Decoded H3Flex base (mesh + static)
  }

  /**
   * Load manifest + base + first shard. Returns decoded base data
   * augmented with temporal info from the first shard.
   * @param {string} [activeMetric] - Metric to load initially (v3). Defaults to manifest.activeMetric or first attribute.
   * @returns {Promise<Object>} Decoded H3Flex data object
   */
  async load(activeMetric) {
    // 1. Fetch manifest (base class: rejects on failure per §C.2)
    this.manifest = await this._fetchManifest(this.manifestUrl);

    // Determine v3 combined vs v3 per-metric vs v2 legacy
    this._isCombined = !!this.manifest.combinedShards;
    const isV3PerMetric =
      !this._isCombined &&
      this.manifest.version >= 3 &&
      this.manifest.temporalAttributes?.length > 0 &&
      this.manifest.temporalAttributes[0].shards;

    if (this._isCombined) {
      // v3 combined: all attributes in each shard file
      this._activeMetric =
        activeMetric || this.manifest.activeMetric || this.manifest.temporalAttributes[0].name;
      this._activeMetricDef = null; // no per-metric shard lists
      const enc = this.manifest.rleEncoding
        ? 'rle'
        : this.manifest.sparseFormat
          ? 'sparse'
          : 'dense';
    } else if (isV3PerMetric) {
      // v3: per-metric shard files
      this._activeMetric =
        activeMetric || this.manifest.activeMetric || this.manifest.temporalAttributes[0].name;
      this._activeMetricDef = this.manifest.temporalAttributes.find(
        (a) => a.name === this._activeMetric
      );
      if (!this._activeMetricDef) {
        throw new Error(`[ShardedLoader] Metric "${this._activeMetric}" not found in manifest`);
      }
    } else {
      // v2: top-level shards
      this._activeMetric = this.manifest.temporalAttribute || 'value';
      this._activeMetricDef = null;
    }

    const shardList = this._getShardList();

    // 2. Fetch base + first shard in parallel
    const baseUrl = this.baseUrl + this.manifest.base;
    const firstShardUrl = this.baseUrl + shardList[0].file;

    const [baseResp, shardResp] = await Promise.all([fetch(baseUrl), fetch(firstShardUrl)]);

    if (!baseResp.ok) throw new Error(`Failed to fetch base: ${baseResp.status}`);
    if (!shardResp.ok) throw new Error(`Failed to fetch shard 0: ${shardResp.status}`);

    const [baseBufferRaw, shardBufferRaw] = await Promise.all([
      baseResp.arrayBuffer(),
      shardResp.arrayBuffer(),
    ]);

    // Auto-decompress if gzip (CDN may not set Content-Encoding: gzip)
    const [baseBuffer, shardBuffer] = await Promise.all([
      maybeDecompress(baseBufferRaw),
      maybeDecompress(shardBufferRaw),
    ]);

    // 3. Decode base (static attrs, no temporal — mesh may be empty if separate)
    this.baseData = await decodeH3Flex(baseBuffer, this.manifest);

    // 3b. If mesh is empty (vertexCount=0) and manifest has mesh config, fetch it
    //     Supports: meshTiles (spatially-sharded tiles) or mesh (monolithic)
    //     Both use IndexedDB cache to avoid re-downloading on repeat visits.
    if (this.baseData.mesh && this.baseData.mesh.vertexCount === 0) {
      const t0 = performance.now();

      if (this.manifest.meshTiles) {
        // ─── Tiled mesh loading ─────────────────────────────────────
        await this._loadMeshTiles(t0);
      } else if (this.manifest.mesh) {
        // ─── Monolithic mesh loading (legacy) ───────────────────────
        const meshPath = this.manifest.mesh;
        const meshUrl = meshPath.startsWith('/')
          ? meshPath
          : new URL(meshPath, new URL(this.baseUrl, window.location.href)).pathname;

        let meshBuffer = await getMeshFromCache(meshUrl);
        if (meshBuffer) {
          /* cache hit — meshBuffer already populated */
        } else {
          const meshResp = await fetch(meshUrl);
          if (!meshResp.ok) throw new Error(`Failed to fetch mesh: ${meshResp.status}`);
          meshBuffer = await maybeDecompress(await meshResp.arrayBuffer());
          await putMeshInCache(meshUrl, meshBuffer);
        }
        this.baseData.mesh = decodeH3Mesh(meshBuffer);
      }
    }

    // 4. Decode + store first shard
    let shard0;
    if (isShardV3(shardBuffer)) {
      const v3 = await decodeShardV3(shardBuffer);
      shard0 = new Map();
      const attrNames = this.manifest.temporalAttributes
        ? this.manifest.temporalAttributes.map((a) => a.name)
        : [this._activeMetric];
      for (const attr of attrNames) {
        const colBuf = v3.columns.get(attr);
        if (colBuf)
          shard0.set(attr, this._unpackColumn(colBuf, v3.types.get(attr), shardList[0].epochCount));
      }
    } else {
      shard0 = this._isCombined
        ? this._decodeCombinedShard(shardBuffer, shardList[0].epochCount)
        : this._decodeShard(shardBuffer, shardList[0].epochCount);
    }
    this._shards.set(0, shard0);
    this._activeShardIdx = 0;

    // 5. Augment baseData with manifest's epoch metadata
    this.baseData.epochCount = this.manifest.epochCount;
    this.baseData.epochInterval = this.manifest.epochInterval;

    // 6. Build initial temporalColumns view from shard 0
    this._buildTemporalView(0);

    // 7. Pre-fetch shard 1 in background (deferred to avoid blocking init)
    if (shardList.length > 1) {
      setTimeout(() => this._preloadShard(1), 100);
    }

    return this.baseData;
  }

  /**
   * Load spatially-sharded H3M2 mesh tiles with viewport-selective loading.
   * Sorts tiles by distance from camera, loads initial viewport batch for
   * fast first render, then background-loads remaining tiles progressively.
   * @param {number} t0 - performance.now() start time
   */
  async _loadMeshTiles(t0) {
    // 1. Resolve tile manifest
    const tilesPath = this.manifest.meshTiles;
    const tilesManifestUrl = tilesPath.startsWith('/')
      ? tilesPath
      : new URL(tilesPath, new URL(this.baseUrl, window.location.href)).pathname;
    const tileBaseUrl = tilesManifestUrl.replace(/[^/]+$/, '');
    if (DEBUG) console.debug('[ShardedLoader] Tile manifest URL:', tilesManifestUrl);
    if (DEBUG) console.debug('[ShardedLoader] Tile base URL:', tileBaseUrl);

    const tmResp = await fetch(tilesManifestUrl);
    if (!tmResp.ok) throw new Error(`Failed to fetch tile manifest: ${tmResp.status}`);
    this._tileManifest = await tmResp.json();
    this._tileBaseUrl = tileBaseUrl;
    console.debug(
      `[ShardedLoader] Tile manifest: ${this._tileManifest.tileCount} tiles, ${this._tileManifest.totalCells.toLocaleString()} global cells`
    );

    // 3. Build dataset cell ID lookup: BigUint64 → dataset cell index
    const datasetCellIds = this.baseData.cellIds;
    this._datasetCellMap = new Map();
    for (let i = 0; i < datasetCellIds.length; i++) {
      this._datasetCellMap.set(datasetCellIds[i], i);
    }

    // 4. Sort tiles by distance from camera center
    const [camLat, camLon] = this.cameraLatLon || [0, 0];
    const DEG2RAD = Math.PI / 180;

    const tilesWithDist = this._tileManifest.tiles.map((tile) => {
      // Tile center from bounds [latMin, lonMin, latMax, lonMax]
      const tLat = (tile.bounds[0] + tile.bounds[2]) / 2;
      let tLon = (tile.bounds[1] + tile.bounds[3]) / 2;
      if (tile.bounds[3] - tile.bounds[1] > 180) tLon = tLon > 0 ? tLon - 180 : tLon + 180;
      // Great-circle angular distance (haversine shortcut)
      const dLat = (tLat - camLat) * DEG2RAD;
      const dLon = (tLon - camLon) * DEG2RAD;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(camLat * DEG2RAD) * Math.cos(tLat * DEG2RAD) * Math.sin(dLon / 2) ** 2;
      const dist = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (DEBUG) {
        // Log tiles that intersect the Pacific region (lon > 150 or lon < -150)
        if (tLon > 150 || tLon < -150) {
          console.debug('[ShardedLoader] Pacific tile candidate', {
            index: tile.index,
            bounds: tile.bounds,
            center: [tLat, tLon],
          });
        }
      }
      return { tile, dist };
    });
    tilesWithDist.sort((a, b) => a.dist - b.dist);

    // 5. Load all tiles
    const allTiles = tilesWithDist.map((t) => t.tile);
    console.debug(`[ShardedLoader] Loading all ${allTiles.length} tiles`);

    // 6. Fetch + decode all tiles → build mesh
    this._loadedTiles = [];
    const allResults = await this._fetchAndDecodeTiles(allTiles);
    this._loadedTiles.push(...allResults);
    this.baseData.mesh = this._mergeTiles(this._loadedTiles);
    console.debug(
      `[ShardedLoader] Initial mesh: ${this.baseData.mesh.vertexCount.toLocaleString()} verts in ${(performance.now() - t0).toFixed(0)}ms`
    );
  }

  /**
   * Fetch and decode a set of tiles (with IndexedDB cache + cell remap).
   * @returns {Promise<Array<{ tile, mesh, cellRemap, matched }>>}
   */
  async _fetchAndDecodeTiles(tiles) {
    let cacheHits = 0,
      cacheMisses = 0;
    const results = await Promise.all(
      tiles.map(async (tile) => {
        const tileUrl = this._tileBaseUrl + tile.file;
        if (DEBUG) console.debug('[ShardedLoader] Fetching tile', tile.index, 'from', tileUrl);
        let buffer = await getMeshFromCache(tileUrl);
        if (buffer) {
          cacheHits++;
          if (DEBUG) console.debug('[ShardedLoader] Cache hit for tile', tile.index);
        } else {
          cacheMisses++;
          const resp = await fetch(tileUrl);
          if (!resp.ok) {
            console.error(
              '[ShardedLoader] Failed to fetch tile',
              tile.index,
              'status',
              resp.status
            );
            throw new Error(`Tile ${tile.index}: ${resp.status}`);
          }
          buffer = await maybeDecompress(await resp.arrayBuffer());
          await putMeshInCache(tileUrl, buffer);
          if (DEBUG) console.debug('[ShardedLoader] Fetched and cached tile', tile.index);
        }
        return { tile, buffer };
      })
    );

    if (tiles.length > 1) {
      console.debug(
        `[ShardedLoader] Tile batch: ${cacheHits} from IndexedDB cache, ${cacheMisses} fetched from network`
      );
    }

    // Decode + build cell remap
    const unmatchedIdx = this.baseData.cellCount;
    return results.map(({ tile, buffer }) => {
      const mesh = decodeH3Mesh(buffer);
      const cellRemap = new Float32Array(mesh.cellCount);
      let matched = 0;
      if (mesh.cellIds) {
        for (let c = 0; c < mesh.cellCount; c++) {
          const idx = this._datasetCellMap.get(mesh.cellIds[c]);
          if (idx !== undefined) {
            cellRemap[c] = idx;
            matched++;
          } else {
            cellRemap[c] = unmatchedIdx;
          }
        }
      } else {
        for (let c = 0; c < mesh.cellCount; c++) {
          cellRemap[c] = tile.globalOffset + c;
        }
      }
      if (DEBUG)
        console.debug(
          '[ShardedLoader] Tile',
          tile.index,
          'matched cells',
          matched,
          'out of',
          mesh.cellCount
        );
      return { tile, mesh, cellRemap, matched };
    });
  }

  /**
   * Merge decoded tiles into a single mesh for the renderer.
   */
  _mergeTiles(decodedTiles) {
    let totalVerts = 0,
      totalIndices = 0;
    for (const { mesh } of decodedTiles) {
      totalVerts += mesh.vertexCount;
      totalIndices += mesh.indexCount;
    }

    const positions = new Float32Array(totalVerts * 3);
    const cellIndices = new Float32Array(totalVerts);
    const extrudeFlags = new Float32Array(totalVerts);
    const indices = new Uint32Array(totalIndices);
    let vOff = 0,
      iOff = 0;

    for (const { mesh, cellRemap } of decodedTiles) {
      positions.set(mesh.positions, vOff * 3);
      for (let v = 0; v < mesh.vertexCount; v++) {
        cellIndices[vOff + v] = cellRemap[mesh.cellIndices[v]];
      }
      extrudeFlags.set(mesh.extrudeFlags, vOff);
      for (let i = 0; i < mesh.indexCount; i++) {
        indices[iOff + i] = mesh.indices[i] + vOff;
      }
      vOff += mesh.vertexCount;
      iOff += mesh.indexCount;
    }

    return {
      positions,
      cellIndices,
      extrudeFlags,
      indices,
      vertexCount: totalVerts,
      indexCount: totalIndices,
      cellCount: this.baseData.cellCount,
    };
  }

  /**
   * Update the active camera position so background tile loading can re-sort remaining tiles.
   * @param {number} lat - Camera latitude
   * @param {number} lon - Camera longitude
   */
  updateCamera(lat, lon) {
    if (!this._remainingTiles || this._remainingTiles.length === 0) return;

    // Re-sort remaining tiles based on new camera distance
    const DEG2RAD = Math.PI / 180;
    this._remainingTiles.sort((a, b) => {
      const tLatA = (a.bounds[0] + a.bounds[2]) / 2;
      let tLonA = (a.bounds[1] + a.bounds[3]) / 2;
      if (a.bounds[3] - a.bounds[1] > 180) tLonA = tLonA > 0 ? tLonA - 180 : tLonA + 180;
      const dLatA = (tLatA - lat) * DEG2RAD;
      const dLonA = (tLonA - lon) * DEG2RAD;
      const distA =
        Math.sin(dLatA / 2) ** 2 +
        Math.cos(lat * DEG2RAD) * Math.cos(tLatA * DEG2RAD) * Math.sin(dLonA / 2) ** 2;

      const tLatB = (b.bounds[0] + b.bounds[2]) / 2;
      let tLonB = (b.bounds[1] + b.bounds[3]) / 2;
      if (b.bounds[3] - b.bounds[1] > 180) tLonB = tLonB > 0 ? tLonB - 180 : tLonB + 180;
      const dLatB = (tLatB - lat) * DEG2RAD;
      const dLonB = (tLonB - lon) * DEG2RAD;
      const distB =
        Math.sin(dLatB / 2) ** 2 +
        Math.cos(lat * DEG2RAD) * Math.cos(tLatB * DEG2RAD) * Math.sin(dLonB / 2) ** 2;

      return distA - distB;
    });
  }

  /**
   * Background-load remaining tiles: fetch ALL concurrently, then merge once.
   *
   * Why this works without blocking:
   *   - fetch() is async I/O — 107 concurrent fetches use zero main-thread CPU
   *   - decodeH3Mesh creates typed array views (zero-copy pointer arithmetic)
   *   - Single _mergeTiles call at the end (~50ms for 107 tiles vs 40×50ms before)
   *   - Single GPU buffer upload via onMeshUpdate/onMeshAppend
   */
  async _backgroundLoadTiles(tiles) {
    // Fire fetches in concurrency chunks to avoid slamming browser/server limits
    // 100+ concurrent fetches can cause 504 timeouts on some dev servers
    const CONCURRENCY = 15;
    for (let i = 0; i < tiles.length; i += CONCURRENCY) {
      const chunk = tiles.slice(i, i + CONCURRENCY);
      const chunkResults = await this._fetchAndDecodeTiles(chunk);
      this._loadedTiles.push(...chunkResults);

      // Incrementally merge and upload to GPU to provide progressive visual feedback
      const interimMesh = this._mergeTiles(this._loadedTiles);
      this.baseData.mesh = interimMesh;
      if (this.onMeshUpdate) {
        this.onMeshUpdate(interimMesh);
      }
      console.debug(
        `[ShardedLoader] Background chunk ${i / CONCURRENCY + 1} loaded → ${interimMesh.vertexCount.toLocaleString()} verts`
      );
    }
    // Single merge of everything → single GPU upload
    const finalMesh = this._mergeTiles(this._loadedTiles);
    this.baseData.mesh = finalMesh;

    if (this.onMeshUpdate) {
      this.onMeshUpdate(finalMesh);
    }
    if (DEBUG)
      console.debug(
        `[ShardedLoader] All ${tiles.length} background tiles loaded → ${finalMesh.vertexCount.toLocaleString()} verts, ${(finalMesh.indexCount / 3).toLocaleString()} tris`
      );
  }

  /**
   * Incrementally append decoded tiles to an existing merged mesh.
   * Avoids the O(N) full re-merge by only copying new tile data.
   */
  _appendToMergedMesh(existing, newTiles) {
    let addVerts = 0,
      addIndices = 0;
    for (const { mesh } of newTiles) {
      addVerts += mesh.vertexCount;
      addIndices += mesh.indexCount;
    }

    const totalVerts = existing.vertexCount + addVerts;
    const totalIndices = existing.indexCount + addIndices;

    // Allocate expanded arrays
    const positions = new Float32Array(totalVerts * 3);
    const cellIndices = new Float32Array(totalVerts);
    const extrudeFlags = new Float32Array(totalVerts);
    const indices = new Uint32Array(totalIndices);

    // Copy existing data
    positions.set(existing.positions);
    cellIndices.set(existing.cellIndices);
    extrudeFlags.set(existing.extrudeFlags);
    indices.set(existing.indices);

    // Append new tiles
    let vOff = existing.vertexCount;
    let iOff = existing.indexCount;

    for (const { mesh, cellRemap } of newTiles) {
      positions.set(mesh.positions, vOff * 3);
      for (let v = 0; v < mesh.vertexCount; v++) {
        cellIndices[vOff + v] = cellRemap[mesh.cellIndices[v]];
      }
      extrudeFlags.set(mesh.extrudeFlags, vOff);
      for (let i = 0; i < mesh.indexCount; i++) {
        indices[iOff + i] = mesh.indices[i] + vOff;
      }
      vOff += mesh.vertexCount;
      iOff += mesh.indexCount;
    }

    return {
      positions,
      cellIndices,
      extrudeFlags,
      indices,
      vertexCount: totalVerts,
      indexCount: totalIndices,
      cellCount: this.baseData.cellCount,
    };
  }

  /**
   * Switch the active metric (v3 only). Evicts all current shard data
   * and fetches the new metric's first shard.
   * @param {string} metricName - The metric to switch to
   * @returns {Promise<void>}
   */
  async switchMetric(metricName) {
    if (metricName === this._activeMetric) return;

    // Combined shards: all metrics already loaded — just switch the view
    if (this._isCombined) {
      const shard = this._shards.get(this._activeShardIdx);
      if (shard instanceof Map && shard.has(metricName)) {
        this._activeMetric = metricName;
        this._buildTemporalView(this._activeShardIdx);
        this._shardDirty = true;
        return;
      }
      // Shard not yet in memory (still loading or between shard boundaries).
      // Update activeMetric so the next shard decode uses the correct metric —
      // do NOT fall through to the per-metric path, which always fails for
      // combined shards (metricDef.shards is undefined by design).
      this._activeMetric = metricName;
      this._shardDirty = true;
      return;
    }

    const metricDef = this.manifest.temporalAttributes?.find((a) => a.name === metricName);
    if (!metricDef?.shards) {
      console.warn(`[ShardedLoader] Metric "${metricName}" not found or has no per-metric shards`);
      return;
    }

    // Evict all current shards
    this._shards.clear();
    this._pendingFetches.clear();
    this._preUploadPending = null;
    this._boundaryExtended = false;
    this.baseData._boundaryEpoch = null;
    this.baseData._boundaryEpochs = null;

    // Switch to new metric
    this._activeMetric = metricName;
    this._activeMetricDef = metricDef;

    const shardList = this._getShardList();

    // Figure out which shard we need based on current playback position
    const currentTime = this.baseData._currentNormalizedTime || 0;
    const epoch = Math.floor(currentTime * (this.manifest.epochCount - 1));
    const neededIdx = this.getShardIndex(epoch);

    // Fetch and decode the needed shard
    const shardInfo = shardList[neededIdx];
    const url = this.baseUrl + shardInfo.file;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch shard ${neededIdx}: ${resp.status}`);
    const buffer = await maybeDecompress(await resp.arrayBuffer());

    let data;
    if (isShardV3(buffer)) {
      const v3 = await decodeShardV3(buffer);
      data = new Map();
      const colBuf = v3.columns.get(metricName);
      if (colBuf)
        data.set(
          metricName,
          this._unpackColumn(colBuf, v3.types.get(metricName), shardInfo.epochCount)
        );
    } else {
      data = this._decodeShard(buffer, shardInfo.epochCount);
    }

    this._shards.set(neededIdx, data);
    this._activeShardIdx = neededIdx;

    // Build temporal view for the new metric
    this._buildTemporalView(neededIdx);
    this._shardDirty = true;

    // Pre-fetch next shard
    const nextIdx = (neededIdx + 1) % shardList.length;
    if (shardList.length > 1) {
      setTimeout(() => this._preloadShard(nextIdx), 100);
    }
  }

  /**
   * Create a Web Worker for off-thread shard decode.
   * Supports RLE, sparse, and dense formats (single-column).
   */
  _createDecodeWorker() {
    if (this._worker) return;

    const workerCode = `
            self.onmessage = function(e) {
                const { buffer, epochCount, cellCount, encoding, id } = e.data;
                let dense;

                if (encoding === 'rle') {
                    // RLE cell-major
                    dense = new Float32Array(epochCount * cellCount);
                    const view = new DataView(buffer);
                    let offset = 0;
                    const activeCells = view.getUint32(offset, true); offset += 4;
                    for (let c = 0; c < activeCells; c++) {
                        const cellIdx = view.getUint32(offset, true); offset += 4;
                        const runCount = view.getUint16(offset, true); offset += 2;
                        let epoch = 0;
                        for (let r = 0; r < runCount; r++) {
                            const runLen = view.getUint16(offset, true); offset += 2;
                            const value = view.getFloat32(offset, true); offset += 4;
                            for (let i = 0; i < runLen && epoch < epochCount; i++, epoch++) {
                                dense[epoch * cellCount + cellIdx] = value;
                            }
                        }
                    }
                } else if (encoding === 'sparse') {
                    // Sparse epoch-major
                    dense = new Float32Array(epochCount * cellCount);
                    const view = new DataView(buffer);
                    let offset = 0;
                    for (let e = 0; e < epochCount; e++) {
                        const count = view.getUint32(offset, true); offset += 4;
                        const dstOff = e * cellCount;
                        for (let i = 0; i < count; i++) {
                            const cellIdx = view.getUint32(offset + i * 4, true);
                            const value = view.getFloat32(offset + count * 4 + i * 4, true);
                            dense[dstOff + cellIdx] = value;
                        }
                        offset += count * 8;
                    }
                } else {
                    // Dense: direct view
                    if (buffer.byteLength % 4 === 0) {
                        dense = new Float32Array(buffer);
                    } else {
                        dense = new Float32Array(buffer.slice(0));
                    }
                }

                self.postMessage({ dense, id }, [dense.buffer]);
            };
        `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    this._worker = new Worker(URL.createObjectURL(blob));
    this._workerCallbacks = new Map();
    this._workerIdCounter = 0;

    this._worker.onmessage = (e) => {
      const { dense, id } = e.data;
      const cb = this._workerCallbacks.get(id);
      if (cb) {
        this._workerCallbacks.delete(id);
        cb(dense); // zero-copy: dense is already a Float32Array from transferred buffer
      }
    };
  }

  /**
   * Decode a shard buffer asynchronously using a Web Worker.
   * Returns a Promise<Float32Array>.
   */
  _decodeShardAsync(buffer, epochCount) {
    this._createDecodeWorker();
    const id = this._workerIdCounter++;
    const encoding = this._getEncoding();
    return new Promise((resolve) => {
      this._workerCallbacks.set(id, resolve);
      this._worker.postMessage(
        {
          buffer,
          epochCount,
          cellCount: this.manifest.cellCount,
          encoding,
          id,
        },
        [buffer]
      );
    });
  }

  /**
   * Decode a shard buffer synchronously. Returns a Float32Array.
   * Supports RLE, sparse, and dense formats.
   */
  _decodeShard(buffer, epochCount) {
    const cellCount = this.manifest.cellCount;
    const encoding = this._getEncoding();

    if (encoding === 'rle') {
      // RLE cell-major
      const dense = new Float32Array(epochCount * cellCount);
      const view = new DataView(buffer);
      let offset = 0;
      const activeCells = view.getUint32(offset, true);
      offset += 4;
      for (let c = 0; c < activeCells; c++) {
        const cellIdx = view.getUint32(offset, true);
        offset += 4;
        const runCount = view.getUint16(offset, true);
        offset += 2;
        let epoch = 0;
        for (let r = 0; r < runCount; r++) {
          const runLen = view.getUint16(offset, true);
          offset += 2;
          const value = view.getFloat32(offset, true);
          offset += 4;
          for (let i = 0; i < runLen && epoch < epochCount; i++, epoch++) {
            dense[epoch * cellCount + cellIdx] = value;
          }
        }
      }
      return dense;
    }

    if (encoding === 'dense') {
      // Dense: wrap buffer directly (zero-copy if aligned)
      if (buffer.byteLength % 4 === 0) {
        return new Float32Array(buffer);
      }
      return new Float32Array(buffer.slice(0));
    }

    // Sparse epoch-major
    const dense = new Float32Array(epochCount * cellCount);
    const view = new DataView(buffer);
    let offset = 0;
    for (let e = 0; e < epochCount; e++) {
      const count = view.getUint32(offset, true);
      offset += 4;
      const dstOff = e * cellCount;
      for (let i = 0; i < count; i++) {
        const cellIdx = view.getUint32(offset + i * 4, true);
        const value = view.getFloat32(offset + count * 4 + i * 4, true);
        dense[dstOff + cellIdx] = value;
      }
      offset += count * 8;
    }
    return dense;
  }

  /**
   * Decode a combined shard buffer containing N temporal attributes.
   * Format: u8(attrCount) + u32[N](blockSizes) + block[N]
   * Each block is encoded independently (RLE/sparse/dense).
   * Returns a Map<string, Float32Array> keyed by attribute name.
   */
  _decodeCombinedShard(buffer, epochCount) {
    const view = new DataView(buffer);
    let offset = 0;

    const attrCount = view.getUint8(offset);
    offset += 1;
    const blockSizes = [];
    for (let i = 0; i < attrCount; i++) {
      blockSizes.push(view.getUint32(offset, true));
      offset += 4;
    }

    const attrNames = this.manifest.temporalAttributes.map((a) => a.name);
    const results = new Map();

    for (let i = 0; i < attrCount; i++) {
      // zero-copy bounds passing instead of buffer.slice()
      const decoded = this._decodeSingleBlock(buffer, epochCount, offset, blockSizes[i]);
      offset += blockSizes[i];

      const name = i < attrNames.length ? attrNames[i] : `attr_${i}`;
      results.set(name, decoded);
    }

    return results;
  }

  /**
   * Decode a single attribute block (shared logic for both standalone and combined shards).
   * @param {ArrayBuffer} buffer
   * @param {number} epochCount
   * @param {number} startOffset
   * @param {number} byteLength
   * @returns {Float32Array}
   */
  _decodeSingleBlock(buffer, epochCount, startOffset = 0, byteLength = buffer.byteLength) {
    const cellCount = this.manifest.cellCount;
    const encoding = this._getEncoding();

    if (encoding === 'rle') {
      const dense = new Float32Array(epochCount * cellCount);
      const view = new DataView(buffer, startOffset, byteLength);
      let offset = 0;
      const activeCells = view.getUint32(offset, true);
      offset += 4;
      for (let c = 0; c < activeCells; c++) {
        const cellIdx = view.getUint32(offset, true);
        offset += 4;
        const runCount = view.getUint16(offset, true);
        offset += 2;
        let epoch = 0;
        for (let r = 0; r < runCount; r++) {
          const runLen = view.getUint16(offset, true);
          offset += 2;
          const value = view.getFloat32(offset, true);
          offset += 4;
          for (let i = 0; i < runLen && epoch < epochCount; i++, epoch++) {
            dense[epoch * cellCount + cellIdx] = value;
          }
        }
      }
      return dense;
    }

    if (encoding === 'dense') {
      if (startOffset % 4 === 0) {
        return new Float32Array(buffer, startOffset, byteLength / 4);
      }
      return new Float32Array(buffer.slice(startOffset, startOffset + byteLength));
    }

    // Sparse epoch-major
    const dense = new Float32Array(epochCount * cellCount);
    const view = new DataView(buffer, startOffset, byteLength);
    let offset = 0;
    for (let e = 0; e < epochCount; e++) {
      const count = view.getUint32(offset, true);
      offset += 4;
      const dstOff = e * cellCount;
      for (let i = 0; i < count; i++) {
        const cellIdx = view.getUint32(offset + i * 4, true);
        const value = view.getFloat32(offset + count * 4 + i * 4, true);
        dense[dstOff + cellIdx] = value;
      }
      offset += count * 8;
    }
    return dense;
  }

  /**
   * Unpacks a column buffer correctly depending on the Shard format encoding (RLE/Sparse/Dense)
   * @param {ArrayBuffer} colBuf
   * @param {number} typeCode
   * @param {number} epochCount
   * @returns {Float32Array|TypedArray}
   */
  _unpackColumn(colBuf, typeCode, epochCount) {
    if (this.manifest.sparseFormat || this.manifest.rleEncoding) {
      return this._decodeSingleBlock(colBuf, epochCount);
    }
    return createTypedArray(typeCode, colBuf);
  }

  /**
   * Build/update the temporalColumns on baseData to point to the active shard.
   * The renderer reads from data.temporalColumns[attribute][epoch * cellCount + i].
   * For sharded data, epoch is relative to the shard start.
   */
  _buildTemporalView(shardIdx) {
    const shard = this._shards.get(shardIdx);
    if (!shard) return;

    if (!this.baseData.temporalColumns) {
      this.baseData.temporalColumns = {};
    }

    if (shard instanceof Map) {
      // Combined shard: populate ALL temporal columns at once
      for (const [name, data] of shard) {
        this.baseData.temporalColumns[name] = data;
      }
    } else {
      // Single-column shard: store under the active metric name
      this.baseData.temporalColumns[this._activeMetric] = shard;
    }

    // Store shard metadata for the renderer to compute correct offsets
    const shardList = this._getShardList();
    this.baseData._shardEpochStart = shardList[shardIdx].epochs[0];
    this.baseData._shardEpochEnd = shardList[shardIdx].epochs[1];
    this.baseData._shardEpochCount = shardList[shardIdx].epochCount;
  }

  /**
   * Extend the current shard's temporal data with the first epoch from the next shard.
   * This allows the renderer to interpolate smoothly across shard boundaries.
   */
  _extendWithBoundaryEpoch() {
    if (this._boundaryExtended) return;

    const activeIdx = this._activeShardIdx;
    const shardList = this._getShardList();
    const nextIdx = (activeIdx + 1) % shardList.length;
    const nextShard = this._shards.get(nextIdx);
    if (!nextShard) return;

    const cellCount = this.manifest.cellCount;

    // Combined shards: nextShard is a Map<string, Float32Array>
    if (nextShard instanceof Map) {
      if (!this.baseData._boundaryEpochs) {
        this.baseData._boundaryEpochs = {};
      }
      for (const [metric, buf] of nextShard.entries()) {
        const boundarySlice = buf.subarray(0, cellCount);
        this.baseData._boundaryEpochs[metric] = boundarySlice;
        // Keep legacy activeMetric reference for generic use
        if (metric === this._activeMetric) {
          this.baseData._boundaryEpoch = boundarySlice;
        }
      }
    } else {
      // Single-column shard: store boundary epoch (zero-copy subarray view)
      this.baseData._boundaryEpoch = nextShard.subarray(0, cellCount);
      if (!this.baseData._boundaryEpochs) {
        this.baseData._boundaryEpochs = {};
      }
      this.baseData._boundaryEpochs[this._activeMetric] = this.baseData._boundaryEpoch;
    }

    this.baseData._shardEpochCount += 1;
    this._boundaryExtended = true;
    this._boundaryDirty = true; // Lightweight signal: upload boundary buffer only (no shard swap)
  }

  /**
   * Get the shard index for a given global epoch.
   */
  getShardIndex(epoch) {
    const shardList = this._getShardList();
    for (let i = 0; i < shardList.length; i++) {
      const s = shardList[i];
      if (epoch >= s.epochs[0] && epoch <= s.epochs[1]) return i;
    }
    return shardList.length - 1;
  }

  /**
   * Ensure the correct shard is loaded for the given normalizedTime.
   * Called each frame from the render loop. Returns true if shard changed.
   * @param {number} normalizedTime - Time in [0, 1]
   * @returns {boolean} Whether the active shard changed
   */
  updateForTime(normalizedTime) {
    if (!this.manifest) return false;

    const epoch = Math.floor(normalizedTime * (this.manifest.epochCount - 1));
    const neededShard = this.getShardIndex(Math.min(epoch, this.manifest.epochCount - 1));

    // ─── Rate-aware pre-fetch ───
    const shardList = this._getShardList();
    const shardInfo = shardList[neededShard];
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
        const futureIdx = (neededShard + i) % shardList.length;
        this._preloadShard(futureIdx);
      }
    }

    if (neededShard === this._activeShardIdx) return false;

    // Check if needed shard is already loaded
    if (this._shards.has(neededShard)) {
      // Activating shard
      this._activateShard(neededShard);
      return true;
    }

    // Shard not ready — renderer will clamp to last available epoch
    // (including boundary epoch if _extendWithBoundaryEpoch ran).
    // No stall: time keeps advancing, visual holds at boundary.
    this._preloadShard(neededShard);
    return false;
  }

  /**
   * Activate a loaded shard and evict old ones.
   * Keep only current shard and the one immediately ahead (forward playback).
   */
  _activateShard(shardIdx) {
    const prevIdx = this._activeShardIdx;
    this._activeShardIdx = shardIdx;
    this._boundaryExtended = false;
    this.baseData._boundaryEpoch = null;
    this._buildTemporalView(shardIdx);
    this._shardDirty = true;

    // If next shard is already loaded, extend boundary.
    const shardList = this._getShardList();
    const nextIdx = (shardIdx + 1) % shardList.length;
    if (this._shards.has(nextIdx)) {
      this._extendWithBoundaryEpoch();
    }

    // Defer shard eviction to avoid GC pressure on the swap frame.
    // Floor: always keep current + next 3 (matches pre-fetch lookahead window).
    // Ceiling: if total resident bytes fit under budget, keep all shards so
    // loop-back and high-speed playback require no re-fetches. Large-shard
    // visualizations (total > budget) fall back to the floor-only behavior.
    // Budget overridable per layer via YAML `shardCacheMB` field.
    // Eviction policy lives in ShardLoader._evict() (shared across formats).
    setTimeout(() => this._evict(), 2000);
  }

  /**
   * Pre-fetch a shard in the background.
   * Gated to one concurrent fetch at a time to avoid bandwidth contention.
   */
  _preloadShard(shardIdx) {
    if (
      this._failedShards.has(shardIdx) ||
      this._shards.has(shardIdx) ||
      this._pendingFetches.has(shardIdx)
    )
      return;

    const shardList = this._getShardList();
    const shardInfo = shardList[shardIdx];
    const url = this.baseUrl + shardInfo.file;

    this._activeFetchCount++;

    const promise = (async () => {
      let data;
      const activeMetric = this._activeMetric;
      const result = await fetchColumns(url, [activeMetric]);

      if (result && result.columns && result.columns.has(activeMetric)) {
        data = new Map();
        const colBuf = result.columns.get(activeMetric);
        data.set(
          activeMetric,
          this._unpackColumn(colBuf, result.types.get(activeMetric), shardInfo.epochCount)
        );
      } else {
        // Fallback: full file fetch
        const resp = await fetch(url);
        const buf = await maybeDecompress(await resp.arrayBuffer());
        const v3 = await decodeShardV3(buf);
        const attrNames = this.manifest.temporalAttributes
          ? this.manifest.temporalAttributes.map((a) => a.name)
          : [this._activeMetric];
        data = new Map();
        for (const attr of attrNames) {
          const colBuf = v3.columns.get(attr);
          if (colBuf)
            data.set(attr, this._unpackColumn(colBuf, v3.types.get(attr), shardInfo.epochCount));
        }
      }

      this._shards.set(shardIdx, data);
      this._pendingFetches.delete(shardIdx);
      this._activeFetchCount--;

      // If this is the next shard (relative to active), extend for smooth
      // boundary interpolation.
      const shardList = this._getShardList();
      if (shardIdx === (this._activeShardIdx + 1) % shardList.length) {
        this._extendWithBoundaryEpoch();
      }
    })().catch((err) => {
      console.error(`[ShardedLoader] Failed to load shard ${shardIdx}:`, err);
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
   * Get the active metric name.
   */
  get activeMetric() {
    return this._activeMetric;
  }

  /**
   * Release all shard memory for cleanup.
   * Delegates shared teardown (shard maps, manifest, in-flight fetch abort)
   * to ShardLoader.dispose(); terminates the decode worker on top of that.
   */
  destroy() {
    super.dispose(); // aborts in-flight fetches (§C.2) + clears shared state
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  }
}
