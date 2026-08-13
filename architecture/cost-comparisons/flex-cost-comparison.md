# Flex Architecture Cost Comparison

> **TL;DR:** Globe Trotter + Flex formats costs **$149/month** where a traditional BigQuery + Kubernetes stack costs **$33,000–$45,000/month** — at the same 100-user workload. FlexStream processes a high-velocity telemetry stream for **$159/month** where an equivalent Flink on EKS pipeline costs **$6,348/month**.

---

## Executive Summary

| Comparison                                   | Traditional        | Flex Architecture | Savings  |
| -------------------------------------------- | ------------------ | ----------------- | -------- |
| Visualization (100 users/day, 5 dashboards)  | $33,372–$45,000/mo | **$97/mo**        | **344×** |
| Streaming pipeline (high-velocity telemetry) | $6,348/mo          | **$159/mo**       | **40×**  |
| Annual combined savings                      | ~$450,000–$590,000 | —                 | —        |

---

## Part 1: Visualization Cost — Globe Trotter vs Traditional Web GIS

**Dataset:** 543 million rows — 1,422,362 H3 cells × 1,440 epochs (H3F), 76,163 moving geometry features × 1,440 epochs (GFB), 76,163 metric entities × 1,440 epochs (MFB). All at 60-second intervals across a 24-hour period.

**User load:** 100 users/day, 300 map views/user/day, 100 custom SQL queries/user/day, 5 auto-refreshing dashboards.

### Architecture A: Traditional — BigQuery + Kubernetes REST API

```
┌──────────┐     REST/GeoJSON     ┌───────────────┐     SQL      ┌───────────┐
│  Web App │ ◄──────────────────► │  K8s REST API │ ◄──────────► │ BigQuery  │
│ (sidecar)│                      │ + Redis Cache │              │ (storage) │
└──────────┘                      └───────────────┘              └───────────┘
```

Every epoch transition → HTTP request → REST API → BQ query → GeoJSON response → JS parse → render. **Five layers, five cost centres.**

### Architecture B: Globe Trotter — Static SPA + CDN

```
┌──────────┐    CDN (binary shards)     ┌──────────────┐    origin     ┌────────┐
│  Web App │ ◄────────────────────────► │  Cloud CDN   │ ◄───────────► │  GCS   │
│ (static) │      .shd3 binary shards   │ (180+ PoPs)  │   cache fill  │ bucket │
└──────────┘                            └──────────────┘               └────────┘
     └──── All rendering is client-side (GPU). No middleware, no REST API, no BQ.
```

---

### Storage Cost

#### *Flex Binary on GCS

| Dataset                  | Format    | Files              | Size (.shd3) |
| ------------------------ | --------- | ------------------ | ------------ |
| H3 demand metrics        | H3F       | 1 base + 24 shards | **870 MB**   |
| Moving geometry features | GFB       | 1 base + 24 shards | **492 MB**   |
| Metric entities          | MFB       | 1 file             | **419 MB**   |
| Manifests + config       | JSON/YAML | ~5 files           | **< 1 MB**   |
| **Total**                |           | **78 files**       | **1.74 GB**  |

#### BigQuery Equivalent

| Dataset      | Rows     | Raw size    | BQ compressed (~8×) |
| ------------ | -------- | ----------- | ------------------- |
| H3F demand   | 323M     | 15.5 GB     | ~1.9 GB             |
| GFB features | 110M     | 5.4 GB      | ~0.7 GB             |
| MFB metrics  | 110M     | 3.6 GB      | ~0.5 GB             |
| **Total**    | **543M** | **24.5 GB** | **~3.1 GB**         |

|          | *_GCS (*Flex)*_                    | **BigQuery**                              |
| -------- | ---------------------------------- | ----------------------------------------- |
| Storage  | **$0.03/mo** (1.74 GB @ $0.020/GB) | $0.06/mo (3.1 GB)                         |
| Overhead | None — purpose-built binary        | Row metadata, partition index, clustering |

> Storage is negligible in both cases. The cost difference lives in queries, compute, and data transfer.

---

### Data Transfer: Binary Shards vs GeoJSON Polling

This is where Globe Trotter's architecture delivers its most dramatic savings.

**GeoJSON polling model:** A standard 2D map has no concept of temporal shards. Every epoch transition requires a new HTTP request carrying full polygon geometry as text:

| Per feature                          | GeoJSON size |
| ------------------------------------ | ------------ |
| H3 polygon (6 vertices + properties) | ~320 bytes   |
| Feature point (coords + properties)  | ~140 bytes   |

| Metric            | Calculation                                                     | Monthly  |
| ----------------- | --------------------------------------------------------------- | -------- |
| Per epoch request | 225K cells × 320 B + 76K features × 140 B = **~8.7 MB** gzipped | —        |
| Monthly egress    | 100 users × 300 views × 30 days × 8.7 MB = **7.8 TB**           | **$626** |

**Globe Trotter binary shard model:** Geometry is sent once in the base shard (cached forever). Epoch transitions use 4-byte Float32 values per cell — zero geometry repetition:

| Transfer                    | Size       | Frequency                   |
| --------------------------- | ---------- | --------------------------- |
| Base file (geometry + mesh) | 154 MB     | Once per user (CDN-cached)  |
| Temporal shard (60 epochs)  | ~30 MB     | Once per hour of playback   |
| **1 hour of animation**     | **~30 MB** | vs **522 MB** GeoJSON (60×) |

| Metric         | Calculation                                            | Monthly |
| -------------- | ------------------------------------------------------ | ------- |
| CDN egress     | 100 users × 3 sessions × 304 MB × 30 days = **912 GB** | **$73** |
| CDN cache fill | 3.5 GB (24 unique shards, origin-to-edge)              | $0.14   |

**Transfer savings: 8.6× less egress, $553/month saved.**

---

### Query & Compute Cost

**Traditional architecture:**

| Component                                | Monthly            |
| ---------------------------------------- | ------------------ |
| BigQuery queries (map + SQL, with cache) | **$4,800–$10,000** |
| GKE Autopilot REST API (4 pods, 16 vCPU) | **$634**           |
| Redis Memorystore (20 GB, HA)            | **$600**           |
| Web app sidecar                          | **$146**           |
| **Subtotal**                             | **$6,180–$11,380** |

**Globe Trotter architecture:**

| Component       | Monthly                                      |
| --------------- | -------------------------------------------- |
| BQ queries      | **$0** (all rendering is client-side)        |
| REST API        | **$0** (no API — browser reads CDN directly) |
| Redis cache     | **$0** (no server-side cache needed)         |
| Web app hosting | **$0.01** (static SPA on same CDN)           |
| **Subtotal**    | **$0.01**                                    |

---

### Dashboard Cost (Auto-Refresh Workloads)

Auto-refreshing dashboards are the **worst case** for BigQuery. A typical ops dashboard — 15 panels, 5 queries/panel, refreshing every 15 seconds — generates 432,000 BQ queries per day per dashboard.

| Metric                       | **BQ-Backed**         | **Globe Trotter**                 |
| ---------------------------- | --------------------- | --------------------------------- |
| Queries/month (5 dashboards) | **64,800,000**        | **0** (client-side GPU filtering) |
| BQ cost (90% cache hit)      | $25,920               | **$0**                            |
| Compute                      | K8s $584 + Redis $876 | **$0** (no server)                |
| **Total**                    | **$27,880**           | **$0**                            |
| **Savings**                  |                       | **∞ (zero server cost)**          |

Globe Trotter loads the full Flex dataset into WebGPU memory once (from CDN). All filtering, metric switching, and chart updates happen client-side via GPU compute — no round trips, no query engine, no server.

---

### Total Monthly Cost — Visualization

| Component                     | **BQ + K8s + Redis** | **Globe Trotter + CDN** |
| ----------------------------- | -------------------- | ----------------------- |
| Storage                       | $0.06                | $0.05                   |
| Queries (map + SQL)           | $4,800–$10,000       | $0 (client-side GPU)    |
| Queries (dashboards)          | $25,920              | $0 (client-side GPU)    |
| Compute (K8s + Redis)         | $1,380               | $0                      |
| Web app hosting               | $146                 | $0.01 (static)          |
| Egress                        | $626                 | $73                     |
| Grafana hosting               | $500                 | $0 (OSS)                |
| FlexDB (optional, ad-hoc SQL) | —                    | $24                     |
| **Total (optimistic cache)**  | **$33,372**          | **$97**                 |
| **Total (realistic cache)**   | **$36,000–$45,000**  | **$97**                 |
| **Cost ratio**                |                      | **344× cheaper**        |
| **Annual savings**            |                      | **~$400,000–$530,000**  |

### Scaling Projection

| Users/day | Dashboards | **Traditional** | **Globe Trotter** | **Savings** |
| --------- | ---------- | --------------: | ----------------: | ----------: |
| 10        | 2          |          $5,800 |               $31 |        187× |
| 100       | 5          |         $34,686 |               $97 |    **357×** |
| 500       | 10         |         $95,000 |              $120 |    **792×** |
| 1,000     | 20         |        $195,000 |              $145 |  **1,345×** |

Traditional costs scale **linearly** with users (more BQ queries, more GeoJSON egress). Globe Trotter scales **logarithmically** — CDN cache hit rate improves with more users requesting the same 24 unique shards.

---

## Part 2: Streaming Pipeline Cost — FlexStream vs Flink on EKS

**Dataset:** A high-velocity telemetry stream aggregated from a Kafka topic — device-level network metrics aggregated at 1-minute tumbling windows.

**Measured data profile:**

| Metric                                 | Value                                     |
| -------------------------------------- | ----------------------------------------- |
| Kafka partitions                       | 16                                        |
| Raw records/minute (peak)              | ~4,200,000 (~70K/sec, evening peak)       |
| Raw records/minute (trough)            | ~450,000 (~7.5K/sec, morning trough)      |
| Output rows/minute (after aggregation) | ~667,000 (peak, at 6.3:1 ratio)           |
| Aggregation ratio (input → output)     | 6.3:1                                     |
| Peak-to-trough ratio                   | ~9.3×                                     |
| Group-by columns                       | 14 (device ID, subscriber, service, etc.) |
| Aggregation functions                  | 6 × SUM + 2 × derived rate metrics        |

---

### Compute Cost: FlexStream vs Flink on EKS

**Flink on EKS (reference architecture):**

| Component                     | vCPU   | Memory     | Instances          |
| ----------------------------- | ------ | ---------- | ------------------ |
| JobManager                    | 2      | 4,596 MB   | 1                  |
| TaskManager                   | 2      | 16,596 MB  | 20–40 (autoscaler) |
| **Total (at parallelism 20)** | **42** | **336 GB** | 21 pods            |
| **Total (at parallelism 40)** | **82** | **668 GB** | 41 pods            |

| Item                                       | Monthly     |
| ------------------------------------------ | ----------- |
| TaskManager nodes (avg 25 TMs, r5.2xlarge) | **$3,311**  |
| JobManager node (m5.large)                 | **$70**     |
| EKS cluster fee                            | **$73**     |
| S3 checkpoints (~50 GB/day)                | **$35**     |
| Logging (~100 GB/month)                    | **$50**     |
| **Flink total**                            | **~$3,539** |

**FlexStream on GKE Autopilot:**

FlexStream replaces the entire Flink pipeline with a single Rust binary:

| Component      | vCPU                    | Memory                         | Instances |
| -------------- | ----------------------- | ------------------------------ | --------- |
| FlexStream pod | 4 (limit) / 1 (request) | 11 GB (limit) / 2 GB (request) | **1**     |

Observed memory at peak: **5.5–6 GB** (stable).

| Item                              | Monthly    |
| --------------------------------- | ---------- |
| vCPU (1 requested)                | **$25.55** |
| Memory (2 GB requested)           | **$5.58**  |
| GCS writes (~55 GB/day × 30)      | **$33.00** |
| GCS operations (1,440 writes/day) | **$0.22**  |
| **FlexStream total**              | **~$64**   |

**Compute comparison:**

|                     | **Flink EKS** | **FlexStream GKE** | **Savings**         |
| ------------------- | ------------- | ------------------ | ------------------- |
| vCPU (steady-state) | 42–82 vCPU    | 1 vCPU (request)   | **42–82×**          |
| Memory              | 336–668 GB    | 2 GB (request)     | **168–334×**        |
| Pod count           | 21–41         | **1**              | **21–41×**          |
| Monthly compute     | ~$3,539       | ~$64               | **55×**             |
| Annual compute      | ~$42,468      | ~$768              | **$41,700 savings** |

FlexStream achieves this by eliminating JVM overhead (Rust uses ~10× less memory for the same workload), state backend (no RocksDB, no S3 checkpoints — pure in-memory tumbling windows), serialisation overhead (zero-copy Arrow), and operator graph overhead (single fused pipeline vs a multi-stage Flink DAG).

---

### Storage Cost: MFB vs BigQuery

**Per-epoch size (1-minute window, ~1.26M rows):**

| Format          | Size        | Per row    | vs MFB (.shd3) |
| --------------- | ----------- | ---------- | -------------- |
| **MFB (.shd3)** | **38.0 MB** | **30.2 B** | 1.0×           |
| MFB (raw)       | 175.3 MB    | 139.4 B    | 4.6×           |
| BQ (logical)    | 647.0 MB    | 514.5 B    | **17.0×**      |

MFB is 17× smaller due to dictionary encoding (repeated string fields stored once with 2-byte indices), columnar gzip compression (typed arrays compress far better than mixed rows), and the absence of BQ's internal partition and cluster metadata.

**Daily & monthly storage:**

|                        | **MFB on GCS** | **BQ Logical** | **Savings** |
| ---------------------- | -------------- | -------------- | ----------- |
| Per epoch (1 min)      | 38.0 MB        | 647.0 MB       | 17×         |
| Per day (1,440 epochs) | **54.7 GB**    | **931.7 GB**   | 17×         |
| Per month (30 days)    | **1.64 TB**    | **27.95 TB**   | 17×         |
| Monthly cost           | **$32.82**     | **$559.04**    | **17×**     |

---

### Query Cost: FlexDB vs BigQuery

**BigQuery on-demand pricing: $6.25 per TB scanned.** The table is partitioned hourly and clustered by device and service category.

| Query pattern                    | Data scanned | Cost/query |
| -------------------------------- | ------------ | ---------- |
| Single epoch (1-min partition)   | ~647 MB      | $0.004     |
| Hourly rollup (60 epochs)        | ~38.8 GB     | $0.24      |
| Daily rollup (1,440 epochs)      | ~931.7 GB    | $5.82      |
| Ad-hoc full table scan (30 days) | ~27.95 TB    | $174.69    |

**Monthly query volume for a typical analytics workload:**

| Consumer                                | Monthly queries | Avg scan | Monthly BQ cost |
| --------------------------------------- | --------------- | -------- | --------------- |
| Dashboard (5 panels, refresh every 15s) | 14,400          | ~647 MB  | **$58**         |
| Hourly reports                          | 720             | ~38.8 GB | **$173**        |
| Analyst ad-hoc (10 engineers × 20/day)  | 6,000           | ~5 GB    | **$188**        |
| Daily ETL/aggregation jobs              | 300             | ~931 GB  | **$1,746**      |
| **Total**                               | **21,420**      |          | **$2,165/mo**   |

**FlexDB on GKE** reads MFB files directly from GCS and executes SQL via Apache DataFusion — zero BQ charges. Cost is **fixed** regardless of query volume:

| Component                 | Monthly   |
| ------------------------- | --------- |
| FlexDB pod (2 vCPU, 4 GB) | **$62**   |
| GCS reads                 | **$0.01** |
| **FlexDB total**          | **~$62**  |

**Query cost comparison:**

|                              | **BigQuery**   | **FlexDB (MFB)**   | **Savings** |
| ---------------------------- | -------------- | ------------------ | ----------- |
| Pricing model                | Per-TB scanned | Fixed compute      | —           |
| Cost at 21K queries/month    | **$2,165**     | **$62**            | **35×**     |
| Cost at 100K queries/month   | ~$10,000       | **$62**            | **161×**    |
| Query latency (single epoch) | 500ms–2s       | <10ms (in-process) | **50–200×** |
| Query latency (daily rollup) | 3–8s           | <100ms             | **30–80×**  |
| Concurrent query limit       | 100 (BQ quota) | Unlimited          | —           |

---

### Total Pipeline Cost — Streaming

| Component         | **Flink + BQ** | **FlexStream + MFB + FlexDB** | **Savings**         |
| ----------------- | -------------- | ----------------------------- | ------------------- |
| Stream processing | $3,539         | $64                           | 55×                 |
| Output storage    | $559           | $33                           | 17×                 |
| Query serving     | $2,165         | $62                           | 35×                 |
| Checkpoint/state  | $35            | $0                            | ∞                   |
| **Monthly total** | **$6,348**     | **$159**                      | **40×**             |
| **Annual total**  | **$76,176**    | **$1,908**                    | **$74,268 savings** |

**Cost per million output rows** (~51.8B rows/month):

|                  | **Flink + BQ** | **FlexStream + MFB** |
| ---------------- | -------------- | -------------------- |
| Cost per 1M rows | $0.123         | **$0.0031**          |
| Ratio            |                | **40× cheaper**      |

---

### Operational Comparison

| Dimension              | **Flink on EKS**                      | **FlexStream**                              |
| ---------------------- | ------------------------------------- | ------------------------------------------- |
| Language               | Python (PyFlink)                      | Rust                                        |
| State management       | RocksDB + S3 checkpoints              | In-memory (stateless restart)               |
| Exactly-once semantics | Yes (via checkpoints)                 | At-least-once (idempotent windows)          |
| Recovery time          | 2–5 min (restore from checkpoint)     | ~5s (restart, reprocess from Kafka)         |
| Autoscaling            | Flink autoscaler (20–40 TaskManagers) | Fixed single pod (handles 9.3× variability) |
| Deployment             | Flink operator + EKS + ECR            | Docker image, `kubectl apply`               |
| Dependencies           | Flink, PyFlink, multiple helpers      | Single static binary                        |
| Cold start             | 30–60s (JVM + class loading)          | < 1s                                        |
| Memory per worker      | 16.6 GB (JVM + RocksDB)               | 5.5–6 GB total (observed)                   |
| Checkpointing          | 20s interval, S3 writes, barriers     | None                                        |

---

## Why the Cost Difference Is Structural

### Visualization tier

| Category          | Traditional                           | Globe Trotter                             |
| ----------------- | ------------------------------------- | ----------------------------------------- |
| Query pricing     | Per-query (BQ charges per TB scanned) | **$0** (client-side rendering)            |
| Data format       | GeoJSON text (~320 B/feature)         | *Flex binary (~4 B/cell/epoch)            |
| Geometry transfer | Repeated every epoch                  | Sent once, cached forever                 |
| Middleware        | REST API + Redis + K8s                | **None** (browser → CDN → GCS)            |
| Compute location  | Server-side                           | **Client GPU**                            |
| Scale model       | Linear (users × queries × cost/query) | **Flat** (CDN bytes, shared across users) |

### Streaming tier

| Category             | Flink + BigQuery                        | FlexStream + MFB                        |
| -------------------- | --------------------------------------- | --------------------------------------- |
| Runtime overhead     | JVM heap, managed memory, RocksDB state | Rust binary, in-process memory only     |
| Parallelism model    | 20–40 TaskManagers + JobManager         | Single process, Tokio async concurrency |
| Storage format       | BQ row format (~514 B/row)              | MFB columnar gzip (~30 B/row)           |
| Query pricing        | Per-TB scanned (scales with volume)     | Fixed compute (cost-flat at any volume) |
| Fault tolerance cost | S3 checkpoints, 20s intervals           | Stateless — reprocess from Kafka        |
