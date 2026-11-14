'use strict';

/**
 * license/issuance.js: the licence asked for after a paid checkout, and what
 * is activated from the answer. The licence server is a stand-in `fetch`;
 * activation is the real one (verifier with a key pair made for this run,
 * store on PGlite).
 *
 *   - Community, or no tier, asks nothing
 *   - a callout that fails, an error status, or an answer without token and
 *     licence id is an error with its own code, and nothing is activated
 *   - a token that does not verify, or an admin blob, is not activated
 *   - an organisation checkout binds the licence to the organisation only, a
 *     consumer checkout to the user only
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test license/issuance.pg.test.js
 */

process.env.NODE_ENV = 'test';
process.env.LICENSE_ISSUE_URL = 'https://license.example.test/v1/issue';
process.env.LICENSE_ISSUE_API_KEY = 'issue-api-key-for-tests';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');

const { pg, close } = usePglitePool();
const verify = require('./verify');
const { issueLicenseFromCheckout } = require('./issuance');
const { encodeAdminLicenseBlob } = require('./adminIssuance');
const { publicKey, sign, signWithOtherKey, claims } = require('./licenseJwt.testkit');
const { initDB: initUsers } = require('../stores/user/schema');

/** @type {{ url: string, init: any }[]} */
const asked = [];
let answer = () => new Response('{}', { status: 200 });
/** @type {() => void} */
let restoreSlow = () => {};

const { swap, restore } = makeSwaps();
before(async () => {
    await initUsers();
    await pg.exec(`
        INSERT INTO organizations (id, name) VALUES ('org-a', 'A');
        INSERT INTO users (id, username, "organizationId") VALUES ('u-1', 'u1', NULL);
    `);
    verify._setPublicKeyForTesting(publicKey);
    swap(globalThis, 'fetch', async (url, init) => { asked.push({ url: String(url), init }); return answer(); });
});
after(async () => { restore(); verify._setPublicKeyForTesting(null); await close(); });
beforeEach(async () => { asked.length = 0; await pg.exec('DELETE FROM license_keys'); });

const orgCheckout = (over = {}) => ({
    scope: /** @type {const} */ ('organization'), organizationId: 'org-a', userId: 'u-1', planId: 'plan-ent', tier: 'enterprise',
    stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', ...over,
});
const replyJson = (obj, status = 200) => { answer = () => new Response(JSON.stringify(obj), { status }); };
const storedRows = async () => (await pg.query('SELECT id, scope, organization_id, user_id, tier, activated_by FROM license_keys')).rows;

test('Community or no tier asks the licence server nothing', async () => {
    assert.equal(await issueLicenseFromCheckout(orgCheckout({ tier: 'community' })), null);
    assert.equal(await issueLicenseFromCheckout(orgCheckout({ tier: '' })), null);
    assert.deepEqual(asked, []);
});

test('the request carries the checkout, the API key, and no more', async () => {
    replyJson({ token: sign(claims({ license_id: 'lic-req' })), license_id: 'lic-req' });
    await issueLicenseFromCheckout(orgCheckout());
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, 'https://license.example.test/v1/issue');
    assert.equal(asked[0].init.method, 'POST');
    assert.equal(asked[0].init.headers['X-API-Key'], 'issue-api-key-for-tests');
    assert.deepEqual(JSON.parse(asked[0].init.body), {
        scope: 'organization', organization_id: 'org-a', user_id: 'u-1', plan_id: 'plan-ent', tier: 'enterprise',
        stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1',
    });
});

test('a failed callout is callout_failed and activates nothing', async () => {
    answer = () => { throw new Error('ECONNRESET'); };
    await assert.rejects(issueLicenseFromCheckout(orgCheckout()), (e) => e.code === 'callout_failed' && /ECONNRESET/.test(e.message));
    assert.deepEqual(await storedRows(), []);
});

test('an error status, or an answer without token or licence id, is license_server_error and activates nothing', async () => {
    const token = sign(claims({ license_id: 'lic-x' }));
    const cases = [
        [() => new Response(JSON.stringify({ token, license_id: 'lic-x' }), { status: 402 }), 402],
        [() => new Response(JSON.stringify({ license_id: 'lic-x' }), { status: 200 }), 200],
        [() => new Response(JSON.stringify({ token }), { status: 200 }), 200],
        [() => new Response('not json', { status: 200 }), 200],
    ];
    for (const [reply, status] of cases) {
        answer = reply;
        await assert.rejects(issueLicenseFromCheckout(orgCheckout()), (e) => e.code === 'license_server_error' && e.httpStatus === status);
    }
    assert.deepEqual(await storedRows(), []);
});

test('a token that does not verify is activation_failed, names the licence, and stores nothing', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const token of [
        signWithOtherKey(claims({ license_id: 'lic-bad' })),
        sign(claims({ license_id: 'lic-bad', exp: now - 1 })),
        sign(claims({ license_id: 'lic-bad', iss: 'evil.example' })),
    ]) {
        replyJson({ token, license_id: 'lic-bad' });
        await assert.rejects(issueLicenseFromCheckout(orgCheckout()), (e) => e.code === 'activation_failed' && e.licenseId === 'lic-bad');
    }
    assert.deepEqual(await storedRows(), []);
});

test('an admin blob in the answer is not activated: a checkout is not a super-admin', async () => {
    // A complete blob, which a super-admin could activate: the refusal must be the blob rule, not a missing field.
    const blob = encodeAdminLicenseBlob({
        v: 1, tier: 'full', issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), billing_interval: 'yearly', metadata: {},
    });
    replyJson({ token: blob, license_id: 'lic-blob' });
    await assert.rejects(issueLicenseFromCheckout(orgCheckout()), (e) => e.code === 'activation_failed' && /super-admin/.test(e.message));
    assert.deepEqual(await storedRows(), []);
});

test('an organisation checkout activates the licence for the organisation only', async () => {
    const token = sign(claims({ license_id: 'lic-org', sub: 'org-a' }));
    replyJson({ token, license_id: 'lic-org' });
    assert.deepEqual(await issueLicenseFromCheckout(orgCheckout()), { token, licenseId: 'lic-org' });
    assert.deepEqual(await storedRows(), [{ id: 'lic-org', scope: 'organization', organization_id: 'org-a', user_id: null, tier: 'enterprise', activated_by: 'stripe_webhook' }]);
});

test('a consumer checkout activates the licence for the user only', async () => {
    const token = sign(claims({ license_id: 'lic-usr', sub: 'u-1' }));
    replyJson({ token, license_id: 'lic-usr' });
    await issueLicenseFromCheckout(orgCheckout({ scope: 'consumer', organizationId: 'org-a', userId: 'u-1' }));
    assert.deepEqual(await storedRows(), [{ id: 'lic-usr', scope: 'consumer', organization_id: null, user_id: 'u-1', tier: 'enterprise', activated_by: 'stripe_webhook' }]);
});

test('the activation is asked for the organisation or for the user, never both', async (t) => {
    const license = require('./index');
    const activations = t.mock.method(license, 'activateLicense', async () => ({}));
    replyJson({ token: 'any-token', license_id: 'lic-args' });
    await issueLicenseFromCheckout(orgCheckout());
    await issueLicenseFromCheckout(orgCheckout({ scope: 'consumer' }));
    assert.deepEqual(activations.mock.calls.map((c) => c.arguments[0]), [
        { token: 'any-token', organizationId: 'org-a', userId: null, activatedBy: 'stripe_webhook' },
        { token: 'any-token', organizationId: null, userId: 'u-1', activatedBy: 'stripe_webhook' },
    ]);
});

test('an answer that takes a moment is waited for: the time limit is seconds, not the next tick', async () => {
    const token = sign(claims({ license_id: 'lic-slow' }));
    answer = () => new Response(JSON.stringify({ token, license_id: 'lic-slow' }), { status: 200 });
    restoreSlow = swap(globalThis, 'fetch', async (_url, init) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (init.signal.aborted) throw new Error('aborted before the licence server answered');
        return answer();
    });
    try {
        assert.deepEqual(await issueLicenseFromCheckout(orgCheckout()), { token, licenseId: 'lic-slow' });
    } finally { restoreSlow(); }
});
