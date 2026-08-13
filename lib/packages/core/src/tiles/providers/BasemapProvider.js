/**
 * BasemapProvider — abstract interface for basemap tile providers.
 *
 * A provider is responsible for:
 *   - Declaring the styles it supports (via the static STYLES map)
 *   - Performing any one-time async setup (e.g. session-token bootstrap)
 *   - Building the tile URL for a given (z, x, y, style)
 *   - Returning the attribution string the footer must display
 *   - Reporting fetch errors to the TileManager so it can decide how to recover
 *
 * Web-Mercator-only: every provider must serve XYZ tiles in the standard
 * Web Mercator projection at integer zoom levels [0, maxZoom]. The TileManager
 * does not care which provider is active — it only calls the methods on this
 * interface.
 *
 * Subclasses MUST set the static class fields:
 *   static PROVIDER_ID    — short identifier ('mapbox', 'google', ...)
 *   static STYLES         — { [styleKey]: { label, ... } }
 *   static DEFAULT_STYLE  — key into STYLES used as the default
 *
 * Subclasses MUST implement:
 *   getTileUrl(z, x, y, style)
 *
 * Subclasses MAY override:
 *   ensureReady(style)        — async one-time setup per style (default no-op)
 *   getAttribution(style)     — string for footer (default empty)
 *   handleFetchError(res, key) — decision string (default 'fail')
 */

export class BasemapProvider {
  /** @type {string} */
  static PROVIDER_ID = 'abstract';

  /** @type {Record<string, { label: string }>} */
  static STYLES = {};

  /** @type {string} */
  static DEFAULT_STYLE = '';

  /**
   * Async one-time setup for the given style. Called by TileManager BEFORE
   * any tiles are requested for the style. Idempotent — safe to call
   * repeatedly; subclasses should cache the result.
   *
   * @param {string} style
   * @returns {Promise<void>}
   */
  async ensureReady(_style) {
    return;
  }

  /**
   * Build the URL to fetch the (z, x, y) tile for the given style.
   *
   * @param {number} z
   * @param {number} x
   * @param {number} y
   * @param {string} style
   * @returns {string}
   */
  getTileUrl(_z, _x, _y, _style) {
    throw new Error('BasemapProvider.getTileUrl() must be overridden');
  }

  /**
   * Attribution text the footer must display.
   * Mapbox returns a static string; Google returns the `copyright` field
   * obtained from createSession.
   *
   * @param {string} style
   * @returns {string}
   */
  getAttribution(_style) {
    return '';
  }

  /**
   * Maximum tile zoom level for the given style, or null if the provider
   * imposes no cap (TileManager falls back to its configured default).
   * GoogleProvider returns the value from the createSession response.
   * MapboxProvider returns the per-style maximum.
   *
   * @param {string} _style
   * @returns {number|null}
   */
  getMaxZoom(_style) {
    return null;
  }

  /**
   * Tile pixel width for the given style. Returns null if unknown (TileManager
   * falls back to 512px-equivalent bias). Override in providers that report
   * actual tile dimensions (e.g. GoogleProvider reads it from createSession).
   *
   * @param {string} _style
   * @returns {number|null}
   */
  getTileWidth(_style) {
    return null;
  }

  /**
   * Handle a non-OK fetch response. Returns one of:
   *   'fail'              — give up (default behaviour)
   *   'refresh-and-retry' — invalidate any cached auth/session and re-queue
   *
   * @param {Response} res
   * @param {string} key
   * @returns {'fail'|'refresh-and-retry'}
   */
  handleFetchError(_res, _key) {
    return 'fail';
  }
}
