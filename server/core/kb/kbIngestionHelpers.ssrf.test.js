// @typecheck
/**
 * assertUrlIsPublic screens with the canonical SSRF table — DB-free.
 *
 * The KB/notebook/webpage pre-check used to carry its own private-range
 * table next to core/http/ssrfGuard.isForbiddenAddress. That copy missed
 * addresses the canonical table refuses, so a hostname whose DNS answer was
 * one of them passed the pre-check (only safeFetch, at connect time, still
 * caught it). These cases pin that the pre-check now agrees with the one
 * table, and that its error texts and return value did not change.
 *
 * Run: node --test core/kb/kbIngestionHelpers.ssrf.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');
const { isForbiddenAddress } = require('../http/ssrfGuard');

process.env.NODE_ENV = 'test';

let restore;
let helpers;

before(() => {
    // Keep the module DB-free: these seams open a Postgres listener otherwise.
    restore = installResolveStub({
        '../../stores/knowledgeBases': {},
        '../../stores/configStore': { getConfig: async () => null, getSecret: async () => null },
        '../serviceAuth': { getServiceHeaders: () => ({}) },
    });
    helpers = require('./kbIngestionHelpers');
});
after(() => restore && restore());

const resolvingTo = (address) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];

// Addresses the old local table let through although the canonical table
// refuses them. A hostile DNS server can answer with any of these.
const PREVIOUSLY_MISSED = [
    '::127.0.0.1',        // IPv4-compatible IPv6 of loopback
    '::a9fe:a9fe',        // IPv4-compatible IPv6 of 169.254.169.254 (metadata)
    '::ffff:7f00:1',      // IPv4-mapped loopback in hex form
    '::ffff:a9fe:a9fe',   // IPv4-mapped metadata endpoint in hex form
    '255.255.255.255',    // broadcast
];

for (const address of PREVIOUSLY_MISSED) {
    test(`refuses a host that resolves to ${address}`, async () => {
        assert.equal(isForbiddenAddress(address), true, 'canonical table refuses it');
        await assert.rejects(
            helpers.assertUrlIsPublic('https://attacker.example/x', { lookup: resolvingTo(address) }),
            { message: `URL attacker.example resolves to a private/loopback address (${address})` },
        );
    });
}

test('refuses when ANY of several records is forbidden', async () => {
    const lookup = async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '::127.0.0.1', family: 6 },
    ];
    await assert.rejects(helpers.assertUrlIsPublic('http://mixed.example/', { lookup }), /private\/loopback/);
});

test('still refuses the ranges the old table covered', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
        await assert.rejects(
            helpers.assertUrlIsPublic('https://h.example/', { lookup: resolvingTo(address) }),
            /private\/loopback/, address,
        );
    }
    await assert.rejects(helpers.assertUrlIsPublic('http://127.0.0.1/'), /private\/loopback address \(127\.0\.0\.1\)/);
    await assert.rejects(helpers.assertUrlIsPublic('http://0x7f.1/'), /private\/loopback/);
});

test('keeps its contract: parsed URL back for a public host, same error texts', async () => {
    const parsed = await helpers.assertUrlIsPublic('https://docs.example/a?b=1', { lookup: resolvingTo('93.184.216.34') });
    assert.ok(parsed instanceof URL);
    assert.equal(parsed.href, 'https://docs.example/a?b=1');

    const v6 = await helpers.assertUrlIsPublic('http://v6.example/', { lookup: resolvingTo('2606:4700::6810:84e5') });
    assert.equal(v6.hostname, 'v6.example');

    await assert.rejects(helpers.assertUrlIsPublic('not a url'), { message: 'Invalid URL' });
    await assert.rejects(helpers.assertUrlIsPublic('file:///etc/passwd'), { message: 'Only HTTP/HTTPS URLs are allowed' });
    await assert.rejects(
        helpers.assertUrlIsPublic('https://nx.example/', { lookup: async () => { throw new Error('getaddrinfo ENOTFOUND nx.example'); } }),
        { message: 'DNS lookup failed for nx.example: getaddrinfo ENOTFOUND nx.example' },
    );
});
