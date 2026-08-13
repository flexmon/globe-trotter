/**
 * WebGPUDevice.js — Initialize WebGPU adapter, device, and canvas context.
 *
 * Returns null if WebGPU is not available, letting the caller fall back to WebGL2.
 *
 * Usage:
 *   const gpu = await initWebGPU(canvas);
 *   if (!gpu) { /* fallback to WebGL2 *\/ }
 */

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<{ device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, depthFormat: GPUTextureFormat } | null>}
 */
export async function initWebGPU(canvas) {
  if (!navigator.gpu) {
    console.debug('[WebGPU] navigator.gpu not available');
    return null;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) {
      console.warn('[WebGPU] No GPU adapter found');
      return null;
    }

    // Log adapter info for debugging
    const info = (await adapter.requestAdapterInfo?.()) ?? {};
    console.debug(
      `[WebGPU] Adapter: ${info.vendor || 'unknown'} — ${info.architecture || ''} (${info.description || ''})`
    );

    const device = await adapter.requestDevice({
      requiredFeatures: [],
      requiredLimits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });

    // Handle device loss
    device.lost.then((info) => {
      console.error(`[WebGPU] Device lost: ${info.reason} — ${info.message}`);
    });

    // Configure canvas context
    const context = canvas.getContext('webgpu');
    if (!context) {
      console.warn('[WebGPU] Could not get webgpu canvas context');
      device.destroy();
      return null;
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format,
      alphaMode: 'opaque',
    });

    const depthFormat = 'depth24plus';

    console.debug(
      `[WebGPU] Initialized — format: ${format}, maxBufferSize: ${(device.limits.maxBufferSize / 1024 / 1024).toFixed(0)} MB`
    );

    return { device, context, format, depthFormat };
  } catch (err) {
    console.warn('[WebGPU] Initialization failed:', err.message);
    return null;
  }
}
