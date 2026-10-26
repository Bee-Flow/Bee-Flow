// @typecheck
/**
 * "New email" on a shared Outlook mailbox, by polling (Graph has no change
 * notifications for shared mailboxes on delegated access).
 *
 * Pins: the first tick anchors without firing; later ticks fire each new mail
 * once, also two in the same second; the shared mailbox is read at
 * /users/{address}/; access is re-checked at every tick (scopes, then Graph's
 * 403) with the clear error; the error never carries the address; a cursor
 * never carries over to another mailbox; Graph gets the MICROSOFT session.
 *
 * Graph is mocked at the HTTP boundary (global fetch) under the real msGraphClient.
 *
 * Run: cd server && node --test automation/triggerBus/pollers/msGraphMail.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { createMsGraphPollers, parseCursor, MAX_MESSAGES_PER_TICK } = require('./msGraphMail.mts');

const SHARED = 'team@contoso.com';
const SCOPED = { oauthProvider: 'microsoft', accessToken: 'ms-at', oauthScope: 'Mail.Read Mail.Read.Shared Mail.Send.Shared' };

/** @type {string[]} */
let urls = [];
/** @type {string[]} */
let auth = [];
/** @type {(url: string) => { status: number, body: any }} */
let answer = () => ({ status: 200, body: { value: [] } });
const realFetch = globalThis.fetch;
test.beforeEach(() => {
    urls = []; auth = [];
    answer = () => ({ status: 200, body: { value: [] } });
    globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
        urls.push(decodeURIComponent(String(url)));
        auth.push(init.headers?.Authorization);
        const { status, body } = answer(decodeURIComponent(String(url)));
        return new Response(JSON.stringify(body), { status });
    });
});
test.afterEach(() => { globalThis.fetch = realFetch; });

function harness({ session = SCOPED } = {}) {
    /** @type {{ id: string, patch: any }[]} */
    const updates = [];
    /** @type {any[]} */
    const asked = [];
    const pollers = createMsGraphPollers({
        store: () => ({ updateSubscription: async (id, patch) => { updates.push({ id, patch }); } }),
        microsoftSession: async (s, userId, opts) => { asked.push({ s, userId, opts }); return /** @type {any} */ (session); },
        msGraphClient: () => require('../../../integrations/msGraphClient'),
    });
    return { poll: pollers['mail.new'], updates, asked };
}

const sub = (/** @type {any} */ over = {}) => ({ id: 'sub1', userId: 'u1', filter: { mailbox: SHARED }, lastCursor: null, ...over });
const cursor = (/** @type {string} */ t, /** @type {string[]} */ ids = [], m = 'shared:' + require('crypto').createHash('sha256').update(SHARED).digest('hex').slice(0, 10)) => JSON.stringify({ t, ids, m });

test('the first tick anchors at the newest mail of the SHARED inbox and fires nothing', async () => {
    answer = () => ({ status: 200, body: { value: [{ id: 'OLD', receivedDateTime: '2026-10-26T09:00:00Z' }] } });
    const h = harness();
    const events = await h.poll(sub(), { oauthProvider: 'google', accessToken: 'google-at' });
    assert.deepStrictEqual(events, []);
    assert.ok(urls[0].startsWith("https://graph.microsoft.com/v1.0/users/team@contoso.com/mailFolders('inbox')/messages?$top=1&$orderby=receivedDateTime desc"), urls[0]);
    assert.deepStrictEqual(auth, ['Bearer ms-at'], 'Graph gets the Microsoft session, never the Google primary');
    assert.deepStrictEqual(h.asked[0].opts, { needsSharedMailbox: true });
    const stored = parseCursor(h.updates[0].patch.lastCursor);
    assert.strictEqual(stored?.t, '2026-10-26T09:00:00Z');
    assert.deepStrictEqual(stored?.ids, ['OLD']);
});

test('later ticks fire each new mail once, with the shape of a Graph notification and the mailbox', async () => {
    const inbox = [
        { id: 'OLD', receivedDateTime: '2026-10-26T09:00:00Z' },
        { id: 'SAME_SECOND', receivedDateTime: '2026-10-26T09:00:00Z' },
        { id: 'NEW', receivedDateTime: '2026-10-26T09:05:00Z' },
    ];
    // Graph applies the `ge` filter.
    answer = (url) => {
        const since = /receivedDateTime ge (\S+?)&/.exec(url)?.[1] || '';
        return { status: 200, body: { value: inbox.filter(m => m.receivedDateTime >= since) } };
    };
    const h = harness();
    const events = await h.poll(sub({ lastCursor: cursor('2026-10-26T09:00:00Z', ['OLD']) }), {});
    assert.ok(urls[0].includes('$filter=receivedDateTime ge 2026-10-26T09:00:00Z&$orderby=receivedDateTime asc'), urls[0]);
    assert.deepStrictEqual(events.map(e => e.resourceData.id), ['SAME_SECOND', 'NEW']);
    assert.deepStrictEqual(events[1], {
        changeType: 'created',
        resource: "Messages('NEW')",
        resourceData: { id: 'NEW', '@odata.type': '#Microsoft.Graph.Message' },
        receivedDateTime: '2026-10-26T09:05:00Z',
        mailbox: SHARED,
    });
    const stored = parseCursor(h.updates[0].patch.lastCursor);
    assert.strictEqual(stored?.t, '2026-10-26T09:05:00Z');
    assert.deepStrictEqual(stored?.ids, ['NEW']);

    // The same answer again fires nothing new.
    const again = await h.poll(sub({ lastCursor: h.updates[0].patch.lastCursor }), {});
    assert.deepStrictEqual(again, []);
});

test('one tick fires at most MAX_MESSAGES_PER_TICK; the rest come next tick', async () => {
    const many = Array.from({ length: MAX_MESSAGES_PER_TICK + 5 }, (_, i) => ({ id: `M${i}`, receivedDateTime: `2026-10-26T10:${String(i).padStart(2, '0')}:00Z` }));
    answer = () => ({ status: 200, body: { value: many } });
    const h = harness();
    const events = await h.poll(sub({ lastCursor: cursor('2026-10-26T09:00:00Z') }), {});
    assert.strictEqual(events.length, MAX_MESSAGES_PER_TICK);
    assert.strictEqual(parseCursor(h.updates[0].patch.lastCursor)?.t, many[MAX_MESSAGES_PER_TICK - 1].receivedDateTime);
});

test('access is re-checked every tick: a connection without the .Shared scopes gets the reconnect message, before Graph', async () => {
    const h = harness({ session: { oauthProvider: 'microsoft', accessToken: 'ms-at', oauthScope: 'Mail.Read Mail.Send' } });
    await assert.rejects(h.poll(sub({ lastCursor: cursor('2026-10-26T09:00:00Z') }), {}),
        (/** @type {any} */ err) => err.code === 'shared_mailbox_scope_missing' && /Reconnect Microsoft in Settings → Connections/.test(err.message));
    assert.strictEqual(urls.length, 0);
});

test('Graph 403 (no Full Access) becomes the clear error, without the address', async () => {
    answer = () => ({ status: 403, body: { error: { code: 'ErrorAccessDenied', message: `Access to ${SHARED} is denied.` } } });
    const h = harness();
    await assert.rejects(h.poll(sub({ lastCursor: cursor('2026-10-26T09:00:00Z') }), {}),
        (/** @type {any} */ err) => err.code === 'shared_mailbox_denied' && /must grant you Full Access/.test(err.message) && !err.message.includes(SHARED));
    // Also on the very first (anchoring) tick.
    await assert.rejects(h.poll(sub(), {}), (/** @type {any} */ err) => err.code === 'shared_mailbox_denied');
    assert.deepStrictEqual(h.updates, [], 'no cursor is written on a refusal');
});

test('any other Graph error on a shared mailbox loses Graph\'s text (it can name the mailbox)', async () => {
    answer = () => ({ status: 500, body: { error: { code: 'InternalServerError', message: `Mailbox ${SHARED} is busy` } } });
    const h = harness();
    await assert.rejects(h.poll(sub({ lastCursor: cursor('2026-10-26T09:00:00Z') }), {}),
        (/** @type {any} */ err) => /HTTP 500/.test(err.message) && !err.message.includes(SHARED));
});

test('a cursor of another mailbox is not used: pointing the trigger elsewhere starts over', async () => {
    answer = () => ({ status: 200, body: { value: [{ id: 'X', receivedDateTime: '2026-10-26T11:00:00Z' }] } });
    const h = harness();
    const events = await h.poll(sub({ lastCursor: cursor('2026-10-26T09:00:00Z', [], 'own') }), {});
    assert.deepStrictEqual(events, [], 'anchored, nothing replayed');
    assert.ok(urls[0].includes('$top=1&$orderby=receivedDateTime desc'));
});

test('the own mailbox polls /me (an own-mailbox row without a public URL)', async () => {
    const h = harness({ session: { oauthProvider: 'microsoft', accessToken: 'ms-at', oauthScope: 'Mail.Read' } });
    await h.poll(sub({ filter: null }), {});
    assert.ok(urls[0].startsWith("https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages?"), urls[0]);
    assert.deepStrictEqual(h.asked[0].opts, { needsSharedMailbox: false });
});

test('an address that does not parse, or no Microsoft connection, fails the tick loudly', async () => {
    await assert.rejects(harness().poll(sub({ filter: { mailbox: 'team' } }), {}), (/** @type {any} */ err) => err.code === 'invalid_mailbox');
    await assert.rejects(harness({ session: /** @type {any} */ (null) }).poll(sub(), {}), /No Microsoft connection/);
    assert.strictEqual(urls.length, 0);
});

test('parseCursor ignores what is not ours', () => {
    assert.strictEqual(parseCursor(null), null);
    assert.strictEqual(parseCursor('12345'), null);
    assert.strictEqual(parseCursor(JSON.stringify({ t: 'yesterday' })), null);
    assert.deepStrictEqual(parseCursor(JSON.stringify({ t: '2026-10-26T09:00:00Z', ids: ['a', 3] })), { t: '2026-10-26T09:00:00Z', ids: ['a'] });
});
