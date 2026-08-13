/**
 * LayerManager.js — Multi-layer orchestrator for H3Flex and GeoFlex data layers.
 * Manages loading, decoding, rendering, and cartographic styling.
 *
 * Style priority cascade (highest → lowest):
 *   1. YAML config style (passed via options.style)
 *   2. Embedded style in the data format itself
 *   3. Geometry-type default (constant color per point/line/polygon)
 *
 * Programmatic setLayerStyle() always overrides all of the above.
 */

import { decodeH3Flex, decodeH3Mesh } from './H3FlexDecoder.js';
import { defaultH3StyleSpec } from './H3EpochUtils.js';
import { VirtualH3Loader } from './VirtualH3Loader.js';
import { decodeDGFlex } from './DGFlexDecoder.js';
import { decodeGFB } from './GFBDecoder.js';
import { decodeMFB } from './MFBDecoder.js';
import { MFBDataSource } from './MFBDataSource.js';
import { H3FlexRenderer } from './H3FlexRenderer.js';
import { DGFlexRenderer } from './DGFlexRenderer.js';
import { GFBRenderer } from './GFBRenderer.js';
import { GFBLineRenderer } from './GFBLineRenderer.js';
import { GFBPolygonRenderer } from './GFBPolygonRenderer.js';
import { LoaderRegistry } from './loaders/registry.js';
import { getMeshFromCache, putMeshInCache } from './MeshCache.js';
import { StyleEngine } from '../styles/StyleEngine.js';
import { parseQuery, flattenForGPU } from '../query/QueryParser.js';

export function extractStyleDictionary(styleSpec, data) {
  const attr = styleSpec?.style?.attribute || styleSpec?.color?.attribute || styleSpec?.attribute;
  if (data.dictionaries && attr && data.dictionaries[attr]) {
    return data.dictionaries[attr];
  }
  return data.dictionary || [];
}

export class LayerManager {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {Object} [gpuOpts] - WebGPU options { device, format, depthFormat }
   */
  constructor(gpuOpts) {
    this._device = gpuOpts?.device || null;
    this._format = gpuOpts?.format || null;
    this._depthFormat = gpuOpts?.depthFormat || null;
    this.layers = new Map(); // name → { type, data, renderer, style }
    this.totalFeatures = 0;
    this.maxEpochCount = 0;
    this.maxEpochInterval = 0;
    this.startHourUTC = null; // Derived from loaded data
    this.startTimestamp = null; // Unix epoch seconds from manifest
    // Monotonically-incrementing counter so UI components (e.g. LegendPanel)
    // can detect style changes without iterating all layers every frame.
    this._styleVersion = 0;
  }

  /**
   * Load a data layer from a URL with optional style.
   * For sharded/streaming layers, use addShardedGFBLayer / addStreamingGFBLayer / addShardedLayer instead.
   * @param {string} name - Layer display name
   * @param {'h3f'|'gfb'|'mfb'} type - Format type (single-file decoders only)
   * @param {string} url - URL to fetch binary data from
   * @param {Object} [options] - { styleUrl, style, extrusionScale }
   * @returns {Promise<void>}
   */
  async addLayer(name, type, url, options = {}) {
    const t0 = performance.now();

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);

    let buffer = await response.arrayBuffer();

    // Auto-decompress .gz files (CDN may not set Content-Encoding: gzip)
    if (url && url.endsWith('.gz')) {
      const ds = new DecompressionStream('gzip');
      const decompressed = new Response(new Blob([buffer]).stream().pipeThrough(ds));
      buffer = await decompressed.arrayBuffer();
    }

    let data, renderer, compiledStyle;

    if (type === 'h3f') {
      let manifest;
      try {
        const maniResp = await fetch(url.replace(/\.h3f(\.gz)?$/, '.manifest.json'));
        manifest = await maniResp.json();
      } catch (e) {
        console.warn(`[LayerManager] Could not fetch manifest for ${url}, decodeH3Flex may fail.`);
      }
      data = await decodeH3Flex(buffer, manifest);

      // Style cascade: YAML > embedded > geometry-type default
      const styleSpec = await this._resolveStyle(options, url, data, 'h3f');
      const layerStyle = styleSpec.layers?.[0] || styleSpec;

      compiledStyle = StyleEngine.compileGPU(
        this._device,
        layerStyle,
        extractStyleDictionary(layerStyle, data)
      );
      renderer = new H3FlexRenderer(
        this._device,
        this._format,
        this._depthFormat,
        data,
        compiledStyle
      );
      if (options.extrusionScale !== undefined) {
        renderer.setExtrusionScale(options.extrusionScale);
      }
      this.totalFeatures += data.cellCount;
    } else if (type === 'gfb') {
      let manifest;
      try {
        const maniResp = await fetch(url.replace(/\.gfb(\.gz)?$/, '.manifest.json'));
        manifest = await maniResp.json();
      } catch (e) {
        console.warn(`[LayerManager] Could not fetch manifest for ${url}, decodeGFB may fail.`);
      }
      data = await decodeGFB(buffer, manifest);

      // Style cascade: YAML > embedded > geometry-type default
      const gt = data.geomType;
      const geomKind = gt === 1 || gt === 2 ? 'point' : gt === 3 || gt === 4 ? 'line' : 'polygon';
      const styleSpec = await this._resolveStyle(options, url, data, geomKind);
      const layerStyle = styleSpec.layers?.[0] || styleSpec;
      compiledStyle = StyleEngine.compileGPU(
        this._device,
        layerStyle,
        extractStyleDictionary(layerStyle, data)
      );

      // Auto-select renderer based on geometry type in the file header
      if (gt === 1 || gt === 2) {
        renderer = new GFBRenderer(
          this._device,
          this._format,
          this._depthFormat,
          data,
          compiledStyle
        );
      } else if (gt === 3 || gt === 4) {
        renderer = new GFBLineRenderer(
          this._device,
          this._format,
          this._depthFormat,
          data,
          compiledStyle
        );
      } else if (gt === 5 || gt === 6) {
        renderer = new GFBPolygonRenderer(
          this._device,
          this._format,
          this._depthFormat,
          data,
          compiledStyle
        );
      } else {
        throw new Error(`Unsupported GFB geometry type: ${gt}`);
      }
      // Apply extrusion scale if renderer supports it (polygon renderer)
      if (options.extrusionScale !== undefined && renderer.setExtrusionScale) {
        renderer.setExtrusionScale(options.extrusionScale);
      }
      // Apply symbol config from YAML if provided
      if (options.symbol?.type !== undefined && renderer.setSymbolType) {
        renderer.setSymbolType(options.symbol.type);
      }
      if (options.symbol?.scale && renderer.setSymbolScale) {
        renderer.setSymbolScale(options.symbol.scale);
      }
      if (options.symbol?.size && renderer.setBaseSize) {
        renderer.setBaseSize(options.symbol.size);
      }
      if (options.symbol?.zoomAttenuation && renderer.setZoomAttenuation) {
        renderer.setZoomAttenuation(options.symbol.zoomAttenuation);
      }
      this.totalFeatures += data.featureCount;
    } else if (type === 'mfb') {
      data = decodeMFB(buffer);
      renderer = new MFBDataSource(data);
      // MFB has no geometry — no style needed
    } else {
      throw new Error(`Unknown layer type: ${type}`);
    }

    // Track max epoch range for adaptive TimeController
    if (data.epochCount > 0) {
      this.maxEpochCount = Math.max(this.maxEpochCount, data.epochCount);
      this.maxEpochInterval = Math.max(this.maxEpochInterval, data.epochInterval);
    }
    // Default start hour for non-sharded layers
    if (this.startHourUTC === null) this.startHourUTC = 0;

    this.layers.set(name, {
      type,
      data,
      renderer,
      style: compiledStyle,
      visible: true,
      _yamlStyle: options.style || null, // Preserve original YAML spec for UI
      _metricStyleCache: new Map(),
    });

    const styleSource = compiledStyle
      ? options.style
        ? 'explicit'
        : data?.embeddedStyle
          ? 'embedded'
          : 'sidecar'
      : 'default';
    const count = data.cellCount || data.featureCount || data.entityCount || 0;
    const countLabel =
      type === 'h3f' || type === 'dgf' ? 'cells' : type === 'mfb' ? 'entities' : 'features';
  }

  /**
   * Load an MFB (MetricFlex Binary) layer from a manifest URL.
   * @param {string} name - Layer display name
   * @param {string} manifestUrl - URL to the .manifest.json file
   * @param {Object} [options]
   * @returns {Promise<void>}
   */
  async addMFBLayer(name, manifestUrl, options = {}) {
    const t0 = performance.now();

    // Loader owns manifest fetch + base decode + first-shard priming.
    // (decodeMFB orchestration relocated verbatim into MFBShards.load().)
    const loader = LoaderRegistry.create('mfb', manifestUrl, options);
    const data = await loader.load();
    const manifest = loader.manifest;

    // Only wire a per-frame sharded loader when the layer actually has shards;
    // a static single-file MFB keeps shardedLoader = null (as before).
    const shardedLoader = loader.hasShards ? loader : null;

    const renderer = new MFBDataSource(data);

    // Track max epoch range
    if (data.epochCount > 0) {
      this.maxEpochCount = Math.max(this.maxEpochCount, data.epochCount);
      this.maxEpochInterval = Math.max(this.maxEpochInterval, data.epochInterval);
    }
    if (this.startHourUTC === null) this.startHourUTC = 0;

    // Read startTimestamp from manifest
    if (manifest.startTimestamp != null) {
      this.startTimestamp =
        this.startTimestamp === null
          ? manifest.startTimestamp
          : Math.min(this.startTimestamp, manifest.startTimestamp);
    }

    this.layers.set(name, {
      type: 'mfb',
      data,
      renderer,
      style: undefined,
      visible: true,
      _yamlStyle: null,
      _manifest: manifest,
      shardedLoader,
      _metricStyleCache: new Map(),
    });

    console.debug(
      `static=[${Object.keys(data.staticColumns).join(',')}], temporal=[${Object.keys(data.temporalColumns).join(',')}]`
    );
  }

  /**
   * Load a sharded GFB layer from a manifest URL.
   * @param {string} name - Layer display name
   * @param {string} manifestUrl - URL to the .manifest.json file
   * @param {Object} [options] - { styleUrl, style }
   * @returns {Promise<void>}
   */
  async addShardedGFBLayer(name, manifestUrl, options = {}) {
    const t0 = performance.now();

    const loader = LoaderRegistry.create('gfb', manifestUrl);
    const data = await loader.load();

    // Style cascade: YAML > embedded > geometry-type default
    const baseUrl = manifestUrl.replace(/[^/]+$/, '') + loader.manifest.base;
    const styleSpec = await this._resolveStyle(options, baseUrl, data, 'point');
    const layerStyle = styleSpec.layers?.[0] || styleSpec;
    const compiledStyle = StyleEngine.compileGPU(
      this._device,
      layerStyle,
      extractStyleDictionary(layerStyle, data)
    );

    const renderer = new GFBRenderer(
      this._device,
      this._format,
      this._depthFormat,
      data,
      compiledStyle
    );
    if (options.extrusionScale !== undefined && renderer.setExtrusionScale) {
      renderer.setExtrusionScale(options.extrusionScale);
    }
    // Apply symbol config from YAML if provided
    if (options.symbol?.type !== undefined && renderer.setSymbolType) {
      renderer.setSymbolType(options.symbol.type);
    }
    if (options.symbol?.scale && renderer.setSymbolScale) {
      renderer.setSymbolScale(options.symbol.scale);
    }
    if (options.symbol?.size && renderer.setBaseSize) {
      renderer.setBaseSize(options.symbol.size);
    }
    if (options.symbol?.zoomAttenuation && renderer.setZoomAttenuation) {
      renderer.setZoomAttenuation(options.symbol.zoomAttenuation);
    }
    this.totalFeatures += data.featureCount;

    // Track max epoch range
    if (data.epochCount > 0) {
      this.maxEpochCount = Math.max(this.maxEpochCount, data.epochCount);
      this.maxEpochInterval = Math.max(this.maxEpochInterval, data.epochInterval);
    }
    if (this.startHourUTC === null) this.startHourUTC = 0;

    // Read startTimestamp from GFB manifest
    if (loader.manifest.startTimestamp != null) {
      this.startTimestamp =
        this.startTimestamp === null
          ? loader.manifest.startTimestamp
          : Math.min(this.startTimestamp, loader.manifest.startTimestamp);
    }

    // Set initial shard metadata on the renderer
    renderer.setShardMetadata(
      loader.manifest.shards[0].epochs[0],
      loader.manifest.shards[0].epochCount
    );

    this.layers.set(name, {
      type: 'gfb',
      data,
      renderer,
      style: compiledStyle,
      visible: true,
      shardedLoader: loader,
      activeMetric:
        options.activeMetric || options.style?.attribute || options.style?.color?.attribute || null,
      metricsMap: options.metrics || {},
      _yamlStyle: options.style || null,
      _manifest: loader.manifest,
      _metricStyleCache: new Map(),
    });

    console.debug(
      `${data.featureCount.toLocaleString()} features, ${data.epochCount} epochs, ` +
        `${loader.manifest.shards?.length ?? '?'} shards`
    );
  }

  /**
   * Load a streaming GFB layer from a manifest URL.
   * Uses ring buffer shard management with live polling.
   * @param {string} name - Layer display name
   * @param {string} manifestUrl - URL to the streaming manifest JSON
   * @param {Object} [options] - { style, ttl, pollInterval }
   * @returns {Promise<void>}
   */
  async addStreamingGFBLayer(name, manifestUrl, options = {}) {
    const t0 = performance.now();

    // Parse TTL and pollInterval from config options
    const loaderOpts = {};
    if (options.ttl) {
      const ttlMatch = options.ttl.match?.(/(\d+)\s*(s|m|h|d)?/i);
      if (ttlMatch) {
        const val = parseInt(ttlMatch[1], 10);
        const unit = (ttlMatch[2] || 's').toLowerCase();
        loaderOpts.ttlSeconds =
          unit === 'd' ? val * 86400 : unit === 'h' ? val * 3600 : unit === 'm' ? val * 60 : val;
      }
    }
    if (options.pollInterval) {
      const piMatch = options.pollInterval.match?.(/(\d+)\s*(ms|s|m)?/i);
      if (piMatch) {
        const val = parseInt(piMatch[1], 10);
        const unit = (piMatch[2] || 'ms').toLowerCase();
        loaderOpts.pollIntervalMs = unit === 'm' ? val * 60000 : unit === 's' ? val * 1000 : val;
      }
    }

    const loader = LoaderRegistry.create('gfb-stream', manifestUrl, loaderOpts);
    loader.onDataUpdated = () => {
      if (this.engine) this.engine.requestRender();
    };
    const data = await loader.load();

    // Style cascade
    const geomKind = 'point'; // Streaming GFB is always temporal points for now
    const styleSpec = await this._resolveStyle(options, manifestUrl, data, geomKind);
    const layerStyle = styleSpec.layers?.[0] || styleSpec;
    const compiledStyle = StyleEngine.compileGPU(
      this._device,
      layerStyle,
      extractStyleDictionary(layerStyle, data)
    );

    // Create renderer (use point renderer for temporal GFB)
    const renderer = new GFBRenderer(
      this._device,
      this._format,
      this._depthFormat,
      data,
      compiledStyle
    );

    console.debug(
      `colorType=${compiledStyle.color?.type}, ` +
        `dict=${data.dictionary?.length || 0} entries, ` +
        `symbol=${JSON.stringify(options.symbol || 'none')}, ` +
        `heading=${JSON.stringify(options.heading || 'none')}`
    );

    // Apply symbol config from YAML if provided
    if (options.symbol?.type !== undefined && renderer.setSymbolType) {
      renderer.setSymbolType(options.symbol.type);
    }
    if (options.symbol?.scale && renderer.setSymbolScale) {
      renderer.setSymbolScale(options.symbol.scale);
    }
    if (options.symbol?.size && renderer.setBaseSize) {
      renderer.setBaseSize(options.symbol.size);
    }
    if (options.symbol?.zoomAttenuation && renderer.setZoomAttenuation) {
      renderer.setZoomAttenuation(options.symbol.zoomAttenuation);
    }
    // Apply heading config from YAML (velocity column names for symbol rotation)
    if (options.heading) {
      renderer._ewVelocityCol = options.heading.ew || 'ewvelocity';
      renderer._nsVelocityCol = options.heading.ns || 'nsvelocity';
      // Re-check velocity availability with the explicit column names
      if (
        data.temporalColumns?.[renderer._ewVelocityCol] &&
        data.temporalColumns?.[renderer._nsVelocityCol]
      ) {
        renderer._hasVelocity = true;
      }
    }

    this.totalFeatures += data.featureCount;

    // Build metricsMap from style_presets so setActiveMetric can hot-swap the
    // correct domain/stops/colors for each metric without falling back to the
    // original loaded style.  Key by attribute name so the lookup at switch time
    // is O(1) regardless of how many presets are defined.
    const metricsMap = {};
    if (options.stylePresets) {
      for (const presetStyle of Object.values(options.stylePresets)) {
        if (presetStyle.attribute) {
          metricsMap[presetStyle.attribute] = { style: presetStyle };
        }
      }
    }

    this.layers.set(name, {
      type: 'gfb-streaming',
      data,
      renderer,
      style: compiledStyle,
      visible: true,
      streamingLoader: loader,
      _isStreaming: true,
      _yamlStyle: options.style || null,
      _manifest: loader.manifest,
      _metricStyleCache: new Map(),
      _metricAttributes: options.metricAttributes || null,
      metricsMap: Object.keys(metricsMap).length ? metricsMap : null,
    });

    console.debug(
      `${data.featureCount.toLocaleString()} features, ` +
        `${loader._ring.length} shards in ring, ` +
        `${loader._windowEpochCount} window epochs`
    );
  }

  /**
   * Load a sharded H3Flex layer from a manifest URL.
   * @param {string} name - Layer display name
   * @param {string} manifestUrl - URL to the .manifest.json file
   * @param {Object} [options] - { styleUrl, style }
   * @returns {Promise<void>}
   */
  async addShardedLayer(name, manifestUrl, options = {}) {
    const t0 = performance.now();

    const loaderOpts = {};
    if (options.maxResidentBytes != null) loaderOpts.maxResidentBytes = options.maxResidentBytes;
    const loader = LoaderRegistry.create('h3f', manifestUrl, loaderOpts);

    // Derive initial active metric from options or style config
    const initialMetric =
      options.activeMetric || options.style?.attribute || options.style?.color?.attribute;

    // Pass camera center for viewport-priority tile loading
    if (options.cameraCenter) {
      loader.cameraLatLon = options.cameraCenter;
    }

    const data = await loader.load(initialMetric);

    // Resolve style: explicit > sidecar > embedded > default
    const baseUrl = manifestUrl.replace(/[^/]+$/, '') + loader.manifest.base;

    // Per-metric style configs: { attrName: { style: {...} } }
    const metricsMap = options.metrics || {};
    // Use the metric the loader resolved (handles v3 + v2 + fallback)
    const activeMetric = initialMetric || loader.activeMetric || 'value';

    // Resolve style for active metric: per-metric > layer-level > sidecar > embedded
    let activeStyleSpec;
    if (metricsMap[activeMetric]?.style) {
      activeStyleSpec = metricsMap[activeMetric].style;
    } else {
      activeStyleSpec = await this._resolveStyle(options, baseUrl, data, 'h3f');
    }

    const layerStyle = activeStyleSpec.layers?.[0] || activeStyleSpec;
    const compiledStyle = StyleEngine.compileGPU(
      this._device,
      layerStyle,
      extractStyleDictionary(layerStyle, data)
    );
    const renderer = new H3FlexRenderer(
      this._device,
      this._format,
      this._depthFormat,
      data,
      compiledStyle
    );
    renderer.setActiveAttribute(activeMetric);

    // Wire progressive mesh loading: incremental GPU append (zero full-mesh copies)
    if (renderer.appendMeshData) {
      // Pre-allocate GPU buffers at estimated max size, preserving initial mesh
      loader.onPreAllocate = (maxVerts, maxIndices) => {
        renderer.positionBuffer?.destroy();
        renderer.cellIndexBuffer?.destroy();
        renderer.extrudeBuffer?.destroy();
        renderer.indexBuffer?.destroy();
        renderer._buildMesh(maxVerts, maxIndices);
      };
      // Per-batch incremental GPU write (only new tile data, ~2-20 MB)
      loader.onMeshAppend = (
        positions,
        cellIndices,
        extrudeFlags,
        indices,
        vertexOffset,
        indexOffset,
        totalIndexCount
      ) => {
        renderer.appendMeshData(
          positions,
          cellIndices,
          extrudeFlags,
          indices,
          vertexOffset,
          indexOffset,
          totalIndexCount
        );
      };
    } else if (renderer.updateMesh) {
      // Fallback for WebGL2: full mesh swap
      loader.onMeshUpdate = (newMesh) => renderer.updateMesh(newMesh);
    }

    // Apply extrusion scale from config options
    if (options.extrusionScale !== undefined) {
      renderer.setExtrusionScale(options.extrusionScale);
    }

    this.totalFeatures += data.cellCount;

    // Track max epoch range and start time
    if (data.epochCount > 0) {
      this.maxEpochCount = Math.max(this.maxEpochCount, data.epochCount);
      this.maxEpochInterval = Math.max(this.maxEpochInterval, data.epochInterval);
    }
    // Get startHourUTC from manifest
    const manifestStart = loader.manifest.startHourUTC ?? 0;
    this.startHourUTC =
      this.startHourUTC === null ? manifestStart : Math.min(this.startHourUTC, manifestStart);

    // Read startTimestamp from H3F manifest
    if (loader.manifest.startTimestamp != null) {
      this.startTimestamp =
        this.startTimestamp === null
          ? loader.manifest.startTimestamp
          : Math.min(this.startTimestamp, loader.manifest.startTimestamp);
    }

    this.layers.set(name, {
      type: 'h3f',
      data,
      renderer,
      style: compiledStyle,
      visible: true,
      shardedLoader: loader,
      metricsMap,
      activeMetric,
      _yamlStyle: options.style || null,
      _manifest: loader.manifest,
      _metricStyleCache: new Map(),
    });

    // v3 manifests store shards inside temporalAttributes[i].shards (no top-level shards).
    const shardList = loader._getShardList?.() ?? loader.manifest.shards ?? [];
    console.debug(
      `${data.cellCount.toLocaleString()} cells, ${data.epochCount} epochs, ` +
        `${shardList.length} shards, metric=${activeMetric}`
    );
  }

  async addShardedDGFlexLayer(name, manifestUrl, options = {}) {
    const t0 = performance.now();

    const loaderOpts = {};
    if (options.maxResidentBytes != null) loaderOpts.maxResidentBytes = options.maxResidentBytes;
    const loader = LoaderRegistry.create('dgf', manifestUrl, loaderOpts);

    // Derive initial active metric from options or style config
    const initialMetric =
      options.activeMetric || options.style?.attribute || options.style?.color?.attribute;

    // Pass camera center for viewport-priority tile loading
    if (options.cameraCenter) {
      loader.cameraLatLon = options.cameraCenter;
    }

    const data = await loader.load(initialMetric);

    // Resolve style: explicit > sidecar > embedded > default
    const baseUrl = manifestUrl.replace(/[^/]+$/, '') + loader.manifest.base;

    // Per-metric style configs: { attrName: { style: {...} } }
    const metricsMap = options.metrics || {};
    // Use the metric the loader resolved (handles v3 + v2 + fallback)
    const activeMetric = initialMetric || loader.activeMetric || 'value';

    // Resolve style for active metric: per-metric > layer-level > sidecar > embedded
    let activeStyleSpec;
    if (metricsMap[activeMetric]?.style) {
      activeStyleSpec = metricsMap[activeMetric].style;
    } else {
      activeStyleSpec = await this._resolveStyle(options, baseUrl, data, 'dgf');
    }

    const layerStyle = activeStyleSpec.layers?.[0] || activeStyleSpec;
    const compiledStyle = StyleEngine.compileGPU(
      this._device,
      layerStyle,
      extractStyleDictionary(layerStyle, data)
    );
    const renderer = new DGFlexRenderer(
      this._device,
      this._format,
      this._depthFormat,
      data,
      compiledStyle
    );
    renderer.setActiveAttribute(activeMetric);

    // Wire progressive mesh loading: incremental GPU append (zero full-mesh copies)
    if (renderer.appendMeshData) {
      // Pre-allocate GPU buffers at estimated max size, preserving initial mesh
      loader.onPreAllocate = (maxVerts, maxIndices) => {
        renderer.positionBuffer?.destroy();
        renderer.cellIndexBuffer?.destroy();
        renderer.extrudeBuffer?.destroy();
        renderer.indexBuffer?.destroy();
        renderer._buildMesh(maxVerts, maxIndices);
      };
      // Per-batch incremental GPU write (only new tile data, ~2-20 MB)
      loader.onMeshAppend = (
        positions,
        cellIndices,
        extrudeFlags,
        indices,
        vertexOffset,
        indexOffset,
        totalIndexCount
      ) => {
        renderer.appendMeshData(
          positions,
          cellIndices,
          extrudeFlags,
          indices,
          vertexOffset,
          indexOffset,
          totalIndexCount
        );
      };
    } else if (renderer.updateMesh) {
      // Fallback for WebGL2: full mesh swap
      loader.onMeshUpdate = (newMesh) => renderer.updateMesh(newMesh);
    }

    // Apply extrusion scale from config options
    if (options.extrusionScale !== undefined) {
      renderer.setExtrusionScale(options.extrusionScale);
    }

    this.totalFeatures += data.cellCount;

    // Track max epoch range and start time
    if (data.epochCount > 0) {
      this.maxEpochCount = Math.max(this.maxEpochCount, data.epochCount);
      this.maxEpochInterval = Math.max(this.maxEpochInterval, data.epochInterval);
    }
    // Get startHourUTC from manifest
    const manifestStart = loader.manifest.startHourUTC ?? 0;
    this.startHourUTC =
      this.startHourUTC === null ? manifestStart : Math.min(this.startHourUTC, manifestStart);

    // Read startTimestamp from DGFlex manifest
    if (loader.manifest.startTimestamp != null) {
      this.startTimestamp =
        this.startTimestamp === null
          ? loader.manifest.startTimestamp
          : Math.min(this.startTimestamp, loader.manifest.startTimestamp);
    }

    this.layers.set(name, {
      type: 'dgf',
      data,
      renderer,
      style: compiledStyle,
      visible: true,
      shardedLoader: loader,
      metricsMap,
      activeMetric,
      _yamlStyle: options.style || null,
      _manifest: loader.manifest,
      _metricStyleCache: new Map(),
    });

    // v3 manifests store shards inside temporalAttributes[i].shards (no top-level shards).
    const shardList = loader._getShardList?.() ?? loader.manifest.shards ?? [];
    console.debug(
      `${data.cellCount.toLocaleString()} cells, ${data.epochCount} epochs, ` +
        `${shardList.length} shards, metric=${activeMetric}`
    );
  }

  /**
   * Hot-swap the style for a named layer at runtime.
   * @param {string} name - Layer name
   * @param {Object} styleSpec - Style spec (from JSON or programmatic API)
   */
  setLayerStyle(name, styleSpec) {
    const layer = this.layers.get(name);
    if (!layer) return;

    const compiled = StyleEngine.compileGPU(
      this._device,
      styleSpec,
      extractStyleDictionary(styleSpec, layer.data)
    );
    layer.renderer.setStyle(compiled);
    layer.style = compiled;
    // Remember the programmatic spec (uncompiled) so engine.getState() can
    // round-trip style adjustments to already-loaded layers.
    layer._appliedStyleSpec = styleSpec;

    // Full style replacement invalidates all per-metric cached styles since
    // the new spec may apply to all metrics (e.g. a layer-wide ramp change).
    layer._metricStyleCache?.clear();

    this._styleVersion++;
  }

  /**
   * Apply a uniform (constant) color to a named layer.
   * @param {string} name - Layer name
   * @param {string|number[]} color - Hex color string or [r,g,b] / [r,g,b,a] float array
   * @param {number} [opacity] - Opacity in [0, 1]. Defaults to layer's current opacity.
   */
  setLayerUniformColor(name, color, opacity) {
    const layer = this.layers.get(name);
    if (!layer) {
      console.warn(`[LayerManager] setLayerUniformColor: unknown layer "${name}"`);
      return;
    }

    let hexColor;
    if (typeof color === 'string') {
      hexColor = color;
    } else if (Array.isArray(color) && color.length >= 3) {
      const r = Math.round(Math.max(0, Math.min(1, color[0])) * 255)
        .toString(16)
        .padStart(2, '0');
      const g = Math.round(Math.max(0, Math.min(1, color[1])) * 255)
        .toString(16)
        .padStart(2, '0');
      const b = Math.round(Math.max(0, Math.min(1, color[2])) * 255)
        .toString(16)
        .padStart(2, '0');
      hexColor = `#${r}${g}${b}`;
      if (opacity === undefined && color[3] !== undefined) opacity = color[3];
    } else {
      console.warn('[LayerManager] setLayerUniformColor: invalid color', color);
      return;
    }

    const resolvedOpacity = opacity ?? layer.style?.opacity?.value ?? 1.0;
    this.setLayerStyle(name, { type: 'constant', color: hexColor, opacity: resolvedOpacity });
  }

  /**
   * GPU-first color ramp update — writes new stops into the existing 256×1 RGBA
   * texture without a shader recompile or full style rebuild. Both backends use
   * an in-place write: WebGL2 via texSubImage2D, WebGPU via queue.writeTexture().
   * Cost: ~0.1ms CPU + 1 KB GPU upload.
   *
   * Each stop can carry an optional `opacity` field (0..1). When present,
   * these are compiled into the texture's alpha channel as graduated transparency.
   *
   * @param {string} name - Layer name
   * @param {Object[]} stops - Array of { value, color, opacity? } stop definitions
   * @param {number[]} domain - [min, max] value range
   */
  updateLayerRamp(name, stops, domain) {
    const layer = this.layers.get(name);
    if (!layer?.style) return;

    // Derive opacityStops from per-stop opacity if any stop has it
    let opacityStops = null;
    if (stops.some((s) => s.opacity !== undefined)) {
      opacityStops = stops.map((s) => ({
        value: s.value,
        opacity: s.opacity ?? 1.0,
      }));
    }

    {
      // Full style recompile to apply the new ramp (no texSubImage2D path).
      // Still <1ms for a 256×1 texture.
      const spec = StyleEngine.ramp({
        attribute: layer.style?.color?.attribute || 'value',
        domain,
        stops,
        opacity: layer.style?.opacity?.value ?? 1.0,
        opacityStops: opacityStops || undefined,
      });
      const compiled = StyleEngine.compileGPU(
        this._device,
        spec,
        extractStyleDictionary(spec, layer.data)
      );
      layer.renderer.setStyle(compiled);
      layer.style = compiled;
    }

    // Evict the cached compiled style for the active metric so the next time
    // the user switches away and back they get the updated ramp rather than
    // the pre-edit snapshot.  The cache entry for other metrics is unaffected.
    layer._metricStyleCache?.delete(layer.activeMetric);

    // Persist for getLayerInfo() so the UI stays in sync
    layer._userStops = stops;
    layer._userDomain = domain;
    this._styleVersion++;
  }

  /**
   * Internal: Load and concatenate tiles for a virtual H3 layer.
   * Uses tile.manifest.json for discovery and decodeH3Mesh for lightweight geometry.
   */
  async addVirtualH3Layer(name, options) {
    const resolution = options.resolution ?? 5;
    const metrics = options.metrics || [];
    const activeMetric = options.activeMetric || metrics[0] || 'value';
    const epochIntervalSeconds = options.epochIntervalSeconds || 60;
    const metricsStyles = options.metrics_styles || {};

    // 1. Load the H3 mesh tiles — these are H3M2 format (not SHD3), containing
    //    embedded cellIds. decodeH3Mesh() handles H3M1/H3M2 directly with pure
    //    typed-array reads — no JSON parsing, no column maps.
    //    Load tiles.manifest.json to discover tiles, then fetch all in parallel.
    const meshDir = options.meshUrl || `/meshes/h3-l${resolution}`;
    const tileManifestUrl = `${meshDir}/tiles.manifest.json`;

    console.debug(`[LayerManager] h3f-virtual: loading tile manifest from ${tileManifestUrl}`);
    const tileManifestResp = await fetch(tileManifestUrl);
    if (!tileManifestResp.ok)
      throw new Error(`[LayerManager] H3 tile manifest not found: ${tileManifestUrl}`);
    const tileManifest = await tileManifestResp.json();

    // Fetch + decode all tiles in parallel using the lightweight H3Mesh decoder
    // Uses shared IndexedDB MeshCache to avoid re-downloading on repeat visits.
    let cacheHits = 0,
      cacheMisses = 0;
    const tileResults = await Promise.all(
      tileManifest.tiles.map(async (tile) => {
        const tileUrl = `${meshDir}/${tile.file}`;

        // Check IndexedDB cache first
        let buf = await getMeshFromCache(tileUrl);
        if (buf) {
          cacheHits++;
        } else {
          cacheMisses++;
          const resp = await fetch(tileUrl);
          if (!resp.ok) throw new Error(`[LayerManager] Mesh tile not found: ${tileUrl}`);
          buf = await resp.arrayBuffer();
          const hdr = new Uint8Array(buf, 0, 2);
          if (hdr[0] === 0x1f && hdr[1] === 0x8b) {
            const ds = new DecompressionStream('gzip');
            buf = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
          }
          // Store decompressed buffer in cache for next visit
          await putMeshInCache(tileUrl, buf);
        }
        return decodeH3Mesh(buf);
      })
    );
    console.debug(
      `[VirtualH3] Mesh tiles: ${cacheHits} from IndexedDB cache, ${cacheMisses} fetched from network`
    );

    // 2. Concatenate cellIds and mesh arrays across all tiles.
    // IMPORTANT: cellIndices in each tile are LOCAL (0..tile.cellCount-1).
    // When concatenating, add cOff to each vertex's cell index so the GPU
    // reads from the correct slot in the global per-cell data texture.
    const cellCount = tileResults.reduce((s, t) => s + (t.cellCount || 0), 0);
    if (cellCount === 0)
      throw new Error('[LayerManager] h3f-virtual: mesh tiles decoded with zero cells');

    const cellIds = new BigUint64Array(cellCount);
    const totalVerts = tileResults.reduce((s, t) => s + (t.vertexCount || 0), 0);
    const totalIdxs = tileResults.reduce((s, t) => s + (t.indexCount || 0), 0);
    const positions = new Float32Array(totalVerts * 3);
    const cellIndices = new Float32Array(totalVerts);
    const extrudeFlags = new Float32Array(totalVerts);
    const indices = new Uint32Array(totalIdxs);

    let cOff = 0,
      vOff = 0,
      iOff = 0,
      vBase = 0;
    for (const t of tileResults) {
      if (t.cellIds) cellIds.set(t.cellIds, cOff);
      positions.set(t.positions, vOff * 3);
      extrudeFlags.set(t.extrudeFlags, vOff);
      // Offset each vertex's local cell index into the global address space
      for (let i = 0; i < t.vertexCount; i++) {
        cellIndices[vOff + i] = t.cellIndices[i] + cOff;
      }
      // Offset triangle indices into the global vertex buffer
      for (let i = 0; i < t.indexCount; i++) indices[iOff + i] = t.indices[i] + vBase;
      cOff += t.cellCount;
      vOff += t.vertexCount;
      iOff += t.indexCount;
      vBase += t.vertexCount;
    }

    const mesh = {
      positions,
      cellIndices,
      extrudeFlags,
      indices,
      vertexCount: totalVerts,
      indexCount: totalIdxs,
    };
    console.debug(
      `[VirtualH3] mesh ready: ${cellCount.toLocaleString()} cells, ${totalVerts.toLocaleString()} verts, ${totalIdxs.toLocaleString()} indices`
    );

    // 3. Build a data object that reuses the decoded mesh geometry.
    //    epochCount MUST be 1: the renderer reads temporalColumns[m][0..cellCount].
    //    VirtualH3Loader overwrites that buffer in-place on each tick.
    const data = {
      cellCount,
      mesh,
      hasMesh: true,
      cellIds,
      epochCount: 1,
      epochInterval: epochIntervalSeconds,
      temporalAttributes: metrics.map((m) => ({ name: m })),
      staticColumns: {},
      temporalColumns: Object.fromEntries(
        metrics.map((m) => [m, new Float32Array(cellCount).fill(0)])
      ),
      dictionaries: {},
      dictionary: [],
      schema: [],
    };

    // 4. Compile style for the active metric
    const layerStyleSpec = options.style || metricsStyles[activeMetric]?.style || null;
    const layerStyle = layerStyleSpec || StyleEngine.ramp(defaultH3StyleSpec(activeMetric));

    const compiledStyle = StyleEngine.compileGPU(this._device, layerStyle, []);
    const renderer = new H3FlexRenderer(
      this._device,
      this._format,
      this._depthFormat,
      data,
      compiledStyle
    );
    renderer.setActiveAttribute(activeMetric);
    if (options.extrusionScale !== undefined) renderer.setExtrusionScale(options.extrusionScale);

    // 5. Set up the VirtualH3Loader
    const loader = new VirtualH3Loader({
      flexdbUrl: options.flexdbUrl,
      table: options.table,
      h3Field: options.h3Field || `h3_${resolution}`,
      metrics,
      aggregation: options.aggregation || 'SUM',
      epochIntervalSeconds,
      epochCacheSize: options.epochCacheSize || 30,
      extraWhere: options.extraWhere || null,
    });
    loader.init(cellIds);

    this.layers.set(name, {
      type: 'h3f-virtual',
      data,
      renderer,
      style: compiledStyle,
      visible: true,
      virtualLoader: loader,
      virtualState: {
        lastEpoch: -1,
        activeMetric,
        lastProbeTime: 0,
        isProbing: false,
      },
      metricsMap: Object.fromEntries(
        metrics.map((m) => [m, { style: metricsStyles[m]?.style || options.style || null }])
      ),
      activeMetric,
      _yamlStyle: options.style || null,
      _metricStyleCache: new Map(),
    });

    if (options.findLatest) {
      console.log(`[VirtualH3] Layer "${name}" dynamic sync: discovering latest epoch...`);
      try {
        const latest = await loader.getLatestEpoch();
        if (latest > 0) {
          // Snap the engine time to this discovered point.
          // `latest` is the START of the latest epoch (MAX(_epoch) * interval).
          // The live edge boundary is one interval PAST that (the point where
          // data is no longer available), so the TimeController's -1 index
          // resolves to exactly `latest`.
          if (this.time?.advanceLiveEdge) {
            const windowSec = (options.epochWindowMinutes ?? 1440) * 60;
            const totalEpochs = Math.round(windowSec / epochIntervalSeconds);
            const liveEdge = latest + epochIntervalSeconds;
            this.time.advanceLiveEdge(liveEdge, liveEdge - windowSec, totalEpochs);
          }
        }
      } catch (err) {
        console.warn(`[VirtualH3] Failed to discover latest epoch for "${name}":`, err);
      }

      // Setup background live polling interval decoupled from GPU render loop
      const vs = this.layers.get(name).virtualState;
      vs.intervalId = setInterval(() => {
        // Don't probe in a hidden tab — avoids spurious dirty wakeups
        // that would light up the render loop immediately on tab restore.
        if (typeof document !== 'undefined' && document.hidden) return;

        const isLive = this.time ? this.time.mode === 'live' && this.time.isFollowingLive : true;
        if (!isLive || vs.isProbing) return;

        vs.isProbing = true;
        loader
          .getLatestEpoch()
          .then((newLatest) => {
            const currentEnd = this.time ? this.time._liveEdgeTimeSec : 0;
            console.log(
              `[VirtualH3] Background heartbeat complete. Latest DB: ${newLatest}. Global UI: ${currentEnd}.`
            );
            const newLiveEdge = newLatest + epochIntervalSeconds;
            if (newLiveEdge > currentEnd) {
              console.log(
                `[VirtualH3] 👉 BACKGROUND PROBE DISCOVERED NEWER EPOCH: ${newLatest} (was ${currentEnd})`
              );
              if (this.time && this.time.advanceLiveEdge) {
                const windowSec = (options.epochWindowMinutes ?? 1440) * 60;
                const totalEpochs = Math.round(windowSec / epochIntervalSeconds);
                this.time.advanceLiveEdge(newLiveEdge, newLiveEdge - windowSec, totalEpochs);
                // Wake up the idle rendering engine
                this.dirty = true;
              }
            }
          })
          .catch(() => {})
          .finally(() => {
            vs.isProbing = false;
          });
      }, 15000);
    }

    this.dirty = true;
    this.maxEpochCount = Math.max(this.maxEpochCount, data.epochCount);
    this.maxEpochInterval = Math.max(this.maxEpochInterval, data.epochInterval);

    const activeStyleSpec = layerStyle;
    const styleInfo = `domain=[${activeStyleSpec.domain}] stops=${activeStyleSpec.stops?.length || 0} opacityStops=${activeStyleSpec.opacityStops?.length || 0}`;
    console.log(
      `[VirtualH3] Layer "${name}" ready — ${cellCount.toLocaleString()} cells, metrics=[${metrics.join(',')}], activeMetric=${activeMetric}, ${styleInfo}`
    );
    console.log(
      `[VirtualH3] FlexDB: ${options.flexdbUrl} | table: ${options.table} | h3Field: ${options.h3Field || `h3_${resolution}`} | epochInterval: ${epochIntervalSeconds}s`
    );
  }

  /**
   * Switch the active metric for a named H3 layer.
   * Triggers on-demand shard loading for the new metric (v3).
   * @param {string} layerName - Layer name
   * @param {string} metricName - Temporal attribute name
   */
  async setActiveMetric(layerName, metricName) {
    const layer = this.layers.get(layerName);
    if (!layer) return;

    layer.activeMetric = metricName;

    // Clear any user-edited ramp overrides so the new metric's configured style
    // (from metricsMap, _yamlStyle, or embedded) takes precedence.  Without this
    // the old metric's ramp stays in _userStops and getLayerInfo() returns it as
    // the highest-priority source, making the Layer Manager and the Symbology
    // dialog show the wrong stops/domain for the new metric.
    layer._userStops = null;
    layer._userDomain = null;

    // v3: loader fetches the new metric's shard files on demand
    if (layer.shardedLoader?.switchMetric) {
      await layer.shardedLoader.switchMetric(metricName);
    }

    // Switch the renderer's active attribute and force texture reload
    if (layer.renderer) {
      layer.renderer.setActiveAttribute(metricName);
      if (layer.renderer.forceAmortizedReload) layer.renderer.forceAmortizedReload();
    }

    // Return cached compiled style to avoid redundant StyleEngine.compileGPU() on revisits.
    if (layer._metricStyleCache?.has(metricName)) {
      const cached = layer._metricStyleCache.get(metricName);
      if (layer.renderer) layer.renderer.setStyle(cached);
      layer.style = cached;
      this._styleVersion++;
      return;
    }

    // Hot-swap style: per-metric style > base YAML/embedded style > no-op
    if (layer.metricsMap?.[metricName]?.style) {
      // Per-metric style explicitly configured in YAML metricsMap
      const styleSpec = layer.metricsMap[metricName].style;
      const layerStyle = styleSpec.layers?.[0] || styleSpec;
      const compiled = StyleEngine.compileGPU(
        this._device,
        layerStyle,
        extractStyleDictionary(layerStyle, layer.data)
      );
      if (layer.renderer) layer.renderer.setStyle(compiled);
      layer.style = compiled;
    } else {
      // No per-metric style: recompile from the embedded style, searching
      // embeddedStyle.layers[] by attribute name so each metric gets its own
      // domain/stops.  Falling back to layers[0] (the old behaviour) caused
      // every metric except the first to receive the wrong ramp.
      const embeddedLayers = layer.data.embeddedStyle?.layers;
      const metricLayer = embeddedLayers?.find((l) => l.attribute === metricName);
      const base =
        layer._yamlStyle || metricLayer || embeddedLayers?.[0] || layer.data.embeddedStyle || null;
      const styleBase = base ? base.style || base : null;
      if (styleBase?.stops) {
        const spec = StyleEngine.ramp({
          attribute: metricName,
          domain: styleBase.domain || layer.style?.color?.domain || [0, 1],
          stops: styleBase.stops,
          opacity: styleBase.opacity ?? 1.0,
          opacityStops: styleBase.opacityStops,
        });
        const compiled = StyleEngine.compileGPU(
          this._device,
          spec,
          extractStyleDictionary(spec, layer.data)
        );
        if (layer.renderer) layer.renderer.setStyle(compiled);
        layer.style = compiled;
      } else if (layer.style?.color) {
        // Even simpler fallback: patch just the attribute on the existing spec
        // and recompile so the domain/stops are preserved but the column name updates.
        const existingSpec = {
          color: { ...layer.style.color, attribute: metricName },
          opacity: layer.style.opacity,
        };
        const compiled = StyleEngine.compileGPU(
          this._device,
          existingSpec,
          extractStyleDictionary(existingSpec, layer.data)
        );
        if (layer.renderer) layer.renderer.setStyle(compiled);
        layer.style = compiled;
      }
    }

    // Store the freshly compiled style in the per-metric cache for future switches.
    if (layer.style) {
      layer._metricStyleCache.set(metricName, layer.style);
    }

    // Notify UI components (LegendPanel, etc.) that the style has changed.
    this._styleVersion++;
  }

  /**
   * Apply a GPU filter to a named layer using a query string.
   * Non-matching cells are discarded in the fragment shader.
   *
   * @param {string} layerName - Layer name
   * @param {string} queryString - Filter expression (e.g. "served_mbps > 50")
   */
  setFilter(layerName, queryString) {
    const layer = this.layers.get(layerName);
    if (!layer) return;

    if (!queryString || !queryString.trim()) {
      this.clearFilter(layerName);
      return;
    }

    // MFB layers: no GPU renderer — store filter string for data-level filtering
    if (layer.type === 'mfb') {
      layer.activeFilter = queryString;
      return;
    }

    // Build schema context for the parser
    const schema = {
      staticColumns: layer.data.staticColumns || {},
      temporalColumns: layer.data.temporalColumns || {},
      dictionary: layer.data.dictionary || [],
      schemaList: layer.data.schema || [],
    };

    const parsed = parseQuery(queryString, schema);
    if (!parsed) {
      console.warn(`[LayerManager] Invalid filter query: "${queryString}"`);
      return;
    }

    const gpuFilter = flattenForGPU(parsed);
    if (!gpuFilter) {
      this.clearFilter(layerName);
      return;
    }

    // GPU layers get GPU-side filter
    if (layer.renderer?.setFilter) {
      layer.renderer.setFilter(gpuFilter);
    }
    layer.activeFilter = queryString;
    this.dirty = true;
  }

  /**
   * Clear a GPU filter from a named layer.
   * @param {string} layerName - Layer name
   */
  clearFilter(layerName) {
    const layer = this.layers.get(layerName);
    if (!layer) return;

    if (layer.renderer?.clearFilter) {
      layer.renderer.clearFilter();
    }
    layer.activeFilter = null;
    this.dirty = true;
  }

  /**
   * Style resolution cascade:
   *   1. YAML config (options.style)
   *   2. Embedded style in data format
   *   3. Geometry-type default
   *
   * @param {Object} options
   * @param {string} dataUrl
   * @param {Object} data
   * @param {'point'|'line'|'polygon'|'h3f'} geomKind
   * @returns {Object} Always returns a valid style spec (never null)
   */
  async _resolveStyle(options, dataUrl, data, geomKind = 'point') {
    // 1. Explicit YAML style (highest priority)
    if (options.style) return options.style;
    if (options.styles?.length) return options.styles[0];

    // 2. Explicit style URL
    if (options.styleUrl) {
      const fetched = await this._fetchStyle(options.styleUrl);
      if (fetched) return fetched;
    }

    // 3. Convention: try {dataUrl}.style.json sidecar
    const sidecarUrl = dataUrl.replace(/\.[^.]+$/, '') + '.style.json';
    const sidecar = await this._fetchStyle(sidecarUrl);
    if (sidecar) return sidecar;

    // 4. Embedded style in data file
    if (data?.embeddedStyle) {
      return data.embeddedStyle;
    }

    // 5. Geometry-type default
    return LayerManager._defaultStyle(geomKind);
  }

  /**
   * Default style specs per geometry type.
   * Used when no YAML config, sidecar, or embedded style exists.
   */
  static _defaultStyle(geomKind) {
    switch (geomKind) {
      case 'point':
        return { type: 'constant', color: '#00BFE6', opacity: 0.9 };
      case 'line':
        return { type: 'constant', color: '#4A90D9', opacity: 0.8, width: 2 };
      case 'polygon':
        return { type: 'constant', color: '#2E8B57', opacity: 0.6 };
      case 'h3f':
        return {
          type: 'ramp',
          attribute: '_value',
          domain: [0, 1],
          stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319'],
          opacity: 0.7,
        };
      default:
        return { type: 'constant', color: '#00BFE6', opacity: 0.9 };
    }
  }

  async _fetchStyle(url) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const spec = await resp.json();
        return spec;
      }
    } catch (e) {
      // Style not found — use default
    }
    return null;
  }

  /**
   * Add an in-memory GeoJSON sub-layer without fetching any URL.
   * Constructs the appropriate renderer directly from pre-parsed data.
   *
   * @param {string} name - Layer display name
   * @param {'points'|'lines'|'polygons'} kind - Geometry kind
   * @param {object} data - Decoded data from geojsonToFeatures()
   * @param {object} [opts] - { style }
   */
  addInMemoryLayer(name, kind, data, opts = {}) {
    const geomKindMap = { points: 'point', lines: 'line', polygons: 'polygon' };
    const geomKind = geomKindMap[kind] || 'point';

    const styleSpec = opts.style || LayerManager._defaultStyle(geomKind);
    const compiledStyle = StyleEngine.compileGPU(
      this._device,
      styleSpec,
      extractStyleDictionary(styleSpec, data)
    );

    let renderer;
    const gt = data.geomType;
    if (gt === 1 || gt === 2) {
      renderer = new GFBRenderer(
        this._device,
        this._format,
        this._depthFormat,
        data,
        compiledStyle
      );
    } else if (gt === 3 || gt === 4) {
      renderer = new GFBLineRenderer(
        this._device,
        this._format,
        this._depthFormat,
        data,
        compiledStyle
      );
    } else if (gt === 5 || gt === 6) {
      renderer = new GFBPolygonRenderer(
        this._device,
        this._format,
        this._depthFormat,
        data,
        compiledStyle
      );
    } else {
      throw new Error(`addInMemoryLayer: unsupported geomType ${gt}`);
    }

    this.totalFeatures += data.featureCount;
    this.layers.set(name, {
      type: 'geojson',
      kind,
      data,
      renderer,
      style: compiledStyle,
      visible: true,
      _yamlStyle: opts.style || null,
      _metricStyleCache: new Map(),
      _isGeoJSON: true,
    });
    this._styleVersion++;
  }

  /**
   * Remove a layer and free GPU resources.
   */
  removeLayer(name) {
    const layer = this.layers.get(name);
    if (layer) {
      // Release GPU resources
      if (layer.renderer?.dispose) layer.renderer.dispose();
      if (layer.style) {
        layer.style.disposeGPU();
      }
      // Release shard memory
      if (layer.shardedLoader?.destroy) layer.shardedLoader.destroy();
      if (layer.streamingLoader?.destroy) layer.streamingLoader.destroy();
      if (layer.virtualLoader?.dispose) layer.virtualLoader.dispose();
      // Clear polling timers
      if (layer.virtualState?.intervalId) {
        clearInterval(layer.virtualState.intervalId);
      }
      this.layers.delete(name);
      this.dirty = true;
    }
  }

  /**
   * Pre-render compute pass: update shard loaders, compute effectiveTime,
   * and dispatch H3 compute shaders. Must be called on the commandEncoder
   * BEFORE beginRenderPass().
   */
  prepareH3Compute(commandEncoder, normalizedTime, playbackSpeed = 60, lookPoint = null) {
    const effectiveTime = normalizedTime;

    // ─── Phase 1a: Update all loaders ───
    // Reset transition frame flag from previous frame.
    // This flag persists through chart rendering on the transition frame,
    // then gets cleared here at the start of the next frame.
    this._shardTransitionFrame = false;
    for (const [name, layer] of this.layers) {
      if (!layer.visible) continue;

      // Sharded loaders (H3F, GFB, MFB)
      if (layer.shardedLoader) {
        layer.shardedLoader.baseData._playbackSpeed = playbackSpeed;
        layer.shardedLoader.updateForTime(normalizedTime);
        if (lookPoint && layer.shardedLoader.updateCamera) {
          layer.shardedLoader.updateCamera(lookPoint[0], lookPoint[1]);
        }
      }

      // Streaming loaders (GFB-streaming)
      if (layer.streamingLoader) {
        layer.streamingLoader.updateForTime(normalizedTime);
      }
    }

    // Virtual H3 compute pass
    for (const [name, layer] of this.layers.entries()) {
      if (layer.type === 'h3f-virtual' && layer.visible) {
        const vs = layer.virtualState;
        const nowSec = Math.floor(Date.now() / 1000);
        const interval = layer.data.epochInterval;

        // Determine current active epoch
        const currentEpoch = this.time
          ? this.time.getCurrentEpoch()
          : Math.floor(nowSec / interval) * interval;

        // If time has actually shifted to a new minute (or probe found new data), fetch it
        if (currentEpoch !== vs.lastEpoch) {
          vs.lastEpoch = currentEpoch;
          const bin = Math.floor(currentEpoch / interval);
          console.log(`[VirtualH3] Tick: requesting data for epoch ${currentEpoch} (bin=${bin})`);

          const self = this;
          layer.virtualLoader
            .fetchEpoch(currentEpoch)
            .then((frame) => {
              if (!frame) return;
              let updated = 0;
              for (const m of Object.keys(layer.data.temporalColumns)) {
                const slice = frame[m];
                if (slice) {
                  layer.data.temporalColumns[m].set(slice.subarray(0, layer.data.cellCount));
                  updated++;
                }
              }
              if (updated > 0 && layer.renderer?._currentEpoch !== undefined) {
                layer.renderer._currentEpoch = -1; // force texture re-upload
              }
              if (self.engine) self.engine.requestRender();
            })
            .catch((err) => {
              console.error(`[VirtualH3] Fetch failed for epoch ${currentEpoch}:`, err);
            });
        }
      }
    }

    // Phase 1c: Pre-upload pending textures (H3F and GFB)
    // (Removed: Direct O(1) writes make pre-uploads and spare textures obsolete)

    // ─── Phase 2 + 3: Apply shard changes + dispatch compute/texture uploads ───
    // ALL texture data must be ready BEFORE beginRenderPass().
    for (const [name, layer] of this.layers) {
      if (!layer.visible) continue;

      if (
        (layer.type.startsWith('h3f') || layer.type === 'dgf') &&
        layer.shardedLoader?._shardDirty
      ) {
        if (layer.renderer?._initShardMetadata) {
          layer.renderer._initShardMetadata();
        }
        layer.shardedLoader._shardDirty = false;
        // Persistent flag: survives through chart render (unlike _shardDirty).
        // Reset at the START of the next prepareH3Compute call.
        this._shardTransitionFrame = true;
      }
      if (
        (layer.type.startsWith('h3f') || layer.type === 'dgf') &&
        layer.shardedLoader?._boundaryDirty
      ) {
        layer.shardedLoader._boundaryDirty = false;
      }

      // GFB shard dirty + texture preparation (before render pass)
      if (layer.type === 'gfb' && layer.shardedLoader?._shardDirty) {
        if (layer.renderer?.setShardMetadata) {
          layer.renderer.setShardMetadata();
        }
        if (layer.renderer?.updateValueBuffer) {
          layer.renderer.updateValueBuffer();
        }
        layer.shardedLoader._shardDirty = false;
        this._shardTransitionFrame = true;
      }

      // GFB-streaming shard dirty + texture preparation
      if (layer.type === 'gfb-streaming' && layer.streamingLoader?._shardDirty) {
        const data = layer.streamingLoader.baseData;
        if (layer.renderer?.setShardMetadata) {
          layer.renderer.setShardMetadata(data._shardEpochStart, data._shardEpochCount);
        }
        // Re-upload value buffer: each shard has features in different order
        if (layer.renderer?.updateValueBuffer) {
          layer.renderer.updateValueBuffer();
        }
        layer.streamingLoader._shardDirty = false;
      }

      // MFB shard dirty — no GPU resources, just clear the flag
      if (layer.type === 'mfb' && layer.shardedLoader?._shardDirty) {
        layer.shardedLoader._shardDirty = false;
      }

      if (layer.shardedLoader) {
        layer.shardedLoader.baseData._currentNormalizedTime = effectiveTime;
      }
      if (layer.streamingLoader) {
        layer.streamingLoader.baseData._currentNormalizedTime = effectiveTime;
      }

      if (
        (layer.type.startsWith('h3f') || layer.type === 'dgf') &&
        layer.renderer?.prepareCompute
      ) {
        layer.renderer.prepareCompute(commandEncoder, effectiveTime);
      }

      // Upload position textures (GFB + GFB-streaming) — must complete before render pass
      if (
        (layer.type === 'gfb' || layer.type === 'gfb-streaming') &&
        layer.renderer?.prepareTextures
      ) {
        layer.renderer.prepareTextures(effectiveTime);
      }
    }

    // Store for render() to reuse
    this._lastEffectiveTime = effectiveTime;
    this._phase1Done = true;
  }

  /**
   * Render all layers.
   * @returns {{ drawCalls: number, effectiveTime: number }}
   */
  render(projection, ctx) {
    const { normalizedTime, playbackSpeed = 60, passEncoder = null } = ctx;
    let drawCalls = 0;

    // ─── Phase 1: Update all loaders and compute effective time ───
    // If prepareH3Compute() already ran Phase 1, reuse its result.
    let effectiveTime;

    if (this._phase1Done) {
      effectiveTime = this._lastEffectiveTime;
      this._phase1Done = false;
    } else {
      effectiveTime = normalizedTime;
      for (const [name, layer] of this.layers) {
        if (!layer.visible || !layer.shardedLoader) continue;
        layer.shardedLoader.baseData._playbackSpeed = playbackSpeed;
        layer.shardedLoader.updateForTime(normalizedTime);
      }
    }

    // Renderers read ctx.normalizedTime; draw at the (possibly shard-stall-
    // adjusted) effective time, matching the pre-Track-D behavior where
    // effectiveTime was passed as the renderer's time argument.
    ctx.normalizedTime = effectiveTime;

    // ─── Phase 2: Apply shard changes and render at effective time ───
    for (const [name, layer] of this.layers) {
      if (!layer.visible) continue;

      if (layer.shardedLoader) {
        layer.shardedLoader.baseData._currentNormalizedTime = effectiveTime;

        if (layer.type.startsWith('h3f') || layer.type === 'dgf') {
          // H3 shard-dirty handled in prepareH3Compute (WebGPU) or here (WebGL2)
          if (!passEncoder && layer.shardedLoader._shardDirty) {
            if (layer.renderer.forceAmortizedReload) layer.renderer.forceAmortizedReload();
            layer.shardedLoader._shardDirty = false;
          }
        } else if (layer.type === 'gfb') {
          // GFB shard-dirty handled in prepareH3Compute (WebGPU) or here (WebGL2)
          if (!passEncoder && layer.shardedLoader._shardDirty) {
            if (layer.renderer?.setShardMetadata) {
              layer.renderer.setShardMetadata();
            }
            if (layer.renderer?.updateValueBuffer) {
              layer.renderer.updateValueBuffer();
            }
            layer.shardedLoader._shardDirty = false;
          }
        } else if (layer.type === 'gfb-streaming') {
          // Streaming GFB shard-dirty
          if (!passEncoder && layer.streamingLoader?._shardDirty) {
            const data = layer.streamingLoader.baseData;
            if (layer.renderer?.setShardMetadata) {
              layer.renderer.setShardMetadata(data._shardEpochStart, data._shardEpochCount);
            }
            // Re-upload value buffer: each shard has features in different order
            if (layer.renderer?.updateValueBuffer) {
              layer.renderer.updateValueBuffer();
            }
            layer.streamingLoader._shardDirty = false;
          }
        } else if (layer.type === 'mfb') {
          // MFB shard dirty — no GPU resources, just clear the flag
          if (layer.shardedLoader?._shardDirty) {
            layer.shardedLoader._shardDirty = false;
          }
        }
      }

      // Render layers: H3 first (with depth), then GFB (no depth test,
      // uses geometric horizon check instead to hide far-side aircraft).
      if (layer.type.startsWith('h3f') || layer.type === 'dgf') {
        layer.renderer.render(projection, ctx);
        drawCalls++;
      }
    }

    // GFB layers render after H3 — no depth test (geometric horizon check),
    // so aircraft are always visible above/through H3 pillars.
    for (const [name, layer] of this.layers) {
      if (!layer.visible) continue;
      if (layer.type === 'gfb' || layer.type === 'gfb-streaming' || layer.type === 'geojson') {
        layer.renderer.render(projection, ctx);
        drawCalls++;
      }
    }

    return { drawCalls, effectiveTime };
  }

  /**
   * Render all layers in 2D Mercator mode. H3F layers use their Mercator
   * pipeline; GFB/DGFlex are skipped (Phase 5).
   *
   * @param {{ lng: number, lat: number, zoom: number }} camera
   * @param {number} viewportW
   * @param {number} viewportH
   * @param {number} normalizedTime
   * @param {number} [playbackSpeed]
   * @param {GPURenderPassEncoder|null} [passEncoder]
   * @returns {{ drawCalls: number, effectiveTime: number }}
   */
  // renderMercator() removed in Track D — render(projection, ctx) now handles
  // both projections via each renderer's render(projection, ctx) dispatcher.

  /**
   * Toggle visibility of a named layer.
   */
  toggleLayerVisibility(name) {
    const layer = this.layers.get(name);
    if (layer) {
      layer.visible = !layer.visible;
      this._styleVersion++; // Wake up render loop
      return layer.visible;
    }
    return null;
  }

  /**
   * Set visibility of a named layer.
   */
  setLayerVisibility(name, visible) {
    const layer = this.layers.get(name);
    if (layer && layer.visible !== visible) {
      layer.visible = visible;
      this._styleVersion++; // Wake up render loop
    }
  }

  /**
   * Get info about all layers for the Layer Manager dialog.
   * Returns an array of { name, type, visible, featureCount, epochCount, activeMetric, temporalAttributes, stops, domain }.
   */
  getLayerInfo() {
    const info = [];
    for (const [name, layer] of this.layers) {
      const entry = {
        name,
        type: layer.type,
        visible: layer.visible,
        featureCount:
          layer.data.cellCount || layer.data.featureCount || layer.data.entityCount || 0,
        epochCount: layer.data.epochCount || 0,
        activeMetric: layer.activeMetric || null,
        symbolType: layer.renderer?._symbolType,
      };
      // Extract color ramp info from compiled style + embedded spec
      if (layer.style?.color) {
        entry.attribute = layer.style.color.attribute || null;
        entry.domain = layer.style.color.domain || null;
      }

      // ─── Resolve stop colors (priority: user override > metricsMap > embedded) ───
      if (layer._userStops) {
        // User has edited stops via the ramp editor (already carry per-stop opacity)
        entry.stops = layer._userStops;
        entry.domain = layer._userDomain || entry.domain;
      } else if (layer.metricsMap?.[layer.activeMetric]?.style) {
        // Per-metric style from YAML config
        const mStyle = layer.metricsMap[layer.activeMetric].style;
        const mSpec = mStyle.layers?.[0] || mStyle;
        const mStyleInner = mSpec.style || mSpec;
        if (mStyleInner.stops) {
          // Normalize: plain strings → { value, color } with even spacing
          const dom = mStyleInner.domain || entry.domain || [0, 1];
          if (typeof mStyleInner.stops[0] === 'string') {
            entry.stops = mStyleInner.stops.map((color, i) => ({
              value: dom[0] + (dom[1] - dom[0]) * (i / (mStyleInner.stops.length - 1)),
              color,
            }));
          } else {
            entry.stops = mStyleInner.stops.map((s) => ({ ...s }));
          }
          entry.domain = dom;
          // Merge opacityStops into stops
          if (mStyleInner.opacityStops) {
            this._mergeOpacityIntoStops(entry.stops, mStyleInner.opacityStops, dom);
          }
        }
        entry.opacity = mStyleInner.opacity ?? 1.0;
      } else if (layer._yamlStyle) {
        // YAML-provided style from globe-config.yaml
        const ySpec = layer._yamlStyle;
        if (ySpec.stops) {
          const dom = ySpec.domain || entry.domain || [0, 1];
          if (typeof ySpec.stops[0] === 'string') {
            entry.stops = ySpec.stops.map((color, i) => ({
              value: dom[0] + (dom[1] - dom[0]) * (i / (ySpec.stops.length - 1)),
              color,
            }));
          } else {
            entry.stops = ySpec.stops.map((s) => ({ ...s }));
          }
          entry.domain = dom;
          if (ySpec.opacityStops) {
            this._mergeOpacityIntoStops(entry.stops, ySpec.opacityStops, dom);
          }
        }
        entry.opacity = ySpec.opacity ?? 1.0;
      } else {
        // Fallback: embedded style in the data file.
        // Search layers[] by the active metric's attribute name so each metric
        // gets its own domain/stops.  Previously this always grabbed layers[0],
        // causing every metric except the first to show the wrong ramp in the
        // Layer Manager preview and the H3SymbologyDialog.
        const embedded = layer.data.embeddedStyle;
        if (embedded) {
          const embeddedLayers = embedded.layers;
          const metricEntry = embeddedLayers?.find((l) => l.attribute === layer.activeMetric);
          const layerSpec = metricEntry || embeddedLayers?.[0] || embedded;
          const styleSpec = layerSpec.style || layerSpec;
          if (styleSpec.stops) {
            entry.stops = styleSpec.stops.map((s) => ({ ...s }));
            // Prefer the embedded style's domain over the stale compiled style's
            // domain (set above from layer.style.color.domain).  Using || would
            // keep the old metric's domain because entry.domain is already set.
            entry.domain = styleSpec.domain || entry.domain;
            // Update attribute to match the metric-specific embedded layer.
            if (layerSpec.attribute) entry.attribute = layerSpec.attribute;
            // Merge opacityStops into stops
            if (styleSpec.opacityStops) {
              this._mergeOpacityIntoStops(entry.stops, styleSpec.opacityStops, entry.domain);
            }
          }
          entry.opacity = styleSpec.opacity ?? 1.0;
        }
      }

      // Expose temporal attribute names — prefer manifest (v3 object array) or v2 string array, fallback to schema
      if (layer.shardedLoader?.manifest?.temporalAttributes) {
        entry.temporalAttributes = layer.shardedLoader.manifest.temporalAttributes.map((a) =>
          typeof a === 'string' ? a : a.name
        );
      } else if (layer.data.temporalAttributes && layer.data.temporalAttributes.length > 0) {
        entry.temporalAttributes = layer.data.temporalAttributes.map((a) =>
          typeof a === 'string' ? a : a.name
        );
      } else if (layer.data.schema) {
        entry.temporalAttributes = layer.data.schema
          .filter((col) => col.temporal)
          .map((col) => col.name);
      }
      if (layer.metricsMap) entry.metricsMap = layer.metricsMap;
      if (layer._metricAttributes?.length) entry.metricAttributes = layer._metricAttributes;
      info.push(entry);
    }
    return info;
  }

  /**
   * Get the epoch duration in seconds for the adaptive TimeController.
   */
  getEpochDuration() {
    if (this.maxEpochCount === 0) return 24 * 60 * 60;
    return this.maxEpochCount * this.maxEpochInterval;
  }

  /**
   * Get total feature count across all layers.
   */
  getTotalFeatures() {
    return this.totalFeatures;
  }

  /**
   * Get layer count.
   */
  getLayerCount() {
    return this.layers.size;
  }

  /**
   * Merge separate opacityStops into color stops by interpolating opacity
   * at each color stop's value position. Modifies stops in-place.
   * @param {Object[]} stops - Color stops (mutated: gains .opacity)
   * @param {Object[]} opacityStops - Array of { value, opacity }
   * @param {number[]} domain - [min, max]
   */
  _mergeOpacityIntoStops(stops, opacityStops, domain) {
    const sorted = [...opacityStops].sort((a, b) => a.value - b.value);
    for (const stop of stops) {
      const v = stop.value;
      if (v <= sorted[0].value) {
        stop.opacity = sorted[0].opacity;
      } else if (v >= sorted[sorted.length - 1].value) {
        stop.opacity = sorted[sorted.length - 1].opacity;
      } else {
        for (let i = 0; i < sorted.length - 1; i++) {
          if (v >= sorted[i].value && v <= sorted[i + 1].value) {
            const t = (v - sorted[i].value) / (sorted[i + 1].value - sorted[i].value);
            stop.opacity = sorted[i].opacity + (sorted[i + 1].opacity - sorted[i].opacity) * t;
            break;
          }
        }
      }
    }
  }

  /**
   * Get aggregate shard loading status across all visible layers.
   * Used by the shard loading progress indicator to show progress
   * when the user scrubs into an unloaded time region.
   * @param {number} normalizedTime - Current normalized time [0, 1]
   * @returns {{ loading: boolean, layersTotal: number, layersReady: number, layersPending: string[] }}
   */
  getShardLoadingStatus(normalizedTime) {
    let layersTotal = 0;
    let layersReady = 0;
    const layersPending = [];

    for (const [name, layer] of this.layers) {
      if (!layer.visible) continue;
      const loader = layer.shardedLoader;
      if (!loader || !loader.manifest) continue;

      layersTotal++;

      const epochCount = loader.manifest.epochCount || 1;
      const epoch = Math.floor(normalizedTime * (epochCount - 1));
      const neededShard = loader.getShardIndex(Math.min(epoch, epochCount - 1));

      if (loader._shards.has(neededShard)) {
        layersReady++;
      } else {
        layersPending.push(name);
      }
    }

    return {
      loading: layersPending.length > 0,
      layersTotal,
      layersReady,
      layersPending,
    };
  }
}
