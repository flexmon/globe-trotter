import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

// Root Vitest configuration — replaces jest.config.cjs (root Jest suite)
// and the per-package `node --test` runners in lib/packages/{core,data-sdk}.
export default defineConfig({
  resolve: {
    alias: [
      // tests/*.test.js import '../src/...' but mean the real engine source,
      // which lives in lib/packages/core/src — mirrors jest.config.cjs's
      // moduleNameMapper. Root src/ is just the app shell (app.js, styles.css).
      {
        find: /^\.\.\/src\/(.*)$/,
        replacement: resolve(import.meta.dirname, 'lib/packages/core/src/$1'),
      },
      {
        find: /^@globe-trotter\/data-sdk\/(.*)$/,
        replacement: resolve(import.meta.dirname, 'lib/packages/data-sdk/$1'),
      },
      {
        find: '@globe-trotter/data-sdk',
        replacement: resolve(import.meta.dirname, 'lib/packages/data-sdk/src/index.js'),
      },
      // Shader `?raw` imports resolve to a mock string in tests (mirrors
      // jest.config.cjs; production uses the real vite-plugin-glsl instead).
      {
        find: /^.*\.(vert|frag|glsl|wgsl)\?raw$/,
        replacement: resolve(import.meta.dirname, 'tests/mocks/rawMock.js'),
      },
    ],
  },
  test: {
    include: [
      'tests/**/*.test.js',
      'lib/packages/core/src/**/*.test.mjs',
      'lib/packages/data-sdk/src/**/*.test.js',
    ],
    environment: 'node',
    globals: true,
  },
});
