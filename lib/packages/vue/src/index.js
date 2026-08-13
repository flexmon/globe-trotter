/**
 * @globe-trotter/vue — Vue 3 component for Globe-Trotter engine.
 *
 * Usage (YAML config — preferred for production):
 *   import YAML from 'yaml';
 *   const config = YAML.parse(await fetch('/globe-config.yaml').then(r => r.text()));
 *   <GlobeTrotter :mapbox-token="'pk.xxx'" :config="config" @ready="onReady" />
 *
 * Usage (simple programmatic layers):
 *   <GlobeTrotter
 *     :mapbox-token="'pk.xxx'"
 *     :layers="[
 *       { name: 'Supply', type: 'h3f-sharded', url: '/data/supply.manifest.json' },
 *       { name: 'Flights', type: 'gfb',        url: '/data/flights.gfb' },
 *     ]"
 *     @selection="({ layer, feature }) => showDetails(layer, feature)"
 *   />
 *
 * Notes:
 * - `layers` are loaded once at mount. For dynamic layer changes after mount,
 *   call `getEngine()` on the component ref to access the engine directly.
 * - If both `config` and `layers` are provided, `config` takes priority.
 * - The `ready` event fires after layers/config have finished loading.
 */

import { defineComponent, ref, onMounted, onBeforeUnmount, watch, h } from 'vue';
import { GlobeTrotterEngine, WebGPURequiredError } from '@globe-trotter/core';

/**
 * Dispatch a layer to the correct engine method based on type.
 * Supports all layer types exposed by GlobeTrotterEngine.
 */
async function _loadLayer(engine, layer) {
  const { name, type, url, ...opts } = layer;
  if (type === 'h3f-sharded') return engine.addShardedLayer(name, url, opts);
  if (type === 'gfb-sharded') return engine.addShardedGFBLayer(name, url, opts);
  if (type === 'dgf-sharded') return engine.addShardedDGFlexLayer(name, url, opts);
  if (type === 'gfb-streaming') return engine.addStreamingGFBLayer(name, url, opts);
  return engine.addLayer(name, type, url, opts); // 'h3f', 'gfb', 'mfb', etc.
}

export const GlobeTrotter = defineComponent({
  name: 'GlobeTrotter',

  props: {
    // ── Tile providers ─────────────────────────────────────
    /** Mapbox access token for satellite tiles */
    mapboxToken: { type: String, default: null },
    /** Google Maps API key (alternative to Mapbox) */
    googleMapsApiKey: { type: String, default: null },
    /** Basemap provider override: null | 'mapbox' | 'google' */
    basemapProvider: { type: String, default: null },
    /** Basemap style ID (provider-specific) */
    basemap: { type: String, default: null },

    // ── Projection ─────────────────────────────────────────
    /** Projection mode: 'spherical' (3D globe) or 'mercator' (2D flat) */
    projectionMode: { type: String, default: 'spherical' },

    // ── Data ───────────────────────────────────────────────
    /** Pre-parsed YAML config object (preferred for production) */
    config: { type: Object, default: null },
    /** Declarative layer array: [{ name, type, url, style? }] */
    layers: { type: Array, default: () => [] },

    // ── Camera ─────────────────────────────────────────────
    /** Camera view: { lat, lon, distance, heading?, tilt? } */
    view: { type: Object, default: null },

    // ── Time ───────────────────────────────────────────────
    /** Playback speed multiplier */
    speed: { type: Number, default: 60 },
    /** Whether time playback is active */
    playing: { type: Boolean, default: true },

    // ── UI ─────────────────────────────────────────────────
    /** Enable UI widgets (master switch) */
    ui: { type: Boolean, default: true },
    /** Per-widget visibility: { footer, layers, geocoder, time, legend, ... } */
    uiWidgets: { type: Object, default: () => ({}) },
  },

  emits: [
    /** Fired every animation frame: { time, normalizedTime, fps, drawCalls, features } */
    'frame',
    /** Fired after engine init + data loading completes: engine instance */
    'ready',
    /** Fired when WebGPU is unavailable: { reason } */
    'unsupported',
    /** Fired on load errors: { error } */
    'error',
    /** Fired when a layer is added: { name, type } */
    'layer-added',
    /** Fired when a layer is removed: { name } */
    'layer-removed',
    /** Fired during layer loading lifecycle: { name, status, error? } */
    'layer-load',
    /** Fired when the camera view changes: { lat, lon, distance, heading, tilt } */
    'view-changed',
    /** Fired when the playhead moves: { epochSec, normalized } */
    'time-changed',
    /** Fired on feature click (or cleared): { layer, feature, featureIndex, lngLat } */
    'selection',
  ],

  setup(props, { emit, expose }) {
    const canvasRef = ref(null);
    let engine = null;

    onMounted(async () => {
      engine = new GlobeTrotterEngine(canvasRef.value, {
        mapboxToken: props.mapboxToken,
        googleMapsApiKey: props.googleMapsApiKey,
        basemapProvider: props.basemapProvider,
        basemap: props.basemap,
        projectionMode: props.projectionMode,
        ui: props.ui,
        uiWidgets: props.uiWidgets,
        time: { speed: props.speed, autoplay: props.playing },
      });

      // Forward all engine events to Vue emits.
      engine.on('frame', (d) => emit('frame', d));
      engine.on('unsupported', (d) => emit('unsupported', d));
      engine.on('error', (d) => emit('error', d));
      engine.on('layerAdded', (d) => emit('layer-added', d));
      engine.on('layerRemoved', (d) => emit('layer-removed', d));
      engine.on('layerLoad', (d) => emit('layer-load', d));
      engine.on('viewChanged', (d) => emit('view-changed', d));
      engine.on('timeChanged', (d) => emit('time-changed', d));
      engine.on('selection', (d) => emit('selection', d));

      try {
        // Wait for WebGPU init, camera, time, and all systems to be ready.
        // Engine methods that touch this.time / this.camera are unsafe before this.
        await engine.ready();

        // Re-apply current prop values to catch any changes during async init.
        engine.setSpeed(props.speed);
        props.playing ? engine.play() : engine.pause();
        if (props.view) engine.setView(props.view);

        // Load data — config takes priority over layers.
        if (props.config) {
          await engine.loadConfig(props.config);
        } else {
          for (const layer of props.layers) {
            await _loadLayer(engine, layer);
          }
        }

        emit('ready', engine);
      } catch (err) {
        // WebGPURequiredError is already surfaced via the 'unsupported' event.
        if (!(err instanceof WebGPURequiredError)) {
          emit('error', { error: err });
        }
      }
    });

    // ── Reactive prop watchers (applied only after engine is ready) ────────────

    watch(
      () => props.view,
      (v) => {
        if (engine?.isReady && v) engine.setView(v);
      },
      { deep: true }
    );

    watch(
      () => props.speed,
      (v) => {
        if (engine?.isReady) engine.setSpeed(v);
      }
    );

    watch(
      () => props.playing,
      (v) => {
        if (!engine?.isReady) return;
        v ? engine.play() : engine.pause();
      }
    );

    watch(
      () => props.basemap,
      (v) => {
        if (engine?.isReady) engine.setBasemap(v);
      }
    );

    watch(
      () => props.projectionMode,
      (v) => {
        if (engine?.isReady) engine.setProjectionMode(v);
      }
    );

    onBeforeUnmount(() => {
      if (engine) engine.destroy();
    });

    // Expose engine instance for advanced programmatic access.
    expose({ getEngine: () => engine });

    return () =>
      h('canvas', {
        ref: canvasRef,
        style: { width: '100%', height: '100%', display: 'block' },
      });
  },
});

export default GlobeTrotter;
