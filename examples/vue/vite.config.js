import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve, join } from 'path';
import { createReadStream, existsSync, statSync } from 'fs';

const ROOT = resolve(__dirname, '../..');
const DIST_BUNDLE = join(ROOT, 'dist', 'globe-trotter', 'globe-trotter.es.js');
const BASE = '/globe-trotter/';

/**
 * Vite plugin: serves pre-compressed .gz data files with Content-Encoding: gzip.
 */
function servePreCompressed() {
    return {
        name: 'serve-pre-compressed',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (!req.url || !req.url.endsWith('.gz')) return next();

                const acceptEncoding = req.headers['accept-encoding'] || '';
                if (!acceptEncoding.includes('gzip')) return next();

                // Strip base path prefix when resolving file on disk
                const urlPath = req.url.replace(BASE, '/').replace(/^\/\//, '/');
                const filePath = resolve(ROOT, 'public', urlPath.replace(/^\//, ''));
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
            });
        },
    };
}

/**
 * Vite plugin: serve static files from the project root's public/ directory.
 * Handles /data/ and /textures/ requests so no separate dev server is needed.
 */
function serveRootPublic() {
    return {
        name: 'serve-root-public',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (!req.url) return next();

                // Strip base path prefix
                const urlPath = req.url.replace(BASE, '/').replace(/^\/\//, '/');

                if (!urlPath.startsWith('/data/') && !urlPath.startsWith('/textures/') && !urlPath.startsWith('/assets/')) {
                    return next();
                }

                // Try root public/ first, then examples/assets/
                let filePath = resolve(ROOT, 'public', urlPath.replace(/^\//, ''));
                if (!existsSync(filePath) && urlPath.startsWith('/assets/')) {
                    filePath = resolve(ROOT, 'examples', urlPath.replace(/^\//, ''));
                }
                if (!existsSync(filePath)) return next();

                const stat = statSync(filePath);
                let contentType = 'application/octet-stream';
                if (req.url.endsWith('.json')) contentType = 'application/json';
                else if (req.url.endsWith('.png')) contentType = 'image/png';
                else if (req.url.endsWith('.jpg') || req.url.endsWith('.jpeg')) contentType = 'image/jpeg';
                else if (req.url.endsWith('.svg')) contentType = 'image/svg+xml';

                res.setHeader('Content-Type', contentType);
                res.setHeader('Content-Length', stat.size);
                res.statusCode = 200;

                createReadStream(filePath).pipe(res);
            });
        },
    };
}

if (!existsSync(DIST_BUNDLE)) {
    console.error('\n❌ No dist bundle found at dist/globe-trotter/.');
    console.error('   Run "npm run build:lib" from the project root first.\n');
    process.exit(1);
}

export default defineConfig({
    base: BASE,
    envDir: ROOT,
    plugins: [vue(), servePreCompressed(), serveRootPublic()],
    resolve: {
        alias: {
            '@globe-trotter/core': DIST_BUNDLE,
        },
    },
    server: {
        port: 5174,
        open: BASE,
    },
});
