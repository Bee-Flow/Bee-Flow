/**
 * outlook_create_draft (Graph mocked) and outlook_reply_in_thread.
 *
 * Run: node --test integrations/outlookDraftReply.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
require('../boot/featureModules'); // outlook_create_draft reaches the draft service by name

const GRAPH = 'https://graph.microsoft.com/v1.0';
const calls = [];
let original = { conversationId: 'C1', subject: 'Offer', from: { emailAddress: { address: 'ann@ext.com' } }, internetMessageHeaders: [] };

// A fake Graph behind the global fetch: records every request, answers the reads the tools make.
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
    const path = String(url).slice(GRAPH.length);
    calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (/^\/me\?/.test(path)) return json({ mail: 'me@corp.nl' });
    if (/^\/me\/messages\/[^/]+\?\$select=(subject|conversationId)/.test(path)) return json(original);
    return json({});
};
after(() => { global.fetch = realFetch; });

const { executeOutlookTool, OUTLOOK_TOOLS } = require('./outlookTools');
// The draft service's own Graph client (token blob, no session) is replaced by property, not through the module system.
const providerClients = require('../services/email/providerClients');
const graphCalls = [];
providerClients.graphFetchFromTokens = async (tokens, onRefresh, path, opts = {}) => {
    graphCalls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, scope: tokens.scope });
    if (/createReply$/.test(path)) return { id: 'D1', toRecipients: [{ emailAddress: { address: 'ann@ext.com' } }], ccRecipients: [], conversationId: 'C1', webLink: 'https://outlook/draft/D1' };
    if (/\/messages$/.test(path)) return { id: 'D2', webLink: 'https://outlook/draft/D2', conversationId: 'C9' };
    return {};
};

const session = (scope) => ({ accessToken: 'tok', refreshToken: 'ref', oauthProvider: 'microsoft', oauthScope: scope });
const mailTrigger = () => ({ provider: 'outlook', messageId: 'AAMk1', threadId: 'C1', mailbox: null, outcomes: [] });

beforeEach(() => { calls.length = 0; graphCalls.length = 0; original = { conversationId: 'C1', subject: 'Offer', from: { emailAddress: { address: 'ann@ext.com' } }, internetMessageHeaders: [] }; });

test('outlook_create_draft as a reply: createReply on the original, nothing is sent', async () => {
    const mt = mailTrigger();
    const res = await executeOutlookTool('outlook_create_draft', { body: 'Hello', replyToMessageId: 'AAMk1' }, session('Mail.ReadWrite Mail.Read'), { mailTrigger: mt });
    assert.strictEqual(res.draftId, 'D1');
    assert.strictEqual(res.webLink, 'https://outlook/draft/D1');
    assert.ok(graphCalls.some(c => /\/me\/messages\/AAMk1\/createReply$/.test(c.path) && c.method === 'POST'));
    assert.ok(!graphCalls.some(c => /\/(send|sendMail|reply|replyAll)$/.test(c.path)), 'a draft never calls a send endpoint');
    assert.deepStrictEqual(mt.outcomes, [{ kind: 'draft_saved' }]);
});

test('outlook_create_draft as a new mail needs to and subject, and posts to /messages', async () => {
    await assert.rejects(() => executeOutlookTool('outlook_create_draft', { body: 'Hi' }, session('Mail.ReadWrite'), {}), /to is required/);
    const res = await executeOutlookTool('outlook_create_draft', { body: 'Hi', to: 'a@b.nl', subject: 'S' }, session('Mail.ReadWrite'), {});
    assert.strictEqual(res.draftId, 'D2');
    assert.ok(graphCalls.some(c => c.path === '/me/messages' && c.method === 'POST'));
});

test('outlook_create_draft without Mail.ReadWrite says to reconnect Microsoft 365 with mail write access', async () => {
    await assert.rejects(
        () => executeOutlookTool('outlook_create_draft', { body: 'Hi', to: 'a@b.nl', subject: 'S' }, session('Mail.Read User.Read'), {}),
        /Reconnect Microsoft 365 .*mail write access/,
    );
    assert.strictEqual(graphCalls.length, 0, 'refused before the first call');
});

test('outlook_reply_in_thread: no recipient parameter; replies through Graph reply, comment only', async () => {
    const def = OUTLOOK_TOOLS.find(t => t.function.name === 'outlook_reply_in_thread').function;
    assert.deepStrictEqual(Object.keys(def.parameters.properties).sort(), ['body', 'messageId', 'replyAll']);
    const mt = mailTrigger();
    const res = await executeOutlookTool('outlook_reply_in_thread', { messageId: 'AAMk1', body: 'Thanks', to: 'evil@x.com' }, session(''), { mailTrigger: mt });
    assert.strictEqual(res.sent, true);
    const send = calls.find(c => /\/reply$/.test(c.path));
    assert.ok(send && send.path === '/me/messages/AAMk1/reply');
    assert.deepStrictEqual(send.body, { comment: 'Thanks' });
    assert.deepStrictEqual(mt.outcomes, [{ kind: 'reply_sent' }]);
});

test('outlook_reply_in_thread refuses another conversation, a run without trigger, and automatic mail', async () => {
    original = { ...original, conversationId: 'OTHER' };
    await assert.rejects(() => executeOutlookTool('outlook_reply_in_thread', { messageId: 'AAMk2', body: 'x' }, session(''), { mailTrigger: mailTrigger() }), /not in the thread/);
    original = { ...original, conversationId: 'C1' };
    await assert.rejects(() => executeOutlookTool('outlook_reply_in_thread', { messageId: 'AAMk1', body: 'x' }, session(''), {}), /started by a new mail/);
    original = { ...original, internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-generated' }] };
    await assert.rejects(() => executeOutlookTool('outlook_reply_in_thread', { messageId: 'AAMk1', body: 'x' }, session(''), { mailTrigger: mailTrigger() }), /automatic message/);
    assert.ok(!calls.some(c => /\/(reply|replyAll)$/.test(c.path)));
});

test('outlook_reply_in_thread answers from the mailbox of the triggering mail, whatever the model passes', async () => {
    const mt = { ...mailTrigger(), mailbox: null };
    await executeOutlookTool('outlook_reply_in_thread', { messageId: 'AAMk1', body: 'x', mailbox: 'someone-else@corp.nl' }, session(''), { mailTrigger: mt });
    assert.ok(calls.every(c => !/someone-else/.test(c.path)));
});
