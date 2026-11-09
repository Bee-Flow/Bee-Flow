/**
 * gmail_reply_in_thread: no recipient parameter, recipients from the original, refuses another thread, a run
 * without a mail trigger, and automatic mail.
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
    const h = {
        'Message-ID': '<orig@x>', From: 'Ann <ann@ext.com>', To: 'me@corp.nl, bob@corp.nl', Cc: 'cy@ext.com', Subject: 'Offer', ...headers,
    };
    return {
        sent,
        users: { messages: {
            get: async () => ({ data: { threadId, payload: { headers: Object.entries(h).map(([name, value]) => ({ name, value })) } } }),
            send: async (p) => { sent.push(p); return { data: { id: 'S1', threadId: p.requestBody.threadId } }; },
        } },
    };
}
const rawOf = (p) => Buffer.from(p.requestBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

test('the tool has no recipient parameter at all', () => {
    const def = GMAIL_TOOLS.find(t => t.function.name === 'gmail_reply_in_thread').function;
    assert.deepStrictEqual(Object.keys(def.parameters.properties).sort(), ['body', 'messageId', 'replyAll']);
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
    assert.deepStrictEqual(mt.outcomes, [{ kind: 'reply_sent' }]);
});

test('replyAll adds the other people on To and Cc, never the own mailbox', async () => {
    const gmail = fakeGmail();
    await replyInThread(gmail, { messageId: 'm1', body: 'Thanks', replyAll: true }, { user: { email: 'me@corp.nl' } }, { mailTrigger: mailTrigger() });
    const raw = rawOf(gmail.sent[0]);
    assert.match(raw, /Cc: .*bob@corp\.nl/);
    assert.match(raw, /Cc: .*cy@ext\.com/);
    assert.doesNotMatch(raw, /Cc: .*me@corp\.nl/);
});

test('replyAll without an address on the session asks Gmail for the own address and leaves it out', async () => {
    const gmail = fakeGmail();
    gmail.users.getProfile = async () => ({ data: { emailAddress: 'Me@Corp.nl' } });
    await replyInThread(gmail, { messageId: 'm1', body: 'Thanks', replyAll: true }, {}, { mailTrigger: { ...mailTrigger(), mailbox: null } });
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
