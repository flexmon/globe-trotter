/**
 * MFBDecoder.js — SHD3 Async MetricFlex Binary decoder.
 */

import { decodeShardV3, createTypedArray } from '../../../data-sdk/src/decoders/ShardV3Decoder.js';

/**
 * Decode an SHD3 MetricFlex binary file using a sidecar manifest for column names.
 *
 * @param {ArrayBuffer} buffer — Raw binary SHD3 data
 * @param {Object} manifest — YAML/JSON manifest defining columns
 * @returns {Promise<Object>}
 */
export async function decodeMFB(buffer, manifest) {
  if (!manifest)
    throw new Error('[MFB] decodeMFB requires a manifest to resolve SHD3 column names');

  const {
    epochCount,
    entityCount,
    columns: shardCols,
    dictionaries,
    types,
    rawSchema,
  } = await decodeShardV3(buffer);

  const staticColumns = {};
  const temporalColumns = {};
  const schema = manifest.columns || [];

  const outDictionaries = {};
  const legacyGlobalDict = manifest.dictionary || null;
  if (dictionaries) {
    for (const [colName, dictArray] of dictionaries.entries()) {
      outDictionaries[colName] = dictArray;
    }
  }

  let entityIds = null;
  let entityKey = null;
  const resolvedStrings = {};

  for (const col of schema) {
    const buf = shardCols.get(col.name);
    if (!buf) continue;

    const typeCode = types.get(col.name);
    const rowCount = col.temporal ? epochCount * entityCount : entityCount;
    const typedArray = createTypedArray(typeCode, buf, rowCount);

    if (typeCode === 'dict_string32') {
      const colDict = outDictionaries[col.name] || legacyGlobalDict;
      if (colDict) {
        outDictionaries[col.name] = colDict; // Guarantee it is mapped
      }
    }

    if (col.temporal) {
      temporalColumns[col.name] = typedArray;
    } else {
      // Is it an entity ID column? e.g. tail_id
      if (col.name === 'tail_id' || col.isEntityKey) {
        entityIds = typedArray;
        entityKey = { name: col.name, type: 4 }; // TYPE_UINT32
      } else {
        staticColumns[col.name] = typedArray;
      }
    }
  }

  return {
    entityCount,
    epochCount: manifest.epochCount ?? epochCount,
    epochInterval: manifest.epochInterval || 0,
    schema: schema.map((c) => ({ name: c.name, type: 0, temporal: c.temporal ? 1 : 0 })),
    dictionaries: outDictionaries,
    staticColumns,
    temporalColumns,
    resolvedStrings,
    entityKey,
    entityIds,
    columnNames: schema.map((c) => c.name),
  };
}
