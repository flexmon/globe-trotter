import { defineConfig } from 'vite';
import { resolve } from 'path';

// Library build for the published @globe-trotter/react package. `react` and
// `@globe-trotter/core` are peer dependencies of the consuming app, so they
// (and the JSX runtime react resolves to) are externalized rather than bundled.
const isExternal = (id) =>
  id === '@globe-trotter/core' || id === 'react' || id.startsWith('react/');

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.jsx'),
      fileName: (format) => `globe-trotter-react.${format === 'es' ? 'es' : 'cjs'}.js`,
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
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
});
