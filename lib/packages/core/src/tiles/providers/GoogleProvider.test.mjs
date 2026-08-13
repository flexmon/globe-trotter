import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { GoogleProvider } from './GoogleProvider.js';

describe('GoogleProvider dark styles', () => {
  it('includes Google dark basemap variants', () => {
    assert.ok(GoogleProvider.STYLES['google-roadmap-dark']);
    assert.ok(GoogleProvider.STYLES['google-satellite-dark']);
    assert.ok(GoogleProvider.STYLES['google-terrain-dark']);
  });

  it('sends dark styles in the createSession payload', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody;

    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          session: 'session-token',
          expiry: String(Math.floor(Date.now() / 1000) + 3600 * 24),
          copyright: 'Map data ©2026 Google',
          tileWidth: 512,
          tileHeight: 512,
          imageFormat: 'png',
        }),
      };
    };

    try {
      const provider = new GoogleProvider('test-api-key');
      await provider.ensureReady('google-roadmap-dark');
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(requestBody.mapType, 'roadmap');
    assert.deepEqual(requestBody.layerTypes, undefined);
    assert.ok(Array.isArray(requestBody.styles));
    assert.ok(requestBody.styles.length > 0);
    assert.equal(requestBody.variant, undefined);
  });
});
