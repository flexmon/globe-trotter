import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { gzipSync } from 'zlib';
import { encodeShardV3 } from './ShardV3Encoder.js';
import { FlexEncoderBase, TYPE_UINT32, TYPE_ENUM32, TYPE_NAMES } from './FlexEncoderBase.js';

export class MetricFlexEncoder extends FlexEncoderBase {
  /**
   * @param {Object} options
   * @param {number} options.entityCount
   * @param {number} options.epochCount
   * @param {number} options.epochInterval
   * @param {number} [options.startTimestamp]
   * @param {number} [options.gzipLevel=1]
   */
  constructor(options = {}) {
    super(options);
    this.entityCount = options.entityCount;
  }

  /**
   * Set entity ID column.
   * @param {string} keyName — e.g. 'tail_id'
   * @param {Uint32Array} ids
   */
  setEntityIds(keyName, ids) {
    // Entity IDs are just a static column in v3
    this._columns.unshift({
      name: keyName,
      type: TYPE_UINT32,
      temporal: 0,
      data: ids,
      isEntityKey: true,
    });
  }

  /**
   * Encode columns into MFB v3 binary (delegates to SHD2).
   */
  _encodeV3(columns, rowCount) {
    const shdCols = columns.map((col) => {
      return {
        name: col.name,
        data: col.data,
        typeCode: col.type,
        dictionary: col.type === TYPE_ENUM32 ? col.dictionary : undefined,
      };
    });
    return encodeShardV3(shdCols, {
      epochCount: 0,
      entityCount: rowCount,
      gzipLevel: this.gzipLevel,
    });
  }

  /**
   * Encode the sharded MFB layout: base .mfb.gz + temporal shard .shard files.
   */
  async encode(options) {
    const t0 = performance.now();
    const { output, baseName = 'data', sharding = { epochsPerShard: 60 } } = options;
    mkdirSync(output, { recursive: true });

    const SHARD_EPOCHS = sharding.epochsPerShard || 60;
    const ec = this.entityCount;

    // 1. Base file — static columns only
    const staticCols = this._columns.filter((c) => !c.temporal);
    const baseBuf = this._encodeV3(staticCols, ec);
    const compressedBase = gzipSync(baseBuf, { level: this.gzipLevel });
    const baseFileName = `${baseName}_base.mfb.gz`;
    writeFileSync(resolve(output, baseFileName), compressedBase);
    console.log(
      `  Base: ${(baseBuf.length / 1e6).toFixed(2)} MB → ${(compressedBase.length / 1e6).toFixed(2)} MB gz`
    );

    // 2. Shard v3 temporal files
    const temporalCols = this._columns.filter((c) => c.temporal);
    const shardCount = Math.ceil(this.epochCount / SHARD_EPOCHS);
    const shardFiles = [];
    let totalShardBytes = 0;

    for (let s = 0; s < shardCount; s++) {
      const epochStart = s * SHARD_EPOCHS;
      const epochEnd = Math.min(epochStart + SHARD_EPOCHS, this.epochCount);
      const shardEpochs = epochEnd - epochStart;

      const extractTarget = this._temporalColumns.length > 0 ? this._temporalColumns : temporalCols;

      const columns = extractTarget.map((col) => {
        const sliceStart = epochStart * ec;
        const sliceEnd = epochEnd * ec;
        // Get the backing data directly (since temporalCols have data:null structurally in the schema array)
        const sourceData = col.data || this._columns.find((c) => c.name === col.name).data;
        const slice = sourceData.subarray(sliceStart, sliceEnd);

        // Lookup type from schema definition
        const schemaDef = this._columns.find((c) => c.name === col.name);

        return {
          name: col.name,
          data: slice,
          typeCode: schemaDef.type,
          dictionary: col.dictionary || schemaDef.dictionary,
        };
      });

      const shardBuf = encodeShardV3(columns, {
        epochCount: shardEpochs,
        entityCount: ec,
        gzipLevel: this.gzipLevel,
      });

      const padS = String(epochStart).padStart(4, '0');
      const padE = String(epochEnd - 1).padStart(4, '0');
      const shardName = `${baseName}_e${padS}-e${padE}.shard`;

      writeFileSync(resolve(output, shardName), shardBuf);
      totalShardBytes += shardBuf.length;

      shardFiles.push({
        epochs: [epochStart, epochEnd - 1],
        file: shardName,
        epochCount: shardEpochs,
      });
    }

    console.log(
      `  Shards v3: ${shardCount} shards, ${temporalCols.length} cols/shard, ${(totalShardBytes / 1e6).toFixed(1)} MB total`
    );

    // 3. Manifest
    const manifest = {
      format: 'mfb-v3-sharded',
      shardFormat: 'v3',
      version: 3,
      entityCount: this.entityCount,
      epochCount: this.epochCount,
      epochInterval: this.epochInterval,
      startTimestamp: this.startTimestamp,
      columns: this._columns.map((c) => ({
        name: c.name,
        type: TYPE_NAMES[c.type] || 'float32',
        temporal: !!c.temporal,
      })),
      base: baseFileName,
      shards: shardFiles,
    };

    writeFileSync(resolve(output, `${baseName}.manifest.json`), JSON.stringify(manifest, null, 2));

    const stats = {
      entityCount: this.entityCount,
      epochCount: this.epochCount,
      shardCount,
      baseBytes: compressedBase.length,
      totalShardBytes,
      durationMs: performance.now() - t0,
    };

    console.log(
      `  MetricFlexEncoder v3 (shard-v3): ${stats.entityCount.toLocaleString()} entities, ${stats.epochCount} epochs, ${shardCount} shards in ${(stats.durationMs / 1000).toFixed(1)}s`
    );

    return { manifest, stats };
  }
}
