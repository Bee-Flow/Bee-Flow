/**
 * drive_list_recent: files modified since a date, newest first, capped. The
 * Drive client is injected, so no network and no module stub.
 *
 * Run: cd server && node --test integrations/driveTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { DRIVE_TOOLS, isDriveTool, listRecentDriveFiles } = require('./driveTools');

const NOW = Date.parse('2026-10-01T12:00:00Z');

function fakeDrive(pages) {
    const calls = [];
    return {
        calls,
        drive: { files: { list: async (params) => { calls.push(params); return { data: pages[calls.length - 1] || { files: [] } }; } } },
    };
}

const f = (id, extra = {}) => ({
    id, name: `${id}.pdf`, mimeType: 'application/pdf',
    modifiedTime: '2026-09-30T10:00:00Z', createdTime: '2026-09-01T10:00:00Z',
    parents: ['FOLDER1'], ownedByMe: true, lastModifyingUser: { me: true, displayName: 'X', emailAddress: 'x@example.com' },
    ...extra,
});

test('queries files modified since, never folders or trash, and maps no person data', async () => {
    const { calls, drive } = fakeDrive([{ files: [f('a'), f('b', { parents: undefined, lastModifyingUser: { me: false } })] }]);
    const out = await listRecentDriveFiles(drive, { since: '2026-09-15' }, { now: NOW });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].q, "modifiedTime >= '2026-09-15T00:00:00.000Z' and trashed = false and mimeType != 'application/vnd.google-apps.folder'");
    assert.strictEqual(calls[0].orderBy, 'modifiedTime desc');
    assert.strictEqual(calls[0].pageSize, 50);
    assert.deepStrictEqual(out.results[0], {
        id: 'a', name: 'a.pdf', mimeType: 'application/pdf', parentId: 'FOLDER1',
        modifiedTime: '2026-09-30T10:00:00Z', createdTime: '2026-09-01T10:00:00Z', ownedByMe: true, modifiedByMe: true,
    });
    assert.strictEqual(out.results[1].parentId, null);
    assert.strictEqual(out.results[1].modifiedByMe, false);
    assert.ok(!JSON.stringify(out).includes('x@example.com'));
    assert.strictEqual(out.hasMore, false);
});

test('defaults to 30 days and pages up to the 200 cap', async () => {
    const page = (n, token) => ({ files: Array.from({ length: n }, (_, i) => f(`x${i}`)), nextPageToken: token });
    const { calls, drive } = fakeDrive([page(100, 't2'), page(100, 't3'), page(100, 't4')]);
    const out = await listRecentDriveFiles(drive, { maxResults: 5000 }, { now: NOW });
    assert.match(calls[0].q, /modifiedTime >= '2026-09-01T12:00:00.000Z'/);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].pageToken, 't2');
    assert.strictEqual(out.resultCount, 200);
    assert.strictEqual(out.hasMore, true);
});

test('an unparseable since is refused before any Drive call', async () => {
    const { calls, drive } = fakeDrive([]);
    await assert.rejects(listRecentDriveFiles(drive, { since: 'soon' }), /since must be an ISO/);
    assert.strictEqual(calls.length, 0);
});

test('the tool is defined and routed', () => {
    assert.ok(DRIVE_TOOLS.some(t => t.function.name === 'drive_list_recent'));
    assert.strictEqual(isDriveTool('drive_list_recent'), true);
});
