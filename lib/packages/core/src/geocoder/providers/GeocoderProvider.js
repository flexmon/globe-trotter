/**
 * GeocoderProvider — abstract interface for geocoder providers.
 *
 * Mirrors the BasemapProvider style established for tile providers
 * (lib/packages/core/src/tiles/providers/BasemapProvider.js).
 *
 * All providers return results normalized to the common NormalizedResult shape:
 *
 *   {
 *     id:          string,                    // provider-scoped unique ID
 *     name:        string,                    // headline label (e.g. "Empire State Building")
 *     displayName: string,                    // secondary subtitle (e.g. "20 W 34th St, New York…")
 *     lat:         number | null,             // null when _needsResolve is true
 *     lon:         number | null,             // null when _needsResolve is true
 *     type:        string,                    // unified vocabulary (see flyToDistanceForType)
 *     _raw:        object,                    // pass-through provider-specific feature data
 *     _provider:   'mapbox' | 'google',       // discriminator
 *     _needsResolve?: boolean,               // true when lat/lon must be fetched separately
 *   }
 *
 * Subclasses MUST set:
 *   static PROVIDER_ID  — short identifier ('mapbox', 'google', …)
 *
 * Subclasses MUST implement:
 *   autocomplete(query, { signal, viewport })  → Promise<NormalizedResult[]>
 *   isAvailable()                              → boolean
 *
 * Subclasses MAY override:
 *   resolvePlace(id)                           → Promise<Partial<NormalizedResult>|null>
 *   resetSession()                             → void
 *
 * TODO: When the 2D repo adds a geocoder, promote this abstraction to a
 * shared package to avoid duplication.
 */

export class GeocoderProvider {
  /** @type {string} */
  static PROVIDER_ID = 'abstract';

  /**
   * Return autocomplete suggestions for the given query string.
   *
   * Implementations MUST respect the AbortSignal and throw (or swallow)
   * the AbortError so GeocoderDialog can cancel in-flight requests safely.
   *
   * @param {string} query
   * @param {{ signal: AbortSignal, viewport?: { minLat: number, maxLat: number, minLon: number, maxLon: number } }} opts
   * @returns {Promise<NormalizedResult[]>}
   */
  async autocomplete(_query, _opts) {
    throw new Error('GeocoderProvider.autocomplete() must be overridden');
  }

  /**
   * Resolve a suggestion's lat/lon when _needsResolve is true (Google two-step flow).
   * For providers that return coordinates in autocomplete, this is a no-op.
   *
   * @param {string} _id  Provider-specific place identifier
   * @returns {Promise<Partial<NormalizedResult>|null>}
   */
  async resolvePlace(_id) {
    return null;
  }

  /**
   * Detach any session-scoped state (e.g. Google billing session token).
   * Called when the panel closes or a selection is made.
   */
  resetSession() {}

  /**
   * Whether this provider has the credentials needed to serve requests.
   * @returns {boolean}
   */
  isAvailable() {
    return false;
  }
}

/**
 * Map a unified place type string to a camera fly-to distance multiplier.
 *
 * Both MapboxGeocoderProvider and GoogleGeocoderProvider populate
 * NormalizedResult.type using this vocabulary. GeocoderDialog calls this
 * instead of switching on Mapbox-specific place_type strings.
 *
 * @param {string} type
 * @returns {number}
 */
export function flyToDistanceForType(type) {
  switch (type) {
    case 'address':
    case 'poi':
      return 1.002;
    case 'neighborhood':
      return 1.01;
    case 'place':
      return 1.05;
    case 'region':
      return 1.2;
    case 'country':
      return 1.8;
    default:
      return 1.05;
  }
}
