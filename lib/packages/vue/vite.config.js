import { defineConfig } from 'vite';
import { resolve } from 'path';

// Library build for the published @globe-trotter/vue package. `vue` and
// `@globe-trotter/core` are peer dependencies of the consuming app, so they
// are externalized rather than bundled.
const isExternal = (id) => id === '@globe-trotter/core' || id === 'vue';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      fileName: (format) => `globe-trotter-vue.${format === 'es' ? 'es' : 'cjs'}.js`,
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: isExternal,
      // The entry has both `export const GlobeTrotter` and `export default GlobeTrotter`;
      // named output silences rollup's default/named export mismatch warning for the CJS build.
      output: {
        exports: 'named',
      },
    },
    sourcemap: true,
    minify: true,
  },
});
