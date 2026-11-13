// @typecheck
/**
 * Company mailbox ingest: what a parsed message becomes in the company inbox.
 * The stores are fakes here; the cursor and the lease run against Postgres in
 * stores/supportCompanyMailboxStore.pg.test.js.
 *
 * Run: cd server && node --test services/supportCompanyMailbox/sync.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { normalizeParsed, pickUids, ingestCompanyMail, maskAddress } = require('./sync.mts');
const { detectAutoOrBulk } = require('../email/parse');

const MAILBOX = { emailAddress: 'support@example.test', aiAutoReply: false };

/** @param {Record<string, unknown>} over */
function parsed(over = {}) {
    return {
        messageId: '<m1@customer.test>',
        from: { value: [{ address: 'Customer@Customer.test', name: 'A Customer' }] },
        subject: 'Cannot sign in',
        text: 'Hello, I cannot sign in.',
        html: '<p>Hello, I cannot sign in.</p>',
        headerLines: [{ key: 'subject', line: 'Subject: Cannot sign in' }],
        ...over,
    };
}

/** A fake support store and the side channels, recording every call. */
function fakes({ existing = /** @type {Record<string, unknown> | null} */ (null), known = /** @type {string[]} */ ([]) } = {}) {
    /** @type {Record<string, unknown[]>} */
    const calls = { created: [], appended: [], updated: [], notified: [], emitted: [], chat: [], ai: [], sent: [] };
    const deps = {
        supportStore: {
            findCompanyThreadByRfcMessageId: async (/** @type {string[]} */ ids) => {
                if (ids.some((id) => known.includes(id))) return { id: 'dup' };
                return existing && ids.some((id) => (/** @type {string[]} */ (existing.ids)).includes(id)) ? existing : null;
            },
            createThread: async (/** @type {Record<string, unknown>} */ t) => { calls.created.push(t); return { id: 'new-thread', ...t }; },
            appendMessage: async (/** @type {Record<string, unknown>} */ m) => { calls.appended.push(m); return { id: 'msg-1' }; },
            updateThread: async (/** @type {string} */ id, /** @type {Record<string, unknown>} */ p) => { calls.updated.push({ id, ...p }); return {}; },
            recordThreadEvent: async () => ({}),
            setThreadSla: async () => ({}),
        },
        notifyStaff: async (/** @type {unknown} */ n) => { calls.notified.push(n); },
        emit: (/** @type {string} */ e) => { calls.emitted.push(e); },
        chatNotify: async (/** @type {{ event: string }} */ a) => { calls.chat.push(a.event); },
        computeSlaDueAt: async () => null,
        runAi: async (/** @type {string} */ id) => { calls.ai.push(id); return { message: { id: 'ai-1', body: 'Try resetting your password.' } }; },
        sendReply: async (/** @type {unknown} */ t, /** @type {unknown} */ a) => { calls.sent.push({ t, a }); return { rfc822MessageId: '<x@y>' }; },
        detectAutoOrBulk,
        htmlToText: (/** @type {string} */ h) => h.replace(/<[^>]+>/g, ''),
    };
    return { calls, deps };
}

const norm = (/** @type {Record<string, unknown>} */ over = {}) => normalizeParsed(/** @type {any} */ (parsed(over)), { uid: 7, uidValidity: '42' });

test('normalizeParsed: the requester is Reply-To when present, lower-cased; ids and headers come through', () => {
    const n = normalizeParsed(/** @type {any} */ (parsed({
        replyTo: { value: [{ address: 'Real@Person.test', name: 'Real Person' }] },
        inReplyTo: '<prev@x>',
        references: '<a@x>  <prev@x>',
        headerLines: [{ key: 'auto-submitted', line: 'Auto-Submitted: auto-replied' }],
    })), { uid: 7, uidValidity: '42' });
    assert.strictEqual(n.from, 'real@person.test');
    assert.strictEqual(n.fromName, 'Real Person');
    assert.strictEqual(n.providerMessageId, 'imap:42:7');
    assert.deepStrictEqual(n.references, ['<a@x>', '<prev@x>']);
    assert.strictEqual(n.getHeader('Auto-Submitted'), 'auto-replied');
    assert.strictEqual(n.getHeader('List-Id'), '');
});

test('pickUids: only after the cursor, oldest first, capped; n:* returning the newest below n is dropped', () => {
    assert.deepStrictEqual(pickUids([12, 10, 11, 9], 9, 0), [10, 11, 12]);
    assert.deepStrictEqual(pickUids([9], 9, 10), []);
    assert.deepStrictEqual(pickUids([5, 3, 4], null, 2), [3, 4]);
});

test('a new message opens an email ticket in the company inbox and tells staff without the full address', async () => {
    const { calls, deps } = fakes();
    const out = await ingestCompanyMail(norm(), MAILBOX, /** @type {any} */ (deps));
    assert.strictEqual(out, 'created');
    assert.strictEqual(calls.created.length, 1);
    const t = /** @type {Record<string, unknown>} */ (calls.created[0]);
    assert.strictEqual(t.source, 'email');
    assert.strictEqual(t.inboxId, null);
    assert.strictEqual(t.requesterEmail, 'customer@customer.test');
    assert.strictEqual(t.rfc822MessageId, '<m1@customer.test>');
    const m = /** @type {Record<string, unknown>} */ (calls.appended[0]);
    assert.strictEqual(m.providerMessageId, 'imap:42:7');
    assert.strictEqual(m.body, 'Hello, I cannot sign in.');
    const note = JSON.stringify(calls.notified);
    assert.ok(!note.includes('customer@customer.test'), 'the staff notice carries a masked address');
    assert.deepStrictEqual(calls.chat, ['ticket_created']);
    assert.deepStrictEqual(calls.ai, [], 'no AI answer while aiAutoReply is off');
});

test('a reply that points at a stored Message-ID lands on that ticket and reopens a resolved one', async () => {
    const existing = { id: 't-1', status: 'resolved', subject: 'Cannot sign in', ids: ['<ours@example.test>'], first_response_at: '2026-11-01' };
    const { calls, deps } = fakes({ existing });
    const out = await ingestCompanyMail(norm({ messageId: '<m2@customer.test>', inReplyTo: '<ours@example.test>' }), MAILBOX, /** @type {any} */ (deps));
    assert.strictEqual(out, 'appended');
    assert.strictEqual(calls.created.length, 0);
    assert.strictEqual((/** @type {Record<string, unknown>} */ (calls.appended[0])).threadId, 't-1');
    assert.deepStrictEqual(calls.updated, [{ id: 't-1', status: 'awaiting_agent', resolved_at: null }]);
    assert.deepStrictEqual(calls.chat, ['customer_message']);
});

test('a message whose own Message-ID is already stored is a duplicate and changes nothing', async () => {
    const { calls, deps } = fakes({ known: ['<m1@customer.test>'] });
    assert.strictEqual(await ingestCompanyMail(norm(), MAILBOX, /** @type {any} */ (deps)), 'duplicate');
    assert.strictEqual(calls.appended.length, 0);
});

test('auto-replies, our own address and no-reply senders never become tickets', async () => {
    const { calls, deps } = fakes();
    const auto = norm({ headerLines: [{ key: 'auto-submitted', line: 'Auto-Submitted: auto-replied' }] });
    assert.strictEqual(await ingestCompanyMail(auto, MAILBOX, /** @type {any} */ (deps)), 'skipped:auto_submitted');
    const self = norm({ from: { value: [{ address: 'support@example.test' }] } });
    assert.strictEqual(await ingestCompanyMail(self, MAILBOX, /** @type {any} */ (deps)), 'skipped:self_loop');
    const noreply = norm({ from: { value: [{ address: 'no-reply@shop.test' }] } });
    assert.strictEqual(await ingestCompanyMail(noreply, MAILBOX, /** @type {any} */ (deps)), 'skipped:noreply_sender');
    assert.strictEqual(calls.created.length, 0);
});

test('with aiAutoReply on, the AI answers a new ticket over the company mailbox, marked as an AI reply', async () => {
    const { calls, deps } = fakes();
    await ingestCompanyMail(norm(), { ...MAILBOX, aiAutoReply: true }, /** @type {any} */ (deps));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(calls.ai, ['new-thread']);
    const sent = /** @type {{ a: { isAiReply: boolean, messageId: string } }} */ (calls.sent[0]);
    assert.strictEqual(sent.a.isAiReply, true);
    assert.strictEqual(sent.a.messageId, 'ai-1');
});

test('with aiAutoReply on, a reply on a ticket a person already answered is left to staff', async () => {
    const existing = { id: 't-1', status: 'awaiting_user', ids: ['<ours@example.test>'], first_response_at: '2026-11-01', ai_handled: true };
    const { calls, deps } = fakes({ existing });
    await ingestCompanyMail(norm({ messageId: '<m3@c>', inReplyTo: '<ours@example.test>' }), { ...MAILBOX, aiAutoReply: true }, /** @type {any} */ (deps));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(calls.ai, []);
});

test('maskAddress keeps a hint, never the address', () => {
    assert.strictEqual(maskAddress('customer@customer.test'), 'cu***@c***');
});
