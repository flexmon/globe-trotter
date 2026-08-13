---
name: globe-trotter-deploy
description: Deployment patterns for Globe Trotter — static hosting, GKE, CDN, shard serving, Mapbox token management, library builds, and production configuration.
---

# Globe Trotter Deployment

Deployment patterns for serving Globe Trotter applications and data in production.

## When to use this skill

- Use this when deploying Globe Trotter to production (GKE, cloud storage, CDN)
- Use this when publishing data or configs to the private CDN
- Use this when configuring CORS headers, caching, or compression for data files
- Use this when managing Mapbox tokens for different environments
- Use this when building the library or SPA for external consumption

## Private CDN Architecture

### Bucket Layout

```
GCS Bucket: $GCS_BUCKET (from .env)
CDN Host:   $GCS_CDN_HOST (from .env)

/globe-trotter/
  web/                          ← SPA (globe-trotter.html)
  catalog/                      ← YAML configs (one per dataset)
    demo-catalog.yaml
    [dataset-name].yaml
  data/
    [dataset-name]/             ← Binary data per dataset
      *.manifest.json           ← Layer manifests
      *_base.{h3f,gfb,mfb}.gz  ← Base files (static attributes)
      *_mesh.h3f.gz             ← Mesh files (H3F geometry)
      *_e*.bin.gz               ← Temporal shards
  meshes/                       ← Shared H3 meshes (one per resolution, 7-day cache)
    h3-l5/                      ← Tiled H3M2 mesh (122 tiles, viewport-selective)
      tiles.manifest.json       ← Tile index + bounds
      r000..r121.mesh.h3f.gz    ← Individual tile files (~1.86MB each)
    h3-l5-global.mesh.h3f.gz   ← Legacy monolithic mesh (157MB, fallback)
  textures/                     ← Globe textures
    blue_marble.jpg
    blue_marble_8k.jpg
    earth_elevation.jpg
```

### URL Structure

| Environment | App URL                                                   | Config parameter                                |
| ----------- | --------------------------------------------------------- | ----------------------------------------------- |
| **CDN**     | `https://<CDN_HOST>/globe-trotter/web/globe-trotter.html` | `?globeconf=/globe-trotter/catalog/[name].yaml` |
| **Local**   | `http://localhost:5173/`                                  | `?globeconf=/catalog/[name].yaml`               |

Both use the same directory structure — CDN just adds the `/globe-trotter` bucket prefix.

### Infrastructure

- **Cloud CDN** with GCS Backend Bucket (Internet NEG)
- **Global HTTPS Load Balancer** with **IAP** (Identity-Aware Proxy)
- **URL Map**: `cdn-proxy-url-map`
- **Project**: `$GCP_PROJECT` (from `.env`)

### SPA Build

```bash
SINGLE=true npm run build    # → dist/globe-trotter.html (single-file SPA, ~630KB)
```

The SPA auto-detects `basePath` from the page URL:

- CDN (`/globe-trotter/web/globe-trotter.html`) → `basePath = /globe-trotter/`
- Local (`/`) → `basePath = /`

### Auto-Decompression

The sharded loaders (`H3FlexShards`, `GFBShards`) include `maybeDecompress()` (from `util/compression.js`) — auto-detects gzip magic bytes (`0x1F 0x8B`) and decompresses via `DecompressionStream`. This ensures CDN serving works regardless of whether GCS sets `Content-Encoding: gzip`.

### Optimal GCS Object Headers

| File type                        | Content-Encoding | Cache-Control                         |
| -------------------------------- | ---------------- | ------------------------------------- |
| `*.gz` (data shards, base files) | `gzip`           | `public, max-age=86400`               |
| `*.manifest.json`                | (none)           | `public, max-age=3600`                |
| `*.yaml` (catalog configs)       | (none)           | `no-cache, no-store, must-revalidate` |
| `*.html` (SPA)                   | (none)           | `no-cache, no-store, must-revalidate` |
| `*.jpg` (textures)               | (none)           | `public, max-age=86400`               |

### CDN Cache Invalidation

```bash
gcloud compute url-maps invalidate-cdn-cache cdn-proxy-url-map \
  --path="/globe-trotter/[path]" \
  --project=$GCP_PROJECT
```

Propagation takes 1-2 minutes. Use `no-cache` headers on mutable files (SPA, configs) to avoid needing invalidation.

### Publishing Workflow

Deploy the SPA, catalog, data, meshes, and/or textures to the GCS CDN using targeted partial deployments, or a full stack push.

## How to use it

### Build for Production

```bash
npm run build   # Vite production build → dist/
```

### Single-Page Application Build

```bash
SINGLE=true npm run build   # → dist/globe-trotter.html (all JS/CSS inlined)
```

### Library Build (Versioned)

Build the core library as ES and UMD modules for external consumption:

```bash
npm run build:lib   # → dist/globe-trotter/
```

### Framework Wrappers

- **Vue**: `lib/packages/vue/` — Vue 3+ component wrapper
- **React**: `lib/packages/react/` — React component wrapper

Both wrap `GlobeTrotterEngine` and expose it as a framework-native component.

### Static Hosting (Nginx)

```nginx
server {
    listen 80;
    root /var/www/globe-trotter/dist;
    location / { try_files $uri $uri/ /index.html; }
    location /data/ {
        types { application/octet-stream h3f gfb; }
        add_header Cache-Control "public, max-age=86400";
        add_header Access-Control-Allow-Origin "*";
    }
}
```

### GKE Deployment

```dockerfile
FROM nginx:alpine
COPY dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

### Mapbox Token Security

1. Create a scoped token on mapbox.com restricted to your domain
2. Only grant `styles:tiles` and `styles:read` scopes
3. Build with production token: `VITE_MAPBOX_TOKEN=$PROD_TOKEN npm run build`

### Performance Tips

- Enable `Content-Encoding: gzip` on GCS objects for native browser decompression
- Use HTTP/2 (enabled by default on Cloud CDN) for parallel shard loading
- Set `Cache-Control: public, max-age=86400` on immutable data files
- Set `no-cache` on mutable files (SPA, catalog configs)
- First load is network-bound; subsequent loads are instant from browser cache

### Key Build Files

- Root build config: `vite.config.js`
- Library build script: `scripts/build-lib.js`
- Core package: `lib/packages/core/package.json`
- Vue wrapper: `lib/packages/vue/package.json`
