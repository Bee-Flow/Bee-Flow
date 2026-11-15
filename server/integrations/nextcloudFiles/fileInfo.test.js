// @typecheck
/**
 * nextcloud_file_info: a file or folder by file id (WebDAV SEARCH on
 * oc:fileid in the user's own tree) or by path (PROPFIND Depth 0), as
 * { fileId, path, name, mimeType, size, owner, modifiedAt, isFolder }.
 *
 * Run: cd server && node --test integrations/nextcloudFiles/fileInfo.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../../testUtils/routeHarness').recordDb();
const { resetFakeNc } = require('../nextcloudToolFakes');
const { executeNextcloudTool } = require('../nextcloudTools');

test.after(resetFakeNc);

const BASE = 'https://nc.example.test';

/**
 * @param {string} href
 * @param {Record<string, string>} props
 * @param {boolean} [folder]
 */
function multistatus(href, props, folder = false) {
    const body = Object.entries(props).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>${href}</d:href>`
        + `<d:propstat><d:prop>${body}<d:resourcetype>${folder ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`
        + '</d:response></d:multistatus>';
}

/**
 * A fake Nextcloud identity whose fetch answers raw XML (the json() helper of
 * nextcloudToolFakes would JSON-encode it); the request body is kept as text.
 * resetFakeNc puts the real resolveAuth back.
 * @param {(req: { url: string, method: string, body: string | undefined }) => { status: number, text: string }} handler
 */
function installDav(handler) {
    /** @type {{ url: string, method: string, body: string | undefined }[]} */
    const calls = [];
    const ncClient = require('../nextcloudClient');
    ncClient.resolveAuth = /** @type {any} */ (async () => ({
        baseUrl: BASE, authError: 'AUTH', uid: 'alice',
        fetch: async (/** @type {string} */ url, /** @type {any} */ opts = {}) => {
            const req = { url, method: opts.method || 'GET', body: opts.body };
            calls.push(req);
            const { status, text } = handler(req);
            return { ok: status < 400, status, headers: new Headers(), text: async () => text };
        },
    }));
    return calls;
}

const FILE_PROPS = {
    'oc:fileid': '4211', 'd:getcontenttype': 'application/pdf', 'd:getcontentlength': '51200',
    'd:getlastmodified': 'Mon, 05 Oct 2026 09:12:00 GMT', 'oc:owner-id': 'alice',
};

test('by file id: one SEARCH on oc:fileid in the own tree, the path as the user sees it', async () => {
    const calls = installDav(() => ({ status: 207, text: multistatus('/remote.php/dav/files/alice/Invoices/Invoice%202026-001.pdf', FILE_PROPS) }));
    const out = await executeNextcloudTool('nextcloud_file_info', { fileId: 4211 }, 'u1', {});
    assert.deepStrictEqual(out, {
        fileId: 4211, path: '/Invoices/Invoice 2026-001.pdf', name: 'Invoice 2026-001.pdf', mimeType: 'application/pdf',
        size: 51200, owner: 'alice', modifiedAt: '2026-10-05T09:12:00.000Z', isFolder: false,
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'SEARCH');
    assert.strictEqual(calls[0].url, `${BASE}/remote.php/dav/`);
    assert.match(String(calls[0].body), /<d:href>\/files\/alice<\/d:href>/);
    assert.match(String(calls[0].body), /<d:literal>4211<\/d:literal>/);
});

test('by path: a Depth 0 PROPFIND; a folder carries its oc:size and no MIME type', async () => {
    const calls = installDav(() => ({ status: 207, text: multistatus('/remote.php/dav/files/alice/Invoices/', { 'oc:fileid': '77', 'oc:size': '9000', 'oc:owner-id': 'alice', 'd:getlastmodified': 'Mon, 05 Oct 2026 09:12:00 GMT' }, true) }));
    const out = await executeNextcloudTool('nextcloud_file_info', { path: '/Invoices' }, 'u1', {});
    assert.deepStrictEqual(out, { fileId: 77, path: '/Invoices', name: 'Invoices', mimeType: null, size: 9000, owner: 'alice', modifiedAt: '2026-10-05T09:12:00.000Z', isFolder: true });
    assert.strictEqual(calls[0].method, 'PROPFIND');
    assert.strictEqual(calls[0].url, `${BASE}/remote.php/dav/files/alice/Invoices`);
});

test('a file id with no hit is "not found"', async () => {
    installDav(() => ({ status: 207, text: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>' }));
    const out = /** @type {any} */ (await executeNextcloudTool('nextcloud_file_info', { fileId: '99' }, 'u1', {}));
    assert.match(out.error, /not found.*99/i);
});

test('a missing path is "not found"; a 401 is the auth message', async () => {
    installDav(() => ({ status: 404, text: '' }));
    assert.match(/** @type {any} */ (await executeNextcloudTool('nextcloud_file_info', { path: '/nope.txt' }, 'u1', {})).error, /not found: \/nope\.txt/i);
    installDav(() => ({ status: 401, text: '' }));
    assert.strictEqual(/** @type {any} */ (await executeNextcloudTool('nextcloud_file_info', { fileId: 5 }, 'u1', {})).error, 'AUTH');
});

test('argument checks: one of the two, a positive whole id, no traversal', async () => {
    const calls = installDav(() => ({ status: 207, text: '' }));
    for (const [args, pattern] of /** @type {Array<[Record<string, unknown>, RegExp]>} */ ([
        [{}, /fileId or path is required/],
        [{ fileId: 1, path: '/a' }, /not both/],
        [{ fileId: -3 }, /positive whole number/],
        [{ fileId: '12abc' }, /positive whole number/],
        [{ fileId: 1.5 }, /positive whole number/],
        [{ path: '/a/../b' }, /"\.\."/],
    ])) {
        const out = /** @type {any} */ (await executeNextcloudTool('nextcloud_file_info', args, 'u1', {}));
        assert.match(out.error, pattern, JSON.stringify(args));
    }
    assert.deepStrictEqual(calls, []);
});

test('the uid in the SEARCH body is XML-escaped', () => {
    const { fileIdSearchBody } = require('./fileInfo.mts');
    assert.match(fileIdSearchBody('a<b&c', 1), /\/files\/a&lt;b&amp;c</);
});
