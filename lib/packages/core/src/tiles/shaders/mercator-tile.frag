#version 300 es
precision mediump float;

uniform sampler2D u_tileTexture;
uniform float     u_opacity;

in  vec2 v_uv;
out vec4 fragColor;

void main() {
  vec4 color = texture(u_tileTexture, v_uv);
  if (color.a < 0.01) discard;
  fragColor = vec4(color.rgb, color.a * u_opacity);
}
