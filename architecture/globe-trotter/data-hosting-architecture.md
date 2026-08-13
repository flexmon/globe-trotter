# Data Hosting Architecture — Serving H3F/GFB to Web Clients

> How to serve 1+ GB binary geodata files to many concurrent web clients with minimum latency and maximum throughput — using only a managed GCS bucket behind Cloud CDN, with zero middleware.

## Table of Contents

1. [The Problem](#1-the-problem)
2. [Architecture: Private CDN (Recommended)](#2-architecture-private-cdn-recommended)
3. [Options Compared](#3-options-compared)
4. [Security Layers](#4-security-layers)
5. [Setup Guide](#5-setup-guide)
6. [Data Update Workflow](#6-data-update-workflow)
7. [Implementation Details](#7-implementation-details)

---

## 1. The Problem

Globe Trotter's binary files have specific delivery characteristics that heavily influence the best hosting strategy:

| File                    | Size                   | Access Pattern                               | Update Frequency      |
| ----------------------- | ---------------------- | -------------------------------------------- | --------------------- |
| `dataset.manifest.json` | ~1 KB                  | Fetched once on page load                    | When data regenerated |
| `base.h3f`              | ~32 MB                 | Fetched once on page load, mesh + static     | When data regenerated |
| `epoch-*.bin`           | ~39 MB each (4 shards) | Fetched on demand during playback            | When data regenerated |
| `tracks.gfb`            | ~34 MB                 | Fetched once on page load, consumed entirely | When data regenerated |

**Key requirements:**

- **Fast time-to-interactive** — users wait for the full download before the globe renders data
- **Concurrent users** — potentially hundreds of simultaneous loads
- **Binary-native** — files are `ArrayBuffer`s consumed via `fetch()`, not parsed as text
- **Immutable per deployment** — files change only when new data is generated, not per-request
- **No middleware** — no proxy pods, no application servers, no compute in the data path

---

## 2. Architecture: Private CDN (Recommended)

**Principle:** Manage a bucket of data. Let GCP handle everything else — CDN caching, TLS termination, authentication, and edge delivery. No proxy pods, no compute, no middleware in the hot path.

### Logical Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Google Cloud Platform                            │
│                                                                          │
│  ┌──────────────────┐                                                    │
│  │ Data Pipeline    │    GCS Client Library                              │
│  │ (generate/upload)│    (service account)     ┌──────────────────────┐  │
│  │                  │─────────────────────────►│                      │  │
│  └──────────────────┘                          │  GCS Private Bucket  │  │
│                                                │  (no public access)  │  │
│                                                │                      │  │
│                                                │  /data/              │  │
│                                                │    *.manifest.json   │  │
│                                                │    *_base.shard      │  │
│                                                │    *_e*.bin.gz       │  │
│                                                │    *.shard           │  │
│                                                └──────────┬───────────┘  │
│                                                           │              │
│                          HMAC Authentication              │              │
│                          (origin-facing only)             │              │
│                                                           │              │
│                                                ┌──────────┴───────────┐  │
│                                                │  Internet NEG        │  │
│                                                │  (bucket.storage.    │  │
│                                                │   googleapis.com)    │  │
│                                                └──────────┬───────────┘  │
│                                                           │              │
│                                                ┌──────────┴───────────┐  │
│                                                │  Backend Service     │  │
│                                                │  + Cloud CDN         │  │
│                                                │  (configurable TTL)  │  │
│                                                └──────────┬───────────┘  │
│                                                           │              │
│                                                ┌──────────┴───────────┐  │
│                                                │  Global HTTPS        │  │
│                                                │  Load Balancer       │  │
│                                                │  + Managed TLS Cert  │  │
│                                                └──────────┬───────────┘  │
│                                                           │              │
│                                                ┌──────────┴───────────┐  │
│                                                │  Identity-Aware      │  │
│                                                │  Proxy (IAP)         │  │
│                                                │  ● Google Workspace  │  │
│                                                │  ● Group-based ACL   │  │
│                                                │  ● No VPN required   │  │
│                                                └──────────┬───────────┘  │
│                                                           │              │
└───────────────────────────────────────────────────────────┼──────────────┘
                                                            │
                              Corporate Network / BeyondCorp / Public Internet
                                                            │
                          ┌─────────────────────────────────┼─────────────────┐
                          │                                 │                 │
                   ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐
                   │ Globe       │  │ Globe       │  │ Globe       │
                   │ Trotter     │  │ Trotter     │  │ Trotter     │
                   │ Client 1    │  │ Client 2    │  │ Client N    │
                   │ fetch()     │  │ fetch()     │  │ fetch()     │
                   └─────────────┘  └─────────────┘  └─────────────┘
```

### Why This Architecture Wins

| Factor                      | Benefit                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Zero middleware**         | No proxy pods, no application servers — GCS serves files directly through CDN                         |
| **Edge caching**            | Cloud CDN's 180+ global PoPs deliver 10–30ms TTFB from local cache                                    |
| **Private by default**      | Bucket has no public access — HMAC keys exist only in the backend service config                      |
| **Corporate auth**          | IAP enforces Google Workspace identity + group membership before any data is served. No VPN required. |
| **Unlimited scale**         | GCS handles unlimited concurrent reads — no pod scaling concerns                                      |
| **Transparent compression** | CDN serves pre-compressed gzipped files — 1.1 GB → ~400 MB over the wire                              |
| **Same-origin**             | App and data share a single hostname → no CORS configuration needed                                   |
| **Configurable TTL**        | CDN cache TTL tunable per use case: `86400s` for batch data, `2s` for streaming                       |
| **Cost**                    | No compute — you pay only for storage + CDN egress (~$0.02–0.08/GB)                                   |

---

## 3. Options Compared

| Approach                                     | TTFB  | Scale | Middleware | Auth       | Cost             | Verdict                |
| -------------------------------------------- | ----- | ----- | ---------- | ---------- | ---------------- | ---------------------- |
| **Private CDN (GCS + Cloud CDN + LB + IAP)** | ★★★★★ | ★★★★★ | None       | IAP + HMAC | Low              | **✅ Recommended**     |
| **GCS Direct** (no CDN)                      | ★★★   | ★★★★★ | None       | IAM only   | Lowest           | Dev/staging only       |
| **REST API Server**                          | ★★    | ★★    | Pod fleet  | Custom     | High             | ❌ Anti-pattern        |
| **Static Site Host** (Vercel/Netlify)        | ★★★★  | ★★★   | None       | None       | Free tier limits | ❌ Size limits (50 MB) |
| **Self-hosted Nginx**                        | ★★★   | ★★    | VM fleet   | Custom     | Medium           | ❌ Legacy only         |

> [!CAUTION]
> **Do not use a REST API to proxy static binary files.** This adds latency, compute cost, and failure modes while providing zero benefit for immutable datasets. If you need authentication, add it at the load balancer level (IAP, signed URLs, or signed cookies).

---

## 4. Security Layers

```
Browser request flow:

  ① Browser sends fetch() with IAP session cookie
  ② IAP validates Google identity + group membership
     ✗ Unauthorized → 403 (never reaches CDN)
     ✓ Authorized → forward to backend
  ③ Cloud CDN checks edge cache
     HIT  → return cached binary (no origin contact)
     MISS → forward to origin
  ④ Backend Service signs request with HMAC key
  ⑤ GCS validates HMAC → returns private object
  ⑥ CDN caches response (configurable TTL) → return to browser
```

**No public access at any layer.** The bucket has no public permissions. HMAC keys exist only in the backend service config. IAP enforces corporate identity before any data is served.

### GCP Resource Summary

| Resource                     | Purpose                                               | Config                                                    |
| ---------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| **GCS Bucket**               | Stores binary data files                              | Uniform bucket IAM, no `allUsers`, optional lifecycle TTL |
| **Service Account (upload)** | Pipeline writes to bucket                             | `roles/storage.objectCreator`                             |
| **Service Account (CDN)**    | CDN reads from bucket via HMAC                        | `roles/storage.objectViewer`, HMAC keys                   |
| **Internet NEG**             | Points CDN backend to `bucket.storage.googleapis.com` | FQDN endpoint                                             |
| **Backend Service**          | CDN caching layer                                     | Cache mode: `FORCE_CACHE_ALL`, configurable TTL           |
| **Cloud CDN**                | Edge caching, global PoPs                             | 180+ edge locations, gzip passthrough                     |
| **HTTPS Load Balancer**      | TLS termination, URL routing                          | Managed cert, path-based routing                          |
| **IAP**                      | Corporate authentication                              | Google Workspace groups, OAuth 2.0, no VPN                |

---

## 5. Setup Guide

### Step 1: Create a private GCS bucket

```bash
# Create bucket — NO public access
gsutil mb -l us-central1 -b on gs://globe-trotter-data

# Verify no public access
gsutil iam get gs://globe-trotter-data
# Should show NO allUsers or allAuthenticatedUsers
```

### Step 2: Upload data with compression headers

```bash
# Upload sharded H3F files
for f in dataset.manifest.json base.shard epoch-*.bin.gz; do
    gsutil -h "Content-Encoding:gzip" \
           -h "Content-Type:application/octet-stream" \
           -h "Cache-Control:public, max-age=86400" \
           cp public/data/$f gs://globe-trotter-data/data/$f
done

# Upload GFB files
gsutil -h "Content-Encoding:gzip" \
       -h "Content-Type:application/octet-stream" \
       -h "Cache-Control:public, max-age=86400" \
       cp public/data/tracks.shard gs://globe-trotter-data/data/tracks.gfb
```

> [!IMPORTANT]
> **Upload the `.gz` file but name it WITHOUT the `.gz` extension** (or set `Content-Encoding: gzip` on the object). This lets browsers decompress transparently.

### Step 3: Create CDN service account + HMAC keys

```bash
# Create a service account for CDN origin access
gcloud iam service-accounts create globe-trotter-cdn \
    --display-name="Globe Trotter CDN Origin"

# Grant read access to the bucket
gsutil iam ch \
    serviceAccount:globe-trotter-cdn@PROJECT_ID.iam.gserviceaccount.com:objectViewer \
    gs://globe-trotter-data

# Create HMAC keys for the service account
gsutil hmac create globe-trotter-cdn@PROJECT_ID.iam.gserviceaccount.com
# Save the access_id and secret — needed for backend service config
```

### Step 4: Create the Internet NEG + Backend Service + CDN

```bash
# Internet NEG pointing to GCS
gcloud compute network-endpoint-groups create globe-trotter-neg \
    --network-endpoint-type=internet-fqdn-port \
    --default-port=443 \
    --global

gcloud compute network-endpoint-groups update globe-trotter-neg \
    --add-endpoint="fqdn=storage.googleapis.com,port=443" \
    --global

# Backend Service with Cloud CDN enabled
gcloud compute backend-services create globe-trotter-data-backend \
    --protocol=HTTPS \
    --global \
    --enable-cdn \
    --cache-mode=FORCE_CACHE_ALL \
    --default-ttl=86400 \
    --custom-request-header="Host: storage.googleapis.com"

gcloud compute backend-services add-backend globe-trotter-data-backend \
    --network-endpoint-group=globe-trotter-neg \
    --global \
    --global-network-endpoint-group
```

### Step 5: Create Global HTTPS Load Balancer

```bash
# Reserve a static IP
gcloud compute addresses create globe-trotter-ip --global

# Create a managed TLS certificate
gcloud compute ssl-certificates create globe-trotter-cert \
    --domains=globe-trotter.example.com \
    --global

# URL map with path-based routing
gcloud compute url-maps create globe-trotter-lb \
    --default-service=globe-trotter-app-backend

gcloud compute url-maps add-path-matcher globe-trotter-lb \
    --path-matcher-name=data-matcher \
    --default-service=globe-trotter-app-backend \
    --backend-service-path-rules="/data/*=globe-trotter-data-backend"

# HTTPS proxy + forwarding rule
gcloud compute target-https-proxies create globe-trotter-proxy \
    --url-map=globe-trotter-lb \
    --ssl-certificates=globe-trotter-cert

gcloud compute forwarding-rules create globe-trotter-fwd \
    --global \
    --address=globe-trotter-ip \
    --target-https-proxy=globe-trotter-proxy \
    --ports=443
```

### Step 6: Enable IAP

```bash
# Enable IAP on the backend service
gcloud iap web enable \
    --resource-type=backend-services \
    --service=globe-trotter-data-backend

# Grant access to a Google Workspace group
gcloud iap web add-iam-policy-binding \
    --resource-type=backend-services \
    --service=globe-trotter-data-backend \
    --member="group:globe-trotter-users@example.com" \
    --role="roles/iap.httpsResourceAccessor"
```

### Path-Based Routing

The load balancer splits traffic by URL path — the app and its data share a single hostname:

| Path      | Backend                                | Type |
| --------- | -------------------------------------- | ---- |
| `/`       | App backend (GKE Service or Cloud Run) | App  |
| `/data/*` | CDN backend (GCS via Internet NEG)     | Data |

```javascript
// In app.js — same-origin, no CORS needed
const DATA_LAYERS = [
  { name: 'Dataset', type: 'h3f-sharded', url: '/data/dataset.manifest.json' },
  { name: 'Aircraft Tracks', type: 'gfb', url: '/data/tracks.gfb' },
];
```

> [!IMPORTANT]
> **Same-origin serving eliminates CORS entirely.** Since `/data/*` is on the same hostname as the app, `fetch()` does not require CORS headers, preflight requests, or any cross-origin configuration.

---

## 6. Data Update Workflow

When new H3F/GFB files are generated (e.g., daily from a BigQuery pipeline):

```bash
# Overwrite with new data — CDN picks it up after TTL expires
gsutil -h "Content-Encoding:gzip" \
       -h "Content-Type:application/octet-stream" \
       -h "Cache-Control:public, max-age=86400" \
       cp new_base.shard gs://globe-trotter-data/data/base.h3f
```

For instant client updates, use versioned paths (`/data/v2/`) or invalidate the CDN cache:

```bash
# CDN cache invalidation (takes ~10s to propagate globally)
gcloud compute url-maps invalidate-cdn-cache globe-trotter-lb \
    --path="/data/*"
```

### Streaming Use Case

For real-time data, set CDN TTL to `2s` and use the streaming manifest pattern. See [Streaming Architecture](streaming-architecture.md) for details.

```bash
# Override TTL for streaming paths
gcloud compute backend-services update globe-trotter-data-backend \
    --default-ttl=2 \
    --global
```

---

## 7. Implementation Details

### 7.1 Temporal Sharding (Implemented)

H3F files are sharded into a **base file** + **temporal shards** loaded on demand:

```
/data/dataset.manifest.json   ← Shard index (1 KB)
/data/base.h3f               ← Mesh + static attrs (32 MB, fetched once)
/data/epoch-000-059.bin      ← Temporal shard (39 MB, loaded during playback)
/data/epoch-060-119.bin
/data/epoch-120-179.bin
/data/epoch-180-239.bin
```

Initial load drops from 189 MB to **71 MB** (manifest + base + first shard). Remaining shards are pre-fetched during playback. See [H3Flex Architecture § 12](h3flex-binary-architecture.md#12-temporal-sharding--breaking-the-2-gb-browser-limit) for full details.

### 7.2 Spatial Tiling (Planned)

For global-scale 24h data, spatial partitioning by H3 res-2 parent creates viewport-dependent tiles:

```
/data/tiles/tile_820a7ff/base.h3f    ← North America cells only
/data/tiles/tile_820a7ff/e000-e059.bin
/data/tiles/tile_821abff/base.h3f    ← Europe cells only
/data/tiles/tile_821abff/e000-e059.bin
```

The client loads only tiles visible in the camera frustum. Combined with temporal sharding, each file stays under ~50 MB while supporting unlimited total data volume.

### 7.3 Versioned URLs

Use versioned paths for aggressive caching with instant invalidation:

```javascript
const DATA_LAYERS = [
  { name: 'Dataset', type: 'h3f-sharded', url: `/data/v1/dataset.manifest.json` },
  { name: 'Aircraft Tracks', type: 'gfb', url: `/data/v1/tracks.gfb` },
];
```

### 7.4 Cost Estimate

| Component                          | Monthly Cost (500 users/day) |
| ---------------------------------- | ---------------------------- |
| GCS Storage (1.5 GB)               | ~$0.03                       |
| GCS Operations (~15K GET/day × 30) | ~$2                          |
| Global HTTPS LB (forwarding rule)  | ~$18                         |
| Cloud CDN (cache fills + egress)   | ~$15–50                      |
| IAP                                | Free (included with LB)      |
| **Total**                          | **~$35–70/month**            |

> [!NOTE]
> Cost scales linearly with CDN egress. Pre-compression reduces egress by ~65%, saving $20–40/month at 500 users/day.

### 7.5 CORS Configuration (cross-origin CDN only)

If serving data from a separate domain (not recommended), configure CORS on the bucket:

```bash
gsutil cors set cors.json gs://globe-trotter-data
```

```json
[
  {
    "origin": ["*"],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Content-Type", "Content-Encoding", "Content-Length", "Accept-Ranges"],
    "maxAgeSeconds": 86400
  }
]
```

> [!TIP]
> **Prefer same-origin serving** (path-based routing on a single hostname) to avoid CORS entirely. Cross-origin setups add complexity and preflight overhead for every `fetch()` request.
