import { defineConfig } from 'vite';
import { resolve } from 'path';

// Two-pass library build. The primary pass emits globe-trotter.* (the stable
// `@globe-trotter/core` entry); GT_ENTRY=advanced emits globe-trotter-advanced.*
// (`@globe-trotter/core/advanced`). Two single-entry passes (rather than a
// multi-entry build) let each bundle keep `inlineDynamicImports` and stay a
// single self-contained file — which downstream consumers (e.g. flexops's
// vite alias) rely on.
const isAdvanced = process.env.GT_ENTRY === 'advanced';
const entryFile = isAdvanced ? 'src/advanced.js' : 'src/index.js';
const baseName = isAdvanced ? 'globe-trotter-advanced' : 'globe-trotter';
const umdName = isAdvanced ? 'GlobeTrotterAdvanced' : 'GlobeTrotter';

export default defineConfig({
  build: {
    // Only the primary pass clears the output dir; the advanced pass writes
    // alongside it.
    emptyOutDir: !isAdvanced,
    lib: {
      entry: resolve(__dirname, entryFile),
      name: umdName,
      fileName: (format) => `${baseName}.${format}.js`,
      formats: ['es', 'umd'],
    },
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
    sourcemap: true,
    minify: true,
  },
  assetsInclude: ['**/*.vert', '**/*.frag'],
});
