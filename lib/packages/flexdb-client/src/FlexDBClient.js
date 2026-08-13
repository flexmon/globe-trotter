/**
 * FlexDBClient.js — Arrow IPC HTTP client for FlexDB historic queries.
 *
 * Posts SQL to FlexDB's /query endpoint with format=arrow,
 * decodes Arrow IPC stream → { columns, rows, elapsed }.
 */
import { tableFromIPC } from 'apache-arrow';

export class FlexDBClient {
  constructor(baseUrl = 'http://localhost:8090') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this._hasWarnedLargeResult = false;
  }

  /**
   * Execute a SQL query against FlexDB.
   * @param {string} sql
   * @returns {Promise<{columns: string[], rows: Object[], elapsed: number}>}
   */
  async query(sql) {
    const t0 = performance.now();

    try {
      // Try Arrow IPC first
      const response = await fetch(`${this.baseUrl}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, format: 'arrow' }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(err.error || `FlexDB error: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/vnd.apache.arrow')) {
        // Arrow IPC decode — wrap in try/catch because FlexDB may return
        // truncated Arrow data on shard errors (HTTP 200 but bad payload)
        let buffer;
        try {
          buffer = await response.arrayBuffer();
        } catch (e) {
          throw new Error(`FlexDB returned incomplete response: ${e.message}`);
        }

        // Check if the buffer is actually a JSON error (FlexDB sometimes
        // returns JSON error body with Arrow content-type on shard failures)
        if (buffer.byteLength < 1000) {
          try {
            const text = new TextDecoder().decode(buffer);
            if (text.startsWith('{')) {
              const errObj = JSON.parse(text);
              if (errObj.error) throw new Error(errObj.error);
            }
          } catch (e) {
            if (e.message.includes('error:') || e.message.includes('Error')) throw e;
            // Not JSON, proceed with Arrow decode
          }
        }

        let table;
        try {
          table = tableFromIPC(new Uint8Array(buffer));
        } catch (e) {
          throw new Error(`Arrow IPC decode failed: ${e.message}`);
        }

        const columns = table.schema.fields.map((f) => f.name);
        // Identify Timestamp columns from Arrow schema
        const tsFlags = table.schema.fields.map(
          (f) => f.type && f.type.toString().startsWith('Timestamp')
        );
        const rows = [];

        // PERF: Row-oriented Arrow decode. Blocks the main thread for large result sets.
        // For >100K rows consider moving to a Web Worker or returning columnar arrays.
        if (table.numRows > 100_000 && !this._hasWarnedLargeResult) {
          this._hasWarnedLargeResult = true;
          console.warn(
            `[FlexDBClient] Large result set (${table.numRows} rows) decoded on main thread. Consider pagination or Web Worker.`
          );
        }

        for (let i = 0; i < table.numRows; i++) {
          const row = {};
          for (let c = 0; c < columns.length; c++) {
            const col = columns[c];
            const vec = table.getChild(col);
            let val = vec.get(i);
            // Arrow returns BigInt for integer types — coerce to Number only when
            // safe (within Number.MAX_SAFE_INTEGER). H3 cell IDs exceed 2^53 and
            // must stay as strings to preserve precision.
            if (typeof val === 'bigint') {
              const SAFE_MIN = -9007199254740991n;
              const SAFE_MAX = 9007199254740991n;
              val = val >= SAFE_MIN && val <= SAFE_MAX ? Number(val) : val.toString();
            }
            // Format Timestamp columns as UTC datetime strings
            if (tsFlags[c] && typeof val === 'number') {
              // Arrow Timestamp(Second) values are in seconds; arrow-js may return ms
              const ms = val > 1e12 ? val : val * 1000;
              const dt = new Date(ms);
              val =
                dt.getUTCFullYear().toString().padStart(4, '0') +
                '-' +
                (dt.getUTCMonth() + 1).toString().padStart(2, '0') +
                '-' +
                dt.getUTCDate().toString().padStart(2, '0') +
                ' ' +
                dt.getUTCHours().toString().padStart(2, '0') +
                ':' +
                dt.getUTCMinutes().toString().padStart(2, '0') +
                ':' +
                dt.getUTCSeconds().toString().padStart(2, '0') +
                ' UTC';
            }
            row[col] = val;
          }
          rows.push(row);
        }

        const rowsScanned = parseInt(response.headers.get('x-rows-scanned') || '0', 10);
        const bytesScanned = parseInt(response.headers.get('x-bytes-scanned') || '0', 10);
        return { columns, rows, elapsed: performance.now() - t0, rowsScanned, bytesScanned };
      }

      // Fallback: JSON response
      const json = await response.json();
      if (json.error) throw new Error(json.error);

      const columns = json.columns || [];
      const rows = (json.rows || []).map((row) => {
        const obj = {};
        columns.forEach((col, i) => {
          obj[col] = row[i];
        });
        return obj;
      });

      return {
        columns,
        rows,
        elapsed: json.elapsed_ms || performance.now() - t0,
        rowsScanned: json.rows_scanned || 0,
        bytesScanned: json.bytes_scanned || 0,
      };
    } catch (err) {
      if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
        throw new Error(`Cannot reach FlexDB at ${this.baseUrl} — is it running?`);
      }
      throw err;
    }
  }

  /**
   * List tables available on FlexDB.
   * @returns {Promise<Array<{name, format, entity_count, epoch_count, columns}>>}
   */
  async listTables() {
    const response = await fetch(`${this.baseUrl}/tables`);
    if (!response.ok) throw new Error(`FlexDB /tables error: ${response.status}`);
    const json = await response.json();
    return json.tables || [];
  }
}
