/**
 * CategoricalCompiler.js — Compiles category→color maps into GPU lookup table textures.
 *
 * Dictionary-indexed data (ENUM16) maps directly to texel index.
 * The shader uses texelFetch(u_catTex, ivec2(categoryIndex, 0), 0) for O(1) lookup.
 */

import { parseColor } from './RampCompiler.js';

/**
 * Compile a categorical color map into a Nx1 RGBA Uint8Array.
 *
 * Supports entries as:
 *   - A hex string:  "#E01933"
 *   - An array of hex strings: ["#BF0D3E", "#FFFFFF", "#002244"] → uses first (primary) color
 *   - An object:     { color: "#E01933", opacity: 0.8 }
 *
 * @param {Object} categories - Maps category name → color spec
 * @param {string[]} dictionary - Dictionary entries from decoded data (defines index order)
 * @param {string} defaultColor - Fallback color for unmapped categories
 * @returns {{ data: Uint8Array, width: number }}
 */
export function compileCategoricalData(categories, dictionary, defaultColor = '#999999') {
  const width = Math.max(
    Array.isArray(dictionary) ? dictionary.length : (dictionary?.length ?? 0),
    1
  );
  const data = new Uint8Array(width * 4);
  const defColor = parseColor(defaultColor);

  for (let i = 0; i < width; i++) {
    const name = dictionary.getString ? dictionary.getString(i) : dictionary[i];
    const entry = categories[name];

    let color;
    if (entry) {
      if (typeof entry === 'string') {
        color = parseColor(entry);
      } else if (Array.isArray(entry)) {
        // Multi-color branding array: use the first (primary) color
        color = parseColor(entry[0]);
      } else {
        color = parseColor(entry.color || defaultColor);
        if (entry.opacity !== undefined) {
          color[3] = entry.opacity;
        }
      }
    } else {
      color = [...defColor]; // copy to prevent defColor mutation across iterations
    }

    const idx = i * 4;
    data[idx] = Math.round(color[0] * 255);
    data[idx + 1] = Math.round(color[1] * 255);
    data[idx + 2] = Math.round(color[2] * 255);
    data[idx + 3] = Math.round(color[3] * 255);
  }

  return { data, width };
}

/**
 * Upload a compiled categorical LUT to a WebGL texture.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Uint8Array} lutData
 * @param {number} width
 * @param {WebGLTexture} [existingTexture]
 * @returns {WebGLTexture}
 */
export function uploadCategoricalTexture(gl, lutData, width, existingTexture) {
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const clampedWidth = Math.min(width, maxSize);
  const tex = existingTexture || gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    clampedWidth,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    lutData.subarray ? lutData.subarray(0, clampedWidth * 4) : lutData
  );
  // NEAREST filtering — exact texel lookup, no interpolation
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Upload a compiled categorical LUT to a WebGPU texture.
 *
 * @param {GPUDevice} device
 * @param {Uint8Array} lutData
 * @param {number} width
 * @returns {GPUTexture}
 */
export function uploadCategoricalTextureGPU(device, lutData, width) {
  const maxSize = device.limits?.maxTextureDimension2D || 8192;
  const clampedWidth = Math.min(Math.max(width, 1), maxSize);
  const texture = device.createTexture({
    label: 'Categorical LUT',
    size: [clampedWidth, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    lutData.subarray ? lutData.subarray(0, clampedWidth * 4) : lutData,
    { bytesPerRow: clampedWidth * 4 },
    [clampedWidth, 1]
  );
  return texture;
}
