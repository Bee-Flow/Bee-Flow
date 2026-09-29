// @typecheck
/**
 * geoDbFetch — download the free DB-IP Lite databases (City + ASN).
 *
 * DB-IP Lite is CC BY 4.0: free to use and redistribute with the attribution
 * "IP Geolocation by DB-IP" linking https://db-ip.com (NOTICE.md, the map
 * footnote, the overview API). A new edition appears every month at a fixed
 * URL, no account or key:
 *   https://download.db-ip.com/free/dbip-<city|asn>-lite-YYYY-MM.mmdb.gz
 *
 * Used by `npm run geo:fetch` (scripts/fetch-geo-db.mjs, local dev) and by the
 * opt-in monthly refresh in geoDb.js (GEO_DB_AUTO_UPDATE=monthly). The image
 * gets its copy at build time (the `geo` stage of server/Dockerfile).
 *
 * Every file is checked before it replaces anything: the gzip must inflate
 * (its CRC is verified), the result must pass a minimum size, and maxmind
 * must be able to open it and answer a known address. Written to a temp file
 * and renamed, so a reader never sees half a database.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gunzip = promisify(zlib.gunzip);

const BASE_URL = 'https://download.db-ip.com/free';

// Minimum inflated sizes: the 2026 editions are ~130 MB (city) and ~10 MB
// (asn). A file far below that is a truncated download or an error page.
const KINDS = {
    city: { minBytes: 20 * 1024 * 1024, check: (r) => typeof r?.country?.iso_code === 'string' },
    asn: { minBytes: 1024 * 1024, check: (r) => Number.isInteger(r?.autonomous_system_number) },
};
const PROBE_IP = '8.8.8.8';

/** 'YYYY-MM' of `date` (UTC). */
function monthOf(date) {
    return date.toISOString().slice(0, 7);
}

/** This month, then the previous one: a new edition can lag the 1st by a day. */
function monthsToTry(now = new Date()) {
    const cur = monthOf(now);
    const prev = monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
    return [cur, prev];
}

function fileName(kind, month) {
    return `dbip-${kind}-lite-${month}.mmdb`;
}

/** The newest DB-IP Lite file of `kind` in `dir`: { month, file } or null. */
function newestLocal(dir, kind) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return null; }
    const re = new RegExp(`^dbip-${kind}-lite-(\\d{4}-\\d{2})\\.mmdb$`);
    const hits = names.map(n => n.match(re)).filter(Boolean).sort((a, b) => b[1].localeCompare(a[1]));
    return hits.length ? { month: hits[0][1], file: path.join(dir, hits[0][0]) } : null;
}

/**
 * Throws unless `buf` is a usable mmdb of `kind`. Returns its metadata.
 * @param {Buffer} buf
 * @param {'city'|'asn'} kind
 */
function validateMmdb(buf, kind) {
    const spec = KINDS[kind];
    if (!spec) throw new Error(`unknown geo database kind '${kind}'`);
    if (!Buffer.isBuffer(buf) || buf.length < spec.minBytes) {
        throw new Error(`${kind} database too small (${buf?.length || 0} bytes)`);
    }
    const { Reader } = require('maxmind');
    const reader = new Reader(buf);
    if (!spec.check(reader.get(PROBE_IP))) throw new Error(`${kind} database does not answer ${PROBE_IP}`);
    return reader.metadata;
}

/**
 * Download one edition. Resolves the inflated buffer, or null on a 404 (that
 * month is not published yet). Any other failure throws.
 */
async function _download(kind, month, fetchImpl, timeoutMs) {
    const url = `${BASE_URL}/dbip-${kind}-lite-${month}.mmdb.gz`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    const gz = Buffer.from(await res.arrayBuffer());
    if (gz[0] !== 0x1f || gz[1] !== 0x8b) throw new Error(`GET ${url} did not return gzip`);
    return gunzip(gz);
}

/**
 * Make sure `dir` holds a current City and ASN edition.
 *
 * @param {object} opts
 * @param {string} opts.dir
 * @param {Array<'city'|'asn'>} [opts.kinds]
 * @param {Date} [opts.now]
 * @param {boolean} [opts.force]     download even when the current month is present
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Array<{kind:string, month:string, file:string, downloaded:boolean}>>}
 */
async function fetchGeoDb({ dir, kinds = ['city', 'asn'], now = new Date(), force = false, fetchImpl = fetch, timeoutMs = 10 * 60 * 1000 }) {
    fs.mkdirSync(dir, { recursive: true });
    const months = monthsToTry(now);
    const out = [];
    for (const kind of kinds) {
        const have = newestLocal(dir, kind);
        if (have && !force && have.month >= months[0]) {
            out.push({ kind, month: have.month, file: have.file, downloaded: false });
            continue;
        }
        let done = null;
        for (const month of months) {
            if (have && !force && have.month >= month) break; // nothing newer to get
            const buf = await _download(kind, month, fetchImpl, timeoutMs);
            if (!buf) continue;
            validateMmdb(buf, kind);
            const file = path.join(dir, fileName(kind, month));
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, buf);
            fs.renameSync(tmp, file);
            // Keep one edition per kind: the reader picks the newest anyway,
            // and each city file is ~130 MB.
            for (const name of fs.readdirSync(dir)) {
                if (name !== path.basename(file) && new RegExp(`^dbip-${kind}-lite-\\d{4}-\\d{2}\\.mmdb$`).test(name)) {
                    fs.rmSync(path.join(dir, name), { force: true });
                }
            }
            done = { kind, month, file, downloaded: true };
            break;
        }
        if (!done && have) done = { kind, month: have.month, file: have.file, downloaded: false };
        if (!done) throw new Error(`no DB-IP ${kind} edition found for ${months.join(' or ')}`);
        out.push(done);
    }
    return out;
}

module.exports = { fetchGeoDb, validateMmdb, monthsToTry, newestLocal, fileName, BASE_URL };
