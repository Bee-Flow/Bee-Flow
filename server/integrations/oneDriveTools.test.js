/**
 * onedrive_list_recent: files modified since a date, from the delta feed with
 * a timestamp token, falling back to the drive's recent view. The Graph GET
 * is injected, so no network and no module stub.
 *
 * Run: cd server && node --test integrations/oneDriveTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { ONEDRIVE_TOOLS, isOneDriveTool, listRecentDriveItems } = require('./oneDriveTools');

const NOW = Date.parse('2026-10-01T12:00:00Z');

const file = (id, modified, extra = {}) => ({
    id,
    name: `${id}.xlsx`,
    file: { mimeType: 'application/vnd.ms-excel' },
    lastModifiedDateTime: modified,
    createdDateTime: '2026-01-01T00:00:00Z',
    parentReference: { id: 'P1', driveId: 'D1' },
    ...extra,
});

function fakeGraph(handler) {
    const calls = [];
    return { calls, fetchPage: async (path) => { calls.push(path); return handler(path, calls.length); } };
}

test('delta with a timestamp token: files only, filtered, newest first, no content', async () => {
    const g = fakeGraph((path, n) => {
        if (n === 1) {
            return {
                value: [
                    { id: 'root', name: 'root', folder: { childCount: 3 } },
                    file('old', '2026-08-01T00:00:00Z'),
                    file('a', '2026-09-20T08:00:00Z'),
                    file('gone', '2026-09-25T00:00:00Z', { deleted: { state: 'deleted' } }),
                ],
                '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x2',
            };
        }
        return { value: [file('b', '2026-09-28T08:00:00Z', { parentReference: { id: 'P2', path: '/drive/root:/Invoices/2026' } })] };
    });
    const out = await listRecentDriveItems({ since: '2026-09-01' }, g.fetchPage, { now: NOW });
    assert.match(g.calls[0], /^\/me\/drive\/root\/delta\?token=2026-09-01T00%3A00%3A00.000Z&\$select=/);
    assert.strictEqual(g.calls[1], 'https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x2');
    assert.strictEqual(out.source, 'delta');
    assert.deepStrictEqual(out.items.map(i => i.id), ['b', 'a']);
    assert.deepStrictEqual(out.items[0], {
        id: 'b', name: 'b.xlsx', mimeType: 'application/vnd.ms-excel', parentId: 'P2',
        parentPath: '/Invoices/2026', lastModified: '2026-09-28T08:00:00Z', created: '2026-01-01T00:00:00Z',
    });
    assert.strictEqual(out.items[1].parentPath, null, 'delta has no path');
    assert.strictEqual(out.hasMore, false);
});

test('a refused delta token falls back to the recent view, filtered here', async () => {
    const g = fakeGraph((path) => {
        if (path.includes('/delta')) throw new Error('Microsoft Graph API error: 400');
        return { value: [file('a', '2026-09-30T00:00:00Z'), file('old', '2026-01-01T00:00:00Z')] };
    });
    const out = await listRecentDriveItems({}, g.fetchPage, { now: NOW });
    assert.strictEqual(out.source, 'recent');
    assert.strictEqual(out.since, '2026-09-01T12:00:00.000Z', 'default window is 30 days');
    assert.deepStrictEqual(out.items.map(i => i.id), ['a']);
});

test('maxResults caps at 200, page cap and foreign nextLinks stop paging', async () => {
    const many = Array.from({ length: 150 }, (_, i) => file(`f${i}`, `2026-09-${String(10 + (i % 18)).padStart(2, '0')}T00:00:00Z`));
    const g = fakeGraph(() => ({ value: many, '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' }));
    const out = await listRecentDriveItems({ since: '2026-09-01', maxResults: 9999 }, g.fetchPage, { now: NOW });
    assert.strictEqual(g.calls.length, 5, 'stops at the page cap');
    assert.strictEqual(out.items.length, 200);
    assert.strictEqual(out.hasMore, true);

    const evil = fakeGraph(() => ({ value: [file('a', '2026-09-30T00:00:00Z')], '@odata.nextLink': 'https://evil.example.com/x' }));
    const one = await listRecentDriveItems({ since: '2026-09-01' }, evil.fetchPage, { now: NOW });
    assert.strictEqual(evil.calls.length, 1);
    assert.strictEqual(one.hasMore, false);
});

test('an unparseable since is refused before any Graph call', async () => {
    const g = fakeGraph(() => ({ value: [] }));
    await assert.rejects(listRecentDriveItems({ since: 'yesterday' }, g.fetchPage), /since must be an ISO/);
    assert.strictEqual(g.calls.length, 0);
});

test('each item says whether the user made the last change, and never who did', async () => {
    const mine = file('mine', '2026-09-29T00:00:00Z', { lastModifiedBy: { user: { id: 'AAD-ME', displayName: 'Me', email: 'me@example.org' } } });
    const theirs = file('theirs', '2026-09-30T00:00:00Z', { lastModifiedBy: { user: { id: 'aad-colleague', displayName: 'Pieter Bakker', email: 'pieter@example.org' } } });
    const g = fakeGraph((path) => (path.startsWith('/me?') ? { id: 'aad-me' } : { value: [mine, theirs] }));
    const out = await listRecentDriveItems({ since: '2026-09-01' }, g.fetchPage, { now: NOW });
    assert.ok(g.calls.includes('/me?$select=id'));
    assert.deepStrictEqual(out.items.map(i => [i.id, i.modifiedByMe]), [['theirs', false], ['mine', true]]);
    assert.doesNotMatch(JSON.stringify(out), /Pieter|pieter@|aad-colleague/);

    // Without a /me answer nothing is claimed either way.
    const down = fakeGraph((path) => { if (path.startsWith('/me?')) throw new Error('403'); return { value: [theirs] }; });
    const unknown = await listRecentDriveItems({ since: '2026-09-01' }, down.fetchPage, { now: NOW });
    assert.ok(!('modifiedByMe' in unknown.items[0]));
});

test('the tool is defined and routed', () => {
    assert.ok(ONEDRIVE_TOOLS.some(t => t.function.name === 'onedrive_list_recent'));
    assert.strictEqual(isOneDriveTool('onedrive_list_recent'), true);
});
