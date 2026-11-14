// @typecheck
/**
 * Each Nextcloud file family dispatches by tool name: a name of another family
 * answers undefined (the facade in nextcloudTools.js then asks the next one),
 * and two tools per family keep their requests and answers.
 *
 * Run: cd server && node --test integrations/nextcloudFiles/dispatch.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../../testUtils/routeHarness').recordDb();
const { executeShareTool } = require('./sharing');
const { executeFileOperationTool } = require('./fileOperations');
const { executeOfficeDocumentTool } = require('./officeDocuments');
const { executeTagTool } = require('./tags');

const BASE = 'https://nc.example.test';

/**
 * A files-tool context whose fetch answers `answer(url, init)` and records each call.
 * @param {(url: string, init: { method?: string, body?: string }) => { status: number, body?: unknown, headers?: Record<string, string> }} answer
 */
function fakeNextcloud(answer) {
    /** @type {{ url: string, method: string, body?: string }[]} */
    const calls = [];
    /** @param {string} url @param {{ method?: string, body?: string }} [init] */
    const ncFetch = async (url, init = {}) => {
        calls.push({ url, method: init.method || 'GET', body: init.body });
        const { status, body = '', headers = {} } = answer(url, init);
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => text, json: async () => JSON.parse(text) };
    };
    const ctx = /** @type {any} */ ({ ncFetch, authError: 'AUTH', root: `${BASE}/remote.php/dav/files/alice`, baseUrl: BASE, uid: 'alice', session: {} });
    return { calls, ctx };
}

test('sharing: another family\'s name is not answered', async () => {
    const { ctx, calls } = fakeNextcloud(() => ({ status: 200 }));
    assert.strictEqual(await executeShareTool('nextcloud_list_files', {}, ctx), undefined);
    assert.strictEqual(calls.length, 0);
});

test('sharing: share_with_group posts share type 1, update_share puts one field per request, delete 404 names the share', async () => {
    const share = { ocs: { meta: { statuscode: 200 }, data: { id: '7', permissions: 17 } } };
    const { ctx, calls } = fakeNextcloud((_url, init) => (init.method === 'DELETE' ? { status: 404 } : { status: 200, body: share }));
    const shared = await executeShareTool('nextcloud_share_with_group', { path: '/a', shareWith: 'staff', note: 'n' }, ctx);
    assert.deepStrictEqual(shared, { success: true, id: 7, shareId: 7, shareType: 1, shareWith: 'staff', path: '/a', permissions: 17, expiration: null });
    assert.strictEqual(calls[0].body, 'path=%2Fa&shareType=1&shareWith=staff&note=n');
    assert.deepStrictEqual(await executeShareTool('nextcloud_update_share', { shareId: '7', permissions: 1, note: 'x' }, ctx), { success: true, shareId: 7 });
    assert.deepStrictEqual(calls.slice(1).map((c) => [c.method, c.body]), [['PUT', 'permissions=1'], ['PUT', 'note=x']]);
    assert.deepStrictEqual(await executeShareTool('nextcloud_delete_share', { shareId: '7' }, ctx), { error: 'Share not found: 7' });
    assert.deepStrictEqual(await executeShareTool('nextcloud_share_by_email', { path: '/a' }, ctx), { error: 'path and shareWith are required' });
});

test('file operations: another family\'s name is not answered; create_folder, copy and folder_tree keep their answers', async () => {
    const { ctx, calls } = fakeNextcloud((url, init) => {
        if (init.method === 'MKCOL') return { status: 405 };
        if (init.method === 'COPY') return { status: 204 };
        return url.includes('depth=1') ? { status: 200, body: [] } : { status: 404 };
    });
    assert.strictEqual(await executeFileOperationTool('nextcloud_create_share', {}, ctx), undefined);
    assert.deepStrictEqual(await executeFileOperationTool('nextcloud_create_folder', { path: '/A' }, ctx), { error: 'Folder already exists: /A' });
    assert.deepStrictEqual(await executeFileOperationTool('nextcloud_copy', { source: '/a', destination: '/b' }, ctx),
        { success: true, operation: 'copy', source: '/a', destination: '/b', overwritten: true });
    assert.deepStrictEqual(await executeFileOperationTool('nextcloud_folder_tree', { path: '/Gone' }, ctx), { error: 'Folder not found: /Gone' });
    assert.deepStrictEqual(calls.map((c) => c.method), ['MKCOL', 'COPY', 'GET', 'GET']);
});

test('office documents: another family\'s name is not answered, and the argument checks answer before any request', async () => {
    const { ctx, calls } = fakeNextcloud(() => ({ status: 200 }));
    assert.strictEqual(await executeOfficeDocumentTool('nextcloud_list_files', {}, ctx), undefined);
    assert.deepStrictEqual(await executeOfficeDocumentTool('nextcloud_create_document', { path: '/a.docx' }, ctx), { error: 'content is required' });
    assert.deepStrictEqual(await executeOfficeDocumentTool('nextcloud_create_spreadsheet', { path: '/a.xlsx', rows: [[1]], ifExists: 'merge' }, ctx),
        { error: 'ifExists must be "overwrite" or "append"' });
    assert.match((await executeOfficeDocumentTool('nextcloud_create_presentation', { path: '/d' }, ctx)).error, /^Give the deck as `slides`/);
    assert.strictEqual(calls.length, 0);
});

test('tags: another family\'s name is not answered; create_tag reads its id, tag_file and untag_file name their failures', async () => {
    const { ctx, calls } = fakeNextcloud((_url, init) => {
        if (init.method === 'POST') return { status: 201, headers: { 'content-location': '/remote.php/dav/systemtags/42' } };
        return { status: init.method === 'PUT' ? 409 : 404 };
    });
    assert.strictEqual(await executeTagTool('nextcloud_list_files', {}, ctx), undefined);
    assert.deepStrictEqual(await executeTagTool('nextcloud_create_tag', { name: 'x' }, ctx), { success: true, id: 42, name: 'x' });
    assert.deepStrictEqual(await executeTagTool('nextcloud_tag_file', { fileId: 1, tagId: 42 }, ctx), { error: 'File already has this tag.' });
    assert.deepStrictEqual(await executeTagTool('nextcloud_untag_file', { fileId: 1, tagId: 42 }, ctx), { error: 'File or tag relation not found.' });
    assert.deepStrictEqual(await executeTagTool('nextcloud_find_files_by_tag', {}, ctx), { error: 'tagId is required' });
    assert.deepStrictEqual(calls.map((c) => c.method), ['POST', 'PUT', 'DELETE']);
});
