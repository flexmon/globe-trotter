// Mercator ground shader (WebGPU) — flat Blue Marble fallback quad for the 2D
// projection, drawn when no satellite tile provider (Mapbox/Google) is
// configured. Reprojects the globe's equirectangular Blue Marble texture into
// Web Mercator space per-fragment so it lines up with the same [0, worldSize]
// extent (±85.0511° lat) that satellite tiles occupy once a token is added.

const PI : f32 = 3.14159265359;

struct Uniforms {
  worldSizePad : vec4<f32>,          // (worldSize, 0, 0, 0)
  cameraOffsetViewport : vec4<f32>,  // (cameraX, cameraY, viewportW, viewportH)
};

@group(0) @binding(0) var<uniform> u : Uniforms;
@group(1) @binding(0) var earthTexture : texture_2d<f32>;
@group(1) @binding(1) var earthSampler : sampler;
// One entry per visible world copy (renderWorldCopies) — world-pixel X offset
// for that copy, e.g. [-worldSize, 0, worldSize]. Single instanced draw call,
// looked up per-instance so no per-copy queue.writeBuffer + draw pair is
// needed (a uniform rewritten between draws in the same command buffer would
// race — see MercatorTileRenderer's identical per-instance storage pattern).
@group(2) @binding(0) var<storage, read> copyOffsets : array<f32>;

struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VsOut {
  // Unit-quad corners for the 6 indices (two triangles), covering one
  // [0, worldSize]² Mercator world extent, shifted by this instance's copy offset.
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 1.0),
  );
  let c = corners[vi];
  let worldPos = vec2<f32>(c.x * u.worldSizePad.x + copyOffsets[ii], c.y * u.worldSizePad.x);

  let cameraX = u.cameraOffsetViewport.x;
  let cameraY = u.cameraOffsetViewport.y;
  let vpW = u.cameraOffsetViewport.z;
  let vpH = u.cameraOffsetViewport.w;

  let sx =  (worldPos.x - cameraX) / (vpW * 0.5);
  let sy = -(worldPos.y - cameraY) / (vpH * 0.5);

  var out : VsOut;
  out.pos = vec4<f32>(sx, sy, 0.0, 1.0);
  out.uv = c; // (lngFraction, mercatorYFraction), both in [0, 1]
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  // Invert the standard Web Mercator y (same formula TileManager/MercatorTileRenderer
  // use going forward) back to latitude, then sample the equirectangular Blue Marble
  // texture with GlobeRenderer's own UV convention: u = (lon+180)/360, v = 0.5 - lat/180.
  let latRad = 2.0 * atan(exp(PI * (1.0 - 2.0 * in.uv.y))) - PI * 0.5;
  let texUV = vec2<f32>(in.uv.x, 0.5 - latRad / PI);
  let color = textureSample(earthTexture, earthSampler, texUV);
  return vec4<f32>(color.rgb, 1.0);
}
