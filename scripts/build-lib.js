#!/usr/bin/env node
/**
 * build-lib.js — Build the @globe-trotter/core library and output to:
 *   dist/globe-trotter/
 *
 * Usage:
 *   node scripts/build-lib.js
 */

import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const outDir = resolve(ROOT, 'dist', 'globe-trotter');

console.log(`\n🌍 Building @globe-trotter/core library`);
console.log(`   Output:  dist/globe-trotter/\n`);

// ── Run Vite library build with custom outDir ──
const libRoot = resolve(ROOT, 'lib/packages/core');

try {
  // Pass 1 — primary entry (globe-trotter.*). Clears the output dir.
  execSync(`npx vite build --outDir "${outDir}" --emptyOutDir`, { cwd: libRoot, stdio: 'inherit' });
  // Pass 2 — advanced entry (globe-trotter-advanced.*). Writes alongside;
  // GT_ENTRY drives the entry + disables emptyOutDir (see vite.config.js).
  execSync(`npx vite build --outDir "${outDir}"`, {
    cwd: libRoot,
    stdio: 'inherit',
    env: { ...process.env, GT_ENTRY: 'advanced' },
  });
} catch {
  console.error('\n❌ Library build failed');
  process.exit(1);
}

console.log(`\n✅ Library built → dist/globe-trotter/`);
console.log(`   Primary:   globe-trotter.es.js / .umd.js`);
console.log(`   Advanced:  globe-trotter-advanced.es.js / .umd.js`);
console.log(`   Source maps: *.map\n`);
