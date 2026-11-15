// @typecheck
/**
 * nextcloud_get_user: OCS cloud/users/<uid> as
 * { uid, displayName, email, groups[], manager[], language }; a profile the
 * caller may not read is a plain error, never a crash.
 *
 * Run: cd server && node --test integrations/nextcloudFiles/userProfile.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../../testUtils/routeHarness').recordDb();
const { installFakeNc, resetFakeNc, json } = require('../nextcloudToolFakes');
const { executeNextcloudTool } = require('../nextcloudTools');

test.after(resetFakeNc);

const ocs = (/** @type {number} */ statuscode, /** @type {unknown} */ data) => ({ ocs: { meta: { status: statuscode < 300 ? 'ok' : 'failure', statuscode }, data } });

test('the profile fields, groups and manager list', async () => {
    const calls = installFakeNc(() => json(200, ocs(200, {
        id: 'carol', displayname: 'Carol Example', email: 'carol@example.com', groups: ['staff', 'finance'],
        manager: ['dave'], language: 'nl', quota: { used: 1 }, phone: '+31 000',
    })));
    const out = await executeNextcloudTool('nextcloud_get_user', { uid: 'carol' }, 'u1', {});
    assert.deepStrictEqual(out, { uid: 'carol', displayName: 'Carol Example', email: 'carol@example.com', groups: ['staff', 'finance'], manager: ['dave'], language: 'nl' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://nc.example.test/ocs/v2.php/cloud/users/carol?format=json');
});

test('a manager given as one string, missing fields as null / empty lists', async () => {
    installFakeNc(() => json(200, ocs(200, { id: 'erin', 'display-name': 'Erin', manager: 'frank', email: null })));
    const out = await executeNextcloudTool('nextcloud_get_user', { uid: 'erin' }, 'u1', {});
    assert.deepStrictEqual(out, { uid: 'erin', displayName: 'Erin', email: null, groups: [], manager: ['frank'], language: null });
});

test('a uid with reserved characters is encoded', async () => {
    const calls = installFakeNc(() => json(200, ocs(200, { id: 'a b@x' })));
    await executeNextcloudTool('nextcloud_get_user', { uid: 'a b@x' }, 'u1', {});
    assert.strictEqual(calls[0].url, 'https://nc.example.test/ocs/v2.php/cloud/users/a%20b%40x?format=json');
});

for (const [status, statuscode, what] of /** @type {Array<[number, number, string]>} */ ([
    [404, 404, 'another user (OCS v2 not found)'],
    [200, 998, 'another user (OCS v1 code in a 200)'],
    [403, 403, 'a forbidden read'],
    [200, 997, 'an unauthorised read'],
])) {
    test(`${what} is a plain error naming the way round`, async () => {
        installFakeNc(() => json(status, ocs(statuscode, [])));
        const out = /** @type {any} */ (await executeNextcloudTool('nextcloud_get_user', { uid: 'bob' }, 'u1', {}));
        assert.match(out.error, /does not show the profile of "bob"/);
        assert.match(out.error, /nextcloud_contacts_search/);
    });
}

test('a 401 is the auth message; a 500 a plain error', async () => {
    installFakeNc(() => json(401, {}));
    assert.strictEqual(/** @type {any} */ (await executeNextcloudTool('nextcloud_get_user', { uid: 'bob' }, 'u1', {})).error, 'auth');
    installFakeNc(() => json(500, 'oops'));
    assert.match(/** @type {any} */ (await executeNextcloudTool('nextcloud_get_user', { uid: 'bob' }, 'u1', {})).error, /Could not read the Nextcloud user "bob" \(500\)/);
});

test('a missing or path-like uid is refused before any call', async () => {
    const calls = installFakeNc(() => json(200, ocs(200, {})));
    for (const uid of [undefined, '', '  ', '../admin', 'a/b', 'a\\b', 'x\ny', 'x'.repeat(256)]) {
        const out = /** @type {any} */ (await executeNextcloudTool('nextcloud_get_user', { uid }, 'u1', {}));
        assert.match(out.error, /uid is required/, String(uid));
    }
    assert.deepStrictEqual(calls, []);
});
