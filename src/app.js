// app.js — Globe Trotter: thin YAML-driven boot loader
//
// All initialization, rendering, and layer management is handled by the
// @globe-trotter/core library. This file only fetches the config and boots.

import YAML from 'yaml';
import { GlobeTrotterEngine } from '@globe-trotter/core';

import gtWordmarkRaw from '../assets/globe-trotter-wordmark.svg?raw';
import gtLogoRaw from '../assets/globe-trotter-logo.svg?raw';

const gtWordmarkUrl = `data:image/svg+xml;base64,${btoa(gtWordmarkRaw)}`;
const gtLogoUrl = `data:image/svg+xml;base64,${btoa(gtLogoRaw)}`;

/**
 * Resolve a token value. "env:VAR_NAME" reads from Vite env vars.
 *
 * IMPORTANT: Vite replaces import.meta.env.VITE_XXX via static string
 * substitution at compile time. Dynamic access like import.meta.env[key]
 * does NOT work. We build a static lookup map here so the replacements
 * happen, then do the dynamic lookup against the map at runtime.
 */
const ENV_MAP = {
  VITE_MAPBOX_TOKEN: import.meta.env.VITE_MAPBOX_TOKEN,
  VITE_GOOGLE_MAPS_API_KEY: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
};

function resolveToken(token) {
  if (!token) return null;
  if (typeof token === 'string' && token.startsWith('env:')) {
    const key = token.slice(4);
    return ENV_MAP[key] || null;
  }
  return token;
}

// ─── Boot ───

window.addEventListener('DOMContentLoaded', async () => {
  try {
    // 1. Load YAML config — from ?globeconf=URL or default config file
    const params = new URLSearchParams(window.location.search);
    let configUrl = params.get('globeconf');

    // If configUrl is not provided, detect CDN vs local and use appropriate catalog path
    if (!configUrl) {
      const isLocalhost =
        window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const isCDN = window.location.pathname.includes('/globe-trotter/');
      const prefix = !isLocalhost && isCDN ? '/globe-trotter' : '';
      configUrl = `${prefix}/catalog/demo-catalog.yaml`;
    }
    // Absolute paths (starting with /) are used as-is — works with CDN deployments
    // Relative paths are resolved against the page's BASE_URL

    // Dynamically inject logos to enforce Vite inlining
    const brandRow = document.querySelector('.brand-row');
    if (brandRow) {
      const wordmarkImg = document.createElement('img');
      wordmarkImg.className = 'brand-wordmark';
      wordmarkImg.src = gtWordmarkUrl;
      wordmarkImg.alt = 'Globe Trotter';

      const logoImg = document.createElement('img');
      logoImg.className = 'brand-icon';
      logoImg.src = gtLogoUrl;
      logoImg.alt = '';
      logoImg.width = 22;
      logoImg.height = 22;

      brandRow.appendChild(wordmarkImg);
      brandRow.appendChild(logoImg);
    }

    // Dynamically inject favicon
    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.type = 'image/svg+xml';
    favicon.href = gtLogoUrl;
    document.head.appendChild(favicon);

    let config;
    const manifestUrl = params.get('manifest');
    if (manifestUrl) {
      // Direct manifest loading — build a minimal config on the fly
      console.log(`[GlobeTrotter] Loading manifest directly: ${manifestUrl}`);
      config = {
        basemap: { provider: 'google', googleApiKey: 'env:VITE_GOOGLE_MAPS_API_KEY' },
        camera: {},
        time: {},
        ui: { footer: true, layers: true, geocoder: true, time: true },
        layers: [
          {
            name: 'Sharded Layer',
            type: 'h3f-sharded',
            url: manifestUrl,
            extrusionEnabled: true,
          },
        ],
      };
    } else {
      console.log(`[GlobeTrotter] Loading config from: ${configUrl}`);
      const cacheBust = `${configUrl}${configUrl.includes('?') ? '&' : '?'}_t=${Date.now()}`;
      const resp = await fetch(cacheBust);
      if (!resp.ok)
        throw new Error(`Config fetch failed: ${resp.status} ${resp.statusText} — ${configUrl}`);

      // Guard: if the server returned HTML (e.g. Vite SPA fallback for a missing file), bail early
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        throw new Error(
          `Config URL returned HTML instead of YAML — file likely does not exist: ${configUrl}`
        );
      }

      config = YAML.parse(await resp.text());
      if (!config || typeof config !== 'object') {
        throw new Error(
          `Config parsed but is not a valid YAML object (got ${typeof config}) — check the URL: ${configUrl}`
        );
      }
    }
    console.log('[GlobeTrotter] Config loaded:', config);

    // 2. Resolve basemap credentials. Both tokens are resolved unconditionally
    //    so any configured geocoder provider works regardless of which tile
    //    provider is active.
    const mapboxToken = resolveToken(config.basemap?.token || 'env:VITE_MAPBOX_TOKEN');
    const googleMapsApiKey = resolveToken(
      config.basemap?.googleApiKey || 'env:VITE_GOOGLE_MAPS_API_KEY'
    );
    const basemapProvider = config.basemap?.provider || 'google';
    // Optional: explicit geocoder provider. When omitted, UIManager uses
    // Mapbox first (backward-compatible default). Set to 'google' to force
    // Google Places Autocomplete (New) even when a Mapbox token is present.
    const geocoderProvider = config.basemap?.geocoderProvider || null;

    // 3. Create engine — handles WebGL, camera, time, tiles, UI, render loop
    const canvas = document.getElementById('globe-canvas');
    // Hide canvas until loading screen overlay is ready to prevent gray flash
    canvas.style.opacity = '0';

    // Auto-detect basePath from page URL:
    // CDN: /globe-trotter/web/globe-trotter.html → basePath = /globe-trotter/
    // Local: / → basePath = /
    const pagePath = window.location.pathname;
    const webIdx = pagePath.indexOf('/web/');
    const basePath = webIdx > 0 ? pagePath.substring(0, webIdx + 1) : '/';

    const engine = new GlobeTrotterEngine(canvas, {
      mapboxToken,
      googleMapsApiKey,
      basemapProvider,
      geocoderProvider,
      basePath,
      // null lets the engine fall back to the active provider's DEFAULT_STYLE.
      basemap: config.basemap?.style || null,
      camera: config.camera || {},
      time: config.time || {},
      uiWidgets: {
        ...(config.ui || { footer: true, layers: true, geocoder: true, time: true }),
        loadingScreen: {
          logoUrl: gtWordmarkUrl,
          iconUrl: gtLogoUrl,
          subtitle: 'Big Data 4D Visualization System',
        },
      },
    });

    // Expose engine globally for programmatic access
    // Developers can use: globe.flyTo(lat, lon), globe.addLayer(...), etc.
    window.globe = engine;

    // Wait for async backend initialization (WebGPU adapter request)
    await engine._initPromise;

    // Show canvas now that loading screen overlay is in place
    canvas.style.opacity = '1';

    // 4. Resolve relative layer URLs against the config file's directory
    if (config.layers) {
      const configBase = new URL(configUrl, window.location.href).href;
      for (const layer of config.layers) {
        if (layer.url && !layer.url.startsWith('http')) {
          layer.url = new URL(layer.url, configBase).pathname;
        }
      }
    }

    // 5. Load all data layers from config
    const result = await engine.loadConfig(config);

    // 5. Init complete
    if (result.ok) {
      console.log(`[GlobeTrotter] Init complete — ${result.layersLoaded} layers loaded`);
    } else {
      console.warn(
        `[GlobeTrotter] Init complete with ${result.layersFailed} error(s):`,
        result.errors
      );
    }
  } catch (err) {
    console.error('[GlobeTrotter] Boot failed:', err);
    // Show error on the library's loading screen if available
    if (window.globe?.ui?.loadingScreen) {
      window.globe.ui.loadingScreen.showError(`Failed: ${err.message}`);
    }
  }
});
