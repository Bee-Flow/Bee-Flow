/**
 * A notebook chat turn writes one usage row (source notebook_chat): the user,
 * the organisation, the model, the notebook as conversation and the tokens of
 * every round the adapter reported. Before, notebook chat wrote nothing.
 *
 * Run: cd server && node --test usecases/ai/notebookChat/toolLoop.usage.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { areaOf } = require('../../../shared/usageAreas');
const { usePglitePool } = require('../../../testUtils/pglitePool');
const surfaceUsage = require('../../../core/llm/surfaceUsage');
const { runToolLoop } = require('./toolLoop');

// The turn reads its round limit from the config store: an empty Postgres
// (pglite behind db.js's pool) answers "not set".
const { close } = usePglitePool();
const rows = [];
// The turn writes through the shared surface-usage sink; the test reads it there.
surfaceUsage._setDepsForTests({ logUsage: async (row) => { rows.push(row); } });
after(async () => { surfaceUsage._setDepsForTests(null); await close(); });

test('one row per turn with the tokens the adapter reported', async () => {
    const adapter = {
        async stream(_k, _u, _m, _msgs, _opts, cb) {
            cb('text', { text: 'An answer.' });
            cb('done', { prompt_tokens: 40, completion_tokens: 6 });
        },
    };
    const out = await runToolLoop(/** @type {any} */ ({
        messages: [{ role: 'user', content: 'Q?' }], notebookTools: [], chatOptions: {},
        executeNotebookTool: async () => ({}), repeatGuard: {},
        toolPiiGate: { toolLoopGate: () => ({ refuse: async () => null, forModel: async (s) => s }) },
        adapter, apiKey: 'k', apiUrl: '', modelId: 'model-1', turnSignal: new AbortController().signal,
        aborted: () => false, send: () => {},
        notebookId: 'nb-1', userId: 'u1', userOrgForTiers: 'org-1', docShield: null, orgShieldConfig: null,
    }));
    assert.strictEqual(out.fullContent, 'An answer.');
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.source, 'notebook_chat');
    assert.strictEqual(row.user_id, 'u1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.model, 'model-1');
    assert.strictEqual(row.conversation_id, 'nb-1');
    assert.strictEqual(row.prompt_tokens, 40);
    assert.strictEqual(row.completion_tokens, 6);
    assert.notStrictEqual(areaOf(row.source), 'other');
});
