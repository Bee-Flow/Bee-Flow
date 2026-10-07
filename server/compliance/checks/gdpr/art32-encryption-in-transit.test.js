/**
 * GDPR-Art32-encryption-in-transit: an env var set to an "off" word is off.
 *
 * `!!process.env.TRUST_PROXY` read TRUST_PROXY=false (or 0) as switched on,
 * and any TLS_TERMINATOR value, `none` included, attested to HTTPS: the check
 * then passed with "TLS termination detected".
 *
 * Run: cd server && node --test compliance/checks/gdpr/art32-encryption-in-transit.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const check = require('./art32-encryption-in-transit');

const KEYS = ['NODE_ENV', 'TRUST_PROXY', 'TLS_TERMINATOR'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
test.afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

function env(vars) {
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

test('TRUST_PROXY=false, 0 or off is not a reverse proxy terminating TLS', async () => {
    for (const off of ['false', '0', 'off', 'FALSE', ' no ']) {
        env({ NODE_ENV: 'production', TRUST_PROXY: off });
        const r = await check.evaluate();
        assert.equal(r.status, 'warn', `TRUST_PROXY=${JSON.stringify(off)}`);
        assert.equal(r.evidence.TRUST_PROXY, false);
    }
});

test('TRUST_PROXY=1 in production still passes', async () => {
    env({ NODE_ENV: 'production', TRUST_PROXY: '1' });
    const r = await check.evaluate();
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.TRUST_PROXY, true);
});

test('TLS_TERMINATOR=none attests nothing; a named terminator passes', async () => {
    env({ NODE_ENV: 'production', TLS_TERMINATOR: 'none' });
    const none = await check.evaluate();
    assert.equal(none.status, 'warn');
    assert.equal(none.evidence.TLS_TERMINATOR, null);

    env({ NODE_ENV: 'production', TLS_TERMINATOR: 'traefik' });
    const named = await check.evaluate();
    assert.equal(named.status, 'pass');
    assert.equal(named.evidence.TLS_TERMINATOR, 'traefik');
});
