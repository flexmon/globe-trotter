/**
 * VirtualH3DecodeWorker.js — Off-main-thread Arrow IPC decode for VirtualH3Loader.
 *
 * Receives raw Arrow IPC bytes from the main thread, parses the table,
 * scatters values into a dense Float32Array aligned to the mesh, and
 * transfers the results back — all without touching the main thread.
 *
 * Protocol:
 *   init   { type:'init',   id, meshCellIds: BigUint64Array }
 *   decode { type:'decode', id, arrowBytes: ArrayBuffer, metrics: string[], h3Field: string }
 *
 * Responses:
 *   { type:'init_ok',   id }
 *   { type:'decode_ok', id, results: { [metric]: Float32Array } }
 *   { type:'decode_err', id, message: string }
 */

import { tableFromIPC } from 'apache-arrow';

// Persistent state — initialised once per worker lifetime.
let _cellIdIndex = null; // Map<bigint, number>  cellId → dense mesh index
let _scratches = {}; // { [metric]: Float32Array } — reused across epochs
let _meshSize = 0;

self.onmessage = async ({ data }) => {
  const { type, id } = data;

  // ── init ─────────────────────────────────────────────────────────────────
  if (type === 'init') {
    const { meshCellIds, metrics } = data;
    _meshSize = meshCellIds.length;

    // Build persistent cellId → dense-index lookup (O(n), done once).
    _cellIdIndex = new Map();
    for (let i = 0; i < meshCellIds.length; i++) {
      _cellIdIndex.set(meshCellIds[i], i);
    }

    // Pre-allocate per-metric scratch buffers.
    _scratches = {};
    for (const m of metrics) {
      _scratches[m] = new Float32Array(_meshSize);
    }

    self.postMessage({ type: 'init_ok', id });
    return;
  }

  // ── decode ────────────────────────────────────────────────────────────────
  if (type === 'decode') {
    const { arrowBytes, metrics, h3Field } = data;

    try {
      // Ensure scratch buffers exist for any new metrics added after init.
      for (const m of metrics) {
        if (!_scratches[m]) _scratches[m] = new Float32Array(_meshSize);
        _scratches[m].fill(0);
      }

      if (arrowBytes && arrowBytes.byteLength > 0) {
        const table = tableFromIPC(new Uint8Array(arrowBytes));
        const h3Col = table.getChild(h3Field);

        const metricCols = {};
        for (const m of metrics) {
          const alias = / AS /i.test(m) ? m.split(/ AS /i)[1].trim() : m;
          metricCols[m] = table.getChild(alias);
        }

        // Scatter directly into scratch via the persistent cellId → meshIndex map.
        for (let i = 0; i < table.numRows; i++) {
          let cellId = h3Col.get(i);
          if (cellId == null || cellId === '' || cellId === 'Null' || cellId === 'null') continue;
          try {
            if (typeof cellId === 'string') {
              const cleanHex = cellId.startsWith('0x') ? cellId.slice(2) : cellId;
              if (!/^[0-9a-fA-F]+$/.test(cleanHex) || cleanHex.length > 16) continue;
              cellId = BigInt('0x' + cleanHex);
            } else if (typeof cellId === 'number') {
              cellId = BigInt(cellId);
            } else if (typeof cellId !== 'bigint') {
              continue;
            }

            const meshIdx = _cellIdIndex.get(cellId);
            if (meshIdx === undefined) continue;

            for (const m of metrics) {
              let val = metricCols[m]?.get(i);
              if (typeof val === 'bigint') val = Number(val);
              if (val != null && !isNaN(val)) _scratches[m][meshIdx] = val;
            }
          } catch {
            continue;
          }
        }
      }

      // Slice each scratch into an independent copy for transfer.
      const results = {};
      const transferables = [];
      for (const m of metrics) {
        results[m] = _scratches[m].slice();
        transferables.push(results[m].buffer);
      }

      self.postMessage({ type: 'decode_ok', id, results }, transferables);
    } catch (err) {
      self.postMessage({ type: 'decode_err', id, message: err.message });
    }
  }
};
