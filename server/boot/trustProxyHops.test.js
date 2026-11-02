// @typecheck
'use strict';
/**
 * `TRUST_PROXY_HOPS`: zero is a setting, a typo is a refusal (boot/trustProxyHops.js).
 * Run: cd server && node --test boot/trustProxyHops.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTrustProxyHops, DEFAULT_HOPS } = require('./trustProxyHops');

test('unset or blank means the one nginx hop of the standard deploy', () => {
    assert.equal(parseTrustProxyHops(undefined), DEFAULT_HOPS);
    assert.equal(parseTrustProxyHops(''), DEFAULT_HOPS);
    assert.equal(parseTrustProxyHops('  '), DEFAULT_HOPS);
    assert.equal(DEFAULT_HOPS, 1);
});

test('zero can be set: no proxy, the socket address is the client', () => {
    assert.equal(parseTrustProxyHops('0'), 0);
    assert.equal(parseTrustProxyHops(' 2 '), 2);
});

test('a value that is not a whole number refuses to boot instead of becoming 1', () => {
    for (const raw of ['one', '1.5', '-1', '0x1', '1e1', 'true']) {
        assert.throws(() => parseTrustProxyHops(raw), /TRUST_PROXY_HOPS/, raw);
    }
});
