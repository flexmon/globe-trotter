import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { gzipSync } from 'zlib';
import { encodeShardV3 } from './ShardV3Encoder.js';
import {
  FlexEncoderBase,
  TYPE_NAMES,
  TYPE_ENUM16,
  TYPE_ENUM32,
  TYPE_FLOAT32,
} from './FlexEncoderBase.js';

// Geometry types
const POINT = 1;
const LINE = 2;
const POLYGON = 3;

const GEOM_TYPES = { point: POINT, line: LINE, polygon: POLYGON };

export class GeoFlexEncoder extends FlexEncoderBase {
  /**
   * @param {Object} options
   * @param {number} options.featureCount
   * @param {number} options.epochCount
   * @param {number} options.epochInterval — Seconds between epochs
   * @param {'point'|'line'|'polygon'} [options.geometryType='point']
   * @param {boolean} [options.hasAltitude=true]
   * @param {number} [options.gzipLevel=1]
   */
  constructor(options = {}) {
    super(options);
    this.featureCount = options.featureCount;
    this.geometryType = GEOM_TYPES[options.geometryType || 'point'] || POINT;
    this.hasAltitude = options.hasAltitude !== false;

    this._positions = null; // Float32Array: epochCount × featureCount × floatsPerPos
    this._bbox = null; // { minLon, minLat, maxLon, maxLat }
    this._entityKey = null; // { name, data: Uint16Array of dict indices }
    this._entityIds = null; // Uint16Array of dictionary indices per feature
  }

  get _floatsPerPos() {
    return this.hasAltitude ? 3 : 2;
  }

  /**
   * Set temporal position data.
   * @param {Float32Array} positions — epoch-major: epochCount × featureCount × floatsPerPos
   * @param {{ minLon: number, minLat: number, maxLon: number, maxLat: number }} [bbox]
   */
  setPositions(positions, bbox) {
    this._positions = positions;
    if (bbox) {
      this._bbox = bbox;
    } else {
      // Auto-compute bbox from position data
      let minLon = 180,
        minLat = 90,
        maxLon = -180,
        maxLat = -90;
      const fpp = this._floatsPerPos;
      for (let i = 0; i < positions.length; i += fpp) {
        const lon = positions[i];
        const lat = positions[i + 1];
        if (lon !== 0 || lat !== 0) {
          minLon = Math.min(minLon, lon);
          minLat = Math.min(minLat, lat);
          maxLon = Math.max(maxLon, lon);
          maxLat = Math.max(maxLat, lat);
        }
      }
      this._bbox = { minLon, minLat, maxLon, maxLat };
    }
  }

  /**
   * Set entity key column. Entity IDs are dictionary-indexed u16/u8 values.
   * Matches Rust gfb_encoder.rs entity ID block.
   * @param {string} keyName — Entity key column name (e.g. 'macaddress')
   * @param {TypedArray} indices — Dictionary indices per feature
   */
  setEntityKey(keyName, indices) {
    this._entityKey = keyName;
    this._entityIds = indices;
  }

  /**
   * Full encode pipeline: Base Static Metadata File + Temporal Shards + Manifest JSON
   */
  async encode(options) {
    const t0 = performance.now();
    const {
      output,
      baseName = 'data',
      sharding = { epochsPerShard: 60 },
      manifest: extra = {},
    } = options;

    mkdirSync(output, { recursive: true });
    const SHARD_EPOCHS = sharding.epochsPerShard || 60;
    const shardCount = Math.ceil(this.epochCount / SHARD_EPOCHS);

    const posTypeCode =
      this._positions instanceof Float64Array ? 2 /* TYPE_FLOAT64 */ : 1; /* TYPE_FLOAT32 */
    const PosArrayType = this._positions instanceof Float64Array ? Float64Array : Float32Array;

    // --- Base file (SHD2) ---
    const baseColumns = [
      { name: 'longitude', data: null, typeCode: posTypeCode },
      { name: 'latitude', data: null, typeCode: posTypeCode },
    ];
    if (this.hasAltitude) baseColumns.push({ name: 'altitude', data: null, typeCode: posTypeCode });

    if (this._entityKey && this._entityIds) {
      const entCol = this._columns.find((c) => c.name === this._entityKey);
      const entType = entCol ? entCol.type : TYPE_ENUM32;
      const entDict = entCol ? entCol.dictionary : this._dictionary;
      baseColumns.push({
        name: this._entityKey,
        data: this._entityIds,
        typeCode: entType,
        dictionary: entDict,
      });
    }
    for (const col of this._columns) {
      if (this._entityKey && col.name === this._entityKey && !col.temporal) continue;
      if (col.data && !col.temporal) {
        baseColumns.push({
          name: col.name,
          data: col.data,
          typeCode: col.type,
          dictionary: col.type === TYPE_ENUM32 ? col.dictionary : undefined,
        });
      } else if (col.temporal) {
        // For temporal columns in the base file, we need to include them in the schema
        // but with a null data array, which will result in a 0-byte header length.
        baseColumns.push({
          name: col.name,
          data: null, // No data for temporal columns in base file
          typeCode: col.type,
          dictionary:
            col.type === TYPE_ENUM16 || col.type === TYPE_ENUM32 ? col.dictionary : undefined,
        });
      }
    }
    const baseBuf = encodeShardV3(baseColumns, {
      epochCount: 0,
      entityCount: this.featureCount,
      gzipLevel: this.gzipLevel,
    });
    const compressedBase = gzipSync(baseBuf, { level: this.gzipLevel });
    const baseFileName = `${baseName}_base.gfb.gz`;
    writeFileSync(resolve(output, baseFileName), compressedBase);
    console.log(
      `  GeoFlexEncoder base: ${(baseBuf.length / 1e6).toFixed(1)} MB → ${(compressedBase.length / 1e6).toFixed(1)} MB gz`
    );

    // --- Temporal shards ---
    const fpp = this._floatsPerPos;
    const floatsPerEpoch = this.featureCount * fpp;
    const shardFiles = [];

    // ── SHD2 Temporal Shards ──
    let totalShardBytes = 0;

    for (let s = 0; s < shardCount; s++) {
      const epochStart = s * SHARD_EPOCHS;
      const epochEnd = Math.min(epochStart + SHARD_EPOCHS, this.epochCount);
      const shardEpochCount = epochEnd - epochStart;

      // 1. Position columns (lon, lat, [alt] — split from interleaved positions)
      const posFloats = shardEpochCount * floatsPerEpoch;
      const srcStart = epochStart * floatsPerEpoch;
      const posSlice = this._positions.subarray(srcStart, srcStart + posFloats);

      const lonData = new PosArrayType(shardEpochCount * this.featureCount);
      const latData = new PosArrayType(shardEpochCount * this.featureCount);
      let altData = null;
      if (this.hasAltitude) altData = new PosArrayType(shardEpochCount * this.featureCount);

      for (let i = 0; i < posSlice.length / fpp; i++) {
        lonData[i] = posSlice[i * fpp];
        latData[i] = posSlice[i * fpp + 1];
        if (this.hasAltitude) altData[i] = posSlice[i * fpp + 2];
      }

      const columns = [
        { name: 'longitude', data: lonData, typeCode: posTypeCode },
        { name: 'latitude', data: latData, typeCode: posTypeCode },
      ];
      if (this.hasAltitude) {
        columns.push({ name: 'altitude', data: altData, typeCode: posTypeCode });
      }

      // 2. Temporal attribute columns
      for (const tc of this._temporalColumns) {
        const srcOff = epochStart * this.featureCount;
        const count = shardEpochCount * this.featureCount;
        // Lookup matching type from schema
        const schemaDef = this._columns.find((c) => c.name === tc.name);
        columns.push({
          name: tc.name,
          data: tc.data.subarray(srcOff, srcOff + count),
          typeCode: schemaDef.type,
          dictionary: tc.dictionary || schemaDef.dictionary,
        });
      }

      const shardBuf = encodeShardV3(columns, {
        epochCount: shardEpochCount,
        entityCount: this.featureCount,
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
        epochCount: shardEpochCount,
      });
    }

    console.log(
      `  GFB Shards v3: ${shardCount} shards, ${(totalShardBytes / 1e6).toFixed(1)} MB total`
    );

    // --- Manifest ---
    const manifest = {
      format: 'gfb-sharded',
      shardFormat: 'v3',
      version: 3,
      base: baseFileName,
      featureCount: this.featureCount,
      epochCount: this.epochCount,
      epochInterval: this.epochInterval,
      columns: this._columns.map((c) => ({
        name: c.name,
        type: TYPE_NAMES[c.type] || 'float32',
        temporal: !!c.temporal,
      })),
      bbox: this._bbox,
      temporalAttributes: this._temporalColumns.map((c) => c.name),
      dictionary: this._dictionary.length > 0 ? this._dictionary : undefined,
      shards: shardFiles,
      ...extra,
    };

    const manifestPath = resolve(output, `${baseName}.manifest.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const stats = {
      featureCount: this.featureCount,
      epochCount: this.epochCount,
      shardCount,
      durationMs: performance.now() - t0,
    };
    console.log(
      `  GeoFlexEncoder: ${stats.featureCount.toLocaleString()} features, ${stats.epochCount} epochs, ${shardCount} shards in ${(stats.durationMs / 1000).toFixed(1)}s`
    );

    return { manifest, stats };
  }
}
