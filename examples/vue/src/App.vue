<template>
  <canvas ref="canvasRef" class="globe-canvas" />
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { GlobeTrotterEngine } from '@globe-trotter/core';
import config, { mapboxToken, googleMapsApiKey } from '../../globe-config.js';

const canvasRef = ref(null);
let engine = null;

onMounted(async () => {
  engine = new GlobeTrotterEngine(canvasRef.value, {
    mapboxToken,
    googleMapsApiKey,
    basePath: '/globe-trotter/',
    camera: { center: [39.0, -98.0], altitude: 12000 },
    time: { enabled: true, autoplay: true, speed: 60 },
    ui: true,
    uiWidgets: {
      footer: true, layers: true, geocoder: true, time: true,
      loadingScreen: {
        logoUrl: `${import.meta.env.BASE_URL}assets/example-logo.svg`,
        iconUrl: `${import.meta.env.BASE_URL}assets/example-icon.svg`,
        subtitle: 'Vue Example',
      },
    },
  });

  await engine.loadConfig(config);
  window.globe = engine;
});

onUnmounted(() => {
  engine?.destroy();
});
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
.globe-canvas { width: 100vw; height: 100vh; display: block; }
</style>
