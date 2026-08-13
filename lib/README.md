# Globe-Trotter Library

GPU-accelerated 4D globe rendering engine — framework-agnostic core with Vue and React wrappers.

## Packages

| Package                | Description                           |
| ---------------------- | ------------------------------------- |
| `@globe-trotter/core`  | Framework-agnostic engine (ESM + UMD) |
| `@globe-trotter/vue`   | Vue 3 component                       |
| `@globe-trotter/react` | React 18/19 component                 |

## Quick Start

### Vanilla HTML

```html
<canvas id="globe" style="width:100vw;height:100vh"></canvas>
<script type="module">
  import { GlobeTrotterEngine, StyleEngine } from '@globe-trotter/core';

  const globe = new GlobeTrotterEngine(document.getElementById('globe'), {
    mapboxToken: 'pk.xxx',
  });

  await globe.addLayer('Demand', 'h3f', '/data/demand_metrics.h3f');

  globe.setView({ lat: 39.8, lon: -98.5, distance: 2.5 });
  globe.play();

  // Change style at runtime
  globe.setLayerStyle(
    'Demand',
    StyleEngine.ramp({
      attribute: 'demand_mbps',
      domain: [0, 100],
      stops: ['#000033', '#0066FF', '#FFFFFF'],
    })
  );
</script>
```

### Vue.js

```vue
<template>
  <GlobeTrotter
    :mapbox-token="token"
    :layers="layers"
    :view="{ lat: 39.8, lon: -98.5, distance: 2.5 }"
    :speed="10"
    @frame="onFrame"
    @ready="onReady"
  />
</template>

<script setup>
import { GlobeTrotter } from '@globe-trotter/vue';

const token = 'pk.xxx';
const layers = [{ name: 'Demand', type: 'h3f', url: '/data/demand_metrics.h3f' }];

function onReady(engine) {
  console.log('Globe ready!', engine);
}

function onFrame({ fps }) {
  // Update HUD
}
</script>
```

### React.js

```jsx
import { GlobeTrotter } from '@globe-trotter/react';
import { useRef, useCallback } from 'react';

function App() {
  const globeRef = useRef();

  const onReady = useCallback((engine) => {
    console.log('Globe ready!', engine);
  }, []);

  return (
    <GlobeTrotter
      ref={globeRef}
      mapboxToken="pk.xxx"
      layers={[{ name: 'Demand', type: 'h3f', url: '/data/demand_metrics.h3f' }]}
      view={{ lat: 39.8, lon: -98.5, distance: 2.5 }}
      speed={10}
      onReady={onReady}
      onFrame={({ fps }) => console.log(fps)}
    />
  );
}
```

## API Reference

### `GlobeTrotterEngine(canvas, options)`

| Option        | Type       | Default                    | Description            |
| ------------- | ---------- | -------------------------- | ---------------------- |
| `mapboxToken` | `string`   | `null`                     | Mapbox access token    |
| `basemap`     | `string`   | `'satellite-v9'`           | Mapbox style ID        |
| `antialias`   | `boolean`  | `true`                     | WebGL antialiasing     |
| `background`  | `number[]` | `[0.008, 0.016, 0.032, 1]` | Clear color            |
| `maxDpr`      | `number`   | `2`                        | Max device pixel ratio |
| `autoStart`   | `boolean`  | `true`                     | Auto-start render loop |

### Data Layers

```javascript
await globe.addLayer(name, type, url, options?)
globe.removeLayer(name)
globe.setLayerStyle(name, styleSpec)
```

### Camera

```javascript
globe.setView({ lat, lon, distance });
globe.getView(); // → { lat, lon, distance }
```

### Time

```javascript
globe.play();
globe.pause();
globe.togglePlay(); // → boolean
globe.setSpeed(10);
globe.scrubTo(0.5); // 0..1
```

### Events

```javascript
globe.on('frame', ({ fps, drawCalls, features }) => {});
globe.on('layerAdded', ({ name, type }) => {});
globe.on('layerRemoved', ({ name }) => {});
```

### Styling

```javascript
import { StyleEngine } from '@globe-trotter/core';

// Color ramp
StyleEngine.ramp({ attribute, domain, stops, opacity })

// Categorical
StyleEngine.categorical({ attribute, categories, default, opacity })

// Multi-attribute
StyleEngine.multi({ color, opacity, size, width })
```

## Building

```bash
cd packages/core
npm install
npm run build
# Outputs: dist/globe-trotter.es.js + dist/globe-trotter.umd.js
```
