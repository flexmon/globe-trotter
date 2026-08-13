# Globe Trotter — High-Performance Network Monitoring Architecture

## The Grafana + Druid Problem

Grafana is brilliant UX — time-range pickers, reactive dashboards, live-tail with auto-refresh — and Apache Druid provides the sub-second OLAP query engine for tabular metric visualization. But the combined architecture is inherently expensive for satellite network monitoring:

```
Every Grafana panel refresh:
  Browser → Grafana Server → Druid Plugin → Druid Broker → Druid Historical → (reverse)

  5 hops per panel × 15 panels × 4 refreshes/min = 300 HTTP round-trips/minute/dashboard
```

| Pain Point                   | Why It Hurts                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Druid cluster overhead**   | 10+ nodes (Master, Broker, Historical, MiddleManager, ZooKeeper) running 24/7 just for query serving |
| **Druid ingestion pipeline** | Data must be ingested into Druid segments — another ETL step, another failure point                  |
| **Middle tier**              | Grafana needs configured Druid data source plugin + proxy — all stateful, all costly                 |
| **Per-query compute**        | Every panel refresh queries Druid Brokers → Historical nodes — CPU scales with dashboard usage       |
| **Transfer bloat**           | JSON wire format repeats field names + text-encodes numbers on every refresh                         |
| **Linear cost scaling**      | 10 dashboards = 10× Druid query load; 100 users = 100× the broker pressure                           |
| **Cloud→Corp drain**         | Every auto-refresh pulls data from cloud to corporate intranet — egress charges compound             |
| **Operational complexity**   | Druid requires deep storage (GCS), metadata store (MySQL), ZooKeeper, segment compaction             |

### Apache Druid Cluster Cost

Druid requires a multi-node cluster to serve sub-second OLAP queries at high-scale telemetry ingestion rates:

```
DRUID CLUSTER FOR 1.42M ROWS/MIN INGESTION:

  Master nodes (coordination + overlord):
    3× n2-standard-4 (HA) × $140/mo              =    ~$420/mo

  Query nodes (broker — serves Grafana):
    3× n2-standard-8 × $245/mo                    =    ~$735/mo

  Data nodes (historical + middle manager):
    6-8× n2-highmem-8 (32 GB RAM for segments)
    × $350/mo                                     = ~$2,100–$2,800/mo

  ZooKeeper (coordination):
    3× n2-standard-2 × $50/mo                     =    ~$150/mo

  Deep storage (GCS — segment files):
    ~2 TB retained × $0.02/GB                      =     ~$40/mo

  Metadata store (Cloud SQL):
    db-n1-standard-1                               =     ~$50/mo

  ──────────────────────────────────────────────────
  Druid cluster total:                             ~$3,500–$4,200/mo

  With headroom for query spikes and segment compaction:
                                                   ~$4,000–$5,500/mo
```

> [!WARNING]
> **The Druid cluster exists solely to provide sub-second query latency that BigQuery cannot deliver.** BQ queries take 500ms–3s — too slow for interactive Grafana panels. Druid solves this by pre-ingesting data into in-memory segments. DuckDB-WASM achieves the same sub-second latency (actually **sub-10ms**) without any server infrastructure — the OLAP engine runs in the browser.

**5-dashboard Grafana+Druid estimate**: **~$27,880/month** (BQ-backed panels + Druid cluster).

---

## Three Architecture Tiers

We propose three tiers, each progressively eliminating cost layers. A deployment can use one, two, or all three depending on latency and flexibility requirements.

```
                           Cost ──────────────────► Performance

  ┌──────────────┐    ┌──────────────────┐    ┌───────────────────┐
  │  Tier 1      │    │  Tier 2          │    │  Tier 3           │
  │  "Zero API"  │    │  "Edge Query"    │    │  "Full Static"    │
  │              │    │                  │    │                   │
  │ DuckDB on    │    │ Query engine on  │    │ No server at all  │
  │ Cloud Run    │    │ CDN edge (WASM)  │    │ Browser-only      │
  │ ($52/mo)     │    │ ($18–73/mo)      │    │ ($0 compute)      │
  └──────────────┘    └──────────────────┘    └───────────────────┘
        ▲                     ▲                       ▲
        │                     │                       │
   SQL over HTTP        SQL in Worker           GPU-direct decode
   JSON results         Arrow IPC results       typed array → texture
   Grafana-compatible   Custom dashboard UI     Globe Trotter native
```

---

## Tier 1: Zero API — DuckDB on Cloud Run

**Architecture:** Replace the entire Grafana middleware stack (data source plugins, REST APIs, caching layers) with a single Cloud Run container running the Globe Trotter query engine.

```
┌──────────────────┐     SQL-over-HTTP       ┌──────────────────┐    binary read    ┌────────┐
│  Dashboard UI    │ ◄─────────────────────► │  Cloud Run       │ ◄───────────────► │  GCS   │
│  (any frontend)  │    JSON / Arrow IPC     │  (DuckDB +       │   *Flex binary    │ bucket │
│                  │    ~2 KB per panel      │   *Flex data     │   loaded once     └────────┘
│  OR: Grafana     │                         │   + ST_ macros)  │
│  (JSON plugin)   │                         │                  │
└──────────────────┘                         └──────────────────┘
                                                in-process SQL
                                                0 BigQuery charges
```

### Why It Works

1. **Data pre-loaded in memory.** Container starts → fetches *Flex from GCS (1.74 GB, ~2s cold start) → DuckDB loads via Arrow IPC zero-copy in <1s. All data is in-memory columnar.
2. **Queries are free.** Whether the dashboard fires 1 or 65 million queries/month, the Cloud Run bill stays at ~$52. Variable query cost → fixed compute cost.
3. **Full SQL.** DuckDB supports JOINs, window functions, CTEs, and our ST_* spatial macros — feature-parity with BigQuery for monitoring queries.
4. **Grafana-compatible.** Grafana's [JSON API data source plugin](https://grafana.com/grafana/plugins/simpod-json-datasource/) can query the endpoint directly. Zero custom plugin development.

### Streaming Data Flow

For real-time monitoring, integrate with the existing streaming architecture:

```
Kafka ──► Flink ──► GCS ──► Cloud Run (hot reload) ──► Dashboard
                     │
                     ├── fleet_latest.bin.gz    (overwritten every 30s)
                     ├── demand_latest.bin.gz
                     └── revenue_latest.bin.gz

Cloud Run watches for new `latest` files:
  1. GCS pub/sub notification → triggers shard reload
  2. DuckDB table re-registered with new data (Arrow IPC swap, <100ms)
  3. Next dashboard query sees fresh data
  4. No polling from dashboard — push-to-reload
```

### Cost Breakdown

| Component                       | Spec                  | Monthly  |
| ------------------------------- | --------------------- | -------- |
| Cloud Run (2 vCPU, 4 GB, min 1) | ~720 hrs × $0.072/hr  | **$52**  |
| GCS storage (1.74 GB)           | $0.020/GB             | $0.04    |
| GCS Pub/Sub notifications       | ~90K events/mo        | $0.09    |
| Egress (PGA)                    | Private Google Access | **$0**   |
| **Total**                       |                       | **~$52** |

### When to Use

- You want Grafana UI or need to integrate with existing Grafana dashboards
- You need full SQL flexibility (ad-hoc queries, JOINs across datasets)
- You have a team that knows SQL and wants to build custom panels
- Cold-start penalty (~3s) is acceptable

---

## Tier 2: Edge Query — DuckDB-WASM on CDN Edge

**Architecture:** Eliminate even the Cloud Run container. Ship DuckDB-WASM to the browser (or a Cloudflare Worker / Deno Deploy edge function) and query *Flex data directly at the network edge.

```
┌──────────────────┐                    ┌──────────────────┐
│  Dashboard UI    │ ◄── local SQL ───► │  DuckDB-WASM     │
│  (browser)       │    (in-process)    │  (Web Worker)    │
│                  │                    │                  │
│  Charts, tables, │                    │  Loaded *Flex    │
│  time pickers    │                    │  from CDN edge   │
└──────────────────┘                    └──────────┬───────┘
                                                   │
                                         fetch() binary shards
                                                   │
                                        ┌──────────▼───────────┐
                                        │  Cloud CDN           │
                                        │  (180+ PoPs)         │
                                        │  10-30ms TTFB        │
                                        └──────────┬───────────┘
                                                   │
                                        ┌──────────▼───────────┐
                                        │  GCS Bucket          │
                                        │  (origin)            │
                                        └──────────────────────┘
```

### Key Innovation: Lazy Shard Query

DuckDB-WASM in the browser doesn't need to download the entire dataset. It leverages the existing shard architecture:

```js
// Pseudo-code for the monitoring dashboard query lifecycle
class MonitoringQueryEngine {
  constructor(manifestUrl) {
    this.db = new duckdb.AsyncDuckDB();
    this.loadedShards = new Map(); // epoch range → Arrow table
  }

  async query(sql, timeRange) {
    // 1. Determine which shards cover the requested time range
    const shards = this.manifest.getShardsForRange(timeRange);

    // 2. Lazy-load only the needed shards (CDN-cached)
    for (const shard of shards) {
      if (!this.loadedShards.has(shard.key)) {
        const buffer = await fetch(shard.url); // CDN edge, ~10ms
        const arrow = bridgeToArrow(decode(buffer));
        this.db.registerTable(shard.tableName, arrow);
        this.loadedShards.set(shard.key, true);
      }
    }

    // 3. Execute SQL locally — zero network round-trip
    return this.db.query(sql); // <5ms for typical dashboard queries
  }
}
```

### Data Transfer Minimization

This tier directly addresses the **cloud → corporate intranet drain** problem:

| Strategy                | How It Works                                               | Transfer Savings                                     |
| ----------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| **Geometry-once**       | Base file loaded once, CDN-cached indefinitely             | H3 mesh (112 MB) sent once per CDN PoP, not per user |
| **Temporal sharding**   | Only the shard covering the current time window is fetched | 30 MB shard vs 1.74 GB full dataset (58× less)       |
| **Binary format**       | Float32 values, no JSON overhead                           | 4 bytes/value vs ~80 bytes (JSON) = 20× less         |
| **CDN edge caching**    | Corporate users on same PoP share cached shards            | 100 users × same shard = 1 origin fetch              |
| **ETag polling**        | `latest` file polled with `If-None-Match` — 304 = 0 bytes  | Only transfer data when it actually changes          |
| **Differential shards** | Future: only send changed cells per epoch                  | Further 60-95% reduction for sparse changes          |

**Monthly transfer comparison for 100-user monitoring:**

| Architecture                       | Transfer/month        | Cost (public egress) | Cost (with PGA)                     |
| ---------------------------------- | --------------------- | -------------------- | ----------------------------------- |
| Grafana + BigQuery (JSON)          | **7,800 GB**          | $626                 | $626 (BQ egress not covered by PGA) |
| Grafana + Cloud Run (JSON results) | **90 GB**             | $7                   | **$0**                              |
| Edge Query (binary shards via CDN) | **912 GB CDN-served** | $73                  | **$0**                              |
| Edge Query (actual origin fetch)   | **~3.5 GB**           | $0.28                | **$0**                              |

> [!TIP]
> With Private Google Access, the transfer column becomes irrelevant for *Flex architectures — all data stays on Google's backbone. The BQ+Grafana architecture still pays egress because BigQuery egress is billed separately from PGA.

### Cost Breakdown

| Component            | Spec                           | Monthly  |
| -------------------- | ------------------------------ | -------- |
| GXLB forwarding rule | Fixed                          | **$18**  |
| GCS storage          | 1.74 GB                        | $0.04    |
| Compute              | **$0** (browser does all work) | $0       |
| **Total**            |                                | **~$18** |

### When to Use

- You want **zero server-side compute** for monitoring
- Corporate intranet deployment where reducing cloud egress is critical
- Offline capability is valued (download shards, query locally forever)
- You're building a custom monitoring UI (not Grafana)

---

## Tier 3: Full Static — GPU-Direct Browser Rendering

**Architecture:** The ultimate zero-cost-compute tier. The browser decodes *Flex binary directly into GPU textures — no SQL engine, no middleware, no server. This is the existing Globe Trotter architecture extended with monitoring-specific UI.

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser                                   │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ Time Panel  │  │ Chart Engine │  │ GPU Render Pipeline     │  │
│  │ (scrub/live)│  │ (WebGPU)     │  │ (WebGL2 / WebGPU)       │  │
│  │             │  │              │  │                         │  │
│  │ ├─ range    │  │ ├─ heatmap   │  │ ├─ H3F hexagons         │  │
│  │ ├─ live btn │  │ ├─ histogram │  │ ├─ GFB tracks           │  │
│  │ └─ speed    │  │ ├─ time-ser  │  │ └─ MFB metrics          │  │
│  │             │  │ └─ boxplot   │  │                         │  │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬──────────────┘  │
│         │                │                      │                │
│         └────────────────┼──────────────────────┘                │
│                          │                                       │
│                   TimeController                                 │
│                   (scrub / ETag poll)                            │
│                          │                                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │ fetch() binary
                    ┌──────▼───────────┐
                    │  Cloud CDN       │
                    └──────┬───────────┘
                    ┌──────▼───────────┐
                    │  GCS Bucket      │
                    └──────────────────┘
```

### Monitoring UX Features (Grafana Parity)

The monitoring application needs specific UX features to match Grafana's experience:

#### 1. Time Range Picker (Grafana-Like)

```
┌──────────────────────────────────────────────────────────────────┐
│  Quick ranges:  [5m] [15m] [1h] [6h] [12h] [24h] [7d] [30d]      │
│                                                                  │
│  ◄──────────────────────●──────────────► [  NOW  ]               │
│  ▲                      ▲                  ▲                     │
│  TTL boundary     current view          live toggle              │
│  (oldest shard)   (playback)            (resume polling)         │
│                                                                  │
│  From: 2026-03-07 02:00 UTC    To: 2026-03-07 10:37 UTC          │
│  Refresh: [off] [5s] [10s] [30s] [1m] [5m]                       │
└──────────────────────────────────────────────────────────────────┘
```

**How it maps to shards:**

- "Last 5 minutes" → fetch 1 shard (covers 60 epochs at 1-min grain)
- "Last 1 hour" → fetch 1 shard (60 epochs)
- "Last 24 hours" → fetch 24 shards (lazy, as user scrubs)
- "Last 7 days" → fetch shards on-demand from GCS TTL window

#### 2. Reactive Dashboard Panels

All panels observe `TimeController` state. When the time range changes, every panel re-renders from the in-memory shard data — **zero network requests** for time scrubbing within a loaded shard.

```
TimeController.update()
    ├── H3F layer: GPU texture swap (50µs)
    ├── GFB layer: position interpolation (50µs)
    ├── Chart 1: histogram re-compute from shard data (1ms)
    ├── Chart 2: time-series re-slice (0.5ms)
    └── Chart 3: heatmap re-color (0.2ms)

    Total: <2ms for all panels to react to a time change
```

Compare to Grafana: time change → 15 panels × HTTP roundtrip → 500ms-3s until all panels update.

#### 3. Live Mode ("Now")

When the user clicks "NOW" or the time range includes the present:

```js
// StreamingController — existing architecture
class StreamingController {
  async poll() {
    const resp = await fetch(this.latestUrl, {
      headers: { 'If-None-Match': this.lastEtag },
    });

    if (resp.status === 304) return; // no new data, 0 bytes transferred

    this.lastEtag = resp.headers.get('etag');
    this.currSnapshot = decode(await resp.arrayBuffer());

    // All dashboard panels automatically update
    this.engine.events.emit('epoch:update', this.currSnapshot);
  }
}
```

- **Poll interval:** 2s (CDN TTL-aligned)
- **Transfer per poll (304 / no change):** 0 bytes
- **Transfer per poll (new data, 5K aircraft):** ~30 KB gzipped
- **Automatic detection:** ETag change = new data available. No timestamps, no counting, no coordination.

### YAML-Driven Dashboard Configuration

Dashboards are defined in `globe-config.yaml` — the same mechanism that drives Globe Trotter visualization:

```yaml
# monitoring-dashboard.yaml
time:
  enabled: true
  autoplay: false # monitoring = paused by default
  speed: 1 # 1x real-time when playing
  mode: streaming # enable live polling

layers:
  - type: h3f
    name: 'Network Demand'
    manifest: ./data/demand/manifest.json
    style:
      colorRamp: spectral
      attribute: demand_mbps
      domain: [0, 500]

  - type: gfb
    name: 'Active Aircraft'
    manifest: ./data/fleet/manifest.json
    style:
      symbol: aircraft
      colorAttribute: avg_bandwidth
      colorRamp: viridis

charts:
  - type: time-series
    title: 'Global Bandwidth Demand'
    source: h3f
    attribute: demand_mbps
    aggregation: sum

  - type: histogram
    title: 'Latency Distribution'
    source: gfb
    attribute: p95_latency
    bins: 50

  - type: heatmap
    title: 'Demand by Region × Hour'
    source: h3f
    xAttribute: epoch
    yAttribute: region_name
    valueAttribute: demand_mbps
    aggregation: avg

  - type: boxplot
    title: 'Per-Airline Bandwidth'
    source: gfb
    categoryAttribute: airline
    valueAttribute: avg_bandwidth
```

### Cost Breakdown

| Component            | Spec                 | Monthly  |
| -------------------- | -------------------- | -------- |
| GXLB forwarding rule | Fixed                | **$18**  |
| GCS storage          | 1.74 GB              | $0.04    |
| Compute              | **$0** (browser GPU) | $0       |
| **Total**            |                      | **~$18** |

---

## End-to-End Streaming Latency Analysis

For network monitoring, **time skew** — the delay from when a network device generates an event to when an operator sees it on the dashboard — is the critical performance metric. The typical Grafana/Prometheus stack achieves 30–120 seconds. Here's how the *Flex pipeline can be optimized to push that as low as possible.

### The Six-Hop Pipeline

Every monitoring event traverses six hops from device to pixel. Each hop has a minimum latency floor and an optimization ceiling.

```
┌──────────┐    ┌────────┐    ┌────────┐    ┌──────┐    ┌──────┐    ┌─────────┐
│ ① Device │ →  │② Kafka │ →  │③ Flink │ →  │④ GCS │ →  │⑤ CDN │ →  │⑥Browser │
│  Event   │    │Ingest  │    │Window  │    │Write │    │ TTL  │    │Poll+GPU │
└──────────┘    └────────┘    └────────┘    └──────┘    └──────┘    └─────────┘
   T=0           +1-3s       +windowSlide   +200ms      +TTL       +poll+50ms
                              +watermark
```

### Per-Hop Latency Budget

| Hop   | Component                  | Latency Source                                        | Current                      | Optimized               | Aggressive                          |
| ----- | -------------------------- | ----------------------------------------------------- | ---------------------------- | ----------------------- | ----------------------------------- |
| **①** | Device → Collector         | SNMP poll interval, gNMI subscribe, sFlow sample rate | 5–60s (SNMP)                 | 1–5s (gNMI)             | **<1s** (gNMI on-change)            |
| **②** | Collector → Kafka          | Producer batch.linger.ms + network                    | 0.5–2s                       | 100–500ms               | **50ms** (linger.ms=0)              |
| **③** | Kafka → Flink window close | Window size + watermark tolerance                     | **30s slide + 10s WM = 40s** | 10s slide + 5s WM = 15s | **5s tumble + 2s WM = 7s**          |
| **④** | Flink → GCS write          | Object creation + gzip                                | 200–500ms                    | 100–200ms               | **100ms** (pre-compressed)          |
| **⑤** | GCS → CDN edge / PGA       | Cache TTL expiry or origin fetch                      | 2s (CDN TTL)                 | 1s                      | **0s** (no CDN, direct GCS via PGA) |
| **⑥** | CDN/GCS → Browser render   | Poll interval + decode + GPU upload                   | 2s poll + 50ms               | 1s poll + 50ms          | **500ms poll + 50ms**               |
|       | **Total time skew**        |                                                       | **~45s typical**             | **~18s typical**        | **~8–9s typical**                   |

> [!NOTE]
> **Hop ① dominates in traditional monitoring.** SNMP polling at 60-second intervals means the data is already 60 seconds old when it enters the pipeline. Switching to gNMI streaming telemetry (`ON_CHANGE` or 1-second `SAMPLE`) eliminates this bottleneck entirely. The pipeline optimizations below assume gNMI or similar push-based telemetry.

### Profile A: Current Architecture (~45s skew)

The streaming architecture as documented uses 5-minute hopping windows with 30-second slides:

```
Flink HOPPING window (5 min size, 30s slide)
  └─ Window fires every 30s
  └─ Watermark tolerance: 10s (INTERVAL '10' SECOND)
  └─ Window cannot close until 10s after boundary
  └─ Effective: event arrives at T=0, visible at T ≈ 40-45s

Timeline:
  T=0          T=30         T=40          T=42         T=44
  │ event      │ window     │ watermark   │ GCS write  │ browser
  │ generated  │ boundary   │ closes      │ completes  │ polls
  │            │            │ Flink emits │            │ new data!
```

**Why 40-45 seconds:** The 30s slide means an event arriving at T=0 waits up to 30 seconds for the next window boundary, then 10 more seconds for the watermark to expire, then ~2-4s for GCS+CDN+poll.

### Profile B: Optimized Architecture (~12-18s skew)

Reduce the window to a **10-second tumbling window** with tighter watermarks:

```
Flink TUMBLING window (10s)
  └─ Window fires every 10s
  └─ Watermark tolerance: 5s (INTERVAL '5' SECOND)
  └─ CDN TTL: 1s
  └─ Browser poll: 1s

Timeline:
  T=0       T=10      T=15      T=15.3    T=16.3    T=17.3
  │ event   │ window  │ WM      │ GCS     │ CDN     │ browser
  │ arrives │ closes  │ expires │ write   │ serves  │ displays
```

**Flink sink configuration:**

```python
# Optimized 10-second tumbling window
t_env.execute_sql("""
    INSERT INTO gfb_sink
    SELECT
        tail_number,
        LAST_VALUE(lon) AS lon,
        LAST_VALUE(lat) AS lat,
        AVG(bandwidth_mbps) AS avg_bandwidth,
        TUMBLE_END(event_time, INTERVAL '10' SECOND) AS window_end
    FROM enriched_stream
    GROUP BY
        tail_number,
        TUMBLE(event_time, INTERVAL '10' SECOND)
""")
```

**Binary output at 10-second grain:**

| Format                            | Snapshot size (raw) | Snapshot size (gz) | Files/hour | GCS writes/day |
| --------------------------------- | ------------------- | ------------------ | ---------- | -------------- |
| GFBS (5K aircraft)                | 140 KB              | **~30 KB**         | 360        | 8,640          |
| H3F shard (1.47M cells, 8% dense) | 469 KB              | **~80 KB**         | 360        | 8,640          |
| MFB snapshot (76K entities)       | 304 KB              | **~50 KB**         | 360        | 8,640          |

GCS operation cost at 360 writes/hr × 3 formats × 24h = **25,920 writes/day ≈ $0.13/day**. Negligible.

### Profile C: Aggressive Architecture (~3-5s skew)

For the absolute minimum latency, bypass CDN caching entirely and use **direct GCS fetch via PGA + micro-batched snapshots**:

```
Device (gNMI ON_CHANGE, <1s)
  → Kafka (linger.ms=0, ~50ms)
    → Flink TUMBLING window (5s) + watermark 2s
      → GCS write (~100ms)
        → Browser direct-GCS poll (500ms interval, PGA = no CDN hop)
          → Decode + GPU upload (50ms)

Worst case: 5s window + 2s watermark + 100ms write + 500ms poll + 50ms decode
           = ~7.7s worst case, ~3-5s typical (event arrives mid-window)
```

**Key insight: PGA eliminates the CDN TTL bottleneck.** With Private Google Access, the browser can fetch directly from `storage.googleapis.com` — no CDN cache in the path, no 1-2 second TTL delay. The file is visible the instant GCS write completes.

```js
// Aggressive polling — direct GCS fetch via PGA
class AggressiveStreamingController {
  constructor(manifest) {
    this.pollInterval = 500; // 500ms — 2× per second
    this.latestUrl = manifest.streaming.latest;
  }

  async poll() {
    // PGA: browser fetches directly from storage.googleapis.com
    // No CDN cache in path — sees GCS writes immediately
    const resp = await fetch(this.latestUrl, {
      headers: { 'If-None-Match': this.lastEtag },
      cache: 'no-store', // bypass browser cache for latest
    });

    if (resp.status === 304) return; // no new data

    this.lastEtag = resp.headers.get('etag');
    const buffer = await resp.arrayBuffer();

    // Snapshot is tiny (~30 KB gz for 5K aircraft)
    // Decode + GPU upload: <50ms total
    this.prevSnapshot = this.currSnapshot;
    this.currSnapshot = decode(buffer);
    this.uploadToGPU();

    // Log time skew for monitoring
    const skew = Date.now() / 1000 - this.currSnapshot.timestamp;
    console.log(`[Streaming] Time skew: ${skew.toFixed(1)}s`);
  }
}
```

### *Flex Format Optimizations for Minimum Latency

The binary format itself contributes to low latency — here's why, and what can be optimized further:

#### 1. Snapshot Size = Transfer Speed

The GFBS format at 5,000 aircraft is **30 KB gzipped**. At even modest network speeds:

| Network                   | 30 KB transfer time | Impact on time skew |
| ------------------------- | ------------------- | ------------------- |
| LAN (1 Gbps)              | **0.24ms**          | Negligible          |
| WiFi (100 Mbps)           | **2.4ms**           | Negligible          |
| PGA / Google backbone     | **<1ms**            | Negligible          |
| Public internet (50 Mbps) | **4.8ms**           | Negligible          |

Compare to Grafana JSON: same 5K aircraft × 140 bytes/feature = **700 KB** uncompressed, ~**70 KB** gzipped. 2.3× larger for the same data. More importantly, JSON requires **parsing** (~15ms for 5K objects), while GFBS is a typed array view (**0.01ms**).

#### 2. Zero-Parse Decode

*Flex streaming snapshots use fixed-size typed arrays. The decode path is a DataView read, not a parse:

```js
// GFBS decode — O(1), no parsing, no allocation
function decodeGFBS(buffer) {
  const view = new DataView(buffer);
  const activeCount = view.getUint16(6, true);
  const timestamp = view.getFloat64(8, true);

  // Direct typed array view — zero copy, zero parse
  const data = new Float32Array(buffer, 16, activeCount * 7);

  return { activeCount, timestamp, data };
  // Total decode time: <0.1ms regardless of entity count
}
```

#### 3. Single-Epoch Snapshots (No Window Accumulation)

For minimum latency, write **single-epoch snapshots** instead of multi-epoch shards. Each snapshot is a self-contained state of the world at one instant:

```
Multi-epoch shard (current):
  ┌──────────────────────────────────┐
  │ 60 epochs × N entities × 4 bytes │   ← must accumulate 60 epochs
  │ Covers: 1 hour of data           │      before writing
  │ Size: ~30 MB for H3F             │
  └──────────────────────────────────┘

Single-epoch snapshot (optimized for latency):
  ┌──────────────────────┐
  │ 1 epoch × N entities │   ← write immediately after window closes
  │ Covers: this instant │      no accumulation delay
  │ Size: ~80 KB for H3F │
  └──────────────────────┘
```

The `latest` file pattern already does this — it's an overwrite of the most recent snapshot. The optimization is to set `epochsPerWindow: 1` in the manifest so each snapshot stands alone.

#### 4. Delta Encoding (Future Optimization)

For sparse-change metrics (e.g., per-cell demand that changes slowly), a delta-encoded snapshot could be dramatically smaller:

```
Full snapshot:  Float32[1,470,000 cells]      = 5.6 MB raw, ~80 KB gz
Delta snapshot: U32[changedIndex] + F32[value] = 2 × changedCount × 4B

If 5% of cells change per epoch:
  Delta: 73,500 × 8 bytes = 588 KB raw, ~30 KB gz  (vs 80 KB full)

If 1% of cells change per epoch:
  Delta: 14,700 × 8 bytes = 118 KB raw, ~8 KB gz   (vs 80 KB full = 10× smaller)
```

Delta encoding trades CPU (client must apply delta to current state) for transfer size and write speed. For monitoring dashboards where many cells are stable between snapshots, this is a significant win.

### Latency Profile Comparison

| Metric                      | **Grafana + BQ**        | **Profile A** (current) | **Profile B** (optimized) | **Profile C** (aggressive)  |
| --------------------------- | ----------------------- | ----------------------- | ------------------------- | --------------------------- |
| **Event → dashboard skew**  | 30–120s                 | **~45s**                | **~12–18s**               | **~3–5s**                   |
| Window interval             | N/A (per-query)         | 30s slide               | 10s tumble                | 5s tumble                   |
| Watermark tolerance         | N/A                     | 10s                     | 5s                        | 2s                          |
| CDN/delivery TTL            | N/A                     | 2s                      | 1s                        | 0s (direct GCS via PGA)     |
| Browser poll interval       | 5–30s (Grafana refresh) | 2s                      | 1s                        | 500ms                       |
| Snapshot size (5K entities) | ~700 KB (JSON)          | ~30 KB (gz)             | ~30 KB (gz)               | ~30 KB (gz)                 |
| Decode time                 | ~15ms (JSON.parse)      | <0.1ms                  | <0.1ms                    | <0.1ms                      |
| GCS writes/day (3 formats)  | N/A                     | 8,640                   | 25,920                    | 51,840                      |
| GCS write cost/day          | N/A                     | $0.04                   | **$0.13**                 | **$0.26**                   |
| **Monthly GCS ops cost**    | N/A                     | $1.30                   | **$3.90**                 | **$7.80**                   |
| Late data risk              | N/A                     | Low                     | Low                       | ⚠️ Medium (tight watermark) |

### Watermark Trade-offs

Tighter watermarks reduce latency but increase the risk of **late data** — events that arrive after the watermark has passed their window. Late data is silently dropped by Flink.

| Watermark  | Max late arrival                   | Risk                             | Mitigation                                                |
| ---------- | ---------------------------------- | -------------------------------- | --------------------------------------------------------- |
| 10 seconds | Events up to 10s late are included | Very safe                        | —                                                         |
| 5 seconds  | Events up to 5s late are included  | Safe for most telemetry          | Kafka producer acks=1, low-latency network                |
| 2 seconds  | Events up to 2s late are included  | ⚠️ Risky for high-jitter sources | Requires gNMI with low-jitter transport, co-located Kafka |
| 0 seconds  | Processing-time semantics          | ❌ Not event-time accurate       | Only for "best effort" displays                           |

> [!WARNING]
> For network monitoring, a **5-second watermark** is the recommended floor. Satellite network telemetry has inherent jitter from space-to-ground links, uplink scheduling, and ground station routing. A 2-second watermark would likely drop 1–5% of events during congestion or handoff periods.

### Recommended Profile for Network Monitoring

**Profile B (10-second tumbling windows, 5s watermark)** is the sweet spot:

- **~12–18 second time skew** — well within the 1-2 minute target, 3× faster than most monitoring systems
- **5-second watermark** — safe for satellite network jitter
- **25,920 GCS writes/day** — $3.90/month, negligible cost
- **Direct GCS via PGA** — can optionally bypass CDN (TTL=0) for zero-cache latency
- **80 KB H3F snapshots** — transfer in <1ms on corporate network

For operations dashboard that require absolute minimum latency (e.g., real-time position tracking), a **Tier 3 + Profile C hybrid** can achieve 3-5 second skew on specific layers while keeping cost-efficient 10-second windows on heatmap/metrics layers.

```yaml
# Mixed-profile monitoring config
layers:
  - type: gfb
    name: 'Aircraft Positions'
    manifest: ./data/fleet/manifest.json
    streaming:
      pollInterval: 500 # 500ms — aggressive for positions
      # Flink writes 5-second tumbling windows for this layer

  - type: h3f
    name: 'Network Demand Heatmap'
    manifest: ./data/demand/manifest.json
    streaming:
      pollInterval: 2000 # 2s — relaxed for heatmap
      # Flink writes 10-second tumbling windows for this layer
```

---

## Data Transfer: Why PGA Changes Everything

With Private Google Access, the entire cloud → corporate network transfer model flips. Instead of paying per-GB egress, **all GCS/CDN traffic is free** because it never touches the public internet.

### Transfer Volume Comparison (Cost = $0 for *Flex with PGA)

```
Model A: Grafana + BigQuery (JSON polling)
══════════════════════════════════════════
  432K queries/day × 50 KB JSON = 21.6 GB/day = 648 GB/month
  BQ egress is billed separately from PGA → still costs $78/month
  + BQ query cost: $25,920/month

Model B–D: *Flex via GCS (any tier)
═══════════════════════════════════
  All data served from GCS → Google backbone → corporate VPC
  Transfer cost: $0 (regardless of volume)
  100 users × 150 MB/day = 450 GB/month → $0
```

> [!IMPORTANT]
> PGA eliminates the need for a forward proxy cache on the corporate network. The Google backbone **is** your cache network — 100 users fetching the same shard from GCS all hit Google's internal caching layer at zero cost. The intranet proxy pattern from the original design becomes unnecessary.

---

## Architecture Comparison: Monitoring Use Case

### Cost Summary (100 users, 5 dashboards, 24/7 operations dashboard)

|                      | **Grafana + BQ** | **Tier 1** (Cloud Run) | **Tier 2** (Edge WASM) | **Tier 3** (Full Static) |
| -------------------- | ---------------: | ---------------------: | ---------------------: | -----------------------: |
| Compute (middleware) |           $1,380 |                    $52 |                     $0 |                       $0 |
| Query cost           |          $25,920 |                     $0 |                     $0 |                       $0 |
| Egress (with PGA)    | $626 (BQ egress) |                 **$0** |                 **$0** |                   **$0** |
| GXLB fixed fee       |                — |                      — |                    $18 |                      $18 |
| Storage              |            $0.06 |                  $0.04 |                  $0.04 |                    $0.04 |
| Grafana license      |             $500 |                     $0 |                     $0 |                       $0 |
| **Total/month**      |      **$28,426** |                **$52** |                **$18** |                  **$18** |
| **Annual**           |     **$341,112** |               **$624** |               **$216** |                 **$216** |

> [!IMPORTANT]
> Private Google Access eliminates all egress costs for GCS-served data. Tier 2 and Tier 3 costs are now dominated by the **$18/month GXLB forwarding rule** — the minimum possible GCP networking cost. This is **1,579× cheaper** than the Grafana + BQ architecture.

### Capability Matrix

| Feature                    |   Grafana + BQ    |      Tier 1      |      Tier 2      |     Tier 3     |
| -------------------------- | :---------------: | :--------------: | :--------------: | :------------: |
| Time range picker          |        ✅         |        ✅        |        ✅        |       ✅       |
| Reactive panels            | ✅ (HTTP refresh) |    ✅ (HTTP)     |    ✅ (local)    |    ✅ (GPU)    |
| Live / "Now" mode          |   ✅ (polling)    | ✅ (GCS notify)  |  ✅ (ETag poll)  | ✅ (ETag poll) |
| Playback / scrub           |        ✅         |        ✅        |   ✅ (instant)   |  ✅ (instant)  |
| SQL analytics              |   ✅ (BigQuery)   |   ✅ (DuckDB)    | ✅ (DuckDB-WASM) |       ❌       |
| 3D globe + map             |        ❌         |        ❌        |        ✅        |       ✅       |
| GPU charts                 |        ❌         |        ❌        |        ✅        |       ✅       |
| Offline capable            |        ❌         |        ❌        |        ✅        |       ✅       |
| Alert rules                |   ✅ (Grafana)    |      Custom      |      Custom      |     Custom     |
| Panel refresh              |     500ms-3s      |      ~50ms       |       <5ms       |      <2ms      |
| Configurable (declarative) |     ✅ (JSON)     |    ✅ (YAML)     |    ✅ (YAML)     |   ✅ (YAML)    |
| Grafana interop            |        ✅         | ✅ (JSON plugin) |        ❌        |       ❌       |

---

## Query Engine as Server-Side Data Delivery

For deployments that need server-side querying (Tier 1), the existing query engine architecture serves as the backbone. Here's how it extends into a monitoring API:

### REST Endpoint Design

```
POST /v1/query
{
    "sql": "SELECT region_name, AVG(demand_mbps) FROM h3f_demand AT_EPOCH(842) GROUP BY region_name",
    "format": "json"        // or "arrow" for binary-efficient clients
}

GET /v1/health              // for load balancer health checks
GET /v1/datasets            // list available *Flex datasets
GET /v1/schema/:dataset     // column names, types, epoch ranges
```

### Streaming Data Reload

```
GCS Object Finalize event
    → Pub/Sub notification
        → Cloud Run receives push
            → Fetch new `latest` shard from GCS (~30 KB, <50ms)
            → Swap Arrow table in DuckDB (<5ms)
            → Next query sees fresh data

Total latency from Flink write → query availability: ~2-5 seconds
```

### Scaling Pattern

| Users    | Cloud Run Instances | vCPU Total | Monthly |
| -------- | ------------------- | ---------- | ------- |
| 1–50     | 1 (min instance)    | 2          | $52     |
| 50–200   | 2 (auto-scale)      | 4          | $104    |
| 200–1000 | 4                   | 8          | $208    |

Cloud Run auto-scales based on concurrent requests. Each instance holds the full dataset in memory (~1.74 GB). No shared state, no Redis, no coordination.

---

## Hybrid Architecture: Best of All Worlds

For maximum flexibility, combine tiers:

```
┌────────────────────────────────────────────────────────────────────┐
│                    globe-config.yaml                               │
│                                                                    │
│  # Visualization layers → Tier 3 (GPU-direct)                      │
│  layers:                                                           │
│    - type: h3f                                                     │
│      manifest: https://cdn.globe.io/v1/demand/manifest.json        │
│                                                                    │
│  # Statistical charts → Tier 2 (DuckDB-WASM in Web Worker)         │
│  charts:                                                           │
│    - type: histogram                                               │
│      source: h3f                                                   │
│      attribute: demand_mbps                                        │
│                                                                    │
│  # Ad-hoc SQL terminal → Tier 1 (Cloud Run query engine)           │
│  queryEngine:                                                      │
│    endpoint: https://query.globe.io/v1                             │
│    auth: iap                                                       │
└────────────────────────────────────────────────────────────────────┘
```

- **Map visualization** loads *Flex shards directly from CDN → GPU (Tier 3)
- **Charts** use DuckDB-WASM in a Web Worker for interactive stats (Tier 2)
- **Power users** open a SQL console that queries the Cloud Run engine (Tier 1)

All three tiers share the **same data files** on the **same GCS bucket** behind the **same CDN and IAP**. No data duplication.

---

## Executive Summary

| Metric                                 | **Grafana + BQ**                     | **Globe Trotter Monitoring**   |
| -------------------------------------- | ------------------------------------ | ------------------------------ |
| Monthly cost (100 users, 5 dashboards) | **$28,426**                          | **$18 – $52**                  |
| Annual cost                            | **$341,112**                         | **$216 – $624**                |
| Annual savings                         | —                                    | **~$340,500 – $340,900**       |
| Panel refresh latency                  | 500ms – 3s                           | **< 2ms – 50ms**               |
| Time scrub latency                     | 1–5s (new query per panel)           | **< 2ms** (in-memory)          |
| Cloud → intranet transfer cost         | $626/month (BQ egress)               | **$0** (Private Google Access) |
| Architecture components                | BQ + K8s + Redis + Grafana           | **GCS + GXLB**                 |
| Middleware to maintain                 | REST API, data source plugins, cache | **None**                       |
| Can work offline                       | ❌                                   | **✅**                         |

> [!CAUTION]
> **What we lose relative to Grafana:** Community plugin ecosystem, built-in alerting rules engine, team/RBAC/annotation system, and the familiarity of a battle-tested UI. These are real trade-offs. For a focused network monitoring use case with a custom dashboard, the **1,579× cost savings** and **100× performance improvement** justify building the monitoring UI in-house.
