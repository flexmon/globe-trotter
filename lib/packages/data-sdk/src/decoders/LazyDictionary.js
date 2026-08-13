/**
 * LazyDictionary.js — On-demand UTF-8 string decoder for SHD3 ENUM columns.
 *
 * Stores raw UTF-8 bytes + a Uint32Array of offsets. Strings are decoded only
 * on first access, then cached. This avoids decoding the entire dictionary
 * upfront when callers only need a handful of category names.
 *
 * Compatible with the StyleEngine `compileCategoricalData` dictionary API:
 * implements `.getString(i)`, `.length`, `.map()`, `.findIndex()`,
 * `.indexOf()`, `.includes()`, `.forEach()`, and `[Symbol.iterator]`.
 */
export class LazyDictionary {
  /**
   * @param {Uint32Array} offsets - Start byte offsets for each string, plus one trailing end offset.
   *   Length = dictCount + 1.  offsets[i] is the start of string i; offsets[i+1] is its end.
   * @param {Uint8Array} data - Raw UTF-8 byte buffer that all strings reference into.
   */
  constructor(offsets, data) {
    this.offsets = offsets;
    this.data = data;
    this._decoder = new TextDecoder('utf-8');
    this._cache = new Map();
    /** Number of strings in the dictionary. */
    this.length = offsets.length - 1;
  }

  /**
   * Decode and return string at index `i`.
   * Returns `undefined` for out-of-range indices (mirrors Array behaviour).
   *
   * @param {number} i
   * @returns {string|undefined}
   */
  getString(i) {
    if (i < 0 || i >= this.length) return undefined;

    const cached = this._cache.get(i);
    if (cached !== undefined) return cached;

    const start = this.offsets[i];
    const end = this.offsets[i + 1];
    const str = start === end ? '' : this._decoder.decode(this.data.subarray(start, end));
    this._cache.set(i, str);
    return str;
  }

  // ── Array-compatible shims for drop-in replacement ──

  /**
   * Map each string in the dictionary through a callback, returning a new array.
   * Callback signature mirrors `Array.prototype.map`: (value, index, dict).
   *
   * @template T
   * @param {(value: string, index: number, dict: LazyDictionary) => T} fn
   * @returns {T[]}
   */
  map(fn) {
    const res = new Array(this.length);
    for (let i = 0; i < this.length; i++) res[i] = fn(this.getString(i), i, this);
    return res;
  }

  /**
   * Return the index of the first string for which the predicate returns true, or -1.
   * Callback signature mirrors `Array.prototype.findIndex`: (value, index, dict).
   *
   * @param {(value: string, index: number, dict: LazyDictionary) => boolean} fn
   * @returns {number} Index of the first match, or -1 if no match
   */
  findIndex(fn) {
    for (let i = 0; i < this.length; i++) {
      if (fn(this.getString(i), i, this)) return i;
    }
    return -1;
  }

  /**
   * Return the index of the first string that strictly equals `val`, or -1.
   * Equivalent to `Array.prototype.indexOf`.
   *
   * @param {string} val - The string to search for
   * @returns {number} Index of the first occurrence, or -1 if not found
   */
  indexOf(val) {
    return this.findIndex((s) => s === val);
  }

  /**
   * Return true if the dictionary contains at least one string equal to `val`.
   * Equivalent to `Array.prototype.includes`.
   *
   * @param {string} val - The string to search for
   * @returns {boolean}
   */
  includes(val) {
    return this.findIndex((s) => s === val) !== -1;
  }

  /**
   * Execute a callback once for each string in the dictionary.
   * Callback signature mirrors `Array.prototype.forEach`: (value, index, dict).
   *
   * @param {(value: string, index: number, dict: LazyDictionary) => void} fn
   */
  forEach(fn) {
    for (let i = 0; i < this.length; i++) fn(this.getString(i), i, this);
  }

  /**
   * Iterate over all strings in the dictionary in index order.
   * Enables `for...of` and spread (`[...dict]`) usage.
   *
   * @returns {Generator<string>}
   */
  *[Symbol.iterator]() {
    for (let i = 0; i < this.length; i++) yield this.getString(i);
  }
}
