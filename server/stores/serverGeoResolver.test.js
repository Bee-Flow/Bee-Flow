/**
 * serverGeoResolver — geoFromIp on the local database, and never a network call.
 *
 * The retired resolver asked ip-api.com over plain HTTP (with the signup IPs of
 * users among the addresses) and cached the answers in ip_geo_cache forever.
 * These tests pin the replacement: the local reader only, the signup guard's
 * result shape unchanged, no fetch and no DNS.
 *
 * Seam: core/http/geo/geoDb.__setReadersForTests installs fake readers.
 *
 * Run: node --test server/stores/serverGeoResolver.test.js
 */

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const dns = require('node:dns');
const geoDb = require('../core/http/geo/geoDb');
const resolver = require('./serverGeoResolver');

const CITY = {
    '81.204.1.1': { country: { iso_code: 'NL' }, city: { names: { en: 'Amsterdam' } }, subdivisions: [{ names: { en: 'North Holland' } }], location: { latitude: 52.37, longitude: 4.9 } },
    '8.8.8.8': { country: { iso_code: 'US' }, city: { names: { en: 'Mountain View' } }, location: { latitude: 37.42, longitude: -122.08 } },
    '41.0.0.1': { country: { iso_code: 'ZW' } },
};
const reader = (t) => ({ get: (ip) => t[ip] || null });

const realFetch = global.fetch;
const realLookup = dns.promises.lookup;
let networkCalls = 0;
before(() => {
    geoDb.__setReadersForTests({ city: reader(CITY), asn: reader({}) });
    global.fetch = async () => { networkCalls++; throw new Error('no network in this test'); };
    dns.promises.lookup = async () => { networkCalls++; throw new Error('no DNS in this test'); };
});
after(() => {
    global.fetch = realFetch;
    dns.promises.lookup = realLookup;
    geoDb.__resetForTests();
});

test('geoFromIp keeps the signup guard shape', async () => {
    assert.deepStrictEqual(await resolver.geoFromIp('81.204.1.1'), {
        country_code: 'NL', country_name: 'Netherlands', region: 'North Holland', city: 'Amsterdam',
        is_eu: true, flag: '🇳🇱',
    });
    const us = await resolver.geoFromIp('8.8.8.8');
    assert.strictEqual(us.is_eu, false);
    assert.strictEqual(us.country_name, 'United States');
});

test('every ISO country has a name, not just the old table', async () => {
    assert.strictEqual((await resolver.geoFromIp('41.0.0.1')).country_name, 'Zimbabwe');
    assert.strictEqual(resolver.countryName('AE'), 'UAE', 'the table still overrides Intl');
    assert.strictEqual(resolver.countryName('BT'), 'Bhutan');
});

test('unknown address → country_code null; private → null', async () => {
    const miss = await resolver.geoFromIp('198.51.100.7');
    assert.strictEqual(miss.country_code, null);
    assert.strictEqual(miss.country_name, 'Unknown');
    assert.strictEqual(miss.flag, '🌐');
    for (const ip of ['10.0.0.5', '192.168.1.1', '172.16.9.9', '127.0.0.1', '::1', '100.64.0.9']) {
        assert.strictEqual(await resolver.geoFromIp(ip), null, ip);
    }
    assert.strictEqual(await resolver.geoFromIp(''), null);
    assert.strictEqual(await resolver.geoFromIp('not-an-ip'), null);
});

test('no lookup ever leaves the box', async () => {
    for (const ip of ['81.204.1.1', '198.51.100.8', '203.0.113.1', '8.8.8.8']) await resolver.geoFromIp(ip);
    assert.strictEqual(networkCalls, 0);
});

test('a missing database answers unknown, still without a network call', async () => {
    geoDb.__setReadersForTests({});
    const g = await resolver.geoFromIp('81.204.1.1');
    assert.strictEqual(g.country_code, null);
    assert.strictEqual(networkCalls, 0);
    geoDb.__setReadersForTests({ city: reader(CITY), asn: reader({}) });
});
