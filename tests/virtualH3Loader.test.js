import { vi } from 'vitest';
import { VirtualH3Loader } from '../lib/packages/core/src/layers/VirtualH3Loader.js';

// Mock apache-arrow as a virtual module since it's not in node_modules
vi.mock('apache-arrow', () => ({
  tableFromIPC: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('VirtualH3Loader', () => {
  const meshCellIds = new BigUint64Array([
    BigInt('0x85283473fffffff'),
    BigInt('0x85283477fffffff'),
    BigInt('0x8528347bfffffff'),
  ]);

  let loader;

  beforeEach(() => {
    vi.clearAllMocks();
    loader = new VirtualH3Loader({
      flexdbUrl: 'http://flexdb:8090',
      table: 'test_table',
      h3Field: 'h3_5',
      metrics: ['m1', 'm2'],
      epochIntervalSeconds: 60,
    });
  });

  describe('getLatestEpoch', () => {
    test('correctly identifies the latest stable bin index', async () => {
      // Mock FlexDB MAX(_epoch) query
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0), // Dummy buffer
      });

      // Mock Arrow table result
      const { tableFromIPC } = await import('apache-arrow');
      tableFromIPC.mockReturnValueOnce({
        numRows: 1,
        getChildAt: () => ({
          get: () => 29582159, // Raw max bin
        }),
      });

      const latest = await loader.getLatestEpoch();

      // Should be 29582159 * 60 = 1774929540
      expect(latest).toBe(1774929540);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://flexdb:8090/query',
        expect.objectContaining({
          body: expect.stringContaining('SELECT MAX(_epoch) as latest'),
        })
      );
    });

    test('retries after catalog reload if no data found', async () => {
      // 1. Initial query returns null
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
      });
      const { tableFromIPC } = await import('apache-arrow');
      tableFromIPC.mockReturnValueOnce(null); // No table

      // 2. Mock catalog reload
      mockFetch.mockResolvedValueOnce({ ok: true });

      // 3. Retry query returns success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
      });
      tableFromIPC.mockReturnValueOnce({
        numRows: 1,
        getChildAt: () => ({ get: () => 100 }),
      });

      const latest = await loader.getLatestEpoch();

      expect(latest).toBe(100 * 60);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'http://flexdb:8090/catalog/reload',
        expect.anything()
      );
    });
  });

  describe('fetchEpoch', () => {
    test('generates correct SQL with bin-index conversion', async () => {
      await loader.init(meshCellIds);

      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(0),
      });

      const { tableFromIPC } = await import('apache-arrow');
      tableFromIPC.mockReturnValue({
        numRows: 0,
      });

      // 1774929839 seconds -> floor(1774929839 / 60) = 29582163
      await loader.fetchEpoch(1774929839);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.stringContaining('WHERE _epoch = 29582163'),
        })
      );
    });

    test('handles 400 Bad Request error', async () => {
      await loader.init(meshCellIds);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Invalid SQL',
      });

      await expect(loader.fetchEpoch(123456)).rejects.toThrow('FlexDB error: 400 - Invalid SQL');
    });
  });

  describe('_decodeResult', () => {
    test('correctly maps sparse records to dense mesh buffer', async () => {
      await loader.init(meshCellIds);

      const mockTable = {
        numRows: 2,
        getChild: (name) => {
          if (name === 'h3_5')
            return { get: (i) => (i === 0 ? '85283473fffffff' : '8528347bfffffff') };
          if (name === 'm1') return { get: (i) => (i === 0 ? 100 : 200) };
          if (name === 'm2') return { get: (i) => (i === 0 ? 10 : 20) };
          return null;
        },
      };

      const result = loader._decodeResult(mockTable);

      // m1: [100, 0 (not found), 200]
      expect(result.m1).toBeInstanceOf(Float32Array);
      expect(result.m1[0]).toBe(100);
      expect(result.m1[1]).toBe(0);
      expect(result.m1[2]).toBe(200);

      // m2: [10, 0, 20]
      expect(result.m2[0]).toBe(10);
      expect(result.m2[2]).toBe(20);
    });

    test('filters out invalid H3 IDs like "Null"', async () => {
      await loader.init(meshCellIds);

      const mockTable = {
        numRows: 2,
        getChild: (name) => {
          if (name === 'h3_5') return { get: (i) => (i === 0 ? 'Null' : '85283473fffffff') };
          if (name === 'm1') return { get: (i) => 500 };
          return null;
        },
      };

      const result = loader._decodeResult(mockTable);

      // Should skip "Null" and only map '85283473fffffff'
      expect(result.m1[0]).toBe(500);
      expect(result.m1[1]).toBe(0);
      expect(result.m1[2]).toBe(0);
    });
  });
});
