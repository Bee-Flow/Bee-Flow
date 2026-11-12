/**
 * gmail_reply_in_thread: no recipient parameter, recipients from the original (the sender; others only with the
 * owner's reply-all; Reply-To only on the sender's domain; a cap), the automatic-reply header, a draft instead of a
 * send after a read outside the thread, and refusals for another thread, a run without a mail trigger, automatic mail.
 *
 * Run: node --test integrations/gmail/replyInThread.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { replyInThread } = require('./replyInThread');
const { GMAIL_TOOLS } = require('./toolDefinitions');

const mailTrigger = () => ({ provider: 'gmail', messageId: 'm1', threadId: 'T1', mailbox: 'me@corp.nl', outcomes: [] });

function fakeGmail({ threadId = 'T1', headers = {} } = {}) {
    const sent = [];
    const drafts = [];
    const h = {
        'Message-ID': '<orig@x>', From: 'Ann <ann@ext.com>', To: 'me@corp.nl, bob@corp.nl', Cc: 'cy@ext.com', Subject: 'Offer', ...headers,
    };
    return {
        sent, drafts,
        users: {
            messages: {
                get: async () => ({ data: { threadId, payload: { headers: Object.entries(h).map(([name, value]) => ({ name, value })) } } }),
                send: async (p) => { sent.push(p); return { data: { id: 'S1', threadId: p.requestBody.threadId } }; },
            },
            drafts: { create: async (p) => { drafts.push(p); return { data: { id: 'D1' } }; } },
        },
    };
}
const decode = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const rawOf = (p) => decode(p.requestBody.raw);
const headerLine = (raw, name) => raw.split('\r\n\r\n')[0].split('\r\n').find(l => l.startsWith(`${name}: `)) || '';

test('the tool has no recipient parameter at all', () => {
    const def = GMAIL_TOOLS.find(t => t.function.name === 'gmail_reply_in_thread').function;
    assert.deepStrictEqual(Object.keys(def.parameters.properties).sort(), ['body', 'messageId']);
});

test('replies to the sender in the same thread; recipients come from the original, not from the arguments', async () => {
    const gmail = fakeGmail();
    const mt = mailTrigger();
    const res = await replyInThread(gmail, { messageId: 'm1', body: 'Thanks', to: 'evil@x.com', cc: 'evil@x.com' }, { user: { email: 'me@corp.nl' } }, { mailTrigger: mt });
    assert.strictEqual(res.sent, true);
    assert.strictEqual(gmail.sent.length, 1);
    assert.strictEqual(gmail.sent[0].requestBody.threadId, 'T1');
    const raw = rawOf(gmail.sent[0]);
    assert.match(raw, /ann@ext\.com/);
    assert.doesNotMatch(raw, /evil@x\.com/);
    assert.doesNotMatch(raw, /bob@corp\.nl|cy@ext\.com/);
    assert.match(raw, /In-Reply-To: <orig@x>/);
    assert.match(raw, /\r\nAuto-Submitted: auto-replied\r\n/);
    assert.deepStrictEqual(mt.outcomes, [{ kind: 'reply_sent' }]);
});

test('a foreign Reply-To and fifty Cc addresses: one recipient, the sender', async () => {
    const cc = Array.from({ length: 50 }, (_, i) => `p${i}@spam.example`).join(', ');
    const gmail = fakeGmail({ headers: { 'Reply-To': 'collect@other.example', Cc: cc } });
    const res = await replyInThread(gmail, { messageId: 'm1', body: 'Thanks', replyAll: true }, { user: { email: 'me@corp.nl' } }, { mailTrigger: mailTrigger() });
    assert.strictEqual(res.repliedTo, 1);
    const raw = rawOf(gmail.sent[0]);
    assert.strictEqual(headerLine(raw, 'To'), 'To: ann@ext.com');
    assert.strictEqual(headerLine(raw, 'Cc'), '');
    assert.match(raw, /Auto-Submitted: auto-replied/);
});

test('a Reply-To on the sender\'s own domain is answered', async () => {
    const gmail = fakeGmail({ headers: { 'Reply-To': 'sales@ext.com' } });
    await replyInThread(gmail, { messageId: 'm1', body: 'Thanks' }, { user: { email: 'me@corp.nl' } }, { mailTrigger: mailTrigger() });
    assert.strictEqual(headerLine(rawOf(gmail.sent[0]), 'To'), 'To: sales@ext.com');
});

test('after a read outside the thread the reply is a draft in the thread, nothing is sent', async () => {
    const gmail = fakeGmail();
    const mt = { ...mailTrigger(), readOutside: true };
    const res = await replyInThread(gmail, { messageId: 'm1', body: 'Thanks' }, { user: { email: 'me@corp.nl' } }, { mailTrigger: mt });
    assert.strictEqual(res.sent, false);
    assert.match(res.message, /draft for the owner/);
    assert.strictEqual(gmail.sent.length, 0);
    assert.strictEqual(gmail.drafts.length, 1);
    assert.strictEqual(gmail.drafts[0].requestBody.message.threadId, 'T1');
    const raw = decode(gmail.drafts[0].requestBody.message.raw);
    assert.strictEqual(headerLine(raw, 'To'), 'To: ann@ext.com');
    assert.doesNotMatch(raw, /Auto-Submitted/);
    assert.deepStrictEqual(mt.outcomes, [{ kind: 'draft_saved' }]);
});

test('more recipients than AGENT_MAIL_REPLY_MAX_RECIPIENTS: a draft; 0 is unlimited', async () => {
    process.env.AGENT_MAIL_REPLY_MAX_RECIPIENTS = '2';
    try {
        const gmail = fakeGmail();
        const res = await replyInThread(gmail, { messageId: 'm1', body: 'x' }, { user: { email: 'me@corp.nl' } }, { mailTrigger: { ...mailTrigger(), replyAll: true } });
        assert.strictEqual(res.sent, false);
        assert.match(res.message, /3 people/);
        process.env.AGENT_MAIL_REPLY_MAX_RECIPIENTS = '0';
        const open = fakeGmail();
        assert.strictEqual((await replyInThread(open, { messageId: 'm1', body: 'x' }, { user: { email: 'me@corp.nl' } }, { mailTrigger: { ...mailTrigger(), replyAll: true } })).sent, true);
    } finally {
        delete process.env.AGENT_MAIL_REPLY_MAX_RECIPIENTS;
    }
});

test('the owner\'s reply-all adds the other people on To and Cc, never the own mailbox', async () => {
    const gmail = fakeGmail();
    await replyInThread(gmail, { messageId: 'm1', body: 'Thanks' }, { user: { email: 'me@corp.nl' } }, { mailTrigger: { ...mailTrigger(), replyAll: true } });
    const raw = rawOf(gmail.sent[0]);
    assert.match(raw, /Cc: .*bob@corp\.nl/);
    assert.match(raw, /Cc: .*cy@ext\.com/);
    assert.doesNotMatch(raw, /Cc: .*me@corp\.nl/);
});

test('a replyAll from the model is ignored: only the owner\'s setting widens the reply', async () => {
    const gmail = fakeGmail();
    await replyInThread(gmail, { messageId: 'm1', body: 'Thanks', replyAll: true }, { user: { email: 'me@corp.nl' } }, { mailTrigger: mailTrigger() });
    assert.strictEqual(headerLine(rawOf(gmail.sent[0]), 'Cc'), '');
});

test('reply-all without an address on the session asks Gmail for the own address and leaves it out', async () => {
    const gmail = fakeGmail();
    gmail.users.getProfile = async () => ({ data: { emailAddress: 'Me@Corp.nl' } });
    await replyInThread(gmail, { messageId: 'm1', body: 'Thanks' }, {}, { mailTrigger: { ...mailTrigger(), mailbox: null, replyAll: true } });
    const raw = rawOf(gmail.sent[0]);
    assert.match(raw, /Cc: .*bob@corp\.nl/);
    assert.doesNotMatch(raw, /Cc: .*me@corp\.nl/);
});

test('refuses a message in another thread, and sends nothing', async () => {
    const gmail = fakeGmail({ threadId: 'OTHER' });
    await assert.rejects(() => replyInThread(gmail, { messageId: 'm9', body: 'x' }, {}, { mailTrigger: mailTrigger() }), /not in the thread/);
    assert.strictEqual(gmail.sent.length, 0);
});

test('refuses outside a mail-triggered run, and for the other provider', async () => {
    const gmail = fakeGmail();
    await assert.rejects(() => replyInThread(gmail, { messageId: 'm1', body: 'x' }, {}, {}), /started by a new mail/);
    await assert.rejects(() => replyInThread(gmail, { messageId: 'm1', body: 'x' }, {}, { mailTrigger: { ...mailTrigger(), provider: 'outlook' } }), /started by a new mail/);
    assert.strictEqual(gmail.sent.length, 0);
});

test('does not answer automatic mail (loop guard)', async () => {
    for (const headers of [{ 'Auto-Submitted': 'auto-replied' }, { Precedence: 'bulk' }]) {
        const gmail = fakeGmail({ headers });
        await assert.rejects(() => replyInThread(gmail, { messageId: 'm1', body: 'x' }, {}, { mailTrigger: mailTrigger() }), /automatic message/);
        assert.strictEqual(gmail.sent.length, 0);
    }
});
