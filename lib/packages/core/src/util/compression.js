/**
 * compression.js — Shared shard decompression (A-4 / E-1).
 *
 * Canonical `maybeDecompress` for the sharded loaders. Three near-identical
 * private copies exist today in ShardedGFBLoader / ShardedH3FlexLoader /
 * ShardedDGFlexLoader; an A-4 characterization pass confirmed they produce
 * IDENTICAL output for every input:
 *   - gzip (magic 1F 8B)        → decompressed bytes
 *   - SHD3 (magic "SHD3")       → returned unchanged
 *   - anything else (plain)     → returned unchanged
 * The GFB copy has an explicit SHD3 early-return, but that is redundant: an
 * SHD3 buffer isn't gzip, so the other two also return it unchanged via the
 * fallback. There is no divergence to preserve — safe to extract.
 *
 * E-1 (Track E) rewires the three loaders to import this and deletes their copies.
 */

const GZIP_B0 = 0x1f;
const GZIP_B1 = 0x8b;

/**
 * Decompress a shard buffer if it is gzip-framed; otherwise return it as-is.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<ArrayBuffer>}
 */
export async function maybeDecompress(buffer) {
  const header = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (header[0] === GZIP_B0 && header[1] === GZIP_B1) {
    const ds = new DecompressionStream('gzip');
    const decompressed = new Response(new Blob([buffer]).stream().pipeThrough(ds));
    return decompressed.arrayBuffer();
  }
  // SHD3 and any other framing pass through untouched (decoders handle them).
  return buffer;
}
