/**
 * interactive-setup.js — First-run interactive environment setup for Globe Trotter.
 *
 * Prompts the user to configure their basemap API token (Mapbox or Google Maps),
 * then writes a .env file from .env.example with the provided values.
 *
 * Usage: Called automatically by `npm run setup` before data generation.
 */
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ENV_FILE = resolve(ROOT, '.env');
const ENV_EXAMPLE = resolve(ROOT, '.env.example');

// ─── Helpers ────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function log(msg) {
  console.log(`\x1b[36m● ${msg}\x1b[0m`);
}
function success(msg) {
  console.log(`\x1b[32m✔ ${msg}\x1b[0m`);
}
function dim(msg) {
  console.log(`\x1b[2m  ${msg}\x1b[0m`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getEnvValue(content, key) {
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
}

function isValidToken(value) {
  return value.length > 0 && !value.startsWith('your_');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('\x1b[1m🌐 Globe Trotter — Interactive Setup\x1b[0m');
  console.log('');

  // Load existing .env or start from .env.example
  let envContent;
  if (existsSync(ENV_FILE)) {
    envContent = readFileSync(ENV_FILE, 'utf-8');
    log('.env file already exists — updating with your choices.');
  } else if (existsSync(ENV_EXAMPLE)) {
    envContent = readFileSync(ENV_EXAMPLE, 'utf-8');
    log('Creating .env from .env.example template.');
  } else {
    console.error('\x1b[31m✘ No .env.example found. Cannot continue.\x1b[0m');
    rl.close();
    process.exit(1);
  }

  // ── Step 1: Ask about basemap API tokens ──────────────────────────────

  const existingMapbox = getEnvValue(envContent, 'VITE_MAPBOX_TOKEN');
  const existingGoogle = getEnvValue(envContent, 'VITE_GOOGLE_MAPS_API_KEY');

  if (isValidToken(existingMapbox)) {
    success('Mapbox token already set — skipping basemap setup.');
  } else if (isValidToken(existingGoogle)) {
    success('Google Maps API key already set — skipping basemap setup.');
  } else {
    const hasToken = await ask('Do you have a Mapbox or Google Maps API token? (yes/no): ');

    if (/^y(es)?$/i.test(hasToken)) {
      const provider = await ask('Which provider? (mapbox/google): ');

      if (/^m(apbox)?$/i.test(provider)) {
        const token = await ask('Enter your Mapbox token: ');
        if (token) {
          envContent = envContent.replace(/^VITE_MAPBOX_TOKEN=.*$/m, `VITE_MAPBOX_TOKEN=${token}`);
          success('Mapbox token saved.');
        }
      } else if (/^g(oogle)?$/i.test(provider)) {
        const token = await ask('Enter your Google Maps API key: ');
        if (token) {
          envContent = envContent.replace(
            /^VITE_GOOGLE_MAPS_API_KEY=.*$/m,
            `VITE_GOOGLE_MAPS_API_KEY=${token}`
          );
          success('Google Maps API key saved.');
        }
      } else {
        dim(`Unrecognized provider "${provider}" — skipping token setup.`);
      }
    } else {
      dim('No API token provided — the globe will use the default basemap.');
      dim('You can add one later by editing .env (see .env.example for details).');
    }
  }

  // ── Write .env ────────────────────────────────────────────────────────

  writeFileSync(ENV_FILE, envContent, 'utf-8');
  success(`.env written to ${ENV_FILE}`);
  console.log('');

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
