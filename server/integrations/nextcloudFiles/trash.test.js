// @typecheck
/**
 * The trash bin tools against the WebDAV shapes Nextcloud documents:
 *
 *   - Restoring is a MOVE of the trash item to `…/trashbin/<uid>/restore/<name>`.
 *     The restore folder is flat: a destination with folders in it
 *     (`restore/Documents/a.txt`) has no parent collection and Nextcloud
 *     answers 409, so an item deleted from a subfolder could never be restored.
 *   - A trash path is a path INSIDE the trash. `..` segments walked out of it:
 *     "permanent delete" of `../../files/<uid>/x` became a DELETE on a live file.
 *
 * Run: cd server && node --test integrations/nextcloudFiles/trash.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('../../testUtils/routeHarness').recordDb();
const { executeTrashTool } = require('./trash');

const BASE = 'https://nc.example.test';
const TRASHBIN = `${BASE}/remote.php/dav/trashbin/alice`;

function ctxFor(status = 201) {
    /** @type {{ url: string, method: string, destination?: string }[]} */
    const calls = [];
    const ncFetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', destination: opts.headers?.Destination });
        return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => '' };
    };
    return { calls, ctx: /** @type {any} */ ({ ncFetch, authError: 'AUTH', baseUrl: BASE, uid: 'alice', session: {} }) };
}

test('restore moves the item to restore/<its trash name>, whatever folder it was deleted from', async () => {
    const { ctx, calls } = ctxFor();
    const res = await executeTrashTool('nextcloud_restore_from_trash',
        { trashPath: '/trash/Q3 report.xlsx.d1762700000', originalPath: 'Documents/Finance/Q3 report.xlsx' }, ctx);
    assert.deepStrictEqual(res, { success: true, restoredFrom: '/trash/Q3 report.xlsx.d1762700000' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, 'MOVE');
    assert.strictEqual(calls[0].url, `${TRASHBIN}/trash/Q3%20report.xlsx.d1762700000`);
    assert.strictEqual(calls[0].destination, `${TRASHBIN}/restore/Q3%20report.xlsx.d1762700000`);
});

test('restore of a file inside a deleted folder uses the file name only', async () => {
    const { ctx, calls } = ctxFor();
    await executeTrashTool('nextcloud_restore_from_trash', { trashPath: '/trash/Old.d1762700000/notes.md' }, ctx);
    assert.strictEqual(calls[0].url, `${TRASHBIN}/trash/Old.d1762700000/notes.md`);
    assert.strictEqual(calls[0].destination, `${TRASHBIN}/restore/notes.md`);
});

for (const tool of ['nextcloud_restore_from_trash', 'nextcloud_permanent_delete_trash']) {
    for (const trashPath of ['../../files/alice/Important.docx', '/trash/../../files/alice/x', 'trash/a/./b', 'restore/x', '/trash/', 'trash']) {
        test(`${tool} refuses "${trashPath}": not a path inside the trash`, async () => {
            const { ctx, calls } = ctxFor(204);
            const res = await executeTrashTool(tool, { trashPath }, ctx);
            assert.match(String(res.error), /trash/i);
            assert.deepStrictEqual(calls, [], 'nothing is sent to Nextcloud');
        });
    }
}

test('permanent delete of a listed item still goes to its trash URL', async () => {
    const { ctx, calls } = ctxFor(204);
    const res = await executeTrashTool('nextcloud_permanent_delete_trash', { trashPath: '/trash/a b#c.txt.d1762700000' }, ctx);
    assert.deepStrictEqual(res, { success: true, deleted: '/trash/a b#c.txt.d1762700000' });
    assert.deepStrictEqual(calls.map((c) => [c.method, c.url]), [['DELETE', `${TRASHBIN}/trash/a%20b%23c.txt.d1762700000`]]);
});
