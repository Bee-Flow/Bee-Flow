/**
 * The trail of a Cowork item (./coworkAudit.mts): what is written (an allow-list: field names, and only the values
 * that say when and how the work runs) and how its owner reads it back. The audit store is handed in.
 *
 * Run: cd server && node --test usecases/coworkAudit.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { changeOf, recordCowork, trailOf, TARGET_TYPE } = require('./coworkAudit.mts');

test('a change names every field it touched, keeps the values of the schedule and the plan, and never copies the text of the work', () => {
    const change = changeOf({
        title: 'Supplier radar for Anna Bakker', prompt: 'Read anna@example.com and tell me', isActive: false,
        repeatInterval: 'daily', timeOfDay: '07:30', agentId: 'agent-1', trigger: { kind: 'mail', from: 'anna@example.com' },
        unknownColumnNextYear: 'whatever', fingerprint: 'f'.repeat(64),
    });
    assert.deepStrictEqual(change.changed, ['agentId', 'fingerprint', 'isActive', 'prompt', 'repeatInterval', 'timeOfDay', 'title', 'trigger']);
    assert.deepStrictEqual(change.values, { isActive: false, repeatInterval: 'daily', timeOfDay: '07:30', agentId: 'agent-1', fingerprint: 'f'.repeat(64) });
    assert.ok(!JSON.stringify(change).includes('Anna') && !JSON.stringify(change).includes('example.com'));
    assert.deepStrictEqual(changeOf(null), { changed: [], values: {} });
});

test('an entry goes to the organisation\'s access audit log, under the item and the person who made the change', async () => {
    const written = [];
    await recordCowork('cowork.updated', 'cw-1', { userId: 'u1', organizationId: 'org-1' }, { isActive: true }, {
        logAccessAudit: async (...args) => { written.push(args); },
        getAccessAuditLog: async () => [],
    });
    assert.deepStrictEqual(written, [['cowork.updated', TARGET_TYPE, 'cw-1', 'u1', null, { changed: ['isActive'], values: { isActive: true } }, 'org-1']]);
});

test('a trail that could not be written never fails the change it describes', async () => {
    await recordCowork('cowork.deleted', 'cw-1', { userId: 'u1' }, null, { logAccessAudit: async () => { throw new Error('db down'); }, getAccessAuditLog: async () => [] });
});

test('the owner reads the trail newest first, sees which entries were theirs, and the values that were kept', async () => {
    const asked = [];
    const rows = [
        { action: 'cowork.plan_approved', created_at: '2026-11-23T09:00:00.000Z', changed_by: 'u1', new_values: { changed: ['fingerprint'], values: { fingerprint: 'abc' } } },
        { action: 'cowork.toggled', created_at: '2026-11-22T09:00:00.000Z', changed_by: 'admin-7', new_values: null },
    ];
    const trail = await trailOf('cw-1', 'u1', { logAccessAudit: async () => {}, getAccessAuditLog: async (opts) => { asked.push(opts); return rows; } });
    assert.deepStrictEqual(asked, [{ targetType: TARGET_TYPE, targetId: 'cw-1', limit: 100 }]);
    assert.deepStrictEqual(trail, [
        { action: 'cowork.plan_approved', at: '2026-11-23T09:00:00.000Z', byYou: true, changed: ['fingerprint'], values: { fingerprint: 'abc' } },
        { action: 'cowork.toggled', at: '2026-11-22T09:00:00.000Z', byYou: false, changed: [], values: {} },
    ]);
    assert.ok(!JSON.stringify(trail).includes('admin-7'), 'who else changed it is not named to the owner');
});
