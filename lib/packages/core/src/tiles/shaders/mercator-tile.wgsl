// Mercator tile shader (WebGPU) — flat-quad raster tiles in world-pixel space.
//
// Mirrors the WebGL2 mercator-tile.{vert,frag} pair. Single instanced draw call
// per frame: each instance reads its world rect + texture-array layer index
// from a per-tile storage buffer, then projects to clip space via the simple
// 2D camera offset / viewport-half transform used by MercatorCameraController.

struct Uniforms {
  // Packed as two vec4<f32> to satisfy std140-style 16-byte alignment.
  // worldSizeOpacityPad: (worldSize, opacity, 0, 0) — worldSize unused in this
  // shader (cameraOffset already lives in world pixels) but kept for parity
  // with the WebGL2 uniform set so the same JS code can fill both backends.
  worldSizeOpacityPad : vec4<f32>,
  cameraOffsetViewport : vec4<f32>,  // (cameraX, cameraY, viewportW, viewportH)
};

struct TileData {
  // (worldX, worldY, tileSize, _pad)
  rect : vec4<f32>,
  // (layerIndex, _pad, _pad, _pad)
  layer : vec4<u32>,
};

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(1) @binding(0) var tileArray : texture_2d_array<f32>;
@group(1) @binding(1) var tileSampler : sampler;
@group(2) @binding(0) var<storage, read> tiles : array<TileData>;

struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) layer : u32,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vi : u32,
  @builtin(instance_index) ii : u32,
) -> VsOut {
  // Unit-quad corners for the 6 indices (two triangles).
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 1.0),
  );
  let c = corners[vi];

  let tile = tiles[ii];
  let worldX = tile.rect.x;
  let worldY = tile.rect.y;
  let tileSize = tile.rect.z;
  let worldPos = vec2<f32>(worldX, worldY) + c * tileSize;

  let cameraX = u.cameraOffsetViewport.x;
  let cameraY = u.cameraOffsetViewport.y;
  let vpW = u.cameraOffsetViewport.z;
  let vpH = u.cameraOffsetViewport.w;

  let sx =  (worldPos.x - cameraX) / (vpW * 0.5);
  let sy = -(worldPos.y - cameraY) / (vpH * 0.5);

  var out : VsOut;
  out.pos = vec4<f32>(sx, sy, 0.0, 1.0);
  out.uv = c;
  out.layer = tile.layer.x;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let opacity = u.worldSizeOpacityPad.y;
  let color = textureSample(tileArray, tileSampler, in.uv, i32(in.layer));
  if (color.a < 0.01) { discard; }
  return vec4<f32>(color.rgb, color.a * opacity);
}
