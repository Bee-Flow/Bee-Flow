/**
 * Which automation a plan can be made from (./planSource.mts), and the copy a plan run executes (./planRunCopy.mts).
 *
 * Run: cd server && node --test core/cowork/plan/planSource.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { planSourceOf, isManagedByStage } = require('./planSource.mts');
const { runCopyOf, OWNER_ONLY_NOTIFICATIONS } = require('./planRunCopy.mts');
const { planFingerprint } = require('./planPermissions.mts');
const { supplierRadar } = require('./plan.testkit');
const { normalizeNotificationSettings } = require('../../automationModel/notificationDefaults');

const rows = {
    mine: { id: 'mine', userId: 'u1', kind: 'automation' },
    untyped: { id: 'untyped', userId: 'u1' },
    theirs: { id: 'theirs', userId: 'u2', kind: 'automation' },
    block: { id: 'block', userId: 'u1', kind: 'block' },
    managed: { id: 'managed', userId: 'u1', kind: 'automation', projectId: 'stage-project' },
    inProject: { id: 'inProject', userId: 'u1', kind: 'automation', projectId: 'plain-project' },
};
const deps = { getAutomation: async (id) => rows[id] ?? null, isManaged: async (a) => a.projectId === 'stage-project' };

test('a plan is made from an automation of the owner\'s own: not someone else\'s, not a building block, not one a Solution manages', async () => {
    const got = {};
    for (const id of [...Object.keys(rows), 'no-such', '', null, undefined]) got[String(id)] = (await planSourceOf(id, 'u1', deps))?.id ?? null;
    assert.deepStrictEqual(got, {
        mine: 'mine', untyped: 'untyped', inProject: 'inProject',
        theirs: null, block: null, managed: null, 'no-such': null, '': null, null: null, undefined: null,
    });
});

test('an automation outside any project is managed by nothing, without a lookup', async () => {
    for (const projectId of [null, undefined, '', 7]) assert.strictEqual(await isManagedByStage({ id: 'a', userId: 'u1', projectId }), false);
});

test('the copy a run executes is the approved plan with the run\'s notifications held to its owner', () => {
    const approved = { ...supplierRadar(), notificationSettings: { onApproval: { enabled: true, channels: ['bell', 'talk'], recipients: [{ type: 'approver' }], talkRoom: 'approvals' } } };
    const before = planFingerprint(approved);
    const copy = runCopyOf(approved);
    assert.deepStrictEqual([copy.steps, copy.edges, copy.trigger], [approved.steps, approved.edges, approved.trigger]);
    assert.strictEqual(copy.notificationSettings, OWNER_ONLY_NOTIFICATIONS);
    assert.strictEqual(planFingerprint(approved), before, 'the approved plan is not touched');
    assert.ok(approved.notificationSettings.onApproval.talkRoom, 'nor are its own settings');
});

test('the owner-only settings mean, to the notifier itself: no failure or success message, and a waiting approval on the owner\'s bell alone', () => {
    const read = normalizeNotificationSettings(OWNER_ONLY_NOTIFICATIONS);
    assert.deepStrictEqual([read.onError.enabled, read.onSuccess.enabled, read.digest.enabled], [false, false, false]);
    assert.deepStrictEqual(read.onApproval, { enabled: true, channels: ['bell'], recipients: [{ type: 'owner' }], urgency: 'normal', throttle: { maxPerHour: null }, delivery: 'direct' });
    assert.strictEqual('talkRoom' in read.onApproval, false);
});
