#version 300 es
precision highp float;

in vec2 v_uv;
in vec3 v_position;
in vec3 v_normal;

uniform sampler2D u_tileTexture;
uniform vec3 u_sunDirection;

out vec4 fragColor;

void main() {
  vec4 texColor = texture(u_tileTexture, v_uv);

  // Discard transparent pixels from Styles API PNG tiles (ocean, sky, etc.)
  // so the underlying globe (Blue Marble) shows through.
  if (texColor.a < 0.01) discard;

  vec3 normal = normalize(v_normal);
  vec3 sunDir = normalize(u_sunDirection);

  // Diffuse lighting
  float diffuse = max(dot(normal, sunDir), 0.0);
  float ambient = 0.12;

  // Night side subtle glow
  float nightFactor = max(-dot(normal, sunDir), 0.0);
  vec3 nightColor = vec3(0.02, 0.02, 0.04) * nightFactor;

  // Atmospheric rim
  vec3 viewDir = normalize(-v_position);
  float rim = 1.0 - max(dot(normal, viewDir), 0.0);
  vec3 rimColor = vec3(0.2, 0.4, 0.8) * pow(rim, 4.0) * 0.2;

  vec3 finalColor = texColor.rgb * (ambient + diffuse * 0.9) + nightColor + rimColor;

  fragColor = vec4(finalColor, 1.0);
}
