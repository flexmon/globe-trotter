// tests/h3FlexMesh.test.js — Tests for H3Flex mesh build, encode, and decode (H3M1 format)
import { gunzipSync } from 'zlib';
import { decodeH3Mesh } from '../src/layers/H3FlexDecoder.js';
import { H3FlexEncoder } from '../lib/packages/data-sdk/src/encoders/H3FlexEncoder.js';

// ─── fs mock ────────────────────────────────────────────────────────────────
const writtenFiles = {};
vi.mock('fs', () => ({
  writeFileSync: vi.fn((filePath, data) => {
    const key = filePath.toString().replace(/.*[\\/]/, '');
    writtenFiles[key] = data;
  }),
  mkdirSync: vi.fn(),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function gunzipToArrayBuffer(buf) {
  return toArrayBuffer(gunzipSync(buf));
}

function getWritten(suffix) {
  const key = Object.keys(writtenFiles).find((k) => k.endsWith(suffix));
  if (!key)
    throw new Error(
      `No file matching '${suffix}'. Written: ${Object.keys(writtenFiles).join(', ')}`
    );
  return writtenFiles[key];
}

/**
 * Mock cellToBoundary for a regular N-gon of radius R centered at (lat, lon).
 * Returns [[lat0,lon0], ..., [lat{N-1},lon{N-1}]].
 */
function makeMockCellToBoundary(numVerts = 6, radius = 0.001) {
  return function (cellId) {
    // Decode lat/lon from the fake cell ID we'll use
    const idx = parseInt(cellId, 16) % 1000;
    const baseLat = (idx * 0.1) % 90;
    const baseLon = (idx * 0.1) % 180;
    return Array.from({ length: numVerts }, (_, v) => {
      const angle = ((2 * Math.PI) / numVerts) * v;
      return [baseLat + radius * Math.sin(angle), baseLon + radius * Math.cos(angle)];
    });
  };
}

const MOCK_CELL_IDS = ['0', '1', '2'];
const MOCK_CENTERS = [
  [0, 0],
  [10, 20],
  [30, 40],
];

beforeEach(() => {
  Object.keys(writtenFiles).forEach((k) => delete writtenFiles[k]);
  vi.clearAllMocks();
});

// ─── buildMesh tests ─────────────────────────────────────────────────────────

describe('H3FlexEncoder.buildMesh', () => {
  test('single hex cell: vertex count = 1 centroid + 6 top + 6 base = 13', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['0'], [[0, 0]]);
    const cellToBoundary = makeMockCellToBoundary(6);

    const mesh = enc.buildMesh(cellToBoundary);

    // 1 centroid + 6 top + 6 base = 13 vertices
    expect(mesh.vertCount).toBe(13);
  });

  test('single hex cell: index count = 6 top tris + 12 side tris = 18 tris = 54 indices', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['0'], [[0, 0]]);
    const cellToBoundary = makeMockCellToBoundary(6);

    const mesh = enc.buildMesh(cellToBoundary);

    // 6 top fan triangles + 6*2 side quad triangles = 18 tris × 3 indices = 54
    expect(mesh.idxCount).toBe(54);
  });

  test('pentagon (5-vert) cell: vertex count = 1 + 5 + 5 = 11', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['0'], [[0, 0]]);
    const cellToBoundary = makeMockCellToBoundary(5); // pentagon

    const mesh = enc.buildMesh(cellToBoundary);

    expect(mesh.vertCount).toBe(11); // 1 + 5 + 5
  });

  test('multi-cell mesh scales vertex/index counts linearly', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(MOCK_CELL_IDS, MOCK_CENTERS);
    const cellToBoundary = makeMockCellToBoundary(6);

    const mesh = enc.buildMesh(cellToBoundary);

    // 3 cells × 13 verts/cell = 39
    expect(mesh.vertCount).toBe(39);
    // 3 cells × 54 indices = 162
    expect(mesh.idxCount).toBe(162);
  });

  test('positions array length = vertCount × 3 (x,y,z)', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(MOCK_CELL_IDS, MOCK_CENTERS);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));

    expect(mesh.positions.length).toBe(mesh.vertCount * 3);
  });

  test('cellIndices array length = vertCount', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(MOCK_CELL_IDS, MOCK_CENTERS);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));

    expect(mesh.cellIndices.length).toBe(mesh.vertCount);
  });

  test('extrudeFlags array length = vertCount', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(MOCK_CELL_IDS, MOCK_CENTERS);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));

    expect(mesh.extrudeFlags.length).toBe(mesh.vertCount);
  });

  test('centroid vertex has extrudeFlag = 1.0 (top)', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['0'], [[0, 0]]);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));

    // First vertex is the centroid — should be top (extrudeFlag=1.0)
    expect(mesh.extrudeFlags[0]).toBeCloseTo(1.0);
  });

  test('base vertices have extrudeFlag = 0.0', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['0'], [[0, 0]]);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));

    // Base vertices start at index 7 (centroid + 6 top) for a hex
    // Vertices 7-12 should all be base (0.0)
    for (let i = 7; i < 13; i++) {
      expect(mesh.extrudeFlags[i]).toBeCloseTo(0.0);
    }
  });

  test('all vertices for a cell have the correct cellIndex', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(MOCK_CELL_IDS, MOCK_CENTERS);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));

    // For a hex, 13 verts per cell
    // Cell 0: verts 0-12 → cellIndex=0
    for (let v = 0; v < 13; v++) {
      expect(mesh.cellIndices[v]).toBe(0);
    }
    // Cell 1: verts 13-25 → cellIndex=1
    for (let v = 13; v < 26; v++) {
      expect(mesh.cellIndices[v]).toBe(1);
    }
  });

  test('triangle indices are within valid vertex range', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(MOCK_CELL_IDS, MOCK_CENTERS);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));

    const maxIdx = mesh.vertCount - 1;
    for (let i = 0; i < mesh.idxCount; i++) {
      expect(mesh.indices[i]).toBeGreaterThanOrEqual(0);
      expect(mesh.indices[i]).toBeLessThanOrEqual(maxIdx);
    }
  });
});

// ─── encodeMesh / decodeH3Mesh roundtrip ────────────────────────────────────

describe('H3FlexEncoder.encodeMesh / decodeH3Mesh roundtrip', () => {
  test('H3M1 magic bytes are written correctly', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['0'], [[0, 0]]);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));
    const meshBuf = enc.encodeMesh(mesh);

    expect(String.fromCharCode(...meshBuf.slice(0, 4))).toBe('H3M1');
  });

  test('encodeMesh / decodeH3Mesh roundtrips vertexCount and indexCount', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['0'], [[0, 0]]);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));
    const meshBuf = enc.encodeMesh(mesh);
    const decoded = decodeH3Mesh(toArrayBuffer(meshBuf));

    expect(decoded.vertexCount).toBe(mesh.vertCount);
    expect(decoded.indexCount).toBe(mesh.idxCount);
  });

  test('encodeMesh / decodeH3Mesh roundtrips positions', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['0'], [[0, 0]]);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));
    const meshBuf = enc.encodeMesh(mesh);
    const decoded = decodeH3Mesh(toArrayBuffer(meshBuf));

    expect(decoded.positions.length).toBe(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i++) {
      expect(decoded.positions[i]).toBeCloseTo(mesh.positions[i], 4);
    }
  });

  test('encodeMesh / decodeH3Mesh roundtrips cellIndices', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(MOCK_CELL_IDS, MOCK_CENTERS);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));
    const meshBuf = enc.encodeMesh(mesh);
    const decoded = decodeH3Mesh(toArrayBuffer(meshBuf));

    expect(decoded.cellIndices.length).toBe(mesh.cellIndices.length);
    for (let i = 0; i < mesh.cellIndices.length; i++) {
      expect(decoded.cellIndices[i]).toBeCloseTo(mesh.cellIndices[i], 4);
    }
  });

  test('encodeMesh / decodeH3Mesh roundtrips extrudeFlags', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['0'], [[0, 0]]);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));
    const meshBuf = enc.encodeMesh(mesh);
    const decoded = decodeH3Mesh(toArrayBuffer(meshBuf));

    for (let i = 0; i < mesh.extrudeFlags.length; i++) {
      expect(decoded.extrudeFlags[i]).toBeCloseTo(mesh.extrudeFlags[i], 4);
    }
  });

  test('encodeMesh / decodeH3Mesh roundtrips indices', () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(['0'], [[0, 0]]);
    const mesh = enc.buildMesh(makeMockCellToBoundary(6));
    const meshBuf = enc.encodeMesh(mesh);
    const decoded = decodeH3Mesh(toArrayBuffer(meshBuf));

    expect(decoded.indices.length).toBe(mesh.indices.length);
    for (let i = 0; i < mesh.indices.length; i++) {
      expect(decoded.indices[i]).toBe(mesh.indices[i]);
    }
  });

  test('decodeH3Mesh rejects invalid magic', () => {
    const buf = new ArrayBuffer(16);
    const u8 = new Uint8Array(buf);
    u8[0] = 0x42;
    u8[1] = 0x41;
    u8[2] = 0x44;
    u8[3] = 0x21;
    expect(() => decodeH3Mesh(buf)).toThrow('Invalid H3Mesh magic');
  });

  test('full encode pipeline writes mesh file when cellToBoundary provided', async () => {
    const enc = new H3FlexEncoder({ epochInterval: 300 });
    enc.setCells(MOCK_CELL_IDS, MOCK_CENTERS);

    await enc.encode({
      output: '/tmp/test/',
      baseName: 'mydata',
      cellToBoundary: makeMockCellToBoundary(6),
    });

    // Mesh file should be written
    expect(() => getWritten('_mesh.h3f.gz')).not.toThrow();
    const meshFile = getWritten('_mesh.h3f.gz');
    const decoded = decodeH3Mesh(gunzipToArrayBuffer(meshFile));
    expect(decoded.vertexCount).toBe(39); // 3 cells × 13 verts
    expect(decoded.cellCount).toBe(3);
  });
});
