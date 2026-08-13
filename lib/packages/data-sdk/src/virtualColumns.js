/**
 * Virtual epoch column helpers — shared across all *Flex formats.
 *
 * Matches Rust flex-format common.rs:
 *   _epoch      → Uint32 (epoch index within the dataset)
 *   _epoch_start → BigInt64 (unix seconds UTC, start of this epoch window)
 *   _epoch_end   → BigInt64 (unix seconds UTC, end of this epoch window)
 *
 * These are always the LAST 3 columns in any *Flex schema.
 * All timestamps are UTC — Globe Trotter stores all global network telemetry in UTC.
 */

/**
 * Virtual column names — order matters. Always appended as the last 3 fields.
 */
export const VIRTUAL_COL_NAMES = Object.freeze(['_epoch', '_epoch_start', '_epoch_end']);

/**
 * Create virtual epoch column arrays for a given epoch.
 *
 * @param {number} epoch — epoch index (0-based)
 * @param {number} rowCount — number of rows in this batch
 * @param {number} startTimestamp — dataset start time (unix seconds UTC)
 * @param {number} epochInterval — seconds per epoch
 * @returns {{ _epoch: Uint32Array, _epoch_start: BigInt64Array, _epoch_end: BigInt64Array }}
 */
export function createVirtualEpochArrays(epoch, rowCount, startTimestamp, epochInterval) {
  const epochStart = startTimestamp + epoch * epochInterval;
  const epochEnd = epochStart + epochInterval;

  const _epoch = new Uint32Array(rowCount).fill(epoch);
  const _epoch_start = new BigInt64Array(rowCount).fill(BigInt(epochStart));
  const _epoch_end = new BigInt64Array(rowCount).fill(BigInt(epochEnd));

  return { _epoch, _epoch_start, _epoch_end };
}

/**
 * Virtual column type codes (for SHD2 encoding).
 */
export const VIRTUAL_COL_TYPE_CODES = Object.freeze({
  _epoch: 0x04, // UInt32
  _epoch_start: 0x0c, // Timestamp (i64 seconds)
  _epoch_end: 0x0c, // Timestamp (i64 seconds)
});
