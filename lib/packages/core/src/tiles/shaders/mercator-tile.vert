#version 300 es
precision highp float;

// ─── Mercator tile vertex shader (WebGL2) ────────────────────────────────────
// Renders a raster map tile as a flat quad in Web Mercator world-pixel space.
// Each tile is one quad; the unit-quad VAO is reused across all tiles, with
// the tile's world origin/size passed as uniforms.

uniform float u_worldSize;    // 256 * 2^zoom — full world diameter in pixels
uniform vec2  u_cameraOffset; // camera center in world pixels (centerX, centerY)
uniform vec2  u_viewportSize; // canvas physical size in pixels

uniform vec2  u_tileOrigin;   // tile top-left in world pixels
uniform float u_tileSize;     // tile size in world pixels (worldSize / 2^z)

in vec2 a_quadPos; // [0,1]×[0,1] unit-quad position
in vec2 a_uv;      // texture UV [0,1]×[0,1]

out vec2 v_uv;

void main() {
  vec2 worldPos = u_tileOrigin + a_quadPos * u_tileSize;

  // Screen NDC: world → camera-relative → viewport-normalized, flip Y.
  float sx =  (worldPos.x - u_cameraOffset.x) / (u_viewportSize.x * 0.5);
  float sy = -(worldPos.y - u_cameraOffset.y) / (u_viewportSize.y * 0.5);

  gl_Position = vec4(sx, sy, 0.0, 1.0);
  v_uv = a_uv;
}
