# Globe Trotter — Vue 3 Example

A minimal Vue 3 + Vite app that renders aircraft tracks and demand heatmaps on a 3D globe.

## Quick Start

```bash
cd examples/vue
npm install
npm run dev
```

Opens at **http://localhost:5174/globe-trotter/**.

> **First run?** Sample data is generated automatically on startup if `public/data/` is empty.
> This is a one-time step and may take a minute.

## Key Files

| File | Purpose |
|------|---------|
| `src/App.vue` | Canvas, engine init, layer loading with styling, cleanup |
| `vite.config.js` | Aliases `@globe-trotter/core` to the pre-built `dist/` bundle, serves data from project root |
| `../ensure-data.js` | Shared pre-start script — generates sample data if missing |

## License

This example is part of **Globe Trotter**, licensed under the [Apache License 2.0](../../LICENSE).
