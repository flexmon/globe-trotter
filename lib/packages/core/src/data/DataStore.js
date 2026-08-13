/**
 * DataStore — Shared data layer for GPU renderers.
 *
 * Architecture:
 *   Binary H3F → decodeH3Flex() → DataStore.ingestH3F()
 *     → GPU data object (typed arrays from decoded format)
 *
 * The GPU renderer consumes typed arrays directly from the decoder output.
 * For browser-side SQL, see the standalone FlexQL tool (tools/flex-query-engine/).
 */

export class DataStore {
  constructor() {
    /** @type {Map<string, Object>} GPU-compatible data objects by table name */
    this._gpuData = new Map();
    /** @type {Map<string, Object>} Metadata (cellCount, dict, schema) per table */
    this._meta = new Map();
  }

  /**
   * Ingest decoded H3F data. Stores typed arrays for GPU rendering.
   *
   * @param {string} name - Table/layer name
   * @param {Object} h3fData - Decoded H3F from decodeH3Flex()
   * @param {Object} [globalBase] - Optional global base for cell ID resolution
   * @returns {Object} GPU-compatible data object (same interface as H3FlexDecoder output)
   */
  ingestH3F(name, h3fData, globalBase = null) {
    const dc = h3fData.dataCount || h3fData.cellCount;
    const dict = h3fData.dictionary || [];

    // Store metadata
    this._meta.set(name, {
      cellCount: h3fData.cellCount,
      dataCount: dc,
      epochCount: h3fData.epochCount || 0,
      dictionary: dict,
      schema: h3fData.schema,
      isRowLevel: h3fData.isRowLevel || false,
    });

    // GPU data object: same interface as decodeH3Flex() output
    const gpuData = {
      cellCount: h3fData.cellCount,
      cellIds: h3fData.cellIds,
      epochCount: h3fData.epochCount || 0,
      mesh: h3fData.mesh,
      dictionary: dict,
      embeddedStyle: h3fData.embeddedStyle,
      temporalAttributes: h3fData.temporalAttributes,
      staticColumns: h3fData.staticColumns,
      temporalColumns: h3fData.temporalColumns,
      isRowLevel: h3fData.isRowLevel || false,
      dataCount: dc,
      cellIndex: h3fData.cellIndex,
    };
    this._gpuData.set(name, gpuData);

    return gpuData;
  }

  /**
   * Get the GPU-compatible data object for a layer.
   * @param {string} name
   * @returns {Object|null} Same interface as decodeH3Flex() output
   */
  getGPUData(name) {
    return this._gpuData.get(name) || null;
  }

  /**
   * Ingest decoded GFB data. Stores data for GPU rendering.
   *
   * @param {string} name - Table/layer name
   * @param {Object} gfbData - Decoded GFB from decodeGFB()
   * @returns {Object} GPU-compatible data object
   */
  ingestGFB(name, gfbData) {
    const fc = gfbData.featureCount;
    const dict = gfbData.dictionary || [];

    this._meta.set(name, {
      format: 'gfb',
      featureCount: fc,
      dataCount: fc,
      dictionary: dict,
      schema: gfbData.schema,
    });

    this._gpuData.set(name, gfbData);
    return gfbData;
  }

  /**
   * Ingest decoded MFB data. Stores data for GPU rendering.
   *
   * @param {string} name - Table/layer name
   * @param {Object} mfbData - Decoded MFB from decodeMFB()
   * @returns {Object} MFB data object
   */
  ingestMFB(name, mfbData) {
    const ec = mfbData.entityCount;
    const dict = mfbData.dictionary || [];

    this._meta.set(name, {
      format: 'mfb',
      entityCount: ec,
      dataCount: ec,
      dictionary: dict,
      schema: mfbData.schema,
    });

    this._gpuData.set(name, mfbData);
    return mfbData;
  }

  /**
   * Inject a virtual static column from aggregation results.
   * Allows SQL results to drive GPU visualization.
   *
   * @param {string} layerName - Layer/table name
   * @param {string} columnName - Name for the virtual column
   * @param {Float32Array} values - Per-cell/feature values
   * @returns {{ columnName: string, domain: number[] }}
   */
  injectColumn(layerName, columnName, values) {
    const gpuData = this._gpuData.get(layerName);
    if (!gpuData) throw new Error(`[DataStore] No GPU data for '${layerName}'`);

    if (!gpuData.staticColumns) gpuData.staticColumns = {};
    gpuData.staticColumns[columnName] = values;

    // Compute domain (min/max of non-zero values)
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < values.length; i++) {
      if (values[i] !== 0) {
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
      }
    }
    if (!isFinite(min)) {
      min = 0;
      max = 1;
    }

    console.debug(
      `[DataStore] Injected '${columnName}' on '${layerName}': domain [${min.toFixed(2)}, ${max.toFixed(2)}]`
    );
    return { columnName, domain: [min, max] };
  }

  /**
   * Remove a virtual column.
   * @param {string} layerName
   * @param {string} columnName
   */
  removeColumn(layerName, columnName) {
    const gpuData = this._gpuData.get(layerName);
    if (gpuData?.staticColumns?.[columnName]) {
      delete gpuData.staticColumns[columnName];
      console.debug(`[DataStore] Removed column '${columnName}' from '${layerName}'`);
    }
  }

  /**
   * Get list of registered table names.
   * @returns {string[]}
   */
  getTableNames() {
    return [...this._gpuData.keys()];
  }

  /**
   * Get metadata for a table.
   * @param {string} name
   * @returns {Object|null}
   */
  getMetadata(name) {
    return this._meta.get(name) || null;
  }

  /**
   * Dispose all resources.
   */
  dispose() {
    this._gpuData.clear();
    this._meta.clear();
  }
}
