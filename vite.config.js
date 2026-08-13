import { defineConfig } from 'vite';
import { resolve, sep } from 'path';
import { createReadStream, existsSync, statSync } from 'fs';
import { viteSingleFile } from 'vite-plugin-singlefile';
const BASE = './';
const isSingle = process.env.SINGLE === 'true';

const PUBLIC_DIR = resolve(__dirname, 'public');
function safePublicResolve(urlPath) {
  const p = resolve(PUBLIC_DIR, urlPath.replace(/^\//, ''));
  return p.startsWith(PUBLIC_DIR + sep) || p === PUBLIC_DIR ? p : null;
}

/**
 * Vite plugin: serves pre-compressed .gz data files with Content-Encoding: gzip.
 * The browser transparently decompresses, so no client code changes needed.
 *
 * This is an order of magnitude more efficient than on-the-fly compression:
 *   - Zero CPU at serve time (just stream a file)
 *   - 325 MB raw shards → ~9.5 MB .gz on disk
 */
function servePreCompressed() {
  // File extensions that should be served directly from public/ (bypass SPA fallback)
  const DATA_EXTENSIONS = ['.mfb', '.h3f', '.gfb', '.manifest.json'];

  return {
    name: 'serve-pre-compressed',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        // Reject path traversal attempts
        if (req.url.includes('..')) return next();

        // Strip base path prefix when resolving file on disk
        const urlPath = req.url.replace(BASE, '/').replace(/^\/\//, '/');
        const filePath = safePublicResolve(urlPath);
        if (!filePath) return next();

        // Handle .gz files with Content-Encoding: gzip
        if (req.url.endsWith('.gz')) {
          const acceptEncoding = req.headers['accept-encoding'] || '';
          if (!acceptEncoding.includes('gzip')) return next();
          if (!existsSync(filePath)) return next();

          const stat = statSync(filePath);
          const baseUrl = urlPath.replace(/\.gz$/, '');
          let contentType = 'application/octet-stream';
          if (baseUrl.endsWith('.json')) contentType = 'application/json';

          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Content-Length', stat.size);
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Vary', 'Accept-Encoding');
          res.statusCode = 200;

          createReadStream(filePath).pipe(res);
          return;
        }

        // Handle binary data files (bypass SPA fallback)
        const isDataFile = DATA_EXTENSIONS.some((ext) => req.url.endsWith(ext));
        if (isDataFile && existsSync(filePath)) {
          const stat = statSync(filePath);
          let contentType = 'application/octet-stream';
          if (req.url.endsWith('.json')) contentType = 'application/json';

          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Length', stat.size);
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.statusCode = 200;

          createReadStream(filePath).pipe(res);
          return;
        }

        next();
      });
    },
  };
}

/**
 * Vite plugin: proxies /data/* requests to GCS buckets using ADC.
 * This lets the web app fetch streaming data from the same domain
 * (e.g. /data/ndr-flight-tracks/...) locally, matching production
 * where the CDN/load-balancer serves these paths from GCS backend buckets.
 *
 * Configuration:
 *   GCS_BUCKET env var overrides the default bucket name.
 *   Routes: /data/{dataset}/* → gs://{bucket}/data/{dataset}/*
 */
function gcsProxy() {
  let storage = null;
  const BUCKET = process.env.GCS_BUCKET || 'globe-trotter';

  return {
    name: 'gcs-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // ── /data-list/ prefix: list GCS objects by prefix (JSON array) ──
        if (req.url?.startsWith('/data-list/')) {
          const prefix = req.url.replace('/data-list/', 'data/').split('?')[0];
          if (!storage) {
            const { Storage } = await import('@google-cloud/storage');
            storage = new Storage();
          }

          try {
            const [files] = await storage.bucket(BUCKET).getFiles({ prefix, maxResults: 200 });
            const names = files.map((f) => f.name.replace(/^data\//, '/data/'));
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-cache');
            res.statusCode = 200;
            res.end(JSON.stringify(names));
          } catch (err) {
            console.error(`[gcs-proxy] List error: ${err.message}`);
            res.statusCode = 500;
            res.end(`Error listing: ${err.message}`);
          }
          return;
        }

        // ── /data/ prefix: proxy individual files ──
        if (!req.url || !req.url.startsWith('/data/')) return next();
        // Reject path traversal attempts
        if (req.url.includes('..')) return next();

        // Skip if the file exists locally in public/
        const urlPath = req.url.split('?')[0].replace(BASE, '/').replace(/^\/\//, '/');
        const localPath = safePublicResolve(urlPath);
        if (localPath && existsSync(localPath)) return next();

        // ── IMPORTANT: Do NOT call next() past this point ──
        // Vite's connect middleware doesn't await async handlers.
        // If we call next() anywhere below, the SPA fallback serves
        // index.html before the GCS response arrives.
        // Instead, we handle the entire response here (sync claim, async body).

        // Lazy-init storage client (uses ADC: gcloud auth application-default login)
        if (!storage) {
          const { Storage } = await import('@google-cloud/storage');
          storage = new Storage();
        }

        // Map URL path to GCS object path (strip leading /)
        const gcsPath = urlPath.replace(/^\//, '');
        const file = storage.bucket(BUCKET).file(gcsPath);

        try {
          const [exists] = await file.exists();
          if (!exists) {
            // 204 No Content — semantically "request OK, but nothing here".
            // Chrome only logs red console errors for 4xx/5xx, so 204
            // keeps the DevTools console clean during streaming shard polling.
            res.statusCode = 204;
            res.end();
            return;
          }

          const [metadata] = await file.getMetadata();
          const size = parseInt(metadata.size, 10);
          const isGzip = gcsPath.endsWith('.gz');

          // Content type
          let contentType = 'application/octet-stream';
          if (gcsPath.endsWith('.json') || gcsPath.endsWith('.json.gz'))
            contentType = 'application/json';
          if (gcsPath.endsWith('.yaml') || gcsPath.endsWith('.yaml.gz')) contentType = 'text/yaml';

          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Access-Control-Allow-Origin', '*');

          if (isGzip) {
            // Serve .gz with Content-Encoding so browser decompresses transparently
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Content-Length', size);
          }

          res.statusCode = 200;
          console.log(`[gcs-proxy] 200 gs://${BUCKET}/${gcsPath} (${(size / 1024).toFixed(1)} KB)`);

          file.createReadStream().pipe(res);
        } catch (err) {
          // If auth expired, drop the cached client so the next request
          // picks up freshly-refreshed ADC credentials from disk.
          const msg = err.message || '';
          if (
            msg.includes('invalid_rapt') ||
            msg.includes('invalid_grant') ||
            msg.includes('EAUTH')
          ) {
            console.warn(
              `[gcs-proxy] Auth expired — will re-init Storage client on next request. Run: gcloud auth application-default login`
            );
            storage = null;
          }
          console.error(`[gcs-proxy] Error: ${msg}`);
          res.statusCode = 502;
          res.end(`GCS proxy error: ${msg}`);
        }
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [servePreCompressed(), gcsProxy(), viteSingleFile({ inlinePattern: ['**/*'] })],
  resolve: {
    alias: {
      '@globe-trotter/core': resolve(__dirname, 'lib/packages/core/src/index.js'),
    },
  },
  server: {
    open: `${BASE}?globeconf=/catalog/demo-catalog.yaml`,
    proxy: {
      // FlexDB API proxy — forwards /api/* to remote FlexDB
      '/api': {
        target: process.env.FLEXDB_URL || 'http://localhost:8090',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    assetsInlineLimit: 100000000, // 100MB limit to force everything to base64
    copyPublicDir: !isSingle, // Prevent gigabytes of copy
  },
  assetsInclude: ['**/*.vert', '**/*.frag'],
});
