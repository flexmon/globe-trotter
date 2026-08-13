#!/usr/bin/env node
/**
 * render-60-frames.mjs — WebGPU frame-time benchmark / perf trip-wire (A-6).
 *
 * Loads the running dev app in headless Chromium (WebGPU), samples N rendered
 * frames via the engine's `frame` event, and prints p50/p95/mean frame time.
 * Use it to catch perf regressions from refactors (e.g. the renderer changes
 * in Track C, worker decoding in E-12).
 *
 * Prerequisites:
 *   1. Dev server running:   npm run dev         (defaults to http://localhost:5173/)
 *   2. Playwright available:  npm i -D playwright && npx playwright install chromium
 *
 * Usage:
 *   node bench/render-60-frames.mjs [url]
 *   BENCH_URL=http://localhost:5173/?globeconf=/catalog/foo.yaml BENCH_FRAMES=120 node bench/render-60-frames.mjs
 *
 * Reference baseline (M-series laptop, default demo-catalog):
 *   ~60 frames · p50 ≈ 13.5 ms (74 FPS) · p95 ≈ 16.8 ms   [post Track C, 2026-06]
 * Treat a p50/p95 regression > ~10% vs your local baseline as a red flag.
 */

const URL = process.env.BENCH_URL || process.argv[2] || 'http://localhost:5173/';
const FRAMES = Number(process.env.BENCH_FRAMES || 60);

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('[bench] playwright is not installed.');
  console.error('        Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

// Frame sampler injected into the page. Hooks the engine `frame` event (emitted
// per non-stationary render) and records inter-frame intervals.
async function sampleFrames(n) {
  const t0 = performance.now();
  while (!window.globe && performance.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const g = window.globe;
  if (!g) return { error: 'window.globe not ready (engine failed to init — WebGPU available?)' };

  const times = [];
  await new Promise((resolve) => {
    let last = performance.now();
    const handler = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      if (times.length >= n) {
        g.off('frame', handler);
        resolve();
      }
    };
    g.on('frame', handler);
    setTimeout(resolve, Math.max(8000, n * 50)); // safety timeout
  });

  if (times.length < 2) return { error: `only ${times.length} frame(s) captured` };
  times.sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return {
    frames: times.length,
    p50_ms: +pct(0.5).toFixed(2),
    p95_ms: +pct(0.95).toFixed(2),
    mean_ms: +mean.toFixed(2),
    fps_p50: +(1000 / pct(0.5)).toFixed(1),
  };
}

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  console.log(`[bench] loading ${URL} …`);
  await page.goto(URL, { waitUntil: 'load' });

  const r = await page.evaluate(sampleFrames, FRAMES);
  if (r.error) {
    console.error(`[bench] FAILED: ${r.error}`);
    if (consoleErrors.length)
      console.error('[bench] console errors:\n  ' + consoleErrors.slice(0, 5).join('\n  '));
    process.exitCode = 1;
  } else {
    console.log(`[bench] ${r.frames} frames @ ${URL}`);
    console.log(`        p50  ${r.p50_ms} ms   (${r.fps_p50} FPS)`);
    console.log(`        p95  ${r.p95_ms} ms`);
    console.log(`        mean ${r.mean_ms} ms`);
  }
} finally {
  await browser.close();
}
