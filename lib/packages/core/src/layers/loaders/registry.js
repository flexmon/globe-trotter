/**
 * registry.js — LoaderRegistry (§C.1).
 *
 * Maps a loader `type` to its loader class and constructs an instance with the
 * uniform (manifestUrl, opts) signature. All sharded loaders extend ShardLoader;
 * StreamingGFBLoader does not (live transport) but exposes the same
 * load()/dispose() surface.
 *
 *   type ∈ {'h3f','dgf','gfb','mfb','gfb-stream'}
 */

import { H3FlexShards } from './H3FlexShards.js';
import { DGFlexShards } from './DGFlexShards.js';
import { GFBShards } from './GFBShards.js';
import { MFBShards } from './MFBShards.js';
import { StreamingGFBLoader } from './StreamingGFBLoader.js';

/** @type {Record<string, new (manifestUrl: string, opts?: object) => object>} */
const LOADER_CLASSES = {
  h3f: H3FlexShards,
  dgf: DGFlexShards,
  gfb: GFBShards,
  mfb: MFBShards,
  'gfb-stream': StreamingGFBLoader,
};

export class LoaderRegistry {
  /**
   * Construct a loader instance for the given type.
   * @param {'h3f'|'dgf'|'gfb'|'mfb'|'gfb-stream'} type
   * @param {string} manifestUrl
   * @param {object} [opts]
   * @returns {object} A loader exposing load()/dispose()
   */
  static create(type, manifestUrl, opts = {}) {
    const Cls = LOADER_CLASSES[type];
    if (!Cls) {
      throw new Error(`LoaderRegistry: unknown loader type "${type}"`);
    }
    return new Cls(manifestUrl, opts);
  }

  /** True if the registry knows how to build a loader for `type`. */
  static has(type) {
    return Object.prototype.hasOwnProperty.call(LOADER_CLASSES, type);
  }
}
