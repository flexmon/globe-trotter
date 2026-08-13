// tests/rleCodec.test.js — Unit tests for RLE shard encode/decode roundtrip
//
// Tests the RLE cell-major binary format:
//   uint32 activeCellCount
//   Per cell: uint32 cellIndex, uint16 runCount, (uint16 runLength, float32 value) × runCount
//
// Decodes to dense Float32Array[epochCount × cellCount] (epoch-major)

/**
 * RLE encoder (mirrors the generator logic).
 * @param {Float32Array} data - Dense epoch-major data [epochCount × cellCount]
 * @param {number} epochCount
 * @param {number} cellCount
 * @returns {ArrayBuffer}
 */
function encodeRLE(data, epochCount, cellCount) {
  // Phase 1: Find active cells
  const activeCells = [];
  for (let i = 0; i < cellCount; i++) {
    for (let e = 0; e < epochCount; e++) {
      if (data[e * cellCount + i] > 0) {
        activeCells.push(i);
        break;
      }
    }
  }

  // Phase 2: Build runs
  const cellRuns = [];
  let totalRuns = 0;
  for (const cellIdx of activeCells) {
    const runs = [];
    let currentVal = data[0 * cellCount + cellIdx];
    let runLen = 1;

    for (let e = 1; e < epochCount; e++) {
      const val = data[e * cellCount + cellIdx];
      if (val === currentVal) {
        runLen++;
      } else {
        runs.push({ len: runLen, value: currentVal });
        currentVal = val;
        runLen = 1;
      }
    }
    runs.push({ len: runLen, value: currentVal });
    cellRuns.push({ cellIdx, runs });
    totalRuns += runs.length;
  }

  // Phase 3: Write binary
  const bufSize = 4 + activeCells.length * 6 + totalRuns * 6;
  const buffer = new ArrayBuffer(bufSize);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint32(offset, activeCells.length, true);
  offset += 4;
  for (const { cellIdx, runs } of cellRuns) {
    view.setUint32(offset, cellIdx, true);
    offset += 4;
    view.setUint16(offset, runs.length, true);
    offset += 2;
    for (const { len, value } of runs) {
      view.setUint16(offset, len, true);
      offset += 2;
      view.setFloat32(offset, value, true);
      offset += 4;
    }
  }

  return buffer;
}

/**
 * RLE decoder (mirrors ShardedH3FlexLoader._decodeShard logic).
 * @param {ArrayBuffer} buffer
 * @param {number} epochCount
 * @param {number} cellCount
 * @returns {Float32Array}
 */
function decodeRLE(buffer, epochCount, cellCount) {
  const dense = new Float32Array(epochCount * cellCount);
  const view = new DataView(buffer);
  let offset = 0;

  const activeCells = view.getUint32(offset, true);
  offset += 4;
  for (let c = 0; c < activeCells; c++) {
    const cellIdx = view.getUint32(offset, true);
    offset += 4;
    const runCount = view.getUint16(offset, true);
    offset += 2;
    let epoch = 0;
    for (let r = 0; r < runCount; r++) {
      const runLen = view.getUint16(offset, true);
      offset += 2;
      const value = view.getFloat32(offset, true);
      offset += 4;
      for (let i = 0; i < runLen && epoch < epochCount; i++, epoch++) {
        dense[epoch * cellCount + cellIdx] = value;
      }
    }
  }
  return dense;
}

describe('RLE Codec', () => {
  test('user example: [1,1,1,1,1,1,1,1,2,2,2,2,2,1] → 3 runs → roundtrip', () => {
    const epochCount = 14;
    const cellCount = 1;

    // Dense epoch-major: 1 cell, 14 epochs
    const dense = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1]);

    const encoded = encodeRLE(dense, epochCount, cellCount);
    const decoded = decodeRLE(encoded, epochCount, cellCount);

    expect(Array.from(decoded)).toEqual(Array.from(dense));

    // Verify binary size: 4 (header) + 6 (cell header) + 3×6 (runs) = 28 bytes
    expect(encoded.byteLength).toBe(28);
  });

  test('multi-cell roundtrip with zeros', () => {
    const epochCount = 6;
    const cellCount = 3;

    // Dense epoch-major layout:
    // epoch0: [10,  0,  5]
    // epoch1: [10,  0,  5]
    // epoch2: [10,  0,  5]
    // epoch3: [20,  0, 10]
    // epoch4: [20,  0, 10]
    // epoch5: [20,  0, 10]
    const dense = new Float32Array([
      10,
      0,
      5, // epoch 0
      10,
      0,
      5, // epoch 1
      10,
      0,
      5, // epoch 2
      20,
      0,
      10, // epoch 3
      20,
      0,
      10, // epoch 4
      20,
      0,
      10, // epoch 5
    ]);

    const encoded = encodeRLE(dense, epochCount, cellCount);
    const decoded = decodeRLE(encoded, epochCount, cellCount);

    expect(Array.from(decoded)).toEqual(Array.from(dense));

    // Only 2 active cells (cell 1 is all zeros → excluded)
    const view = new DataView(encoded);
    expect(view.getUint32(0, true)).toBe(2); // activeCellCount
  });

  test('all-zero data produces minimal output', () => {
    const epochCount = 100;
    const cellCount = 50;
    const dense = new Float32Array(epochCount * cellCount); // all zeros

    const encoded = encodeRLE(dense, epochCount, cellCount);
    const decoded = decodeRLE(encoded, epochCount, cellCount);

    expect(Array.from(decoded)).toEqual(Array.from(dense));
    expect(encoded.byteLength).toBe(4); // just the header: 0 active cells
  });

  test('every epoch different (worst case) still roundtrips', () => {
    const epochCount = 5;
    const cellCount = 1;
    const dense = new Float32Array([1, 2, 3, 4, 5]);

    const encoded = encodeRLE(dense, epochCount, cellCount);
    const decoded = decodeRLE(encoded, epochCount, cellCount);

    expect(Array.from(decoded)).toEqual(Array.from(dense));

    // 4 (header) + 6 (cell header) + 5×6 (5 runs of length 1) = 40 bytes
    // Dense would be 5×4 = 20 bytes → RLE is worse for unique values (expected)
    expect(encoded.byteLength).toBe(40);
  });

  test('single constant value (best case) compresses well', () => {
    const epochCount = 1000;
    const cellCount = 1;
    const dense = new Float32Array(epochCount).fill(42.5);

    const encoded = encodeRLE(dense, epochCount, cellCount);
    const decoded = decodeRLE(encoded, epochCount, cellCount);

    expect(Array.from(decoded)).toEqual(Array.from(dense));

    // 4 (header) + 6 (cell header) + 1×6 (1 run) = 16 bytes
    // Dense would be 1000×4 = 4000 bytes → 250× compression
    expect(encoded.byteLength).toBe(16);
  });

  test('interleaved zero runs are preserved', () => {
    const epochCount = 10;
    const cellCount = 1;
    // Value, then zeros, then value again
    const dense = new Float32Array([5, 5, 0, 0, 0, 0, 5, 5, 5, 5]);

    const encoded = encodeRLE(dense, epochCount, cellCount);
    const decoded = decodeRLE(encoded, epochCount, cellCount);

    expect(Array.from(decoded)).toEqual(Array.from(dense));
  });
});
