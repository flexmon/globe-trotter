/**
 * meshCache.test.js — Unit tests for MeshCache IndexedDB utility.
 *
 * MeshCache uses IndexedDB, which is not available in Node/Jest.
 * We provide a minimal in-memory mock that mirrors the IDB event model.
 */

// ─── Minimal IDB mock ─────────────────────────────────────────────────────────

function createMockIDB() {
  const store = new Map();
  const db = {
    transaction: (storeName, mode) => {
      const tx = {
        objectStore: () => ({
          get: (key) => {
            const req = {};
            setImmediate(() => {
              req.result = store.get(key);
              req.onsuccess?.();
            });
            return req;
          },
          put: (value, key) => {
            store.set(key, value);
            const req = {};
            setImmediate(() => req.oncomplete?.());
            return req;
          },
        }),
        oncomplete: null,
        onerror: null,
      };
      // fire oncomplete after all microtasks
      setImmediate(() => tx.oncomplete?.());
      return tx;
    },
  };
  return { db, store };
}

function installMockIndexedDB(db) {
  global.indexedDB = {
    open: (name, version) => {
      const req = { result: db };
      setImmediate(() => req.onsuccess?.());
      return req;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MeshCache', () => {
  let getMeshFromCache;
  let putMeshInCache;
  let mockStore;
  let originalIndexedDB;

  beforeEach(async () => {
    // Reset module so the _dbPromise singleton is cleared between tests
    vi.resetModules();
    const { db, store } = createMockIDB();
    mockStore = store;
    originalIndexedDB = global.indexedDB;
    installMockIndexedDB(db);

    // Re-import after resetting modules and installing mock IDB
    ({ getMeshFromCache, putMeshInCache } =
      await import('../lib/packages/core/src/layers/MeshCache.js'));
  });

  afterEach(() => {
    global.indexedDB = originalIndexedDB;
  });

  test('getMeshFromCache returns null for a cache miss', async () => {
    const result = await getMeshFromCache('http://example.com/mesh.bin');
    expect(result).toBeNull();
  });

  test('putMeshInCache stores and getMeshFromCache retrieves a buffer', async () => {
    const url = 'http://example.com/mesh.bin';
    const buf = new ArrayBuffer(8);
    // Must start with a recognised mesh magic prefix — getMeshFromCache now
    // rejects (evicts) non-binary buffers via _isValidMeshBuffer. 'H3M1' = H3Mesh v1.
    new Uint8Array(buf).set([0x48, 0x33, 0x4d, 0x31, 5, 6, 7, 8]);

    await putMeshInCache(url, buf);
    const retrieved = await getMeshFromCache(url);

    expect(retrieved).not.toBeNull();
    expect(retrieved.byteLength).toBe(8);
    expect(new Uint8Array(retrieved)[0]).toBe(0x48);
  });

  test('getMeshFromCache returns null for an expired entry', async () => {
    const url = 'http://example.com/old-mesh.bin';
    const buf = new ArrayBuffer(4);

    // Manually insert an entry with an old timestamp (8 days ago)
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    mockStore.set(url, { buffer: buf, timestamp: eightDaysAgo });

    const result = await getMeshFromCache(url);
    expect(result).toBeNull();
  });

  test('getMeshFromCache returns buffer for a non-expired entry', async () => {
    const url = 'http://example.com/fresh-mesh.bin';
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set([0x48, 0x33, 0x4d, 0x31]); // 'H3M1' magic — valid mesh buffer

    // Entry created 6 days ago (within 7-day TTL)
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
    mockStore.set(url, { buffer: buf, timestamp: sixDaysAgo });

    const result = await getMeshFromCache(url);
    expect(result).not.toBeNull();
  });

  test('getMeshFromCache returns null when indexedDB open fails', async () => {
    // Override IDB to simulate failure
    global.indexedDB = {
      open: () => {
        const req = {};
        setImmediate(() => {
          req.error = new Error('IDB unavailable');
          req.onerror?.();
        });
        return req;
      },
    };
    // Need to reset module to clear cached _dbPromise
    vi.resetModules();
    ({ getMeshFromCache } = await import('../lib/packages/core/src/layers/MeshCache.js'));

    const result = await getMeshFromCache('http://example.com/mesh.bin');
    expect(result).toBeNull();
  });

  test('putMeshInCache does not throw when IDB is unavailable', async () => {
    global.indexedDB = {
      open: () => {
        const req = {};
        setImmediate(() => {
          req.error = new Error('IDB unavailable');
          req.onerror?.();
        });
        return req;
      },
    };
    vi.resetModules();
    ({ putMeshInCache } = await import('../lib/packages/core/src/layers/MeshCache.js'));

    // Should not throw
    await expect(putMeshInCache('http://x.com/m.bin', new ArrayBuffer(4))).resolves.toBeUndefined();
  });
});
