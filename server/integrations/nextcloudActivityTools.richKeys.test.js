// @typecheck
/**
 * The activity rows carry the parameter names of the rich subject, which are
 * the same in every language, in both shapes the Activity API sends
 * `subject_rich` in. The incoming-share read returns the shared file ids.
 *
 * Run: cd server && node --test integrations/nextcloudActivityTools.richKeys.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

require('../testUtils/routeHarness').recordDb();
const { installFakeNc, resetFakeNc } = require('./nextcloudToolFakes');
const { executeNextcloudActivityTool, incomingShareFileIds } = require('./nextcloudActivityTools');

test.after(() => resetFakeNc());

/**
 * @param {number} status
 * @param {unknown} body
 * @returns {any}
 */
const json = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });

const file = (id, path) => ({ type: 'file', id: String(id), name: path.split('/').pop(), path });

test('nextcloud_activity_list: rich parameter names are passed on for the array and the object shape', async () => {
    const data = [
        { activity_id: 1, type: 'file_changed', subject: 'Du hast a.pdf nach Rechnungen/a.pdf verschoben',
            subject_rich: ['Du hast {oldfile} nach {newfile} verschoben', { newfile: file(7, 'Rechnungen/a.pdf'), oldfile: file(7, 'a.pdf') }] },
        { activity_id: 2, type: 'file_changed', subject: 'Vous avez déplacé a.pdf dans Factures/a.pdf',
            subject_rich: { 0: 'Vous avez déplacé {oldfile} dans {newfile}', 1: { newfile: file(7, 'Factures/a.pdf'), oldfile: file(7, 'a.pdf') } } },
        { activity_id: 3, type: 'file_changed', subject: 'Je wijzigde a.pdf', subject_rich: ['Je wijzigde {file}', { file: file(7, 'a.pdf') }] },
        { activity_id: 4, type: 'calendar', subject: 'Termin', subject_rich: ['Termin', []] },
        { activity_id: 5, type: 'file_created', subject: 'created' },
    ];
    installFakeNc(() => json(200, { ocs: { data } }));
    const out = /** @type {any} */ (await executeNextcloudActivityTool('nextcloud_activity_list', {}, 'user-1', {}));
    assert.deepStrictEqual(out.activities.map((a) => a.richKeys), [['newfile', 'oldfile'], ['newfile', 'oldfile'], ['file'], undefined, undefined]);
    assert.ok(!('richKeys' in out.activities[4]), 'a row without rich parameters gains no key');
});

test('incomingShareFileIds: the ids of the files shared with the user; null when the list cannot be read', async () => {
    const calls = installFakeNc(() => json(200, { ocs: { data: [{ id: '3', file_source: 55, item_source: 55 }, { id: '4', file_source: 60 }] } }));
    const ids = await incomingShareFileIds('user-1', {});
    assert.deepStrictEqual([...(ids || [])].sort(), ['55', '60']);
    assert.match(calls[0].url, /\/apps\/files_sharing\/api\/v1\/shares\?format=json&shared_with_me=true$/);

    installFakeNc(() => json(404, {}));
    assert.strictEqual(await incomingShareFileIds('user-1', {}), null);
    installFakeNc(() => json(200, { ocs: { data: null } }));
    assert.strictEqual(await incomingShareFileIds('user-1', {}), null);
});
