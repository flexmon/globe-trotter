# Cartographic Projection Architecture — 2D Map Rendering

> **Updated 2026-06: globe-trotter is WebGPU-only (WebGL2 removed). globe-trotter-2d remains WebGPU + WebGL2.**

> The Globe Trotter ecosystem uses **two complementary projects** for geospatial visualization: `globe-trotter` renders geospatial data on a 3D sphere; `globe-trotter-2d` renders the same data on a flat 2D Web Mercator map. Both projects share data formats, decoders, loaders, and the style engine. Only projection, camera, and rendering differ.

> **Note on projection toggle**: Globe-trotter now supports polymorphic projection dispatch via `SphericalProjection` and `WebMercatorProjection` classes. Renderers call `render(projection, ctx)` where `projection.mode` determines spherical vs Mercator path. This unified dispatch pattern replaces the old dual-renderer pairs and enables future runtime projection switching.

## Table of Contents

1. [Motivation and Approach](#1-motivation-and-approach)
2. [Design Constraints](#2-design-constraints)
3. [Architecture Overview](#3-architecture-overview)
4. [Projection Systems Compared](#4-projection-systems-compared)
5. [3D Projection — Spherical WGS84 (globe-trotter)](#5-3d-projection--spherical-wgs84-globe-trotter)
6. [2D Projection — Web Mercator (globe-trotter-2d)](#6-2d-projection--web-mercator-globe-trotter-2d)
7. [GPU Projection — Shader Implementation](#7-gpu-projection--shader-implementation)
8. [H3Flex Mesh Handling in 2D](#8-h3flex-mesh-handling-in-2d)
9. [Camera Systems](#9-camera-systems)
10. [Tile System](#10-tile-system)
11. [Code-Sharing Strategy](#11-code-sharing-strategy)
12. [Performance Characteristics](#12-performance-characteristics)
13. [Float32 Precision Analysis](#13-float32-precision-analysis)
14. [File Inventory](#14-file-inventory)

---

## 1. Motivation and Approach

Globe Trotter originally rendered all geospatial data exclusively on a 3D globe (unit sphere). Many operational use cases benefit from a flat cartographic view:

- **Regional analysis** — a 2D map eliminates curvature distortion that makes it difficult to compare adjacent regions at medium zoom levels.
- **Presentation and export** — flat map views are the standard for reports, dashboards, and screenshot/video exports.
- **Cartographic convention** — most GIS tools default to a flat projection; users expect this capability.

### The Decision: Separate Project

Rather than adding a runtime projection toggle inside the existing 3D `GlobeTrotterEngine` (which would require reverse-projecting pre-baked 3D XYZ mesh data in shaders, dual camera modes, and branching throughout every renderer), the 2D map capability was implemented as a **separate sibling project**: `globe-trotter-2d`.

**Why a separate project?**

| Concern             | Runtime Toggle (rejected)                                                | Separate Project (chosen)                                   |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Projection approach | Shader reverse-projection (XYZ → lat/lon → Mercator, ~7 trig ops/vertex) | Forward projection (lat/lon → Mercator, ~2 trig ops/vertex) |
| Camera              | Dual-mode CameraController                                               | Clean PanZoomCamera with no globe baggage                   |
| Tile system         | Dual algorithm (horizon spiral vs. viewport rect)                        | Simple viewport-rect only                                   |
| Shader complexity   | All shaders branch on `projection_mode` uniform                          | Shaders are simpler, projection-specific                    |
| Data sharing        | Same process, branched code                                              | Shared packages via Vite alias to `@globe-trotter/core`     |
| Bundle size         | Single large bundle                                                      | Users load only what they need                              |

The separate-project approach yields simpler, faster, more maintainable code at the cost of some duplication. The duplication is minimized through shared packages.

---

## 2. Design Constraints

Both projects honor these constraints:

| Constraint                 | Rationale                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Zero data re-encoding**  | H3F, GFB, MFB, and DGFlex datasets work unmodified in both projects. Projection is purely a rendering concern.                      |
| **WebGPU + WebGL2 parity** | Both backends produce identical pixel output in both projects.                                                                      |
| **Shared data formats**    | The same `.h3f`, `.gfb`, `.mfb`, and `.dgf` shard files are consumed by both projects.                                              |
| **Shared style system**    | `StyleEngine`, color ramps, categorical LUTs, and filter predicates are identical in both projects.                                 |
| **Shader-side projection** | Neither project pre-projects coordinates on the CPU per frame. Camera uniforms change every frame; data stays on the GPU unchanged. |

---

## 3. Architecture Overview

```
┌───────────────────────────────┐     ┌───────────────────────────────────┐
│       globe-trotter           │     │         globe-trotter-2d          │
│  (3D sphere rendering)        │     │  (2D flat map rendering)          │
│                               │     │                                   │
│  GlobeTrotterEngine           │     │  MapEngine                        │
│  ├── CameraController /       │     │  ├── PanZoomCamera                │
│  │   MercatorCameraController │     │  │     center: [lng, lat]         │
│  │     supports both modes    │     │  │     zoom: 0–22                 │
│  ├── TileManager              │     │  ├── TileManager                  │
│  │     horizon spiral /       │     │  │     viewport rectangle         │
│  │     viewport rect (mode)   │     │  │                                │
│  ├── LayerManager             │     │  ├── LayerManager                 │
│  │   ├── H3FlexRenderer       │     │  │   ├── H3FlexRenderer           │
│  │   ├── GFBRenderer          │     │  │   ├── GeoFlexRenderer          │
│  │   └── DGFlexRenderer       │     │  │   └── DGFlexRenderer           │
│  └── GlobeRenderer            │     │  └── (no globe renderer)          │
│      (spherical mode only)    │     │                                   │
│                               │     │                                   │
│  Projection: Polymorphic      │     │  Projection: Web Mercator         │
│  (Spherical or Mercator)      │     │                                   │
│  Shaders: WGSL (WebGPU)       │     │  Shaders: WGSL + GLSL             │
└──────────────┬────────────────┘     └──────────────┬────────────────────┘
               │                                      │
               └──────────────┬───────────────────────┘
                              │  Shared via Vite alias:
                              │  @globe-trotter/core →
                              │    globe-trotter/lib/packages/core/src/
                              │
                    ┌─────────▼─────────────┐
                    │  Shared Components    │
                    │  StyleEngine          │
                    │  GFBShards            │
                    │  DGFlexShards         │
                    │  StreamingGFBLoader   │
                    │  decodeMFB            │
                    │  parseQuery           │
                    │  flattenForGPU        │
                    │  @globe-trotter/shared│
                    │    lngLatToPixel      │
                    │    pixelToLngLat      │
                    │    bboxUnion          │
                    │    bboxIntersects     │
                    └───────────────────────┘
```

---

## 4. Projection Systems Compared

| Aspect                  | globe-trotter (3D)                                                                                | globe-trotter-2d (2D)                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Projection**          | Spherical WGS84 (unit sphere approximation) OR Web Mercator (via projection mode)                 | Web Mercator EPSG:3857                                                |
| **Data stored as**      | Pre-baked 3D XYZ (unit sphere) for H3/DGFlex; lat/lon for GFB                                     | Lat/lon for GFB; XYZ converted to Mercator at load time for H3/DGFlex |
| **Shader projection**   | Identity passthrough (XYZ already on sphere) in spherical mode; forward Mercator in Mercator mode | Forward Mercator: `[lng, lat]` → `[x, y]` (~2 trig ops/vertex)        |
| **Camera type**         | Orbital (θ, φ, distance) with perspective                                                         | Pan/zoom (center, zoom) with orthographic screen math                 |
| **Camera matrices**     | Full `view` + `projection` matrix stack                                                           | No matrices — screen offset + NDC conversion via uniforms             |
| **Latitude limits**     | ±90° (full sphere)                                                                                | ±85.051129° (Web Mercator singularity)                                |
| **Tile visibility**     | Horizon spiral from orbital position                                                              | Viewport bounding-box rectangle intersection                          |
| **Tile projection**     | Inverse Mercator → XYZ then sphere transform                                                      | Direct world-pixel positioning (tile Mercator bounds)                 |
| **Extrusion direction** | Radial (along surface normal)                                                                     | Vertical (Y-axis)                                                     |

---

## 5. 3D Projection — Spherical WGS84 (globe-trotter)

Globe Trotter uses a **spherical approximation of WGS84** for GPU efficiency — a unit sphere instead of the WGS84 ellipsoid. The encoding function (from `geodetic-coordinate-system.md`) is:

```javascript
// latLonAltToXYZ — used by H3FlexEncoder and DGFlexEncoder at encode time
function latLonAltToXYZ(lat, lon, altFeet) {
  const theta = (90 - lat) * DEG2RAD; // colatitude
  const phi = (lon + 180) * DEG2RAD;
  const r = 1.0 + altFeet / 20_925_525; // earth radius in feet
  const st = Math.sin(theta);
  return [st * Math.sin(phi), Math.cos(theta), st * Math.cos(phi)].map((v) => v * r);
}
```

**Accuracy tradeoff:** The spherical approximation discards WGS84's 0.3% ellipsoidal flattening. Maximum positional error is ~21 km at 45° latitude, which equates to ~3.3 pixels at a 1000 px viewport — acceptable for all operational use cases (satellite coverage, flight tracking, network planning).

H3Flex and DGFlex meshes store these pre-baked XYZ coordinates in `.h3f` and `.dgf` shard files. At render time the vertex shader applies the view and projection matrices directly — no per-frame projection computation is needed:

```wgsl
// h3hex.wgsl (globe-trotter, WebGPU) — simplified
let normal     = normalize(in.position);
let extrusion  = in.extrude_flag * extrude_val * u.extrusion_scale + Z_FIGHT_OFFSET;
let offset_pos = in.position + normal * extrusion;
out.clip_position = u.projection * u.view * vec4f(offset_pos, 1.0);
```

GFB layers store raw lat/lon in RGBA32F data textures and project to 3D in the vertex shader via `lat_lon_alt_to_xyz()`.

---

## 6. 2D Projection — Web Mercator (globe-trotter-2d)

Globe Trotter 2D implements **EPSG:3857 Web Mercator** on both CPU and GPU.

### CPU Side: `WebMercatorProjection`

**File:** `packages/map/src/projection/WebMercatorProjection.js`

The CPU class handles tile coordinate math and screen-to-geo coordinate conversion. The key formulas:

```javascript
// Forward: [lng, lat] → world pixel [x, y] at the current zoom level
project(lng, lat) {
    const scale = WORLD_SIZE * Math.pow(2, this.zoom); // WORLD_SIZE = 256
    const x = ((lng + 180) / 360) * scale;
    const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)); // MAX_LAT = 85.051129°
    const sinLat = Math.sin((clampedLat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    return { x, y };
}

// Inverse: world pixel [x, y] → [lng, lat]
unproject(x, y) {
    const scale = WORLD_SIZE * Math.pow(2, this.zoom);
    const lng = (x / scale) * 360 - 180;
    const n   = Math.PI - (2 * Math.PI * y) / scale;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lng, lat };
}
```

**World-pixel coordinate system:**

- Origin: top-left of the world at zoom 0 (a 256×256 pixel square)
- X increases eastward; Y increases southward (matches browser canvas convention)
- At zoom level `z`, the world is `256 × 2^z` pixels wide and tall
- The camera's `cameraOffset` is the world-pixel coordinate of the viewport center

### Shared Utilities: `@globe-trotter/shared`

**File:** `packages/shared/src/geo/index.js`

Lightweight projection helpers used outside the rendering hot path:

```javascript
// lngLatToPixel — used for UI coordinate math, tile bounds, bounding box tests
export function lngLatToPixel(lng, lat, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

// pixelToLngLat — inverse for mouse coordinate unprojection
export function pixelToLngLat(x, y, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lng, lat };
}
```

---

## 7. GPU Projection — Shader Implementation

### Key Insight: Forward Shader-Side Projection

In globe-trotter-2d, GFB layers store raw `[lng, lat]` in GPU data textures and the tile system stores tile bounds in world-pixel coordinates. The vertex shader applies the **forward Mercator formula** each frame — approximately **2 transcendental operations per vertex** (`sin` + `log`).

This is significantly cheaper than the reverse-projection approach that would be needed inside the 3D engine (where XYZ meshes would need `acos` + `atan2` to recover lat/lon before projecting to Mercator — ~7 trig operations per vertex).

Camera changes (pan, zoom) require no data re-encoding. Only the three camera uniforms update per frame:

| Uniform          | Type    | Description                                               |
| ---------------- | ------- | --------------------------------------------------------- |
| `u_worldSize`    | `float` | `256 × 2^zoom` — world diameter in pixels at current zoom |
| `u_cameraOffset` | `vec2`  | Camera center in world pixels `(x, y)`                    |
| `u_viewportSize` | `vec2`  | Canvas physical size in pixels `(width, height)`          |

### GLSL (WebGL2) — `webmercator.glsl`

**File:** `packages/map/src/shaders/webmercator.glsl`

```glsl
#version 300 es
precision highp float;

uniform float u_worldSize;    // 256 * 2^zoom
uniform vec2  u_cameraOffset; // camera center in world pixels
uniform vec2  u_viewportSize; // canvas physical size

const float PI = 3.14159265358979323846;

vec2 mercatorProject(vec2 lngLat) {
    float x = (lngLat.x + 180.0) / 360.0 * u_worldSize;
    float sinLat = sin(lngLat.y * PI / 180.0);
    float y = (0.5 - log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * PI)) * u_worldSize;

    // Translate to screen space and convert to NDC [-1, 1]
    // Y is flipped: world Y increases downward, NDC Y increases upward
    vec2 screen = vec2(x, y) - u_cameraOffset;
    return vec2(
        (screen.x / u_viewportSize.x) * 2.0 - 1.0,
        1.0 - (screen.y / u_viewportSize.y) * 2.0
    );
}
```

### WGSL (WebGPU) — `webmercator.wgsl`

**File:** `packages/map/src/shaders/webmercator.wgsl`

```wgsl
struct Uniforms {
    worldSize:      f32,  // 256 * 2^zoom
    cameraOffsetX:  f32,  // camera center X in world pixels
    cameraOffsetY:  f32,  // camera center Y in world pixels
    viewportWidth:  f32,  // canvas physical width
    viewportHeight: f32,  // canvas physical height
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

const PI: f32 = 3.14159265358979;

fn mercatorProject(lngLat: vec2<f32>) -> vec2<f32> {
    let x = (lngLat.x + 180.0) / 360.0 * uniforms.worldSize;
    let sinLat = sin(lngLat.y * PI / 180.0);
    let y = (0.5 - log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * PI)) * uniforms.worldSize;

    let screen = vec2<f32>(x - uniforms.cameraOffsetX, y - uniforms.cameraOffsetY);
    return vec2<f32>(
        screen.x / uniforms.viewportWidth  *  2.0 - 1.0,
        1.0 - screen.y / uniforms.viewportHeight * 2.0
    );
}
```

### No View/Projection Matrices

Unlike globe-trotter's 3D rendering, globe-trotter-2d uses **no view or projection matrices**. The camera transform is entirely expressed via the three uniforms above. This eliminates matrix allocation, upload, and shader multiplication overhead per frame — a meaningful saving when the render loop runs at 60 FPS.

---

## 8. H3Flex Mesh Handling in 2D

### The Challenge

H3Flex and DGFlex mesh files (`.h3f`, `.dgf`) store vertex positions as **pre-baked 3D XYZ coordinates on a unit sphere** — the original lat/lon values are discarded at encode time. The globe-trotter-2d project must convert these to 2D Mercator world-pixel coordinates before they can be rendered on a flat map.

### The Solution: CPU Conversion at Mesh Load Time

Rather than performing the conversion in the vertex shader every frame (which would require ~7 trig operations per vertex), globe-trotter-2d converts XYZ → Mercator **once on the CPU when the mesh is first loaded**, producing a 2D `(x, y)` position array stored in world-pixel space at zoom 0.

**File:** `packages/map/src/layers/H3FlexRenderer.js`

```javascript
// xyzToMercator — converts unit-sphere XYZ to Mercator world pixels at zoom 0.
// Globe XYZ convention (matches globe-trotter's latLonAltToXYZ):
//   x = sin(theta) * sin(phi)
//   y = cos(theta)              ← Y is up (north pole)
//   z = sin(theta) * cos(phi)
export function xyzToMercator(xyzPositions, indices, cellIndices) {
  const BAKE_WORLD = 256; // zoom 0 world size in pixels
  const count = xyzPositions.length / 3;
  const PI = Math.PI;
  const pos = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    const gx = xyzPositions[i * 3];
    const gy = xyzPositions[i * 3 + 1];
    const gz = xyzPositions[i * 3 + 2];

    // Inverse of latLonAltToXYZ — recover lat/lon from unit-sphere XYZ
    const lat = 90 - Math.acos(Math.max(-1, Math.min(1, gy))) * (180 / PI);
    const lonRaw = Math.atan2(gx, gz) * (180 / PI) - 180;
    const lon = lonRaw < -180 ? lonRaw + 360 : lonRaw; // normalise to [-180, 180]

    // Forward Mercator at zoom 0
    pos[i * 2] = ((lon + 180) / 360) * BAKE_WORLD;
    const sinLat = Math.sin((lat * PI) / 180);
    pos[i * 2 + 1] = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * PI)) * BAKE_WORLD;
  }
  // ... antimeridian splitting (see below)
}
```

### Baking at Zoom 0

Positions are baked at zoom 0 (world size = 256 px). The vertex shader scales them to the current zoom by multiplying by `u_worldSize / 256.0`. This means:

- The GPU buffer never needs to be updated as the user zooms
- Only the `u_worldSize` uniform changes on zoom

```glsl
// h3hex.vert (globe-trotter-2d, WebGL2)
// a_position is Mercator world pixels baked at zoom 0

float scale = u_worldSize / 256.0;      // scale factor for current zoom
float wx    = a_position.x * scale;
float wy    = a_position.y * scale;

// Translate to screen-space, flip Y for NDC
float sx = (wx - u_cameraOffset.x) / (u_viewportSize.x * 0.5);
float sy = -(wy - u_cameraOffset.y) / (u_viewportSize.y * 0.5);
gl_Position = vec4(sx, sy, 0.0, 1.0);
```

### Antimeridian Splitting

Hexagonal cells that straddle the antimeridian (±180° longitude) span the full width of the Mercator map when rendered naively. Globe-trotter-2d detects and corrects this during the CPU conversion:

Any triangle whose vertices span more than half the world width (> 128 px at zoom 0) is considered an antimeridian crosser. The minority vertices (those on the "wrong" side of the seam) are **duplicated** and shifted by ±256 px so the triangle no longer stretches across the map. Duplicated vertices carry the same `cellIndices` value so the data-texture epoch lookup is unaffected.

---

## 9. Camera Systems

### globe-trotter: `CameraController` (Orbital)

**File:** `lib/packages/core/src/camera/CameraController.js`

State:

```
theta     — longitude angle (radians)
phi       — latitude angle (radians)
distance  — distance from sphere origin
tilt      — pitch angle (for 2.5D views)
heading   — orbit rotation
```

Produces a perspective view + projection matrix pair passed to all renderers via `render(view, proj)`. Scroll zooms by adjusting `distance`; drag rotates `theta`/`phi`.

### globe-trotter-2d: `PanZoomCamera` (Orthographic)

**File:** `packages/map/src/camera/PanZoomCamera.js`

State:

```
center  — [longitude, latitude] of viewport center
zoom    — zoom level 0–22 (fractional)
```

There are **no matrices**. The camera produces three scalar/vector uniforms (`worldSize`, `cameraOffset`, `viewportSize`) from which every shader computes its own NDC positions.

**Pan implementation:** converts pixel delta to world-pixel delta, then unprojects the new center:

```javascript
pan(dx, dy) {
    const scale = 256 * Math.pow(2, this.zoom);
    const dLng = (dx / scale) * 360;
    const [currentLng, currentLat] = this.center;
    const sinLat = Math.sin((currentLat * Math.PI) / 180);
    const mercatorY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    const newMercatorY = mercatorY - dy;
    const n = Math.PI - (2 * Math.PI * newMercatorY) / scale;
    const newLat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    this.center = [currentLng - dLng, Math.max(-MAX_LAT, Math.min(MAX_LAT, newLat))];
}
```

**Zoom-to-cursor:** keeps the geographic point under the cursor fixed on screen by computing the world-pixel coordinate of the cursor at the old zoom, scaling to the new zoom, then computing the new center that keeps that world coordinate at the same screen offset.

**Input binding:** `attachTo(canvas)` wires `pointerdown`/`pointermove`/`pointerup`/`wheel` events via `AbortController` — no listener leaks on cleanup.

---

## 10. Tile System

### globe-trotter: Horizon Spiral

The 3D tile manager computes which tiles are visible by calculating the horizon angle from the orbital camera position, then spiraling outward from the camera's ground point to find tiles within that angle. Tile zoom level is derived from `floor(-log2(altitude) + bias)`.

### globe-trotter-2d: Viewport Rectangle

**File:** `packages/map/src/tiles/TileManager.js`

The 2D tile manager computes the geographic bounding box of the current viewport in world pixels, converts to tile coordinates, and enumerates the tile rectangle:

```javascript
getVisibleTiles(lng, lat, zoom, viewportW, viewportH) {
    const tileZoom = Math.floor(zoom);
    const worldSize = TILE_PX * Math.pow(2, zoom);        // 256 * 2^zoom
    const tileSize  = TILE_PX * Math.pow(2, zoom - tileZoom); // tile px at fractional zoom

    // Enumerate tiles covering the viewport (half-width/height from center)
    const halfW = viewportW / 2;
    const halfH = viewportH / 2;
    // ...convert camera center to world pixels, compute tile range, iterate grid
}
```

**No horizon culling** — on a flat map, all in-viewport tiles are always visible. The LRU texture cache, concurrent fetch limit (6), and eviction timer are identical to the 3D project.

**Tile geometry:** Each tile is a flat quad. The tile shader receives `u_tileOrigin` (world-pixel top-left corner) and `u_tileSize` and applies the same camera-uniform NDC conversion as the layer shaders:

```glsl
// tile.vert (globe-trotter-2d, WebGL2)
vec2 worldPos = u_tileOrigin + a_quadPos * u_tileSize;
float sx = (worldPos.x - u_cameraOffset.x) / (u_viewportSize.x * 0.5);
float sy = -(worldPos.y - u_cameraOffset.y) / (u_viewportSize.y * 0.5);
gl_Position = vec4(sx, sy, 0.0, 1.0);
```

Compare to the 3D tile shader, which computes inverse Mercator → lat/lon → sphere XYZ, then applies view/projection matrices.

---

## 11. Code-Sharing Strategy

Globe-trotter-2d resolves `@globe-trotter/core` directly to the 3D project's source tree via a Vite path alias, eliminating duplication of the largest shared components:

```javascript
// globe-trotter-2d/vite.config.js
resolve: {
    alias: {
        '@globe-trotter/core': resolve(
            import.meta.dirname,
            '../globe-trotter/lib/packages/core/src/index.js'
        ),
    }
}
```

### Shared (from `@globe-trotter/core`)

| Component                      | What it provides                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `StyleEngine`                  | Color ramp compilation, categorical LUT, GPU texture upload                      |
| `LoaderRegistry`               | Unified loader construction (`'h3f'`, `'dgf'`, `'gfb'`, `'mfb'`, `'gfb-stream'`) |
| `GFBShards`                    | GeoFlex Binary shard fetching and decoding                                       |
| `DGFlexShards`                 | DGFlex shard fetching and decoding                                               |
| `StreamingGFBLoader`           | Live ring-buffer GFB streaming                                                   |
| `decodeMFB`                    | MetricFlex binary decoder                                                        |
| `parseQuery` / `flattenForGPU` | Filter query parser and GPU predicate flattening                                 |

### Shared (from `@globe-trotter/shared`)

| Component                         | What it provides              |
| --------------------------------- | ----------------------------- |
| `lngLatToPixel` / `pixelToLngLat` | Web Mercator pixel math       |
| `bboxUnion` / `bboxIntersects`    | Bounding box operations       |
| `EARTH_RADIUS_M` / `TILE_SIZE`    | Common constants              |
| `mat4` / `vec3`                   | Matrix/vector utilities       |
| Color utilities                   | `hexToRgb`, `sampleColorRamp` |

### Shared (from `@globe-trotter/loaders-2d`)

| Component             | What it provides                                              |
| --------------------- | ------------------------------------------------------------- |
| `ShardedH3FlexLoader` | H3Flex shard fetching, IndexedDB mesh caching, epoch decoding |
| `VirtualH3Loader`     | FlexDB SQL query → H3 layer                                   |

### Not Shared (project-specific)

| Concern                | globe-trotter                                                            | globe-trotter-2d                                     |
| ---------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| **Engine**             | `GlobeTrotterEngine`                                                     | `MapEngine`                                          |
| **Camera**             | `CameraController` / `MercatorCameraController` (polymorphic)            | `PanZoomCamera` (pan/zoom)                           |
| **Projection class**   | `SphericalProjection` / `WebMercatorProjection`                          | `WebMercatorProjection`                              |
| **Layer renderers**    | `H3FlexRenderer`, `GFBRenderer`, `DGFlexRenderer` (polymorphic dispatch) | Same names, 2D implementations                       |
| **Tile renderers**     | `TileRenderer`, `MercatorTileRenderer` (mode-specific)                   | `TileRenderer` (flat quads)                          |
| **Globe renderer**     | `GlobeRenderer` (spherical mode only)                                    | Not present                                          |
| **Shaders**            | WGSL with sphere/Mercator math (projection-aware)                        | WGSL + GLSL with Mercator math                       |
| **Framework wrappers** | `@globe-trotter/vue`, `@globe-trotter/react`                             | `@globe-trotter/map-vue`, `@globe-trotter/map-react` |

---

## 12. Performance Characteristics

### GPU Cost Per Frame (globe-trotter 3D)

| Stage                                | Cost                          |
| ------------------------------------ | ----------------------------- |
| Tile draw calls                      | 1 (instanced), ~150 in WebGL2 |
| H3 epoch transition (WebGPU compute) | < 1 ms                        |
| H3 vertex projection                 | 0 (XYZ baked; passthrough)    |
| Frame rate (1.4M cells, WebGPU)      | 60 FPS                        |

### GPU Cost Per Frame (globe-trotter-2d)

| Stage                     | Cost                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| Tile draw calls           | ~1–64 (simple viewport enumeration)                              |
| H3 epoch transition       | < 1 ms (same texture ping-pong pattern)                          |
| H3 vertex projection      | ~2 trig ops × vertex count (scale + offset, no trig in hot path) |
| Frame rate (5M+ H3 cells) | 60 FPS target                                                    |

The 2D H3 vertex projection is essentially free in practice: positions are baked at zoom 0, and the per-frame "projection" is just a multiply + subtract + divide (no transcendental functions in the shader hot path). The CPU `xyzToMercator()` conversion runs once at mesh load and is cached for the session.

### Dirty-Flag Rendering

Both projects use a dirty-flag request-animation-frame loop: if neither the camera nor the time state has changed and no new data has arrived, the GPU render pass is skipped entirely. This means idle CPU cost is effectively zero.

---

## 13. Float32 Precision Analysis

### 3D (globe-trotter): Acceptable Everywhere

On a unit sphere, all XYZ coordinates are in `[-1, 1]`. Float32 provides ~7 significant decimal digits, giving sub-millimeter precision — more than sufficient for rendering.

### 2D (globe-trotter-2d): Precision Challenge at High Zoom

At high zoom levels, world-pixel coordinates become very large. At zoom 20, `worldSize = 256 × 2^20 ≈ 268M pixels`. A float32 can represent integers up to 2^24 (≈16.7M) exactly; beyond that, adjacent integers merge. This means at zoom 20, float32 world coordinates have ~16 pixel quantization — visible as vertex jitter.

**Mitigation: Relative-to-Camera Coordinates (baked-at-zoom-0 approach)**

Globe-trotter-2d sidesteps the problem by baking positions at zoom 0 (max value = 256) and scaling in the shader:

```glsl
// Positions baked at zoom 0, max world value = 256 — safely within float32 range
float scale = u_worldSize / 256.0;  // 2^zoom — a small scalar
float wx    = a_position.x * scale; // world pixel at current zoom
```

The `a_position` values are all in `[0, 256]` (zoom 0 world), so float32 is exact. The multiplication by `scale` introduces only one rounding step. The subsequent subtraction of `u_cameraOffset` (which is close in magnitude to `wx`) eliminates the high-order bits, leaving the result in the range of the viewport size (typically ≤ 4096 px) — well within float32 precision.

**Practical precision:** Sub-pixel accuracy is maintained up to approximately zoom 18–19 without explicit float64 camera math. At higher zoom levels, precision can be improved by computing `u_cameraOffset` in float64 on the CPU before truncating to float32 for the GPU uniform.

---

## 14. File Inventory

### globe-trotter (3D) — Projection-Relevant Files

| File                                                       | Role                                              |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `lib/packages/core/src/GlobeTrotterEngine.js`              | Engine facade; no projection switching API        |
| `lib/packages/core/src/camera/CameraController.js`         | Orbital camera; produces view/projection matrices |
| `lib/packages/core/src/layers/shaders/h3hex.wgsl`          | H3 hexagon vertex shader (globe-only)             |
| `lib/packages/core/src/layers/shaders/h3hex.vert`          | H3 hexagon WebGL2 vertex shader (globe-only)      |
| `lib/packages/core/src/layers/shaders/dgflex.wgsl`         | DGFlex vertex shader (globe-only)                 |
| `lib/packages/core/src/layers/shaders/gfbpoint.wgsl`       | GFB point vertex shader (lat/lon → sphere)        |
| `lib/packages/core/src/tiles/shaders/tile.wgsl`            | Tile vertex shader (inverse Mercator → sphere)    |
| `lib/packages/core/src/tiles/TileManager.js`               | Horizon-spiral tile visibility                    |
| `lib/packages/core/src/globe/GlobeRenderer.js`             | Globe sphere renderer (not present in 2D)         |
| `architecture/globe-trotter/geodetic-coordinate-system.md` | Spherical WGS84 math reference                    |

### globe-trotter-2d (2D) — Projection-Relevant Files

#### Projection Core

| File                                                   | Role                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/map/src/projection/WebMercatorProjection.js` | CPU Mercator: `project()`, `unproject()`, `lngLatToTile()`            |
| `packages/shared/src/geo/index.js`                     | Shared utilities: `lngLatToPixel()`, `pixelToLngLat()`, `bboxUnion()` |

#### Camera

| File                                       | Role                                             |
| ------------------------------------------ | ------------------------------------------------ |
| `packages/map/src/camera/PanZoomCamera.js` | 2D pan/zoom camera; state: `[lng, lat]` + `zoom` |

#### Shaders

| File                                        | Role                                                  |
| ------------------------------------------- | ----------------------------------------------------- |
| `packages/map/src/shaders/webmercator.glsl` | WebGL2 forward Mercator projection function           |
| `packages/map/src/shaders/webmercator.wgsl` | WebGPU forward Mercator projection function           |
| `packages/map/src/shaders/h3hex.vert`       | H3 hexagon vertex shader (Mercator world-pixel input) |
| `packages/map/src/shaders/h3hex.frag`       | H3 hexagon fragment shader (color ramp sampling)      |
| `packages/map/src/shaders/tile.vert`        | Tile quad vertex shader (world-pixel → NDC)           |
| `packages/map/src/shaders/tile.frag`        | Tile quad fragment shader (texture sampling)          |

#### Renderers and Layers

| File                                            | Role                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/map/src/layers/H3FlexRenderer.js`     | WebGL2 H3 renderer; includes `xyzToMercator()` + antimeridian splitting         |
| `packages/map/src/layers/H3FlexRendererGPU.js`  | WebGPU H3 renderer                                                              |
| `packages/map/src/layers/GeoFlexRenderer.js`    | WebGL2 GFB points/lines/polygons renderer                                       |
| `packages/map/src/layers/GeoFlexRendererGPU.js` | WebGPU GFB renderer                                                             |
| `packages/map/src/layers/DGFlexRenderer.js`     | WebGL2 DGFlex renderer                                                          |
| `packages/map/src/layers/DGFlexRendererGPU.js`  | WebGPU DGFlex renderer                                                          |
| `packages/map/src/layers/LayerManager.js`       | Config-driven layer lifecycle; imports `StyleEngine` from `@globe-trotter/core` |

#### Tiles

| File                                        | Role                                          |
| ------------------------------------------- | --------------------------------------------- |
| `packages/map/src/tiles/TileManager.js`     | Viewport-rectangle tile visibility; LRU cache |
| `packages/map/src/tiles/TileRenderer.js`    | WebGL2 tile rendering                         |
| `packages/map/src/tiles/TileRendererGPU.js` | WebGPU tile rendering                         |

#### Engine

| File                                 | Role                                       |
| ------------------------------------ | ------------------------------------------ |
| `packages/map/src/MapEngine.js`      | Main facade: init, render loop, public API |
| `packages/map-react/src/MapView.jsx` | React 18/19 wrapper (109 lines)            |
| `packages/map-vue/src/MapView.js`    | Vue 3 wrapper (111 lines)                  |

#### Architecture Documentation

| File                                                | Role                                                           |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `architecture/map/map-projection-architecture.md`   | Detailed projection math, precision analysis, design rationale |
| `architecture/map/map-camera-system.md`             | PanZoomCamera state, pan/zoom math, event binding              |
| `architecture/map/map-rendering-pipeline.md`        | Dirty-flag loop, frame sequence, dual-backend                  |
| `architecture/map/map-library-architecture.md`      | Package structure, MapEngine facade, module graph              |
| `architecture/map/map-tile-system-architecture.md`  | Tile visibility, LRU cache, concurrent fetching                |
| `architecture/map/map-layer-system-architecture.md` | Layer lifecycle, style compilation, filter system              |
