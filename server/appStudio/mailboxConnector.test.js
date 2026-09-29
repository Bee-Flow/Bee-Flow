/**
 * The `mailbox` connector kind.
 *
 * Run: cd server && node --test appStudio/mailboxConnector.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let listCalls = [];
let attachmentCalls = [];
let listResult = { messages: [], nextPageToken: null };
let listError = null;
let attachmentError = null;
let threadCalls = [];
let threadResult = [];
let threadError = null;
let identityResult = null;
let identityError = null;
let attachmentMetaByMessage = null; // override per test; null = the default fixture

stub('../services/email/fetch', {
    listMessages: async (p) => {
        listCalls.push(p);
        if (listError) throw listError;
        return listResult;
    },
    listAttachmentMeta: async (p) => {
        attachmentCalls.push(p);
        if (attachmentError) throw attachmentError;
        if (attachmentMetaByMessage) return attachmentMetaByMessage(p.messageId);
        return [
            { provider_attachment_id: `att-${p.messageId}`, filename: 'bon.pdf', mime_type: 'application/pdf', size: 10, is_inline: false },
        ];
    },
    listThreadMessages: async (p) => {
        threadCalls.push(p);
        if (threadError) throw threadError;
        return threadResult;
    },
    computeThreadKey: () => 'gmail:th-1',
    resolveMailboxAddress: async () => 'ik@acme.nl',
});

stub('./mailboxIdentity', {
    resolveMailboxIdentity: async () => {
        if (identityError) throw identityError;
        return identityResult;
    },
    sharedModeFor: (provider) => (provider === 'outlook' ? 'delegated_mailbox' : 'delivered_alias'),
});

const mailboxConnector = require('./mailboxConnector');

const APP = { id: 'app_1', userId: 'u1', organizationId: 'orgA' };

function connector(extra = {}) {
    return {
        id: 'conn_ab12',
        kind: 'mailbox',
        provider: 'gmail',
        mode: 'personal',
        folder: 'inbox',
        lookbackDays: 7,
        maxPerRun: 100,
        sync: { tableId: 'tbl_1', mode: 'upsert', keyField: 'provider_message_id', retentionDays: 90 },
        ...extra,
    };
}

function message(id, extra = {}) {
    return {
        provider_message_id: id,
        provider_thread_id: `th-${id}`,
        thread_key: `gmail:th-${id}`,
        received_at: '2026-08-05T10:00:00Z',
        has_attachments: false,
        ...extra,
    };
}

test.beforeEach(() => {
    listCalls = [];
    attachmentCalls = [];
    listResult = { messages: [], nextPageToken: null };
    listError = null;
    attachmentError = null;
    attachmentMetaByMessage = null;
    threadCalls = [];
    threadResult = [];
    threadError = null;
    identityError = null;
    identityResult = {
        userId: 'u1',
        provider: 'gmail',
        integrationId: 'gmail',
        tokens: { accessToken: 'at' },
        onRefresh: async () => {},
        mailbox: { address: 'ik@acme.nl', mode: 'personal', sharedMode: 'delivered_alias' },
    };
});

// ── Shape ────────────────────────────────────────────────────────────────────

test('emits messages as grain 0 and attachment metadata as grain 1', async () => {
    listResult = { messages: [message('a'), message('b', { has_attachments: true })] };

    const res = await mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' });

    assert.strictEqual(res.grains.length, 2);
    assert.strictEqual(res.grains[0].level, 0);
    assert.strictEqual(res.grains[0].rows.length, 2);
    assert.strictEqual(res.rows.length, 2, 'flat rows mirror grain 0');

    assert.strictEqual(res.grains[1].level, 1);
    assert.strictEqual(res.grains[1].rows.length, 1, 'only the message with attachments was probed');
    // _parentIndex is how the sync engine relates the child row to the message
    // it just wrote — without it the attachment has no owner.
    assert.strictEqual(res.grains[1].rows[0]._parentIndex, 1);
    assert.strictEqual(attachmentCalls.length, 1);
});

test('attachment probing can be switched off', async () => {
    listResult = { messages: [message('a', { has_attachments: true })] };
    const res = await mailboxConnector.runMailboxConnector(
        connector({ includeAttachmentMeta: false }), { app: APP, viewerId: 'u1' },
    );
    assert.strictEqual(res.grains[1].rows.length, 0);
    assert.strictEqual(attachmentCalls.length, 0);
});

test('one unreadable attachment list does not lose the batch', async () => {
    // The message row is the valuable part; losing 50 messages because one
    // attachment listing 404'd would be a bad trade.
    listResult = { messages: [message('a', { has_attachments: true })] };
    attachmentError = new Error('boom');

    const res = await mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' });
    assert.strictEqual(res.rows.length, 1);
    assert.strictEqual(res.grains[1].rows.length, 0);
});

// ── Windowing ────────────────────────────────────────────────────────────────

test('the first run falls back to lookbackDays instead of the whole history', async () => {
    await mailboxConnector.runMailboxConnector(connector({ lookbackDays: 3 }), { app: APP, viewerId: 'u1' });

    const since = Date.parse(listCalls[0].since);
    const expected = Date.now() - 3 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(since - expected) < 5000, 'since is roughly lookbackDays ago');
});

test('a stored watermark wins over the lookback window', async () => {
    await mailboxConnector.runMailboxConnector(connector(), {
        app: APP, viewerId: 'u1', systemArgs: { since: '2026-08-04T00:00:00.000Z' },
    });
    assert.strictEqual(listCalls[0].since, '2026-08-04T00:00:00.000Z');
});

test('maxPerRun is honoured and hard-capped', async () => {
    listResult = { messages: Array.from({ length: 50 }, (_, i) => message(`m${i}`)) };

    const res = await mailboxConnector.runMailboxConnector(connector({ maxPerRun: 10 }), { app: APP, viewerId: 'u1' });
    assert.strictEqual(listCalls[0].max, 10);
    assert.strictEqual(res.rows.length, 10, 'the runner also slices, not just the provider');

    listCalls = [];
    await mailboxConnector.runMailboxConnector(connector({ maxPerRun: 100000 }), { app: APP, viewerId: 'u1' });
    assert.strictEqual(listCalls[0].max, mailboxConnector.MAX_MAILBOX_ROWS);
});

test('the connector config drives the provider query and folder', async () => {
    await mailboxConnector.runMailboxConnector(
        connector({ folder: 'archive', query: 'from:klant.nl', includeBody: false }),
        { app: APP, viewerId: 'u1' },
    );
    assert.strictEqual(listCalls[0].folder, 'archive');
    assert.strictEqual(listCalls[0].query, 'from:klant.nl');
    assert.strictEqual(listCalls[0].includeBody, false);
});

// ── Errors ───────────────────────────────────────────────────────────────────

test('a 403 on a SHARED mailbox names the real problem, not "connect your account"', async () => {
    // The account IS connected; it just cannot reach that mailbox. Telling the
    // user to reconnect sends them round a loop that never fixes it.
    const err = new Error('Graph API 403: denied');
    err.status = 403;
    listError = err;

    await assert.rejects(
        () => mailboxConnector.runMailboxConnector(
            connector({ provider: 'outlook', mode: 'shared', address: 'support@acme.nl' }),
            { app: APP, viewerId: 'u1' },
        ),
        (e) => {
            assert.strictEqual(e.status, 403);
            assert.strictEqual(e.code, 'shared_mailbox_denied');
            assert.match(e.message, /support@acme\.nl/);
            assert.match(e.message, /Mail\.Read\.Shared/);
            return true;
        },
    );
});

test('throttling surfaces as 429 and carries Retry-After through', async () => {
    const err = new Error('Graph API 429');
    err.status = 429;
    err.retryAfterMs = 30_000;
    listError = err;

    await assert.rejects(
        () => mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' }),
        (e) => {
            assert.strictEqual(e.status, 429);
            assert.strictEqual(e.code, 'mailbox_throttled');
            assert.strictEqual(e.retryAfterMs, 30_000, 'the back-off needs this');
            return true;
        },
    );
});

test('an expired grant asks for a reconnect, naming the provider', async () => {
    const err = new Error('No valid Google tokens — reconnect the mailbox.');
    listError = err;

    await assert.rejects(
        () => mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' }),
        (e) => {
            assert.strictEqual(e.status, 409);
            assert.strictEqual(e.code, 'connection_required');
            assert.strictEqual(e.provider, 'gmail');
            return true;
        },
    );
});

test('anything else is a 502, not a silent empty sync', async () => {
    listError = new Error('socket hang up');
    await assert.rejects(
        () => mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' }),
        (e) => {
            assert.strictEqual(e.status, 502);
            assert.strictEqual(e.code, 'connector_failed');
            return true;
        },
    );
});

test('an identity failure passes through untouched', async () => {
    // resolveMailboxIdentity already produced the actionable 409 with a
    // provider on it; re-classifying would flatten that.
    const err = new Error('Connect gmail in Settings');
    err.status = 409; err.code = 'connection_required'; err.provider = 'gmail';
    identityError = err;

    await assert.rejects(
        () => mailboxConnector.runMailboxConnector(connector({ runAs: 'viewer' }), { app: APP, viewerId: 'u2' }),
        (e) => e.code === 'connection_required' && e.provider === 'gmail',
    );
});

// ── Table templates ──────────────────────────────────────────────────────────

test('the shipped message table keys dedupe on a UNIQUE provider_message_id', () => {
    // This is the equivalent of the support inbox's unique index. Without
    // `unique: true` the upsert silently becomes an append and every sync tick
    // duplicates the whole window.
    const key = mailboxConnector.MAILBOX_TABLE_TEMPLATE.fields.find((f) => f.key === 'provider_message_id');
    assert.ok(key);
    assert.strictEqual(key.unique, true);
    assert.strictEqual(key.required, true);

    const keys = mailboxConnector.MAILBOX_TABLE_TEMPLATE.fields.map((f) => f.key);
    for (const required of ['thread_key', 'rfc822_message_id', 'references', 'in_reply_to', 'received_at', 'direction']) {
        assert.ok(keys.includes(required), `threading needs ${required}`);
    }
});

test('the attachment table is keyed too', () => {
    const key = mailboxConnector.MAILBOX_ATTACHMENT_TABLE_TEMPLATE.fields.find((f) => f.key === 'provider_attachment_id');
    assert.strictEqual(key.unique, true);
});

// ── groupIntoThreads ────────────────────────────────────────────────────────

test('groupIntoThreads rolls messages up into conversations, messages become grain 1', async () => {
    // This is what makes tickets appear by themselves. Without it a mailbox
    // fills a flat message log and nothing ever creates the ticket.
    listResult = {
        messages: [
            message('a', { thread_key: 'T1', subject: 'Order 1', direction: 'inbound', from_email: 'jan@x.nl', from_name: 'Jan', received_at: '2026-08-01T10:00:00Z', is_read: false }),
            message('b', { thread_key: 'T1', subject: 'Re: Order 1', direction: 'outbound', from_email: 'support@acme.nl', received_at: '2026-08-01T11:00:00Z', is_read: true }),
            message('c', { thread_key: 'T2', subject: 'Order 2', direction: 'inbound', from_email: 'ana@x.nl', received_at: '2026-08-02T09:00:00Z', is_read: true }),
        ],
    };

    const res = await mailboxConnector.runMailboxConnector(
        connector({ groupIntoThreads: true }), { app: APP, viewerId: 'u1' },
    );

    assert.strictEqual(res.grains[0].rows.length, 2, 'two conversations');
    assert.strictEqual(res.grains[1].rows.length, 3, 'all three messages');
    assert.strictEqual(res.rows.length, 2, 'flat rows mirror grain 0');

    const [t1, t2] = res.grains[0].rows;
    assert.strictEqual(t1.thread_key, 'T1');
    assert.strictEqual(t1.message_count, 2);
    assert.strictEqual(t1.requester_email, 'jan@x.nl', 'the customer is who wrote IN, never our own address');
    assert.strictEqual(t1.requester_name, 'Jan');
    assert.strictEqual(t1.last_message_at, '2026-08-01T11:00:00Z', 'the newest message wins');
    assert.strictEqual(t1.subject, 'Re: Order 1', 'subject follows the newest message');
    assert.strictEqual(t1.has_unread, true, 'one unread inbound is enough');
    assert.strictEqual(t2.has_unread, false);

    // The child link is POSITIONAL — connectorSync relates by _parentIndex.
    assert.deepStrictEqual(res.grains[1].rows.map((m) => m._parentIndex), [0, 0, 1]);
});

test('a conversation row carries ONLY the columns the mailbox owns', async () => {
    // Upsert writes exactly the columns present, so status/priority/assignee on
    // the same table survive every re-sync. Emitting them here would wipe the
    // team's triage on the next tick.
    listResult = { messages: [message('a', { thread_key: 'T1', direction: 'inbound' })] };
    const res = await mailboxConnector.runMailboxConnector(
        connector({ groupIntoThreads: true }), { app: APP, viewerId: 'u1' },
    );

    const keys = Object.keys(res.grains[0].rows[0]).sort();
    assert.deepStrictEqual(keys, [
        'has_unread', 'last_message_at', 'mailbox_address', 'message_count',
        'provider', 'requester_email', 'requester_name', 'subject', 'thread_key',
    ]);
    for (const owned of ['status', 'priority', 'assignee']) {
        assert.ok(!(owned in res.grains[0].rows[0]), `${owned} belongs to the team, not the mailbox`);
    }
});

test('groupIntoThreads is OFF by default — the flat log is unchanged', async () => {
    listResult = { messages: [message('a'), message('b')] };
    const res = await mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' });
    assert.strictEqual(res.grains[0].rows.length, 2, 'grain 0 is still the messages');
    assert.strictEqual(res.grains[0].rows[0].provider_message_id, 'a');
});

test('the rollup is deterministic and keeps first-seen thread order', () => {
    const grouped = mailboxConnector._groupIntoThreads([
        { thread_key: 'B', direction: 'inbound', received_at: '2026-08-01T00:00:00Z' },
        { thread_key: 'A', direction: 'inbound', received_at: '2026-08-02T00:00:00Z' },
        { thread_key: 'B', direction: 'inbound', received_at: '2026-08-03T00:00:00Z' },
    ]);
    assert.deepStrictEqual(grouped.threads.map((t) => t.thread_key), ['B', 'A']);
    assert.deepStrictEqual(grouped.messages.map((m) => m._parentIndex), [0, 1, 0]);
});

test('a message with no conversation key at all is dropped, not mis-grouped', () => {
    const grouped = mailboxConnector._groupIntoThreads([
        { direction: 'inbound' },
        { thread_key: 'A', direction: 'inbound' },
    ]);
    assert.strictEqual(grouped.threads.length, 1);
    assert.strictEqual(grouped.messages.length, 1);
});

test('the shipped conversation table keys on thread_key', () => {
    const key = mailboxConnector.MAILBOX_THREAD_TABLE_TEMPLATE.fields.find((f) => f.key === 'thread_key');
    assert.strictEqual(key.unique, true);
    assert.strictEqual(key.required, true);
});

// ── Attachments ─────────────────────────────────────────────────────────────

test('an attachment row carries a PENDING descriptor, never bytes', async () => {
    // The sync must stay cheap and store nothing a stranger mailed: the row
    // points at the provider, and the first reader redeems it.
    listResult = { messages: [message('a', { has_attachments: true })] };
    const res = await mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' });

    const [att] = res.grains[1].rows;
    assert.strictEqual(att.provider_message_id, 'a', 'redeeming needs the message id too');
    // An OBJECT, not JSON text. Serialising a file column is the query
    // compiler's job; pre-stringifying here got stringified AGAIN on write, so
    // the stored value was a JSON string containing a JSON string — one parse
    // gave back a string, `.kind` was undefined, and preview, materialize and
    // the AI read all reported "no file" on a row that had one.
    assert.strictEqual(typeof att.file, 'object', 'the descriptor is handed over unserialised');
    assert.deepStrictEqual(att.file, {
        kind: 'mailbox_attachment',
        connectorId: 'conn_ab12',
        messageId: 'a',
        attachmentId: 'att-a',
        name: 'bon.pdf',
        mime: 'application/pdf',
        size: 10,
        isInline: false,
    });
});

test('threaded mailboxes emit attachments as grain 2 under their MESSAGE', async () => {
    // The bug: attachmentRows were computed and then silently dropped whenever
    // groupIntoThreads was on. The support desk sets it, so that desk could
    // never show an attachment no matter what includeAttachmentMeta said.
    listResult = {
        messages: [
            message('a', { thread_key: 'T1', direction: 'inbound', received_at: '2026-08-01T10:00:00Z' }),
            message('b', { thread_key: 'T2', direction: 'inbound', received_at: '2026-08-02T10:00:00Z', has_attachments: true }),
        ],
    };

    const res = await mailboxConnector.runMailboxConnector(
        connector({ groupIntoThreads: true }), { app: APP, viewerId: 'u1' },
    );

    assert.strictEqual(res.grains.length, 3, 'conversations, messages, attachments');
    assert.strictEqual(res.grains[2].rows.length, 1);
    // Rebased onto the MESSAGES grain: 'b' is message index 1 there. Pointing at
    // the original list index would attach it to the wrong conversation.
    assert.strictEqual(res.grains[2].rows[0]._parentIndex, 1);
    assert.strictEqual(res.grains[1].rows[1].provider_message_id, 'b');
    assert.strictEqual(res.meta.attachments, 1);
});

test('the attachment table can hold the file it points at', () => {
    const keys = mailboxConnector.MAILBOX_ATTACHMENT_TABLE_TEMPLATE.fields.map((f) => f.key);
    assert.ok(keys.includes('file'), 'a file column');
    assert.ok(keys.includes('provider_message_id'), 'the message id needed to redeem it');
    const file = mailboxConnector.MAILBOX_ATTACHMENT_TABLE_TEMPLATE.fields.find((f) => f.key === 'file');
    assert.strictEqual(file.type, 'file');
});

// ── Following a conversation past its labelled message ──────────────────────

test('thread mode pulls in the rest of the conversation', async () => {
    // A label belongs to a MESSAGE, not a thread. `label:support` matches the
    // message someone labelled; the reply an hour later carries no label and
    // matches nothing — so the ticket silently stops updating while the customer
    // keeps writing. In a support tool that looks like "answered".
    listResult = { messages: [message('a', { thread_key: 'T1', provider_thread_id: 'th-1' })] };
    threadResult = [
        message('a', { thread_key: 'T1', provider_thread_id: 'th-1' }),
        message('b', { thread_key: 'T1', provider_thread_id: 'th-1', received_at: '2026-08-06T10:52:00Z' }),
    ];

    const res = await mailboxConnector.runMailboxConnector(
        connector({ groupIntoThreads: true }), { app: APP, viewerId: 'u1' },
    );

    assert.strictEqual(threadCalls.length, 1, 'one expansion per distinct thread');
    assert.strictEqual(threadCalls[0].threadId, 'th-1');
    assert.strictEqual(res.grains[1].rows.length, 2, 'both messages');
    assert.strictEqual(res.grains[0].rows[0].message_count, 2);
    assert.strictEqual(res.grains[0].rows[0].last_message_at, '2026-08-06T10:52:00Z');
});

test('a message already returned by the search is not duplicated', async () => {
    listResult = { messages: [message('a', { thread_key: 'T1', provider_thread_id: 'th-1' })] };
    threadResult = [message('a', { thread_key: 'T1', provider_thread_id: 'th-1' })];
    const res = await mailboxConnector.runMailboxConnector(
        connector({ groupIntoThreads: true }), { app: APP, viewerId: 'u1' },
    );
    assert.strictEqual(res.grains[1].rows.length, 1);
});

test('an unreadable thread does not lose the messages already found', async () => {
    listResult = { messages: [message('a', { thread_key: 'T1', provider_thread_id: 'th-1' })] };
    threadError = new Error('boom');
    const res = await mailboxConnector.runMailboxConnector(
        connector({ groupIntoThreads: true }), { app: APP, viewerId: 'u1' },
    );
    assert.strictEqual(res.grains[1].rows.length, 1);
});

test('the flat log does NOT expand threads', async () => {
    // Only the threaded shape needs whole conversations; expanding for a flat
    // message log would multiply provider calls for nothing.
    listResult = { messages: [message('a', { provider_thread_id: 'th-1' })] };
    await mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' });
    assert.strictEqual(threadCalls.length, 0);
});

test('a thread with only outbound mail still has someone to reply to', async () => {
    // requester is "whoever wrote IN". A thread the agent started has no inbound
    // message at all, so Reply had no recipient and failed at submit.
    const grouped = mailboxConnector._groupIntoThreads([
        { thread_key: 'T1', direction: 'outbound', to_emails: 'klant@x.nl, cc@x.nl', received_at: '2026-08-01T00:00:00Z' },
    ]);
    assert.strictEqual(grouped.threads[0].requester_email, 'klant@x.nl');
});

test('a real inbound sender always beats the fallback', async () => {
    const grouped = mailboxConnector._groupIntoThreads([
        { thread_key: 'T1', direction: 'outbound', to_emails: 'wrong@x.nl', received_at: '2026-08-01T00:00:00Z' },
        { thread_key: 'T1', direction: 'inbound', from_email: 'klant@x.nl', received_at: '2026-08-02T00:00:00Z' },
    ]);
    assert.strictEqual(grouped.threads[0].requester_email, 'klant@x.nl');
});

test('attachments carry the conversation key they are filtered by', async () => {
    listResult = { messages: [message('a', { thread_key: 'T7', has_attachments: true })] };
    const res = await mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' });
    assert.strictEqual(res.grains[1].rows[0].thread_key, 'T7');
});

// ── Roll-up honesty ──────────────────────────────────────────────────────────

test('a thread we only hold a SLICE of keeps its stored counts', () => {
    // message_count computed over a slice overwrites a correct 11 with a wrong 3
    // — every run, for as long as the conversation stays busy. Omitting the
    // column leaves the previous complete answer alone (upsert writes only the
    // columns present).
    const grouped = mailboxConnector._groupIntoThreads([
        { thread_key: 'A', direction: 'inbound', received_at: '2026-08-01T00:00:00Z' },
        { thread_key: 'B', direction: 'inbound', received_at: '2026-08-01T00:00:00Z' },
    ], new Set(['A']));

    const [a, b] = grouped.threads;
    assert.ok(!('message_count' in a), 'a partial thread claims no count');
    assert.ok(!('has_unread' in a));
    assert.strictEqual(a.last_message_at, '2026-08-01T00:00:00Z', 'facts about the messages we DO have still land');
    assert.strictEqual(b.message_count, 1, 'a complete thread is measured as before');
});

test('first_response_secs is measured, but only on a complete thread', () => {
    const full = mailboxConnector._groupIntoThreads([
        { thread_key: 'A', direction: 'inbound', received_at: '2026-08-01T10:00:00Z', from_email: 'k@x.nl' },
        { thread_key: 'A', direction: 'outbound', received_at: '2026-08-01T10:30:00Z' },
        { thread_key: 'A', direction: 'outbound', received_at: '2026-08-01T12:00:00Z' },
    ]);
    assert.strictEqual(full.threads[0].first_response_secs, 1800, 'the FIRST reply, not the last');

    const partial = mailboxConnector._groupIntoThreads([
        { thread_key: 'A', direction: 'inbound', received_at: '2026-08-01T10:00:00Z' },
        { thread_key: 'A', direction: 'outbound', received_at: '2026-08-01T10:30:00Z' },
    ], new Set(['A']));
    assert.ok(!('first_response_secs' in partial.threads[0]), 'a slice cannot be timed');
});

test('a thread with no reply yet reports no response time, not zero', () => {
    const grouped = mailboxConnector._groupIntoThreads([
        { thread_key: 'A', direction: 'inbound', received_at: '2026-08-01T10:00:00Z' },
    ]);
    assert.ok(!('first_response_secs' in grouped.threads[0]));
});

test('the attachment upsert key is STABLE across runs — never the rotating provider token', async () => {
    // Gmail attachment ids are ephemeral: a fresh token on every fetch. Keying
    // rows on them meant the upsert never matched, so every 2-minute sync
    // inserted the same attachments AGAIN — the table grew by the full set per
    // run, and every older generation held an already-expired token.
    listResult = { messages: [message('a', { has_attachments: true })] };
    const first = await mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' });

    // Simulate the provider rotating the token on the second listing.
    attachmentMetaByMessage = (msgId) => [
        { provider_attachment_id: `ROTATED-${msgId}`, filename: 'bon.pdf', mime_type: 'application/pdf', size: 10, is_inline: false },
    ];
    listResult = { messages: [message('a', { has_attachments: true })] };
    const second = await mailboxConnector.runMailboxConnector(connector(), { app: APP, viewerId: 'u1' });

    const keyOf = (res) => res.grains[1].rows[0].provider_attachment_id;
    assert.strictEqual(keyOf(first), keyOf(second), 'same file → same key, whatever the provider token did');
    assert.ok(!keyOf(second).includes('ROTATED'), 'the rotating token is not the identity');
    // …but the DESCRIPTOR carries the fresh token, so redemption uses one that works.
    assert.strictEqual(second.grains[1].rows[0].file.attachmentId, 'ROTATED-a');
});
