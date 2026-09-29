/**
 * generated_file handles — a kept file may only be read back inside the
 * journey that produced it. Pinned: no run → refused; a foreign or expired id
 * → null; the happy path streams the bytes with the ledger's name and MIME;
 * the size cap aborts the stream.
 *
 * Run: cd server && node --test --test-force-exit core/automationRunner/generatedFileHandle.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Readable } = require('stream');
const { installResolveStub } = require('../../testUtils/stubRequire');

const ledger = { files: new Map(), chain: [], askedRuns: null };
const automationStore = {
    async getRunsInChain(_rootRunId) { return ledger.chain.map((id) => ({ id })); },
    async getGeneratedFileForRuns(id, runIds) {
        ledger.askedRuns = runIds;
        const f = ledger.files.get(id);
        return f && runIds.includes(f.runId) ? f : null;
    },
    async getAutomation() { return null; },
    async recordGeneratedFile() { return { id: 'x' }; },
};
const storage = {
    bytes: Buffer.from('PK-deck-bytes'),
    isAvailable: () => true,
    async streamFile(_key) { return { stream: Readable.from([storage.bytes]), contentType: 'application/octet-stream' }; },
    buildAutomationFileKey: () => 'k',
    async uploadFile() {},
};
const restore = installResolveStub({
    '../../stores/automationStore': automationStore,
    '../../stores/storageStore': storage,
    '../../services/documentRenderer': { renderDocument: async () => ({}), FORMATS: ['pdf'], CONTENT_TYPES: {} },
});
const { readGeneratedFile, isGeneratedFileHandle, journeyRunIds } = require('./generatedFileHandle');
after(restore);

beforeEach(() => {
    ledger.files = new Map([['f1', { id: 'f1', runId: 'run-leg-1', storageKey: 'auto/a/sha', filename: 'deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }]]);
    ledger.chain = ['run-root', 'run-leg-1', 'run-leg-2'];
    ledger.askedRuns = null;
    storage.bytes = Buffer.from('PK-deck-bytes');
});

test('the handle shape', () => {
    assert.strictEqual(isGeneratedFileHandle({ kind: 'generated_file', fileId: 'f1' }), true);
    assert.strictEqual(isGeneratedFileHandle({ kind: 'gmail_attachment', fileId: 'f1' }), false);
    assert.strictEqual(isGeneratedFileHandle({ kind: 'generated_file' }), false);
    assert.strictEqual(isGeneratedFileHandle(null), false);
});

test('outside a run the handle is refused with a clear message', async () => {
    await assert.rejects(readGeneratedFile({ kind: 'generated_file', fileId: 'f1' }, null), (e) => e.errorClass === 'handle_scope_missing');
    await assert.rejects(readGeneratedFile({ kind: 'generated_file', fileId: 'f1' }, {}), (e) => e.errorClass === 'handle_scope_missing');
});

test('inside a run the journey chain is what the ledger is asked with — a later leg reads an earlier leg\'s file', async () => {
    const file = await readGeneratedFile({ kind: 'generated_file', fileId: 'f1' }, { runId: 'run-leg-2', rootRunId: 'run-root' });
    assert.ok(file, 'found through the chain');
    assert.deepStrictEqual([...ledger.askedRuns].sort(), ['run-leg-1', 'run-leg-2', 'run-root']);
    assert.strictEqual(file.filename, 'deck.pptx');
    assert.match(file.mimeType, /presentationml/);
    assert.strictEqual(file.buffer.toString(), 'PK-deck-bytes');
    assert.strictEqual(file.size, 13);
    assert.deepStrictEqual((await journeyRunIds({ runId: 'solo' })).sort(), ['run-leg-1', 'run-leg-2', 'run-root', 'solo']);
});

test('a foreign or expired id is null, never somebody else\'s bytes', async () => {
    ledger.chain = ['other-root'];
    assert.strictEqual(await readGeneratedFile({ kind: 'generated_file', fileId: 'f1' }, { runId: 'other-root' }), null);
    assert.strictEqual(await readGeneratedFile({ kind: 'generated_file', fileId: 'nope' }, { runId: 'run-leg-1', rootRunId: 'run-root' }), null);
});

test('a file past the cap aborts instead of buffering', async () => {
    storage.bytes = Buffer.alloc(26 * 1024 * 1024);
    await assert.rejects(readGeneratedFile({ kind: 'generated_file', fileId: 'f1' }, { runId: 'run-leg-1', rootRunId: 'run-root' }), (e) => e.errorClass === 'document_too_large');
});
