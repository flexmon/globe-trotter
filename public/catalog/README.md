# Globe Trotter Catalog

This directory contains YAML configuration files that define globe visualizations.
Each file is loadable via `?globeconf=/catalog/<filename>.yaml` in development or
via the CDN path in production.

---

## Projection Toggle

Globe Trotter supports two projections that the user (or the catalog config) can
select at any time:

- **Spherical** (`3d`) — the default interactive 3-D globe.
- **Mercator** (`2d`) — a flat Web Mercator view (no tilt, pan/zoom like a 2-D map).

### How to Switch

| Method | Action |
|--------|--------|
| UI button | Click the **2D / 3D** toggle in the top-right toolbar. |
| Keyboard | Press **`m`** (or `M`) while focus is not in a text input. |
| Programmatic | Call `engine.setProjectionMode('mercator' \| 'spherical', { animate: true })` on the `GlobeTrotterEngine` instance. Returns `true` if the mode changed, `false` if already in that mode or a tween is in progress. |

When switching from a tilted 3-D view to Mercator, the engine animates the tilt to
zero before completing the swap (the `animate` option, which defaults to `true`,
controls this tween).

---

## YAML Schema: `view` field

The top-level `view` key sets the **initial** projection for a catalog entry.
It is optional; the engine defaults to `'3d'` (spherical) when omitted.

```yaml
# Optional. '3d' = spherical globe (default), '2d' = flat Mercator.
view: '3d'   # or '2d'
```

The field is an alias for the internal `projectionMode` engine option
(`'spherical'` / `'mercator'`). It is parsed in `GlobeTrotterEngine` constructor
(see `lib/packages/core/src/GlobeTrotterEngine.js` lines 94-97).

### Example — force Mercator on load

```yaml
view: '2d'

basemap:
  provider: google
  style: google-satellite

camera:
  center: [39.0, -98.0]
  altitude: 12000
  tilt: 0
  heading: 0

layers:
  - name: IPFix Spatial Density
    type: h3f-virtual
    # ... rest of layer config
```

### Example — explicit 3-D (default, no change in behavior)

```yaml
view: '3d'

basemap:
  provider: mapbox
  style: dark-v11
# ...
```

> **Note**: `view` sets the *initial* mode only. The user can always toggle
> projection at runtime via the UI button or the `m` key.

---

## Layer-Type Mercator Support Matrix

Support status as of 2026-06-04. Backend refers to the renderer selected at
runtime (WebGPU when available, otherwise WebGL2).

| Layer type | WebGPU 3D | WebGPU Mercator | WebGL2 3D | WebGL2 Mercator |
|------------|:---------:|:---------------:|:---------:|:---------------:|
| Tiles      | yes       | yes             | yes       | yes             |
| H3F        | yes       | yes             | yes       | no (task #15)   |
| DGF        | yes       | yes             | yes       | no (task #17)   |
| GFB-point  | yes       | yes             | yes       | no (task #17)   |
| GFB-line   | yes       | no (task #16)   | yes       | no (task #17)   |
| GFB-poly   | yes       | no (task #16)   | yes       | no (task #17)   |
| MFB        | yes       | no (task #18)   | yes       | no (task #18)   |

Layers not supported in the active projection are silently skipped by
`LayerManager` (one-time console warning per layer).

---

## Known Limitations (2026-06-04)

- **Antimeridian spanning**: H3F and DGF hexes that cross the antimeridian
  (±180° longitude) may render as stretched triangles in Mercator.
  Tracked: task #13.

- **No tilt in Mercator**: The Mercator camera controller locks tilt to zero.
  Tilt support (2.5-D Mercator) is tracked in task #12.

- **WebGL2 backend**: No data layers render in Mercator on devices that fall
  back to WebGL2 (only the basemap tile layer is drawn).
  Tracked: tasks #15, #17.

- **MFB layers**: Invisible in Mercator on both backends.
  Tracked: task #18.

---

## Catalog File Listing

| File | Description | Projection |
|------|-------------|------------|
| `demo-catalog.yaml` | Primary 4D synthetic simulation catalog (GFB + H3F + MFB) | 3D (default) |
