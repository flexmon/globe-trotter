/**
 * RampCompiler.js — Compiles color ramp stops into a 256×1 RGBA GPU texture.
 *
 * The shader samples this texture with: texture(u_colorRamp, vec2(t, 0.5))
 * where t = normalized attribute value. ONE texture sample per fragment —
 * same cost as the old hardcoded approach, but fully configurable at runtime.
 *
 * Changing the ramp = one texSubImage2D call (1 KB), zero shader recompilation.
 */

const RAMP_WIDTH = 256;

/**
 * Parse a CSS hex color string to [r, g, b, a] in 0..1 range.
 * Returns magenta [1,0,1,1] for any invalid input (visible error indicator).
 *
 * @param {string} hex - CSS hex color (e.g. '#ff0000', '#f00', 'ff0000', '#ffffff80')
 * @returns {[number, number, number, number]}
 */
export function parseColor(hex) {
  if (typeof hex !== 'string' || hex.length === 0) return [1, 0, 1, 1];
  hex = hex.replace('#', '');
  if (hex.length === 6) hex += 'ff';
  if (hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const a = parseInt(hex.slice(6, 8), 16) / 255;
    if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) return [1, 0, 1, 1];
    return [r, g, b, a];
  }
  // 3-char shorthand
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16) / 255;
    const g = parseInt(hex[1] + hex[1], 16) / 255;
    const b = parseInt(hex[2] + hex[2], 16) / 255;
    if (isNaN(r) || isNaN(g) || isNaN(b)) return [1, 0, 1, 1];
    return [r, g, b, 1.0];
  }
  return [1, 0, 1, 1]; // magenta fallback (visible error)
}

/**
 * Linearly interpolate between two color arrays.
 */
function lerpColor(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ];
}

/**
 * Compile color ramp stops into a 256×1 RGBA Uint8Array.
 *
 * Supports optional graduated transparency via `opacityStops`:
 *   opacityStops: [{ value: 0, opacity: 0.15 }, { value: 150, opacity: 0.85 }]
 * When provided, the alpha channel is interpolated from these stops,
 * overriding any alpha embedded in the color hex values.
 * When omitted, the alpha comes from the color's own alpha (1.0 for 6-char hex).
 *
 * @param {Array} stops - Array of { value, color } where color is CSS hex
 * @param {Array} domain - [min, max] value range
 * @param {Array} [opacityStops] - Optional array of { value, opacity } for graduated alpha
 * @returns {Uint8Array} 256 × 4 bytes (RGBA)
 */
export function compileRampData(stops, domain, opacityStops) {
  const [domMin, domMax] = domain;
  const range = domMax - domMin || 1; // guard divide-by-zero when domain is degenerate
  const data = new Uint8Array(RAMP_WIDTH * 4);

  // Sort color stops by value
  const sorted = [...stops].sort((a, b) => a.value - b.value);
  const parsedStops = sorted.map((s) => ({
    t: (s.value - domMin) / range,
    color: parseColor(s.color),
  }));

  // Sort opacity stops by value (if provided)
  let parsedOpacity = null;
  if (opacityStops && opacityStops.length >= 2) {
    parsedOpacity = [...opacityStops]
      .sort((a, b) => a.value - b.value)
      .map((s) => ({ t: (s.value - domMin) / range, opacity: s.opacity }));
  }

  for (let i = 0; i < RAMP_WIDTH; i++) {
    const t = i / (RAMP_WIDTH - 1);

    // ─── Interpolate color ───
    let color;
    if (t < parsedStops[0].t) {
      color = [0, 0, 0, 0]; // Transparent below first stop
    } else if (t >= parsedStops[parsedStops.length - 1].t) {
      color = parsedStops[parsedStops.length - 1].color;
    } else {
      for (let s = 0; s < parsedStops.length - 1; s++) {
        if (t >= parsedStops[s].t && t <= parsedStops[s + 1].t) {
          const localT = (t - parsedStops[s].t) / (parsedStops[s + 1].t - parsedStops[s].t);
          color = lerpColor(parsedStops[s].color, parsedStops[s + 1].color, localT);
          break;
        }
      }
    }

    // ─── Interpolate alpha (graduated transparency) ───
    let alpha = color[3]; // Default: from color hex
    if (parsedOpacity) {
      if (t < parsedOpacity[0].t) {
        alpha = 0.0; // Transparent below first stop
      } else if (t >= parsedOpacity[parsedOpacity.length - 1].t) {
        alpha = parsedOpacity[parsedOpacity.length - 1].opacity;
      } else {
        for (let s = 0; s < parsedOpacity.length - 1; s++) {
          if (t >= parsedOpacity[s].t && t <= parsedOpacity[s + 1].t) {
            const localT = (t - parsedOpacity[s].t) / (parsedOpacity[s + 1].t - parsedOpacity[s].t);
            alpha =
              parsedOpacity[s].opacity +
              (parsedOpacity[s + 1].opacity - parsedOpacity[s].opacity) * localT;
            break;
          }
        }
      }
    }

    const idx = i * 4;
    data[idx] = Math.round(color[0] * 255);
    data[idx + 1] = Math.round(color[1] * 255);
    data[idx + 2] = Math.round(color[2] * 255);
    data[idx + 3] = Math.round(alpha * 255);
  }

  return data;
}

/**
 * Upload a compiled ramp to a WebGL texture.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Uint8Array} rampData - From compileRampData()
 * @param {WebGLTexture} [existingTexture] - Reuse existing texture (for updates)
 * @returns {WebGLTexture}
 */
export function uploadRampTexture(gl, rampData, existingTexture) {
  const tex = existingTexture || gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, RAMP_WIDTH, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rampData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Upload a compiled ramp to a WebGPU texture.
 *
 * @param {GPUDevice} device
 * @param {Uint8Array} rampData - From compileRampData()
 * @returns {GPUTexture}
 */
export function uploadRampTextureGPU(device, rampData) {
  const texture = device.createTexture({
    label: 'Color ramp',
    size: [RAMP_WIDTH, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, rampData, { bytesPerRow: RAMP_WIDTH * 4 }, [
    RAMP_WIDTH,
    1,
  ]);
  return texture;
}

export { RAMP_WIDTH };
