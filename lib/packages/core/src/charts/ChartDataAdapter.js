/**
 * ChartDataAdapter.js — Bridges layer temporal data to chart series.
 *
 * Reads per-epoch temporal values from loaded H3Flex layer data
 * (renderer.data.temporalColumns) and aggregates them for charting.
 *
 * Data layout in temporalColumns[attrName]:
 *   Float32Array: [epoch0_cell0, epoch0_cell1, ..., epoch1_cell0, ...]
 *   Each epoch has `cellCount` contiguous values.
 */

export class ChartDataAdapter {
  /**
   * @param {import('../layers/LayerManager.js').LayerManager} layerManager
   */
  constructor(layerManager) {
    this.layerManager = layerManager;
    this._cache = new Map();
    this._lastShardKey = new Map();

    // Pre-allocated buffers — reused across calls (zero GC pressure)
    this._histCounts = null; // Uint32Array for histogram bins
    this._cdfScratch = null; // Float32Array for CDF value collection
    this._cdfCache = null; // { epoch, values } — cached sorted CDF result
    this._cdfCacheLayer = ''; // layer name for CDF cache validity
  }

  // ─────────────────────────────────────────────
  // Time Series (aggregated per epoch)
  // ─────────────────────────────────────────────

  getTimeSeries(layerName, attribute, aggregation = 'sum') {
    const layer = this._findLayer(layerName);
    if (!layer) return null;

    const shardKey = this._getShardKey(layer);
    if (this._lastShardKey.get(layerName) === shardKey && this._cache.has(layerName)) {
      return this._cache.get(layerName);
    }

    const result = this._aggregate(layer, attribute, aggregation);
    if (result) {
      this._cache.set(layerName, result);
      this._lastShardKey.set(layerName, shardKey);
    }
    return result;
  }

  _aggregate(layer, attribute, aggregation) {
    const { attrData, cellCount, epochCount, shardEpochStart, shardEpochCount } =
      this._getTemporalData(layer, attribute);
    if (!attrData) return null;

    const values = new Float32Array(epochCount);
    values.fill(NaN);
    let min = Infinity,
      max = -Infinity;

    // Only iterate over epochs available in the current shard
    for (let localE = 0; localE < shardEpochCount; localE++) {
      const globalE = shardEpochStart + localE;
      if (globalE >= epochCount) break;

      const offset = localE * cellCount;
      let agg = 0,
        count = 0,
        epochMax = -Infinity;

      for (let c = 0; c < cellCount; c++) {
        const val = attrData[offset + c];
        if (val === 0 || isNaN(val)) continue;
        agg += val;
        count++;
        if (val > epochMax) epochMax = val;
      }

      switch (aggregation) {
        case 'sum':
          values[globalE] = agg;
          break;
        case 'mean':
          values[globalE] = count > 0 ? agg / count : 0;
          break;
        case 'max':
          values[globalE] = epochMax === -Infinity ? 0 : epochMax;
          break;
        case 'count':
          values[globalE] = count;
          break;
      }

      if (values[globalE] < min) min = values[globalE];
      if (values[globalE] > max) max = values[globalE];
    }

    if (min === Infinity) min = 0;
    if (max === -Infinity) max = 1;
    if (max === min) max = min + 1;

    return { values, dataRange: [min, max * 1.1], epochCount };
  }

  // ─────────────────────────────────────────────
  // Histogram (current epoch snapshot)
  // ─────────────────────────────────────────────

  /**
   * @param {string} layerName
   * @param {number} binCount
   * @param {number[]} domain
   * @param {number} normalizedTime 0..1
   */
  getHistogram(layerName, binCount, domain, normalizedTime, attribute, includeZeros = false) {
    const layer = this._findLayer(layerName);
    if (!layer) return null;

    // ─── GPU fast path ───
    // Only valid when the requested attribute is the active metric on the renderer,
    // since the GPU texture only contains the active metric's data.
    const renderer = layer.renderer;
    const rendererAttr = renderer?.activeAttribute || renderer?._colorAttr;
    const isActiveMetric = !attribute || attribute === rendererAttr;
    if (isActiveMetric && renderer?.computeHistogram && !layer.activeFilter) {
      const gpuEpochKey = `${layerName}_gpu_${attribute || ''}_${Math.floor(normalizedTime * 1440)}`;

      // Fire GPU compute if not already pending for this epoch
      if (this._gpuHistKey !== gpuEpochKey && !this._gpuHistPending) {
        this._gpuHistPending = true;
        renderer
          .computeHistogram(normalizedTime, binCount, domain, attribute)
          .then((result) => {
            if (result) {
              this._gpuHistCache = result;
              this._gpuHistKey = gpuEpochKey;
            }
            this._gpuHistPending = false;
          })
          .catch(() => {
            this._gpuHistPending = false;
          });
      }

      // Return cached GPU result if available and for same attribute
      if (this._gpuHistCache && this._gpuHistKey?.includes(`_${attribute || ''}_`)) {
        return this._gpuHistCache;
      }
    }

    // ─── CPU fallback path ───
    const { attrData, cellCount, epochCount, shardEpochStart, shardEpochCount } =
      this._getTemporalData(layer, attribute);
    if (!attrData) {
      console.debug(
        `[ChartDataAdapter] getHistogram: no data for "${layerName}" attr="${attribute}"`
      );
      return null;
    }

    const filterPred = this._parseSimpleFilter(layer.activeFilter);

    // Convert global epoch to shard-local offset
    const globalEpoch = Math.floor(normalizedTime * (epochCount - 1));
    const localEpoch = Math.max(0, Math.min(globalEpoch - shardEpochStart, shardEpochCount - 1));
    const offset = localEpoch * cellCount;

    // Auto-compute domain from actual data at this epoch
    let dataMin = Infinity,
      dataMax = -Infinity;
    for (let c = 0; c < cellCount; c++) {
      const val = attrData[offset + c];
      if (isNaN(val) || (!includeZeros && val === 0)) continue;
      if (filterPred && !filterPred(val)) continue;
      if (val < dataMin) dataMin = val;
      if (val > dataMax) dataMax = val;
    }
    if (dataMin === Infinity) {
      dataMin = 0;
      dataMax = 1;
    }

    // When YAML provides a domain, use it as the fixed bin range so that
    // multiple histograms with the same domain produce identical bin edges
    // (enabling apples-to-apples comparison). Min acts as a floor (clips
    // float artifacts near 0); max is a hard cap (values above land in the
    // last bin, never dropped). Without a domain, fall back to auto range.
    const effectiveDomain = [
      domain ? Math.max(domain[0], dataMin) : dataMin,
      domain?.[1] != null ? domain[1] : dataMax,
    ];
    if (effectiveDomain[0] >= effectiveDomain[1]) {
      effectiveDomain[0] -= 1;
      effectiveDomain[1] += 1;
    }

    // Reuse pre-allocated typed array for bin counts (F5 fix)
    if (!this._histCounts || this._histCounts.length < binCount) {
      this._histCounts = new Uint32Array(binCount);
    }
    const counts = this._histCounts;
    counts.fill(0);
    const binWidth = (effectiveDomain[1] - effectiveDomain[0]) / binCount;

    for (let c = 0; c < cellCount; c++) {
      const val = attrData[offset + c];
      if (isNaN(val) || (!includeZeros && val === 0)) continue;
      if (filterPred && !filterPred(val)) continue;

      const bin = Math.min(Math.floor((val - effectiveDomain[0]) / binWidth), binCount - 1);
      counts[bin]++;
    }

    // Return counts + effective domain so caller can update axes
    return {
      counts: counts.subarray(0, binCount), // zero-alloc typed array view
      effectiveDomain,
    };
  }

  // ─────────────────────────────────────────────
  // Heatmap (full 24h × value bins)
  // ─────────────────────────────────────────────

  /**
   * Build a 2D grid: grid[timeBin][valueBin] = count of cells.
   * Each time bin reads the real cell values from the corresponding epoch.
   */
  getHeatmapGrid(layerName, timeBins, valueBins, domain) {
    const layer = this._findLayer(layerName);
    if (!layer) return null;

    // Cache by shard key — full-day heatmap only changes on shard swap
    const shardKey = this._getShardKey(layer);
    const hmCacheKey = `${layerName}:${shardKey}:${timeBins}:${valueBins}:${domain[0]}:${domain[1]}:${layer.activeFilter || ''}`;
    if (this._hmCacheKey === hmCacheKey && this._hmCache) {
      return this._hmCache;
    }

    const { attrData, cellCount, epochCount, shardEpochStart, shardEpochCount } =
      this._getTemporalData(layer);
    if (!attrData) return null;

    const filterPred = this._parseSimpleFilter(layer.activeFilter);
    const binWidth = (domain[1] - domain[0]) / valueBins;

    // Initialize 2D grid
    const grid = [];
    for (let t = 0; t < timeBins; t++) {
      grid.push(new Array(valueBins).fill(0));
    }

    // Map each time bin to a shard-local epoch
    for (let tBin = 0; tBin < timeBins; tBin++) {
      const normalizedTime = (tBin + 0.5) / timeBins;
      const globalEpoch = Math.floor(normalizedTime * (epochCount - 1));
      const localEpoch = Math.max(0, Math.min(globalEpoch - shardEpochStart, shardEpochCount - 1));
      const offset = localEpoch * cellCount;

      for (let c = 0; c < cellCount; c++) {
        const val = attrData[offset + c];
        if (val === 0 || isNaN(val)) continue;
        if (val < domain[0] || val > domain[1]) continue;
        if (filterPred && !filterPred(val)) continue;

        const vBin = Math.min(Math.floor((val - domain[0]) / binWidth), valueBins - 1);
        grid[tBin][vBin]++;
      }
    }

    this._hmCacheKey = hmCacheKey;

    // Return grid wrapped with shard time metadata for data-driven X-axis
    const renderer = layer.renderer;
    const epochInterval = renderer?.data?.epochInterval || 60;
    const result = {
      grid,
      shardEpochStart,
      shardEpochCount,
      globalEpochCount: epochCount,
      epochInterval,
    };
    this._hmCache = result;
    return result;
  }
  // ─────────────────────────────────────────────
  // CDF (sorted values at current epoch)
  // ─────────────────────────────────────────────

  /**
   * Get sorted cell values at the current time for CDF rendering.
   * Updates every epoch as time progresses → animated CDF.
   */
  getCDFValues(layerName, domain, normalizedTime, attribute) {
    const layer = this._findLayer(layerName);
    if (!layer) return null;

    const { attrData, cellCount, epochCount, shardEpochStart, shardEpochCount } =
      this._getTemporalData(layer, attribute);
    if (!attrData) {
      console.debug(
        `[ChartDataAdapter] getCDFValues: no data for "${layerName}" attr="${attribute}"`
      );
      return null;
    }

    const filterPred = this._parseSimpleFilter(layer.activeFilter);

    // Convert global epoch to shard-local offset
    const globalEpoch = Math.floor(normalizedTime * (epochCount - 1));
    const localEpoch = Math.max(0, Math.min(globalEpoch - shardEpochStart, shardEpochCount - 1));
    const offset = localEpoch * cellCount;

    // Check cache — skip sort if same epoch + layer (F4 fix)
    const cacheKey = `${layerName}_${localEpoch}_${layer.activeFilter || ''}`;
    if (this._cdfCacheKey === cacheKey && this._cdfCache) {
      return this._cdfCache;
    }

    // Pre-allocate scratch buffer (reuse across calls)
    if (!this._cdfScratch || this._cdfScratch.length < cellCount) {
      this._cdfScratch = new Float32Array(cellCount);
    }

    let count = 0;
    for (let c = 0; c < cellCount; c++) {
      const val = attrData[offset + c];
      if (val === 0 || isNaN(val)) continue;
      if (filterPred && !filterPred(val)) continue;
      this._cdfScratch[count++] = val;
    }

    // Sort in-place on the typed array (faster than Array.from + sort)
    const sorted = this._cdfScratch.subarray(0, count);
    sorted.sort(); // Float32Array.sort() is native, no comparator needed

    // Return a copy (small — typically <50K values post-filter)
    // Using slice() on the subarray is fast and avoids holding the large scratch buffer
    const values = sorted.slice();

    // Cache result
    this._cdfCacheKey = cacheKey;
    this._cdfCache = values;

    return values;
  }

  // ─────────────────────────────────────────────
  // Box Plot (per-time-bin statistics)
  // ─────────────────────────────────────────────

  /**
   * Compute box plot statistics for each time bin.
   * @param {string} layerName
   * @param {number} timeBins — number of time columns (e.g. 24 for hourly)
   * @param {string} [attribute]
   * @returns {{ stats: Object[], dataRange: number[] } | null}
   */
  /**
   * @param {string} yAutoScale — 'p95' (default), 'p99', 'max', or 'mean'
   */
  getBoxPlotData(layerName, timeBins, attribute, yAutoScale = 'p95') {
    const layer = this._findLayer(layerName);
    if (!layer) return null;

    const { attrData, cellCount, epochCount, shardEpochStart, shardEpochCount } =
      this._getTemporalData(layer, attribute);
    if (!attrData) return null;

    const filterPred = this._parseSimpleFilter(layer.activeFilter);
    const stats = [];
    let globalMax = -Infinity;

    // Distribute the available shard epochs evenly across time bins
    // Each bin aggregates cells from multiple epochs for richer statistics
    const epochsPerBin = Math.max(1, Math.floor(shardEpochCount / timeBins));
    const actualBins = Math.min(timeBins, shardEpochCount);

    for (let tBin = 0; tBin < actualBins; tBin++) {
      const epochStart = tBin * epochsPerBin;
      const epochEnd =
        tBin === actualBins - 1
          ? shardEpochCount // last bin gets remaining epochs
          : epochStart + epochsPerBin;

      // Collect ALL non-zero cell values across all epochs in this bin
      const values = [];
      for (let localE = epochStart; localE < epochEnd; localE++) {
        const offset = localE * cellCount;
        for (let c = 0; c < cellCount; c++) {
          const val = attrData[offset + c];
          if (val === 0 || isNaN(val)) continue;
          if (filterPred && !filterPred(val)) continue;
          values.push(val);
        }
      }

      if (values.length === 0) {
        stats.push({ p5: 0, q1: 0, median: 0, q3: 0, p95: 0, mean: 0, count: 0 });
        continue;
      }

      values.sort((a, b) => a - b);
      const n = values.length;
      const percentile = (p) => {
        const idx = (p / 100) * (n - 1);
        const lo = Math.floor(idx);
        const hi = Math.min(lo + 1, n - 1);
        const f = idx - lo;
        return values[lo] + (values[hi] - values[lo]) * f;
      };

      const sum = values.reduce((a, v) => a + v, 0);
      const s = {
        min: values[0],
        p5: percentile(5),
        q1: percentile(25),
        median: percentile(50),
        q3: percentile(75),
        p95: percentile(95),
        max: values[n - 1],
        mean: sum / n,
        count: n,
      };
      // Whisker endpoints honor the yAutoScale setting
      if (yAutoScale === 'max') {
        s.whiskerLow = s.min;
        s.whiskerHigh = s.max;
      } else if (yAutoScale === 'p99') {
        s.whiskerLow = percentile(1);
        s.whiskerHigh = percentile(99);
      } else {
        // p95 (default) and mean
        s.whiskerLow = s.p5;
        s.whiskerHigh = s.p95;
      }
      stats.push(s);
      const scaleVal =
        yAutoScale === 'max'
          ? s.max
          : yAutoScale === 'p99'
            ? percentile(99)
            : yAutoScale === 'mean'
              ? s.mean
              : s.p95; // default
      if (scaleVal > globalMax) globalMax = scaleVal;
    }

    if (globalMax <= 0) globalMax = 1;

    // Return shard time metadata for data-driven X-axis labels
    const renderer = layer.renderer;
    const epochInterval = renderer?.data?.epochInterval || 60;
    return {
      stats,
      dataRange: [0, globalMax * 1.1],
      shardEpochStart,
      shardEpochCount,
      globalEpochCount: epochCount,
      epochInterval,
    };
  }

  /**
   * Compute categorical bar chart data: aggregate a temporal value by a static category.
   * @param {string} layerName
   * @param {string} groupBy — static ENUM16 column name to group by
   * @param {string} valueAttr — temporal Float32 column to aggregate
   * @param {string} aggregation — 'sum', 'avg', or 'count'
   * @param {number} normalizedTime — 0..1
   * @returns {{ categories: string[], values: number[], dataRange: number[] } | null}
   */
  getBarPlotData(
    layerName,
    groupBy,
    valueAttr,
    aggregation,
    normalizedTime,
    topN = 0,
    filterMode = 'aggregate',
    timeWindow = 1
  ) {
    // ─── Minute-level caching: recompute each simulated minute ───
    const layer = this._findLayer(layerName);
    if (!layer) return null;
    const renderer = layer.renderer;
    if (!renderer || !renderer.data) return null;
    const data = renderer.data;
    const globalEpochCount = data.epochCount || renderer.epochCount || 0;
    const shardStart = data._shardEpochStart || 0;
    // Use normalizedTime minute for cache key (1440 minutes/day)
    const simMinute = Math.floor(normalizedTime * 1440);
    const filterStr = layer.activeFilter || '';
    const cacheKey = `${layerName}:${simMinute}:${shardStart}:${filterStr}:${filterMode}:${timeWindow}:${aggregation}`;
    if (this._barPlotCache && this._barPlotCache.key === cacheKey) {
      return this._barPlotCache.result;
    }

    const featureCount = data.featureCount || data.cellCount || renderer.featureCount || 0;
    if (featureCount === 0) return null;

    // Get the static categorical column (ENUM16)
    const groupCol = data.staticColumns?.[groupBy];
    if (!groupCol) {
      // Find the actual layer name for diagnostics
      let foundLayerName = '<not found>';
      for (const [key, val] of this.layerManager.layers) {
        if (val.renderer === renderer) {
          foundLayerName = key;
          break;
        }
      }
      console.warn(
        `[ChartDataAdapter] groupBy column "${groupBy}" not found in staticColumns. ` +
          `Resolved layer="${foundLayerName}", staticColumns=[${Object.keys(data.staticColumns || {}).join(',')}], ` +
          `temporalColumns=[${Object.keys(data.temporalColumns || {}).join(',')}]`
      );
      return null;
    }

    // Get the dictionary for category labels
    const dictionary = data.dictionaries?.[groupBy] || data.dictionary;
    if (!dictionary) {
      console.warn(`[ChartDataAdapter] No dictionary for ENUM16 labels`);
      return null;
    }

    // Get temporal value data
    const { attrData, cellCount, epochCount, shardEpochStart, shardEpochCount } =
      this._getTemporalData(layer, valueAttr);
    if (!attrData || cellCount === 0) return null;

    // Compute current epoch position
    const globalEpoch = normalizedTime * Math.max(globalEpochCount - 1, 1);

    // ─── Shard boundary guard ───
    // During shard transitions, the global epoch may fall outside the new shard's
    // data range. If so, return the cached bar plot result from the previous frame
    // instead of computing from zeros (which causes bars to drop to 0).
    const rawLocalEpoch = Math.floor(globalEpoch - shardEpochStart);
    if (rawLocalEpoch < 0 || rawLocalEpoch >= shardEpochCount) {
      if (this._barPlotCache?.result) {
        return this._barPlotCache.result;
      }
      // No cache — clamp to nearest valid epoch
    }
    const localEpochCurrent = Math.max(0, Math.min(rawLocalEpoch, shardEpochCount - 1));

    // Compute epoch range — snap to hour boundaries so the chart shows the
    // full hour sum, not a trailing accumulation. At any point during hour N,
    // all 60 epochs of that hour are summed.
    const epochIntervalSec = data.epochInterval || 60;
    const epochsPerMinute = 60 / epochIntervalSec;
    const windowEpochs = Math.max(1, Math.round(timeWindow * epochsPerMinute));
    const hourIndex = Math.floor(localEpochCurrent / windowEpochs);
    const epochStart = hourIndex * windowEpochs;
    const epochEnd = Math.min(epochStart + windowEpochs - 1, shardEpochCount - 1);

    // ─── Second guard: if the epoch window has no valid data, keep previous result ───
    // This handles the case where the shard just started and only has partial data
    if (epochStart >= shardEpochCount) {
      if (this._barPlotCache?.result) {
        return this._barPlotCache.result;
      }
    }

    // Pre-allocated aggregation: reuse typed arrays sized to dictionary length
    const catCount = dictionary.length;
    if (!this._barSums || this._barSums.length < catCount) {
      this._barSums = new Float64Array(catCount);
      this._barCounts = new Uint32Array(catCount);
    }
    const sums = this._barSums;
    const counts = this._barCounts;
    sums.fill(0);
    counts.fill(0);

    // Build entity-index-based filter (handles categorical on static cols, e.g. airline = Delta)
    const entityPred = this._buildEntityFilter(layer, data);
    // Build value-level filter (e.g. revenue_usd > 25)
    const valuePred = this._parseSimpleFilter(layer.activeFilter);

    // Sum across all epochs in the time window
    for (let epoch = epochStart; epoch <= epochEnd; epoch++) {
      const offset = epoch * cellCount;
      for (let i = 0; i < featureCount; i++) {
        // Entity-level filter (categorical)
        if (entityPred && !entityPred(i)) continue;

        const catIdx = groupCol[i];
        const val = attrData[offset + i] || 0;

        // filterMode=entity: apply numeric filter per entity before aggregation
        if (filterMode === 'entity' && valuePred && !valuePred(val)) continue;

        sums[catIdx] += val;
        counts[catIdx]++;
      }
    }

    // Build result — only categories with count > 0
    const categories = [];
    const values = [];
    for (let c = 0; c < catCount; c++) {
      if (counts[c] === 0) continue;
      let aggVal;
      switch (aggregation) {
        case 'avg':
          aggVal = sums[c] / counts[c];
          break;
        case 'count':
          aggVal = counts[c];
          break;
        case 'sum':
        default:
          aggVal = sums[c];
          break;
      }
      // filterMode=aggregate: apply numeric filter post-aggregation (BI-style)
      if (filterMode === 'aggregate' && valuePred && !valuePred(aggVal)) continue;
      const label = dictionary.getString ? dictionary.getString(c) : dictionary[c];
      categories.push(label || `Category ${c}`);
      values.push(aggVal);
    }

    // Sort descending by value and take topN if specified
    const indices = Array.from({ length: categories.length }, (_, i) => i);
    indices.sort((a, b) => values[b] - values[a]);
    const limit = topN > 0 ? Math.min(topN, indices.length) : indices.length;
    const sortedCats = [];
    const sortedVals = [];
    for (let i = 0; i < limit; i++) {
      sortedCats.push(categories[indices[i]]);
      sortedVals.push(values[indices[i]]);
    }

    let maxVal = 0;
    for (let i = 0; i < sortedVals.length; i++) {
      if (sortedVals[i] > maxVal) maxVal = sortedVals[i];
    }
    if (maxVal === 0) maxVal = 1;
    const result = { categories: sortedCats, values: sortedVals, dataRange: [0, maxVal * 1.1] };
    this._barPlotCache = { key: cacheKey, result };
    return result;
  }
  // ─────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────

  /**
   * Get the real temporal column data from an H3F or GFB layer.
   * Returns { attrData: Float32Array, cellCount, epochCount } or empty.
   */
  _getTemporalData(layer, attribute) {
    const renderer = layer.renderer;
    if (!renderer || !renderer.data) return {};

    const data = renderer.data;
    const cellCount =
      data.cellCount || data.featureCount || renderer.cellCount || renderer.featureCount || 0;
    const globalEpochCount = data.epochCount || renderer.epochCount || 0;
    if (cellCount === 0 || globalEpochCount === 0) return {};

    // Shard-local epoch info: the temporal column only has shard-local data
    const shardEpochStart = data._shardEpochStart || 0;
    const shardEpochCount = data._shardEpochCount || globalEpochCount;

    // Use the renderer's active attribute if none specified
    const attr = attribute || renderer.activeAttribute || renderer._colorAttr || '';

    // Try temporal columns first
    let attrData = data.temporalColumns?.[attr];
    if (attrData && attrData.length >= cellCount) {
      return {
        attrData,
        cellCount,
        epochCount: globalEpochCount,
        shardEpochStart,
        shardEpochCount,
      };
    }

    // Combined shard lookup: the sharded loader may have decoded ALL columns
    // into the shard Map but only populated temporalColumns for the active metric.
    // Charts referencing a non-active metric (e.g. served_mbps_per_km2 while
    // served_mbps is active) need to pull the data from the shard Map directly.
    if (!attrData && layer.shardedLoader?._shards) {
      const activeShard = layer.shardedLoader._shards.get(layer.shardedLoader._activeShardIdx);
      if (activeShard instanceof Map && activeShard.has(attr)) {
        const shardData = activeShard.get(attr);
        // Promote into temporalColumns so subsequent frames hit the fast path
        if (!data.temporalColumns) data.temporalColumns = {};
        data.temporalColumns[attr] = shardData;
        return {
          attrData: shardData,
          cellCount,
          epochCount: globalEpochCount,
          shardEpochStart,
          shardEpochCount,
        };
      }
      // Column not in shard Map — trigger lazy on-demand fetch.
      // Returns empty this frame; loadColumn() populates temporalColumns
      // so next frame hits the fast path above.
      if (layer.shardedLoader.loadColumn && !activeShard?.has(attr)) {
        console.debug(`[ChartDataAdapter] Triggering lazy load for "${attr}"`);
        layer.shardedLoader.loadColumn(attr); // fire-and-forget async
        return {}; // Return empty — do NOT fall through to the wrong column
      }
    }

    // Try static columns (single epoch)
    attrData = data.staticColumns?.[attr];
    if (attrData) {
      return { attrData, cellCount, epochCount: 1, shardEpochStart: 0, shardEpochCount: 1 };
    }

    // Fallback: only use first available temporal column when NO specific
    // attribute was requested.  Previously this returned the wrong column
    // when a chart explicitly asked for a non-loaded attribute.
    if (!attribute && data.temporalColumns) {
      for (const [name, col] of Object.entries(data.temporalColumns)) {
        if (col && col.length >= cellCount) {
          return {
            attrData: col,
            cellCount,
            epochCount: globalEpochCount,
            shardEpochStart,
            shardEpochCount,
          };
        }
      }
    }

    return {};
  }

  _findLayer(name) {
    const layers = this.layerManager.layers;
    if (!layers) return null;

    // Exact match
    const layer = layers.get(name);
    if (layer) return layer;

    // Case-insensitive match
    const nameLower = name.toLowerCase();
    for (const [key, val] of layers) {
      if (key.toLowerCase() === nameLower) return val;
    }

    // Fallback: first available layer with a renderer
    for (const [key, val] of layers) {
      if (val.renderer?.data) {
        return val;
      }
    }

    return null;
  }

  _getShardKey(layer) {
    const loader = layer.loader;
    if (!loader) return '';
    return `${loader._currentShardIdx || 0}_${loader._loadedShardCount || 0}`;
  }

  /**
   * Parse a simple filter query into a predicate function.
   */
  _parseSimpleFilter(queryString) {
    if (!queryString || !queryString.trim()) return null;

    const q = queryString.trim();

    const betweenMatch = q.match(/\w+\s+BETWEEN\s+([\d.]+)\s+AND\s+([\d.]+)/i);
    if (betweenMatch) {
      const lo = parseFloat(betweenMatch[1]);
      const hi = parseFloat(betweenMatch[2]);
      return (val) => val >= lo && val <= hi;
    }

    const cmpMatch = q.match(/\w+\s*(>=|<=|>|<|=)\s*([\d.]+)/);
    if (cmpMatch) {
      const op = cmpMatch[1];
      const threshold = parseFloat(cmpMatch[2]);
      switch (op) {
        case '>':
          return (val) => val > threshold;
        case '<':
          return (val) => val < threshold;
        case '>=':
          return (val) => val >= threshold;
        case '<=':
          return (val) => val <= threshold;
        case '=':
          return (val) => Math.abs(val - threshold) < 0.001;
      }
    }

    return null;
  }

  /**
   * Extract numeric range bounds from a filter query string.
   * Returns [min, max] where either may be -Infinity/+Infinity if unbounded.
   * Returns null if the filter doesn't constrain a numeric range.
   */
  _extractFilterRange(queryString) {
    if (!queryString || !queryString.trim()) return null;
    const q = queryString.trim();

    const betweenMatch = q.match(/\w+\s+BETWEEN\s+([\d.]+)\s+AND\s+([\d.]+)/i);
    if (betweenMatch) {
      return [parseFloat(betweenMatch[1]), parseFloat(betweenMatch[2])];
    }

    const cmpMatch = q.match(/\w+\s*(>=|<=|>|<|=)\s*([\d.]+)/);
    if (cmpMatch) {
      const op = cmpMatch[1];
      const val = parseFloat(cmpMatch[2]);
      switch (op) {
        case '>':
          return [val, Infinity];
        case '>=':
          return [val, Infinity];
        case '<':
          return [-Infinity, val];
        case '<=':
          return [-Infinity, val];
        case '=':
          return [val - 0.5, val + 0.5];
      }
    }
    return null;
  }

  /**
   * Build an entity-index-based filter for MFB/barplot data.
   * Handles categorical equality (dictionary lookup) and numeric comparisons.
   * @returns {Function|null} predicate (entityIndex) => boolean
   */
  _buildEntityFilter(layer, data) {
    const q = layer.activeFilter;
    if (!q || !q.trim()) return null;

    const staticCols = data.staticColumns || {};

    // Handle OR-separated clauses: "airline = Delta OR airline = United"
    const orClauses = q
      .split(/\s+OR\s+/i)
      .map((c) => c.trim())
      .filter(Boolean);
    if (orClauses.length > 1) {
      const subPreds = orClauses
        .map((clause) => this._buildSingleEntityPred(clause, staticCols, data))
        .filter((p) => p !== null);
      if (subPreds.length === 0) return null;
      return (idx) => subPreds.some((pred) => pred(idx));
    }

    return this._buildSingleEntityPred(q.trim(), staticCols, data);
  }

  /**
   * Parse a single filter clause into an entity-index predicate.
   */
  _buildSingleEntityPred(clause, staticCols, data) {
    // Categorical equality: "column = StringValue"
    const catMatch = clause.match(/^(\w+)\s*=\s*(.+)$/);
    if (catMatch) {
      const colName = catMatch[1];
      const matchVal = catMatch[2].trim();

      const col = staticCols[colName];
      if (col) {
        // Dictionary lookup (case-insensitive)
        const dictionary = data.dictionaries?.[colName] || data.dictionary || [];
        const dictIdx = dictionary.findIndex(
          (d) => d && d.toLowerCase() === matchVal.toLowerCase()
        );
        if (dictIdx < 0) return () => false;
        return (idx) => col[idx] === dictIdx;
      }
    }

    // Numeric comparison: "column > 25"
    const numMatch = clause.match(/^(\w+)\s*(>=|<=|>|<)\s*([\d.]+)$/);
    if (numMatch) {
      const colName = numMatch[1];
      const op = numMatch[2];
      const threshold = parseFloat(numMatch[3]);
      const col = staticCols[colName];
      if (col) {
        switch (op) {
          case '>':
            return (idx) => col[idx] > threshold;
          case '>=':
            return (idx) => col[idx] >= threshold;
          case '<':
            return (idx) => col[idx] < threshold;
          case '<=':
            return (idx) => col[idx] <= threshold;
        }
      }
    }

    return null;
  }

  dispose() {
    this._cache.clear();
    this._lastShardKey.clear();
  }
}
