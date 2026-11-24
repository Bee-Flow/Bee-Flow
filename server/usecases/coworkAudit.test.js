/**
 * The trail of a Cowork item (./coworkAudit.mts): what is written (an allow-list: field names, and only the values
 * that say when and how the work runs) and how its owner reads it back. The audit store is handed in.
 *
 * Run: cd server && node --test usecases/coworkAudit.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { changeOf, recordCowork, trailOf, TARGET_TYPE, AUDITED_FIELDS } = require('./coworkAudit.mts');

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

test('who a cowork is shared with is kept as ids and roles only, rebuilt from an allow-list and capped', () => {
    const raw = [
        { userId: 'u-2', role: 'approver', name: 'Anna Bakker', email: 'anna@example.com' }, { userId: 'u-3', role: 'viewer' },
        { userId: 'u-4', role: 'owner' }, { userId: 7, role: 'viewer' }, { userId: 'x'.repeat(201), role: 'viewer' }, null, 'u-5',
    ];
    const change = changeOf({ shares: raw });
    assert.deepStrictEqual(change.changed, ['shares']);
    assert.deepStrictEqual(change.values, { shares: [{ userId: 'u-2', role: 'approver' }, { userId: 'u-3', role: 'viewer' }] });
    assert.ok(!JSON.stringify(change).includes('Anna') && !JSON.stringify(change).includes('example.com'));
    assert.deepStrictEqual(changeOf({ shares: [] }).values, { shares: [] });
    assert.deepStrictEqual(changeOf({ shares: 'u-2' }).values, { shares: [] });
    const many = Array.from({ length: 80 }, (_, i) => ({ userId: `u-${i}`, role: 'viewer' }));
    assert.strictEqual(/** @type {unknown[]} */ (changeOf({ shares: many }).values.shares).length, 50);
});

test('an entry that names who got access reads back in the owner\'s trail', async () => {
    const shares = [{ userId: 'u-2', role: 'approver' }];
    const rows = [{ action: 'cowork.shares_set', created_at: '2026-11-23T09:00:00.000Z', changed_by: 'u1', new_values: changeOf({ shares }) }];
    const [entry] = await trailOf('cw-1', 'u1', { logAccessAudit: async () => {}, getAccessAuditLog: async () => rows });
    assert.deepStrictEqual([entry.changed, entry.values], [['shares'], { shares }]);
});

test('every field a trail entry can name has its words, so the owner never reads a raw name like "monthlyBudget"', () => {
    const en = require('../i18n/defaults/en/cowork_trail.js');
    const nl = require('../i18n/defaults/nl/cowork_trail.json').translations;
    assert.ok(AUDITED_FIELDS.includes('monthlyBudget') && AUDITED_FIELDS.includes('shares'));
    for (const field of AUDITED_FIELDS) {
        assert.ok(typeof en[`cowork_trail.field.${field}`] === 'string', `English for ${field}`);
        assert.ok(typeof nl[`cowork_trail.field.${field}`] === 'string', `Dutch for ${field}`);
    }
    assert.strictEqual(en['cowork_trail.field.monthlyBudget'], 'the budget');
});
