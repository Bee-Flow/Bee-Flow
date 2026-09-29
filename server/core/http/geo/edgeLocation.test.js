/**
 * edgeLocation — CDN edge headers, believed only on the network's own ASN.
 *
 * Run: node --test server/core/http/geo/edgeLocation.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const { detectEdge, airport } = require('./edgeLocation');

test('cf-ray on a Cloudflare ASN names the Amsterdam edge', () => {
    const e = detectEdge({ 'cf-ray': 'a41859ef1d78ae32-AMS', server: 'cloudflare' }, 13335);
    assert.strictEqual(e.network, 'Cloudflare');
    assert.strictEqual(e.edge_pop, 'AMS');
    assert.deepStrictEqual(e.place, { city: 'Amsterdam', country_code: 'NL', lat: 52.31, lon: 4.76 });
    assert.strictEqual(detectEdge({ 'cf-ray': '8c1d2f3a4b5c6d7e-fra' }, 209242).edge_pop, 'FRA');
});

test('a forged cf-ray on a non-Cloudflare ASN is rejected', () => {
    // A US host on Amazon space claiming to be Cloudflare Amsterdam.
    assert.strictEqual(detectEdge({ 'cf-ray': 'deadbeef-AMS', server: 'cloudflare' }, 16509), null);
    assert.strictEqual(detectEdge({ 'cf-ray': 'deadbeef-AMS' }, 24940), null);
    assert.strictEqual(detectEdge({ 'cf-ray': 'deadbeef-AMS' }, null), null, 'no ASN, no belief');
});

test('CloudFront POP only on Amazon ASNs', () => {
    assert.strictEqual(detectEdge({ 'x-amz-cf-pop': 'FRA56-P5' }, 16509).edge_pop, 'FRA');
    assert.strictEqual(detectEdge({ 'x-amz-cf-pop': 'IAD89-C1' }, 14618).network, 'Amazon CloudFront');
    assert.strictEqual(detectEdge({ 'x-amz-cf-pop': 'FRA56-P5' }, 13335), null);
});

test('Fastly: the last cache in x-served-by, only on AS54113', () => {
    const e = detectEdge({ 'x-served-by': 'cache-fra-eddf8230047-FRA, cache-ams21052-AMS' }, 54113);
    assert.strictEqual(e.network, 'Fastly');
    assert.strictEqual(e.edge_pop, 'AMS');
    assert.strictEqual(detectEdge({ 'x-served-by': 'cache-ams21052-AMS' }, 15169), null);
});

test('Vercel needs server: Vercel AND Amazon address space', () => {
    const hdr = { 'x-vercel-id': 'fra1::iad1::abcde-1727420000000-0123456789ab', server: 'Vercel' };
    assert.strictEqual(detectEdge(hdr, 16509).edge_pop, 'FRA');
    assert.strictEqual(detectEdge({ ...hdr, server: 'nginx' }, 16509), null, 'header alone is not enough');
    assert.strictEqual(detectEdge(hdr, 24940), null, 'not on Amazon space');
});

test('Fly.io region suffix only on AS40509', () => {
    assert.strictEqual(detectEdge({ 'fly-request-id': '01J8ABCDEF-ams' }, 40509).edge_pop, 'AMS');
    assert.strictEqual(detectEdge({ 'fly-request-id': '01J8ABCDEF-ams' }, 16509), null);
});

test('Microsoft Front Door: x-msedge-ref POP, x-azure-ref network only', () => {
    const e = detectEdge({ 'x-msedge-ref': 'Ref A: 1234 Ref B: AMS30EDGE0712 Ref C: 2026-09-27T08:00:00Z' }, 8075);
    assert.strictEqual(e.network, 'Microsoft Front Door');
    assert.strictEqual(e.edge_pop, 'AMS');
    const azure = detectEdge({ 'x-azure-ref': '20260927T080000Z-abc' }, 8075);
    assert.deepStrictEqual(azure, { network: 'Microsoft Front Door', edge_pop: null, place: null });
    assert.strictEqual(detectEdge({ 'x-azure-ref': 'x' }, 13335), null);
});

test('nothing to go on → null', () => {
    assert.strictEqual(detectEdge(null, 13335), null);
    assert.strictEqual(detectEdge({ server: 'cloudflare' }, 13335), null);
    assert.strictEqual(detectEdge({ 'cf-ray': 'garbage' }, 13335).edge_pop, null, 'verified header, no POP');
});

test('airport(): IATA → city, unknown code → null', () => {
    assert.strictEqual(airport('yyz').city, 'Toronto');
    assert.strictEqual(airport('CDG').city, 'Paris');
    assert.strictEqual(airport('ZZZ'), null);
    assert.strictEqual(airport(null), null);
});
