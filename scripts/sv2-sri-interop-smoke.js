#!/usr/bin/env node
/**
 * Preflight for SV2 ↔ SRI interop: confirms Lido SV2 is enabled and prints
 * authority pubkey + reject counters. Does not perform a Noise/SV2 handshake.
 *
 * Usage:
 *   node scripts/sv2-sri-interop-smoke.js
 *   LIDO_API_BASE=http://127.0.0.1:3334 node scripts/sv2-sri-interop-smoke.js
 *
 * Full checklist: scripts/sv2-sri-interop.md
 */

const base = (process.env.LIDO_API_BASE || 'http://127.0.0.1:3334').replace(/\/$/, '');
const url = `${base}/api/info/sv2`;

async function main() {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(`Failed to reach ${url}: ${err.message}`);
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`HTTP ${res.status} from ${url}`);
    process.exit(1);
  }

  const body = await res.json();
  console.log('SV2 info:', JSON.stringify(body, null, 2));

  if (!body.enabled) {
    console.error('SV2 is disabled. Set ENABLE_STRATUM_V2=true and restart.');
    process.exit(1);
  }

  if (!body.authorityPublicKey) {
    console.error('Missing authorityPublicKey');
    process.exit(1);
  }

  console.log('\nUse authorityPublicKey with SRI translator / mining-device.');
  console.log('Checklist: scripts/sv2-sri-interop.md');
  process.exit(0);
}

main();
