#!/usr/bin/env node
/**
 * Download the DB-IP Lite City + ASN databases for local development.
 *
 * The server geolocates every recorded outbound call against these files,
 * on the box, with no third-party lookup (core/http/geo/geoDb.js). Images get
 * them at build time; a dev checkout gets them from this script.
 *
 * Usage (from server/):
 *   npm run geo:fetch                 current month, falls back to the previous one
 *   npm run geo:fetch -- --force      download again even when the month is present
 *   GEO_DB_DIR=/some/dir npm run geo:fetch
 *
 * Target: GEO_DB_DIR when set, else server/data/geo (gitignored).
 * Licence: CC BY 4.0, attribution "IP Geolocation by DB-IP" (https://db-ip.com).
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { fetchGeoDb, validateMmdb } = require('../core/http/geo/geoDbFetch.js');

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.GEO_DB_DIR || path.join(SERVER_ROOT, 'data', 'geo');
const force = process.argv.includes('--force');

try {
    const results = await fetchGeoDb({ dir, force });
    const fs = await import('node:fs');
    for (const r of results) {
        const meta = validateMmdb(fs.readFileSync(r.file), /** @type {'city'|'asn'} */ (r.kind));
        const built = meta.buildEpoch instanceof Date ? meta.buildEpoch.toISOString().slice(0, 10) : '?';
        console.log(`${r.downloaded ? 'downloaded' : 'up to date'}  ${r.kind.padEnd(4)}  ${r.month}  ${meta.databaseType} (built ${built})  ${r.file}`);
    }
    console.log('IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0.');
} catch (err) {
    console.error(`geo:fetch failed: ${err.message}`);
    process.exit(1);
}
