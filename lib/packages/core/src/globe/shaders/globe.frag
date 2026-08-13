#version 300 es
precision highp float;

in vec3 v_normal;
in vec3 v_position;
in vec2 v_uv;
in float v_elevation;

uniform sampler2D u_earthTexture;
uniform sampler2D u_elevationMap;
uniform vec3 u_sunDirection;
uniform float u_time;
uniform float u_terrainScale;
uniform float u_darkMode;    // 1.0 = dark sphere (tiles active), 0.0 = blue marble

out vec4 fragColor;

// Compute perturbed normal from heightmap for bump mapping
vec3 computeBumpNormal(vec2 uv, vec3 normal) {
  vec2 texSize = vec2(textureSize(u_elevationMap, 0));
  vec2 texel = 1.0 / texSize;

  // Sample neighboring elevation values
  float hL = texture(u_elevationMap, uv + vec2(-texel.x, 0.0)).r;
  float hR = texture(u_elevationMap, uv + vec2( texel.x, 0.0)).r;
  float hD = texture(u_elevationMap, uv + vec2(0.0, -texel.y)).r;
  float hU = texture(u_elevationMap, uv + vec2(0.0,  texel.y)).r;

  // Compute gradient
  float bumpStrength = 2.5;
  vec3 dU = vec3(1.0, 0.0, (hR - hL) * bumpStrength);
  vec3 dV = vec3(0.0, 1.0, (hU - hD) * bumpStrength);

  // Build TBN-space perturbed normal
  vec3 bumpNormal = normalize(cross(dU, dV));

  // Transform to world space using surface normal as reference
  vec3 N = normalize(normal);
  vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.001)));
  vec3 B = normalize(cross(N, T));
  mat3 TBN = mat3(T, B, N);

  return normalize(TBN * bumpNormal);
}

void main() {
  // Early-out when tiles are active — skip all texture samples and math.
  // Saves ~7 texture samples + 30 math ops per fragment (~1M fragments/frame).
  if (u_darkMode > 0.5) {
      fragColor = vec4(vec3(0.02), 1.0);
      return;
  }

  vec3 sunDir = normalize(u_sunDirection);

  // Sample Blue Marble texture
  vec4 texColor = texture(u_earthTexture, v_uv);

  // Bump-mapped normal from elevation data
  vec3 bumpedNormal = computeBumpNormal(v_uv, v_normal);

  // Use bumped normal for lighting
  vec3 normal = bumpedNormal;

  // Diffuse lighting
  float diffuse = max(dot(normal, sunDir), 0.0);
  float ambient = 0.06;

  // Determine if pixel is ocean or land based on elevation
  float elevation = v_elevation;
  float isOcean = smoothstep(0.0, 0.06, 1.0 - elevation); // Low elevation = ocean
  // Also use color saturation to detect ocean (blue-ish areas)
  float blueRatio = texColor.b / (max(texColor.r + texColor.g + texColor.b, 0.001));
  float colorOceanMask = smoothstep(0.35, 0.45, blueRatio);
  float oceanMask = max(isOcean * 0.5, colorOceanMask);

  // Specular reflection — strong on oceans, weak on land
  vec3 viewDir = normalize(-v_position);
  vec3 halfVec = normalize(sunDir + viewDir);
  float specPower = mix(16.0, 128.0, oceanMask);
  float specIntensity = mix(0.05, 0.8, oceanMask);
  float specular = pow(max(dot(normal, halfVec), 0.0), specPower) * specIntensity;

  // Ocean has slight reflective tint
  vec3 specColor = mix(vec3(1.0), vec3(0.7, 0.85, 1.0), oceanMask);

  // Night side city lights simulation (subtle warm glow on dark side)
  float nightFactor = max(-dot(normal, sunDir), 0.0);
  float nightIntensity = nightFactor * 0.12;
  // City lights are brighter where there's terrain (not ocean)
  vec3 nightColor = vec3(1.0, 0.8, 0.4) * nightIntensity * (1.0 - oceanMask * 0.8);

  // Atmospheric rim
  float rim = 1.0 - max(dot(normalize(v_normal), viewDir), 0.0);
  vec3 rimColor = vec3(0.3, 0.5, 1.0) * pow(rim, 3.5) * 0.35;

  // Terrain color enhancement — boost green on land, deepen blue on ocean
  vec3 enhancedColor = texColor.rgb;
  // Increase saturation slightly
  float lum = dot(enhancedColor, vec3(0.299, 0.587, 0.114));
  enhancedColor = mix(vec3(lum), enhancedColor, 1.2);

  // Snow/ice on high elevation (above ~0.6 in heightmap)
  float snowLine = smoothstep(0.55, 0.70, elevation);
  enhancedColor = mix(enhancedColor, vec3(0.92, 0.94, 0.96), snowLine * 0.6);

  // Final composition
  vec3 finalColor = enhancedColor * (ambient + diffuse)
                  + specular * specColor
                  + nightColor
                  + rimColor;

  // Subtle terminator line (sunrise/sunset glow)
  float terminator = exp(-pow((diffuse - 0.02) * 18.0, 2.0)) * 0.12;
  finalColor += vec3(1.0, 0.35, 0.12) * terminator;

  // Tone mapping to prevent blown-out highlights
  finalColor = finalColor / (finalColor + vec3(1.0));
  // Slight gamma for richness
  finalColor = pow(finalColor, vec3(0.95));

  fragColor = vec4(finalColor, 1.0);
}
