'use strict';

/**
 * The shared approval announcement.
 *
 * The rule this exists to enforce: a BELL is per recipient, a TALK CARD is per
 * conversation. Fanning the card out through the recipient loop would post one
 * identical card per approver into the same room — five approvers, five cards,
 * and five separate 👍 targets of which four are unroutable.
 *
 * Everything else here is "the bell behaves exactly as it did before", because
 * this dispatcher is meant to be dropped in front of seven existing
 * createNotification call sites without changing a single thing a user sees
 * until they select a Nextcloud channel.
 *
 * Run: cd server && node --test --test-force-exit automation/approvalNotify.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const rec = { bells: [], cards: [] };
mock(path.join(SERVER, 'stores/notificationStore'), {
    createNotification: async (n) => { rec.bells.push(n); return { id: `n${rec.bells.length}` }; },
});
mock(path.join(SERVER, 'automation/approvalDelivery'), {
    deliverApprovalToNextcloud: async (args) => { rec.cards.push(args); return { talk: { ok: true }, notifications: [] }; },
});
mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async (id) => (id === 'a1' ? { id: 'a1', title: 'Invoices' } : null),
});

const { notifyApproval, automationForApproval } = require('./approvalNotify');

const APPROVAL = { id: 'apr_1', ownerId: 'owner', automationId: 'a1', prompt: 'Pay it?' };
function automation(channels) {
    return { id: 'a1', title: 'Invoices', userId: 'owner',
        definition: { notificationSettings: { onApproval: { enabled: true, level: 'heads_up', channels } } } };
}
function reset() { rec.bells = []; rec.cards = []; }

test('the bell rings once per recipient, verbatim', async () => {
    reset();
    const res = await notifyApproval({
        approval: APPROVAL, automation: automation(['inapp']),
        recipientIds: ['lead', 'fin'],
        title: '⏳ Still waiting on you: Invoices',
        message: 'Pay it?\nNobody has decided yet.',
        category: 'heads_up',
    });
    assert.equal(res.bells, 2);
    assert.deepEqual(rec.bells.map(b => b.userId), ['lead', 'fin']);
    assert.equal(rec.bells[0].title, '⏳ Still waiting on you: Invoices');
    assert.equal(rec.bells[0].category, 'heads_up');
    assert.equal(rec.bells[0].link, '/app/studio/approvals/apr_1');
});

test('a duplicated recipient is belled once', async () => {
    reset();
    await notifyApproval({
        approval: APPROVAL, recipientIds: ['lead', 'lead', null, 'fin'], title: 'x',
    });
    assert.deepEqual(rec.bells.map(b => b.userId), ['lead', 'fin']);
});

test('with no Nextcloud channel selected, nothing changes', async () => {
    reset();
    const res = await notifyApproval({
        approval: APPROVAL, automation: automation(['inapp', 'email']),
        recipientIds: ['lead'], title: 'x',
    });
    assert.equal(res.card, null);
    assert.equal(rec.cards.length, 0, 'the policy is the gate — never a side effect of calling this');
});

test('the card is posted ONCE no matter how many people are belled', async () => {
    reset();
    await notifyApproval({
        approval: APPROVAL, automation: automation(['inapp', 'nc_talk']),
        recipientIds: ['lead', 'fin', 'cfo'], title: 'x',
    });
    assert.equal(rec.bells.length, 3);
    assert.equal(rec.cards.length, 1, 'one conversation, one card');
    assert.deepEqual(rec.cards[0].recipientIds, ['lead', 'fin', 'cfo'],
        'the bell channel still needs every recipient for the Nextcloud bell');
    assert.deepEqual(rec.cards[0].channels, ['nc_talk'], 'the card only; every recipient already heard through the Bee Flow bell');
});

test('the handoff 5 shape: Talk in the channels posts the card', async () => {
    reset();
    const a = { id: 'a1', title: 'Invoices', userId: 'owner',
        definition: { notificationSettings: { onApproval: { enabled: true, channels: ['bell', 'talk'], recipients: [{ type: 'approver' }], urgency: 'normal' } } } };
    await notifyApproval({ approval: APPROVAL, automation: a, recipientIds: ['lead'], title: 'x' });
    assert.equal(rec.bells.length, 1);
    assert.equal(rec.cards.length, 1);
});

test('an announcement with nothing to react to opts out of the card', async () => {
    reset();
    // A withdrawal or an outcome notice is not a request for a decision, so
    // posting a reactable card for it would invite a 👍 on a closed row.
    await notifyApproval({
        approval: APPROVAL, automation: automation(['nc_talk']),
        recipientIds: ['lead'], title: '↩️ Approval withdrawn', card: false,
    });
    assert.equal(rec.bells.length, 1);
    assert.equal(rec.cards.length, 0);
});

test('a disabled approval policy sends no card (the bell is the caller’s own call)', async () => {
    reset();
    const off = automation(['nc_talk']);
    off.definition.notificationSettings.onApproval.enabled = false;
    await notifyApproval({ approval: APPROVAL, automation: off, recipientIds: ['lead'], title: 'x' });
    assert.equal(rec.cards.length, 0);
    assert.equal(rec.bells.length, 1, 'expiry and escalation bells are never optional');
});

test('an app-sourced approval with no routine behind it stays bell-only', async () => {
    reset();
    await notifyApproval({ approval: { id: 'apr_2', ownerId: 'owner' }, recipientIds: ['lead'], title: 'x' });
    assert.equal(rec.bells.length, 1);
    assert.equal(rec.cards.length, 0);
});

test('a failing bell never stops the rest, and never throws', async () => {
    reset();
    const store = require('../stores/notificationStore');
    const real = store.createNotification;
    let n = 0;
    store.createNotification = async (bell) => {
        n += 1;
        if (n === 1) throw new Error('bell down');
        rec.bells.push(bell);
    };
    const res = await notifyApproval({ approval: APPROVAL, recipientIds: ['lead', 'fin'], title: 'x' });
    assert.equal(res.bells, 1);
    assert.deepEqual(rec.bells.map(b => b.userId), ['fin']);
    store.createNotification = real;
});

test('a failing card never stops the bells, and never throws', async () => {
    reset();
    const delivery = require('./approvalDelivery');
    const real = delivery.deliverApprovalToNextcloud;
    delivery.deliverApprovalToNextcloud = async () => { throw new Error('Nextcloud down'); };
    const res = await notifyApproval({
        approval: APPROVAL, automation: automation(['nc_talk']), recipientIds: ['lead'], title: 'x',
    });
    assert.equal(res.bells, 1);
    assert.equal(res.card, null);
    delivery.deliverApprovalToNextcloud = real;
});

test('nothing at all happens without an approval or a title', async () => {
    reset();
    assert.deepEqual(await notifyApproval({ recipientIds: ['lead'], title: 'x' }), { bells: 0, card: null });
    assert.deepEqual(await notifyApproval({ approval: APPROVAL, recipientIds: ['lead'] }), { bells: 0, card: null });
    assert.equal(rec.bells.length, 0);
});

test('the sweep paths can recover the routine from the approval row', async () => {
    assert.equal((await automationForApproval(APPROVAL)).title, 'Invoices');
    assert.equal(await automationForApproval({ id: 'apr_3' }), null);
    assert.equal(await automationForApproval(null), null);
});
