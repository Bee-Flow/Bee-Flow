'use strict';

/**
 * The delivery ledger's two load-bearing queries, on a real Postgres (the boot
 * ladder's schema on PGlite, testUtils/pgliteTemplate.js ladderPglite, behind
 * db.js's pool).
 *
 * getApprovalDeliveryForTalkMessage is the ROUTING lookup: it is what decides
 * whether an inbound 👍 belongs to an approval at all. It must key on the exact
 * pair the reaction webhook carries and never widen to "the newest card in that
 * room" — a reaction on an unrelated message resolving to the nearest approval
 * would be an approval bypass with extra steps.
 *
 * recordApprovalDelivery must survive the unique index rather than throw: a
 * re-delivery losing that race is a duplicate, not a failure, and an exception
 * there would propagate into the approval pause.
 *
 * Run: cd server && node --test stores/automationStore/approvalDeliveries.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');

const { pg, close } = usePglitePool(ladderPglite());
const store = require('./approvalDeliveries');

before(() => pg.exec(`
    INSERT INTO automation_approvals (id, step_id, owner_id, status) VALUES
        ('apr_1', 's2', 'owner', 'pending'),
        ('apr_2', 's1', 'owner', 'pending'),
        ('apr_done', 's1', 'owner', 'approved');
`));
after(close);
beforeEach(() => pg.exec('DELETE FROM automation_approval_deliveries'));

const deliveryCount = async () => (await pg.query('SELECT COUNT(*)::int AS n FROM automation_approval_deliveries')).rows[0].n;

/** @param {string} approvalId @param {string} roomToken @param {string | number} messageId @param {Record<string, unknown>} [over] */
const talk = (approvalId, roomToken, messageId, over = {}) => store.recordApprovalDelivery({
    approvalId, stage: 's2', channel: 'nc_talk', organizationId: 'org1',
    externalRef: { roomToken, messageId: messageId == null ? undefined : String(messageId), via: 'bot' }, userId: 'owner', ...over,
});

test('the routing lookup keys on BOTH the room and the message', async () => {
    await talk('apr_1', 'room1', 1567);
    await talk('apr_2', 'room1', 1600);       // newer card, same room
    await talk('apr_2', 'room2', 1567);       // same message id, other room
    const d = await store.getApprovalDeliveryForTalkMessage('room1', 1567);
    assert.equal(d.approvalId, 'apr_1');
    assert.equal(d.externalRef.roomToken, 'room1');
    assert.equal(d.stage, 's2');
    // Both halves are compared as text, so a numeric message id from the
    // webhook and a string one in the ledger still match.
    assert.equal((await store.getApprovalDeliveryForTalkMessage('room1', '1567')).approvalId, 'apr_1');
    assert.equal(await store.getApprovalDeliveryForTalkMessage('room1', 9999), null, 'an unrelated message in that room resolves to nothing');
    assert.equal(await store.getApprovalDeliveryForTalkMessage('room3', 1567), null);
});

test('the routing lookup is Talk only', async () => {
    await store.recordApprovalDelivery({ approvalId: 'apr_1', channel: 'nc_notification', externalRef: { roomToken: 'room1', messageId: '1567' } });
    assert.equal(await store.getApprovalDeliveryForTalkMessage('room1', 1567), null);
});

test('an incomplete key resolves to nothing', async () => {
    await talk('apr_1', 'room1', 1);
    assert.equal(await store.getApprovalDeliveryForTalkMessage(null, '1'), null);
    assert.equal(await store.getApprovalDeliveryForTalkMessage('room1', null), null);
    assert.equal(await store.getApprovalDeliveryForTalkMessage('room1', ''), null);
});

test('a delivery is recorded with its external ref as JSON', async () => {
    const d = await talk('apr_1', 'room1', 1567);
    assert.match(d.id, /^dlv_[0-9a-f]{24}$/);
    const [row] = (await pg.query('SELECT * FROM automation_approval_deliveries')).rows;
    assert.equal(row.id, d.id);
    assert.deepEqual(row.external_ref, { roomToken: 'room1', messageId: '1567', via: 'bot' });
    assert.equal(row.status, 'sent');
    assert.equal(row.organization_id, 'org1');
    assert.equal(row.user_id, 'owner');
});

test('a FAILED attempt is recorded too — it is the only trace the card was meant to exist', async () => {
    const d = await store.recordApprovalDelivery({
        approvalId: 'apr_1', channel: 'nc_talk', externalRef: { roomToken: 'r' },
        status: 'failed', error: 'bot not in conversation',
    });
    assert.equal(d.status, 'failed');
    assert.equal(d.error, 'bot not in conversation');
    assert.equal(await deliveryCount(), 1);
});

test('losing the unique-index race returns the row that won, never an error', async () => {
    const first = await talk('apr_1', 'room1', 1567);
    const again = await talk('apr_1', 'room1', 1567);
    assert.equal(again.id, first.id, 're-delivery must never be able to fail an approval');
    assert.equal(await deliveryCount(), 1);
});

test('a delivery with no approval or channel is refused', async () => {
    assert.equal(await store.recordApprovalDelivery(/** @type {any} */ ({ channel: 'nc_talk' })), null);
    assert.equal(await store.recordApprovalDelivery(/** @type {any} */ ({ approvalId: 'apr_1' })), null);
    assert.equal(await deliveryCount(), 0);
});

test('the poll working set is bounded by "still pending" and "id known"', async () => {
    await talk('apr_1', 'room1', 1);
    await talk('apr_2', 'room1', 2);
    await talk('apr_done', 'room1', 3);                                     // decided
    await talk('apr_1', 'room1', null);                                     // no message id
    await talk('apr_1', 'room1', 4, { status: 'failed' });                  // never landed
    await store.recordApprovalDelivery({ approvalId: 'apr_1', channel: 'nc_notification', externalRef: { messageId: '5' } });
    const rows = await store.getPendingTalkDeliveries();
    assert.deepEqual(rows.map(r => r.externalRef.messageId).sort(), ['1', '2']);
});

test('the poll limit is clamped — a caller cannot ask for the whole table', async () => {
    for (let i = 0; i < 3; i++) await talk('apr_1', 'room1', i + 1);
    assert.equal((await store.getPendingTalkDeliveries(100000)).length, 3);
    assert.equal((await store.getPendingTalkDeliveries(0)).length, 3, '0 is falsy → the default');
    assert.equal((await store.getPendingTalkDeliveries(-5)).length, 1);
    assert.equal((await store.getPendingTalkDeliveries(2)).length, 2);
});

test('getApprovalDeliveries lists one approval\'s deliveries, oldest first', async () => {
    const a = await talk('apr_1', 'room1', 1);
    await talk('apr_2', 'room1', 2);
    const b = await store.recordApprovalDelivery({ approvalId: 'apr_1', channel: 'nc_notification', externalRef: { ncUid: 'ada' } });
    assert.deepEqual((await store.getApprovalDeliveries('apr_1')).map(d => d.id), [a.id, b.id]);
    assert.deepEqual(await store.getApprovalDeliveries(''), []);
});

test('rows map to camelCase with the external ref parsed', () => {
    const row = {
        id: 'dlv_1', approval_id: 'apr_1', stage: 's2', channel: 'nc_notification', organization_id: 'org1',
        external_ref: { roomToken: 'room1', messageId: '1567', via: 'bot' },
        user_id: 'owner', nc_uid: 'ada', status: 'sent', error: null, created_at: '2026-08-23T10:00:00Z',
    };
    const d = store.rowToDelivery(/** @type {any} */ (row));
    assert.equal(d.approvalId, 'apr_1');
    assert.equal(d.organizationId, 'org1');
    assert.equal(d.ncUid, 'ada');
    assert.equal(d.channel, 'nc_notification');
    assert.deepEqual(d.externalRef, { roomToken: 'room1', messageId: '1567', via: 'bot' });
    assert.equal(store.rowToDelivery(null), null);
});
