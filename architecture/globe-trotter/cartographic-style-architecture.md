# Cartographic Style Architecture: GPU-Native Styling for Globe-Trotter

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Problem — Hardcoded Cartography](#2-the-problem--hardcoded-cartography)
3. [Design Principles](#3-design-principles)
4. [GPU-Native Style Compilation](#4-gpu-native-style-compilation)
5. [Style Specification Format](#5-style-specification-format)
6. [Multi-Attribute Styling](#6-multi-attribute-styling)
7. [Style Delivery & Loading](#7-style-delivery--loading)
8. [Client-Side Programmatic API](#8-client-side-programmatic-api)
9. [SDF-Based Wide Line Rendering](#9-sdf-based-wide-line-rendering)
10. [Performance Characteristics](#10-performance-characteristics)
11. [File Inventory](#11-file-inventory)

---

## 1. Executive Summary

Cartographic styling — the mapping from raw data values to visual properties like color, opacity, width, and icon shape — is a fundamental challenge in any GIS application. Traditional approaches fall into two extremes: either the styling is hardcoded in shader source code (fast but inflexible), or it's computed per-feature on the CPU every frame (flexible but slow).

Globe-Trotter's **StyleEngine** eliminates this trade-off by **compiling declarative style specifications into GPU textures at load time**. The result:

- **Color ramps** become 256×1 RGBA textures sampled in the fragment shader with a single `texture()` call — the same GPU cost as a hardcoded ramp, but dynamically configurable at runtime.
- **Categorical colors** become N×1 lookup table (LUT) textures — one `texelFetch()` per fragment, O(1) regardless of category count.
- **Changing a color ramp** requires one `texSubImage2D()` call (1 KB of data), not a shader recompilation.
- **Multi-attribute styling** — color from column A, opacity from column B — works by binding separate data textures, each driven by its own style spec.

The styling system supports three delivery modes: **embedded in the binary format** (via `HAS_STYLE` flag — zero additional HTTP requests), **server-delivered sidecar JSON**, and **client-side programmatic construction**. All three compile to the same GPU resources via the same `StyleEngine.compile()` pipeline. Programmatic styles always override embedded and sidecar styles.

---

## 2. The Problem — Hardcoded Cartography

Before the StyleEngine, all visual mappings were baked directly into GLSL shader source:

### H3Flex (Cell Coloring)

```glsl
// h3hex.frag — 15 lines of hardcoded color stops
vec3 supplyColorRamp(float supply) {
    float t = clamp(supply / 150.0, 0.0, 1.0);
    vec3 c0 = vec3(0.05, 0.10, 0.50);  // deep blue
    vec3 c1 = vec3(0.05, 0.45, 0.75);  // cyan
    vec3 c2 = vec3(0.10, 0.75, 0.35);  // green
    vec3 c3 = vec3(0.85, 0.85, 0.10);  // yellow
    vec3 c4 = vec3(0.95, 0.20, 0.10);  // red
    if (t < 0.25) return mix(c0, c1, t / 0.25);
    if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
    if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
    return mix(c3, c4, (t - 0.75) / 0.25);
}
```

### GeoFlex (Point Coloring)

```glsl
// gfbpoint.frag — all features rendered with a single constant fallback
const vec3 DEFAULT_POINT_COLOR = vec3(0.0, 0.75, 0.9); // cyan
```

**Problems:**

1. **No runtime configuration** — changing a single color stop requires editing GLSL, recompiling the shader program, and reloading the page.
2. **No multi-layer support** — two H3Flex layers can't have different color ramps.
3. **No data-driven opacity** — opacity is a constant (`v_alpha = 0.7`), not driven by an attribute.
4. **No style sharing** — a backend can't deliver a recommended visualization alongside the data.

---

## 3. Design Principles

| Principle                      | Rationale                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GPU-native**                 | Styles compile to textures and uniforms. The fragment shader does the same number of texture lookups as the hardcoded approach — zero performance regression.                                |
| **Zero-copy compatible**       | Style compilation is a separate pass from data decoding. The H3Flex/GeoFlex zero-copy decode pipeline is untouched.                                                                          |
| **Declarative + Programmatic** | Server delivers a JSON style spec, OR the client builds one via `StyleEngine.ramp()` / `StyleEngine.categorical()`. Both paths compile to the same GPU resources.                            |
| **Format-aware**               | Separate style schemas for H3Flex cells (continuous ramps), GeoFlex points (categorical LUTs, icon shapes), GeoFlex lines (SDF width, dash patterns), and GeoFlex polygons (fill + outline). |
| **Hot-swappable**              | `setStyle()` on any renderer replaces GPU textures without touching the VAO, mesh, or shader program.                                                                                        |

---

## 4. GPU-Native Style Compilation

The core innovation: **style specifications are compiled into GPU resources at load time**, not interpreted at render time.

### 4.1 Color Ramp → 1D Texture

```
Style JSON                     GPU Texture                  GLSL Shader
┌──────────────────┐           ┌────────────────────┐       ┌────────────────────────────┐
│ 5 color stops    │──compile─►│ 256×1 RGBA texture │─bind─►│ texture(u_colorRamp, t).rgb│
│ domain: [0, 150] │  (< 0.5ms)│ LINEAR filtering   │       │ // t = normalized value    │
│ hex colors       │           │ CLAMP_TO_EDGE      │       │ // 1 sample per fragment   │
└──────────────────┘           └────────────────────┘       └────────────────────────────┘
```

**How it works:**

1. `RampCompiler.compileRampData()` takes N color stops and a `[min, max]` domain.
2. It pre-interpolates the ramp into a 256-pixel RGBA `Uint8Array` on the CPU (< 0.5ms).
3. `uploadRampTexture()` uploads the array via `texImage2D` with `LINEAR` filtering.
4. The fragment shader normalizes the attribute value: `t = (value - min) / (max - min)` and samples the texture: `texture(u_colorRamp, vec2(t, 0.5))`.

**Result:** The GPU does one texture sample per fragment — identical cost to the old hardcoded `mix()` chain, but now the ramp is a data structure, not code.

### 4.2 Categorical → Lookup Table Texture

```
Category Map                   GPU Texture                  GLSL Shader
┌──────────────────┐           ┌────────────────────┐       ┌───────────────────────────────────────┐
│ N categories     │──compile─►│ N×1 RGBA texture   │─bind─►│ texture(u_colorRamp, (idx+0.5)/width) │
│ + default color  │           │ NEAREST filtering  │       │ // idx = dictionary index             │
└──────────────────┘           └────────────────────┘       └───────────────────────────────────────┘
```

**How it works:**

1. `CategoricalCompiler.compileCategoricalData()` receives a `{ name: color }` map and the decoded dictionary.
2. It creates an N-pixel RGBA `Uint8Array` where pixel `i` = the color for dictionary entry `i`.
3. `uploadCategoricalTexture()` uploads with `NEAREST` filtering (no interpolation — exact texel match).
4. The shader normalizes the enum attribute value (ENUM8/16/32) into a UV coordinate: `(v_value + 0.5) / u_catWidth`, where `u_catWidth` is the LUT texture width (= dictionary size). With NEAREST filtering, this maps each index to exactly one texel.

**Result:** O(1) category-to-color mapping regardless of N. No hash maps, no `switch` statements, no CPU loops.

### 4.3 The CompiledStyle Object

```javascript
CompiledStyle {
    color:   { type: 'ramp'|'categorical'|'constant', texture?, attribute?, domain?, value? }
    opacity: { type: 'ramp'|'constant', texture?, attribute?, domain?, value? }
    size:    { type: 'constant', value }     // points
    width:   { type: 'constant', value }     // lines
    outline: { color, width, opacity }       // polygons
    icon:    { shape, sdf }                  // points

    dispose(gl)  // Frees GPU textures
}
```

This object is the **only interface** between the styling system and the renderers. Renderers never see raw style JSON — they receive pre-compiled GPU resources.

---

## 5. Style Specification Format

### 5.1 H3Flex Cell Style (Color Ramp)

```json
{
  "format": "h3flex",
  "version": 1,
  "layers": [
    {
      "id": "demand-heatmap",
      "attribute": "demand_mbps",
      "style": {
        "type": "color-ramp",
        "domain": [0, 150],
        "stops": [
          { "value": 0, "color": "#0D1A80" },
          { "value": 37, "color": "#0D73BF" },
          { "value": 75, "color": "#1ABF59" },
          { "value": 112, "color": "#D9D91A" },
          { "value": 150, "color": "#F23319" }
        ],
        "opacity": 0.7
      }
    }
  ]
}
```

### 5.2 GeoFlex Point Style (Categorical)

```json
{
  "format": "geoflex",
  "version": 1,
  "layers": [
    {
      "id": "aircraft-tracks",
      "geometry": "point",
      "style": {
        "type": "categorical",
        "attribute": "airline",
        "icon": { "shape": "circle", "radius": 4, "sdf": true },
        "categories": {
          "Delta": { "color": "#0032A0", "radius": 5 },
          "United": { "color": "#002244" },
          "Southwest": { "color": "#F3B716" }
        },
        "default": { "color": "#999999" },
        "opacity": 0.9
      }
    }
  ]
}
```

### 5.3 GeoFlex Line Style (SDF + Ramp)

```json
{
  "format": "geoflex",
  "version": 1,
  "layers": [
    {
      "id": "flight-paths",
      "geometry": "line",
      "style": {
        "type": "attribute-ramp",
        "attribute": "altitude_ft",
        "width": 3,
        "domain": [0, 45000],
        "stops": [
          { "value": 0, "color": "#2196F3" },
          { "value": 45000, "color": "#F44336" }
        ],
        "dashPattern": null,
        "opacity": 0.8
      }
    }
  ]
}
```

### 5.4 GeoFlex Polygon Style (Fill + Outline)

```json
{
  "format": "geoflex",
  "version": 1,
  "layers": [
    {
      "id": "coverage-zones",
      "geometry": "polygon",
      "style": {
        "type": "categorical",
        "attribute": "status",
        "fill": {
          "categories": {
            "active": { "color": "#4CAF50", "opacity": 0.3 },
            "planned": { "color": "#FF9800", "opacity": 0.2 }
          }
        },
        "outline": {
          "color": "#FFFFFF",
          "width": 1.5,
          "opacity": 0.8
        }
      }
    }
  ]
}
```

---

## 6. Multi-Attribute Styling

A single layer can drive different visual properties from different data columns:

```javascript
const style = StyleEngine.multi({
  color: {
    type: 'ramp',
    attribute: 'demand_mbps', // Color from supply column
    domain: [0, 150],
    stops: [
      { value: 0, color: '#0D1A80' },
      { value: 150, color: '#F23319' },
    ],
  },
  opacity: {
    type: 'ramp',
    attribute: 'confidence', // Opacity from confidence column
    domain: [0, 1],
    stops: [
      { value: 0, opacity: 0.1 },
      { value: 1, opacity: 0.9 },
    ],
  },
});
```

**GPU implementation:** Each attribute (color, opacity) gets its own data texture and its own ramp/LUT texture. The fragment shader samples both:

```glsl
// Color from supply ramp
float tColor = normalize(v_supplyValue, u_colorDomain);
vec4 color = texture(u_colorRamp, vec2(tColor, 0.5));

// Opacity from confidence ramp
float tOpacity = normalize(v_confidenceValue, u_opacityDomain);
float alpha = texture(u_opacityRamp, vec2(tOpacity, 0.5)).a;

fragColor = vec4(color.rgb, alpha);
```

---

## 7. Style Delivery & Loading

The `LayerManager` resolves styles through a five-tier cascade (highest priority first):

```
┌─────────────────────────────────────────────────────────────────┐
│  Priority 1: Explicit style object                              │
│    addLayer('Demand', 'h3f', url, { style: { ... } })           │
├─────────────────────────────────────────────────────────────────┤
│  Priority 2: Explicit style URL                                 │
│    addLayer('Demand', 'h3f', url, {                             │
│        styleUrl: '/styles/demand-heatmap.style.json'            │
│    })                                                           │
├─────────────────────────────────────────────────────────────────┤
│  Priority 3: Sidecar convention (auto-discovered)               │
│    /data/demand_metrics.h3f → /data/demand_metrics.style.json   │
│    Fetched automatically, 404 = fall through                    │
├─────────────────────────────────────────────────────────────────┤
│  Priority 4: Embedded in data file (HAS_STYLE flag)             │
│    Style travels inside the H3Flex/GeoFlex binary.              │
│    Zero additional HTTP requests. Atomic delivery.              │
├─────────────────────────────────────────────────────────────────┤
│  Priority 5: Geometry-type default                              │
│    Point: #00BFE6, Line: #4A90D9, Polygon: #2E8B57              │
│    H3F: blue→red 5-stop ramp, domain [0,1], α=0.7               │
│    _resolveStyle() always returns a valid spec — never null     │
└─────────────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> **Programmatic `setLayerStyle()` always overrides all of the above.** The cascade only determines the initial style at load time. Client code can swap to any style at any time.

### Embedded Style (HAS_STYLE = 0x10)

The **recommended primary delivery mode.** The style spec is embedded directly in the H3Flex/GeoFlex binary, after the column schema:

```
┌─────────────────────────────────────┐
│  H3Flex Header (32 bytes)           │
│    flags: HAS_TEMPORAL | HAS_STYLE  │
├─────────────────────────────────────┤
│  Column Schema                      │
├─────────────────────────────────────┤
│  Style Spec (length-prefixed JSON)  │
│    Uint32: byte length              │
│    UTF-8: JSON body (~500 bytes)    │
├─────────────────────────────────────┤
│  Dictionary (if HAS_DICTIONARY)     │
├─────────────────────────────────────┤
│  ... rest of data sections ...      │
└─────────────────────────────────────┘
```

**Advantages over sidecar files:**

| Factor            | Sidecar (2 requests)              | Embedded (1 request)                                                  |
| ----------------- | --------------------------------- | --------------------------------------------------------------------- |
| HTTP requests     | 2 (data + style)                  | **1**                                                                 |
| Size overhead     | ~500B pre-gzip                    | **~0** (compresses to nothing inside the already-gzipped data stream) |
| Version coherence | Risk of stale style vs fresh data | **Atomic** — always in sync                                           |
| CDN caching       | 2 URLs to manage                  | **1 URL**                                                             |

### Sidecar Convention (Fallback)

For cases where you want to override an embedded style without regenerating the data file:

| Data File             | Style Sidecar (auto-discovered) |
| --------------------- | ------------------------------- |
| `demand_metrics.h3f`  | `demand_metrics.style.json`     |
| `aircraft_tracks.gfb` | `aircraft_tracks.style.json`    |

> [!TIP]
> **Sidecar takes priority over embedded.** This means you can ship data with an embedded default style, then deploy a sidecar override without touching the data file.

---

## 8. Client-Side Programmatic API

### 8.1 Simple Ramp

```javascript
import { StyleEngine } from './styles/StyleEngine.js';

// Evenly-spaced color ramp from 5 hex colors
const style = StyleEngine.ramp({
  attribute: 'demand_mbps',
  domain: [0, 150],
  stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319'],
  opacity: 0.7,
});

const compiled = StyleEngine.compile(gl, style);
renderer.setStyle(compiled);
```

### 8.2 Categorical

```javascript
const style = StyleEngine.categorical({
  attribute: 'region',
  categories: {
    North: '#E31937',
    South: '#0032A0',
    West: '#F3B716',
  },
  default: '#999999',
});
```

### 8.3 Hot-Swap at Runtime

```javascript
// Change the color ramp from the browser console — zero shader recompilation:
layerManager.setLayerStyle(
  'Demand Metrics',
  StyleEngine.ramp({
    attribute: 'demand_mbps',
    domain: [0, 100],
    stops: ['#000033', '#0066FF', '#00FFFF', '#FFFFFF'],
    opacity: 0.9,
  })
);
// Takes effect in < 1ms. Next frame uses the new ramp.
```

### 8.4 Update Ramp Without Recompiling

```javascript
// Even faster: update just the ramp texture data on an existing CompiledStyle
StyleEngine.updateRamp(
  gl,
  compiledStyle,
  [
    { value: 0, color: '#000000' },
    { value: 100, color: '#FF0000' },
  ],
  [0, 100]
);
// One texSubImage2D call (1KB). No new objects allocated.
```

---

## 9. SDF-Based Wide Line Rendering

Standard WebGL `gl.LINE_STRIP` is limited to 1px width on most hardware. Globe-Trotter uses **Signed Distance Field (SDF) wide lines** for GeoFlex line features, enabling arbitrary width with GPU-native antialiasing.

### 9.1 Technique

Each line segment is expanded into a screen-space quad in the vertex shader:

```
Screen Space

 ░░░░░░░░░░░░░░░░░░░░░   ← a_side = +1 (top edge)
 ████████████████████████  ← line core
 ████████████████████████  ← line core
 ░░░░░░░░░░░░░░░░░░░░░   ← a_side = -1 (bottom edge)

 A ─────────────────── B   Line segment endpoints
```

1. **Vertex shader** (`gfbline.vert`): Projects endpoints A and B to clip space, computes screen-space direction, extrudes perpendicular by `u_lineWidth / 2 + 1px` for antialiasing margin.

2. **Fragment shader** (`gfbline.frag`): Uses the interpolated signed distance `v_dist` (−1 at left edge, +1 at right edge) to compute alpha:

```glsl
float lineCore = u_lineWidth / (u_lineWidth + 1.0);
float dist = abs(v_dist);
float alpha = 1.0 - smoothstep(lineCore, 1.0, dist);
```

This produces a pixel-perfect antialiased edge regardless of line width.

### 9.2 Color Integration

Line color is driven by the same StyleEngine ramp system:

```glsl
float t = clamp((v_value - u_domain.x) / (u_domain.y - u_domain.x), 0.0, 1.0);
vec4 color = texture(u_colorRamp, vec2(t, 0.5));
fragColor = vec4(color.rgb, color.a * alpha * u_opacity);
```

A flight path can be colored by altitude, speed, or any other continuous attribute — the same ramp texture approach used for H3Flex cells.

### 9.3 Performance

| Metric                    | Value                               |
| ------------------------- | ----------------------------------- |
| Vertices per line segment | 4 (quad)                            |
| Draw call                 | 1 per layer (instanced)             |
| Antialiasing              | GPU `smoothstep` — no MSAA required |
| Width range               | 0.5px to 50px+                      |
| Width change cost         | 1 × `gl.uniform1f()`                |

---

## 10. Performance Characteristics

### 10.1 Style Compilation Costs

| Operation                         | Time      | Data Size |
| --------------------------------- | --------- | --------- |
| Parse style JSON (5 stops)        | < 0.1ms   | —         |
| Compile ramp → 256px texture      | < 0.5ms   | 1 KB      |
| Compile categorical → N-pixel LUT | < 0.1ms   | 4N bytes  |
| Upload to GPU (`texImage2D`)      | < 0.1ms   | 1 KB      |
| **Total load-time cost**          | **< 1ms** | —         |

### 10.2 Per-Frame Rendering Costs

| Operation              | Old (Hardcoded)                     | New (Texture-Driven)                 |
| ---------------------- | ----------------------------------- | ------------------------------------ |
| Color ramp lookup      | 4 branches + 3 `mix()` per fragment | **1 `texture()` per fragment**       |
| Category lookup        | —                                   | **1 `texture()` per fragment**       |
| Shader program changes | Needed for any color change         | **Never** (textures + uniforms only) |
| Net rendering impact   | —                                   | **Zero** (same GPU workload)         |

### 10.3 Runtime Style Update Costs

| Operation                      | Cost                       |
| ------------------------------ | -------------------------- |
| Change color ramp              | 1 × `texSubImage2D` (1 KB) |
| Change opacity                 | 1 × `gl.uniform1f()`       |
| Change line width              | 1 × `gl.uniform1f()`       |
| Change domain [min, max]       | 1 × `gl.uniform2f()`       |
| Full style swap (`setStyle()`) | < 1ms (compile + upload)   |

> [!IMPORTANT]
> **The rendering cost of the new style system is identical to the old hardcoded approach.** The GPU does the same number of texture lookups either way. The difference is that the lookup table is now in a texture (configurable) instead of in GLSL source (fixed).

---

## 11. File Inventory

### Style Engine Core

| File                                | Purpose                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/styles/StyleEngine.js`         | Central compiler + programmatic API (`ramp()`, `categorical()`, `compile()`)              |
| `src/styles/RampCompiler.js`        | Color stops → 256×1 RGBA texture, `compileRampData()` + `uploadRampTexture()`             |
| `src/styles/CategoricalCompiler.js` | Category map → N×1 LUT texture, `compileCategoricalData()` + `uploadCategoricalTexture()` |

### Layer Shaders

| File                               | Purpose                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `src/layers/shaders/h3hex.vert`    | H3Flex vertex: pre-computed position + data texture lookup      |
| `src/layers/shaders/h3hex.frag`    | H3Flex fragment: `texture(u_colorRamp, t)` color ramp + opacity |
| `src/layers/shaders/gfbpoint.vert` | GeoFlex point vertex: position + categorical index              |
| `src/layers/shaders/gfbpoint.frag` | GeoFlex point fragment: SDF circle + categorical/ramp color     |
| `src/layers/shaders/gfbline.vert`  | SDF wide line: screen-space quad extrusion                      |
| `src/layers/shaders/gfbline.frag`  | SDF wide line: antialiasing + ramp color lookup                 |

### Renderers & Decoders

| File                               | Purpose                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/layers/H3FlexRenderer.js`     | Accepts `CompiledStyle`, binds ramp on TEXTURE1, `setStyle()` API                                         |
| `src/layers/H3FlexDecoder.js`      | Zero-copy H3F decoder: typed array views into network buffer                                              |
| `src/layers/GFBRenderer.js`        | Accepts `CompiledStyle`, point rendering with 4 SDF symbols + `u_catWidth` LUT sampling, `setStyle()` API |
| `src/layers/GFBLineRenderer.js`    | SDF wide-line renderer with style-driven coloring                                                         |
| `src/layers/GFBPolygonRenderer.js` | Triangulated polygon renderer with fill + optional extrusion                                              |
| `src/layers/GFBDecoder.js`         | Zero-copy GFB decoder: typed array views into network buffer                                              |
| `src/layers/LayerManager.js`       | Style cascade (`_resolveStyle` + `_defaultStyle`), `setLayerStyle()` API                                  |

### UI Widgets

| File                               | Purpose                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `src/ui/UIManager.js`              | Orchestrates all UI panels (footer, layers, geocoder, time)       |
| `src/ui/AcetateFooter.js`          | Status bar: coordinates, altitude, FPS, draw calls                |
| `src/ui/LayerManagerDialog.js`     | Layer toggle + symbology button + basemap selector                |
| `src/ui/SymbologyDialog.js`        | Point symbology editor (symbol type, per-category color, opacity) |
| `src/ui/LineSymbologyDialog.js`    | Line symbology editor (width, color ramp, dash pattern)           |
| `src/ui/PolygonSymbologyDialog.js` | Polygon symbology editor (fill, outline, opacity)                 |
| `src/ui/LegendPanel.js`            | Auto-generated legend from compiled style categories/ramp         |
| `src/ui/GeocoderDialog.js`         | Location search with geocoding results                            |
| `src/ui/TimePanel.js`              | Time scrubber with play/pause and speed cycling                   |
| `src/ui/styles.js`                 | Programmatic CSS injection for all widgets                        |
