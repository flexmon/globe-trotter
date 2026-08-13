import fs from 'fs';
import zlib from 'zlib';
import { decodeGFB } from '../lib/packages/core/src/layers/GFBDecoder.js';
import {
  isShardV2,
  parseShardHeader,
} from '../lib/packages/data-sdk/src/decoders/ShardV2Decoder.js';

try {
  const buf = zlib.gunzipSync(
    fs.readFileSync('./public/data/mobile-demand-sim/aircraft_tracks_base.gfb.gz')
  );
  const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  console.log('isShardV2:', isShardV2(arrayBuf));
  console.log('parseShardHeader:', parseShardHeader(arrayBuf));
  await decodeGFB(arrayBuf, { epochCount: 10 });
  console.log('Decode GFB successful');
} catch (e) {
  console.error('Error during decode:', e);
}
