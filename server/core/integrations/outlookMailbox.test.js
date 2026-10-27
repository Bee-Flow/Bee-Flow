// @typecheck strict
/**
 * The one rule for "which Outlook mailbox": the address check, the Graph path
 * for "me" vs a shared mailbox, the scope check and the error wording that
 * the Outlook steps, the trigger and the App Studio mailbox connector share.
 *
 * Run: cd server && node --test core/integrations/outlookMailbox.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    parseMailbox, isValidMailbox, mailboxBase, mailboxResource, hasSharedMailboxScopes, grantedScopeOf,
    assertSharedScopes, mapGraphMailboxError, mailboxLogRef, sharedMailboxDeniedText,
    SHARED_SCOPES_MISSING_TEXT, SHARED_MAILBOX_NOT_FOUND_TEXT, MAILBOX_PARAM,
} = require('./outlookMailbox.mts');
const { classifyMailboxError } = require('../../appStudio/mailboxConnector');

test('absent, empty and "me" (any case) are the own mailbox', () => {
    for (const v of [undefined, null, '', '   ', 'me', 'ME', ' Me ']) {
        assert.deepStrictEqual(parseMailbox(v), { shared: false }, JSON.stringify(v));
    }
});

test('an address is a shared mailbox, trimmed and lower-cased', () => {
    assert.deepStrictEqual(parseMailbox(' Support@Contoso.com '), { shared: true, address: 'support@contoso.com' });
});

test('anything else is refused with a 400 that names the rule', () => {
    const bad = ['support', 'support@', '@contoso.com', 'a b@contoso.com', 'x/../users/ceo@contoso.com',
        'x?$select=id@contoso.com', 'x\\y@contoso.com', 'x@contoso', 42, {}, ['a@b.co'], `${'a'.repeat(65)}@contoso.com`];
    for (const v of bad) {
        assert.throws(() => parseMailbox(v), (/** @type {any} */ err) => err.status === 400 && err.code === 'invalid_mailbox'
            && /"me" or the e-mail address of a shared mailbox/.test(err.message), JSON.stringify(v));
        assert.strictEqual(isValidMailbox(v), false);
    }
    assert.strictEqual(isValidMailbox('team@contoso.com'), true);
    assert.strictEqual(isValidMailbox(undefined), true);
});

test('the Graph path: /me for the own mailbox, /users/{address} for a shared one', () => {
    assert.strictEqual(mailboxBase(parseMailbox('me')), '/me');
    assert.strictEqual(mailboxBase(parseMailbox('team+sales@contoso.com')), '/users/team%2Bsales%40contoso.com');
    assert.strictEqual(mailboxResource(parseMailbox(undefined)), 'me');
    assert.strictEqual(mailboxResource(parseMailbox('team@contoso.com')), 'users/team%40contoso.com');
});

test('the shared scopes: both needed, case-insensitive', () => {
    assert.strictEqual(hasSharedMailboxScopes('Mail.Read Mail.Read.Shared mail.send.shared'), true);
    assert.strictEqual(hasSharedMailboxScopes('Mail.Read.Shared'), false);
    assert.strictEqual(hasSharedMailboxScopes('Mail.Read Mail.Send'), false);
    assert.strictEqual(hasSharedMailboxScopes(''), false);
    assert.strictEqual(hasSharedMailboxScopes(null), false);
});

test('the scope is read from an SSO session or from an automation session\'s Microsoft credential', () => {
    assert.strictEqual(grantedScopeOf({ oauthScope: 'Mail.Read' }), 'Mail.Read');
    assert.strictEqual(grantedScopeOf({ automationProviders: { microsoft: { scope: 'Mail.Read.Shared' } } }), 'Mail.Read.Shared');
    assert.strictEqual(grantedScopeOf({}), null);
    assert.strictEqual(grantedScopeOf(null), null);
});

test('a credential KNOWN to lack the shared scopes gets the reconnect message; an unknown scope goes on to Graph', () => {
    const shared = parseMailbox('team@contoso.com');
    assert.throws(() => assertSharedScopes(shared, { oauthScope: 'openid Mail.Read Mail.Send' }), (/** @type {any} */ err) => err.status === 403
        && err.code === 'shared_mailbox_scope_missing' && err.message === SHARED_SCOPES_MISSING_TEXT);
    assert.match(SHARED_SCOPES_MISSING_TEXT, /Mail\.Read\.Shared and Mail\.Send\.Shared/);
    assert.match(SHARED_SCOPES_MISSING_TEXT, /Reconnect Microsoft in Settings → Connections/);
    assert.doesNotThrow(() => assertSharedScopes(shared, { oauthScope: 'Mail.Read.Shared Mail.Send.Shared' }));
    assert.doesNotThrow(() => assertSharedScopes(shared, {}), 'no scope recorded: Graph decides');
    assert.doesNotThrow(() => assertSharedScopes(parseMailbox('me'), { oauthScope: 'Mail.Read' }), 'the own mailbox needs no .Shared scope');
});

test('Graph 403 on a shared mailbox becomes the App Studio connector\'s "no access" instruction', () => {
    const shared = parseMailbox('team@contoso.com');
    const mapped = /** @type {any} */ (mapGraphMailboxError(Object.assign(new Error('Access is denied. Check credentials and try again.'), { graphStatus: 403, graphCode: 'ErrorAccessDenied' }), shared));
    assert.strictEqual(mapped.status, 403);
    assert.strictEqual(mapped.code, 'shared_mailbox_denied');
    assert.match(mapped.message, /^No access to the shared mailbox\. Your Microsoft administrator must grant you Full Access, and the connection needs the Mail\.Read\.Shared permission — reconnect Microsoft in Settings → Connections\.$/);
    assert.ok(!mapped.message.includes('team@contoso.com'), 'the error (which lands in run logs) never carries the address');
    // A batched answer hands the status in as `status`.
    assert.strictEqual(/** @type {any} */ (mapGraphMailboxError({ status: 403 }, shared)).code, 'shared_mailbox_denied');
});

test('the wording is the App Studio connector\'s, word for word', () => {
    const fromConnector = classifyMailboxError({ status: 403 }, { mode: 'shared', address: 'team@contoso.com' });
    assert.strictEqual(fromConnector.message, sharedMailboxDeniedText('team@contoso.com'));
    assert.strictEqual(fromConnector.code, 'shared_mailbox_denied');
});

test('a 404 for the MAILBOX becomes "not found"; a 404 for a message stays as it is', () => {
    const shared = parseMailbox('team@contoso.com');
    const noUser = /** @type {any} */ (mapGraphMailboxError(Object.assign(new Error("The requested user 'team@contoso.com' is invalid."), { graphStatus: 404, graphCode: 'ErrorInvalidUser' }), shared));
    assert.strictEqual(noUser.code, 'mailbox_not_found');
    assert.strictEqual(noUser.message, SHARED_MAILBOX_NOT_FOUND_TEXT);
    const noMessage = Object.assign(new Error('The specified object was not found in the store.'), { graphStatus: 404, graphCode: 'ErrorItemNotFound' });
    assert.strictEqual(mapGraphMailboxError(noMessage, shared), noMessage);
});

test('the own mailbox\'s errors are never rewritten', () => {
    const err = Object.assign(new Error('Access is denied.'), { graphStatus: 403 });
    assert.strictEqual(mapGraphMailboxError(err, parseMailbox('me')), err);
});

test('a log reference never contains the address', () => {
    const ref = mailboxLogRef(parseMailbox('team@contoso.com'));
    assert.match(ref, /^shared:[0-9a-f]{10}$/);
    assert.ok(!ref.includes('team'));
    assert.strictEqual(mailboxLogRef(parseMailbox('me')), 'own');
    assert.strictEqual(ref, mailboxLogRef(parseMailbox('TEAM@contoso.com')), 'stable across case');
});

test('the tool parameter describes the field the builder and the MCP tools offer', () => {
    assert.strictEqual(MAILBOX_PARAM.type, 'string');
    assert.match(MAILBOX_PARAM.description, /"me" \(the default\)/);
    assert.match(MAILBOX_PARAM.description, /shared mailbox/);
});
