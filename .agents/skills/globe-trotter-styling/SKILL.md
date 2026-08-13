---
name: globe-trotter-styling
description: StyleEngine API for Globe Trotter — color ramps, categorical LUTs, opacity stops, compile/dispose lifecycle, GPU texture management, symbol types, and symbology dialog.
---

# Globe Trotter Styling System

The `StyleEngine` converts style specifications into GPU-ready textures for rendering. Supports continuous color ramps, categorical lookup tables, and constant values. The `SymbologyDialog` provides interactive editing of GFB vector symbology.

## When to use this skill

- Use this when creating or modifying data-driven color schemes
- Use this when building programmatic styles in JavaScript
- Use this when debugging why colours or opacity aren't rendering correctly
- Use this when hot-swapping styles at runtime
- Use this when customizing GFB point symbology (shape, size, per-category colors)

## How to use it

### Creating a Color Ramp

```javascript
const spec = StyleEngine.ramp({
  attribute: 'supply_mbps',
  domain: [0, 100],
  stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319'],
  opacityStops: [
    { value: 0, opacity: 0.0 },
    { value: 100, opacity: 0.9 },
  ],
});
```

### Creating a Categorical Style

```javascript
const spec = StyleEngine.categorical({
  attribute: 'airline',
  categories: { Delta: '#E31937', United: '#0032A0' },
  default: '#999999',
  opacity: 0.9,
});
```

### Compiling to GPU Resources

```javascript
const compiledStyle = StyleEngine.compileGPU(device, spec, data.dictionary || []);
// Returns CompiledStyle with .color, .opacity, .disposeGPU()
```

### Hot-Swapping at Runtime

```javascript
// Full style swap (recompiles shader + texture):
const newStyle = StyleEngine.compileGPU(device, newSpec, dictionary);
renderer.setStyle(newStyle); // old style auto-disposed

// Fast ramp recompile (rebuilds the 256×1 texture, <1ms):
layerManager.updateLayerRamp(layerName, stops, domain);
```

### GPU-First Ramp Updates

`LayerManager.updateLayerRamp()` recompiles the color stops via `StyleEngine.compileGPU()` and swaps the result in through `renderer.setStyle()` — no render pipeline/shader rebuild, still <1ms for a 256×1 texture. Use this for interactive ramp editing (e.g. dragging color stop handles).

```javascript
const stops = [
  { value: 0, color: '#0D1A80', opacity: 0.0 },
  { value: 50, color: '#1ABF59', opacity: 0.6 },
  { value: 100, color: '#F23319', opacity: 0.9 },
];
layerManager.updateLayerRamp('My Layer', stops, [0, 100]);
```

### Color Modes (GFB Shader)

GFB point/line/polygon shaders support 3 color modes via `color_mode`:

| Mode | Uniform         | Description                                                                                     |
| ---- | --------------- | ----------------------------------------------------------------------------------------------- |
| 0    | Fallback        | Default cyan `#00BFE6` when no style configured                                                 |
| 1    | Ramp            | 256×1 texture sampled with `textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5))`             |
| 2    | Categorical LUT | Width=dictLength, sampled with `textureSample(color_ramp, ramp_sampler, vec2f(idx/width, 0.5))` |

### Symbol Types (GFB Points)

GFB point shaders support 4 SDF symbol types via `symbol_type`:

| Value | Symbol        | Use Case                                                                                    |
| ----- | ------------- | ------------------------------------------------------------------------------------------- |
| 0     | ● + V-chevron | Default: directional aircraft/vehicle. V-cutout uses hard-discard to prevent glow flooding. |
| 1     | ▲ Arrow       | Directional movement                                                                        |
| 2     | ◆ Diamond     | Waypoints, fixed assets                                                                     |
| 3     | ● Circle      | Generic points                                                                              |

Grounded features (altitude > 0 and < 100 feet) automatically switch to a plain circle with a pulsing animation. When altitude data is absent (`alt == 0`), features are treated as airborne.

### SymbologyDialog (Interactive GFB Editing)

The `SymbologyDialog` provides a rich overlay editor for GFB vector layers:

```javascript
const dialog = new SymbologyDialog(engine, 'Aircraft Tracks');
// Opens overlay with:
//   - Symbol type dropdown (circle+chevron, arrow, diamond, circle)
//   - Symbol scale slider
//   - Attribute selector (for categorical coloring)
//   - Per-category color pickers
//   - Global opacity slider
//   - Reset to defaults button
dialog.close();
dialog.destroy();
```

All changes hot-swap via `StyleEngine → renderer.setStyle()`. Symbology changes call `engine.requestRender()` to wake up the WebGPU stationary frame detection, ensuring changes are visible even when time playback is paused.

### H3SymbologyDialog (Interactive H3 Ramp Editing)

The `H3SymbologyDialog` provides a floating overlay editor for H3Flex layers, launched from the Layer Manager's Symbology button:

```javascript
const dialog = new H3SymbologyDialog(engine, 'Demand Metrics', {
    stops: [{ value: 0, color: '#0D1A80', opacity: 0.0 }, ...],
    domain: [0, 60],
    attribute: 'demand_mbps'
});
// Opens overlay with:
//   - Color ramp gradient track (click to add stops, right-click to remove)
//   - Draggable color stop handles with color pickers
//   - Editable stop table: per-stop value input, color picker, opacity input, remove button
//   - Domain min/max inputs (auto-rescales stops)
//   - Add Stop / Reset buttons
//   - 3D Extrusion controls (toggle + scale slider) — if renderer supports it
//   - Draggable by header bar (all symbology dialogs)
dialog.close();
dialog.destroy();
```

All changes apply in real-time to the GPU via `LayerManager.updateLayerRamp()`.

### LineSymbologyDialog & PolygonSymbologyDialog

GFB line and polygon layers have dedicated symbology dialogs with:

- Color mode toggle (Ramp / Discrete)
- Attribute selector
- Per-category color pickers (discrete mode)
- Domain + ramp stop color pickers (ramp mode)
- Opacity slider
- Line width slider (LineSymbologyDialog only)
- 3D extrusion toggle + scale (PolygonSymbologyDialog only)
- Draggable by header bar

### LegendPanel

Toggle popup showing per-layer symbology. Shows category name + color swatch for GFB categorical layers, and color ramp preview for H3F layers. Lazy-populated — only built on first open. **MFB (metric-only) layers are excluded** from the legend since they have no spatial rendering.

### GPU Texture Types

- **Ramp**: 256×1 RGBA texture, sampled with `textureSample(color_ramp, ramp_sampler, vec2f(t, 0.5))`
- **Categorical LUT**: width=dictLength, sampled with `textureSample(color_ramp, ramp_sampler, vec2f(idx/width, 0.5))`

### Static vs Temporal Attribute Compatibility

Style features behave differently depending on whether the `attribute` is in `staticColumns` or `temporalColumns`, **and which GFB geometry type is used**. This is the most common source of "opacity stops don't work" issues.

| Feature (temporal attribute) | H3Flex          | GFB Point                              | GFB Line / Polygon           |
| ---------------------------- | --------------- | -------------------------------------- | ---------------------------- |
| Color ramp                   | ✓ per-epoch     | ✓ per-epoch (value buffer re-uploaded) | ✗ reads `staticColumns` only |
| `opacityStops`               | ✓ alpha in ramp | ✓ alpha in ramp                        | ✗ static only                |
| Categorical LUT              | N/A (uses ramp) | ✓ (categories are static)              | ✓ (categories are static)    |
| `opacity` (global)           | ✓               | ✓                                      | ✓                            |
| Color ramp (static attr)     | ✓               | ✓                                      | ✓                            |

**Why?** H3Flex samples attribute values per epoch from RGBA32F data textures on the GPU. GFB **points** now also support temporal color/opacity: `GFBRenderer` detects a temporal attribute (`isTemporal`) and re-uploads the per-instance value buffer each epoch via `updateValueBuffer()` (`GFBRenderer.js:357-365`, `:964-966`); alpha is baked into the sampled ramp texel, so temporal `opacityStops` work too. GFB **line** and **polygon** renderers read `a_value` from `staticColumns` at init only (`GFBLineRenderer.js:302`, `GFBPolygonRenderer.js:223,338`) — a temporal-only attribute yields a static (or zero) value there, so use a static column for line/polygon color.

### Lifecycle

Always dispose old styles when swapping — `renderer.setStyle()` handles this automatically. Call `compiledStyle.disposeGPU()` if managing styles manually.

### Key Implementation Files

- `lib/packages/core/src/styles/StyleEngine.js`
- `lib/packages/core/src/styles/RampCompiler.js`
- `lib/packages/core/src/styles/CategoricalCompiler.js`
- `lib/packages/core/src/ui/SymbologyDialog.js`
- `lib/packages/core/src/ui/H3SymbologyDialog.js`
- `lib/packages/core/src/ui/LineSymbologyDialog.js`
- `lib/packages/core/src/ui/PolygonSymbologyDialog.js`
- `lib/packages/core/src/ui/LegendPanel.js`
- `lib/packages/core/src/ui/styles.js` (CSS-in-JS for all UI)
