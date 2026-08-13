/**
 * MapboxGeocoderProvider — wraps the Mapbox Geocoding v5 endpoint.
 *
 * This is a behavior-preserving extraction of the original inline _geocode()
 * logic from GeocoderDialog. Existing Mapbox users should see zero change
 * in autocomplete behavior.
 */

import { GeocoderProvider } from './GeocoderProvider.js';

const GEOCODE_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

/**
 * Map a Mapbox place_type string to the unified type vocabulary.
 *
 * @param {string} placeType
 * @returns {string}
 */
function mapMapboxPlaceType(placeType) {
  switch (placeType) {
    case 'poi':
      return 'poi';
    case 'address':
      return 'address';
    case 'neighborhood':
    case 'locality':
      return 'neighborhood';
    case 'place':
    case 'district':
      return 'place';
    case 'region':
      return 'region';
    case 'country':
      return 'country';
    default:
      return 'place';
  }
}

export class MapboxGeocoderProvider extends GeocoderProvider {
  static PROVIDER_ID = 'mapbox';

  /** @param {string} token Mapbox public access token */
  constructor(token) {
    super();
    this._token = token;
  }

  /**
   * @param {string} query
   * @param {{ signal: AbortSignal }} opts
   * @returns {Promise<import('./GeocoderProvider.js').NormalizedResult[]>}
   */
  async autocomplete(query, { signal } = {}) {
    const url =
      `${GEOCODE_URL}/${encodeURIComponent(query)}.json` +
      `?access_token=${this._token}&autocomplete=true&limit=5`;

    const resp = await fetch(url, { signal });
    if (!resp.ok) return [];

    const data = await resp.json();
    return (data.features || []).map((f) => ({
      id: f.id,
      name: f.text,
      displayName: f.place_name,
      lat: f.center?.[1] ?? null,
      lon: f.center?.[0] ?? null,
      type: mapMapboxPlaceType((f.place_type || [])[0] || ''),
      _raw: f,
      _provider: 'mapbox',
    }));
  }

  isAvailable() {
    return !!this._token;
  }
}
