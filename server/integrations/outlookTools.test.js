/**
 * Outlook send / reply / save-draft recipient handling.
 *
 * outlook_compose accepts a `bcc`, the draft carries it and EmailDraftCard
 * shows it — but only the plain sendMail path ever put it on the wire. The
 * reply payload forwarded to/cc only (mail genuinely went out, the card said
 * "sent", and the BCC copy never arrived) and executeOutlookSaveDraft never
 * looked at draft.bcc at all. One shared buildOutlookMessage now feeds all
 * three, so the next recipient field cannot go missing from one of them.
 *
 * './msGraphClient' is stubbed via installResolveStub (pattern:
 * calendarTools.test.js) with a fake Graph recording every request.
 *
 * Run: cd server && node --test integrations/outlookTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

const calls = [];

const restore = installResolveStub({
    './msGraphClient': {
        isMicrosoftConnected: () => true,
        graphFetch: async (path, session, options = {}) => {
            calls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
            return { id: 'DRAFT1', conversationId: 'C1' };
        },
        GRAPH_BASE: 'https://graph.microsoft.com/v1.0',
    },
});

const {
    executeOutlookTool,
    executeOutlookSend,
    executeOutlookSaveDraft,
    buildOutlookMessage,
    isOutlookTool,
} = require('./outlookTools');

test.after(() => restore());

const SESSION = { oauthProvider: 'microsoft', accessToken: 'at' };

const DRAFT = {
    _provider: 'microsoft',
    to: 'boss@company.com',
    cc: 'team@company.com',
    bcc: 'compliance@company.com',
    subject: 'Re: Q3 numbers',
    body: 'See attached.',
    replyToMessageId: 'MSG1',
};

const addresses = (list) => (list || []).map(r => r.emailAddress.address);

// ═══ BCC survives every outbound path ═══════════════════════════════

test('reply: the BCC the card showed is actually sent', async () => {
    calls.length = 0;
    await executeOutlookSend(DRAFT, SESSION);

    assert.strictEqual(calls[0].path, '/me/messages/MSG1/reply');
    const message = calls[0].body.message;
    assert.deepStrictEqual(addresses(message.toRecipients), ['boss@company.com']);
    assert.deepStrictEqual(addresses(message.ccRecipients), ['team@company.com']);
    assert.deepStrictEqual(addresses(message.bccRecipients), ['compliance@company.com'],
        'reply payload carries bccRecipients (was dropped silently)');
});

test('new mail: to/cc/bcc all reach sendMail', async () => {
    calls.length = 0;
    await executeOutlookSend({ ...DRAFT, replyToMessageId: null }, SESSION);

    assert.strictEqual(calls[0].path, '/me/sendMail');
    const message = calls[0].body.message;
    assert.deepStrictEqual(addresses(message.bccRecipients), ['compliance@company.com']);
    assert.strictEqual(calls[0].body.saveToSentItems, true);
});

test('save draft: the BCC is stored on the Outlook draft', async () => {
    calls.length = 0;
    const result = await executeOutlookSaveDraft(DRAFT, SESSION);

    assert.strictEqual(calls[0].path, '/me/messages');
    assert.deepStrictEqual(addresses(calls[0].body.bccRecipients), ['compliance@company.com'],
        'saved draft keeps the user-entered BCC (was dropped silently)');
    assert.strictEqual(result.draftId, 'DRAFT1');
});

// ═══ The shared builder ═════════════════════════════════════════════

test('buildOutlookMessage: splits lists, trims, and omits empty fields', () => {
    const message = buildOutlookMessage({
        to: 'a@x.com, b@x.com ',
        subject: 'Hi',
        body: 'text',
    });
    assert.deepStrictEqual(addresses(message.toRecipients), ['a@x.com', 'b@x.com']);
    assert.ok(!('ccRecipients' in message), 'no empty ccRecipients when cc is absent');
    assert.ok(!('bccRecipients' in message), 'no empty bccRecipients when bcc is absent');

    const trailing = buildOutlookMessage({ to: 'a@x.com,', bcc: 'c@x.com , ', subject: 's', body: 'b' });
    assert.deepStrictEqual(addresses(trailing.toRecipients), ['a@x.com'], 'trailing comma does not add a blank recipient');
    assert.deepStrictEqual(addresses(trailing.bccRecipients), ['c@x.com']);
});

test('the prefix test matches this module and nothing broader', () => {
    assert.strictEqual(isOutlookTool('outlook_compose'), true);
    assert.strictEqual(isOutlookTool('gmail_compose'), false);
});

// ═══ outlook_compose: draft in a chat, send in an unattended run ════

const COMPOSE = { to: 'boss@company.com', cc: 'team@company.com', subject: 'Q3', body: 'Numbers attached.' };

test('outlook_compose without autoSend returns a draft and sends nothing', async () => {
    calls.length = 0;
    const result = await executeOutlookTool('outlook_compose', COMPOSE, SESSION);

    assert.strictEqual(result._action, 'email_draft');
    assert.strictEqual(result.draft._provider, 'microsoft');
    assert.strictEqual(result.draft.to, 'boss@company.com');
    assert.ok(!calls.some(c => c.method === 'POST'), 'no Graph write without approval');
});

test('outlook_compose with autoSend sends via sendMail and returns the sent shape', async () => {
    calls.length = 0;
    const result = await executeOutlookTool('outlook_compose', COMPOSE, SESSION, { autoSend: true });

    assert.strictEqual(result.sent, true);
    assert.strictEqual(result._action, undefined, 'no draft card in an unattended run');
    assert.strictEqual(result.to, 'boss@company.com');
    assert.strictEqual(result.subject, 'Q3');
    const send = calls.find(c => c.path === '/me/sendMail');
    assert.ok(send, 'sendMail was called');
    assert.strictEqual(send.method, 'POST');
    assert.deepStrictEqual(addresses(send.body.message.toRecipients), ['boss@company.com']);
    assert.deepStrictEqual(addresses(send.body.message.ccRecipients), ['team@company.com']);
});

test('outlook_compose with autoSend on a reply uses the reply endpoint', async () => {
    calls.length = 0;
    const result = await executeOutlookTool('outlook_compose', { ...COMPOSE, replyToMessageId: 'MSG9' }, SESSION, { autoSend: true });

    assert.strictEqual(result.sent, true);
    assert.strictEqual(result.replyToMessageId, 'MSG9');
    assert.strictEqual(result.conversationId, 'C1', 'reply context is still looked up');
    assert.ok(calls.some(c => c.path === '/me/messages/MSG9/reply' && c.method === 'POST'));
    assert.ok(!calls.some(c => c.path === '/me/sendMail'));
});

// ═══ Model-supplied ids never reach a Graph path unchecked ══════════

const TRAVERSAL = 'a/../../users/x@corp.com/messages/MSG1';

test('outlook_compose with autoSend refuses a path-like replyToMessageId without calling Graph', async () => {
    calls.length = 0;
    await assert.rejects(
        executeOutlookTool('outlook_compose', { ...COMPOSE, replyToMessageId: TRAVERSAL }, SESSION, { autoSend: true }),
        /not an Outlook message id/,
    );
    assert.strictEqual(calls.length, 0, 'no Graph call at all');
});

test('outlook_compose as a draft refuses a path-like replyToMessageId too', async () => {
    calls.length = 0;
    await assert.rejects(
        executeOutlookTool('outlook_compose', { ...COMPOSE, replyToMessageId: TRAVERSAL }, SESSION),
        /not an Outlook message id/,
    );
    assert.strictEqual(calls.length, 0);
});

test('executeOutlookSend refuses a path-like replyToMessageId', async () => {
    calls.length = 0;
    await assert.rejects(
        executeOutlookSend({ ...DRAFT, replyToMessageId: TRAVERSAL }, SESSION),
        /not an Outlook message id/,
    );
    assert.strictEqual(calls.length, 0);
});

test('outlook_read and outlook_list_recent refuse path-like ids', async () => {
    calls.length = 0;
    await assert.rejects(executeOutlookTool('outlook_read', { messageId: TRAVERSAL }, SESSION), /not an Outlook message id/);
    await assert.rejects(executeOutlookTool('outlook_list_recent', { folder: '../../users/x/mailFolders/inbox' }, SESSION), /folder is a mail folder name/);
    assert.strictEqual(calls.length, 0);
});
