# Globe Trotter — React Example

A minimal React 18 + Vite app that renders aircraft tracks and demand heatmaps on a 3D globe.

## Quick Start

```bash
cd examples/react
npm install
npm run dev
```

Opens at **http://localhost:5175/globe-trotter/**.

> **First run?** Sample data is generated automatically on startup if `public/data/` is empty.
> This is a one-time step and may take a minute.

## Key Files

| File | Purpose |
|------|---------|
| `src/App.jsx` | Canvas ref, engine init in `useEffect`, layer loading with styling, cleanup on unmount |
| `vite.config.js` | Aliases `@globe-trotter/core` to the pre-built `dist/` bundle, serves data from project root |
| `../ensure-data.js` | Shared pre-start script — generates sample data if missing |

## License

This example is part of **Globe Trotter**, licensed under the [Apache License 2.0](../../LICENSE).
