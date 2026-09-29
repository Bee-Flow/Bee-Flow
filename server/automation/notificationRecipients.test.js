/**
 * automation/notificationRecipients: who a routine notification reaches.
 *
 * Run: cd server && node --test automation/notificationRecipients.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRecipientIds, resolveDigestRecipientIds, MAX_RECIPIENT_IDS } = require('./notificationRecipients');

const USERS = [
    { id: 'owner', organizationId: 'org1', groups: '[]' },
    { id: 'ann', organizationId: 'org1', groups: '["g-fin"]' },
    { id: 'bob', organizationId: 'org1', groups: ['g-fin', 'g-ops'] },
    { id: 'gone', organizationId: 'org1', groups: '["g-fin"]', status: 'disabled' },
    { id: 'eve', organizationId: 'org2', groups: '["g-fin"]' },
];
const automation = { id: 'a1', userId: 'owner' };
let listed = 0;
const deps = { listUsers: async () => { listed += 1; return USERS; } };

test('owner is the routine owner', async () => {
    assert.deepEqual(await resolveRecipientIds({ recipients: [{ type: 'owner' }] }, { automation, orgId: 'org1' }, deps), ['owner']);
});

test('approver is whoever the approval asks, else the owner', async () => {
    const ev = { recipients: [{ type: 'approver' }] };
    assert.deepEqual(await resolveRecipientIds(ev, { automation, orgId: 'org1', approverIds: ['ann', 'bob'] }, deps), ['ann', 'bob']);
    assert.deepEqual(await resolveRecipientIds(ev, { automation, orgId: 'org1' }, deps), ['owner']);
});

test('a user counts only while an active member of the organisation', async () => {
    const ev = { recipients: [{ type: 'user', id: 'ann' }, { type: 'user', id: 'eve' }, { type: 'user', id: 'gone' }, { type: 'user', id: 'nobody' }] };
    assert.deepEqual(await resolveRecipientIds(ev, { automation, orgId: 'org1' }, deps), ['ann']);
});

test('a group is its active members in this organisation', async () => {
    const ev = { recipients: [{ type: 'group', id: 'g-fin' }] };
    assert.deepEqual(await resolveRecipientIds(ev, { automation, orgId: 'org1' }, deps), ['ann', 'bob']);
});

test('duplicates collapse, order follows the recipients', async () => {
    const ev = { recipients: [{ type: 'user', id: 'bob' }, { type: 'owner' }, { type: 'group', id: 'g-fin' }, { type: 'approver' }] };
    assert.deepEqual(await resolveRecipientIds(ev, { automation, orgId: 'org1' }, deps), ['bob', 'owner', 'ann']);
});

test('without an organisation only the owner and approvers are reachable', async () => {
    listed = 0;
    const ev = { recipients: [{ type: 'owner' }, { type: 'user', id: 'ann' }, { type: 'group', id: 'g-fin' }] };
    assert.deepEqual(await resolveRecipientIds(ev, { automation, orgId: null }, deps), ['owner']);
    assert.equal(listed, 0, 'no member lookup without an organisation');
});

test('owner and approver alone never list the organisation', async () => {
    listed = 0;
    await resolveRecipientIds({ recipients: [{ type: 'owner' }, { type: 'approver' }] }, { automation, orgId: 'org1' }, deps);
    assert.equal(listed, 0);
});

test('a failing member lookup degrades to owner/approver', async () => {
    const broken = { listUsers: async () => { throw new Error('db down'); } };
    const ev = { recipients: [{ type: 'owner' }, { type: 'group', id: 'g-fin' }] };
    assert.deepEqual(await resolveRecipientIds(ev, { automation, orgId: 'org1' }, broken), ['owner']);
});

test('fan-out is capped', async () => {
    const big = Array.from({ length: 80 }, (_, i) => ({ id: `u${i}`, organizationId: 'org1', groups: ['g'] }));
    const ids = await resolveRecipientIds({ recipients: [{ type: 'group', id: 'g' }] }, { automation, orgId: 'org1' }, { listUsers: async () => big });
    assert.equal(ids.length, MAX_RECIPIENT_IDS);
});

test('digest recipients: owner plus named people of enabled events, never "the approver"', async () => {
    const settings = {
        onError: { enabled: true, recipients: [{ type: 'owner' }, { type: 'user', id: 'ann' }] },
        onApproval: { enabled: true, recipients: [{ type: 'approver' }] },
        onSuccess: { enabled: false, recipients: [{ type: 'user', id: 'bob' }] },
    };
    assert.deepEqual(await resolveDigestRecipientIds(settings, { automation, orgId: 'org1' }, deps), ['owner', 'ann']);
});
