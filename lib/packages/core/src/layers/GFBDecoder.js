/**
 * GFBDecoder.js — SHD3 Async GeoFlex Binary decoder.
 * Supports de-interleaved geometry streams for RGBA32F GPU uploads.
 */

import { decodeShardV3, createTypedArray } from '../../../data-sdk/src/decoders/ShardV3Decoder.js';

/**
 * Resolve the entity-key column (e.g. modem_mac) from the shard's decoded columns.
 * The entity key is not listed in manifest.columns, so it must be pulled from the
 * shard's self-describing column set. String/dict keys are decoded to display
 * strings via their dictionary so the value is self-contained (no external dict
 * dependency downstream, which matters for streaming dict remapping).
 *
 * decodeShardV3 stores dict/plain columns as raw ArrayBuffers, so the buffer must
 * be reinterpreted to a typed array (via createTypedArray, honoring the column's
 * dataType) before indexing — the same step decodeGFB applies to normal columns.
 *
 * @param {string|null} entityKeyName
 * @param {Map<string, any>} shardCols  Decoded columns keyed by name (ArrayBuffers).
 * @param {Map<string, string[]>} dictionaries  Per-column dictionaries.
 * @param {Map<string, string>} types  Per-column SHD3 dataType strings.
 * @returns {Array<string>|TypedArray|null}
 */
export function resolveEntityColumn(entityKeyName, shardCols, dictionaries, types) {
  if (!entityKeyName || !shardCols?.has) return null;
  // Encoders may prefix split columns with '_' (as geometry does: _longitude).
  const key = shardCols.has(entityKeyName)
    ? entityKeyName
    : shardCols.has(`_${entityKeyName}`)
      ? `_${entityKeyName}`
      : null;
  if (!key) return null;
  const raw = shardCols.get(key);
  const indices = createTypedArray(types?.get?.(key), raw);
  const dict = dictionaries?.get?.(key);
  if (dict) return Array.from(indices, (idx) => dict[idx]);
  return indices;
}

export async function decodeGFB(buffer, manifest) {
  if (!manifest)
    throw new Error('[GFB] decodeGFB requires a manifest to resolve SHD3 column names');

  const {
    epochCount,
    entityCount,
    columns: shardCols,
    dictionaries,
    types,
    rawSchema,
  } = await decodeShardV3(buffer);

  // Extract geometry columns (SHD3 GeoFlexEncoder splits them)
  const lonBuf = shardCols.get('longitude') || shardCols.get('_longitude');
  const latBuf = shardCols.get('latitude') || shardCols.get('_latitude');
  const altBuf = shardCols.get('altitude') || shardCols.get('_altitude');

  let geometry = null;
  const geomType = rawSchema?.geom_type || 1; // 1 = POINT is default
  let fpp = rawSchema?.floats_per_pos || 2;
  const hasAltitude =
    !!altBuf ||
    manifest?.hasAltitude === true ||
    (manifest?.columns?.some((c) => c.name === 'altitude') ?? false);
  const geomIsTemporal = lonBuf && epochCount > 0;

  if (lonBuf && latBuf) {
    const lonType = types.get('longitude') || types.get('_longitude') || 'float32';
    const latType = types.get('latitude') || types.get('_latitude') || 'float32';
    const altType = types.get('altitude') || types.get('_altitude') || 'float32';
    const lon = createTypedArray(lonType, lonBuf);
    const lat = createTypedArray(latType, latBuf);
    const alt = altBuf ? createTypedArray(altType, altBuf) : null;
    fpp = alt ? 3 : 2;

    if (geomIsTemporal) {
      geometry = {
        type: 'temporal_point',
        featureCount: entityCount,
        epochCount,
        floatsPerPos: fpp,
        hasAltitude,
        packedPositions: packRGBA32F_deinterleaved(lon, lat, alt, entityCount, epochCount),
      };
    } else {
      // Static geometry -> build pre-packed RGBA32F array for fast GPU upload
      // We use manifest.featureCount or entityCount depending on base vs shard contexts
      const featCount = manifest.featureCount || entityCount;
      geometry = {
        type: 'point',
        featureCount: featCount,
        epochCount: 1,
        floatsPerPos: fpp,
        hasAltitude,
        packedPositions: packRGBA32F_deinterleaved(lon, lat, alt, featCount, 1),
      };
    }
  }

  const staticColumns = {};
  const temporalColumns = {};
  const schema = manifest.columns || [];

  // Convert the Map to a standard JS object, with legacy fallback
  const outDictionaries = {};
  const legacyGlobalDict = manifest.dictionary || [];
  if (dictionaries) {
    for (const [colName, dictArray] of dictionaries.entries()) {
      outDictionaries[colName] = dictArray;
    }
  }

  let entityIds = null;
  let entityKey = null;

  for (const col of schema) {
    const buf = shardCols.get(col.name);
    if (!buf) continue;

    const baseFeatCount = manifest.featureCount || entityCount;
    const rowCount = col.temporal ? epochCount * baseFeatCount : baseFeatCount;
    const typedArray = createTypedArray(types.get(col.name), buf, rowCount);

    const typeStr = types.get(col.name);
    if (
      (typeStr === 'dict_string32' || typeStr === 'enum32' || typeStr === 'enum') &&
      !outDictionaries[col.name]
    ) {
      outDictionaries[col.name] = legacyGlobalDict;
    }

    if (col.temporal) {
      temporalColumns[col.name] = typedArray;
    } else {
      // Is it an entity ID column? e.g. target_id
      if (col.name === 'target_id' || col.isEntityKey) {
        entityIds = typedArray;
        entityKey = { name: col.name, type: 4 }; // TYPE_UINT32
      } else {
        staticColumns[col.name] = typedArray;
      }
    }
  }

  // Entity key (e.g. modem_mac) — not in manifest.columns, so pull it from the
  // shard's own columns. Only if the columns loop didn't already capture one.
  if (!entityIds) {
    const ekName = manifest.entityKey?.name;
    const resolved = resolveEntityColumn(ekName, shardCols, dictionaries, types);
    if (resolved) {
      entityIds = resolved;
      entityKey = { name: ekName, type: types.get(ekName) };
    }
  }

  return {
    featureCount: manifest.featureCount || entityCount,
    geomType,
    bbox: manifest.bbox,
    geometry,
    staticColumns,
    temporalColumns,
    dictionaries: outDictionaries,
    schema,
    epochCount: manifest.epochCount ?? epochCount,
    epochInterval: manifest.epochInterval || 0,
    hasTemporal: schema.some((c) => c.temporal),
    geomIsTemporal,
    hasAltitude,
    entityKey,
    entityIds,
  };
}

// ═══════════════════════════════════════════════════════════
// RGBA32F GPU De-interleaver (SHD2)
// ═══════════════════════════════════════════════════════════
export function packRGBA32F_deinterleaved(lon, lat, alt, featureCount, epochCount) {
  const texSize = Math.max(1, Math.ceil(Math.sqrt(featureCount)));
  const texelsPerEpoch = texSize * texSize;
  const packed = new Float32Array(epochCount * texelsPerEpoch * 4);

  for (let e = 0; e < epochCount; e++) {
    const srcBase = e * featureCount;
    const dstBase = e * texelsPerEpoch * 4;
    for (let i = 0; i < featureCount; i++) {
      const src = srcBase + i;
      const dst = dstBase + i * 4;
      packed[dst] = lon[src];
      packed[dst + 1] = lat[src];
      packed[dst + 2] = alt ? alt[src] : 0;
    }
  }

  packed._texSize = texSize;
  packed._texelsPerEpoch = texelsPerEpoch;
  return packed;
}
