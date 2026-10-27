// @typecheck strict
/**
 * The Outlook family opens a SHARED mailbox only with the asker's own
 * Microsoft connection. A lent connection (connection lending) or an acting
 * identity (the Support inbox's operator) lends that person's own mailbox,
 * never every shared mailbox they happen to have Full Access to.
 *
 * Run: cd server && node --test integrations/toolFamilies.sharedMailbox.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

require('./toolFamilies');
const { getToolFamily } = require('../core/tools/toolFamilyRegistry');

const outlook = /** @type {NonNullable<ReturnType<typeof getToolFamily>>} */ (getToolFamily('outlook'));
const SESSION = { oauthProvider: 'microsoft', accessToken: 'at', oauthScope: 'Mail.Read.Shared Mail.Send.Shared' };
const realFetch = globalThis.fetch;
/** @type {string[]} */
let urls = [];
test.beforeEach(() => {
    urls = [];
    globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => { urls.push(String(url)); return new Response(JSON.stringify({ value: [] }), { status: 200 }); });
});
test.afterEach(() => { globalThis.fetch = realFetch; });

const refused = (/** @type {any} */ err) => err.status === 403 && err.code === 'shared_mailbox_not_lendable';

test('a lent connection cannot open a shared mailbox', async () => {
    await assert.rejects(Promise.resolve(outlook.execute('outlook_list_recent', { mailbox: 'team@contoso.com' },
        /** @type {any} */ ({ userId: 'owner', session: SESSION, lentConnection: { connectionId: 'c1' } }))), refused);
    assert.equal(urls.length, 0);
});

test('an acting identity (asker is not the integration user) cannot either', async () => {
    await assert.rejects(Promise.resolve(outlook.execute('outlook_search', { query: 'x', mailbox: 'team@contoso.com' },
        /** @type {any} */ ({ userId: 'operator', askerUserId: 'asker', session: SESSION }))), refused);
    assert.equal(urls.length, 0);
});

test('the own connection opens it; a lent connection still reads its owner\'s own mailbox', async () => {
    await outlook.execute('outlook_list_recent', { mailbox: 'team@contoso.com' }, /** @type {any} */ ({ userId: 'u1', askerUserId: 'u1', session: SESSION }));
    await outlook.execute('outlook_list_recent', {}, /** @type {any} */ ({ userId: 'owner', session: SESSION, lentConnection: { connectionId: 'c1' } }));
    assert.ok(urls[0].startsWith('https://graph.microsoft.com/v1.0/users/team%40contoso.com/'));
    assert.ok(urls[1].startsWith('https://graph.microsoft.com/v1.0/me/'));
});
