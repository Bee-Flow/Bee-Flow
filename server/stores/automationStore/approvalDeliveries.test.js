'use strict';

/**
 * The delivery ledger's two load-bearing queries.
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
 * The SQL is asserted rather than executed — this suite runs with no database,
 * and what matters here is the shape of the WHERE, not Postgres's behaviour.
 *
 * Run: cd server && node --test --test-force-exit stores/automationStore/approvalDeliveries.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const queries = [];
// getOne answers from a queue so a test can stage "the INSERT conflicted, the
// follow-up SELECT won" — the store destructures core at load time, so the
// double has to be the stateful thing, not a reassignable property.
let oneResults = [];
let allResult = [];
mock(path.join(__dirname, 'core'), {
    getOne: async (sql, params) => {
        queries.push({ sql, params });
        return oneResults.length > 1 ? oneResults.shift() : (oneResults[0] ?? null);
    },
    getAll: async (sql, params) => { queries.push({ sql, params }); return allResult; },
    run: async () => {},
});

const store = require('./approvalDeliveries');

function row(over = {}) {
    return {
        id: 'dlv_1', approval_id: 'apr_1', stage: 's2', channel: 'nc_talk',
        organization_id: 'org1',
        external_ref: { roomToken: 'room1', messageId: '1567', via: 'bot' },
        user_id: 'owner', nc_uid: null, status: 'sent', error: null,
        created_at: '2026-08-23T10:00:00Z', ...over,
    };
}

test('the routing lookup keys on BOTH the room and the message', async () => {
    queries.length = 0;
    oneResults = [row()];
    const d = await store.getApprovalDeliveryForTalkMessage('room1', 1567);
    assert.equal(d.approvalId, 'apr_1');
    assert.equal(d.externalRef.roomToken, 'room1');
    assert.equal(d.stage, 's2');

    const { sql, params } = queries[0];
    assert.match(sql, /channel = 'nc_talk'/);
    assert.match(sql, /external_ref->>'roomToken' = \$1/);
    assert.match(sql, /external_ref->>'messageId' = \$2/);
    // Both halves are compared as text, so a numeric message id from the
    // webhook and a string one in the ledger still match.
    assert.deepEqual(params, ['room1', '1567']);
});

test('an incomplete key resolves to nothing without touching the database', async () => {
    queries.length = 0;
    assert.equal(await store.getApprovalDeliveryForTalkMessage(null, '1'), null);
    assert.equal(await store.getApprovalDeliveryForTalkMessage('room1', null), null);
    assert.equal(await store.getApprovalDeliveryForTalkMessage('room1', ''), null);
    assert.equal(queries.length, 0);
});

test('a delivery is recorded with its external ref as JSON', async () => {
    queries.length = 0;
    oneResults = [row()];
    const d = await store.recordApprovalDelivery({
        approvalId: 'apr_1', stage: 's2', channel: 'nc_talk', organizationId: 'org1',
        externalRef: { roomToken: 'room1', messageId: '1567' }, userId: 'owner',
    });
    assert.equal(d.id, 'dlv_1');
    const { sql, params } = queries[0];
    assert.match(sql, /INSERT INTO automation_approval_deliveries/);
    assert.match(sql, /ON CONFLICT DO NOTHING/);
    assert.match(params[0], /^dlv_[0-9a-f]{24}$/);
    assert.deepEqual(JSON.parse(params[5]), { roomToken: 'room1', messageId: '1567' });
    assert.equal(params[8], 'sent');
});

test('a FAILED attempt is recorded too — it is the only trace the card was meant to exist', async () => {
    queries.length = 0;
    oneResults = [row({ status: 'failed', error: 'bot not in conversation' })];
    const d = await store.recordApprovalDelivery({
        approvalId: 'apr_1', channel: 'nc_talk', externalRef: { roomToken: 'r' },
        status: 'failed', error: 'bot not in conversation',
    });
    assert.equal(d.status, 'failed');
    assert.equal(d.error, 'bot not in conversation');
    assert.equal(queries[0].params[8], 'failed');
});

test('losing the unique-index race returns the row that won, never an error', async () => {
    queries.length = 0;
    oneResults = [null, row()];                    // INSERT conflicts, SELECT wins
    const d = await store.recordApprovalDelivery({
        approvalId: 'apr_1', channel: 'nc_talk',
        externalRef: { roomToken: 'room1', messageId: '1567' },
    });
    assert.equal(d.id, 'dlv_1', 're-delivery must never be able to fail an approval');
    assert.equal(queries.length, 2);
    assert.match(queries[1].sql, /SELECT \* FROM automation_approval_deliveries/);
});

test('a delivery with no approval or channel is refused before any SQL', async () => {
    queries.length = 0;
    assert.equal(await store.recordApprovalDelivery({ channel: 'nc_talk' }), null);
    assert.equal(await store.recordApprovalDelivery({ approvalId: 'apr_1' }), null);
    assert.equal(queries.length, 0);
});

test('the poll working set is bounded by "still pending" and "id known"', async () => {
    queries.length = 0;
    allResult = [row(), row({ id: 'dlv_2' })];
    const rows = await store.getPendingTalkDeliveries();
    assert.equal(rows.length, 2);
    const { sql, params } = queries[0];
    assert.match(sql, /JOIN automation_approvals a ON a\.id = d\.approval_id/);
    assert.match(sql, /a\.status = 'pending'/);
    assert.match(sql, /d\.status = 'sent'/);
    assert.match(sql, /external_ref->>'messageId' IS NOT NULL/);
    assert.equal(params[0], 200);
});

test('the poll limit is clamped — a caller cannot ask for the whole table', async () => {
    queries.length = 0;
    allResult = [];
    await store.getPendingTalkDeliveries(100000);
    assert.equal(queries[0].params[0], 1000);
    await store.getPendingTalkDeliveries(0);
    assert.equal(queries[1].params[0], 200);      // 0 is falsy → the default
    await store.getPendingTalkDeliveries(-5);
    assert.equal(queries[2].params[0], 1);
});

test('rows map to camelCase with the external ref parsed', () => {
    const d = store.rowToDelivery(row({ nc_uid: 'ada', channel: 'nc_notification' }));
    assert.equal(d.approvalId, 'apr_1');
    assert.equal(d.organizationId, 'org1');
    assert.equal(d.ncUid, 'ada');
    assert.equal(d.channel, 'nc_notification');
    assert.deepEqual(d.externalRef, { roomToken: 'room1', messageId: '1567', via: 'bot' });
    assert.equal(store.rowToDelivery(null), null);
});
