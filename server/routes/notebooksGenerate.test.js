/**
 * Notebook Studio generation (routes/notebooksGenerate.js): the doc-only
 * generate gate. A notebook with no ready source but a document body still
 * generates; one with neither is refused before any model is asked.
 *
 * The collaborators are swapped on their shared module objects
 * (testUtils/swaps.js), the database only records (testUtils/routeHarness.js):
 * no module mocking. The Privacy Shield is off here, so the texts pass
 * unchanged (tested on its own in agents/notebooks/notebookAiShield.test.js).
 *
 * Run: cd server && node --test routes/notebooksGenerate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');
const { makeSwaps } = require('../testUtils/swaps');

const notebookStore = require('../stores/notebookStore');
const notebookAiShield = require('../agents/notebooks/notebookAiShield');
const notebookKbAccess = require('../agents/notebooks/notebookKbAccess');
const notebookKnowledgeSearch = require('../core/kb/notebookKnowledgeSearch');
const modelResolver = require('../core/llm/modelResolver');
const aiAgent = require('../core/aiAgent');
const providers = require('../core/providers');

const { swap, restore } = makeSwaps();

const state = { notebook: null };

const { api } = h.routeUnderTest(test, '/api/notebooks', () => {
    // Before the router loads: it destructures these at require time.
    swap(notebookAiShield, 'shieldNotebookPrompt', async ({ sourceText, otherUnits = [] }) => ({
        ok: true, units: [sourceText, ...otherUnits], addendum: '', untokenise: { push: (t) => t, flush: () => '' },
    }));
    swap(notebookKbAccess, 'partitionNotebookKbIds', async () => ({ allowed: [], denied: [] }));
    return require('./notebooksGenerate');
});

test.before(() => {
    swap(notebookStore, 'getNotebook', async (id, userId) => (
        state.notebook && id === state.notebook.id && userId === state.notebook.userId ? { ...state.notebook } : null));
    swap(notebookStore, 'getSources', async () => []);
    // Required inside the handler — swapped so the doc-only test streams to
    // completion without a KB, model tiers or a provider.
    swap(notebookKnowledgeSearch, 'gatherNotebookContent', async () => ({ content: 'Document body content' }));
    swap(modelResolver, 'resolveEffectiveOrgId', async () => null);
    swap(modelResolver, 'resolveModelForTier', async () => 'test-model');
    swap(modelResolver, 'getEUAwareTiers', async () => ({}));
    swap(aiAgent, 'getAIConfig', async () => ({ model: 'test-model' }));
    swap(aiAgent, 'getProviderForModel', async () => ({ apiKey: 'k', url: 'http://test.local', providerType: 'mock' }));
    swap(providers, 'getAdapter', () => ({
        stream: async (_key, _url, _model, _messages, _opts, cb) => { cb('text', { text: 'GENERATED-OK' }); },
    }));
});
test.after(restore);

function seedNotebook(nb) {
    state.notebook = {
        userId: 'u1', name: 'NB', description: '', instructions: '',
        knowledgeBaseIds: [], settings: {}, documentContent: '', documentMd: null,
        type: 'notebook', version: 1, sourceCount: 0,
        ...nb,
    };
}

const generate = () => api.call('POST', '/api/notebooks/nb1/generate/summary', { body: {} });

// ── POST /:id/generate/:type — doc-only gate ────────────────────────

test('generate with 0 sources and an empty doc → 400', async () => {
    seedNotebook({ id: 'nb1', documentContent: '   ', documentMd: null });
    const r = await generate();
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'Add a source or write something in the document first');
});

test('generate with 0 sources but a non-empty doc does NOT 400 — it streams', async () => {
    seedNotebook({ id: 'nb1', documentContent: '<p>A real document body</p>' });
    const r = await generate();
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('GENERATED-OK'), `expected streamed content, got: ${r.text.slice(0, 200)}`);
    assert.ok(r.text.includes('event: done'));
});
