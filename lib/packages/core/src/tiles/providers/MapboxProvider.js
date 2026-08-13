/**
 * MapboxProvider — Mapbox basemap tiles.
 *
 * Two underlying APIs are used depending on the style:
 *   - V4 raster API (used for `mapbox.satellite`) → fastest, raw JPEG imagery
 *   - Static Tiles API (all styled maps) → PNG/JPEG with transparency
 *
 * Tiles are 512×512 @2x (matches the existing TileRenderer texture sizing).
 * Attribution is static (Mapbox + OpenStreetMap).
 *
 * Behavior is preserved verbatim from the previous TileManager.STYLES /
 * getTileUrl() pre-refactor — this provider is a drop-in extraction.
 */

import { BasemapProvider } from './BasemapProvider.js';

/**
 * Static attribution text required by Mapbox's terms of service for
 * raster tile usage. Both Mapbox and OpenStreetMap must be credited.
 *
 * @see https://docs.mapbox.com/help/getting-started/attribution/
 */
const MAPBOX_ATTRIBUTION = '© Mapbox © OpenStreetMap';

export class MapboxProvider extends BasemapProvider {
  static PROVIDER_ID = 'mapbox';

  /**
   * Available Mapbox basemap styles. `useV4: true` selects the raw V4 raster
   * tiles endpoint (currently only used for `satellite`); all others use the
   * Static Tiles API at /styles/v1/.
   */
  static STYLES = {
    satellite: { label: 'Satellite', id: 'mapbox.satellite', useV4: true, maxZoom: 22 },
    'satellite-streets': {
      label: 'Sat Streets',
      id: 'mapbox/satellite-streets-v12',
      useV4: false,
      maxZoom: 22,
    },
    streets: { label: 'Streets', id: 'mapbox/streets-v12', useV4: false, maxZoom: 22 },
    outdoors: { label: 'Outdoors', id: 'mapbox/outdoors-v12', useV4: false, maxZoom: 22 },
    light: { label: 'Light', id: 'mapbox/light-v11', useV4: false, maxZoom: 22 },
    dark: { label: 'Dark', id: 'mapbox/dark-v11', useV4: false, maxZoom: 22 },
    'navigation-day': {
      label: 'Navigation Day',
      id: 'mapbox/navigation-day-v1',
      useV4: false,
      maxZoom: 22,
    },
    'navigation-night': {
      label: 'Navigation Night',
      id: 'mapbox/navigation-night-v1',
      useV4: false,
      maxZoom: 22,
    },
  };

  static DEFAULT_STYLE = 'satellite';

  /**
   * @param {string} accessToken - Mapbox access token (pk.* or sk.*)
   */
  constructor(accessToken) {
    super();
    if (!accessToken) {
      throw new Error('[MapboxProvider] accessToken is required');
    }
    this.accessToken = accessToken;
  }

  /**
   * Mapbox needs no async setup — tokens are presented directly with each
   * tile request. Returns immediately.
   */
  async ensureReady(_style) {
    return;
  }

  getTileUrl(z, x, y, style) {
    const styleInfo = MapboxProvider.STYLES[style];
    if (!styleInfo) {
      throw new Error(`[MapboxProvider] Unknown style: ${style}`);
    }
    if (styleInfo.useV4) {
      // V4 raster API (faster, for raw satellite imagery)
      return `https://api.mapbox.com/v4/${styleInfo.id}/${z}/${x}/${y}@2x.jpg90?access_token=${this.accessToken}`;
    }
    // Static Tiles API (for styled maps).
    // Format is automatically JPEG for raster layers, PNG for vector-only.
    return `https://api.mapbox.com/styles/v1/${styleInfo.id}/tiles/512/${z}/${x}/${y}@2x?access_token=${this.accessToken}`;
  }

  getAttribution(_style) {
    return MAPBOX_ATTRIBUTION;
  }

  /**
   * Get whether this style uses the V4 raster API (used by the zoom bias
   * heuristic in TileManager.zoomFromDistance — V4 satellite gets +5,
   * styled maps get +4 for sharper labels).
   *
   * @param {string} style
   * @returns {boolean}
   */
  isV4Style(style) {
    return MapboxProvider.STYLES[style]?.useV4 === true;
  }

  getMaxZoom(style) {
    return MapboxProvider.STYLES[style]?.maxZoom ?? 22;
  }
}
