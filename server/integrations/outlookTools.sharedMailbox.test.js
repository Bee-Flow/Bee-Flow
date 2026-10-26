// @typecheck
/**
 * Outlook steps on a SHARED mailbox: every tool takes `mailbox` ("me" by
 * default), goes to /users/{address}/... instead of /me/..., checks the
 * connection's .Shared scopes at the moment of use, and turns Graph's 403/404
 * into the App Studio mailbox connector's words.
 *
 * Graph is mocked at the HTTP boundary (global fetch), so the real
 * msGraphClient builds the requests and reads the error bodies.
 *
 * Run: cd server && node --test integrations/outlookTools.sharedMailbox.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { executeOutlookTool, executeOutlookSend, executeOutlookSaveDraft, OUTLOOK_TOOLS } = require('./outlookTools');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SHARED = 'team@contoso.com';
const SHARED_BASE = `${GRAPH}/users/team%40contoso.com`;
const SESSION = { oauthProvider: 'microsoft', accessToken: 'at', oauthScope: 'openid Mail.Read Mail.Send Mail.Read.Shared Mail.Send.Shared offline_access' };

/** @type {{ url: string, method: string, body: any }[]} */
let calls = [];
/** @type {(url: string, init: any) => { status: number, body?: any }} */
let answer = () => ({ status: 200, body: { value: [] } });
const realFetch = globalThis.fetch;

test.beforeEach(() => {
    calls = [];
    answer = () => ({ status: 200, body: { value: [] } });
    globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
        calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
        const { status, body } = answer(String(url), init);
        return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    });
});
test.afterEach(() => { globalThis.fetch = realFetch; });

const denied = () => ({ status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } } });

test('every Outlook tool declares the optional mailbox field', () => {
    for (const tool of OUTLOOK_TOOLS) {
        const props = tool.function.parameters.properties;
        assert.strictEqual(/** @type {any} */ (props).mailbox?.type, 'string', `${tool.function.name} has no mailbox`);
        assert.ok(!tool.function.parameters.required.includes('mailbox'), `${tool.function.name}: mailbox stays optional`);
    }
});

test('without a mailbox nothing changes: /me, as before', async () => {
    await executeOutlookTool('outlook_search', { query: 'invoice' }, SESSION);
    await executeOutlookTool('outlook_list_recent', {}, SESSION);
    await executeOutlookTool('outlook_list_recent', { mailbox: 'me' }, SESSION);
    assert.ok(calls[0].url.startsWith(`${GRAPH}/me/messages?$search=`));
    assert.ok(calls[1].url.startsWith(`${GRAPH}/me/mailFolders/inbox/messages?`));
    assert.ok(calls[2].url.startsWith(`${GRAPH}/me/mailFolders/inbox/messages?`));
});

test('search, list, read and read_many go to /users/{address}/ for a shared mailbox', async () => {
    answer = (url) => url.includes('/$batch')
        ? { status: 200, body: { responses: [{ id: '0', status: 200, body: { id: 'M1', subject: 'Hi', hasAttachments: false } }] } }
        : url.includes('/messages/M1?') ? { status: 200, body: { id: 'M1', subject: 'Hi', hasAttachments: false } }
            : { status: 200, body: { value: [{ id: 'M1', subject: 'Hi' }] } };

    const search = await executeOutlookTool('outlook_search', { query: 'invoice', mailbox: SHARED }, SESSION);
    const recent = await executeOutlookTool('outlook_list_recent', { folder: 'sentitems', mailbox: 'Team@Contoso.com' }, SESSION);
    await executeOutlookTool('outlook_read', { messageId: 'M1', mailbox: SHARED }, SESSION);
    const many = await executeOutlookTool('outlook_read_many', { messageIds: ['M1'], mailbox: SHARED }, SESSION);

    assert.ok(calls[0].url.startsWith(`${SHARED_BASE}/messages?$search=`), calls[0].url);
    assert.ok(calls[1].url.startsWith(`${SHARED_BASE}/mailFolders/sentitems/messages?`), calls[1].url);
    assert.ok(calls[2].url.startsWith(`${SHARED_BASE}/messages/M1?$select=`), calls[2].url);
    assert.strictEqual(calls[3].url, `${GRAPH}/$batch`);
    assert.ok(calls[3].body.requests[0].url.startsWith('/users/team%40contoso.com/messages/M1?'), calls[3].body.requests[0].url);
    assert.strictEqual(search.mailbox, SHARED, 'the result names the mailbox it came from');
    assert.strictEqual(recent.mailbox, SHARED);
    assert.strictEqual(many.messages.length, 1);
});

test('send goes out AS the shared mailbox, a reply answers in it', async () => {
    answer = () => ({ status: 202 });
    await executeOutlookSend({ to: 'client@example.com', subject: 'Hello', body: 'Hi', mailbox: SHARED }, SESSION);
    await executeOutlookSend({ to: 'client@example.com', subject: 'Re: Hello', body: 'Hi', replyToMessageId: 'M1', mailbox: SHARED }, SESSION);
    assert.strictEqual(calls[0].url, `${SHARED_BASE}/sendMail`);
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(calls[1].url, `${SHARED_BASE}/messages/M1/reply`);
});

test('compose: an unattended run sends from the shared mailbox; a chat draft carries it to the approval card', async () => {
    answer = (url) => url.endsWith('/sendMail') ? { status: 202 } : { status: 200, body: { conversationId: 'C1' } };
    const sent = await executeOutlookTool('outlook_compose', { to: 'a@example.com', subject: 'S', body: 'B', mailbox: SHARED }, SESSION, { autoSend: true });
    assert.strictEqual(sent.sent, true);
    assert.strictEqual(sent.mailbox, SHARED);
    assert.strictEqual(calls.at(-1)?.url, `${SHARED_BASE}/sendMail`);

    const draft = await executeOutlookTool('outlook_compose', { to: 'a@example.com', subject: 'S', body: 'B', mailbox: SHARED }, SESSION);
    assert.strictEqual(draft._action, 'email_draft');
    assert.strictEqual(draft.draft.mailbox, SHARED);
    const own = await executeOutlookTool('outlook_compose', { to: 'a@example.com', subject: 'S', body: 'B' }, SESSION);
    assert.ok(!('mailbox' in own.draft), 'the own mailbox stays implicit, as before');
});

test('an invalid address is refused before anything reaches Graph', async () => {
    for (const mailbox of ['team', 'x/../users/ceo@contoso.com', 42]) {
        await assert.rejects(executeOutlookTool('outlook_search', { query: 'x', mailbox }, SESSION),
            (/** @type {any} */ err) => err.status === 400 && err.code === 'invalid_mailbox');
        await assert.rejects(executeOutlookSend({ to: 'a@example.com', subject: 'S', body: 'B', mailbox }, SESSION),
            (/** @type {any} */ err) => err.code === 'invalid_mailbox');
    }
    assert.strictEqual(calls.length, 0);
});

test('a connection without the .Shared scopes gets the reconnect message, checked at every call', async () => {
    const ssoOnly = { oauthProvider: 'microsoft', accessToken: 'at', oauthScope: 'openid Mail.Read Mail.Send offline_access' };
    await assert.rejects(executeOutlookTool('outlook_list_recent', { mailbox: SHARED }, ssoOnly),
        (/** @type {any} */ err) => err.status === 403 && err.code === 'shared_mailbox_scope_missing'
            && /Reconnect Microsoft in Settings → Connections/.test(err.message));
    await assert.rejects(executeOutlookSend({ to: 'a@example.com', subject: 'S', body: 'B', mailbox: SHARED }, ssoOnly),
        (/** @type {any} */ err) => err.code === 'shared_mailbox_scope_missing');
    assert.strictEqual(calls.length, 0, 'refused before Graph');
    // The automation session carries the scope on its Microsoft credential.
    const automation = { oauthProvider: 'microsoft', accessToken: 'at', automationProviders: { microsoft: { accessToken: 'at', scope: 'Mail.Read Mail.Send' } } };
    await assert.rejects(executeOutlookTool('outlook_search', { query: 'x', mailbox: SHARED }, automation),
        (/** @type {any} */ err) => err.code === 'shared_mailbox_scope_missing');
    // The own mailbox needs no .Shared scope.
    await executeOutlookTool('outlook_list_recent', {}, ssoOnly);
    assert.strictEqual(calls.length, 1);
});

test('Graph 403 on the shared mailbox becomes the clear "no access" error, for every tool', async () => {
    answer = (url, init) => url.includes('/$batch')
        ? { status: 200, body: { responses: JSON.parse(init.body).requests.map((/** @type {{ id: string }} */ r) => ({ id: r.id, ...denied() })) } }
        : denied();
    const isDenied = (/** @type {any} */ err) => err.status === 403 && err.code === 'shared_mailbox_denied'
        && /^No access to the shared mailbox\. Your Microsoft administrator must grant you Full Access, and the connection needs the Mail\.Read\.Shared permission/.test(err.message)
        && !err.message.includes(SHARED);
    await assert.rejects(executeOutlookTool('outlook_search', { query: 'x', mailbox: SHARED }, SESSION), isDenied);
    await assert.rejects(executeOutlookTool('outlook_list_recent', { mailbox: SHARED }, SESSION), isDenied);
    await assert.rejects(executeOutlookTool('outlook_read', { messageId: 'M1', mailbox: SHARED }, SESSION), isDenied);
    await assert.rejects(executeOutlookTool('outlook_read_many', { messageIds: ['M1', 'M2'], mailbox: SHARED }, SESSION), isDenied);
    await assert.rejects(executeOutlookSend({ to: 'a@example.com', subject: 'S', body: 'B', mailbox: SHARED }, SESSION),
        (/** @type {any} */ err) => isDenied(err) && /Send As/.test(err.message));
});

test('Graph 404 for an unknown mailbox says so; the own mailbox keeps Graph\'s own error', async () => {
    answer = () => ({ status: 404, body: { error: { code: 'ErrorInvalidUser', message: "The requested user 'team@contoso.com' is invalid." } } });
    await assert.rejects(executeOutlookTool('outlook_list_recent', { mailbox: SHARED }, SESSION),
        (/** @type {any} */ err) => err.code === 'mailbox_not_found' && !err.message.includes(SHARED));
    answer = denied;
    await assert.rejects(executeOutlookTool('outlook_list_recent', {}, SESSION),
        (/** @type {any} */ err) => err.message === 'Access is denied. Check credentials and try again.' && err.code === undefined);
});

test('a draft cannot be saved INTO a shared mailbox (that needs Mail.ReadWrite.Shared, never asked for)', async () => {
    await assert.rejects(executeOutlookSaveDraft({ to: 'a@example.com', subject: 'S', body: 'B', mailbox: SHARED }, SESSION),
        (/** @type {any} */ err) => err.status === 400 && err.code === 'shared_mailbox_draft_unsupported');
    assert.strictEqual(calls.length, 0);
});
