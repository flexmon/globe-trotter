# Contributing to Globe Trotter

Thank you for your interest in contributing. This document covers how to get set up, the PR process, and a few guidelines.

---

## Prerequisites

- **Node.js 20+** — check with `node --version`
- A **Mapbox** or **Google Maps** API key for satellite basemap tiles (optional — the globe renders without one)

---

## Getting Started

```bash
git clone https://github.com/flexmon/globe-trotter.git
cd globe-trotter
npm run setup
```

`npm run setup` installs dependencies, optionally prompts for a basemap API key, generates sample data, and starts the dev server at [localhost:5173](http://localhost:5173).

Copy `.env.example` to `.env` and fill in any keys you need:

```bash
cp .env.example .env
```

---

## Making Changes

1. Fork the repo and create a branch from `main`:
   ```bash
   git checkout -b feature/my-change
   ```
2. Make your changes. For GPU engine changes, test in a WebGPU-capable browser (Chrome 113+, Edge 113+, Safari 18+).
3. Run the type checker and any tests:
   ```bash
   npm run build:lib
   ```
4. Open a pull request against `main`. Include a short description of what changed and why.

---

## Code Style

- The codebase is vanilla JavaScript (no TypeScript in the engine). Follow the patterns in adjacent files.
- WGSL shaders live alongside their renderers in `lib/packages/core/src/`.
- Comments are minimal — names should be self-describing. Add a comment only when the _why_ is non-obvious.

---

## Reporting Issues

Please open a [GitHub Issue](https://github.com/flexmon/globe-trotter/issues) with:

- Browser and OS version
- Steps to reproduce
- What you expected vs. what happened

For security issues, please do not open a public issue — email the maintainers directly.

---

## License

By contributing you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
