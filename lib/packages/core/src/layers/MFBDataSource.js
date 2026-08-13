/**
 * MFBDataSource.js — Non-rendering data source for MetricFlex Binary layers.
 *
 * Exposes the same `data` shape as H3F/GFB renderers so ChartDataAdapter
 * can read temporal and static columns without any code changes.
 * No GPU buffers, no shaders, no visual output.
 *
 * MFB is a pure tabular format (entity IDs + static/temporal columns).
 * It carries no drawable geometry — no coordinates, no triangles, no line
 * segments. Visual representation is handled by the chart layer, not the
 * map renderer, so MFB layers are simply not drawn by LayerManager.render().
 */
export class MFBDataSource {
  /**
   * @param {import('./MFBDecoder.js').decodeMFB} decoded — Output of decodeMFB()
   */
  constructor(decoded) {
    // Store the decoded object directly — ShardedMFBLoader updates it
    // in-place (_shardEpochStart, _shardEpochCount, temporalColumns),
    // and ChartDataAdapter reads from renderer.data. Using the same
    // object reference ensures all shard metadata propagates.
    this.data = decoded;

    // ChartDataAdapter checks both cellCount and featureCount
    // — alias entityCount to both names.
    if (!decoded.cellCount) decoded.cellCount = decoded.entityCount;
    if (!decoded.featureCount) decoded.featureCount = decoded.entityCount;
  }

  /**
   * Update the data source with new decoded MFB data (e.g., from streaming poll).
   * @param {Object} decoded — Output of decodeMFB()
   */
  update(decoded) {
    // Replace the data reference entirely (full re-decode)
    this.data = decoded;
    if (!decoded.cellCount) decoded.cellCount = decoded.entityCount;
    if (!decoded.featureCount) decoded.featureCount = decoded.entityCount;
  }

  dispose() {
    this.data = null;
  }
}
