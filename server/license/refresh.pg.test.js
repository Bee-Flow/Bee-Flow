'use strict';

/**
 * license/refresh.js: what each answer of the licence server does to the
 * stored licence, against the real store on PGlite and the real verifier with
 * a key pair made for this run. The licence server is a stand-in `fetch`.
 *
 *   - admin-issued and non-monthly licences are never pinged
 *   - unreachable, an HTTP error, a body that is not an object, or an unknown
 *     status: grace inside the window, expired after it
 *   - revoked: revoked at once; expired: expired at once only when the local
 *     expiry has passed too, else grace
 *   - active with a new token: the token replaces the stored one only when it
 *     verifies AND names this licence; any other token changes nothing but
 *     the status
 *   - the revocation list revokes what it names and moves its cursor forward
 *     only
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test license/refresh.pg.test.js
 */

process.env.NODE_ENV = 'test';
process.env.LICENSE_REFRESH_URL = 'https://license.example.test/v1/refresh';
process.env.LICENSE_CRL_URL = 'https://license.example.test/v1/crl';
delete process.env.LICENSE_GRACE_WINDOW_SECONDS;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const store = require('./store');
const verify = require('./verify');
const refresh = require('./refresh');
const { ADMIN_ISSUER } = require('./adminIssuance');
const { publicKey, sign, signWithOtherKey, claims } = require('./licenseJwt.testkit');
const { initDB: initUsers } = require('../stores/user/schema');
const configStore = require('../stores/configStore');
const sessionCache = require('../auth/sessionCache');

const DAY = 86400 * 1000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

/** What the stand-in licence server answers next, and the URLs it was asked. */
let answer = () => ({ status: 200, body: '{}' });
const asked = [];
const config = new Map();

const { swap, restore } = makeSwaps();
before(async () => {
    await initUsers();
    await pg.exec(`INSERT INTO organizations (id, name) VALUES ('org-a', 'A'), ('org-b', 'B')`);
    verify._setPublicKeyForTesting(publicKey);
    swap(globalThis, 'fetch', async (url) => {
        asked.push(String(url));
        const a = answer();
        if (a.throws) throw a.throws;
        return new Response(a.body, { status: a.status });
    });
    swap(configStore, 'getConfig', async (key) => config.get(key) ?? null);
    swap(configStore, 'setConfig', async (key, value) => { config.set(key, value); });
    swap(sessionCache, 'endSessionsForOrg', async () => 0);
    swap(sessionCache, 'bustSessionsForUser', async () => 0);
});
after(async () => { restore(); verify._setPublicKeyForTesting(null); await close(); });
beforeEach(async () => {
    asked.length = 0;
    config.clear();
    await pg.exec('DELETE FROM license_keys');
});

const replyJson = (obj, status = 200) => { answer = () => ({ status, body: JSON.stringify(obj) }); };

/** A stored monthly licence of org-a, issued `ageDays` ago. */
async function stored(over = {}, ageDays = 1) {
    return store.upsertLicense({
        licenseId: 'lic-1', scope: 'organization', organizationId: 'org-a', rawToken: 'tok-original',
        tier: 'enterprise', issuer: 'license.beeflow.nl', issuedAt: iso(-ageDays * DAY), expiresAt: iso(30 * DAY),
        billingInterval: 'monthly', ...over,
    });
}
const row = async (id = 'lic-1') => store.getLicenseById(id);

// ── Never pinged ────────────────────────────────────────────────────────

test('a refresh without a licence is a programming error', async () => {
    await assert.rejects(refresh.refreshOne(null), /missing license/);
    await assert.rejects(refresh.refreshOne({}), /missing license/);
});

test('an admin-issued licence and a yearly licence are skipped without asking the server', async () => {
    assert.deepEqual(await refresh.refreshOne(await stored({ issuer: ADMIN_ISSUER })), { skipped: true, reason: 'admin_issued_license' });
    assert.deepEqual(await refresh.refreshOne(await stored({ licenseId: 'lic-y', billingInterval: 'yearly' })), { skipped: true, reason: 'non_monthly_license' });
    assert.deepEqual(asked, []);
});

test('the licence id is sent encoded in the query', async () => {
    replyJson({ status: 'active' });
    await refresh.refreshOne(await stored({ licenseId: 'lic 1&x=y' }));
    assert.deepEqual(asked, ['https://license.example.test/v1/refresh?license_id=lic%201%26x%3Dy']);
});

// ── Failures ────────────────────────────────────────────────────────────

test('an unreachable server leaves a young licence in grace and expires an old one', async () => {
    answer = () => ({ throws: new Error('ECONNREFUSED') });
    assert.equal((await refresh.refreshOne(await stored({}, 1))).reason, 'unreachable');
    assert.equal((await row()).refreshStatus, 'grace');
    await stored({ licenseId: 'lic-old', organizationId: 'org-b' }, 20);
    await refresh.refreshOne(await row('lic-old'));
    assert.equal((await row('lic-old')).refreshStatus, 'expired');
});

test('an HTTP error, a body that is no object, and an unknown status each count as a failed refresh', async () => {
    const cases = [
        [() => ({ status: 503, body: 'down' }), 'http_error'],
        [() => ({ status: 200, body: '<html>' }), 'malformed_response'],
        [() => ({ status: 200, body: 'null' }), 'malformed_response'],
        [() => ({ status: 200, body: '"active"' }), 'malformed_response'],
        [() => ({ status: 200, body: JSON.stringify({ status: 'paused' }) }), 'unknown_status'],
    ];
    for (const [reply, reason] of cases) {
        await pg.exec('DELETE FROM license_keys');
        answer = reply;
        const r = await refresh.refreshOne(await stored());
        assert.equal(r.ok, false, reason);
        assert.equal(r.reason, reason);
        assert.equal((await row()).refreshStatus, 'grace', reason);
        assert.equal((await row()).rawToken, 'tok-original', reason);
    }
});

// ── Revoked and expired ─────────────────────────────────────────────────

test('revoked revokes at once, whatever the age', async () => {
    replyJson({ status: 'revoked', reason: 'refund' });
    assert.deepEqual(await refresh.refreshOne(await stored()), { ok: true, status: 'revoked' });
    const lic = await row();
    assert.equal(lic.refreshStatus, 'revoked');
    assert.ok(lic.revokedAt);
});

test('expired expires at once only when the local expiry has passed too', async () => {
    replyJson({ status: 'expired' });
    const r = await refresh.refreshOne(await stored({ expiresAt: iso(10 * DAY) }));
    assert.equal(r.graceWindow, 10 * 86400);
    assert.equal((await row()).refreshStatus, 'grace', 'one reply does not end a licence that is still in date');

    await pg.exec('DELETE FROM license_keys');
    const lapsed = await stored();
    const r2 = await refresh.refreshOne({ ...lapsed, expiresAt: iso(-1000) });
    assert.equal(r2.graceWindow, 0);
    assert.equal((await row()).refreshStatus, 'expired');
});

// ── Active ──────────────────────────────────────────────────────────────

test('active without a token confirms the licence and keeps its token', async () => {
    replyJson({ status: 'active' });
    await stored();
    await pg.query(`UPDATE license_keys SET refresh_status = 'grace'`);
    assert.deepEqual(await refresh.refreshOne(await row()), { ok: true, status: 'active', renewed: false });
    const lic = await row();
    assert.equal(lic.refreshStatus, 'active');
    assert.equal(lic.rawToken, 'tok-original');
    assert.ok(lic.lastRefreshAt);
});

test('active with a valid new token for this licence replaces the token and the expiry', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60 * 86400;
    const token = sign(claims({ license_id: 'lic-1', exp }));
    replyJson({ status: 'active', new_token: token });
    assert.deepEqual(await refresh.refreshOne(await stored()), { ok: true, status: 'active', renewed: true });
    const lic = await row();
    assert.equal(lic.rawToken, token);
    assert.equal(new Date(lic.expiresAt).getTime(), exp * 1000);
});

test('a new token that does not verify, has expired, or names another licence is refused and stored nowhere', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
        [signWithOtherKey(claims({ license_id: 'lic-1' })), 'invalid_signature'],
        [sign(claims({ license_id: 'lic-1', exp: now - 10 })), 'token_expired'],
        [sign(claims({ license_id: 'lic-1', iss: 'someone.else' })), 'untrusted_issuer: someone.else'],
        [sign(claims({ license_id: 'lic-OTHER' })), 'payload_mismatch'],
        ['not-a-jwt', 'decode_failed: Malformed JWT'],
    ];
    for (const [token, error] of cases) {
        await pg.exec('DELETE FROM license_keys');
        replyJson({ status: 'active', new_token: token });
        const r = await refresh.refreshOne(await stored());
        assert.deepEqual(r, { ok: false, reason: 'bad_new_token', error }, error);
        const lic = await row();
        assert.equal(lic.rawToken, 'tok-original', error);
        assert.equal(lic.refreshStatus, 'grace', error);
    }
});

// ── The scheduler tick ──────────────────────────────────────────────────

test('a tick refreshes the due licences and counts them', async () => {
    replyJson({ status: 'revoked' });
    await stored();
    await stored({ licenseId: 'lic-y', organizationId: 'org-b', billingInterval: 'yearly' });
    await refresh.tick();
    assert.equal((await row()).refreshStatus, 'revoked');
    assert.equal((await row('lic-y')).refreshStatus, 'active');
    assert.equal(refresh.getRefresherHealth().lastTickProcessed, 1);
    assert.equal(refresh.getRefresherHealth().lastTickError, null);
});

// ── Revocation list ─────────────────────────────────────────────────────

test('the revocation list revokes what it names, skips entries without an id, and stores the next cursor', async () => {
    await stored();
    await stored({ licenseId: 'lic-b', organizationId: 'org-b' });
    config.set('license_crl_last_since', '5');
    replyJson({ revoked: [{ license_id: 'lic-1', reason: 'refund' }, { reason: 'no id' }, null], next_since: 9 });
    await refresh.crlTick();
    assert.deepEqual(asked, ['https://license.example.test/v1/crl?since=5']);
    assert.equal((await row()).refreshStatus, 'revoked');
    assert.equal((await row('lic-b')).refreshStatus, 'active');
    assert.equal(config.get('license_crl_last_since'), 9);
    assert.equal(refresh.getRefresherHealth().crl.lastProcessed, 1);
});

test('the revocation cursor never moves back', async () => {
    config.set('license_crl_last_since', '20');
    replyJson({ revoked: [], next_since: 3 });
    await refresh.crlTick();
    assert.equal(config.get('license_crl_last_since'), '20');
    assert.equal(refresh.getRefresherHealth().crl.lastSince, 20, 'health reports the cursor that is kept');
});

test('a revocation list that fails or does not parse revokes nothing and records why', async () => {
    await stored();
    answer = () => ({ status: 502, body: JSON.stringify({ revoked: [{ license_id: 'lic-1' }] }) });
    await refresh.crlTick();
    assert.equal(refresh.getRefresherHealth().crl.lastError, 'http_502');
    answer = () => ({ status: 200, body: 'garbage' });
    await refresh.crlTick();
    assert.equal(refresh.getRefresherHealth().crl.lastError, 'malformed_response');
    assert.equal((await row()).refreshStatus, 'active');
    assert.equal(config.has('license_crl_last_since'), false);
});
