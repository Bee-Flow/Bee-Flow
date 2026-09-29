/**
 * suppressSessionPersistence — header-authenticated requests must not write
 * session rows.
 *
 * Embedded (connector JWT) and bridged (x-session-token) requests carry no
 * cookie the SaaS ever sees again, so a persisted session is a write-only
 * INSERT into user_sessions (~15 per embedded page load — one of the top
 * "slow inside Nextcloud" causes, and unbounded table growth). This suite
 * pins the no-op contract and the wiring: connectorJwt and the bridge
 * middleware suppress; cookie-session flows never do.
 *
 * Run: node --test server/auth/suppressSessionPersistence.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { establishSession, suppressSessionPersistence } = require('./establishSession');

test('save/regenerate become callback-invoking no-ops; touch is inert', () => {
    let stored = 0;
    const session = {
        save: (cb) => { stored += 1; cb && cb(); },
        regenerate: (cb) => { stored += 1; cb && cb(); },
        touch: () => { stored += 1; },
    };
    const req = { session };
    suppressSessionPersistence(req);

    let saveCbRan = false;
    req.session.save(() => { saveCbRan = true; });
    assert.equal(saveCbRan, true, 'express-session\'s end-of-response hook expects the callback to fire');
    let regenCbRan = false;
    req.session.regenerate(() => { regenCbRan = true; });
    assert.equal(regenCbRan, true);
    req.session.touch();
    assert.equal(stored, 0, 'no store write may reach the original session methods');
});

test('save() without a callback does not throw (some callers fire-and-forget)', () => {
    const req = { session: { save() {}, regenerate() {}, touch() {} } };
    suppressSessionPersistence(req);
    assert.doesNotThrow(() => req.session.save());
    assert.doesNotThrow(() => req.session.regenerate());
});

test('missing session is a no-op, not a crash', () => {
    assert.doesNotThrow(() => suppressSessionPersistence({}));
    assert.doesNotThrow(() => suppressSessionPersistence(null));
});

test('session data stays readable after suppression', () => {
    const req = { session: { save() {}, regenerate() {}, touch() {}, user: { id: 'u1' } } };
    suppressSessionPersistence(req);
    req.session.isAuthenticated = true;
    req.session.connectorOrgId = 'org1';
    assert.equal(req.session.user.id, 'u1');
    assert.equal(req.session.isAuthenticated, true);
    assert.equal(req.session.connectorOrgId, 'org1');
});

test('establishSession itself is untouched — cookie flows still persist', async () => {
    const calls = [];
    const req = {
        session: {
            regenerate(cb) { calls.push('regenerate'); req.session = this; cb(); },
            save(cb) { calls.push('save'); cb(); },
        },
    };
    await establishSession(req, { user: { id: 'u1' } });
    assert.deepEqual(calls, ['regenerate', 'save'],
        'cookie-session logins genuinely need the rotation + persisted row');
});

// ── Wiring tripwires: where suppression MUST (and must not) be applied ──────

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

test('connectorJwt establishes the session in-memory, not via establishSession', () => {
    const src = read('./connectorJwt.js');
    assert.ok(src.includes('suppressSessionPersistence(req)'),
        'connector-JWT requests must suppress the per-request session INSERT');
    assert.ok(!/establishSession\(req/.test(src),
        'connectorJwt must not persist sessions — cookies are stripped by the connector, the row is unreachable');
    assert.match(src, /isAuthenticated:\s*true/, 'the canonical authenticated shape must still be written');
    assert.match(src, /connectorOrgId:\s*orgId/, 'the connector binding must still reach the session');
});

test('the x-session-token bridge suppresses; login routes do not', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const bridge = indexSrc.slice(indexSrc.indexOf("x-session-token"), indexSrc.indexOf("x-session-token") + 1500);
    assert.ok(bridge.includes('suppressSessionPersistence'),
        'bridged requests rebuild the session per request — persisting it is pure churn');
    for (const file of ['./login/finalizeLogin.js', './login/signupRoutes.js', './opaqueRoutes.js',
        './oauth/providerCallbackRoutes.js', './oauth/nextcloudLegacyRoutes.js']) {
        const src = read(file);
        assert.ok(!src.includes('suppressSessionPersistence'),
            `${file} is a cookie-session flow and must keep persisting sessions`);
    }
});
