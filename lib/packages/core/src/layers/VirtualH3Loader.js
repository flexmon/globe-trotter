/**
 * VirtualH3Loader.js — FlexDB-powered per-epoch H3 aggregation layer.
 *
 * Replaces the static shard-file data path with a live SQL query fired
 * against FlexDB on each epoch tick. Results arrive as Arrow IPC and are
 * decoded into a dense Float32Array ready for H3FlexRenderer.writeTexture().
 *
 * Key design properties:
 *   - Double-buffered: queries next epoch in the background while rendering current
 *   - Sparse→dense: builds a lookup map from h3 cell ID → value per epoch
 *   - Multi-metric: stores separate Float32Arrays per metric name
 *   - Epoch LRU cache: last N epochs kept to support scrubbing without re-querying
 *
 * Usage:
 *   const loader = new VirtualH3Loader({
 *     flexdbUrl: 'https://flexdb.example.com',
 *     table: 'your-flex-dataset',
 *     h3Field: 'h3_5',
 *     metrics: ['incoming_octets', 'outgoing_octets'],
 *     epochIntervalSeconds: 60,
 *     epochCacheSize: 30,
 *   });
 *   await loader.init(meshCellIds);  // BigUint64Array from mesh
 *   const frame = await loader.fetchEpoch(epochTimestamp);
 *   // frame.incoming_octets → Float32Array, one value per mesh cell
 */

// ─── SQL safety helpers ───────────────────────────────────────────────────────

/** Allowlist of permitted aggregation functions. */
// ?worker&inline tells Vite to bundle the worker + its deps (apache-arrow)
// and inline the result as a base64 blob URL — required for single-file builds.
import InlineVirtualH3DecodeWorker from './VirtualH3DecodeWorker.js?worker&inline';

const ALLOWED_AGG_FUNCTIONS = new Set(['SUM', 'AVG', 'MAX', 'MIN', 'COUNT']);

/**
 * Validate a SQL identifier (table name, column name) against a strict allowlist.
 * Only alphanumeric characters and underscores are permitted.
 *
 * @security This allowlist is the ONLY SQL injection barrier for table and column
 * names interpolated into FlexDB queries. Do NOT relax the regex without first
 * adding parameterized query support in FlexDB. Relaxing without parameterization
 * is a SQL injection vulnerability.
 *
 * @param {string} name - The identifier to validate
 * @param {string} label - Human-readable label for error messages
 * @returns {string} The validated identifier (unchanged)
 * @throws {Error} If the identifier contains disallowed characters
 */
function sanitizeIdentifier(name, label) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`[VirtualH3Loader] ${label} must be a non-empty string`);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(
      `[VirtualH3Loader] ${label} contains disallowed characters: "${name}". ` +
        `Only alphanumeric characters and underscores are permitted.`
    );
  }
  return name;
}

/**
 * Validate an aggregation function name against the permitted allowlist.
 *
 * @param {string} agg - Aggregation function name (e.g. 'SUM', 'AVG')
 * @returns {string} The validated aggregation function name (uppercased)
 * @throws {Error} If the aggregation function is not in the allowlist
 */
function sanitizeAgg(agg) {
  const upper = (agg || '').toUpperCase();
  if (!ALLOWED_AGG_FUNCTIONS.has(upper)) {
    throw new Error(
      `[VirtualH3Loader] Aggregation function "${agg}" is not allowed. ` +
        `Permitted values: ${[...ALLOWED_AGG_FUNCTIONS].join(', ')}`
    );
  }
  return upper;
}

/**
 * Sanitize an optional extra WHERE clause fragment by rejecting patterns
 * associated with destructive or injection SQL.
 *
 * @param {string|null} clause - The WHERE clause fragment to validate, or null
 * @returns {string|null} The clause unchanged if safe, or null if input was null/empty
 * @throws {Error} If the clause contains disallowed SQL patterns
 */
function sanitizeExtraWhere(clause) {
  if (!clause) return null;
  if (typeof clause !== 'string') {
    throw new Error(`[VirtualH3Loader] extraWhere must be a string`);
  }
  // Reject patterns associated with SQL injection or destructive operations
  const dangerous =
    /\b(DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE|EXEC|EXECUTE|UNION|GRANT|REVOKE)\b|--|;|\/\*/i;
  if (dangerous.test(clause)) {
    throw new Error(
      `[VirtualH3Loader] extraWhere clause contains disallowed SQL patterns: "${clause}"`
    );
  }
  return clause;
}

export class VirtualH3Loader {
  /**
   * @param {Object} opts
   * @param {string}   opts.flexdbUrl            - FlexDB base URL (no trailing slash)
   * @param {string}   opts.table                - Table/dataset name in FlexDB
   * @param {string}   opts.h3Field              - H3 index column name (e.g. 'h3_5')
   * @param {string[]} opts.metrics              - Metric column names to aggregate
   * @param {string}   [opts.aggregation='SUM']  - Aggregation function (SUM, AVG, MAX)
   * @param {number}   [opts.epochIntervalSeconds=60]
   * @param {number}   [opts.epochCacheSize=30]  - Max epochs to keep in LRU cache
   * @param {string}   [opts.extraWhere]         - Optional extra WHERE clause fragment
   */
  constructor(opts) {
    this._url = (opts.flexdbUrl || 'http://localhost:8090').replace(/\/$/, '');
    this._table = sanitizeIdentifier(opts.table, 'table');
    this._h3Field = sanitizeIdentifier(opts.h3Field, 'h3Field');
    this._metrics = (opts.metrics || []).map((m, i) => {
      // Metrics may be "expr AS alias" — validate only the alias portion used as identifier
      if (/ AS /i.test(m)) {
        const [, alias] = m.split(/ AS /i);
        sanitizeIdentifier(alias.trim(), `metrics[${i}] alias`);
      } else {
        sanitizeIdentifier(m, `metrics[${i}]`);
      }
      return m;
    });
    this._agg = sanitizeAgg(opts.aggregation || 'SUM');
    this._epochInterval = opts.epochIntervalSeconds || 60;
    this._cacheSize = opts.epochCacheSize || 30;
    this._extraWhere = sanitizeExtraWhere(opts.extraWhere || null);

    /** @type {BigUint64Array|null} Ordered H3 cell IDs from the mesh */
    this._meshCellIds = null;

    /**
     * LRU epoch result cache.
     * Key: epochTimestamp (number), Value: { [metricName]: Float32Array }
     */
    this._cache = new Map();

    /** Re-usable per-metric Float32Array scratches (allocated on first use) */
    this._scratches = {};

    /** In-flight query promise (for double-buffering) */
    this._inflight = null;
    this._inflightEpoch = null;

    /** Separate AbortController for background prefetches (never aborts user fetches) */
    this._prefetchController = null;

    /** Decode worker — Arrow parsing and scatter run off the main thread. */
    this._worker = null;
    this._workerReady = null; // Promise that resolves when worker init completes
    this._workerPending = new Map(); // id → { resolve, reject }
    this._workerMsgId = 0;
  }

  /**
   * Initialize the loader with the mesh's ordered cell IDs.
   * Must be called once after the mesh tile is loaded, before fetchEpoch().
   *
   * Allocates reusable scratch buffers (one Float32Array per metric) sized
   * to the mesh cell count, avoiding per-epoch allocations during playback.
   *
   * @param {BigUint64Array} meshCellIds - Ordered H3 cell IDs from the mesh,
   *   used to build sparse→dense lookup tables on each epoch query
   * @returns {void}
   */
  init(meshCellIds) {
    this._meshCellIds = meshCellIds;
    // Pre-allocate output scratches (one per metric, used as fallback if worker unavailable)
    for (const m of this._metrics) {
      this._scratches[m] = new Float32Array(meshCellIds.length);
    }
    // Persistent cellId → dense-index map (fallback path only; worker builds its own).
    this._cellIdIndex = new Map();
    for (let i = 0; i < meshCellIds.length; i++) {
      this._cellIdIndex.set(meshCellIds[i], i);
    }

    // Spin up the decode worker. Transfer a copy of meshCellIds so the worker
    // can build its own persistent index without touching the main-thread copy.
    try {
      this._worker = new InlineVirtualH3DecodeWorker();
      this._worker.onmessage = ({ data }) => this._onWorkerMessage(data);
      this._worker.onerror = (err) => this._onWorkerError(err);

      const initId = this._workerMsgId++;
      this._workerReady = new Promise((resolve, reject) => {
        this._workerPending.set(initId, { resolve, reject });
      });

      const meshCopy = new BigUint64Array(meshCellIds); // copy — main thread keeps original
      this._worker.postMessage(
        { type: 'init', id: initId, meshCellIds: meshCopy, metrics: this._metrics },
        [meshCopy.buffer]
      );
    } catch (err) {
      console.warn(
        '[VirtualH3Loader] Worker unavailable, falling back to main-thread decode:',
        err.message
      );
      this._worker = null;
      this._workerReady = null;
    }
  }

  /**
   * Fetch and decode one epoch's data from FlexDB.
   * Returns a map of { metricName → Float32Array } in mesh-cell order.
   * Cached results are returned immediately without a network call.
   *
   * @param {number} epochTimestamp - Unix timestamp (seconds) of the epoch's start
   * @returns {Promise<Object.<string, Float32Array>|null>} Metric arrays keyed by metric name,
   *   each of length `meshCellIds.length`; returns null if the request was aborted
   */
  async fetchEpoch(epochTimestamp) {
    // Return cached result, promoting to MRU position (Map preserves insertion order)
    if (this._cache.has(epochTimestamp)) {
      const cached = this._cache.get(epochTimestamp);
      this._cache.delete(epochTimestamp);
      this._cache.set(epochTimestamp, cached);
      return cached;
    }

    try {
      // Abort any currently in-flight request to prevent lagging playback queues
      if (this._abortController) {
        this._abortController.abort();
      }
      this._abortController = new AbortController();

      this._inflightEpoch = epochTimestamp;
      this._inflight = this._queryEpoch(epochTimestamp, this._abortController.signal).then(
        (result) => {
          this._setCached(epochTimestamp, result);
          return result;
        }
      );

      return await this._inflight;
    } catch (err) {
      if (err.name === 'AbortError') {
        console.info(`[VirtualH3] Discarding aborted fetch for epoch ${epochTimestamp}`);
        return null;
      }
      throw err;
    } finally {
      if (this._inflightEpoch === epochTimestamp) {
        this._inflight = null;
        this._inflightEpoch = null;
      }
    }
  }

  /**
   * Pre-fetch the next epoch in the background so it's ready before the
   * renderer needs it. Uses a dedicated AbortController so background fetches
   * cannot accidentally abort user-initiated fetchEpoch() calls.
   *
   * Silently no-ops if the epoch is already cached or currently in-flight.
   * Any previously-queued prefetch for a different epoch is cancelled first.
   *
   * @param {number} epochTimestamp - Unix timestamp (seconds) of the epoch to pre-fetch
   * @returns {void}
   */
  prefetch(epochTimestamp) {
    if (this._cache.has(epochTimestamp) || this._inflightEpoch === epochTimestamp) return;

    // Cancel any previous prefetch that is no longer needed
    if (this._prefetchController) this._prefetchController.abort();
    this._prefetchController = new AbortController();
    const { signal } = this._prefetchController;

    this._queryEpoch(epochTimestamp, signal)
      .then((result) => {
        this._setCached(epochTimestamp, result);
        this._prefetchController = null;
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          console.warn(`[VirtualH3] Prefetch failed for epoch ${epochTimestamp}:`, err);
        }
        this._prefetchController = null;
      });
  }

  /**
   * Find the absolute maximum _epoch in the table to discover the live edge.
   * @returns {Promise<number>} Unix timestamp (seconds) of the latest available epoch
   */
  async getLatestEpoch() {
    // Include cache buster to penetrate proxy memos
    const sql = `SELECT MAX(_epoch) as latest FROM "${this._table}" /* ${Date.now()} */`;
    let val = await this._queryValue(sql);

    if (val == null) {
      console.warn(
        `[VirtualH3] Latest epoch discovery returned null. Retrying after catalog reload...`
      );
      await fetch(`${this._url}/catalog/reload`, { method: 'POST' }).catch(() => {});
      val = await this._queryValue(sql);
    }

    if (val != null) {
      const bin = Math.max(0, Number(val));
      return bin * this._epochInterval;
    }
    return 0;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * Execute a SQL query and return the first column value of the first row.
   * Returns null if the query produces no rows.
   *
   * @param {string} sql - SQL query string; should return a single scalar value
   * @returns {Promise<*>} The raw Arrow scalar value, or null on empty result
   */
  async _queryValue(sql) {
    const table = await this._queryArrow(sql);
    if (!table || table.numRows === 0) return null;
    return table.getChildAt(0).get(0);
  }

  /**
   * Build and execute the per-epoch aggregation SQL query, then decode the result.
   *
   * @param {number} epochTimestamp - Unix timestamp (seconds) of the epoch to query
   * @param {AbortSignal} signal - AbortSignal to cancel the underlying fetch
   * @returns {Promise<Object.<string, Float32Array>>} Decoded metric arrays in mesh-cell order
   * @throws {Error} If init() was not called before this method
   */
  async _queryEpoch(epochTimestamp, signal) {
    if (!this._meshCellIds) {
      throw new Error('[VirtualH3Loader] init() must be called before fetchEpoch()');
    }

    const binIndex = Math.floor(epochTimestamp / this._epochInterval);

    const selectList = [
      this._h3Field,
      ...this._metrics.map((m) => {
        if (/ AS /i.test(m)) {
          const [expr, alias] = m.split(/ AS /i);
          return `${this._agg}(${expr.trim()}) AS ${alias.trim()}`;
        }
        return `${this._agg}(${m}) AS ${m}`;
      }),
    ].join(', ');

    const whereParts = [
      `_epoch = ${binIndex}`,
      `${this._h3Field} IS NOT NULL`,
      this._extraWhere,
    ].filter(Boolean);

    const sql = `
            SELECT ${selectList}
            FROM "${this._table}"
            WHERE ${whereParts.join(' AND ')}
            GROUP BY ${this._h3Field}
            LIMIT 1000000
        `.trim();

    // Fetch raw Arrow IPC bytes. If the worker is ready, decode off main thread;
    // otherwise fall back to synchronous main-thread decode.
    const arrowBytes = await this._queryArrowBytes(sql, signal);
    if (this._worker && this._workerReady) {
      return this._decodeViaWorker(arrowBytes, signal);
    }
    // Fallback: parse Arrow and decode on the main thread.
    const { tableFromIPC } = await import('apache-arrow');
    const table = tableFromIPC(new Uint8Array(arrowBytes));
    return this._decodeResult(table);
  }

  /**
   * Fetch raw Arrow IPC bytes from FlexDB without parsing.
   * Used by _queryEpoch to transfer the buffer to the decode worker.
   */
  async _queryArrowBytes(sql, signal) {
    const response = await fetch(`${this._url}/query`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, format: 'arrow' }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`[VirtualH3Loader] FlexDB error: ${response.status} - ${body}`);
    }
    return response.arrayBuffer();
  }

  /**
   * POST a SQL query to FlexDB's /query endpoint and decode the Arrow IPC response.
   * Used by _queryValue (scalar queries) — keeps Arrow parsing on the main thread
   * since these are lightweight single-value results.
   *
   * @param {string} sql - SQL query string
   * @param {AbortSignal} [signal] - Optional AbortSignal for cancellation
   * @returns {Promise<import('apache-arrow').Table>} Decoded Arrow Table
   * @throws {Error} If the server returns a non-2xx status
   */
  async _queryArrow(sql, signal) {
    const arrowBytes = await this._queryArrowBytes(sql, signal);
    const { tableFromIPC } = await import('apache-arrow');
    return tableFromIPC(new Uint8Array(arrowBytes));
  }

  /**
   * Send Arrow IPC bytes to the decode worker and await the Float32Array results.
   * Transfers ownership of arrowBytes to the worker (zero-copy).
   */
  async _decodeViaWorker(arrowBytes, signal) {
    await this._workerReady;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      const id = this._workerMsgId++;
      const onAbort = () => {
        this._workerPending.delete(id);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this._workerPending.set(id, {
        resolve: (results) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(results);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      });

      this._worker.postMessage(
        { type: 'decode', id, arrowBytes, metrics: this._metrics, h3Field: this._h3Field },
        [arrowBytes] // transfer ownership — zero-copy
      );
    });
  }

  _onWorkerMessage(data) {
    const { type, id } = data;
    const pending = this._workerPending.get(id);
    if (!pending) return;
    this._workerPending.delete(id);

    if (type === 'init_ok') {
      pending.resolve();
    } else if (type === 'decode_ok') {
      pending.resolve(data.results);
    } else if (type === 'decode_err') {
      pending.reject(new Error(data.message));
    }
  }

  _onWorkerError(err) {
    console.error('[VirtualH3Loader] Decode worker error:', err.message);
    for (const { reject } of this._workerPending.values()) {
      reject(new Error(`[VirtualH3DecodeWorker] ${err.message}`));
    }
    this._workerPending.clear();
    // Disable worker so subsequent epochs fall back to main-thread decode.
    this._worker = null;
    this._workerReady = null;
  }

  /**
   * Decode an Arrow Table of H3 cell IDs + metric values into dense Float32Arrays
   * aligned to the mesh cell order. Cells not present in the query result are
   * left as 0. NaN values are coerced to 0.
   *
   * @param {import('apache-arrow').Table|null} arrowTable - Query result table
   * @returns {Object.<string, Float32Array>} Metric arrays keyed by metric name
   */
  _decodeResult(arrowTable) {
    // Reset all scratch buffers (reused across epochs — zero-alloc hot path).
    for (const m of this._metrics) {
      this._scratches[m].fill(0);
    }

    if (arrowTable && arrowTable.numRows > 0) {
      const h3Col = arrowTable.getChild(this._h3Field);
      const metricCols = {};
      for (const m of this._metrics) {
        const alias = / AS /i.test(m) ? m.split(/ AS /i)[1].trim() : m;
        metricCols[m] = arrowTable.getChild(alias);
      }

      // Scatter directly into scratch via the persistent cellId → meshIndex map.
      // Zero per-epoch Map allocation; eliminates the separate buildDenseEpochBuffer pass.
      for (let i = 0; i < arrowTable.numRows; i++) {
        let cellId = h3Col.get(i);
        if (cellId == null || cellId === '' || cellId === 'Null' || cellId === 'null') continue;
        try {
          if (typeof cellId === 'string') {
            const cleanHex = cellId.startsWith('0x') ? cellId.slice(2) : cellId;
            if (!/^[0-9a-fA-F]+$/.test(cleanHex) || cleanHex.length > 16) continue;
            cellId = BigInt('0x' + cleanHex);
          } else if (typeof cellId === 'number') {
            cellId = BigInt(cellId);
          } else if (typeof cellId !== 'bigint') {
            continue;
          }
          const meshIdx = this._cellIdIndex.get(cellId);
          if (meshIdx === undefined) continue;
          for (const m of this._metrics) {
            let val = metricCols[m]?.get(i);
            if (typeof val === 'bigint') val = Number(val);
            if (val != null && !isNaN(val)) this._scratches[m][meshIdx] = val;
          }
        } catch {
          continue;
        }
      }
    }

    // Slice each scratch into an independent copy safe for caching and GPU upload.
    const result = {};
    for (const m of this._metrics) {
      result[m] = this._scratches[m].slice();
    }
    return result;
  }

  /**
   * Insert a result into the LRU epoch cache, evicting the oldest entry if full.
   *
   * @param {number} epochTimestamp - Unix timestamp (seconds) used as the cache key
   * @param {Object.<string, Float32Array>} result - Decoded metric arrays to cache
   * @returns {void}
   */
  _setCached(epochTimestamp, result) {
    // Evict oldest entry if at capacity (FIFO on insertion order)
    if (this._cache.size >= this._cacheSize) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    this._cache.set(epochTimestamp, result);
  }

  /**
   * Release all held resources and reset the loader to an uninitialized state.
   *
   * Clears the epoch LRU cache and frees scratch buffers. After calling
   * `dispose()`, `init()` must be called again before `fetchEpoch()` can be used.
   *
   * @returns {void}
   */
  dispose() {
    this._cache.clear();
    this._meshCellIds = null;
    this._cellIdIndex = null;
    this._scratches = {};
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
    this._workerPending.clear();
    this._workerReady = null;
  }
}
