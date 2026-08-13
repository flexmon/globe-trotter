import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { gzipSync } from 'zlib';
import { encodeShardV3 } from './ShardV3Encoder.js';
import { FlexEncoderBase, TYPE_NAMES, TYPE_UINT64, TYPE_UINT32 } from './FlexEncoderBase.js';

const DEG2RAD = Math.PI / 180;

export class H3FlexEncoder extends FlexEncoderBase {
  /**
   * @param {Object} options
   * @param {number} options.epochInterval - Seconds between epochs
   * @param {number} [options.epochCount] - Number of epochs
   * @param {number} [options.gzipLevel=1] - Compression level (1=fast, 9=best)
   */
  constructor(options = {}) {
    super(options);

    this._cellIds = null; // string[] — H3 cell IDs (hex)
    this._cellCenters = null; // Float64Array — [lat, lon] per cell
    this._cellCount = 0;

    this._styleSpec = null;

    // Custom overriding `_temporalData` for backwards compat with legacy APIs in scripts
    this._temporalDataMaps = {}; // { columnName: Float32Array(epochCount * cellCount) }

    // Row-level mode
    this._isRowLevel = false;
    this._rowCount = 0;
    this._cellIndex = null; // Uint32Array — maps row → unique cell index
  }

  /**
   * Set the H3 cells to encode.
   * @param {string[]} cellIds — H3 cell IDs (hex strings)
   * @param {Array<[number,number]>} cellCenters — [lat, lon] per cell
   */
  setCells(cellIds, cellCenters) {
    this._cellIds = cellIds;
    this._cellCount = cellIds.length;
    if (Array.isArray(cellCenters) && cellCenters[0]?.length === 2) {
      // Convert array-of-arrays to flat Float64Array
      this._cellCenters = new Float64Array(cellIds.length * 2);
      for (let i = 0; i < cellIds.length; i++) {
        this._cellCenters[i * 2] = cellCenters[i][0];
        this._cellCenters[i * 2 + 1] = cellCenters[i][1];
      }
    } else {
      this._cellCenters = cellCenters; // assume Float64Array
    }
  }

  /**
   * Set temporal data for a metric column. Overridden to handle cell counts.
   * @param {string} name — Column name
   * @param {TypedArray} data — Flat array: epochCount × cellCount (epoch-major)
   * @param {number|Object} [options] — Number of epochs or options object
   */
  setTemporalData(name, data, options) {
    let epCount = typeof options === 'object' ? options.epochCount : options;
    epCount = epCount || this.epochCount;

    if (!epCount && this._cellCount > 0) {
      if (Array.isArray(data)) {
        throw new Error('H3FlexEncoder: must provide epochCount when passing sharded data array');
      }
      epCount = data.length / this._cellCount;
    }

    this._temporalDataMaps[name] = data;
    const superOpts = typeof options === 'object' ? { ...options, epochCount: epCount } : epCount;
    super.setTemporalData(name, data, superOpts);
  }

  /**
   * Set embedded style spec.
   */
  setStyle(styleSpec) {
    this._styleSpec = styleSpec;
  }

  /**
   * Enable row-level mode: multiple data rows per cell.
   */
  setRowLevelData(cellIndex, rowCount) {
    this._isRowLevel = true;
    this._rowCount = rowCount;
    this._cellIndex = cellIndex;
  }

  get dataCount() {
    return this._isRowLevel ? this._rowCount : this._cellCount;
  }

  /**
   * Build a GPU-ready 3D mesh with top + side faces for extrusion.
   */
  buildMesh(cellToBoundary, globeRadius = 1.0) {
    const cellCount = this._cellCount;
    const MAX_BOUNDARY = 10;

    const maxVerts = cellCount * (2 * MAX_BOUNDARY + 1);
    const maxTris = cellCount * 3 * MAX_BOUNDARY;

    const positions = new Float32Array(maxVerts * 3);
    const cellIndices = new Float32Array(maxVerts);
    const extrudeFlags = new Float32Array(maxVerts);
    const indices = new Uint32Array(maxTris * 3);

    let vOff = 0,
      iOff = 0;

    for (let c = 0; c < cellCount; c++) {
      const cellId = this._cellIds[c];
      const boundary = cellToBoundary(cellId);
      const numVerts = boundary.length;
      const cLat = this._cellCenters[c * 2];
      const cLon = this._cellCenters[c * 2 + 1];

      const centroidIdx = vOff;
      _latLonTo3D(cLat, cLon, globeRadius, positions, vOff * 3);
      cellIndices[vOff] = c;
      extrudeFlags[vOff] = 1.0;
      vOff++;

      const firstTopIdx = vOff;
      for (let v = 0; v < numVerts; v++) {
        const [bLat, bLon] = boundary[v];
        _latLonTo3D(bLat, bLon, globeRadius, positions, vOff * 3);
        cellIndices[vOff] = c;
        extrudeFlags[vOff] = 1.0;
        vOff++;
      }

      const firstBaseIdx = vOff;
      for (let v = 0; v < numVerts; v++) {
        const [bLat, bLon] = boundary[v];
        _latLonTo3D(bLat, bLon, globeRadius, positions, vOff * 3);
        cellIndices[vOff] = c;
        extrudeFlags[vOff] = 0.0;
        vOff++;
      }

      for (let v = 0; v < numVerts; v++) {
        const next = (v + 1) % numVerts;
        indices[iOff++] = centroidIdx;
        indices[iOff++] = firstTopIdx + v;
        indices[iOff++] = firstTopIdx + next;
      }

      for (let v = 0; v < numVerts; v++) {
        const next = (v + 1) % numVerts;
        indices[iOff++] = firstBaseIdx + v;
        indices[iOff++] = firstBaseIdx + next;
        indices[iOff++] = firstTopIdx + next;
        indices[iOff++] = firstBaseIdx + v;
        indices[iOff++] = firstTopIdx + next;
        indices[iOff++] = firstTopIdx + v;
      }

      if (c > 0 && c % 100000 === 0) {
        console.log(
          `  H3FlexEncoder: ${c.toLocaleString()} / ${cellCount.toLocaleString()} cells meshed`
        );
      }
    }

    return {
      positions: positions.subarray(0, vOff * 3),
      cellIndices: cellIndices.subarray(0, vOff),
      extrudeFlags: extrudeFlags.subarray(0, vOff),
      indices: indices.subarray(0, iOff),
      vertCount: vOff,
      idxCount: iOff,
    };
  }

  encodeBase(mesh) {
    const cc = this._cellCount;
    const dc = this.dataCount; // rowCount if row-level, else cellCount

    const baseColumns = [];

    // 1. Cell IDs (BigUint64Array)
    const cellIdData = new BigUint64Array(cc);
    for (let i = 0; i < cc; i++) {
      cellIdData[i] = BigInt('0x' + this._cellIds[i]);
    }
    baseColumns.push({
      name: 'h3_cell_id',
      data: cellIdData,
      typeCode: TYPE_UINT64,
    });

    // 2. Cell Index (Row level mode)
    if (this._isRowLevel && this._cellIndex) {
      baseColumns.push({
        name: '_cell_index',
        data: this._cellIndex,
        typeCode: TYPE_UINT32,
      });
    }

    for (const col of this._columns) {
      if (!col.temporal && col.data) {
        const isDict = col.type === 0x0e; // Enum32
        baseColumns.push({
          name: col.name,
          data: col.data,
          typeCode: col.type,
          dictionary: isDict ? col.dictionary : undefined,
        });
      }
    }

    return encodeShardV3(baseColumns, {
      epochCount: 0,
      entityCount: dc,
      gzipLevel: this.gzipLevel,
    });
  }

  encodeMesh(mesh) {
    const headerSize = 16;
    const totalBytes =
      headerSize +
      mesh.positions.byteLength +
      mesh.cellIndices.byteLength +
      mesh.extrudeFlags.byteLength +
      mesh.indices.byteLength;

    const buf = Buffer.alloc(totalBytes);
    let pos = 0;

    buf.write('H3M1', 0);
    pos += 4;
    buf.writeUInt32LE(mesh.vertCount, pos);
    pos += 4;
    buf.writeUInt32LE(mesh.idxCount, pos);
    pos += 4;
    buf.writeUInt32LE(this._cellCount, pos);
    pos += 4;

    Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength).copy(
      buf,
      pos
    );
    pos += mesh.positions.byteLength;
    Buffer.from(
      mesh.cellIndices.buffer,
      mesh.cellIndices.byteOffset,
      mesh.cellIndices.byteLength
    ).copy(buf, pos);
    pos += mesh.cellIndices.byteLength;
    Buffer.from(
      mesh.extrudeFlags.buffer,
      mesh.extrudeFlags.byteOffset,
      mesh.extrudeFlags.byteLength
    ).copy(buf, pos);
    pos += mesh.extrudeFlags.byteLength;
    Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength).copy(
      buf,
      pos
    );
    pos += mesh.indices.byteLength;

    return buf.subarray(0, pos);
  }

  /**
   * Full encode pipeline: base + [shards] + manifest.
   */
  async encode(options) {
    const t0 = performance.now();
    const {
      output,
      sharding = { epochsPerShard: 60 },
      baseName = 'data',
      manifest: extraManifest = {},
      meshDir,
      meshLevel,
    } = options;

    mkdirSync(output, { recursive: true });
    const SHARD_EPOCHS = sharding.epochsPerShard || 60;

    // ─── Shared mesh logic ───
    let mesh = options.mesh || null;
    let meshFileName = null;
    let meshRelativePath = null;

    if (meshDir) {
      mkdirSync(meshDir, { recursive: true });
      const level = meshLevel || 5;
      const sharedMeshFile = `h3-l${level}-global.mesh.h3f.gz`;
      const sharedMeshPath = resolve(meshDir, sharedMeshFile);

      if (existsSync(sharedMeshPath)) {
        console.log(`  Shared mesh exists: ${sharedMeshPath} — skipping mesh generation`);
        mesh = { _shared: true };
        meshRelativePath = relative(output, meshDir) + '/' + sharedMeshFile;
      } else {
        console.log(`  Generating shared mesh: ${sharedMeshPath}`);
        if (!mesh && options.cellToBoundary) {
          mesh = this.buildMesh(options.cellToBoundary);
        }
        if (mesh && !mesh._shared) {
          const meshBuf = this.encodeMesh(mesh);
          const compressedMesh = gzipSync(meshBuf, { level: this.gzipLevel });
          writeFileSync(sharedMeshPath, compressedMesh);
          console.log(
            `  Mesh: ${(meshBuf.length / 1e6).toFixed(1)} MB → ${(compressedMesh.length / 1e6).toFixed(1)} MB gz`
          );
          meshRelativePath = relative(output, meshDir) + '/' + sharedMeshFile;
        }
      }
    } else {
      if (!mesh && options.cellToBoundary) {
        mesh = this.buildMesh(options.cellToBoundary);
      }
    }

    const baseBuf = this.encodeBase(mesh);
    const compressedBase = gzipSync(baseBuf, { level: this.gzipLevel });
    const baseFileName = `${baseName}_base.h3f.gz`;
    writeFileSync(resolve(output, baseFileName), compressedBase);
    console.log(
      `  Base: ${(baseBuf.length / 1e6).toFixed(1)} MB → ${(compressedBase.length / 1e6).toFixed(1)} MB gz`
    );

    if (!meshDir && mesh && !mesh._shared) {
      const meshBuf = this.encodeMesh(mesh);
      const compressedMesh = gzipSync(meshBuf, { level: this.gzipLevel });
      meshFileName = `${baseName}_mesh.h3f.gz`;
      writeFileSync(resolve(output, meshFileName), compressedMesh);
      console.log(
        `  Mesh: ${(meshBuf.length / 1e6).toFixed(1)} MB → ${(compressedMesh.length / 1e6).toFixed(1)} MB gz`
      );
    }

    const temporalMetrics = Object.keys(this._temporalDataMaps);
    const shardCount = Math.ceil(this.epochCount / SHARD_EPOCHS);

    // ── SHD2 Temporal Shards ──
    const shardFiles = [];
    let totalShardBytes = 0;

    const hasExternalShards =
      temporalMetrics.length > 0 &&
      temporalMetrics.every(
        (name) =>
          Array.isArray(this._temporalDataMaps[name]) && this._temporalDataMaps[name].length === 0
      );

    if (temporalMetrics.length > 0 && !hasExternalShards) {
      const cc = this._cellCount;
      const h3CellIdData = new BigUint64Array(cc);
      for (let i = 0; i < cc; i++) {
        h3CellIdData[i] = BigInt('0x' + this._cellIds[i]);
      }

      for (let s = 0; s < shardCount; s++) {
        const epochStart = s * SHARD_EPOCHS;
        const epochEnd = Math.min(epochStart + SHARD_EPOCHS, this.epochCount);
        const shardEpochs = epochEnd - epochStart;

        const colsExtract = this._temporalColumns.filter((c) => temporalMetrics.includes(c.name));

        const columns = colsExtract.map((tc) => {
          const data = tc.data;
          const sliceStart = epochStart * cc;
          const sliceEnd = epochEnd * cc;
          const slice = Array.isArray(data) ? data[s] : data.subarray(sliceStart, sliceEnd);

          const schemaDef = this._columns.find((c) => c.name === tc.name);

          return {
            name: tc.name,
            data: slice,
            typeCode: schemaDef.type,
            dictionary: tc.dictionary || schemaDef.dictionary,
          };
        });

        columns.unshift({
          name: 'h3_cell_id',
          data: h3CellIdData,
          typeCode: TYPE_UINT64,
        });

        const shardBuf = encodeShardV3(columns, {
          epochCount: shardEpochs,
          entityCount: cc,
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
        `  Shards v3: ${shardCount} shards, ${temporalMetrics.length} cols/shard, ${(totalShardBytes / 1e6).toFixed(1)} MB total`
      );
    }

    const meshRef = meshRelativePath || meshFileName || null;
    let manifestObj;

    if (temporalMetrics.length === 0) {
      manifestObj = {
        format: 'h3flex-static',
        version: 3,
        cellCount: this._cellCount,
        ...(this._isRowLevel ? { rowCount: this._rowCount, isRowLevel: true } : {}),
        epochCount: 0,
        epochInterval: this.epochInterval,
        columns: this._columns.map((c) => ({
          name: c.name,
          type: TYPE_NAMES[c.type] || 'float32',
          temporal: !!c.temporal,
        })),
        base: baseFileName,
        ...(meshRef ? { mesh: meshRef } : {}),
        ...extraManifest,
      };
    } else {
      manifestObj = {
        format: 'h3flex-sharded',
        shardFormat: 'v3',
        version: 3,
        cellCount: this._cellCount,
        ...(this._isRowLevel ? { rowCount: this._rowCount } : {}),
        epochCount: this.epochCount,
        epochInterval: this.epochInterval,
        columns: this._columns.map((c) => ({
          name: c.name,
          type: TYPE_NAMES[c.type] || 'float32',
          temporal: !!c.temporal,
        })),
        base: baseFileName,
        ...(meshRef ? { mesh: meshRef } : {}),
        activeMetric: temporalMetrics[0],
        temporalAttributes: temporalMetrics.map((name) => ({ name })),
        shards: shardFiles,
        ...extraManifest,
      };
    }
    if (this._styleSpec) {
      manifestObj.style = this._styleSpec;
    }

    writeFileSync(
      resolve(output, `${baseName}.manifest.json`),
      JSON.stringify(manifestObj, null, 2)
    );

    const stats = {
      cellCount: this._cellCount,
      ...(this._isRowLevel ? { rowCount: this._rowCount } : {}),
      epochCount: this.epochCount,
      shardCount: temporalMetrics.length > 0 ? shardCount : 0,
      vertCount: mesh?.vertCount || 0,
      triCount: mesh ? mesh.idxCount / 3 : 0,
      durationMs: performance.now() - t0,
    };

    return { manifest: manifestObj, stats };
  }
}

function _latLonTo3D(lat, lon, R, outBuffer, outOffset) {
  const theta = (90 - lat) * DEG2RAD;
  const phi = (lon + 180) * DEG2RAD;
  outBuffer[outOffset] = Math.sin(theta) * Math.sin(phi) * R;
  outBuffer[outOffset + 1] = Math.cos(theta) * R;
  outBuffer[outOffset + 2] = Math.sin(theta) * Math.cos(phi) * R;
}
