import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { gzipSync } from 'zlib';
import earcut from 'earcut';
import { encodeShardV3 } from './ShardV3Encoder.js';
import { FlexEncoderBase, TYPE_NAMES, TYPE_UINT64, TYPE_UINT32 } from './FlexEncoderBase.js';

const DEG2RAD = Math.PI / 180;

export class DGFlexEncoder extends FlexEncoderBase {
  constructor(options = {}) {
    super(options);

    this._features = null; // GeoJSON Features
    this._cellIds = null; // Array of feature properties.id
    this._cellCount = 0;

    this._styleSpec = null;
    this._temporalDataMaps = {};

    this._isRowLevel = false;
    this._rowCount = 0;
    this._cellIndex = null;
  }

  setFeatures(features) {
    this._features = features;
    this._cellCount = features.length;
    this._cellIds = new Float64Array(this._cellCount);
    for (let i = 0; i < this._cellCount; i++) {
      this._cellIds[i] = features[i].properties.id;
    }
  }

  setTemporalData(name, data, options) {
    let epCount = typeof options === 'object' ? options.epochCount : options;
    epCount = epCount || this.epochCount;

    if (!epCount && this._cellCount > 0) {
      epCount = data.length / this._cellCount;
    }

    this._temporalDataMaps[name] = data;
    const superOpts = typeof options === 'object' ? { ...options, epochCount: epCount } : epCount;
    super.setTemporalData(name, data, superOpts);
  }

  setStyle(styleSpec) {
    this._styleSpec = styleSpec;
  }

  setRowLevelData(cellIndex, rowCount) {
    this._isRowLevel = true;
    this._rowCount = rowCount;
    this._cellIndex = cellIndex;
  }

  get dataCount() {
    return this._isRowLevel ? this._rowCount : this._cellCount;
  }

  /**
   * Build a GPU-ready 3D mesh using earcut on GeoJSON Polygons/MultiPolygons.
   */
  buildMesh(globeRadius = 1.0) {
    // Pre-allocate large buffers, will subarray at the end
    const maxVerts = this._cellCount * 100;
    const maxTris = this._cellCount * 300;

    let positions = new Float32Array(maxVerts * 3);
    let cellIndices = new Float32Array(maxVerts);
    let extrudeFlags = new Float32Array(maxVerts);
    let indices = new Uint32Array(maxTris * 3);

    let vOff = 0,
      iOff = 0;

    const ensureVerts = (count) => {
      if (vOff + count > positions.length / 3) {
        const newPos = new Float32Array(positions.length * 2);
        newPos.set(positions);
        positions = newPos;

        const newCIdx = new Float32Array(cellIndices.length * 2);
        newCIdx.set(cellIndices);
        cellIndices = newCIdx;

        const newExt = new Float32Array(extrudeFlags.length * 2);
        newExt.set(extrudeFlags);
        extrudeFlags = newExt;
      }
    };

    const ensureIndices = (count) => {
      if (iOff + count > indices.length) {
        const newInd = new Uint32Array(indices.length * 2);
        newInd.set(indices);
        indices = newInd;
      }
    };

    for (let c = 0; c < this._cellCount; c++) {
      const feature = this._features[c];
      const geom = feature.geometry;
      if (!geom) continue;

      const polygons =
        geom.type === 'Polygon'
          ? [geom.coordinates]
          : geom.type === 'MultiPolygon'
            ? geom.coordinates
            : [];

      for (const polygon of polygons) {
        const exterior = polygon[0];
        const holes = polygon.slice(1);

        const numVerts = exterior.length - 1; // GeoJSON is closed (first=last)
        if (numVerts < 3) continue;

        ensureVerts(1 + numVerts * 2); // 1 centroid + 2 rings (base and top)
        ensureIndices(numVerts * 3 + numVerts * 6); // Top caps + Side walls

        // Calculate centroid approx
        let cLat = 0,
          cLon = 0;
        for (let v = 0; v < numVerts; v++) {
          cLon += exterior[v][0];
          cLat += exterior[v][1];
        }
        cLat /= numVerts;
        cLon /= numVerts;

        const centroidIdx = vOff;
        _latLonTo3D(cLat, cLon, globeRadius, positions, vOff * 3);
        cellIndices[vOff] = c;
        extrudeFlags[vOff] = 1.0;
        vOff++;

        // Flatten for earcut
        const flatData = [];
        const holeIndices = [];
        let pOff = 0;

        for (let v = 0; v < numVerts; v++) {
          flatData.push(exterior[v][0], exterior[v][1]);
        }
        pOff += numVerts;

        const firstTopIdx = vOff;
        for (let v = 0; v < numVerts; v++) {
          const bLon = exterior[v][0];
          const bLat = exterior[v][1];
          _latLonTo3D(bLat, bLon, globeRadius, positions, vOff * 3);
          cellIndices[vOff] = c;
          extrudeFlags[vOff] = 1.0;
          vOff++;
        }

        const firstBaseIdx = vOff;
        for (let v = 0; v < numVerts; v++) {
          const bLon = exterior[v][0];
          const bLat = exterior[v][1];
          _latLonTo3D(bLat, bLon, globeRadius, positions, vOff * 3);
          cellIndices[vOff] = c;
          extrudeFlags[vOff] = 0.0;
          vOff++;
        }

        // If no holes and simple, standard triangle fan from centroid is faster
        if (holes.length === 0) {
          for (let v = 0; v < numVerts; v++) {
            const next = (v + 1) % numVerts;
            indices[iOff++] = centroidIdx;
            indices[iOff++] = firstTopIdx + v;
            indices[iOff++] = firstTopIdx + next;
          }
        } else {
          for (const hole of holes) {
            holeIndices.push(pOff);
            const hLen = hole.length - 1;
            for (let v = 0; v < hLen; v++) {
              flatData.push(hole[v][0], hole[v][1]);
              ensureVerts(2); // Top and base
              const bLon = hole[v][0];
              const bLat = hole[v][1];
              // Top hole vert
              _latLonTo3D(bLat, bLon, globeRadius, positions, vOff * 3);
              cellIndices[vOff] = c;
              extrudeFlags[vOff] = 1.0;
              vOff++;
              // Base hole vert
              _latLonTo3D(bLat, bLon, globeRadius, positions, vOff * 3);
              cellIndices[vOff] = c;
              extrudeFlags[vOff] = 0.0;
              vOff++;
            }
            pOff += hLen;
          }

          const earcutTris = earcut(flatData, holeIndices, 2);
          ensureIndices(earcutTris.length);
          for (let i = 0; i < earcutTris.length; i++) {
            indices[iOff++] = firstTopIdx + earcutTris[i];
          }
        }

        // Side walls for exterior ring
        for (let v = 0; v < numVerts; v++) {
          const next = (v + 1) % numVerts;
          indices[iOff++] = firstBaseIdx + v;
          indices[iOff++] = firstBaseIdx + next;
          indices[iOff++] = firstTopIdx + next;
          indices[iOff++] = firstBaseIdx + v;
          indices[iOff++] = firstTopIdx + next;
          indices[iOff++] = firstTopIdx + v;
        }
      }

      if (c > 0 && c % 10000 === 0) {
        console.log(
          `  DGFlexEncoder: ${c.toLocaleString()} / ${this._cellCount.toLocaleString()} cells meshed`
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
    const dc = this.dataCount;

    const baseColumns = [];

    // 1. Cell IDs (Uint64 representation of numerical ID)
    const cellIdData = new BigUint64Array(cc);
    for (let i = 0; i < cc; i++) {
      cellIdData[i] = BigInt(this._cellIds[i]);
    }
    baseColumns.push({
      name: '_dg_cell_id',
      data: cellIdData,
      typeCode: TYPE_UINT64,
    });

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
    // Embed the actual sequential IDs used by the mesh locally
    const cellCount = this._cellCount;
    const headerSize = 16 + cellCount * 8;
    const totalBytes =
      headerSize +
      mesh.positions.byteLength +
      mesh.cellIndices.byteLength +
      mesh.extrudeFlags.byteLength +
      mesh.indices.byteLength;

    const buf = Buffer.alloc(totalBytes);
    let pos = 0;

    buf.write('DGM1', 0);
    pos += 4;
    buf.writeUInt32LE(mesh.vertCount, pos);
    pos += 4;
    buf.writeUInt32LE(mesh.idxCount, pos);
    pos += 4;
    buf.writeUInt32LE(cellCount, pos);
    pos += 4;

    for (let i = 0; i < cellCount; i++) {
      buf.writeBigUInt64LE(BigInt(this._cellIds[i]), pos);
      pos += 8;
    }

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

  async encode(options) {
    const t0 = performance.now();
    const {
      output,
      sharding = { epochsPerShard: 60 },
      baseName = 'data',
      manifest: extraManifest = {},
      meshDir,
    } = options;

    mkdirSync(output, { recursive: true });
    const SHARD_EPOCHS = sharding.epochsPerShard || 60;

    let mesh = options.mesh || null;
    const meshFileName = null;
    let meshRelativePath = null;

    if (meshDir) {
      mkdirSync(meshDir, { recursive: true });
      const sharedMeshFile = `${baseName}_grid.mesh.dgf.gz`;
      const sharedMeshPath = resolve(meshDir, sharedMeshFile);

      if (existsSync(sharedMeshPath)) {
        console.log(`  Shared DGF mesh exists: ${sharedMeshPath} — skipping generation`);
        mesh = { _shared: true };
        meshRelativePath = relative(output, meshDir) + '/' + sharedMeshFile;
      } else {
        console.log(`  Generating DGF mesh: ${sharedMeshPath}`);
        if (!mesh && this._features) {
          mesh = this.buildMesh(options.globeRadius || 1.0);
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
    }

    const baseBuf = this.encodeBase(mesh);
    const compressedBase = gzipSync(baseBuf, { level: this.gzipLevel });
    const baseFileName = `${baseName}_base.dgf.gz`;
    writeFileSync(resolve(output, baseFileName), compressedBase);
    console.log(
      `  Base: ${(baseBuf.length / 1e6).toFixed(1)} MB → ${(compressedBase.length / 1e6).toFixed(1)} MB gz`
    );

    const temporalMetrics = Object.keys(this._temporalDataMaps);
    const shardCount = Math.ceil(this.epochCount / SHARD_EPOCHS);

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
      const cellIdData = new BigUint64Array(cc);
      for (let i = 0; i < cc; i++) {
        cellIdData[i] = BigInt(this._cellIds[i]);
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
          name: '_dg_cell_id',
          data: cellIdData,
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

    const meshRef = meshRelativePath || null;
    let manifestObj;

    if (temporalMetrics.length === 0) {
      manifestObj = {
        format: 'dgflex-static',
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
        format: 'dgflex-sharded',
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
