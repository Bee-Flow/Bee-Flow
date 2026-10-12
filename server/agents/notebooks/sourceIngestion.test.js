/**
 * Source ingestion: a cancel/delete that happens while a source is being
 * ingested wins, unreadable text is an error (not a silent "ready" with 0
 * words), and failures are stored in friendly words with stage 'error'.
 *
 * Run: node --test agents/notebooks/sourceIngestion.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { installResolveStub } = require('../../testUtils/stubRequire');

const state = { status: 'processing', writes: [], embedded: 0, cleaned: [], ingestError: null, statusDuringEmbed: null };

// Stubbed at the require boundary (also keeps the heavy privacy stack, which
// needs native modules, out of a unit test of the state machine).
const restore = installResolveStub({
    '../../core/kb/kbIngestionHelpers': {
        extractFileContent: async () => '',
        fetchUrlContent: async () => ({ content: '' }),
        ingestDocument: async () => {
            state.embedded++;
            if (state.statusDuringEmbed) state.status = state.statusDuringEmbed;
            if (state.ingestError) throw state.ingestError;
            return { chunks: 3 };
        },
    },
    '../../core/privacy/orgShield': { resolveShieldFor: async () => ({ enabled: false }) },
    '../../core/kb/notebookCascade': {
        cleanupSourceArtifacts: async (nb, source, tenant) => { state.cleaned.push({ nb, source, tenant }); },
    },
});
test.after(restore);

const notebookStore = require('../../stores/notebookStore');
notebookStore.updateSource = async (id, updates, opts = {}) => {
    if (opts.onlyIfProcessing && state.status !== 'processing') return false;
    state.writes.push({ id, updates, opts });
    if (updates.status) state.status = updates.status;
    return true;
};
notebookStore.getSourceStatus = async () => state.status;
notebookStore.getSource = async () => ({ id: 's1', metadata: {} });
notebookStore.getNotebook = async () => ({ id: 'n1', userId: 'u1', name: 'NB', knowledgeBaseIds: ['kb1'] });

const { ingestTextIntoKB, NO_READABLE_TEXT } = require('./sourceIngestion');

function reset() {
    Object.assign(state, { status: 'processing', writes: [], embedded: 0, cleaned: [], ingestError: null, statusDuringEmbed: null });
}
const TEXT = 'This is a perfectly readable paragraph of text.';

test('happy path: embeds, then marks ready with a conditional write', async () => {
    reset();
    await ingestTextIntoKB('n1', 's1', 'u1', TEXT, 'Doc');
    assert.strictEqual(state.embedded, 1);
    assert.strictEqual(state.status, 'ready');
    const last = state.writes.at(-1);
    assert.strictEqual(last.opts.onlyIfProcessing, true);
    assert.strictEqual(state.cleaned.length, 0);
});

test('text with no readable content is an error with a friendly message, not "ready"', async () => {
    reset();
    await ingestTextIntoKB('n1', 's1', 'u1', '  short  ', 'Doc');
    assert.strictEqual(state.embedded, 0);
    assert.strictEqual(state.status, 'error');
    const w = state.writes.at(-1).updates;
    assert.strictEqual(w.error, NO_READABLE_TEXT);
    assert.strictEqual(w.stage, 'error');
    assert.strictEqual(w.wordCount, 0);
});

test('a source cancelled before embedding is never embedded or marked ready', async () => {
    reset();
    state.status = 'error'; // user pressed cancel
    await ingestTextIntoKB('n1', 's1', 'u1', TEXT, 'Doc');
    assert.strictEqual(state.embedded, 0);
    assert.strictEqual(state.status, 'error');
    assert.strictEqual(state.writes.length, 0, 'nothing overwrote the cancelled row');
});

test('a source cancelled while embedding stays cancelled and its chunks are removed', async () => {
    reset();
    state.statusDuringEmbed = 'error';
    await ingestTextIntoKB('n1', 's1', 'u1', TEXT, 'Doc');
    assert.strictEqual(state.embedded, 1);
    assert.strictEqual(state.status, 'error', 'not flipped to ready');
    assert.strictEqual(state.cleaned.length, 1);
    assert.deepStrictEqual(state.cleaned[0].nb.knowledgeBaseIds, ['kb1']);
    assert.strictEqual(state.cleaned[0].source.id, 's1');
    assert.strictEqual(state.cleaned[0].source.storageKey, undefined, 'the uploaded original is kept for retry');
});

test('a source deleted while embedding has its chunks removed too', async () => {
    reset();
    state.statusDuringEmbed = 'gone';
    await ingestTextIntoKB('n1', 's1', 'u1', TEXT, 'Doc');
    assert.strictEqual(state.cleaned.length, 1);
});

test('an ingestion failure is stored friendly, with stage error', async () => {
    reset();
    state.ingestError = new Error('getaddrinfo ENOTFOUND embeddings.internal');
    await ingestTextIntoKB('n1', 's1', 'u1', TEXT, 'Doc');
    const w = state.writes.at(-1).updates;
    assert.strictEqual(w.status, 'error');
    assert.strictEqual(w.stage, 'error');
    assert.match(w.error, /Could not reach/);
    assert.doesNotMatch(w.error, /embeddings\.internal/);
});
