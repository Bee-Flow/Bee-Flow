/**
 * geoDb — record shaping, the source order, status, and the monthly refresh
 * decision. Fake readers only: no test reads a 130 MB file.
 *
 * Run: node --test server/core/http/geo/geoDb.test.js
 */

const assert = require('node:assert');
const { test, afterEach } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const geoDb = require('./geoDb');

afterEach(() => {
    geoDb.__resetForTests();
    delete process.env.GEO_DB_DIR;
});

// Records in MaxMind's shape, as DB-IP Lite serves them.
const CITY = {
    '95.216.1.1': {
        city: { names: { en: 'Helsinki' } }, country: { iso_code: 'FI' },
        location: { latitude: 60.1699, longitude: 24.9384 }, subdivisions: [{ names: { en: 'Uusimaa' } }],
    },
    '160.79.104.10': {
        city: { names: { en: 'San Francisco (Financial District)' } }, country: { iso_code: 'US' },
        location: { latitude: 37.7901, longitude: -122.401 },
    },
};
const ASN = {
    '95.216.1.1': { autonomous_system_number: 24940, autonomous_system_organization: 'Hetzner Online GmbH' },
    '8.8.8.8': { autonomous_system_number: 15169, autonomous_system_organization: 'Google LLC' },
};
const reader = (table) => ({ get: (ip) => table[ip] || null });

test('lookupIp shapes a City + ASN record', () => {
    geoDb.__setReadersForTests({ city: reader(CITY), asn: reader(ASN) });
    assert.deepStrictEqual(geoDb.lookupIp('95.216.1.1'), {
        country_code: 'FI', region: 'Uusimaa', city: 'Helsinki', lat: 60.17, lon: 24.94,
        asn: 24940, as_org: 'Hetzner Online GmbH',
    });
    assert.strictEqual(geoDb.lookupIp('160.79.104.10').city, 'San Francisco', 'district suffix stripped');
    const asnOnly = geoDb.lookupIp('8.8.8.8');
    assert.strictEqual(asnOnly.country_code, null);
    assert.strictEqual(asnOnly.asn, 15169);
    // Wrapped IPv4 is looked up as the IPv4 inside.
    assert.strictEqual(geoDb.lookupIp('::ffff:95.216.1.1').country_code, 'FI');
});

test('lookupIp: null for non-addresses, misses and a throwing reader', () => {
    geoDb.__setReadersForTests({ city: { get() { throw new Error('bad ip'); } }, asn: reader({}) });
    assert.strictEqual(geoDb.lookupIp('not-an-ip'), null);
    assert.strictEqual(geoDb.lookupIp('1.2.3.4'), null);
});

test('status reflects the loaded City database', () => {
    geoDb.__setReadersForTests({ city: reader(CITY), asn: reader(ASN), date: '2026-09' });
    assert.deepStrictEqual(geoDb.status(), { available: true, edition: 'dbip-city-lite', date: '2026-09', asn_available: true });
    geoDb.__setReadersForTests({});
    assert.strictEqual(geoDb.status().available, false);
    assert.strictEqual(geoDb.lookupIp('95.216.1.1'), null);
});

test('GEO_DB_DIR wins outright; files are found by name, newest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geodb-'));
    try {
        const older = path.join(dir, 'GeoLite2-City.mmdb');
        const newer = path.join(dir, 'dbip-city-lite-2026-09.mmdb');
        fs.writeFileSync(older, 'x');
        fs.writeFileSync(newer, 'x');
        fs.utimesSync(older, new Date('2026-01-01'), new Date('2026-01-01'));
        fs.writeFileSync(path.join(dir, 'dbip-asn-lite-2026-09.mmdb'), 'x');
        fs.writeFileSync(path.join(dir, 'README.txt'), 'x');
        process.env.GEO_DB_DIR = dir;
        assert.strictEqual(geoDb._pick('city'), newer);
        assert.strictEqual(geoDb._pick('asn'), path.join(dir, 'dbip-asn-lite-2026-09.mmdb'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('monthly refresh: nothing to do when the loaded editions are current', async () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    geoDb.__setReadersForTests({ city: reader(CITY), asn: reader(ASN), date: thisMonth });
    let fetched = 0;
    const updated = await geoDb._autoUpdate(async () => { fetched++; return { status: 404 }; });
    assert.strictEqual(updated, false);
    assert.strictEqual(fetched, 0, 'no download when the month is already loaded');
});

test('monthly refresh: a stale edition triggers a download into GEO_DB_DIR', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geodb-upd-'));
    try {
        process.env.GEO_DB_DIR = dir;
        geoDb.__setReadersForTests({ city: reader(CITY), asn: reader(ASN), date: '2020-01' });
        const urls = [];
        // Nothing published (404 for both months): the refresh reports the gap
        // instead of pretending, and never touches the loaded readers.
        await assert.rejects(geoDb._autoUpdate(async (url) => { urls.push(url); return { status: 404 }; }), /no DB-IP city edition/);
        assert.ok(urls.length >= 1 && urls.every(u => u.startsWith('https://download.db-ip.com/free/dbip-city-lite-')));
        assert.strictEqual(geoDb.status().available, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
