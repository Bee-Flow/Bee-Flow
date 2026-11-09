/**
 * The Activity API answers 304 when the end of the list is reached (nothing
 * newer than `since`, or no activity at all) and 204 when the user has no
 * activity types selected. Both mean "an empty list", not a failure.
 *
 * Run: cd server && node --test integrations/nextcloudActivityTools.notModified.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

require('../testUtils/routeHarness').recordDb();
const { installFakeNc, resetFakeNc } = require('./nextcloudToolFakes');
const { executeNextcloudActivityTool } = require('./nextcloudActivityTools');

test.after(() => resetFakeNc());

/**
 * @param {number} status
 * @returns {any}
 */
const empty = (status) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => '' });

for (const status of [304, 204]) {
    test(`nextcloud_activity_list: HTTP ${status} is an empty list, not an error`, async () => {
        installFakeNc(() => empty(status));
        const out = await executeNextcloudActivityTool('nextcloud_activity_list', { since: 4711 }, 'user-1', {});
        assert.deepStrictEqual(out, { count: 0, activities: [] });
    });

    test(`nextcloud_activity_list_for_file: HTTP ${status} is an empty list, not an error`, async () => {
        installFakeNc(() => empty(status));
        const out = await executeNextcloudActivityTool('nextcloud_activity_list_for_file', { fileId: '12' }, 'user-1', {});
        assert.strictEqual(out.error, undefined);
        assert.strictEqual(out.count, 0);
    });
}

test('nextcloud_activity_list: a real failure still comes back as an error', async () => {
    installFakeNc(() => empty(500));
    const out = await executeNextcloudActivityTool('nextcloud_activity_list', {}, 'user-1', {});
    assert.ok(out.error);
});
