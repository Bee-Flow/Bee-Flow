/**
 * The "documents" mode of the three storages (providers/documents.js): what a
 * knowledge-base folder source lists and reads, against the same kind of
 * recording fakes the per-provider tests use.
 *
 * What it pins: every provider keeps folders plus the files the text extractor
 * reads (and drops the rest), a file carries its change `marker`, the default
 * mode still lists spreadsheets only, a native Google Doc is EXPORTED to docx
 * (and never downloaded as media), and each provider's `changeCursor` answers
 * "changed" for a first look or a moved cursor and "unchanged" only on a
 * cursor that has not moved.
 *
 * (The Nextcloud half is in nextcloudFiles.test.js, which has the WebDAV fake.)
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/providers/documentsMode.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const documents = require('./documents');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const calls = { drive: [], graph: [] };
const world = { driveFiles: [], changes: [], startToken: 't-start', graphRoutes: [] };

// ─── Google Drive ───────────────────────────────────────────────────────
const fakeDrive = {
    files: {
        list: async (req) => { calls.drive.push({ verb: 'list', req }); return { data: { files: world.driveFiles, nextPageToken: null } }; },
        get: async (req, opts) => {
            calls.drive.push({ verb: 'get', req, opts });
            if (req.alt === 'media') return { data: Buffer.from('MEDIA') };
            const f = world.driveFiles.find((x) => x.id === req.fileId);
            return { data: { ...f, version: f.version || '3' } };
        },
        export: async (req, opts) => { calls.drive.push({ verb: 'export', req, opts }); return { data: Buffer.from('EXPORT') }; },
    },
    changes: {
        getStartPageToken: async (req) => { calls.drive.push({ verb: 'start', req }); return { data: { startPageToken: world.startToken } }; },
        list: async (req) => { calls.drive.push({ verb: 'changes', req }); return { data: { changes: world.changes, newStartPageToken: 't-next' } }; },
    },
};

// ─── Microsoft Graph ────────────────────────────────────────────────────
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fakeGraph = {
    GRAPH_BASE,
    graphRequest: async (path, session, options = {}) => {
        calls.graph.push({ path, method: options.method || 'GET' });
        for (const r of world.graphRoutes) {
            if (typeof r.match === 'string' ? path.startsWith(r.match) : r.match.test(path)) return r.handler(path);
        }
        return json({ error: { code: 'itemNotFound', message: `no route ${path}` } }, 404);
    },
};

require('../../../../integrations/integrationClients').registerIntegrationClients({
    google: () => ({ createGoogleApiClient: async () => ({ drive: fakeDrive }) }),
    msGraph: () => fakeGraph,
});
const googleDrive = require('./googleDrive');
const oneDrive = require('./oneDrive');

test.beforeEach(() => {
    calls.drive.length = 0; calls.graph.length = 0;
    Object.assign(world, { driveFiles: [], changes: [], startToken: 't-start', graphRoutes: [] });
});

// ─── documents.js ───────────────────────────────────────────────────────

test('documentFormatOf: what the extractor reads, by extension first, then by type; native Google files by their type', () => {
    const f = (name, mimeType) => documents.documentFormatOf({ name, mimeType });
    assert.equal(f('Plan.PDF', 'application/octet-stream'), 'pdf');
    assert.equal(f('Notes.md', 'text/plain'), 'md');
    assert.equal(f('notes.markdown'), 'md');
    assert.equal(f('Brief.docx'), 'docx');
    assert.equal(f('Deck.pptx'), 'pptx');
    assert.equal(f('data.csv', 'text/plain'), 'csv');
    assert.equal(f('README', 'text/plain'), 'txt', 'no extension: the type decides');
    assert.equal(f('Budget', 'application/vnd.google-apps.spreadsheet'), 'gsheet');
    assert.equal(f('Memo', 'application/vnd.google-apps.document'), 'gdoc');
    assert.equal(f('Pitch', 'application/vnd.google-apps.presentation'), 'gslides');
    assert.equal(f('photo.png', 'image/png'), null);
    assert.equal(f('archive.zip', 'application/zip'), null);
    assert.equal(f('form', 'application/vnd.google-apps.form'), null);
    assert.equal(documents.exportFor('application/vnd.google-apps.document').mime, DOCX);
    assert.equal(documents.exportFor('application/pdf'), null);
    assert.equal(documents.mimeForFormat('md'), 'text/markdown');
    assert.equal(documents.mimeForFormat('gdoc'), DOCX);
});

// ─── Google Drive ───────────────────────────────────────────────────────

test('google: documents mode asks for document types, keeps what the extractor reads, drops shortcuts, carries the version marker', async () => {
    world.driveFiles = [
        { id: 'd1', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'p1', name: 'Plan.pdf', mimeType: 'application/pdf', size: '99', version: '12', modifiedTime: '2026-09-01T00:00:00Z' },
        { id: 'g1', name: 'Memo', mimeType: 'application/vnd.google-apps.document', version: '4' },
        { id: 'i1', name: 'logo.png', mimeType: 'image/png' },
        { id: 's1', name: 'Link', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'x', targetMimeType: 'application/pdf' } },
    ];
    const a = googleDrive.forLinker({ save: async () => {} }, { userId: 'u1', accept: 'documents' });
    const { items } = await a.list({ view: 'mine', parentId: 'root' });
    const q = calls.drive[0].req.q;
    assert.ok(q.includes("mimeType='application/pdf'") && q.includes("mimeType='application/vnd.google-apps.document'"));
    assert.ok(!q.includes('shortcut'), 'shortcuts are not asked for');
    assert.equal(calls.drive[0].req.pageSize, 200);
    assert.deepEqual(items.map((i) => [i.fileId, i.isFolder, i.format]), [['d1', true, null], ['p1', false, 'pdf'], ['g1', false, 'gdoc']]);
    assert.equal(items[1].marker.version, '12');
    assert.ok(googleDrive.markerEquals(items[1].marker, { version: 12 }));
});

test('google: the default mode is unchanged — spreadsheets, no marker on a ref', async () => {
    world.driveFiles = [
        { id: 'p1', name: 'Plan.pdf', mimeType: 'application/pdf' },
        { id: 'x1', name: 'Budget.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ];
    const { items } = await googleDrive.forLinker({ save: async () => {} }, {}).list({ view: 'mine' });
    assert.deepEqual(items.map((i) => i.fileId), ['x1']);
    assert.equal(items[0].marker, undefined);
    assert.ok(!calls.drive[0].req.q.includes("mimeType='application/pdf'"));
    assert.equal(calls.drive[0].req.pageSize, 50);
});

test('google: a native Doc is exported to docx; an uploaded file is downloaded as media', async () => {
    world.driveFiles = [
        { id: 'g1', name: 'Memo', mimeType: 'application/vnd.google-apps.document', version: '4' },
        { id: 'p1', name: 'Plan.pdf', mimeType: 'application/pdf', size: '5', version: '2' },
    ];
    const a = googleDrive.forLinker({ save: async () => {} }, { accept: 'documents' });
    const exported = await a.download({ fileId: 'g1' }, { maxBytes: 1000 });
    assert.equal(exported.buffer.toString(), 'EXPORT');
    const exp = calls.drive.find((c) => c.verb === 'export');
    assert.deepEqual(exp.req, { fileId: 'g1', mimeType: DOCX });
    assert.equal(exported.marker.version, '4');
    const media = await a.download({ fileId: 'p1' });
    assert.equal(media.buffer.toString(), 'MEDIA');
    assert.equal(calls.drive.filter((c) => c.verb === 'export').length, 1);
});

test('google: changeCursor — no cursor anchors; an untouched cursor is unchanged; a change is changed with a fresh anchor', async () => {
    const a = googleDrive.forLinker({ save: async () => {} }, { accept: 'documents' });
    assert.deepEqual(await a.changeCursor({}, null), { changed: true, cursor: 't-start' });
    assert.deepEqual(await a.changeCursor({}, 'old'), { changed: false, cursor: 't-next' });
    world.changes = [{ fileId: 'x' }];
    world.startToken = 't-fresh';
    assert.deepEqual(await a.changeCursor({ driveId: 'sd1' }, 'old'), { changed: true, cursor: 't-fresh' });
    const asked = calls.drive.filter((c) => c.verb === 'changes').pop().req;
    assert.equal(asked.driveId, 'sd1');
    assert.equal(asked.pageToken, 'old');
    assert.equal(asked.includeRemoved, true);
});

// ─── OneDrive ───────────────────────────────────────────────────────────

function item(id, name, extra = {}) {
    return { id, name, size: 10, eTag: `e-${id}`, cTag: `c-${id}`, lastModifiedDateTime: '2026-09-01T10:00:00Z', file: { mimeType: 'application/octet-stream' }, webUrl: `https://1drv/${id}`, parentReference: { driveId: 'me-drive', id: 'root-id', path: '/drive/root:/Docs' }, ...extra };
}

test('onedrive: documents mode asks for bigger pages, keeps readable files and folders, carries the cTag marker', async () => {
    world.graphRoutes = [
        { match: '/me/drive?$select=id', handler: () => json({ id: 'me-drive' }) },
        { match: /\/me\/drive\/root\/children/, handler: () => json({ value: [
            item('s1', 'Sub', { file: undefined, folder: { childCount: 1 } }),
            item('p1', 'Plan.pdf'), item('m1', 'Notes.md'), item('i1', 'logo.png'),
        ] }) },
    ];
    const a = oneDrive.forLinker({ accessToken: 'at' }, { accept: 'documents' });
    const { items } = await a.list({ view: 'mine' });
    assert.ok(calls.graph.some((c) => c.path.includes('$top=200')));
    assert.deepEqual(items.map((i) => [i.fileId, i.isFolder, i.format]), [['s1', true, null], ['p1', false, 'pdf'], ['m1', false, 'md']]);
    assert.equal(items[1].marker.cTag, 'c-p1');
    assert.ok(oneDrive.markerEquals(items[1].marker, { cTag: 'c-p1' }));
    assert.ok(!oneDrive.markerEquals(items[1].marker, { cTag: 'c-other' }));
    // And without the mode: spreadsheets only, 50 a page, no marker.
    const plain = await oneDrive.forLinker({ accessToken: 'at' }, {}).list({ view: 'mine' });
    assert.deepEqual(plain.items.map((i) => i.fileId), ['s1']);
});

test('onedrive: changeCursor — token=latest anchors; an empty delta is unchanged; items in the delta are changed; a foreign link is never followed', async () => {
    const link = `${GRAPH_BASE}/drives/me-drive/items/f1/delta?token=abc`;
    world.graphRoutes = [
        { match: '/me/drive?$select=id', handler: () => json({ id: 'me-drive' }) },
        { match: /\/delta\?token=latest$/, handler: () => json({ value: [], '@odata.deltaLink': `${GRAPH_BASE}/delta?token=NEW` }) },
        { match: `${GRAPH_BASE}/drives/me-drive/items/f1/delta?token=abc`, handler: () => json({ value: [], '@odata.deltaLink': `${GRAPH_BASE}/delta?token=same` }) },
        { match: `${GRAPH_BASE}/drives/me-drive/items/f1/delta?token=moved`, handler: () => json({ value: [{ id: 'x' }], '@odata.deltaLink': `${GRAPH_BASE}/delta?token=after` }) },
    ];
    const a = oneDrive.forLinker({ accessToken: 'at' }, { accept: 'documents' });
    const folder = { folderId: 'f1', driveId: 'me-drive' };
    assert.deepEqual(await a.changeCursor(folder, null), { changed: true, cursor: `${GRAPH_BASE}/delta?token=NEW` });
    assert.equal(calls.graph.pop().path, '/drives/me-drive/items/f1/delta?token=latest');
    assert.deepEqual(await a.changeCursor(folder, link), { changed: false, cursor: `${GRAPH_BASE}/delta?token=same` });
    assert.deepEqual(await a.changeCursor(folder, `${GRAPH_BASE}/drives/me-drive/items/f1/delta?token=moved`), { changed: true, cursor: `${GRAPH_BASE}/delta?token=after` });
    calls.graph.length = 0;
    const foreign = await a.changeCursor(folder, 'https://evil.example/delta?token=1');
    assert.equal(foreign.changed, true);
    assert.ok(calls.graph.every((c) => !c.path.startsWith('https://evil.example')), 'the bearer never goes to a non-Graph URL');
});
