// @typecheck
/**
 * davStatusError.mts: a locked file (423), a full quota (507) and a denied
 * write (403) read the same on every write path (create folder, delete, move,
 * copy, upload, the generated office files), the Sabre body is not echoed, and
 * the classifier files each one under its own code.
 *
 * Run: cd server && node --test integrations/nextcloudFiles/davStatusError.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// The real nextcloudClient (it pulls the database in at load) over a recording pool.
require('../../testUtils/routeHarness').recordDb();
const { davStatusError } = require('./davStatusError.mts');
const { executeFileOperationTool } = require('./fileOperations');
const { executeOfficeDocumentTool } = require('./officeDocuments');
const { uploadBinaryFile } = require('./webdav');
const { classifyNextcloudError } = require('../../utils/nextcloudErrorClassifier');

const ROOT = 'https://nc.example.test/remote.php/dav/files/alice';
const SABRE = {
    423: '<?xml version="1.0"?><d:error xmlns:s="http://sabredav.org/ns"><s:exception>OCA\\DAV\\Connector\\Sabre\\Exception\\FileLocked</s:exception><s:message>"report.docx" is locked</s:message></d:error>',
    507: '<?xml version="1.0"?><d:error xmlns:s="http://sabredav.org/ns"><s:exception>Sabre\\DAV\\Exception\\InsufficientStorage</s:exception><s:message>Insufficient space in /Docs, 1048576 required, 0 available</s:message></d:error>',
    403: '<?xml version="1.0"?><d:error xmlns:s="http://sabredav.org/ns"><s:exception>Sabre\\DAV\\Exception\\Forbidden</s:exception><s:message>Access denied</s:message></d:error>',
};
const CODE = { 423: 'FILE_LOCKED', 507: 'QUOTA_EXCEEDED', 403: 'NO_ACCESS' };

/** The method under test; a MKCOL of a parent folder succeeds unless MKCOL itself is under test. */
const FAILING = { method: '' };

/** Every write answers `status` with Sabre's own body. */
function ctxAnswering(status) {
    const ncFetch = async (/** @type {string} */ _url, /** @type {{ method?: string }} */ opts = {}) => {
        if (opts.method === 'MKCOL' && FAILING.method !== 'MKCOL') return { ok: true, status: 201, text: async () => '' };
        return { ok: false, status, text: async () => SABRE[status] || '' };
    };
    return { ncFetch, authError: 'AUTH', root: ROOT, baseUrl: 'https://nc.example.test', uid: 'alice', session: {} };
}

test('the helper words 423, 507 and 403, keeps the status in the text and leaves every other status alone', () => {
    assert.match(davStatusError(423, '/Docs/report.docx'), /^\/Docs\/report\.docx is locked in Nextcloud \(423\)/);
    assert.match(davStatusError(507, '/Docs/big.zip'), /^Not enough storage in Nextcloud for \/Docs\/big\.zip \(507\)/);
    assert.match(davStatusError(403, '/HR/a.pdf'), /^Permission denied in Nextcloud for \/HR\/a\.pdf \(403\)/);
    assert.match(davStatusError(403, '/HR/a.pdf'), /read-only share, a team folder permission or a file access control rule/);
    assert.match(davStatusError(423, null), /^this file or folder is locked/);
    for (const status of [200, 204, 401, 404, 405, 409, 412, 500, 503]) assert.strictEqual(davStatusError(status, '/x'), null, String(status));
});

/** @type {Array<[tool: string, args: Record<string, string>, method: string]>} */
const WRITES = [
    ['nextcloud_delete', { path: '/Docs/report.docx' }, 'DELETE'],
    ['nextcloud_create_folder', { path: '/Docs/New' }, 'MKCOL'],
    ['nextcloud_move', { source: '/Docs/report.docx', destination: '/Archive/report.docx' }, 'MOVE'],
    ['nextcloud_copy', { source: '/Docs/report.docx', destination: '/Archive/report.docx' }, 'COPY'],
    ['nextcloud_upload_file', { path: '/Docs/report.txt', content: 'x' }, 'PUT'],
];

for (const status of [423, 507, 403]) {
    test(`a ${status} reads the same on every write path and classifies as ${CODE[status]}`, async () => {
        for (const [tool, args, method] of WRITES) {
            FAILING.method = method;
            const res = await executeFileOperationTool(tool, args, ctxAnswering(status));
            assert.ok(res && typeof res.error === 'string', `${tool}: ${JSON.stringify(res)}`);
            assert.ok(res.error.includes(`(${status})`), `${tool}: ${res.error}`);
            assert.ok(!/<|Sabre|failed \(/.test(res.error), `${tool} echoes no body and no bare status line: ${res.error}`);
            assert.strictEqual(classifyNextcloudError(res.error, { tool }).code, CODE[status], `${tool}: ${res.error}`);
        }
        FAILING.method = '';
    });

    test(`a ${status} on a generated office file is the same message (the office write path)`, async () => {
        FAILING.method = 'PUT';
        const ctx = ctxAnswering(status);
        const direct = await uploadBinaryFile(ctx.ncFetch, ROOT, '/Docs/sheet.xlsx', Buffer.from('x'), 'application/octet-stream', 'AUTH');
        assert.strictEqual(direct.error, davStatusError(status, '/Docs/sheet.xlsx'));
        const viaTool = await executeOfficeDocumentTool('nextcloud_create_document', { path: '/Docs/note.docx', content: 'Hello' }, ctx);
        assert.strictEqual(viaTool.error, davStatusError(status, '/Docs/note.docx'));
        assert.strictEqual(classifyNextcloudError(viaTool.error, { tool: 'nextcloud_create_document' }).code, CODE[status]);
        FAILING.method = '';
    });
}

test('a full quota on a move names the destination; a lock names both ends', async () => {
    FAILING.method = 'MOVE';
    const args = { source: '/Docs/a.pdf', destination: '/Archive/a.pdf' };
    const full = await executeFileOperationTool('nextcloud_move', args, ctxAnswering(507));
    assert.match(full.error, /for \/Archive\/a\.pdf \(507\)/);
    const locked = await executeFileOperationTool('nextcloud_move', args, ctxAnswering(423));
    assert.match(locked.error, /^\/Docs\/a\.pdf or \/Archive\/a\.pdf is locked/);
    FAILING.method = '';
});

test('the statuses the write paths already named keep their own message', async () => {
    FAILING.method = 'DELETE';
    assert.deepStrictEqual(await executeFileOperationTool('nextcloud_delete', { path: '/x' }, ctxAnswering(404)), { error: 'Not found: /x' });
    assert.deepStrictEqual(await executeFileOperationTool('nextcloud_delete', { path: '/x' }, ctxAnswering(500)), { error: 'Delete failed (500)' });
    FAILING.method = 'MKCOL';
    assert.deepStrictEqual(await executeFileOperationTool('nextcloud_create_folder', { path: '/x' }, ctxAnswering(405)), { error: 'Folder already exists: /x' });
    FAILING.method = '';
});
