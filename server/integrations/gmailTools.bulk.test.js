'use strict';

/**
 * gmail_read_many and gmail_bulk_modify: many emails per request, with the
 * same answers one email at a time would give. Fakes only, no network, no DB.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    shapeReadMessage, messageIdList, readManyMessages, bulkModifyMessages, resolveLabelIds,
} = require('./gmailTools');

const b64 = (text) => Buffer.from(text, 'utf-8').toString('base64url');

/** A `format: 'full'` message with a text body and one PDF attachment. */
function fullMessage(id, { body = `Body of ${id}` } = {}) {
    return {
        id,
        threadId: `t-${id}`,
        payload: {
            headers: [
                { name: 'From', value: 'billing@example.com' },
                { name: 'To', value: 'me@example.com' },
                { name: 'Subject', value: `Invoice ${id}` },
                { name: 'Date', value: 'Mon, 05 Oct 2026 08:00:00 +0200' },
            ],
            mimeType: 'multipart/mixed',
            parts: [
                { mimeType: 'text/plain', body: { data: b64(body) } },
                { filename: `${id}.pdf`, mimeType: 'application/pdf', body: { size: 1200, attachmentId: `att-${id}` } },
            ],
        },
    };
}

/** A googleBatch stand-in: answers from a table, records what it was asked. */
function fakeBatch(table) {
    const calls = [];
    const batch = async (session, requests) => {
        calls.push({ session, requests });
        return new Map(requests.map(r => [r.id, table[r.id] || { status: 200, headers: {}, body: fullMessage(r.id) }]));
    };
    return { batch, calls };
}

test('message ids from whatever a step binds: ids, search results, JSON text or a list in text', () => {
    assert.deepEqual(messageIdList(['a', 'b', 'a']), ['a', 'b']);
    assert.deepEqual(messageIdList([{ id: 'x', subject: 's' }, { messageId: 'y' }]), ['x', 'y']);
    assert.deepEqual(messageIdList('["p","q"]'), ['p', 'q']);
    assert.deepEqual(messageIdList('m1, m2\nm3'), ['m1', 'm2', 'm3']);
    assert.deepEqual(messageIdList(null), []);
    assert.deepEqual(messageIdList('single'), ['single']);
    // A forEach's results carry their ids under `output`: a mis-bound list is
    // an error, never a green "nothing to change".
    assert.throws(() => messageIdList([{ index: 0, output: { id: 'm1' }, status: 'success' }]), /1 of the 1 entries has no id/);
    assert.throws(() => messageIdList([{ id: 'a' }, { subject: 'no id' }]), /1 of the 2 entries has no id/);
});

test('gmail_read_many: one batch for many ids, every message shaped exactly like gmail_read', async () => {
    const { batch, calls } = fakeBatch({});
    const session = { accessToken: 't' };
    const out = await readManyMessages(session, { messageIds: ['m1', 'm2', 'm3'] }, { batch });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].session, session);
    assert.deepEqual(calls[0].requests.map(r => r.path), [
        '/gmail/v1/users/me/messages/m1?format=full',
        '/gmail/v1/users/me/messages/m2?format=full',
        '/gmail/v1/users/me/messages/m3?format=full',
    ]);
    assert.equal(out.count, 3);
    assert.deepEqual(out.messages.map(m => m.id), ['m1', 'm2', 'm3']);
    assert.deepEqual(out.messages[1], shapeReadMessage(fullMessage('m2')));
    // The attachments are ready for a "for each attachment" Read attachment step.
    assert.deepEqual(out.messages[0].attachments[0], {
        filename: 'm1.pdf', mimeType: 'application/pdf', size: 1200, attachmentId: 'att-m1', canOCR: true, messageId: 'm1', threadId: 't-m1',
    });
    assert.deepEqual(out.notFound, []);
    assert.deepEqual(out.failed, []);
    assert.equal(out.error, undefined);
});

test('gmail_read_many: unknown ids are notFound, failures say why, odd ids never reach Gmail', async () => {
    const { batch, calls } = fakeBatch({
        gone: { status: 404, headers: {}, body: { error: { message: 'Requested entity was not found.' } } },
        slow: { status: 429, headers: {}, body: { error: { message: 'Too many concurrent requests for user' } } },
    });
    const out = await readManyMessages({ accessToken: 't' }, { messageIds: ['ok', 'gone', 'slow', 'a/b'] }, { batch });
    assert.deepEqual(calls[0].requests.map(r => r.id), ['ok', 'gone', 'slow']);
    assert.deepEqual(out.messages.map(m => m.id), ['ok']);
    assert.deepEqual(out.notFound, ['gone']);
    assert.deepEqual(out.failed, [
        { id: 'a/b', error: 'not a Gmail message id' },
        { id: 'slow', error: 'Too many concurrent requests for user' },
    ]);
    assert.equal(out.error, undefined, 'some were read: no error');
});

test('gmail_read_many: nothing readable is an error; more than 100 reads the first 100 and says so', async () => {
    const failing = fakeBatch({ x: { status: 500, headers: {}, body: { error: { message: 'Backend Error' } } } });
    const none = await readManyMessages({ accessToken: 't' }, { messageIds: ['x'] }, { batch: failing.batch });
    assert.match(none.error, /Could not read any of the 1 messages: Backend Error/);

    const many = fakeBatch({});
    const ids = Array.from({ length: 130 }, (_, i) => `m${i}`);
    const out = await readManyMessages({ accessToken: 't' }, { messageIds: ids }, { batch: many.batch });
    assert.equal(many.calls[0].requests.length, 100);
    assert.equal(out.count, 100);
    assert.equal(out.truncated, true);
    assert.equal(out.totalRequested, 130);

    const empty = await readManyMessages({ accessToken: 't' }, { messageIds: [] }, { batch: many.batch });
    assert.deepEqual(empty, { messages: [], count: 0, notFound: [], failed: [] });
    assert.equal(many.calls.length, 1, 'no ids, no request');
});

test('gmail_read_many cuts a body at 20,000 characters (gmail_read keeps 50,000)', () => {
    const long = fullMessage('big', { body: 'x'.repeat(30_000) });
    assert.match(shapeReadMessage(long, 20_000).body, /^x{20000}\n\n\[\.\.\. truncated/);
    assert.equal(shapeReadMessage(long).body.length, 30_000);
});

/** A Gmail client stand-in for the label and batchModify calls. */
function fakeGmail(labels = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'Label_7', name: 'Invoices', type: 'user' },
]) {
    const calls = { list: 0, batchModify: [] };
    const gmail = {
        users: {
            labels: { list: async () => { calls.list++; return { data: { labels: [...labels] } }; } },
            messages: { batchModify: async (params) => { calls.batchModify.push(params); return { status: 204, data: '' }; } },
        },
    };
    return { gmail, calls, labels };
}

test('gmail_bulk_modify: one batchModify for every message, label names resolved, flags folded in', async () => {
    const { gmail, calls } = fakeGmail();
    const out = await bulkModifyMessages(gmail, { messageIds: ['m1', 'm2', 'm3'], addLabelIds: ['Invoices'], markRead: 'true', archive: true }, {});
    assert.equal(calls.batchModify.length, 1);
    assert.deepEqual(calls.batchModify[0], {
        userId: 'me',
        requestBody: { ids: ['m1', 'm2', 'm3'], addLabelIds: ['Label_7'], removeLabelIds: ['UNREAD', 'INBOX'] },
    });
    assert.deepEqual(out, { modified: 3, messageIds: ['m1', 'm2', 'm3'], addLabelIds: ['Label_7'], removeLabelIds: ['UNREAD', 'INBOX'] });
});

test('gmail_bulk_modify: refuses what it cannot do in one honest request', async () => {
    const { gmail, calls } = fakeGmail();
    await assert.rejects(bulkModifyMessages(gmail, { messageIds: ['a'] }), /Nothing to change/);
    await assert.rejects(bulkModifyMessages(gmail, { messageIds: ['a'], markRead: true, markUnread: true }), /not both/);
    await assert.rejects(bulkModifyMessages(gmail, { messageIds: ['a'], addLabelIds: ['INBOX'], archive: true }), /added and removed at once: INBOX/);
    await assert.rejects(bulkModifyMessages(gmail, { messageIds: ['a b'], archive: true }), /Not Gmail message ids/);
    const tooMany = Array.from({ length: 1001 }, (_, i) => `m${i}`);
    await assert.rejects(bulkModifyMessages(gmail, { messageIds: tooMany, archive: true }), /at most 1000/);
    assert.equal(calls.batchModify.length, 0);
    // An empty search is not an error: nothing to change, no request.
    const none = await bulkModifyMessages(gmail, { messageIds: [], markUnread: true });
    assert.deepEqual(none, { modified: 0, messageIds: [], addLabelIds: ['UNREAD'], removeLabelIds: [], message: 'No messages to change.' });
    assert.equal(calls.batchModify.length, 0);
});

test('label names resolve once a minute per session, and again when a name is new', async () => {
    const { gmail, calls, labels } = fakeGmail();
    const session = {};
    assert.deepEqual(await resolveLabelIds(gmail, ['Invoices'], session), ['Label_7']);
    assert.deepEqual(await resolveLabelIds(gmail, ['Invoices', 'INBOX'], session), ['Label_7', 'INBOX']);
    assert.equal(calls.list, 1, 'the second lookup used the cached list');
    // A label made since: the cached list does not know it, so ask Gmail once more.
    labels.push({ id: 'Label_9', name: 'Paid', type: 'user' });
    assert.deepEqual(await resolveLabelIds(gmail, ['Paid'], session), ['Label_9']);
    assert.equal(calls.list, 2);
    // Without a session there is no cache: every call asks (the old behaviour).
    await resolveLabelIds(gmail, ['Invoices']);
    await resolveLabelIds(gmail, ['Invoices']);
    assert.equal(calls.list, 4);
    // A different session has its own cache.
    await resolveLabelIds(gmail, ['Invoices'], {});
    assert.equal(calls.list, 5);
});
