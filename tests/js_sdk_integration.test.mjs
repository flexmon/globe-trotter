import { strict as assert } from 'assert';
import { GeoFlexEncoder } from '../lib/packages/data-sdk/src/encoders/GeoFlexEncoder.js';
import { MetricFlexEncoder } from '../lib/packages/data-sdk/src/encoders/MetricFlexEncoder.js';
import { H3FlexEncoder } from '../lib/packages/data-sdk/src/encoders/H3FlexEncoder.js';
import { decodeGFB } from '../lib/packages/core/src/layers/GFBDecoder.js';
import { decodeMFB } from '../lib/packages/core/src/layers/MFBDecoder.js';
import { decodeH3Flex } from '../lib/packages/core/src/layers/H3FlexDecoder.js';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { resolve } from 'path';

const OUT_DIR = resolve('./tests/output_shd2');

async function testGFB() {
  console.log('\\n[TEST] GeoFlexEncoder -> decodeGFB (SHD2)');
  const encoder = new GeoFlexEncoder({
    featureCount: 2,
    epochCount: 2,
    epochInterval: 60,
    hasAltitude: true,
    isTemporalGeom: true,
  });

  // Positions (lon, lat, alt) x 2 entities x 2 epochs = 12 floats
  // e0: [-10, 20, 100, -11, 21, 101]
  // e1: [-12, 22, 102, -13, 23, 103]
  const pos = new Float32Array([-10, 20, 100, -11, 21, 101, -12, 22, 102, -13, 23, 103]);
  encoder.setPositions(pos);

  // Static Column
  encoder.addColumn('aircraft_type', ['B737', 'A320']); // dictionary string
  // Temporal Column
  encoder.setTemporalData('speed', new Float32Array([450, 460, 470, 480]));

  // Output SHD2
  await encoder.encode({
    output: OUT_DIR,
    baseName: 'test_gfb',
    gzipLevel: 0,
    manifest: { desc: 'Test GFB' },
  });

  // Assert files exist
  assert(existsSync(resolve(OUT_DIR, 'test_gfb.manifest.json')));
  assert(existsSync(resolve(OUT_DIR, 'test_gfb_base.gfb.gz')));
  assert(existsSync(resolve(OUT_DIR, 'test_gfb_e0000-e0001.shard')));

  // Load Manifest
  const manifest = JSON.parse(readFileSync(resolve(OUT_DIR, 'test_gfb.manifest.json'), 'utf8'));

  // Test Shard Decode (Geometry + Temporal)
  // NOTE: decodeGFB expects ArrayBuffer, readFileSync returns Buffer, which shares backing ArrayBuffer
  let shardBuf = readFileSync(resolve(OUT_DIR, 'test_gfb_e0000-e0001.shard'));
  shardBuf = shardBuf.buffer.slice(shardBuf.byteOffset, shardBuf.byteOffset + shardBuf.byteLength);

  const shardData = await decodeGFB(shardBuf, manifest);

  // Validate Geometry unpacking
  assert.equal(shardData.featureCount, 2);
  assert.equal(shardData.epochCount, 2);
  assert.equal(shardData.geometry.type, 'temporal_point');
  assert.equal(shardData.geometry.hasAltitude, true);

  // packRGBA32F layout: epoch-major, padded to square texture root
  // 2 features -> ceil(sqrt(2))=2 -> 4 texels per epoch
  // lon, lat, alt, 0
  const packed = shardData.geometry.packedPositions;
  assert.equal(packed.length, 2 * 4 * 4); // 32 floats

  // e0, f0: lon=-10, lat=20, alt=100
  assert.equal(packed[0], -10);
  assert.equal(packed[1], 20);
  assert.equal(packed[2], 100);

  // e1, f1: lon=-13, lat=23, alt=103
  assert.equal(packed[16 + 4], -13); // offset: e1 base (16) + index 1*4 (4)
  assert.equal(packed[16 + 5], 23);
  assert.equal(packed[16 + 6], 103);

  // Validate Temporal
  assert.equal(shardData.temporalColumns['speed'][0], 450);
  assert.equal(shardData.temporalColumns['speed'][3], 480);

  // Test Base Decode (Static attributes)
  let baseBuf = readFileSync(resolve(OUT_DIR, 'test_gfb_base.gfb.gz'));
  baseBuf = baseBuf.buffer.slice(baseBuf.byteOffset, baseBuf.byteOffset + baseBuf.byteLength);

  // Note: zlib compressed! We can mock or just assume JS sdk doesn't natively gunzip
  // unless streamingDataLoader does it. The test env does NOT auto gunzip in JS without DecompressionStream.
  // However, encodeShardV2 doesn't compress if gzipLevel=0 ... wait, GeoFlexEncoder hardcodes gzipSync for baseBuf.
  // Let's rely on Node's zlib to unzip it first just for the test.
  const zlib = await import('zlib');
  const decompressedBase = zlib.gunzipSync(new Uint8Array(baseBuf));
  const baseBuffer = decompressedBase.buffer.slice(
    decompressedBase.byteOffset,
    decompressedBase.byteOffset + decompressedBase.byteLength
  );

  const baseData = await decodeGFB(baseBuffer, manifest);
  assert.equal(baseData.staticColumns['aircraft_type'][0], 0); // Dictionary index
  assert.equal(baseData.dictionary[0], 'B737');
  console.log('✅ GeoFlex Pipeline Verified');
}

async function testMFB() {
  console.log('\\n[TEST] MetricFlexEncoder -> decodeMFB (SHD2)');
  const encoder = new MetricFlexEncoder({ entityCount: 3, epochCount: 1, epochInterval: 60 });
  encoder.addColumn('airline', ['Delta', 'United', 'Delta']);
  encoder.addColumn('revenue', new Float32Array([10.5, 20.0, 30.1]));
  encoder.setEntityIds('tail_id', new Uint32Array([0, 1, 2]));

  await encoder.encode({ output: OUT_DIR, baseName: 'test_mfb', gzipLevel: 0 });

  const manifest = JSON.parse(readFileSync(resolve(OUT_DIR, 'test_mfb.manifest.json')));

  let baseBuf = readFileSync(resolve(OUT_DIR, 'test_mfb.mfb'));
  baseBuf = baseBuf.buffer.slice(baseBuf.byteOffset, baseBuf.byteOffset + baseBuf.byteLength);

  const data = await decodeMFB(baseBuf, manifest);

  assert.equal(data.entityCount, 3);
  assert(Math.abs(data.staticColumns['revenue'][2] - 30.1) < 0.001);

  // Dict string array resolution mapped by decoder
  assert.equal(data.dictionaries['airline'][data.staticColumns['airline'][0]], 'Delta');
  assert.equal(data.dictionaries['airline'][data.staticColumns['airline'][1]], 'United');
  console.log('✅ MetricFlex Pipeline Verified');
}

async function testH3F() {
  console.log('\\n[TEST] H3FlexEncoder -> decodeH3Flex (SHD2)');
  const encoder = new H3FlexEncoder({ epochInterval: 60, epochCount: 1 }); // res 8

  // Using string hex IDs
  const h3Ids = ['88283082a9fffff', '8828308285fffff'];
  encoder.setCells(h3Ids, new Float64Array([40.1, -73.1, 40.2, -73.2]));

  encoder.addColumn('population', new Int32Array([1000, 2000]));
  encoder.setTemporalData('demand', new Float32Array([5.5, 9.9]));

  await encoder.encode({ output: OUT_DIR, baseName: 'test_h3f', gzipLevel: 0 });

  const manifest = JSON.parse(readFileSync(resolve(OUT_DIR, 'test_h3f.manifest.json')));

  let baseBuf = readFileSync(resolve(OUT_DIR, 'test_h3f_base.h3f.gz'));
  const zlib = await import('zlib');
  baseBuf = zlib.gunzipSync(baseBuf);
  baseBuf = baseBuf.buffer.slice(baseBuf.byteOffset, baseBuf.byteOffset + baseBuf.byteLength);

  const baseData = await decodeH3Flex(baseBuf, manifest);

  assert.equal(baseData.dataCount, 2);
  assert.equal(baseData.staticColumns['population'][1], 2000);

  // H3 index validation (uint64 BigInt arrays decoded natively)
  const encodedH3 =
    baseData.cellIds || baseData.h3Indices || baseData.indices || baseData.cellIndex;
  assert.equal(encodedH3.length, 2);
  assert.equal(encodedH3[0].toString(16), '88283082a9fffff');
  assert.equal(encodedH3[1].toString(16), '8828308285fffff');

  let shardBuf = readFileSync(resolve(OUT_DIR, 'test_h3f_e0000-e0000.shard'));
  shardBuf = shardBuf.buffer.slice(shardBuf.byteOffset, shardBuf.byteOffset + shardBuf.byteLength);

  const shardData = await decodeH3Flex(shardBuf, manifest);

  // Verify temporal column
  assert.ok('demand' in shardData.temporalColumns);
  assert(Math.abs(shardData.temporalColumns['demand'][1] - 9.9) < 0.001);

  console.log('✅ H3Flex Pipeline Verified');
}

async function run() {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  try {
    await testGFB();
    await testMFB();
    await testH3F();
    console.log('\\n[SUCCESS] All JS SDK Encoders & SHD2 Decoders Verified');
  } catch (e) {
    console.error('\\n[FAILURE] Integration Test Failed:', e);
    process.exit(1);
  }
}

run();
