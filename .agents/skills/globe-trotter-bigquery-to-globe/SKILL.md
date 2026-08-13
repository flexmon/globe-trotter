---
name: globe-trotter-bigquery-to-globe
description: End-to-end workflow for querying BigQuery data and visualizing it on the Globe Trotter globe via H3F and GFB formats.
---

# BigQuery to Globe Trotter

End-to-end workflow for querying BigQuery, transforming results into H3F/GFB, and visualizing on the globe.

## When to use this skill

- Use this when pulling geospatial data from BigQuery for globe visualization
- Use this when building H3 hex aggregations from BigQuery tables
- Use this when extracting feature trajectories for GFB point animation
- Use this when connecting the BigQuery MCP server to Globe Trotter

## How to use it

### Step 1: Query BigQuery

**H3 Aggregation** (for H3F):

```sql
SELECT
  `bq-gis`.h3.ST_H3(ST_GEOGPOINT(lon, lat), 4) AS h3_cell,
  TIMESTAMP_TRUNC(ts, INTERVAL 5 MINUTE) AS epoch,
  SUM(supply_mbps) AS supply_mbps
FROM `project.dataset.table`
GROUP BY h3_cell, epoch
```

**Point Trajectories** (for GFB):

```sql
SELECT flight_id, TIMESTAMP_TRUNC(ts, INTERVAL 5 MINUTE) AS epoch,
  lon, lat, altitude_ft AS alt, airline
FROM `project.flights.positions`
ORDER BY epoch, flight_id
```

### Step 2: Export to Python

```python
from google.cloud import bigquery
client = bigquery.Client()
df = client.query(query).to_dataframe()
```

Or via the BigQuery MCP tool:

```
mcp_bigquery_execute_sql(sql=query)
```

### Step 3: Transform to Binary

Use the `@globe-trotter/data-sdk` encoders:

**H3F** (hexagonal aggregation):

```javascript
import { H3FlexEncoder } from '../../lib/packages/data-sdk/src/index.js';

const encoder = new H3FlexEncoder({ epochInterval: 300, epochCount });
encoder.setCells(cellIds, cellCenters);
encoder.setTemporalData('supply_mbps', supplyFloat32);
await encoder.encode({ output: './public/data/', baseName: 'supply', cellToBoundary });
```

**GFB** (point trajectories):

```javascript
import { GeoFlexEncoder } from '../../lib/packages/data-sdk/src/index.js';

const encoder = new GeoFlexEncoder({
  featureCount,
  epochCount,
  epochInterval: 300,
  hasAltitude: true,
});
encoder.setPositions(positionsFloat32);
await encoder.encode({ output: './public/data/', baseName: 'flights' });
```

See the `globe-trotter-data-pipeline` skill and `docs/data-sdk-guide.md` for full patterns.

### Step 4: Generate Metadata (optional)

Use `--generate-metadata` to auto-infer column descriptions:

```bash
node scripts/starlink-leo-sim/generate-leo-h3f.js --generate-metadata
```

This creates a `metadata.yaml` file that enriches the Layer Manager info overlay with human-readable descriptions for each column.

### Step 5: Configure YAML

```yaml
layers:
  - name: Supply Coverage
    type: h3f-sharded
    url: /data/supply.manifest.json
    extrusionScale: 0.012
    style:
      type: ramp
      attribute: supply_mbps
      domain: [0, 100]
      stops: ['#0D1A80', '#0D73BF', '#1ABF59', '#D9D91A', '#F23319']
```

### Common BigQuery Patterns

- **Time bucketing**: `TIMESTAMP_TRUNC(ts, INTERVAL 5 MINUTE)`
- **H3 cell assignment**: `bq-gis.h3.ST_H3(ST_GEOGPOINT(lon, lat), resolution)`
- **Dictionary building**: `SELECT DISTINCT category FROM table ORDER BY category`
