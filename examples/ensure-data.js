/**
 * ensure-data.js — Pre-setup check for Globe Trotter sample data.
 *
 * Checks whether sample data exists in public/data/mobile-demand-sim/.
 * If not, runs the data generators automatically.
 * After generation (or if data already exists), ensures a catalog config
 * is written to public/catalog/demo-catalog.yaml to bootstrap the app.
 *
 * Usage: Called by `npm run setup` (NOT by `npm run dev`).
 */
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'public', 'data', 'mobile-demand-sim');

// Check for the manifest files that indicate data has been generated
const h3Manifest = resolve(DATA_DIR, 'demand_metrics.manifest.json');
const gfbManifest = resolve(DATA_DIR, 'aircraft_tracks.manifest.json');
const mfbFile = resolve(DATA_DIR, 'airline_revenue.manifest.json');
const CATALOG_DIR = resolve(ROOT, 'public', 'catalog');
const catalogConfig = resolve(CATALOG_DIR, 'demo-catalog.yaml');

if (existsSync(h3Manifest) && existsSync(gfbManifest) && existsSync(mfbFile)) {
  // Data exists — ensure the catalog config YAML is present
  if (!existsSync(catalogConfig)) {
    mkdirSync(CATALOG_DIR, { recursive: true });
    writeGlobeConfig(catalogConfig);
  }
  console.log('✅ Sample data already exists in public/data/mobile-demand-sim/ — skipping generation.\n');
  process.exit(0);
}

console.log('📦 Sample data not found in public/data/mobile-demand-sim/ — generating...\n');
console.log('   This is a one-time setup and may take a minute.\n');

try {
  // Install root dependencies if needed (generators use h3-js etc.)
  if (!existsSync(resolve(ROOT, 'node_modules', 'h3-js'))) {
    console.log('📥 Installing root dependencies...');
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
  }

  // Run data generators
  console.log('\n🌍 Generating H3F demand metrics...');
  execSync('npm run generate:h3', { cwd: ROOT, stdio: 'inherit' });

  console.log('\n✈️  Generating GFB aircraft tracks...');
  execSync('npm run generate:gfb', { cwd: ROOT, stdio: 'inherit' });

  console.log('\n💰 Generating MFB airline revenue...');
  execSync('npm run generate:mfb', { cwd: ROOT, stdio: 'inherit' });

  // Generate catalog config YAML (dataset-specific name, absolute /data/ paths)
  mkdirSync(CATALOG_DIR, { recursive: true });
  writeGlobeConfig(catalogConfig);

  console.log('\n✅ Data generation complete!\n');
} catch (err) {
  console.error('\n❌ Data generation failed:', err.message);
  console.error('   You can generate data manually from the project root: npm run generate\n');
  process.exit(1);
}

// ─── Catalog Config Generator ────────────────────────────────────────────────
// Generates the catalog YAML at public/catalog/demo-catalog.yaml
// Uses absolute /data/ paths so config works with both local dev and CDN.

function writeGlobeConfig(outPath) {
  // Airline brand colors — matches the categorical palette in the generator
  const airlineColors = {
    'Delta': '#001E70',
    'United': '#003D87',
    'American': '#B31B2C',
    'Southwest': '#E07816',
    'JetBlue': '#003D9E',
    'Alaska': '#004D80',
    'Spirit': '#FAD900',
    'Air Canada': '#F21121',
    'WestJet': '#00A16B',
    'Aeromexico': '#002E6B',
    'British Airways': '#BA1228',
    'Lufthansa': '#00286F',
    'Air France': '#002E8C',
    'KLM': '#00A1E3',
    'Ryanair': '#0A3385',
    'Turkish Airlines': '#E50D24',
    'Swiss': '#E30021',
    'Iberia': '#D6AB00',
    'SAS': '#002163',
    'TAP Portugal': '#00876E',
    'Singapore Airlines': '#003D87',
    'Cathay Pacific': '#00604D',
    'ANA': '#002E87',
    'JAL': '#CC041C',
    'Korean Air': '#0A4587',
    'Thai Airways': '#611A8D',
    'Air India': '#E05900',
    'Qantas': '#E50D24',
    'Air New Zealand': '#001F3D',
    'China Southern': '#003D87',
    'Emirates': '#D10014',
    'Qatar Airways': '#5C1237',
    'Etihad': '#B08C43',
    'Saudia': '#00664D',
    'LATAM': '#001245',
    'Avianca': '#E50D24',
    'GOL': '#FF7000',
    'Ethiopian Airlines': '#008745',
    'South African Airways': '#003387',
  };

  // Build the airline categories YAML block
  const categoryLines = Object.entries(airlineColors)
    .map(([name, color]) => `        ${name}: "${color}"`)
    .join('\n');

  const yaml = `# Globe Trotter — Mobile Demand Simulation
# Catalog config — uses absolute /data/ paths for consistency between local dev and CDN.
#
# Local dev:  http://localhost:5173/?globeconf=/catalog/demo-catalog.yaml
# CDN:        https://<CDN_HOST>/globe-trotter/web/globe-trotter.html?globeconf=/globe-trotter/catalog/demo-catalog.yaml
#
# On CDN, paths are prefixed with /globe-trotter (the bucket name).
# Locally, Vite serves public/ at root so /data/... resolves to public/data/...

# ─── Basemap ───
basemap:
  provider: google
  style: google-satellite

# ─── Camera ───
camera:
  center: [39.0, -98.0]
  altitude: 12000
  tilt: 0
  heading: 0

# ─── Time ───
time:
  enabled: true
  autoplay: true
  speed: 60
  startOffset: "00:00:00"
  loop: true

# ─── Data Layers ───
layers:
  - name: Demand Metrics
    type: h3f-sharded
    url: /data/mobile-demand-sim/demand_metrics.manifest.json
    visible: true
    extrusionScale: 0.012
    style:
      type: ramp
      attribute: demand_mbps
      domain: [0, 60]
      stops: ["#0D1A80", "#0D73BF", "#1ABF59", "#D9D91A", "#F23319"]
      opacityStops:
        - { value: 0,  opacity: 0.0  }
        - { value: 2,  opacity: 0.3  }
        - { value: 15, opacity: 0.55 }
        - { value: 40, opacity: 0.75 }
        - { value: 60, opacity: 0.9  }

  - name: Aircraft Tracks
    type: gfb-sharded
    url: /data/mobile-demand-sim/aircraft_tracks.manifest.json
    visible: true
    extrusionScale: 1.0
    style:
      type: categorical
      attribute: airline
      categories:
${categoryLines}
      default: "#999999"
      opacity: 1.0
    symbol:
      type: 0
      size: 0.015
      scale: 0.3
      zoomAttenuation:
        near: 1.05
        far: 3.0
        minScale: 0.25

  - name: Airline Revenue
    type: mfb
    url: /data/mobile-demand-sim/airline_revenue.manifest.json
    visible: true

# ─── Charts (GPU-rendered overlays) ───
charts:
  - name: Demand Box Plot
    type: boxplot
    source: Demand Metrics
    attribute: demand_mbps
    position: top-right
    size: [420, 180]
    style:
      title: "Demand (Mbps) — Box Plot"
      xLabel: "Time of Day"
      yLabel: "Demand (Mbps)"
      yScale: linear
      domain: [0, 25]
      timeBins: 24
      background: "rgba(4, 6, 12, 0.88)"

  - name: Demand CDF
    type: cdf
    source: Demand Metrics
    attribute: demand_mbps
    position: top-right
    size: [420, 180]
    style:
      title: "Demand (Mbps) — CDF"
      xLabel: "Demand (Mbps)"
      yLabel: "Cumulative %"
      domain: [0, 60]
      background: "rgba(4, 6, 12, 0.88)"

  - name: Demand Histogram
    type: histogram
    source: Demand Metrics
    attribute: demand_mbps
    position: top-right
    size: [420, 180]
    style:
      title: "Demand (Mbps) — Histogram"
      xLabel: "Demand (Mbps)"
      yLabel: "Count"
      yScale: log
      domain: [0, 60]
      binCount: 20
      background: "rgba(4, 6, 12, 0.88)"

  - name: Revenue by Airline
    type: barplot
    source: Airline Revenue
    attribute: revenue_usd
    groupBy: airline
    aggregation: sum
    topN: 10
    position: top-right
    size: [420, 180]
    style:
      title: "Revenue (USD) by Airline — Top 10"
      xLabel: "Airline"
      yLabel: "Revenue (USD)"
      yScale: linear
      timeWindow: 60
      background: "rgba(4, 6, 12, 0.88)"

# ─── SQL Sample Queries (QueryDialog "Samples…" dropdown) ───
queries:
  # ── Demand Metrics (H3F) ──
  - name: "Preview — First 100 cells"
    layer: Demand Metrics
    sql: |
      SELECT h3_cell_id, region_name, demand_mbps
      FROM "Demand Metrics"
      LIMIT 100

  - name: "Avg demand by region"
    layer: Demand Metrics
    sql: |
      SELECT region_name,
             COUNT(*)            AS cell_count,
             ROUND(AVG(demand_mbps), 2)  AS avg_mbps,
             ROUND(MAX(demand_mbps), 2)  AS max_mbps
      FROM "Demand Metrics"
      WHERE demand_mbps > 0
      GROUP BY region_name
      ORDER BY avg_mbps DESC

  - name: "Hot cells (> 30 Mbps)"
    layer: Demand Metrics
    sql: |
      SELECT h3_cell_id, region_name, demand_mbps
      FROM "Demand Metrics"
      WHERE demand_mbps > 30
      ORDER BY demand_mbps DESC
      LIMIT 200

  # ── Aircraft Tracks (GFB) ──
  - name: "Preview — First 100 flights"
    layer: Aircraft Tracks
    sql: |
      SELECT tail_number, airline, demand_mbps
      FROM "Aircraft Tracks"
      LIMIT 100

  - name: "Flights by airline"
    layer: Aircraft Tracks
    sql: |
      SELECT airline,
             COUNT(*)            AS flights,
             ROUND(AVG(demand_mbps), 2)  AS avg_mbps,
             ROUND(SUM(demand_mbps), 2)  AS total_mbps
      FROM "Aircraft Tracks"
      WHERE demand_mbps > 0
      GROUP BY airline
      ORDER BY total_mbps DESC

  - name: "High-demand flights (> 20 Mbps)"
    layer: Aircraft Tracks
    sql: |
      SELECT tail_number, airline, demand_mbps
      FROM "Aircraft Tracks"
      WHERE demand_mbps > 20
      ORDER BY demand_mbps DESC
      LIMIT 200

  # ── Airline Revenue (MFB) ──
  - name: "Preview — First 100 entities"
    layer: Airline Revenue
    sql: |
      SELECT airline, revenue_usd
      FROM "Airline Revenue"
      LIMIT 100

  - name: "Revenue by airline"
    layer: Airline Revenue
    sql: |
      SELECT airline,
             COUNT(*)            AS flights,
             ROUND(SUM(revenue_usd), 2)  AS total_revenue,
             ROUND(AVG(revenue_usd), 4)  AS avg_revenue
      FROM "Airline Revenue"
      WHERE revenue_usd > 0
      GROUP BY airline
      ORDER BY total_revenue DESC

  - name: "Top revenue flights"
    layer: Airline Revenue
    sql: |
      SELECT airline, revenue_usd
      FROM "Airline Revenue"
      WHERE revenue_usd > 0
      ORDER BY revenue_usd DESC
      LIMIT 100

# ─── UI Widgets ───
ui:
  footer: true
  layers: true
  geocoder: true
  time: true
`;

  writeFileSync(outPath, yaml);
  console.log(`📋 Generated catalog config → ${outPath}`);
}
