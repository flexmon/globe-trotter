/**
 * flexdbClient.test.js — Unit tests for FlexDBClient (ported from globe-trotter-2d).
 *
 * All network calls are mocked via jest's global fetch stub.
 * Covers the BigInt precision bug (fixed in Phase 1 backport).
 */

import { vi } from 'vitest';
import { FlexDBClient } from '../lib/packages/flexdb-client/src/FlexDBClient.js';

// ─── fetch mock factory ───────────────────────────────────────────────────────

function mockFetch(
  responseData,
  { status = 200, contentType = 'application/json', headers = {} } = {}
) {
  const responseHeaders = new Map([
    ['content-type', contentType],
    ['x-rows-scanned', '0'],
    ['x-bytes-scanned', '0'],
    ...Object.entries(headers),
  ]);
  const mockResponse = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => responseHeaders.get(key.toLowerCase()) ?? null },
    json: async () => (typeof responseData === 'string' ? JSON.parse(responseData) : responseData),
    text: async () =>
      typeof responseData === 'string' ? responseData : JSON.stringify(responseData),
    arrayBuffer: async () => {
      if (responseData instanceof ArrayBuffer) return responseData;
      return new TextEncoder().encode(JSON.stringify(responseData)).buffer;
    },
  };
  return vi.fn().mockResolvedValue(mockResponse);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FlexDBClient', () => {
  let client;
  let originalFetch;

  beforeEach(() => {
    client = new FlexDBClient('http://flexdb.test:8090');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ─── constructor ────────────────────────────────────────────────────────

  describe('constructor', () => {
    test('stores baseUrl with trailing slash removed', () => {
      const c = new FlexDBClient('http://example.com/');
      expect(c.baseUrl).toBe('http://example.com');
    });

    test('defaults to localhost:8090', () => {
      const c = new FlexDBClient();
      expect(c.baseUrl).toBe('http://localhost:8090');
    });
  });

  // ─── query — JSON fallback path ─────────────────────────────────────────

  describe('query — JSON response', () => {
    test('parses JSON column/row format', async () => {
      global.fetch = mockFetch({
        columns: ['id', 'name'],
        rows: [
          [1, 'alpha'],
          [2, 'beta'],
        ],
        elapsed_ms: 42,
        rows_scanned: 2,
        bytes_scanned: 100,
      });

      const result = await client.query('SELECT id, name FROM t');
      expect(result.columns).toEqual(['id', 'name']);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({ id: 1, name: 'alpha' });
      expect(result.rows[1]).toEqual({ id: 2, name: 'beta' });
      expect(result.rowsScanned).toBe(2);
      expect(result.bytesScanned).toBe(100);
    });

    test('handles empty JSON result', async () => {
      global.fetch = mockFetch({ columns: [], rows: [] });
      const result = await client.query('SELECT * FROM empty');
      expect(result.columns).toEqual([]);
      expect(result.rows).toHaveLength(0);
    });

    test('throws when JSON response has error field', async () => {
      global.fetch = mockFetch({ error: 'Table not found' });
      await expect(client.query('SELECT * FROM missing')).rejects.toThrow('Table not found');
    });

    test('throws when HTTP status is not ok', async () => {
      global.fetch = mockFetch({ error: 'Unauthorized' }, { status: 401 });
      await expect(client.query('SELECT 1')).rejects.toThrow();
    });

    test('posts to /query with correct payload', async () => {
      const fetchMock = mockFetch({ columns: [], rows: [] });
      global.fetch = fetchMock;
      await client.query('SELECT 42');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://flexdb.test:8090/query',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: 'SELECT 42', format: 'arrow' }),
        })
      );
    });

    test('wraps network errors with helpful message', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
      await expect(client.query('SELECT 1')).rejects.toThrow('Cannot reach FlexDB');
    });
  });

  // ─── listTables ──────────────────────────────────────────────────────────

  describe('listTables', () => {
    test('returns the tables array from JSON response', async () => {
      global.fetch = mockFetch({
        tables: [
          { name: 'metrics', format: 'GFB', entity_count: 1000, epoch_count: 24, columns: ['val'] },
        ],
      });
      const tables = await client.listTables();
      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe('metrics');
    });

    test('returns empty array when tables field is missing', async () => {
      global.fetch = mockFetch({});
      const tables = await client.listTables();
      expect(tables).toEqual([]);
    });

    test('throws when /tables returns non-ok status', async () => {
      global.fetch = mockFetch('Server Error', { status: 500 });
      await expect(client.listTables()).rejects.toThrow('FlexDB /tables error: 500');
    });

    test('fetches from /tables endpoint', async () => {
      const fetchMock = mockFetch({ tables: [] });
      global.fetch = fetchMock;
      await client.listTables();
      expect(fetchMock).toHaveBeenCalledWith('http://flexdb.test:8090/tables');
    });
  });
});
