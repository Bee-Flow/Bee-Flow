// @typecheck
/**
 * geoDb — IP → { country, region, city, lat, lon, asn, as_org }, on this box.
 *
 * Every recorded outbound call is located against two MaxMind-format files:
 * a City database and an ASN database. By default the free DB-IP Lite editions
 * (CC BY 4.0, "IP Geolocation by DB-IP", https://db-ip.com); a self-hoster can
 * drop in a commercial GeoIP2 or DB-IP file instead, it is found by name
 * (`*city*.mmdb`, `*asn*.mmdb`). No lookup ever leaves the box: when the files
 * are missing the answer is "unknown", never a third-party service.
 *
 * Where the files come from, in order:
 *   GEO_DB_DIR       an explicit directory; wins outright when it has a file
 *   /app/data/geo    the data volume: the opt-in monthly refresh writes here
 *   /app/geo         baked into the image at build time (server/Dockerfile)
 *   server/data/geo  a dev checkout (`npm run geo:fetch`)
 * Among the last three the most recently written file wins, so a refreshed
 * copy on the volume beats the image and a newer image beats a refresh that
 * was switched off months ago.
 *
 * Loading is ASYNCHRONOUS and starts on the first call to load() (the ledger
 * starts it at boot): the City file is ~130 MB and reading it synchronously on
 * the first lookup would stall the event loop. Until it is in, lookupIp()
 * returns null. A change in any watched directory reloads, debounced.
 *
 * GEO_DB_AUTO_UPDATE=monthly (off by default) checks once a day whether the
 * loaded edition is older than this month and, if so, downloads the new one
 * into /app/data/geo (or GEO_DB_DIR) and reloads.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const log = require('../../../telemetry/log');
const { canonicalIp } = require('../ipClass');

const DEV_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'geo');
const VOLUME_DIR = '/app/data/geo';
const IMAGE_DIR = '/app/geo';
const RELOAD_DEBOUNCE_MS = 2000;
const UPDATE_FIRST_DELAY_MS = 60 * 1000;
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;

/** @typedef {{ get(ip: string): any }} MmdbReader */
/** @typedef {{ file: string|null, edition: string|null, date: string|null, _mtime?: number }} DbInfo */

/** @type {{ city: MmdbReader|null, asn: MmdbReader|null, cityInfo: DbInfo|null, asnInfo: DbInfo|null }} */
let _state = { city: null, asn: null, cityInfo: null, asnInfo: null };
/** @type {Promise<void>|null} */
let _loadPromise = null;
/** @type {fs.FSWatcher[]} */
let _watchers = [];
let _reloadTimer = null;
let _updateTimer = null;
let _warnedMissing = false;

function _sources() {
    // In the image DEV_DIR resolves to /app/data/geo too: listed once.
    return { override: process.env.GEO_DB_DIR || null, dirs: [...new Set([VOLUME_DIR, IMAGE_DIR, DEV_DIR])] };
}

function _matches(name, kind) {
    const lower = String(name).toLowerCase();
    return lower.endsWith('.mmdb') && lower.includes(kind);
}

/** Newest `kind` file in one directory: { file, mtimeMs } or null. */
function _newestIn(dir, kind) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return null; }
    let best = null;
    for (const name of names) {
        if (!_matches(name, kind)) continue;
        const file = path.join(dir, name);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        if (!st.isFile() || st.size === 0) continue;
        if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
    }
    return best;
}

/** The file to load for `kind`, per the source order in the header. */
function _pick(kind) {
    const { override, dirs } = _sources();
    if (override) {
        const hit = _newestIn(override, kind);
        if (hit) return hit.file;
    }
    let best = null;
    for (const dir of dirs) {
        const hit = _newestIn(dir, kind);
        if (hit && (!best || hit.mtimeMs > best.mtimeMs)) best = hit;
    }
    return best ? best.file : null;
}

/** 'DBIP-City-Lite' → 'dbip-city-lite'; buildEpoch → 'YYYY-MM'. */
function _info(file, metadata) {
    const type = String(metadata?.databaseType || '').split(' ')[0].toLowerCase() || null;
    const built = metadata?.buildEpoch instanceof Date && !Number.isNaN(metadata.buildEpoch.getTime())
        ? metadata.buildEpoch.toISOString().slice(0, 7)
        : null;
    return { file, edition: type, date: built };
}

async function _open(file) {
    const maxmind = require('maxmind');
    const reader = await maxmind.open(file);
    return { reader, info: _info(file, reader.metadata) };
}

/** (Re)load both files. A failed load keeps whatever was loaded before. */
async function _reload() {
    const next = { ..._state };
    for (const kind of /** @type {const} */ (['city', 'asn'])) {
        const file = _pick(kind);
        const current = kind === 'city' ? _state.cityInfo : _state.asnInfo;
        if (!file) continue;
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { /* raced with a rename */ }
        if (current && current.file === file && current._mtime === mtime) continue;
        try {
            const { reader, info } = await _open(file);
            const withMtime = { ...info, _mtime: mtime };
            if (kind === 'city') { next.city = reader; next.cityInfo = withMtime; }
            else { next.asn = reader; next.asnInfo = withMtime; }
            log.info(`[geoDb] loaded ${kind} ${info.edition || '?'} ${info.date || ''} from ${file}`);
        } catch (err) {
            log.warn(`[geoDb] could not load ${kind} database ${file}: ${err.message}`);
        }
    }
    _state = next;
    if (!_state.city && !_warnedMissing) {
        _warnedMissing = true;
        log.warn('[geoDb] no IP location database found (GEO_DB_DIR, /app/data/geo, /app/geo, server/data/geo): '
            + 'outbound calls are recorded with an unknown location. Run `npm run geo:fetch` in a dev checkout.');
    }
}

function _scheduleReload() {
    if (_reloadTimer) clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => {
        _reloadTimer = null;
        _reload().catch(err => log.warn('[geoDb] reload failed:', err.message));
    }, RELOAD_DEBOUNCE_MS);
    _reloadTimer.unref?.();
}

function _watch() {
    const { override, dirs } = _sources();
    for (const dir of new Set([override, ...dirs].filter(Boolean))) {
        try {
            const w = fs.watch(dir, { persistent: false }, (_event, name) => {
                if (!name || String(name).toLowerCase().endsWith('.mmdb')) _scheduleReload();
            });
            w.on('error', () => { /* directory removed: the next load() re-reads the sources */ });
            _watchers.push(w);
        } catch { /* directory absent */ }
    }
}

// ── Opt-in monthly refresh ──────────────────────────────────────────────────

function _autoUpdateEnabled() {
    return String(process.env.GEO_DB_AUTO_UPDATE || '').toLowerCase() === 'monthly';
}

async function _autoUpdate(fetchImpl) {
    const { fetchGeoDb, monthsToTry } = require('./geoDbFetch');
    const current = monthsToTry()[0];
    if (_state.cityInfo?.date && _state.cityInfo.date >= current
        && _state.asnInfo?.date && _state.asnInfo.date >= current) return false;
    const dir = process.env.GEO_DB_DIR || VOLUME_DIR;
    const results = await fetchGeoDb({ dir, ...(fetchImpl ? { fetchImpl } : {}) });
    if (results.some(r => r.downloaded)) {
        log.info(`[geoDb] monthly refresh downloaded ${results.filter(r => r.downloaded).map(r => `${r.kind} ${r.month}`).join(', ')}`);
        await _reload();
        return true;
    }
    return false;
}

function _startAutoUpdate() {
    if (!_autoUpdateEnabled() || _updateTimer) return;
    const tick = () => _autoUpdate().catch(err => log.warn('[geoDb] monthly refresh failed:', err.message));
    _updateTimer = setTimeout(function run() {
        tick();
        _updateTimer = setTimeout(run, UPDATE_EVERY_MS);
        _updateTimer.unref?.();
    }, UPDATE_FIRST_DELAY_MS);
    _updateTimer.unref?.();
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Start (once) and await the initial load. Never rejects. */
function load() {
    if (!_loadPromise) {
        _loadPromise = _reload()
            .catch(err => log.warn('[geoDb] initial load failed:', err.message))
            .then(() => { _watch(); _startAutoUpdate(); });
    }
    return _loadPromise;
}

const _round2 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const _en = (o) => (o && o.names && (o.names.en || Object.values(o.names)[0])) || null;
/** 'San Francisco (Financial District)' → 'San Francisco'. */
const _cityName = (s) => (s ? String(s).replace(/\s*\(.*\)\s*$/, '').trim() || null : null);

/**
 * Synchronous lookup. null when the address is not an IP, is not in either
 * database, or the databases are not loaded (yet).
 * @returns {{ country_code: string|null, region: string|null, city: string|null,
 *             lat: number|null, lon: number|null, asn: number|null, as_org: string|null } | null}
 */
function lookupIp(ip) {
    if (!_loadPromise) load();
    const addr = canonicalIp(ip);
    if (!addr) return null;
    let c = null, a = null;
    try { c = _state.city ? _state.city.get(addr) : null; } catch { c = null; }
    try { a = _state.asn ? _state.asn.get(addr) : null; } catch { a = null; }
    if (!c && !a) return null;
    const cc = c?.country?.iso_code || c?.registered_country?.iso_code || null;
    return {
        country_code: cc ? String(cc).toUpperCase() : null,
        region: _en(c?.subdivisions?.[0]),
        city: _cityName(_en(c?.city)),
        lat: _round2(c?.location?.latitude),
        lon: _round2(c?.location?.longitude),
        asn: Number.isInteger(a?.autonomous_system_number) ? a.autonomous_system_number : null,
        as_org: a?.autonomous_system_organization || null,
    };
}

/** { available, edition, date, asn_available } — `available` means the City database is loaded. */
function status() {
    return {
        available: !!_state.city,
        edition: _state.cityInfo?.edition || null,
        date: _state.cityInfo?.date || null,
        asn_available: !!_state.asn,
    };
}

/**
 * Test seam: install fake readers ({ get(ip) }) and mark the load done, so no
 * test ever reads a 130 MB file. Pass nothing to simulate a missing database.
 */
function __setReadersForTests({ city = null, asn = null, edition = 'dbip-city-lite', date = '2026-09' } = {}) {
    __resetForTests();
    _state = {
        city, asn,
        cityInfo: city ? { file: null, edition, date } : null,
        asnInfo: asn ? { file: null, edition: 'dbip-asn-lite', date } : null,
    };
    _loadPromise = Promise.resolve();
}

function __resetForTests() {
    for (const w of _watchers) { try { w.close(); } catch { /* already closed */ } }
    _watchers = [];
    if (_reloadTimer) clearTimeout(_reloadTimer);
    if (_updateTimer) clearTimeout(_updateTimer);
    _reloadTimer = null;
    _updateTimer = null;
    _state = { city: null, asn: null, cityInfo: null, asnInfo: null };
    _loadPromise = null;
    _warnedMissing = false;
}

module.exports = {
    load,
    lookupIp,
    status,
    __setReadersForTests,
    __resetForTests,
    _autoUpdate, // exported for tests (the monthly refresh decision)
    _pick,       // exported for tests (source order)
};
