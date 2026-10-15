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

// ── executeDriveTool: one pinned case per tool (the Drive client is injected through googleClient) ──
const googleClient = require('./googleClient');
const { executeDriveTool } = require('./driveTools');

async function withDrive(drive, fn) {
    const orig = googleClient.createGoogleApiClient;
    googleClient.createGoogleApiClient = async () => drive;
    try { return await fn(); } finally { googleClient.createGoogleApiClient = orig; }
}
const rec = (impl = {}) => {
    const calls = [];
    const wrap = (name, ret) => async (p, o) => { calls.push([name, p, o]); return typeof ret === 'function' ? ret(p) : ret; };
    return {
        calls,
        drive: { files: {
            list: wrap('list', { data: { files: [{ id: 'f1', name: 'A', mimeType: 'text/plain' }] } }),
            get: wrap('get', { data: { id: 'f1', name: 'A', mimeType: 'text/plain', parents: ['P'] } }),
            update: wrap('update', { data: { id: 'f1', name: 'A', parents: ['Q'], webViewLink: 'L' } }),
            create: wrap('create', { data: { id: 'n1', name: 'New', webViewLink: 'L' } }),
            export: wrap('export', { data: 'exported' }),
            ...impl,
        } },
    };
};

test('drive_search wraps a plain term in a name query and leaves operators alone', async () => {
    const a = rec();
    const out = await withDrive(a.drive, () => executeDriveTool('drive_search', { query: `"it's"`, maxResults: 999 }, {}));
    assert.strictEqual(a.calls[0][1].q, "name contains 'it\\'s'");
    assert.strictEqual(a.calls[0][1].pageSize, 50);
    assert.strictEqual(out.query, `"it's"`);
    assert.strictEqual(out.resultCount, 1);
    assert.strictEqual(out.results[0].id, 'f1');
    const b = rec();
    await withDrive(b.drive, () => executeDriveTool('drive_search', { query: "name contains 'x'" }, {}));
    assert.strictEqual(b.calls[0][1].q, "name contains 'x'");
    assert.strictEqual(b.calls[0][1].pageSize, 20);
});

test('drive_list_files scopes to a folder or to non-trashed files', async () => {
    const a = rec();
    const out = await withDrive(a.drive, () => executeDriveTool('drive_list_files', { folderId: 'F' }, {}));
    assert.strictEqual(a.calls[0][1].q, "'F' in parents and trashed = false");
    assert.strictEqual(out.folderId, 'F');
    const b = rec();
    const out2 = await withDrive(b.drive, () => executeDriveTool('drive_list_files', {}, {}));
    assert.strictEqual(b.calls[0][1].q, 'trashed = false');
    assert.strictEqual(out2.folderId, 'recent');
});

test('drive_list_recent goes through listRecentDriveFiles', async () => {
    const a = rec();
    const out = await withDrive(a.drive, () => executeDriveTool('drive_list_recent', { since: '2026-09-15' }, {}));
    assert.match(a.calls[0][1].q, /^modifiedTime >= '2026-09-15T00:00:00.000Z' and trashed = false/);
    assert.ok(Array.isArray(out.results));
});

test('drive_get_file adds permission detail and the description', async () => {
    const a = rec({ get: async () => ({ data: { id: 'f1', name: 'A', mimeType: 'x', description: 'D', permissions: [{ role: 'writer', type: 'user', emailAddress: 'a@b.c', displayName: 'Ann', id: 'drop' }] } }) });
    const out = await withDrive(a.drive, () => executeDriveTool('drive_get_file', { fileId: 'f1' }, {}));
    assert.deepStrictEqual(out.permissions, [{ role: 'writer', type: 'user', email: 'a@b.c', displayName: 'Ann' }]);
    assert.strictEqual(out.description, 'D');
    assert.strictEqual(out.id, 'f1');
});

test('drive_move_file removes the previous parents', async () => {
    const a = rec({ get: async () => ({ data: { parents: ['P1', 'P2'] } }) });
    const out = await withDrive(a.drive, () => executeDriveTool('drive_move_file', { fileId: 'f1', destinationFolderId: 'D' }, {}));
    assert.deepStrictEqual(out, { success: true, file: 'A', movedTo: 'D' });
    assert.strictEqual(a.calls[0][1].removeParents, 'P1,P2');
    assert.strictEqual(a.calls[0][1].addParents, 'D');
});

test('drive_create_folder', async () => {
    const a = rec();
    const out = await withDrive(a.drive, () => executeDriveTool('drive_create_folder', { name: 'New', parentFolderId: 'P' }, {}));
    assert.deepStrictEqual(out, { success: true, folderId: 'n1', name: 'New', link: 'L' });
    assert.deepStrictEqual(a.calls[0][1].requestBody, { name: 'New', mimeType: 'application/vnd.google-apps.folder', parents: ['P'] });
});

test('drive_upload_file: argument checks, inline content, overwrite in place', async () => {
    const run = (args, drive = rec().drive, extra) => withDrive(drive, () => executeDriveTool('drive_upload_file', args, {}, extra));
    assert.deepStrictEqual(await run({}), { error: 'name is required' });
    assert.deepStrictEqual(await run({ name: 'a', content: 'x', sourceHandle: {} }), { error: 'Pass either sourceHandle or content, not both.' });
    assert.deepStrictEqual(await run({ name: 'a' }), { error: 'Either sourceHandle (preferred for binary) or content (for inline text) is required.' });
    assert.deepStrictEqual(await run({ name: 'a', sourceHandle: { kind: 'zip' } }), { error: 'Unsupported sourceHandle.kind: zip' });
    const a = rec();
    const out = await run({ name: 'n.txt', content: 'aGk=', isBase64: true, parentFolderId: 'P' }, a.drive);
    assert.strictEqual(out.bytesUploaded, 2);
    assert.strictEqual(out.updated, false);
    assert.strictEqual(out.mimeType, 'text/plain');
    assert.strictEqual(a.calls[0][0], 'create');
    const b = rec({ list: async () => ({ data: { files: [{ id: 'old' }] } }) });
    const upd = await run({ name: "o'x.txt", content: 'z', overwriteIfExists: true, parentFolderId: 'P' }, b.drive);
    assert.strictEqual(upd.updated, true);
    assert.strictEqual(b.calls[0][0], 'update');
});

test('drive_get_content: google doc, text file, unsupported type, truncation', async () => {
    const run = (args, drive) => withDrive(drive, () => executeDriveTool('drive_get_content', args, {}));
    assert.deepStrictEqual(await run({}, rec().drive), { error: 'fileId is required' });
    const doc = rec({ get: async () => ({ data: { id: 'f1', name: 'D', mimeType: 'application/vnd.google-apps.document' } }) });
    assert.deepStrictEqual(await run({ fileId: 'f1' }, doc.drive), { fileId: 'f1', fileName: 'D', mimeType: 'application/vnd.google-apps.document', content: 'exported', charCount: 8, truncated: false });
    assert.strictEqual(doc.calls[0][1].mimeType, 'text/plain');
    const sheet = rec({ get: async () => ({ data: { name: 'S', mimeType: 'application/vnd.google-apps.spreadsheet' } }) });
    await run({ fileId: 'f1' }, sheet.drive);
    assert.strictEqual(sheet.calls[0][1].mimeType, 'text/csv');
    const txt = rec({ get: async (p) => ({ data: p.alt === 'media' ? 'y'.repeat(80010) : { name: 'T', mimeType: 'text/plain' } }) });
    const out = await run({ fileId: 'f1' }, txt.drive);
    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.charCount, 80010);
    assert.ok(out.content.endsWith('\n\n[... truncated, file too large ...]'));
    const bin = rec({ get: async () => ({ data: { name: 'B', mimeType: 'image/png' } }) });
    assert.deepStrictEqual(await run({ fileId: 'f1' }, bin.drive), { error: 'Cannot read content of image/png files. Supported: Google Docs, Sheets, Slides, PDF, and text files.', fileName: 'B', mimeType: 'image/png' });
});

test('executeDriveTool refuses an unknown tool, including inherited names', async () => {
    const a = rec();
    assert.deepStrictEqual(await withDrive(a.drive, () => executeDriveTool('drive_nope', {}, {})), { error: 'Unknown drive tool: drive_nope' });
    assert.deepStrictEqual(await withDrive(a.drive, () => executeDriveTool('toString', {}, {})), { error: 'Unknown drive tool: toString' });
});
