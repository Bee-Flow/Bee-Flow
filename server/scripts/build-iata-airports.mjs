#!/usr/bin/env node
/**
 * Build core/http/geo/iataAirports.json from OurAirports (public domain).
 *
 * CDNs name their edge by the IATA code of the nearest airport: Cloudflare's
 * `cf-ray: …-AMS`, CloudFront's `x-amz-cf-pop: AMS50-P2`, Fastly's
 * `x-served-by: cache-ams…-AMS`. core/http/geo/edgeLocation.js turns that code
 * into a city and a point on the map with this table.
 *
 * Only large airports, and medium ones with scheduled service, that carry an
 * IATA code (edges sit at cities with real airports), in a compact shape:
 *   { "AMS": ["Amsterdam", "NL", 52.31, 4.76], … }   [city, ISO-2 country, lat, lon]
 * Coordinates are rounded to two decimals (about 1 km): a map pin, not a runway.
 *
 * Usage (from server/):
 *   node scripts/build-iata-airports.mjs                 downloads airports.csv
 *   node scripts/build-iata-airports.mjs --csv <file>    uses a local copy
 * Then commit the regenerated JSON.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'http', 'geo', 'iataAirports.json');
const TYPES = new Map([['large_airport', 2], ['medium_airport', 1]]);

// OurAirports names the municipality of the runway, which for a few airports
// that CDNs use as edge codes is a suburb nobody would recognise on a map
// label ("via Cloudflare, Zaventem"). The city the edge serves instead.
const METRO = {
    ATH: 'Athens', BRU: 'Brussels', DFW: 'Dallas', IAD: 'Washington', KBP: 'Kyiv', KRK: 'Kraków',
    KUL: 'Kuala Lumpur', LJU: 'Ljubljana', LYS: 'Lyon', MRS: 'Marseille', MXP: 'Milan',
    NRT: 'Tokyo', OTP: 'Bucharest', TPE: 'Taipei', ZAG: 'Zagreb',
};

/** 'Paris (Roissy-en-France, Val-d'Oise)' / 'Toulouse/Blagnac' / 'Manchester, Greater Manchester' → the first name. */
function cityName(code, municipality, name) {
    if (METRO[code]) return METRO[code];
    return String(municipality || name).replace(/\s*\(.*\)\s*$/, '').split(/[,/]/)[0].trim();
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
        } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

/** CSV text → { IATA: [city, country, lat, lon] }, larger airport wins a shared code. */
export function buildTable(csvText) {
    const [header, ...rows] = parseCsv(csvText);
    const col = (name) => {
        const i = header.indexOf(name);
        if (i === -1) throw new Error(`airports.csv has no column '${name}'`);
        return i;
    };
    const iType = col('type'), iIata = col('iata_code'), iCity = col('municipality'), iSched = col('scheduled_service');
    const iName = col('name'), iCountry = col('iso_country'), iLat = col('latitude_deg'), iLon = col('longitude_deg');
    const best = new Map();
    for (const r of rows) {
        const rank = TYPES.get(r[iType]);
        const code = String(r[iIata] || '').trim().toUpperCase();
        if (!rank || !/^[A-Z]{3}$/.test(code)) continue;
        if (rank === 1 && r[iSched] !== 'yes') continue;
        const lat = Number(r[iLat]), lon = Number(r[iLon]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const prev = best.get(code);
        if (prev && prev.rank >= rank) continue;
        best.set(code, {
            rank,
            entry: [cityName(code, r[iCity], r[iName]), String(r[iCountry]).trim().toUpperCase(),
                Math.round(lat * 100) / 100, Math.round(lon * 100) / 100],
        });
    }
    const out = {};
    for (const code of [...best.keys()].sort()) out[code] = best.get(code).entry;
    return out;
}

async function main() {
    const csvArg = process.argv.indexOf('--csv');
    const text = csvArg !== -1
        ? fs.readFileSync(process.argv[csvArg + 1], 'utf8')
        : await (await fetch(SOURCE, { signal: AbortSignal.timeout(120000) })).text();
    const table = buildTable(text);
    const n = Object.keys(table).length;
    if (n < 1000) throw new Error(`only ${n} airports parsed; refusing to overwrite ${OUT}`);
    // One entry per line: a regeneration shows up as a readable diff.
    const body = Object.entries(table).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n');
    fs.writeFileSync(OUT, `{\n${body}\n}\n`);
    console.log(`wrote ${n} airports to ${path.relative(process.cwd(), OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => { console.error(`build-iata-airports: ${err.message}`); process.exit(1); });
}
