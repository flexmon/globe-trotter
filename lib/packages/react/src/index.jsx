/**
 * @globe-trotter/react — React component for Globe-Trotter engine.
 *
 * Usage (YAML config — preferred for production):
 *   import YAML from 'yaml';
 *   const config = YAML.parse(await fetch('/globe-config.yaml').then(r => r.text()));
 *   <GlobeTrotter mapboxToken="pk.xxx" config={config} onReady={(e) => console.log(e)} />
 *
 * Usage (simple programmatic layers):
 *   <GlobeTrotter
 *     mapboxToken="pk.xxx"
 *     layers={[
 *       { name: 'Supply', type: 'h3f-sharded', url: '/data/supply.manifest.json' },
 *       { name: 'Flights', type: 'gfb',        url: '/data/flights.gfb' },
 *     ]}
 *     view={{ lat: 39.8, lon: -98.5, distance: 2.5 }}
 *     onSelection={({ layer, feature }) => showDetails(layer, feature)}
 *   />
 *
 * Notes:
 * - `layers` are loaded once at mount. For dynamic layer changes after mount,
 *   use `ref.current.getEngine()` to access the engine directly.
 * - If both `config` and `layers` are provided, `config` takes priority.
 * - `onReady` fires after layers/config have finished loading.
 */

import { useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
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

export const GlobeTrotter = forwardRef(function GlobeTrotter(
  {
    // ── Tile providers ──────────────────────────────────────
    mapboxToken = null,
    googleMapsApiKey = null,
    basemapProvider = null,
    basemap = null,

    // ── Projection ──────────────────────────────────────────
    projectionMode = 'spherical', // 'spherical' | 'mercator'

    // ── Data ────────────────────────────────────────────────
    config = null, // pre-parsed YAML config object (preferred)
    layers = [], // simple declarative layers array

    // ── Camera ──────────────────────────────────────────────
    view = null, // { lat, lon, distance, heading?, tilt? }

    // ── Time ────────────────────────────────────────────────
    speed = 60,
    playing = true,

    // ── UI ──────────────────────────────────────────────────
    ui = true,
    uiWidgets = {},

    // ── Events ──────────────────────────────────────────────
    onFrame,
    onReady,
    onUnsupported,
    onError,
    onLayerAdded,
    onLayerRemoved,
    onLayerLoad,
    onViewChanged,
    onTimeChanged,
    onSelection,

    // ── DOM ─────────────────────────────────────────────────
    style: containerStyle,
    className,
    ...rest
  },
  ref
) {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);

  // Expose engine instance so callers can use advanced APIs directly.
  useImperativeHandle(ref, () => ({
    getEngine: () => engineRef.current,
  }));

  // ── Initialize engine ──────────────────────────────────────────────────────
  // Re-runs only when provider keys change (re-init is expensive; use getEngine()
  // for runtime changes to other options).
  useEffect(() => {
    if (!canvasRef.current) return;

    const engine = new GlobeTrotterEngine(canvasRef.current, {
      mapboxToken,
      googleMapsApiKey,
      basemapProvider,
      basemap,
      projectionMode,
      ui,
      uiWidgets,
      time: { speed, autoplay: playing },
    });
    engineRef.current = engine;

    // Forward all engine events to prop callbacks.
    // on() returns an unsubscribe function — collect them for cleanup.
    const offs = [
      onFrame && engine.on('frame', onFrame),
      onUnsupported && engine.on('unsupported', onUnsupported),
      onError && engine.on('error', onError),
      onLayerAdded && engine.on('layerAdded', onLayerAdded),
      onLayerRemoved && engine.on('layerRemoved', onLayerRemoved),
      onLayerLoad && engine.on('layerLoad', onLayerLoad),
      onViewChanged && engine.on('viewChanged', onViewChanged),
      onTimeChanged && engine.on('timeChanged', onTimeChanged),
      onSelection && engine.on('selection', onSelection),
    ].filter(Boolean);

    (async () => {
      try {
        // Wait for WebGPU init, camera, time, and all systems to be ready.
        // Engine methods that touch this.time / this.camera are unsafe before this.
        await engine.ready();

        // Re-apply current prop values to catch any changes during async init.
        engine.setSpeed(speed);
        playing ? engine.play() : engine.pause();
        if (view) engine.setView(view);

        // Load data — config takes priority over layers.
        if (config) {
          await engine.loadConfig(config);
        } else {
          for (const layer of layers) {
            await _loadLayer(engine, layer);
          }
        }

        if (onReady) onReady(engine);
      } catch (err) {
        // WebGPURequiredError is already surfaced via the 'unsupported' event.
        if (!(err instanceof WebGPURequiredError) && onError) {
          onError({ error: err });
        }
      }
    })();

    return () => {
      offs.forEach((off) => off());
      engine.destroy();
      engineRef.current = null;
    };
  }, [mapboxToken, googleMapsApiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reactive prop updates (applied only after engine is ready) ─────────────

  useEffect(() => {
    const eng = engineRef.current;
    if (eng?.isReady && view) eng.setView(view);
  }, [view?.lat, view?.lon, view?.distance, view?.heading, view?.tilt]);

  useEffect(() => {
    if (engineRef.current?.isReady) engineRef.current.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    const eng = engineRef.current;
    if (!eng?.isReady) return;
    playing ? eng.play() : eng.pause();
  }, [playing]);

  useEffect(() => {
    if (engineRef.current?.isReady) engineRef.current.setBasemap(basemap);
  }, [basemap]);

  useEffect(() => {
    if (engineRef.current?.isReady) engineRef.current.setProjectionMode(projectionMode);
  }, [projectionMode]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%', display: 'block', ...containerStyle }}
      {...rest}
    />
  );
});

export default GlobeTrotter;
