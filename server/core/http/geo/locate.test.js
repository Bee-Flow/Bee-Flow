/**
 * locate — every state, with a fake location database; plus one test that
 * runs against the real DB-IP files when `npm run geo:fetch` has put them in
 * server/data/geo (skipped otherwise).
 *
 * Run: node --test server/core/http/geo/locate.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { locatePeer, locateCall, registrableDomain, hostOf } = require('./locate');

const TABLE = {
    '104.18.24.82': { country_code: 'CA', region: 'Ontario', city: 'Toronto', lat: 43.65, lon: -79.38, asn: 13335, as_org: 'Cloudflare, Inc.' },
    '104.18.7.192': { country_code: 'CA', region: 'Ontario', city: 'Toronto', lat: 43.65, lon: -79.38, asn: 13335, as_org: 'Cloudflare, Inc.' },
    '95.216.1.1': { country_code: 'FI', region: 'Uusimaa', city: 'Helsinki', lat: 60.17, lon: 24.94, asn: 24940, as_org: 'Hetzner Online GmbH' },
    '3.5.1.1': { country_code: 'US', region: 'Virginia', city: 'Ashburn', lat: 39.04, lon: -77.49, asn: 14618, as_org: 'Amazon.com, Inc.' },
    '160.79.104.10': { country_code: 'US', region: 'California', city: 'San Francisco', lat: 37.79, lon: -122.4, asn: 399358, as_org: 'Anthropic, PBC' },
    '203.0.113.9': { country_code: null, region: null, city: null, lat: null, lon: null, asn: 64500, as_org: 'Example' },
};
const fakeGeo = (available = true) => ({
    lookupIp: (ip) => TABLE[ip] || null,
    status: () => ({ available }),
});
const geo = fakeGeo();

test('private address → local, whatever the database says', () => {
    for (const ip of ['172.21.0.5', '10.0.0.1', '100.64.1.2', '::1', 'fd00::5', '::ffff:192.168.1.4']) {
        const l = locatePeer({ host: 'bee-flow-nc-sandbox', ip, basis: 'socket' }, { geo });
        assert.strictEqual(l.state, 'local', ip);
        assert.strictEqual(l.basis, 'socket');
    }
});

test('EU country → eu with city and point; other country → outside', () => {
    const eu = locatePeer({ host: 'x.example.de', ip: '95.216.1.1' }, { geo });
    assert.strictEqual(eu.state, 'eu');
    assert.strictEqual(eu.city, 'Helsinki');
    assert.strictEqual(eu.country_name, 'Finland');
    assert.strictEqual(eu.lat, 60.17);
    assert.strictEqual(eu.operator, null, 'an unknown ASN gives no operator');
    assert.strictEqual(eu.as_org, 'Hetzner Online GmbH', '…only its as_org');

    const us = locatePeer({ host: 's3.amazonaws.com', ip: '3.5.1.1' }, { geo });
    assert.strictEqual(us.state, 'outside', 'Amazon is not an edge on its ASN alone');
    assert.strictEqual(us.operator, 'Amazon AWS');
    const anthropic = locatePeer({ host: 'api.anthropic.com', ip: '160.79.104.10' }, { geo });
    assert.strictEqual(anthropic.operator, 'Anthropic');
});

test('Cloudflare with cf-ray → via_network at the edge city, not Toronto', () => {
    const l = locatePeer({
        host: 'api.fireflies.ai', ip: '104.18.24.82', basis: 'socket',
        edge: { 'cf-ray': 'a41859ef1d78ae32-AMS', server: 'cloudflare' },
    }, { geo });
    assert.strictEqual(l.state, 'via_network');
    assert.strictEqual(l.basis, 'edge_header');
    assert.strictEqual(l.network, 'Cloudflare');
    assert.strictEqual(l.edge_pop, 'AMS');
    assert.strictEqual(l.city, 'Amsterdam');
    assert.strictEqual(l.country_code, 'NL');
    assert.strictEqual(l.operator, 'Cloudflare');
});

test('Cloudflare without headers → via_network, no place (anycast has none)', () => {
    const l = locatePeer({ host: 'example.org', ip: '104.18.24.82' }, { geo });
    assert.strictEqual(l.state, 'via_network');
    assert.strictEqual(l.basis, 'socket');
    assert.strictEqual(l.country_code, null);
    assert.strictEqual(l.lat, null);
    // The CIDR override still wins for the operator label.
    assert.strictEqual(locatePeer({ ip: '104.18.7.192' }, { geo }).operator, 'OpenAI');
});

test('unknown: no address, proxy, child process, not in the database, no database', () => {
    assert.deepStrictEqual(
        [locatePeer({ host: 'h', ip: null }, { geo }).state, locatePeer({ host: 'h', ip: null }, { geo }).basis],
        ['unknown', 'none']);
    assert.strictEqual(locatePeer({ host: 'h', ip: '95.216.1.1', basis: 'proxy' }, { geo }).basis, 'proxy');
    assert.strictEqual(locatePeer({ host: 'h', ip: '95.216.1.1', basis: 'proxy' }, { geo }).state, 'unknown');
    assert.strictEqual(locatePeer({ host: 'mcp', ip: null, basis: 'child_process' }, { geo }).basis, 'child_process');
    const notFound = locatePeer({ host: 'h', ip: '203.0.113.9' }, { geo });
    assert.strictEqual(notFound.state, 'unknown');
    assert.strictEqual(notFound.basis, 'socket');
    const noDb = locatePeer({ host: 'h', ip: '95.216.1.1' }, { geo: fakeGeo(false) });
    assert.strictEqual(noDb.state, 'unknown');
    assert.strictEqual(noDb.basis, 'no_geo_db');
    // A private address needs no database.
    assert.strictEqual(locatePeer({ ip: '10.1.1.1' }, { geo: fakeGeo(false) }).state, 'local');
});

test('locateCall: no peers → the local hint, else unknown; basis none', () => {
    assert.strictEqual(locateCall({ peers: [], isLocalHint: true, geo }).row.state, 'local');
    const r = locateCall({ peers: [], isLocalHint: false, geo });
    assert.strictEqual(r.row.state, 'unknown');
    assert.strictEqual(r.row.basis, 'none');
    assert.strictEqual(r.primary, null);
    assert.deepStrictEqual(r.peers, []);
    assert.strictEqual(locateCall({ geo }).row.state, 'unknown', 'no input at all');
});

test('locateCall: worst peer that received data decides; primary on the integration domain', () => {
    const peers = [
        { host: 'oauth2.googleapis.com', ip: '3.5.1.1', sentBody: true },     // outside, but an auth host
        { host: 'api.example.de', ip: '95.216.1.1', sentBody: true },         // eu, the integration
        { host: 'cdn.example.de', ip: '104.18.24.82', sentBody: false },      // GET only
    ];
    const r = locateCall({ peers, serverEndpoint: 'https://api.example.de/v1 (Example)', geo });
    assert.strictEqual(r.primary.host, 'api.example.de');
    assert.strictEqual(r.row.state, 'outside', 'the auth host received data outside Europe');
    assert.strictEqual(r.row.operator, 'Amazon AWS', 'the row names who received it');
    assert.strictEqual(r.peers.length, 3);

    // Only GETs everywhere → the worst over all peers.
    const gets = peers.map(p => ({ ...p, sentBody: false }));
    assert.strictEqual(locateCall({ peers: gets, serverEndpoint: 'api.example.de', geo }).row.state, 'outside');

    // The GET-only CDN peer does not count when someone received a body.
    const r2 = locateCall({ peers: peers.slice(1), serverEndpoint: 'api.example.de', geo });
    assert.strictEqual(r2.row.state, 'eu');
    assert.strictEqual(r2.row.city, 'Helsinki', 'row location = primary when it is the worst');
});

test('locateCall: primary falls back to the last peer with a body, then the last peer', () => {
    const peers = [
        { host: 'a.one.com', ip: '95.216.1.1', sentBody: true },
        { host: 'b.two.com', ip: '95.216.1.1', sentBody: false },
    ];
    assert.strictEqual(locateCall({ peers, serverEndpoint: 'three.com', geo }).primary.host, 'a.one.com');
    const noBody = peers.map(p => ({ ...p, sentBody: false }));
    assert.strictEqual(locateCall({ peers: noBody, geo }).primary.host, 'b.two.com');
});

test('registrableDomain / hostOf', () => {
    assert.strictEqual(registrableDomain('api.eu.fireflies.ai'), 'fireflies.ai');
    assert.strictEqual(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
    assert.strictEqual(registrableDomain('localhost'), 'localhost');
    assert.strictEqual(registrableDomain('10.0.0.1'), '10.0.0.1');
    assert.strictEqual(hostOf('HTTPS://Api.Serper.dev:443/search (Google Search)'), 'api.serper.dev');
    assert.strictEqual(hostOf(''), null);
});

// ── Real database (only when present) ─────────────────────────────────────────
const DEV_GEO = path.resolve(__dirname, '..', '..', '..', 'data', 'geo');
const hasRealDb = (() => {
    try { return fs.readdirSync(DEV_GEO).some(n => /city.*\.mmdb$/i.test(n)); } catch { return false; }
})();

test('real DB-IP files: Cloudflare → via_network, Hetzner → eu, 8.8.8.8 → Google', { skip: !hasRealDb && 'no DB in server/data/geo (npm run geo:fetch)' }, async () => {
    const geoDb = require('./geoDb');
    geoDb.__resetForTests();
    try {
        await geoDb.load();
        assert.strictEqual(geoDb.status().available, true);
        const cf = locatePeer({ host: 'example.org', ip: '104.16.124.96' });
        assert.strictEqual(cf.asn, 13335);
        assert.strictEqual(cf.operator, 'Cloudflare');
        assert.strictEqual(cf.state, 'via_network');
        const hetzner = locatePeer({ host: 'x', ip: '95.216.1.1' });
        assert.strictEqual(hetzner.state, 'eu');
        assert.strictEqual(hetzner.country_code, 'FI');
        const google = locatePeer({ host: 'dns.google', ip: '8.8.8.8' });
        assert.strictEqual(google.operator, 'Google');
        assert.strictEqual(google.asn, 15169);
    } finally {
        geoDb.__resetForTests();
    }
});
