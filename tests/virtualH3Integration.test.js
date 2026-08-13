import { vi } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Mock VirtualH3Loader before LayerManager is imported so the internally
// constructed loader instance uses our controlled mock methods.
// ──────────────────────────────────────────────────────────────────────────────
let mockLoaderInstance;

vi.mock('../lib/packages/core/src/layers/VirtualH3Loader.js', () => {
  return {
    VirtualH3Loader: vi.fn().mockImplementation(function () {
      mockLoaderInstance = {
        init: vi.fn(),
        getLatestEpoch: vi.fn().mockResolvedValue(1774929480),
        fetchEpoch: vi.fn().mockResolvedValue({ m1: new Float32Array(3) }),
        prefetch: vi.fn(),
      };
      return mockLoaderInstance;
    }),
  };
});

// ──────────────────────────────────────────────────────────────────────────────
// These tests exercise LayerManager's virtual-H3 orchestration (loader init,
// epoch-change fetch, background live probing) — not GPU rendering. Stub out the
// WebGPU-touching collaborators so no real GPUDevice is required:
//   - H3FlexRenderer's constructor allocates GPU buffers/pipelines.
//   - StyleEngine.compileGPU uploads a ramp texture (device.createTexture).
// StyleEngine.ramp() stays real so the layer's style spec is built normally.
// ──────────────────────────────────────────────────────────────────────────────
vi.mock('../lib/packages/core/src/layers/H3FlexRenderer.js', () => ({
  H3FlexRenderer: vi.fn().mockImplementation(function () {
    return {
      setActiveAttribute: vi.fn(),
      setExtrusionScale: vi.fn(),
      _currentEpoch: 0,
    };
  }),
}));

vi.mock('../lib/packages/core/src/styles/StyleEngine.js', async (importActual) => {
  const actual = await importActual();
  actual.StyleEngine.compileGPU = vi.fn(() => ({}));
  return actual;
});

import { LayerManager } from '../lib/packages/core/src/layers/LayerManager.js';

/** Flush pending microtasks (n hops through the Promise queue). */
async function flushPromises(hops = 4) {
  for (let i = 0; i < hops; i++) {
    await Promise.resolve();
  }
}

describe('LayerManager Virtual H3 Integration', () => {
  let layerManager;
  let mockEngine;

  // Mock global fetch for manifest retrieval and tile fetching
  const mockFetch = vi.fn();
  global.fetch = mockFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoaderInstance = null;

    // Default fetch mock: JSON for manifests, H3M2 binary for tile files
    mockFetch.mockImplementation((url) => {
      if (url.endsWith('.json')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            tiles: [{ file: 'tile_0.h3f' }],
            vertCount: 100,
            idxCount: 100,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => {
          // Minimal valid H3M2 binary: magic + header counts + zero data
          const vertexCount = 3;
          const indexCount = 3;
          const cellCount = 3;

          const buf = new ArrayBuffer(2000);
          const view = new DataView(buf);

          // Magic: 'H3M2'
          view.setUint8(0, 0x48);
          view.setUint8(1, 0x33);
          view.setUint8(2, 0x4d);
          view.setUint8(3, 0x32);

          view.setUint32(4, vertexCount, true);
          view.setUint32(8, indexCount, true);
          view.setUint32(12, cellCount, true);
          return buf;
        },
      });
    });

    mockEngine = {
      requestRender: vi.fn(),
    };

    layerManager = new LayerManager();
    // StyleEngine.compileGPU and H3FlexRenderer are mocked (see top of file), so
    // the device is never actually used — a placeholder is enough to pass through.
    layerManager._device = {};
    layerManager.engine = mockEngine;
  });

  afterEach(() => {
    // Clear any setInterval timers created by addVirtualH3Layer(findLatest:true)
    for (const [, layer] of layerManager?.layers || []) {
      if (layer.virtualState?.intervalId) {
        clearInterval(layer.virtualState.intervalId);
      }
    }
    vi.useRealTimers();
  });

  test('addVirtualH3Layer: initializes loader and sets status', async () => {
    await layerManager.addVirtualH3Layer('traffic', {
      findLatest: true,
      epochInterval: 60,
      table: 'traffic_metrics',
      h3Field: 'h3_5',
    });

    const layer = layerManager.layers.get('traffic');
    expect(layer).toBeDefined();
    expect(layer.type).toBe('h3f-virtual');

    // The internally constructed VirtualH3Loader must have had init() called on it
    expect(mockLoaderInstance.init).toHaveBeenCalled();
    // findLatest: true → getLatestEpoch should have been called during setup
    expect(mockLoaderInstance.getLatestEpoch).toHaveBeenCalled();
  });

  test('prepareH3Compute: triggers fetch when epoch changes', async () => {
    // Setup layer (findLatest: false avoids setInterval side-effects)
    await layerManager.addVirtualH3Layer('traffic', {
      findLatest: false,
      epochInterval: 60,
      table: 'traffic_metrics',
      h3Field: 'h3_5',
      metrics: ['m1'],
    });

    const layer = layerManager.layers.get('traffic');
    layer.virtualState.lastEpoch = 0;

    // Mock time controller returning a new epoch
    layerManager.time = {
      getCurrentEpoch: () => 1774929480,
    };

    // First call: epoch differs from lastEpoch (0 vs 1774929480) → fetchEpoch called
    layerManager.prepareH3Compute();

    expect(layer.virtualState.lastEpoch).toBe(1774929480);
    expect(mockLoaderInstance.fetchEpoch).toHaveBeenCalledWith(1774929480);

    // Wait for the internal .then() microtask to fire
    await flushPromises(2);

    expect(mockEngine.requestRender).toHaveBeenCalled();
  });

  test('prepareH3Compute: background probing logic', async () => {
    vi.useFakeTimers();

    const epochInterval = 60;
    const newLatest = 1774929540;
    const newLiveEdge = newLatest + epochInterval; // 1774929600

    // epochWindowMinutes defaults to 1440 min = 86400s → totalEpochs = 86400/60 = 1440
    const windowSec = 1440 * 60;
    const totalEpochs = Math.round(windowSec / epochInterval);

    await layerManager.addVirtualH3Layer('traffic', {
      findLatest: true,
      epochInterval,
      table: 'traffic_metrics',
      h3Field: 'h3_5',
    });

    const layer = layerManager.layers.get('traffic');

    const advanceLiveEdge = vi.fn();
    layerManager.time = {
      getCurrentEpoch: () => 1774929480,
      advanceLiveEdge,
      mode: 'live',
      isFollowingLive: true,
      // _liveEdgeTimeSec must be 0 (< newLiveEdge) so the condition triggers
      _liveEdgeTimeSec: 0,
    };

    // Mock the internal loader's getLatestEpoch to return a newer epoch
    mockLoaderInstance.getLatestEpoch.mockResolvedValueOnce(newLatest);

    // The probing logic lives inside the setInterval callback (15s).
    // Advance fake timers past the 15s interval to fire the callback.
    vi.advanceTimersByTime(15000);

    // isProbing is set synchronously inside the interval callback before the async probe
    expect(layer.virtualState.isProbing).toBe(true);

    // The probe chain: getLatestEpoch() → .then() → .catch() → .finally()
    // Each hop is one Promise.resolve() tick. 4 flushes cover the full chain.
    await flushPromises(4);

    expect(layer.virtualState.isProbing).toBe(false);
    expect(advanceLiveEdge).toHaveBeenCalledWith(newLiveEdge, newLiveEdge - windowSec, totalEpochs);
  });
});
