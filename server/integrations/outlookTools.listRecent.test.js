/**
 * outlook_list_recent: the `since` filter and @odata.nextLink paging.
 *
 * listRecentMessages takes the Graph GET as an injected function, so these
 * tests run without a network or a module stub.
 *
 * Run: cd server && node --test integrations/outlookTools.listRecent.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { listRecentMessages, OUTLOOK_TOOLS } = require('./outlookTools');

const msg = (i, extra = {}) => ({
    id: `m${i}`,
    subject: `Subject ${i}`,
    from: { emailAddress: { name: 'A', address: 'a@example.com' } },
    toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
    receivedDateTime: '2026-09-01T10:00:00Z',
    sentDateTime: '2026-09-01T09:59:00Z',
    bodyPreview: 'preview',
    hasAttachments: false,
    isRead: true,
    ...extra,
});

function fakeGraph(pages) {
    const calls = [];
    const fetchPage = async (path) => {
        calls.push(path);
        return pages[calls.length - 1] || { value: [] };
    };
    return { calls, fetchPage };
}

test('default call is unchanged: one page, top clamped to 20, no extra keys', async () => {
    const { calls, fetchPage } = fakeGraph([
        { value: [msg(1)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/next' },
    ]);
    const out = await listRecentMessages({ maxResults: 999 }, fetchPage);
    assert.strictEqual(calls.length, 1, 'never follows nextLink without maxPages');
    assert.match(calls[0], /^\/me\/mailFolders\/inbox\/messages\?\$top=20&\$orderby=receivedDateTime desc/);
    assert.ok(!calls[0].includes('$filter'));
    assert.deepStrictEqual(Object.keys(out).sort(), ['folder', 'results', 'total']);
    assert.strictEqual(out.results[0].from, 'A <a@example.com>');
    assert.strictEqual(out.results[0].date, '2026-09-01T10:00:00Z');
});

test('unreadOnly alone still leads the filter with the sort field, as Graph requires', async () => {
    const { calls, fetchPage } = fakeGraph([{ value: [] }, { value: [] }]);
    await listRecentMessages({ unreadOnly: true }, fetchPage);
    assert.match(calls[0], /&\$filter=receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false$/);
    await listRecentMessages({ unreadOnly: true, folder: 'sentitems' }, fetchPage);
    assert.match(calls[1], /\$orderby=sentDateTime desc.*&\$filter=sentDateTime ge 1900-01-01T00:00:00Z and isRead eq false$/);
});

test('since becomes a ge filter on the folder date field, leading the filter', async () => {
    const { calls, fetchPage } = fakeGraph([{ value: [] }, { value: [] }]);
    const inbox = await listRecentMessages({ since: '2026-07-01', unreadOnly: true }, fetchPage);
    assert.match(calls[0], /&\$filter=receivedDateTime ge 2026-07-01T00:00:00\.000Z and isRead eq false$/);
    assert.strictEqual(inbox.pages, 1);
    assert.strictEqual(inbox.hasMore, false);

    await listRecentMessages({ folder: 'sentitems', since: '2026-07-01T08:00:00+02:00' }, fetchPage);
    assert.match(calls[1], /\$orderby=sentDateTime desc/);
    assert.match(calls[1], /&\$filter=sentDateTime ge 2026-07-01T06:00:00\.000Z$/);
});

test('an unparseable since is refused before any Graph call', async () => {
    const { calls, fetchPage } = fakeGraph([]);
    await assert.rejects(listRecentMessages({ since: 'last tuesday' }, fetchPage), /since must be an ISO date/);
    assert.strictEqual(calls.length, 0);
});

test('maxPages follows nextLink up to maxResults (cap 200) and reports hasMore', async () => {
    const page = (from, n, next) => ({
        value: Array.from({ length: n }, (_, i) => msg(from + i)),
        ...(next ? { '@odata.nextLink': next } : {}),
    });
    const { calls, fetchPage } = fakeGraph([
        page(0, 50, 'https://graph.microsoft.com/v1.0/me/p2'),
        page(50, 50, 'https://graph.microsoft.com/v1.0/me/p3'),
        page(100, 50, 'https://graph.microsoft.com/v1.0/me/p4'),
    ]);
    const out = await listRecentMessages({ maxResults: 120, maxPages: 5 }, fetchPage);
    assert.match(calls[0], /\$top=50&/, 'paged mode asks for 50 per page');
    assert.deepStrictEqual(calls.slice(1), ['https://graph.microsoft.com/v1.0/me/p2', 'https://graph.microsoft.com/v1.0/me/p3']);
    assert.strictEqual(out.total, 120);
    assert.strictEqual(out.pages, 3);
    assert.strictEqual(out.hasMore, true);

    const capped = fakeGraph(Array.from({ length: 10 }, (_, i) => page(i * 50, 50, `https://graph.microsoft.com/v1.0/me/p${i + 2}`)));
    const big = await listRecentMessages({ maxResults: 5000, maxPages: 99 }, capped.fetchPage);
    assert.strictEqual(big.total, 200, 'maxResults is capped at 200');
    assert.strictEqual(capped.calls.length, 4);
});

test('the page cap stops paging even when Graph has more', async () => {
    const { calls, fetchPage } = fakeGraph([
        { value: [msg(1)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/p2' },
        { value: [msg(2)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/p3' },
    ]);
    const out = await listRecentMessages({ maxResults: 200, maxPages: 2 }, fetchPage);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(out.total, 2);
    assert.strictEqual(out.hasMore, true);
});

test('a nextLink off the Graph host is not followed', async () => {
    const { calls, fetchPage } = fakeGraph([
        { value: [msg(1)], '@odata.nextLink': 'https://evil.example.com/steal' },
    ]);
    const out = await listRecentMessages({ maxResults: 100, maxPages: 3 }, fetchPage);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(out.hasMore, false);
});

test('a path-like folder is refused', async () => {
    const { calls, fetchPage } = fakeGraph([]);
    await assert.rejects(listRecentMessages({ folder: '../../users/x/mailFolders/inbox' }, fetchPage), /folder is a mail folder name/);
    assert.strictEqual(calls.length, 0);
});

test('the tool definition declares since and maxPages', () => {
    const def = OUTLOOK_TOOLS.find(t => t.function.name === 'outlook_list_recent');
    assert.strictEqual(def.function.parameters.properties.since.type, 'string');
    assert.strictEqual(def.function.parameters.properties.maxPages.type, 'integer');
    assert.deepStrictEqual(def.function.parameters.required, []);
});
