'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCidrList, ipAllowed } = require('./ipMatch');

test('an empty or missing list restricts nothing', () => {
    assert.equal(ipAllowed('203.0.113.7', []), true);
    assert.equal(ipAllowed('203.0.113.7', undefined), true);
    assert.equal(ipAllowed(undefined, []), true);
});

test('IPv4: inside and outside a /24, and a single host', () => {
    const list = ['203.0.113.0/24', '198.51.100.9'];
    assert.equal(ipAllowed('203.0.113.200', list), true);
    assert.equal(ipAllowed('203.0.114.1', list), false);
    assert.equal(ipAllowed('198.51.100.9', list), true);
    assert.equal(ipAllowed('198.51.100.10', list), false);
});

test('IPv6: inside and outside a /32, and a single host', () => {
    const list = ['2001:db8::/32', '2001:4860:4860::8888'];
    assert.equal(ipAllowed('2001:db8:abcd::1', list), true);
    assert.equal(ipAllowed('2001:db9::1', list), false);
    assert.equal(ipAllowed('2001:4860:4860::8888', list), true);
    assert.equal(ipAllowed('2001:4860:4860::8889', list), false);
});

test('an IPv4-mapped client address is matched as the IPv4 address it is', () => {
    assert.equal(ipAllowed('::ffff:203.0.113.7', ['203.0.113.0/24']), true);
    assert.equal(ipAllowed('::ffff:203.0.114.7', ['203.0.113.0/24']), false);
    assert.equal(ipAllowed('::FFFF:203.0.113.7', ['203.0.113.7']), true);
});

test('an IPv4-mapped list entry is stored as the IPv4 range it means', () => {
    assert.deepEqual(parseCidrList(['::ffff:203.0.113.0/120']), ['203.0.113.0/24']);
    assert.deepEqual(parseCidrList(['::ffff:203.0.113.5']), ['203.0.113.5']);
    assert.equal(ipAllowed('203.0.113.77', ['::ffff:203.0.113.0/120']), true);
});

test('an IPv4 address never matches an IPv6-only list, nor the reverse', () => {
    assert.equal(ipAllowed('203.0.113.7', ['2001:db8::/32']), false);
    assert.equal(ipAllowed('2001:db8::1', ['203.0.113.0/24']), false);
});

test('a zone id on the client address is ignored', () => {
    assert.equal(ipAllowed('fe80::1%eth0', ['fe80::/10']), true);
});

test('a non-empty list denies a missing or unparseable client address', () => {
    assert.equal(ipAllowed(undefined, ['203.0.113.0/24']), false);
    assert.equal(ipAllowed('', ['203.0.113.0/24']), false);
    assert.equal(ipAllowed('not-an-ip', ['203.0.113.0/24']), false);
});

test('parseCidrList canonicalises, trims and de-duplicates', () => {
    assert.deepEqual(parseCidrList([' 203.0.113.0/24 ', '203.0.113.0/24', '2001:db8::/32', '198.51.100.1']),
        ['203.0.113.0/24', '2001:db8::/32', '198.51.100.1']);
    assert.deepEqual(parseCidrList(undefined), []);
    assert.deepEqual(parseCidrList(null), []);
    assert.deepEqual(parseCidrList([]), []);
});

test('parseCidrList refuses what is not an address or range, with a 400', () => {
    for (const bad of [['nope'], ['203.0.113.0/33'], ['2001:db8::/129'], ['203.0.113.0/'], ['203.0.113.0/-1'],
        ['999.1.1.1'], ['203.0.113.0/24/8'], [42], [null], ['::ffff:203.0.113.0/64']]) {
        assert.throws(() => parseCidrList(bad), (err) => err.status === 400 && err.code === 'invalid_ip_allowlist', JSON.stringify(bad));
    }
    assert.throws(() => parseCidrList('203.0.113.0/24'), (err) => err.status === 400);
    assert.throws(() => parseCidrList(new Array(101).fill('203.0.113.1')), (err) => err.status === 400);
});

test('a refusal names the offending entry', () => {
    assert.throws(() => parseCidrList(['203.0.113.0/24', 'garbage']), /garbage/);
});
