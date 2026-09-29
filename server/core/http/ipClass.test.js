/**
 * ipClass — a table of addresses a real socket can report, and what each is.
 *
 * Run: node --test server/core/http/ipClass.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const { classifyIp, isPrivateIp, canonicalIp } = require('./ipClass');

const TABLE = [
    // [input, kind, canonical ip, family]
    ['8.8.8.8', 'public', '8.8.8.8', 4],
    ['104.16.124.96', 'public', '104.16.124.96', 4],
    ['10.1.2.3', 'private', '10.1.2.3', 4],
    ['172.16.0.1', 'private', '172.16.0.1', 4],
    ['172.21.0.5', 'private', '172.21.0.5', 4],
    ['172.31.255.255', 'private', '172.31.255.255', 4],
    ['172.15.255.255', 'public', '172.15.255.255', 4],
    ['172.32.0.1', 'public', '172.32.0.1', 4],
    ['192.168.1.10', 'private', '192.168.1.10', 4],
    ['127.0.0.1', 'loopback', '127.0.0.1', 4],
    ['169.254.169.254', 'link_local', '169.254.169.254', 4],
    ['100.64.0.1', 'cgnat', '100.64.0.1', 4],
    ['100.127.255.254', 'cgnat', '100.127.255.254', 4],
    ['100.128.0.1', 'public', '100.128.0.1', 4],
    ['0.0.0.0', 'unspecified', '0.0.0.0', 4],
    ['::1', 'loopback', '::1', 6],
    ['::', 'unspecified', '::', 6],
    ['fd12:3456::1', 'ula', 'fd12:3456::1', 6],
    ['fc00::1', 'ula', 'fc00::1', 6],
    ['fe80::1%eth0', 'link_local', 'fe80::1', 6],
    ['FE80::ABCD', 'link_local', 'fe80::abcd', 6],
    ['2606:4700::6810:7c60', 'public', '2606:4700::6810:7c60', 6],
    ['[2a01:4f8::1]', 'public', '2a01:4f8::1', 6],
    // IPv4-mapped: classify the IPv4 inside.
    ['::ffff:10.0.0.7', 'private', '10.0.0.7', 4],
    ['::ffff:8.8.4.4', 'public', '8.8.4.4', 4],
    ['::ffff:7f00:1', 'loopback', '127.0.0.1', 4],
    // NAT64 well-known prefix: the embedded IPv4 is the destination.
    ['64:ff9b::808:808', 'public', '8.8.8.8', 4],
    ['64:ff9b::192.168.0.1', 'private', '192.168.0.1', 4],
];

test('classifyIp: the address table', () => {
    for (const [input, kind, ip, family] of TABLE) {
        const c = classifyIp(input);
        assert.strictEqual(c.kind, kind, `${input} → kind`);
        assert.strictEqual(c.ip, ip, `${input} → canonical`);
        assert.strictEqual(c.family, family, `${input} → family`);
        assert.strictEqual(c.isPrivate, kind !== 'public', `${input} → isPrivate`);
    }
});

test('not an address: invalid, never private', () => {
    for (const bad of ['', null, undefined, 'api.fireflies.ai', '999.1.1.1', '1.2.3', 'fe80::1::2', '::ffff:300.1.1.1']) {
        const c = classifyIp(bad);
        assert.strictEqual(c.kind, 'invalid', String(bad));
        assert.strictEqual(c.ip, null);
        assert.strictEqual(isPrivateIp(bad), false, String(bad));
    }
});

test('isPrivateIp / canonicalIp are shorthands of classifyIp', () => {
    assert.strictEqual(isPrivateIp('172.21.0.5'), true);
    assert.strictEqual(isPrivateIp('100.64.3.4'), true);
    assert.strictEqual(isPrivateIp('81.204.1.1'), false);
    assert.strictEqual(canonicalIp('::ffff:1.2.3.4'), '1.2.3.4');
    assert.strictEqual(canonicalIp('fe80::1%25eth0'), 'fe80::1');
});
