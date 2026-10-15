/**
 * officeFileDelivery — where a chat-built .docx / .xlsx goes. Pinned here: the
 * OneDrive destination (the Graph PUT, rename on conflict, the deep link, the
 * card), its refusals falling back to a download link with the reason, a path
 * that would climb out, and the dispatcher entry running the Nextcloud scope
 * guard of the matching nextcloud_create_* tool. Builders and the Nextcloud
 * leg have their own tests (wordDocumentTools / spreadsheetTools).
 *
 * DB-free: storage, Graph and the scope guard are stubbed.
 *
 * Run: node --test integrations/officeFileDelivery.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../testUtils/stubRequire');

const uploads = [];
const storage = {
    isAvailable: () => true,
    buildKey: (userId, category, filename) => `users/${userId}/${category}/${filename}`,
    buildProxyUrl: (key) => `/api/storage/file/${key}`,
    uploadFile: async (key, buffer, contentType) => { uploads.push({ key, buffer, contentType }); },
};

const graphCalls = [];
const graph = { status: 201, body: null, throws: null };
const msGraph = {
    isMicrosoftConnected: (session) => !!(session?.accessToken && session?.oauthProvider === 'microsoft'),
    graphRequest: async (path, session, options) => {
        graphCalls.push({ path, options });
        if (graph.throws) throw new Error(graph.throws);
        const body = graph.body || { id: 'ITEM1', name: path.split(':/')[1].split('/').pop().split(':')[0], webUrl: 'https://contoso-my.sharepoint.com/x' };
        return { ok: graph.status < 300, status: graph.status, json: async () => body, text: async () => JSON.stringify(body) };
    },
};

const guardCalls = [];
const ncScopeGuard = {
    checkToolCall: async (call) => { guardCalls.push(call); return call.toolArgs.path.startsWith('/Private') ? { error: 'outside the allowed folders' } : null; },
};

installResolveStub({
    '../stores/storageStore': storage,
    './msGraphClient': msGraph,
    '../core/integrations/ncScopeGuard': ncScopeGuard,
});

const { executeOfficeFileTool, buildAndDeliver, destinationPath, officeFileToolDefinitions } = require('./officeFileDelivery');

const MS = { accessToken: 't', oauthProvider: 'microsoft' };
const SHEET = { title: 'Klanten', sheets: [{ rows: [{ Naam: 'A', Bedrag: 1 }] }] };

function reset() { uploads.length = 0; graphCalls.length = 0; guardCalls.length = 0; graph.status = 201; graph.body = null; graph.throws = null; }

test('destinationPath: a folder gets the file name, a matching extension is the file, anything else is nothing', () => {
    assert.strictEqual(destinationPath('/Documents/', 'xlsx', 'a.xlsx'), '/Documents/a.xlsx');
    assert.strictEqual(destinationPath('/D/mine.XLSX', 'xlsx', 'a.xlsx'), '/D/mine.XLSX');
    assert.strictEqual(destinationPath('/D/mine.docx', 'xlsx', 'a.xlsx'), '/D/mine.docx/a.xlsx');
    assert.strictEqual(destinationPath(true, 'xlsx', 'a.xlsx'), '');
    assert.strictEqual(destinationPath('  ', 'xlsx', 'a.xlsx'), '');
});

test('oneDrivePath: one Graph PUT into the user\'s drive, rename on conflict, the OneDrive link and card', async () => {
    reset();
    const res = await executeOfficeFileTool('create_spreadsheet', { ...SHEET, oneDrivePath: '/Rapporten 2026' }, { userId: 'u1', session: MS });
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(graphCalls.length, 1);
    assert.strictEqual(graphCalls[0].path, '/me/drive/root:/Rapporten%202026/Klanten.xlsx:/content?@microsoft.graph.conflictBehavior=rename');
    assert.strictEqual(graphCalls[0].options.method, 'PUT');
    assert.strictEqual(graphCalls[0].options.body.subarray(0, 2).toString('latin1'), 'PK');
    assert.strictEqual(uploads.length, 0, 'nothing kept in storage');
    assert.strictEqual(res.onedrive, true);
    assert.strictEqual(res.path, '/Rapporten 2026/Klanten.xlsx');
    assert.strictEqual(res.webUrl, 'https://contoso-my.sharepoint.com/x');
    assert.strictEqual(res.file.kind, 'spreadsheet');
    assert.strictEqual(res.file.webUrl, res.webUrl);
    assert.ok(res.message.includes('[Open in OneDrive](https://contoso-my.sharepoint.com/x)'));
    assert.deepStrictEqual(guardCalls, [], 'no Nextcloud guard without nextcloudPath');
});

test('OneDrive not connected, refused or unreachable: a download link with the reason', async () => {
    for (const [ctx, setup, reason] of [
        [{ userId: 'u1', session: {} }, () => {}, /OneDrive \(OneDrive is not connected/],
        [{ userId: 'u1', session: MS }, () => { graph.status = 403; graph.body = { error: { message: 'You do not have a valid license' } }; }, /OneDrive \(OneDrive refused the upload \(403: You do not have a valid license\)\)/],
        [{ userId: 'u1', session: MS }, () => { graph.throws = 'fetch failed'; }, /OneDrive \(OneDrive upload failed\)/],
    ]) {
        reset();
        setup();
        const res = await buildAndDeliver('create_spreadsheet', SHEET, { ...ctx, oneDrivePath: '/Documents/k.xlsx' });
        assert.strictEqual(res.success, true, JSON.stringify(res));
        assert.match(res.downloadUrl, /^\/api\/storage\/file\/users\/u1\/documents\//);
        assert.strictEqual(uploads.length, 1);
        assert.match(res.message, reason);
        assert.match(res.message, /could NOT be saved/);
    }
});

test('a OneDrive path that climbs out is refused before Graph is called', async () => {
    reset();
    const res = await buildAndDeliver('create_spreadsheet', SHEET, { userId: 'u1', session: MS, oneDrivePath: '/Documents/../../x.xlsx' });
    assert.strictEqual(graphCalls.length, 0);
    assert.match(res.message, /Not a usable OneDrive path/);
    assert.ok(res.downloadUrl);
});

test('nextcloudPath runs the scope guard of the matching nextcloud_create_* tool; a refusal keeps the file', async () => {
    reset();
    const res = await executeOfficeFileTool('create_spreadsheet', { ...SHEET, nextcloudPath: '/Private' }, { userId: 'u1', orgId: 'o1' });
    assert.deepStrictEqual(guardCalls, [{ toolName: 'nextcloud_create_spreadsheet', toolArgs: { path: '/Private/Klanten.xlsx' }, userId: 'u1', orgId: 'o1' }]);
    assert.deepStrictEqual(res.nextcloud, { error: 'outside the allowed folders' });
    assert.ok(res.downloadUrl);
});

test('no destination: a download link, and an unknown tool is refused', async () => {
    reset();
    const res = await executeOfficeFileTool('create_spreadsheet', SHEET, { userId: 'u1' });
    assert.ok(res.message.includes(`[Klanten.xlsx](${res.downloadUrl})`));
    assert.strictEqual(res.sheets, 1);
    assert.match((await executeOfficeFileTool('create_pdf', {}, { userId: 'u1' })).error, /Unknown file tool/);
});

test('the definitions offer oneDrivePath only while the OneDrive app is on', () => {
    const names = (defs) => defs.map((d) => d.function.name);
    assert.deepStrictEqual(names(officeFileToolDefinitions()), ['create_presentation', 'create_word_document', 'create_spreadsheet']);
    for (const d of officeFileToolDefinitions()) assert.ok(d.function.parameters.properties.oneDrivePath, d.function.name);
    for (const d of officeFileToolDefinitions({ oneDrive: false })) {
        assert.strictEqual(d.function.parameters.properties.oneDrivePath, undefined, d.function.name);
        assert.ok(d.function.parameters.properties.nextcloudPath, 'the rest stays');
    }
    assert.ok(officeFileToolDefinitions()[0].function.parameters.properties.oneDrivePath, 'the shared definition is not mutated');
});
