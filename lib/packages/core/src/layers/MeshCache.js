/**
 * MeshCache.js — Shared IndexedDB cache for H3 mesh tile buffers.
 *
 * Stores decompressed mesh ArrayBuffers in IndexedDB so repeat visits
 * (across dashboard reloads, page navigations, and multiple apps sharing
 * the same origin) skip the CDN download entirely.
 *
 * Keyed by mesh URL, 7-day TTL (immutable geometry doesn't change).
 * Used by both H3FlexShards and LayerManager's addVirtualH3Layer().
 */

const MESH_CACHE_DB = 'globe-trotter-mesh-cache';
const MESH_CACHE_STORE = 'meshes';
const MESH_CACHE_VERSION = 1;
const MESH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let _dbPromise = null;

function _openMeshCacheDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(MESH_CACHE_DB, MESH_CACHE_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(MESH_CACHE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      _dbPromise = null;
      reject(req.error);
    };
  });
  return _dbPromise;
}

/**
 * Check whether an ArrayBuffer contains a valid binary mesh.
 * Rejects any buffer that starts with an HTML/text signature, which
 * indicates the server returned an error page (e.g. SPA fallback for a
 * missing route) that was mistakenly cached on a previous load.
 *
 * Recognised binary magic prefixes:
 *   DGM1 (0x44 0x47 0x4D 0x31) — DGFMesh monolithic / tile
 *   DGM2 (0x44 0x47 0x4D 0x32) — DGFMesh v2 tile
 *   H3M1 (0x48 0x33 0x4D 0x31) — H3Mesh v1 tile
 *   H3M2 (0x48 0x33 0x4D 0x32) — H3Mesh v2 tile
 *   0x1F 0x8B                  — gzip (pre-decompression)
 * @param {ArrayBuffer} buffer
 * @returns {boolean}
 */
function _isValidMeshBuffer(buffer) {
  if (!buffer || buffer.byteLength < 4) return false;
  const b = new Uint8Array(buffer, 0, 4);
  // gzip magic
  if (b[0] === 0x1f && b[1] === 0x8b) return true;
  // DGM1 / DGM2 magic (0x44 0x47 0x4D)
  if (b[0] === 0x44 && b[1] === 0x47 && b[2] === 0x4d) return true;
  // H3M1 / H3M2 magic (0x48 0x33 0x4D)
  if (b[0] === 0x48 && b[1] === 0x33 && b[2] === 0x4d) return true;
  return false;
}

/**
 * Retrieve a cached mesh buffer by URL.
 * Returns null if missing, expired, or the stored buffer is invalid
 * (e.g. a stale HTML error page from a previous SPA-fallback fetch).
 * @param {string} url
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getMeshFromCache(url) {
  try {
    const db = await _openMeshCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(MESH_CACHE_STORE, 'readonly');
      const req = tx.objectStore(MESH_CACHE_STORE).get(url);
      req.onsuccess = () => {
        const entry = req.result;
        if (entry && Date.now() - entry.timestamp < MESH_CACHE_TTL_MS) {
          if (!_isValidMeshBuffer(entry.buffer)) {
            console.warn(
              `[MeshCache] INVALID (non-binary) cached entry evicted: ${url.split('/').pop()}`
            );
            // Actively delete the stale entry so a failed re-write doesn't
            // leave the bad buffer persisting for the full 7-day TTL.
            try {
              const delTx = db.transaction(MESH_CACHE_STORE, 'readwrite');
              delTx.objectStore(MESH_CACHE_STORE).delete(url);
            } catch {
              /* best-effort */
            }
            resolve(null);
          } else {
            resolve(entry.buffer);
          }
        } else {
          if (entry) console.debug(`[MeshCache] EXPIRED: ${url.split('/').pop()}`);
          resolve(null); // expired or missing
        }
      };
      req.onerror = () => {
        console.warn('[MeshCache] Read error:', req.error);
        resolve(null);
      };
    });
  } catch (e) {
    console.warn('[MeshCache] DB open error:', e);
    return null;
  }
}

/**
 * Store a decompressed mesh buffer in the cache.
 * @param {string} url
 * @param {ArrayBuffer} buffer
 * @returns {Promise<void>}
 */
export async function putMeshInCache(url, buffer) {
  try {
    const db = await _openMeshCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(MESH_CACHE_STORE, 'readwrite');
      tx.objectStore(MESH_CACHE_STORE).put({ buffer, timestamp: Date.now() }, url);
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = (e) => {
        console.warn('[MeshCache] Write error:', e);
        resolve();
      };
    });
  } catch (e) {
    console.warn('[MeshCache] DB write error:', e);
  }
}
