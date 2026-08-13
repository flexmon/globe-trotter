# @globe-trotter/flexdb-client

**Arrow IPC HTTP client for FlexDB** — the shared JavaScript client used by the Flex Query Engine and Globe Trotter to execute SQL queries against the FlexDB Rust service and receive results as zero-copy Apache Arrow tables.

---

## Prerequisites

| Requirement        | Version  | Notes                                                                       |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| **FlexDB running** | —        | See [FlexDB README](../../services/flexdb/README.md) for start instructions |
| **apache-arrow**   | ≥ 17.0.0 | Peer dependency — install alongside this package                            |

---

## Installation

```bash
# From within a consuming package (e.g. flex-query-engine, globe-trotter)
# The package is resolved via workspace alias or relative import
npm install apache-arrow
```

The package exports from `src/index.js` — no build step required.

---

## Usage

```js
import { FlexDBClient } from '@globe-trotter/flexdb-client';

const client = new FlexDBClient('http://localhost:8090');

// Execute SQL query (Arrow IPC decode with JSON fallback)
const result = await client.query(
  'SELECT airline, SUM(revenue_usd) FROM airline_revenue GROUP BY airline'
);
console.log(result.columns); // ['airline', 'SUM(revenue_usd)']
console.log(result.rows); // [{ airline: 'Delta', ... }, ...]
console.log(result.elapsed); // 45.2 (ms, client-measured)
console.log(result.rowsScanned); // 109,674,720
console.log(result.bytesScanned); // 438,699,520

// List available tables
const tables = await client.listTables();
// [{ name: 'demand_metrics', format: 'h3flex-sharded', entity_count: 1472833, ... }]
```

---

## Features

- **Arrow IPC first** — requests `format=arrow`, decodes via `apache-arrow` `tableFromIPC()` for maximum throughput
- **JSON fallback** — automatically falls back to JSON response if server returns JSON
- **Scan stats** — reads `x-rows-scanned` / `x-bytes-scanned` custom headers from FlexDB responses
- **Timestamp formatting** — Arrow Timestamp columns are formatted as UTC datetime strings
- **BigInt coercion** — Arrow BigInt values are coerced to JavaScript Numbers
- **Connection error handling** — clear error messages when FlexDB is unreachable

---

## API

### `new FlexDBClient(baseUrl)`

| Parameter | Type     | Description                                      |
| --------- | -------- | ------------------------------------------------ |
| `baseUrl` | `string` | FlexDB server URL (e.g. `http://localhost:8090`) |

### `client.query(sql)` → `Promise<QueryResult>`

| Field          | Type       | Description                         |
| -------------- | ---------- | ----------------------------------- |
| `columns`      | `string[]` | Column names                        |
| `rows`         | `Object[]` | Row objects (column name → value)   |
| `elapsed`      | `number`   | Client-measured execution time (ms) |
| `rowsScanned`  | `number`   | Source rows scanned by FlexDB       |
| `bytesScanned` | `number`   | Source bytes scanned by FlexDB      |

### `client.listTables()` → `Promise<TableInfo[]>`

Returns metadata for all registered FlexDB tables.

---

## Project Structure

```
lib/packages/flexdb-client/
├── src/
│   ├── index.js           ← Package entry (re-exports FlexDBClient)
│   └── FlexDBClient.js    ← Arrow IPC HTTP client implementation
├── package.json
└── README.md
```

---

## Related

- [FlexDB README](../../services/flexdb/README.md) — The server this client connects to
- [Flex Query Engine](../../tools/flex-query-engine/README.md) — Primary consumer of this client
- [FlexDB Skill](../../.agents/skills/flexdb/SKILL.md) — Detailed architecture for AI agents
