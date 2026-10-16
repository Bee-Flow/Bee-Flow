/**
 * nextcloud_upload_file: missing parents are created on a 404 as well as a 409
 * (Nextcloud answers 404 for a PUT whose parent folder is missing), a path
 * that ends in "/" is refused with a clear message, and base64 that is not
 * base64 is refused instead of being stored as garbage.
 *
 * Run: cd server && node --test integrations/nextcloudFiles/fileOperations.upload.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const restore = installResolveStub({
    '../nextcloudClient': { REQUEST_TIMEOUT_MS: 20000, webdavRoot: (b, u) => `${b}/remote.php/dav/files/${u}` },
});
const { executeFileOperationTool } = require('./fileOperations');
test.after(() => restore());

const ROOT = 'https://nc.example.test/remote.php/dav/files/alice';

/** A server where /New does not exist until MKCOL'd; the PUT answers `missingStatus` until then. */
function makeCtx(missingStatus) {
    const calls = [];
    const made = new Set();
    const ncFetch = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, body: opts.body });
        if (method === 'MKCOL') { made.add(url); return { ok: true, status: 201, text: async () => '' }; }
        if (method === 'PUT' && url.startsWith(`${ROOT}/New/`) && !made.has(`${ROOT}/New`)) {
            return { ok: false, status: missingStatus, text: async () => 'Sabre\\DAV\\Exception\\NotFound' };
        }
        return { ok: true, status: 201, text: async () => '' };
    };
    return { calls, ctx: { ncFetch, authError: 'Reconnect', root: ROOT, baseUrl: 'https://nc.example.test', uid: 'alice', session: {} } };
}

for (const status of [404, 409]) {
    test(`a ${status} on the PUT creates the missing parents and retries once`, async () => {
        const { ctx, calls } = makeCtx(status);
        const res = await executeFileOperationTool('nextcloud_upload_file', { path: '/New/sub/deep.txt', content: 'x' }, ctx);
        assert.strictEqual(res.success, true, JSON.stringify(res));
        assert.deepStrictEqual(calls.map((c) => c.method), ['PUT', 'MKCOL', 'MKCOL', 'PUT']);
    });
}

test('a path ending in a slash is refused as a folder, with no request made', async () => {
    const { ctx, calls } = makeCtx(404);
    const res = await executeFileOperationTool('nextcloud_upload_file', { path: '/New/', content: 'x' }, ctx);
    assert.match(res.error, /folder/i);
    assert.match(res.error, /file name/i);
    assert.strictEqual(calls.length, 0);
});

test('isBase64 with text that is not base64 is refused', async () => {
    const { ctx, calls } = makeCtx(404);
    const res = await executeFileOperationTool('nextcloud_upload_file', { path: '/a.bin', content: 'not base64 !!', isBase64: true }, ctx);
    assert.match(res.error, /base64/i);
    assert.strictEqual(calls.length, 0);
});

test('valid base64 (with line breaks) still uploads its bytes', async () => {
    const { ctx, calls } = makeCtx(404);
    const res = await executeFileOperationTool('nextcloud_upload_file', { path: '/a.bin', content: 'aGVs\nbG8=', isBase64: true }, ctx);
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(calls[0].body.toString(), 'hello');
});

test('base64url text uploads, and a 404 that survives the retry reads like the 409 message', async () => {
    const { ctx, calls } = makeCtx(404);
    const ok = await executeFileOperationTool('nextcloud_upload_file', { path: '/a.bin', content: '_-8=', isBase64: true }, ctx);
    assert.strictEqual(ok.success, true, JSON.stringify(ok));
    assert.deepStrictEqual([...calls[0].body], [0xff, 0xef]);
    const still = { ...ctx, ncFetch: async (url, opts = {}) => ({ ok: opts.method === 'MKCOL', status: opts.method === 'MKCOL' ? 201 : 404, text: async () => '' }) };
    const res = await executeFileOperationTool('nextcloud_upload_file', { path: '/New/x.txt', content: 'x' }, still);
    assert.match(res.error, /could not be created/);
});

test('"." and ".." path segments are refused by joinDavPath', () => {
    const { joinDavPath } = require('./webdav');
    assert.throws(() => joinDavPath(ROOT, '/a/../b'), /not allowed/);
    assert.throws(() => joinDavPath(ROOT, './x'), /not allowed/);
    assert.ok(joinDavPath(ROOT, '/a..b/c.d').endsWith('/a..b/c.d'));
});
