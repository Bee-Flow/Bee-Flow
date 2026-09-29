/**
 * nextcloud_upload_file with sourceHandle { kind: 'generated_file' } — the
 * bridge that lets a routine push the deck (or PDF) a document step kept
 * into Nextcloud Files. The handle resolver is a double; what is pinned is
 * the wiring: the run scope reaches the tool, the bytes and MIME come from
 * the ledger, a folder path takes the file's own name, and the two refusals.
 *
 * Run: node --test --test-force-exit integrations/nextcloudFiles/fileOperations.generatedFile.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const resolver = { calls: [], answer: null, throwWith: null };
installResolveStub({
    '../../core/automationRunner/generatedFileHandle': {
        readGeneratedFile: async (handle, runScope) => {
            resolver.calls.push({ handle, runScope });
            if (resolver.throwWith) throw resolver.throwWith;
            return resolver.answer;
        },
    },
});
const { executeFileOperationTool } = require('./fileOperations');

const ROOT = 'https://nc.example.test/remote.php/dav/files/alice';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function makeCtx(runScope) {
    const calls = [];
    const ncFetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
        return { ok: true, status: 201, headers: new Headers(), text: async () => '' };
    };
    return { calls, ctx: { ncFetch, authError: 'Reconnect', root: ROOT, baseUrl: 'https://nc.example.test', uid: 'alice', session: {}, runScope } };
}

test('a generated_file handle is resolved against the run scope and PUT with the ledger MIME', async () => {
    resolver.calls = [];
    resolver.answer = { buffer: Buffer.from('PK-deck'), filename: 'kwartaal.pptx', mimeType: PPTX, size: 7 };
    const { ctx, calls } = makeCtx({ runId: 'run-1', rootRunId: 'run-0' });
    const res = await executeFileOperationTool('nextcloud_upload_file', { path: '/Decks/', sourceHandle: { kind: 'generated_file', fileId: 'f1' } }, ctx);
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.deepStrictEqual(resolver.calls[0].runScope, { runId: 'run-1', rootRunId: 'run-0' });
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put.url.endsWith('/Decks/kwartaal.pptx'), `a folder path takes the file's own name: ${put.url}`);
    assert.strictEqual(put.headers['Content-Type'], PPTX);
    assert.strictEqual(put.body.toString(), 'PK-deck');
});

test('an explicit file path wins over the ledger name', async () => {
    resolver.answer = { buffer: Buffer.from('PK'), filename: 'x.pptx', mimeType: PPTX, size: 2 };
    const { ctx, calls } = makeCtx({ runId: 'run-1' });
    await executeFileOperationTool('nextcloud_upload_file', { path: '/Decks/board.pptx', sourceHandle: { kind: 'generated_file', fileId: 'f1' } }, ctx);
    assert.ok(calls.find((c) => c.method === 'PUT').url.endsWith('/Decks/board.pptx'));
});

test('refusals: not a live file of this run; used outside a run', async () => {
    resolver.answer = null;
    const { ctx } = makeCtx({ runId: 'run-1' });
    const gone = await executeFileOperationTool('nextcloud_upload_file', { path: '/Decks/', sourceHandle: { kind: 'generated_file', fileId: 'old' } }, ctx);
    assert.match(gone.error, /not a live file of this run/);

    resolver.throwWith = Object.assign(new Error('A generated_file handle can only be used inside a routine run — the file belongs to that run.'), { errorClass: 'handle_scope_missing' });
    const chat = await executeFileOperationTool('nextcloud_upload_file', { path: '/Decks/', sourceHandle: { kind: 'generated_file', fileId: 'f1' } }, makeCtx(null).ctx);
    assert.match(chat.error, /inside a routine run/);
    resolver.throwWith = null;
});
