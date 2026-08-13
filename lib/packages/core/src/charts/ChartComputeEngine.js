/**
 * ChartComputeEngine.js — GPU compute pipeline for chart data.
 *
 * Runs histogram, min/max, CDF, and boxplot computations entirely on the GPU.
 * All chart types read from a shared epoch storage buffer (uploaded ONCE per
 * epoch change). Results are read back via mapAsync — never blocks frames.
 *
 * Architecture:
 *   epochChange(attrData, cellCount, epoch)
 *       → upload epoch slice to _epochBuf (104KB for 26K cells)
 *       → dispatch all pending chart computations
 *       → mapAsync readback (async, ~1-2ms latency)
 *       → resolve promises with tiny results (bins, stats)
 */

import chartWGSL from './shaders/chart_compute.wgsl?raw';

const MAX_BINS = 256;

export class ChartComputeEngine {
  /**
   * @param {GPUDevice} device
   * @param {number} maxCells — maximum cellCount across all shards
   */
  constructor(device, maxCells) {
    this.device = device;
    this.maxCells = maxCells;
    this._pending = false;
    this._currentEpoch = -1;

    this._initPipelines(device, maxCells);
  }

  _initPipelines(device, maxCells) {
    const shaderModule = device.createShaderModule({
      label: 'Chart compute shader',
      code: chartWGSL,
    });

    // ─── Shared bind group layout ───
    // binding 0: uniform params
    // binding 1: epoch data (read-only storage)
    // binding 2: output (read-write storage, atomic)
    this._bgl = device.createBindGroupLayout({
      label: 'Chart compute BGL',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this._bgl],
    });

    // ─── Pipelines ───
    this._histogramPipeline = device.createComputePipeline({
      label: 'Chart histogram',
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: 'histogramMain' },
    });

    this._minMaxPipeline = device.createComputePipeline({
      label: 'Chart min/max',
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: 'minMaxMain' },
    });

    // ─── Shared epoch data buffer ───
    // Sized for maxCells floats — reused every epoch
    this._epochBuf = device.createBuffer({
      label: 'Chart epoch data',
      size: maxCells * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // ─── Uniform params buffer (32 bytes) ───
    this._uniformBuf = device.createBuffer({
      label: 'Chart params',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // ─── Histogram output (256 bins × 4 bytes = 1KB) ───
    this._histOutputBuf = device.createBuffer({
      label: 'Chart histogram output',
      size: MAX_BINS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // ─── Min/max output (3 × u32 = min, max, count = 16 bytes aligned) ───
    this._minMaxOutputBuf = device.createBuffer({
      label: 'Chart min/max output',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // ─── Staging buffers for async readback ───
    this._histStagingBuf = device.createBuffer({
      label: 'Chart histogram staging',
      size: MAX_BINS * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    this._minMaxStagingBuf = device.createBuffer({
      label: 'Chart min/max staging',
      size: 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Pre-allocated param scratch
    this._paramsBuf = new ArrayBuffer(32);
    this._paramsU32 = new Uint32Array(this._paramsBuf);
    this._paramsF32 = new Float32Array(this._paramsBuf);
  }

  /**
   * Upload a single epoch to the shared GPU buffer.
   * Call this ONCE per epoch change — all chart computations read from it.
   *
   * @param {Float32Array} attrData — full temporal column
   * @param {number} cellCount — cells in this epoch
   * @param {number} localEpoch — shard-local epoch index
   */
  uploadEpoch(attrData, cellCount, localEpoch) {
    const start = localEpoch * cellCount;
    const slice = attrData.subarray(start, start + cellCount);
    this.device.queue.writeBuffer(this._epochBuf, 0, slice);
    this._cellCount = cellCount;
  }

  /**
   * Compute auto domain (min/max) + histogram bins on the GPU.
   * Returns a Promise that resolves with { counts, effectiveDomain }.
   *
   * @param {number} binCount
   * @param {number[]|null} domainHint — YAML domain floor (optional)
   * @returns {Promise<{ counts: Uint32Array, effectiveDomain: number[] } | null>}
   */
  async computeHistogram(binCount, domainHint = null) {
    if (this._pending) return null;
    this._pending = true;

    const device = this.device;
    const cellCount = this._cellCount;
    binCount = Math.min(binCount, MAX_BINS);

    try {
      // ─── Pass 1: Min/Max reduction ───
      const initMinMax = new Uint32Array([0x7f7fffff, 0, 0, 0]); // max float bits, 0, 0, pad
      device.queue.writeBuffer(this._minMaxOutputBuf, 0, initMinMax);

      this._paramsU32[0] = cellCount;
      this._paramsU32[1] = 0; // binCount unused for minmax
      this._paramsU32[2] = 0;
      this._paramsU32[3] = 0;
      this._paramsF32[4] = 0;
      this._paramsF32[5] = 0;
      this._paramsF32[6] = 0;
      this._paramsF32[7] = 0;
      device.queue.writeBuffer(this._uniformBuf, 0, this._paramsBuf);

      const minMaxBG = device.createBindGroup({
        layout: this._bgl,
        entries: [
          { binding: 0, resource: { buffer: this._uniformBuf } },
          { binding: 1, resource: { buffer: this._epochBuf } },
          { binding: 2, resource: { buffer: this._minMaxOutputBuf } },
        ],
      });

      const enc1 = device.createCommandEncoder({ label: 'Chart minMax' });
      const pass1 = enc1.beginComputePass();
      pass1.setPipeline(this._minMaxPipeline);
      pass1.setBindGroup(0, minMaxBG);
      pass1.dispatchWorkgroups(Math.ceil(cellCount / 256));
      pass1.end();
      enc1.copyBufferToBuffer(this._minMaxOutputBuf, 0, this._minMaxStagingBuf, 0, 12);
      device.queue.submit([enc1.finish()]);

      // Read back min/max
      await this._minMaxStagingBuf.mapAsync(GPUMapMode.READ, 0, 12);
      const mmData = new Uint32Array(this._minMaxStagingBuf.getMappedRange(0, 12).slice(0));
      this._minMaxStagingBuf.unmap();

      const dataMin = new Float32Array(mmData.buffer, 0, 1)[0];
      const dataMax = new Float32Array(mmData.buffer, 4, 1)[0];
      const count = mmData[2];

      if (count === 0 || dataMin >= dataMax) {
        this._pending = false;
        return null;
      }

      const effectiveDomain = [domainHint ? Math.max(domainHint[0], dataMin) : dataMin, dataMax];
      if (effectiveDomain[0] >= effectiveDomain[1]) effectiveDomain[1] = effectiveDomain[0] + 1;

      // ─── Pass 2: Histogram binning ───
      const clearBins = new Uint32Array(binCount);
      device.queue.writeBuffer(this._histOutputBuf, 0, clearBins);

      this._paramsU32[0] = cellCount;
      this._paramsU32[1] = binCount;
      this._paramsU32[2] = 0;
      this._paramsU32[3] = 0;
      this._paramsF32[4] = effectiveDomain[0];
      this._paramsF32[5] = effectiveDomain[1];
      this._paramsF32[6] = 0;
      this._paramsF32[7] = 0;
      device.queue.writeBuffer(this._uniformBuf, 0, this._paramsBuf);

      const histBG = device.createBindGroup({
        layout: this._bgl,
        entries: [
          { binding: 0, resource: { buffer: this._uniformBuf } },
          { binding: 1, resource: { buffer: this._epochBuf } },
          { binding: 2, resource: { buffer: this._histOutputBuf } },
        ],
      });

      const binBytes = binCount * 4;
      const enc2 = device.createCommandEncoder({ label: 'Chart histogram' });
      const pass2 = enc2.beginComputePass();
      pass2.setPipeline(this._histogramPipeline);
      pass2.setBindGroup(0, histBG);
      pass2.dispatchWorkgroups(Math.ceil(cellCount / 256));
      pass2.end();
      enc2.copyBufferToBuffer(this._histOutputBuf, 0, this._histStagingBuf, 0, binBytes);
      device.queue.submit([enc2.finish()]);

      // Read back histogram bins
      await this._histStagingBuf.mapAsync(GPUMapMode.READ, 0, binBytes);
      const counts = new Uint32Array(this._histStagingBuf.getMappedRange(0, binBytes).slice(0));
      this._histStagingBuf.unmap();

      this._pending = false;
      return { counts, effectiveDomain };
    } catch (err) {
      this._pending = false;
      console.warn('[ChartComputeEngine] histogram error:', err);
      return null;
    }
  }

  /**
   * Compute CDF: sort all non-zero values + return statistics.
   * CPU sort on the epoch slice (26K values = <1ms with typed array sort).
   *
   * Note: GPU bitonic sort is overkill for 26K values — CPU Float32Array.sort()
   * completes in <0.5ms. We only GPU-accelerate the heavy operations.
   *
   * @returns {{ sortedValues: Float32Array, count: number, mean: number, stdDev: number, median: number }}
   */
  computeCDFSync(attrData, cellCount, localEpoch, filterPred = null) {
    const start = localEpoch * cellCount;
    let sum = 0,
      count = 0;

    // Collect non-zero values (reuse scratch buffer)
    if (!this._cdfScratch || this._cdfScratch.length < cellCount) {
      this._cdfScratch = new Float32Array(cellCount);
    }
    for (let c = 0; c < cellCount; c++) {
      const val = attrData[start + c];
      if (val === 0 || val !== val) continue;
      if (filterPred && !filterPred(val)) continue;
      this._cdfScratch[count] = val;
      sum += val;
      count++;
    }
    if (count === 0) return null;

    const values = this._cdfScratch.subarray(0, count);
    values.sort(); // TypedArray.sort() — <0.5ms for 26K values

    const mean = sum / count;
    let variance = 0;
    for (let i = 0; i < count; i++) {
      const d = values[i] - mean;
      variance += d * d;
    }
    const stdDev = Math.sqrt(variance / count);
    const median = values[Math.floor(count / 2)];

    return { sortedValues: values, count, mean, stdDev, median };
  }

  /**
   * Compute boxplot stats from current epoch only.
   * Since we only use one epoch, the boxplot shows the distribution
   * of cell values at the current time.
   *
   * @returns {{ stats: object[], dataRange: number[] }}
   */
  computeBoxplotSync(attrData, cellCount, localEpoch, filterPred = null) {
    const start = localEpoch * cellCount;

    // Collect non-zero values
    if (!this._boxScratch || this._boxScratch.length < cellCount) {
      this._boxScratch = new Float32Array(cellCount);
    }
    let count = 0,
      sum = 0;
    for (let c = 0; c < cellCount; c++) {
      const val = attrData[start + c];
      if (val === 0 || val !== val) continue;
      if (filterPred && !filterPred(val)) continue;
      this._boxScratch[count] = val;
      sum += val;
      count++;
    }

    if (count === 0) {
      return {
        stats: [
          {
            p5: 0,
            q1: 0,
            median: 0,
            q3: 0,
            p95: 0,
            mean: 0,
            count: 0,
            min: 0,
            max: 0,
            whiskerLow: 0,
            whiskerHigh: 0,
          },
        ],
        dataRange: [0, 1],
      };
    }

    const values = this._boxScratch.subarray(0, count);
    values.sort(); // <0.5ms for 26K

    const n = count;
    const percentile = (p) => {
      const idx = (p / 100) * (n - 1);
      const lo = Math.floor(idx);
      const hi = Math.min(lo + 1, n - 1);
      const f = idx - lo;
      return values[lo] + (values[hi] - values[lo]) * f;
    };

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
      whiskerLow: percentile(5),
      whiskerHigh: percentile(95),
    };

    return {
      stats: [s], // Single bin (current epoch only)
      dataRange: [0, s.p95 * 1.1],
    };
  }

  /**
   * Compute barplot: group-by category aggregation for current epoch.
   * CPU path — dictionary lookups are inherently branchy.
   */
  computeBarplotSync(
    data,
    cellCount,
    localEpoch,
    groupBy,
    valueAttr,
    aggregation,
    topN = 0,
    filterPred = null
  ) {
    const valueData = data.temporalColumns?.[valueAttr] || data.staticColumns?.[valueAttr];
    const catCol = data.staticColumns?.[groupBy];
    const dict = data.dictionary;
    if (!valueData || !catCol || !dict) return null;

    const catDict = dict[groupBy];
    if (!catDict) return null;

    const start = localEpoch * cellCount;
    const groups = new Map();

    for (let c = 0; c < cellCount; c++) {
      const val = valueData[start + c];
      if (val === 0 || val !== val) continue;

      const catIdx = catCol[c];
      const catName = catDict[catIdx] || `Unknown(${catIdx})`;

      if (!groups.has(catName)) {
        groups.set(catName, { sum: 0, count: 0 });
      }
      const g = groups.get(catName);
      g.sum += val;
      g.count++;
    }

    // Sort by value descending
    let entries = [...groups.entries()].sort((a, b) => b[1].sum - a[1].sum);
    if (topN > 0) entries = entries.slice(0, topN);

    const categories = entries.map((e) => e[0]);
    const values = new Float32Array(entries.length);
    for (let i = 0; i < entries.length; i++) {
      const g = entries[i][1];
      values[i] =
        aggregation === 'avg'
          ? g.count > 0
            ? g.sum / g.count
            : 0
          : aggregation === 'count'
            ? g.count
            : g.sum;
    }

    const maxVal = values.length > 0 ? values[0] : 1;
    return {
      categories,
      values,
      dataRange: [0, maxVal * 1.1],
    };
  }

  destroy() {
    this._epochBuf?.destroy();
    this._uniformBuf?.destroy();
    this._histOutputBuf?.destroy();
    this._minMaxOutputBuf?.destroy();
    this._histStagingBuf?.destroy();
    this._minMaxStagingBuf?.destroy();
  }
}
