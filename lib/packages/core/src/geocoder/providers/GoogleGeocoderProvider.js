/**
 * GoogleGeocoderProvider — Google Places Autocomplete (New) + Place Details (New).
 *
 * Two-step flow required by the Google Places API (New):
 *   1. autocomplete()   — POST places:autocomplete → returns suggestions WITHOUT lat/lon.
 *                         Results have _needsResolve: true; lat/lon are populated lazily.
 *   2. resolvePlace()   — GET places/{placeId} → returns lat/lon + canonical fields.
 *                         Called by GeocoderDialog when the user clicks a suggestion.
 *
 * Session token:
 *   A UUID session token is included in both calls and bundles them into a
 *   single billing event ("Autocomplete (Session) + Place Details"). The token
 *   is invalidated immediately after the Place Details call succeeds.
 *   See: https://developers.google.com/maps/documentation/places/web-service/session-tokens
 *
 * Viewport biasing:
 *   When a viewport is supplied (derived from the current camera position),
 *   it is passed as locationBias.rectangle to bias suggestions toward the
 *   visible area without restricting results.
 *
 * Required Cloud Console APIs (same key as Map Tiles):
 *   - Places API (New)  — for autocomplete + place details
 */

import { GeocoderProvider } from './GeocoderProvider.js';

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';

/**
 * Build the Place Details URL for a given placeId.
 * @param {string} placeId
 * @returns {string}
 */
function placeDetailsUrl(placeId) {
  return `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
}

/**
 * Map Google Places types array to the unified type vocabulary.
 *
 * @param {string[]} types
 * @returns {string}
 */
function googleTypesToUnified(types) {
  for (const t of types) {
    switch (t) {
      case 'street_address':
      case 'premise':
      case 'subpremise':
      case 'route':
        return 'address';
      case 'point_of_interest':
      case 'establishment':
        return 'poi';
      case 'neighborhood':
      case 'sublocality':
      case 'sublocality_level_1':
      case 'sublocality_level_2':
      case 'sublocality_level_3':
      case 'sublocality_level_4':
      case 'sublocality_level_5':
        return 'neighborhood';
      case 'locality':
      case 'administrative_area_level_2':
      case 'administrative_area_level_3':
        return 'place';
      case 'administrative_area_level_1':
        return 'region';
      case 'country':
        return 'country';
    }
  }
  return 'place';
}

export class GoogleGeocoderProvider extends GeocoderProvider {
  static PROVIDER_ID = 'google';

  /** @param {string} apiKey Google Maps Platform API key (Places API New enabled) */
  constructor(apiKey) {
    super();
    this._apiKey = apiKey;
    this._sessionToken = null;
  }

  /**
   * Ensure a session token exists (lazily created per-session).
   * @returns {string}
   */
  _ensureSession() {
    if (!this._sessionToken) {
      this._sessionToken = crypto.randomUUID();
    }
    return this._sessionToken;
  }

  /**
   * Invalidate the current session token.
   * MUST be called after a successful resolvePlace() call (per Google's billing rules).
   * Also called when the user closes the panel without making a selection.
   */
  resetSession() {
    this._sessionToken = null;
  }

  /**
   * @param {string} query
   * @param {{
   *   signal?: AbortSignal,
   *   viewport?: { minLat: number, maxLat: number, minLon: number, maxLon: number }
   * }} opts
   * @returns {Promise<import('./GeocoderProvider.js').NormalizedResult[]>}
   */
  async autocomplete(query, { signal, viewport } = {}) {
    const body = {
      input: query,
      sessionToken: this._ensureSession(),
    };

    // Bias results toward the current camera viewport when available.
    // Uses locationBias (not locationRestriction) to preserve global recall.
    if (viewport) {
      body.locationBias = {
        rectangle: {
          low: { latitude: viewport.minLat, longitude: viewport.minLon },
          high: { latitude: viewport.maxLat, longitude: viewport.maxLon },
        },
      };
    }

    const resp = await fetch(AUTOCOMPLETE_URL, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this._apiKey,
        // Field mask is REQUIRED and must be minimal to stay in the cheaper billing tier.
        'X-Goog-FieldMask':
          'suggestions.placePrediction.placeId,' +
          'suggestions.placePrediction.text,' +
          'suggestions.placePrediction.structuredFormat,' +
          'suggestions.placePrediction.types',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) return [];

    const data = await resp.json();
    return (data.suggestions || []).map((s) => {
      const p = s.placePrediction;
      const sf = p.structuredFormat || {};
      return {
        id: p.placeId,
        name: sf.mainText?.text || p.text?.text || '',
        displayName: sf.secondaryText?.text || p.text?.text || '',
        lat: null, // resolved lazily via resolvePlace()
        lon: null,
        type: googleTypesToUnified(p.types || []),
        _raw: p,
        _provider: 'google',
        _needsResolve: true,
      };
    });
  }

  /**
   * Resolve a placeId to lat/lon (second billable event in the session).
   *
   * The session token is invalidated AFTER a successful response to correctly
   * bundle billing. If the network call fails, the session is preserved so the
   * user can retry without starting a new (more expensive) session.
   *
   * @param {string} placeId
   * @returns {Promise<Partial<import('./GeocoderProvider.js').NormalizedResult>|null>}
   */
  async resolvePlace(placeId) {
    const sessionToken = this._ensureSession();
    // NOTE: Google Places API (New) Place Details is a GET-only endpoint;
    // sessionToken must be a query parameter per the API spec.  The token is
    // ephemeral (single-use, reset after each successful call) so exposure
    // in server logs / browser history is minimal.
    const url = `${placeDetailsUrl(placeId)}?sessionToken=${sessionToken}`;

    const resp = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': this._apiKey,
        // Minimal field mask — each field added may bump into a higher cost tier.
        'X-Goog-FieldMask': 'id,location,displayName,formattedAddress,types',
      },
    });

    if (!resp.ok) {
      // Do NOT reset session on failure; preserve it so a retry stays in the same session.
      return null;
    }

    // Session is consumed after a successful Place Details call — reset it.
    this.resetSession();

    const data = await resp.json();
    return {
      lat: data.location?.latitude ?? null,
      lon: data.location?.longitude ?? null,
      name: data.displayName?.text || '',
      displayName: data.formattedAddress || '',
      type: googleTypesToUnified(data.types || []),
    };
  }

  isAvailable() {
    return !!this._apiKey;
  }
}
