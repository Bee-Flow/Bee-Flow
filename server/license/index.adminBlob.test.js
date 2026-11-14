'use strict';

/**
 * license/index.js activateLicense with a licence a super-admin issued (an
 * admin blob): what it is bound to, and what a replaced server-wide licence
 * leaves behind. The store and the module bookkeeping are stand-ins on the
 * objects the licence module calls them through.
 *
 *   - an organisation activation binds to the organisation given, else to the
 *     one the blob names; with neither it is refused and nothing is stored
 *   - a user activation binds to the user only, a server activation to neither
 *   - a server activation that replaces another licence records the replaced
 *     id; the first one, or the same id again, records nothing
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test license/index.adminBlob.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('./store');
const license = require('./index');
const subjects = require('../modules/subjects');
const { sign, claims, publicKey } = require('./licenseJwt.testkit');
const verify = require('./verify');

const blob = (over = {}) => license.adminIssuance.encodeAdminLicenseBlob({
    v: 1, tier: 'enterprise', issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), ...over,
});

/**
 * The store and the bookkeeping, recording.
 * @param {import('node:test').TestContext} t
 * @param {{ id?: string } | null} [serverLicence] the server-wide licence that is active before the activation
 */
function arrange(t, serverLicence = null) {
    return {
        upserts: t.mock.method(store, 'upsertLicense', async (/** @type {any} */ args) => ({ id: args.licenseId, ...args })),
        server: t.mock.method(store, 'getActiveLicenseForServer', async () => serverLicence),
        superseded: t.mock.method(subjects, 'recordSupersededLicenseId', async () => {}),
    };
}
/** @param {{ mock: { calls: { arguments: any[] }[] } }} fn */
const firstArgs = (fn) => fn.mock.calls.map((c) => c.arguments[0]);
/** What an activation was bound to. @param {any} a */
const binding = (a) => ({ scope: a.scope, organizationId: a.organizationId, userId: a.userId });

test('an organisation activation binds to the organisation given, else to the one the blob names', async (t) => {
    const calls = arrange(t);
    await license.activateLicense({ token: blob({ organization_id: 'org-in-blob' }), organizationId: 'org-given', allowAdminBlob: true });
    await license.activateLicense({ token: blob({ organization_id: 'org-in-blob' }), allowAdminBlob: true });
    assert.deepEqual(firstArgs(calls.upserts).map(binding), [
        { scope: 'organization', organizationId: 'org-given', userId: null },
        { scope: 'organization', organizationId: 'org-in-blob', userId: null },
    ]);
    assert.equal(calls.superseded.mock.callCount(), 0, 'an organisation licence replaces no server licence');
});

test('an organisation activation that names no organisation anywhere is refused and stores nothing', async (t) => {
    const calls = arrange(t);
    await assert.rejects(
        license.activateLicense({ token: blob(), allowAdminBlob: true }),
        (/** @type {any} */ err) => err.code === 'missing_org_context',
    );
    assert.equal(calls.upserts.mock.callCount(), 0);
});

test('a user activation binds to the user only; a server activation to nobody', async (t) => {
    const calls = arrange(t);
    await license.activateLicense({ token: blob({ organization_id: 'org-in-blob' }), userId: 'u-1', organizationId: 'org-given', allowAdminBlob: true });
    await license.activateLicense({ token: blob({ organization_id: 'org-in-blob' }), scope: 'server', userId: 'u-1', organizationId: 'org-given', allowAdminBlob: true });
    assert.deepEqual(firstArgs(calls.upserts).map(binding), [
        { scope: 'consumer', organizationId: null, userId: 'u-1' },
        { scope: 'server', organizationId: null, userId: null },
    ]);
});

test('a server activation that replaces another licence records the replaced id', async (t) => {
    const calls = arrange(t, { id: 'srv-old' });
    const activated = await license.activateLicense({ token: blob(), scope: 'server', allowAdminBlob: true });
    assert.deepEqual(firstArgs(calls.superseded), ['srv-old']);
    assert.notEqual(activated.id, 'srv-old', 'the activation gets an id of its own');
});

test('the first server licence, or the same licence activated again, records nothing as replaced', async (t) => {
    const first = arrange(t, null);
    await license.activateLicense({ token: blob(), scope: 'server', allowAdminBlob: true });
    assert.equal(first.superseded.mock.callCount(), 0);

    // A signed licence keeps its id, so activating it again replaces itself.
    verify._setPublicKeyForTesting(publicKey);
    t.after(() => verify._setPublicKeyForTesting(null));
    const again = arrange(t, { id: 'lic-same' });
    await license.activateLicense({ token: sign(claims({ license_id: 'lic-same' })), scope: 'server' });
    assert.equal(again.superseded.mock.callCount(), 0);
    const version = license.getServerLicenseVersion();
    await license.activateLicense({ token: sign(claims({ license_id: 'lic-next' })), scope: 'server' });
    assert.deepEqual(firstArgs(again.superseded), ['lic-same']);
    assert.equal(license.getServerLicenseVersion(), version + 1, 'every cached tier resolution is stale from here');
});
