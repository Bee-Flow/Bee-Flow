/**
 * geoDbFetch — month fallback, validation before replace, one edition kept.
 * The fetch is injected; the one test that needs a real mmdb uses the ASN
 * file from `npm run geo:fetch` when present (skipped otherwise).
 *
 * Run: node --test server/core/http/geo/geoDbFetch.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { fetchGeoDb, monthsToTry, newestLocal, validateMmdb } = require('./geoDbFetch');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'geofetch-'));
const res = (status, body = Buffer.alloc(0)) => ({
    status, ok: status >= 200 && status < 300,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
});

test('monthsToTry: this month, then the previous one (across a year)', () => {
    assert.deepStrictEqual(monthsToTry(new Date('2026-09-27T10:00:00Z')), ['2026-09', '2026-08']);
    assert.deepStrictEqual(monthsToTry(new Date('2027-01-01T00:30:00Z')), ['2027-01', '2026-12']);
});

test('a current local edition is not downloaded again', async () => {
    const dir = tmp();
    try {
        fs.writeFileSync(path.join(dir, 'dbip-asn-lite-2026-09.mmdb'), 'x');
        let calls = 0;
        const out = await fetchGeoDb({ dir, kinds: ['asn'], now: new Date('2026-09-27'), fetchImpl: async () => { calls++; return res(404); } });
        assert.strictEqual(calls, 0);
        assert.strictEqual(out[0].downloaded, false);
        assert.strictEqual(out[0].month, '2026-09');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a broken download never replaces the file on disk', async () => {
    const dir = tmp();
    try {
        const keep = path.join(dir, 'dbip-asn-lite-2026-07.mmdb');
        fs.writeFileSync(keep, 'old');
        const notGzip = async () => res(200, Buffer.from('<html>error</html>'));
        await assert.rejects(fetchGeoDb({ dir, kinds: ['asn'], now: new Date('2026-09-27'), fetchImpl: notGzip }), /did not return gzip/);
        const tooSmall = async () => res(200, zlib.gzipSync(Buffer.from('tiny')));
        await assert.rejects(fetchGeoDb({ dir, kinds: ['asn'], now: new Date('2026-09-27'), fetchImpl: tooSmall }), /too small/);
        assert.strictEqual(fs.readFileSync(keep, 'utf8'), 'old');
        assert.deepStrictEqual(fs.readdirSync(dir), ['dbip-asn-lite-2026-07.mmdb'], 'no temp file left behind');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nothing published and nothing local → a clear error', async () => {
    const dir = tmp();
    try {
        await assert.rejects(
            fetchGeoDb({ dir, kinds: ['city'], now: new Date('2026-09-27'), fetchImpl: async () => res(404) }),
            /no DB-IP city edition found for 2026-09 or 2026-08/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validateMmdb rejects garbage', () => {
    assert.throws(() => validateMmdb(Buffer.alloc(2 * 1024 * 1024), 'asn'));
    assert.throws(() => validateMmdb(Buffer.from('x'), 'city'), /too small/);
});

const DEV_GEO = path.resolve(__dirname, '..', '..', '..', 'data', 'geo');
const realAsn = newestLocal(DEV_GEO, 'asn');

test('falls back to last month when this month is a 404; keeps one edition', { skip: !realAsn && 'no ASN DB in server/data/geo (npm run geo:fetch)' }, async () => {
    const dir = tmp();
    try {
        fs.writeFileSync(path.join(dir, 'dbip-asn-lite-2026-06.mmdb'), 'stale');
        const gz = zlib.gzipSync(fs.readFileSync(realAsn.file));
        const asked = [];
        const fetchImpl = async (url) => {
            asked.push(url);
            return url.includes('2026-09') ? res(404) : res(200, gz);
        };
        const [out] = await fetchGeoDb({ dir, kinds: ['asn'], now: new Date('2026-09-02'), fetchImpl });
        assert.deepStrictEqual(asked.map(u => u.match(/\d{4}-\d{2}/)[0]), ['2026-09', '2026-08']);
        assert.strictEqual(out.downloaded, true);
        assert.strictEqual(out.month, '2026-08');
        assert.deepStrictEqual(fs.readdirSync(dir), ['dbip-asn-lite-2026-08.mmdb'], 'the older edition is pruned');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
