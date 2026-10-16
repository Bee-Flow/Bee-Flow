/**
 * Nextcloud Files tools that reported success with wrong output: the folder
 * tree (plain Files route, bare array), read_file on a folder, a text cut in
 * the middle of a multibyte character, share ids and OCS errors, the 412 on an
 * unknown tag, and the comment id.
 *
 * Run: cd server && node --test integrations/nextcloudFiles/fileTools.fixes.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const restore = installResolveStub({
    '../nextcloudClient': { REQUEST_TIMEOUT_MS: 20000, webdavRoot: (b, u) => `${b}/remote.php/dav/files/${u}` },
});
const { executeFileOperationTool } = require('./fileOperations');
const { executeShareTool } = require('./sharing');
const { executeTagTool } = require('./tags');
const { executeCommentTool } = require('./comments');
const { MAX_TEXT_BYTES } = require('./webdav');
test.after(() => restore());

const BASE = 'https://nc.example.test';
const ROOT = `${BASE}/remote.php/dav/files/alice`;

function reply(status, body, headers = {}) {
    const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body ?? '');
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        text: async () => String(text),
        json: async () => JSON.parse(String(text)),
        arrayBuffer: async () => Uint8Array.from(Buffer.from(text)).buffer,
    };
}
function ctxFor(answer) {
    const calls = [];
    const ncFetch = async (url, opts = {}) => { calls.push({ url, method: opts.method || 'GET' }); return answer(url, opts); };
    return { calls, ctx: { ncFetch, authError: 'AUTH', root: ROOT, baseUrl: BASE, uid: 'alice', session: {} } };
}

test('folder_tree calls the OCS route and reads its bare array', async () => {
    const tree = [{ name: 'Docs', children: [] }];
    const { ctx, calls } = ctxFor(() => reply(200, tree));
    const res = await executeFileOperationTool('nextcloud_folder_tree', { depth: 2, path: '/Docs', withParents: true }, ctx);
    assert.deepStrictEqual(res.tree, [{ name: 'Docs', children: [], path: '/Docs' }]);
    assert.ok(calls[0].url.startsWith(`${BASE}/ocs/v2.php/apps/files/api/v1/folder-tree?`), calls[0].url);
    assert.match(calls[0].url, /depth=2/);
    assert.match(calls[0].url, /path=%2FDocs/);
    assert.match(calls[0].url, /withParents=true/);
});

test('read_file on a folder says so instead of returning the WebDAV banner', async () => {
    const banner = '<html><body>This is the WebDAV interface. It can only be accessed by WebDAV clients.</body></html>';
    const { ctx } = ctxFor(() => reply(200, banner, { 'content-type': 'text/html; charset=utf-8' }));
    const res = await executeFileOperationTool('nextcloud_read_file', { path: '/Docs' }, ctx);
    assert.match(res.error, /folder/);
    assert.strictEqual(res.content, undefined);
});

test('a truncated text read never ends in half a character', async () => {
    // "é" is 2 bytes; an odd offset puts the cut inside one.
    const text = 'a' + 'é'.repeat(MAX_TEXT_BYTES);
    const { ctx } = ctxFor(() => reply(200, text, { 'content-type': 'text/plain' }));
    const res = await executeFileOperationTool('nextcloud_read_file', { path: '/big.txt' }, ctx);
    assert.strictEqual(res.truncated, true);
    assert.ok(!res.content.includes('�'), 'no replacement character');
});

const SHARE = { ocs: { meta: { statuscode: 200 }, data: { id: '12', token: 't', url: 'u', permissions: 1 } } };

test('share ids come back as numbers from create, share_with and list', async () => {
    const { ctx } = ctxFor((url, opts) => (opts.method === 'POST' ? reply(200, SHARE) : reply(200, { ocs: { data: [{ id: '12' }] } })));
    assert.strictEqual((await executeShareTool('nextcloud_create_share', { path: '/a' }, ctx)).id, 12);
    const w = await executeShareTool('nextcloud_share_with_user', { path: '/a', shareWith: 'bob' }, ctx);
    assert.strictEqual(w.shareId, 12);
    assert.strictEqual(w.id, 12);
    assert.strictEqual((await executeShareTool('nextcloud_list_shares', {}, ctx)).shares[0].id, 12);
});

test('an OCS share failure shows the reason, not the raw JSON', async () => {
    const body = { ocs: { meta: { status: 'failure', statuscode: 404, message: 'Wrong path, file/folder does not exist' }, data: [] } };
    const { ctx } = ctxFor(() => reply(404, body));
    const res = await executeShareTool('nextcloud_create_share', { path: '/nope' }, ctx);
    assert.match(res.error, /Wrong path, file\/folder does not exist/);
    assert.ok(!res.error.includes('{'), res.error);
});

test('tag_file with an unknown tag explains the 412', async () => {
    const { ctx } = ctxFor(() => reply(412, ''));
    const res = await executeTagTool('nextcloud_tag_file', { fileId: 1, tagId: 999 }, ctx);
    assert.match(res.error, /nextcloud_list_tags/);
});

test('add_file_comment returns the new comment id from Content-Location', async () => {
    const { ctx } = ctxFor(() => reply(201, '', { 'content-location': '/remote.php/dav/comments/files/1/77' }));
    const res = await executeCommentTool('nextcloud_add_file_comment', { fileId: 1, message: 'hi' }, ctx);
    assert.strictEqual(res.commentId, 77);
});

test('folder_tree writes the full path on every node, relative to the start folder', async () => {
    const answer = [{ name: 'Secret', children: [{ name: 'x' }] }];
    const { ctx } = ctxFor(() => reply(200, answer));
    const res = await executeFileOperationTool('nextcloud_folder_tree', { path: 'Shared/' }, ctx);
    assert.deepStrictEqual(res.tree.map((n) => n.path), ['/Shared/Secret']);
    assert.strictEqual(res.tree[0].children[0].path, '/Shared/Secret/x');
});
