/**
 * Unit tests for syncClientWorkspaceContent (BFSF-287).
 *
 * Run: node --test integrations/workspaceTools.syncClient.test.js
 *
 * Seed-on-entry copies the live client editor content into the SAME store the
 * notebook tools read (notebooks.document_content when a notebook is linked,
 * else the conversation's workspace_content column) so the agent builds on the
 * user's current edits instead of its own last write. These tests assert the
 * routing, the no-op-when-unchanged guard, the empty/cross-user/no-row guards,
 * and that no expectedVersion (CAS) is passed.
 *
 * No DB needed — we stub `../db` and `../stores/notebookStore` via require.cache
 * (same trick as workspaceTools.test.js), but here the stubs RECORD their calls
 * so we can assert which store was written.
 */

const { test } = require('node:test');
const assert = require('node:assert');

// Mutable stub state + recorded calls, reset by resetState() before each test.
const state = {
    agentRow: null,        // row returned for the agent_conversations lookup
    directRow: null,       // row returned for the direct_conversations lookup
    notebook: null,        // notebookStore.getNotebook result
    updateNotebookResult: true,
    runRowCount: 1,
};
const calls = {
    getOne: [],
    run: [],
    getNotebook: [],
    updateNotebook: [],
};

function resetState(next = {}) {
    state.agentRow = next.agentRow ?? null;
    state.directRow = next.directRow ?? null;
    state.notebook = next.notebook ?? null;
    state.updateNotebookResult = next.updateNotebookResult ?? true;
    state.runRowCount = next.runRowCount ?? 1;
    calls.getOne = [];
    calls.run = [];
    calls.getNotebook = [];
    calls.updateNotebook = [];
}

// Stub ../db (lazy-required inside syncClientWorkspaceContent).
const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        getOne: async (sql, params) => {
            calls.getOne.push({ sql, params });
            if (sql.includes('agent_conversations')) return state.agentRow;
            if (sql.includes('direct_conversations')) return state.directRow;
            return null;
        },
        run: async (sql, params) => {
            calls.run.push({ sql, params });
            return { rowCount: state.runRowCount };
        },
    },
};

// Stub ../stores/notebookStore.
const notebookStorePath = require.resolve('../stores/notebookStore');
require.cache[notebookStorePath] = {
    id: notebookStorePath,
    filename: notebookStorePath,
    loaded: true,
    exports: {
        getNotebook: async (id, userId) => {
            calls.getNotebook.push({ id, userId });
            return state.notebook;
        },
        updateNotebook: async (id, userId, updates) => {
            calls.updateNotebook.push({ id, userId, updates });
            return state.updateNotebookResult;
        },
    },
};

const { syncClientWorkspaceContent } = require('./workspaceTools');

// ── 1. Linked + changed → writes to notebooks.document_content ──────────
test('linked notebook, content changed → updateNotebook once, no run, no CAS', async () => {
    resetState({
        agentRow: { workspace_content: 'x', workspace_notebook_id: 'nb1', user_id: 'u1' },
        notebook: { documentContent: 'old' },
        updateNotebookResult: true,
    });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: true, reason: 'linked' });
    assert.strictEqual(calls.updateNotebook.length, 1, 'updateNotebook called once');
    assert.deepStrictEqual(calls.updateNotebook[0], { id: 'nb1', userId: 'u1', updates: { documentContent: 'new' } });
    assert.ok(!('expectedVersion' in calls.updateNotebook[0].updates), 'no expectedVersion (last-writer-wins)');
    assert.strictEqual(calls.run.length, 0, 'legacy column never touched for a linked notebook');
    assert.deepStrictEqual(calls.getNotebook[0], { id: 'nb1', userId: 'u1' }, 'notebook read under owner user_id');
});

// ── 2. Linked + unchanged → no-op ──────────────────────────────────────
test('linked notebook, content unchanged → no write', async () => {
    resetState({
        agentRow: { workspace_content: 'x', workspace_notebook_id: 'nb1', user_id: 'u1' },
        notebook: { documentContent: 'same' },
    });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'same');
    assert.deepStrictEqual(r, { seeded: false, reason: 'unchanged' });
    assert.strictEqual(calls.updateNotebook.length, 0, 'no version bump when content equals stored');
    assert.strictEqual(calls.run.length, 0);
});

// ── 3. Non-linked + changed → writes workspace_content ─────────────────
test('non-linked, content changed → UPDATE workspace_content scoped by user_id', async () => {
    resetState({
        agentRow: { workspace_content: 'old', workspace_notebook_id: null, user_id: 'u1' },
        runRowCount: 1,
    });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: true, reason: 'legacy' });
    assert.strictEqual(calls.updateNotebook.length, 0, 'no notebook store write on the legacy path');
    assert.strictEqual(calls.run.length, 1, 'one UPDATE issued');
    assert.match(calls.run[0].sql, /UPDATE agent_conversations SET workspace_content/);
    assert.match(calls.run[0].sql, /WHERE id = \$2 AND user_id = \$3/);
    assert.deepStrictEqual(calls.run[0].params, ['new', 'conv-1', 'u1']);
});

// ── 4. Non-linked + unchanged → no-op ──────────────────────────────────
test('non-linked, content unchanged → no write', async () => {
    resetState({
        agentRow: { workspace_content: 'same', workspace_notebook_id: null, user_id: 'u1' },
    });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'same');
    assert.deepStrictEqual(r, { seeded: false, reason: 'unchanged' });
    assert.strictEqual(calls.run.length, 0);
});

// ── 5. Empty / whitespace content → never wipes, no DB access ──────────
test('empty content → no DB access, not seeded', async () => {
    resetState({ agentRow: { workspace_notebook_id: 'nb1', user_id: 'u1' } });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', '   ');
    assert.deepStrictEqual(r, { seeded: false, reason: 'empty' });
    assert.strictEqual(calls.getOne.length, 0, 'guarded before any query');
    assert.strictEqual(calls.updateNotebook.length, 0);
    assert.strictEqual(calls.run.length, 0);
});

// ── 6. Cross-user → blocked ────────────────────────────────────────────
test('caller does not own the conversation → blocked, no write', async () => {
    resetState({
        agentRow: { workspace_content: 'old', workspace_notebook_id: 'nb1', user_id: 'u2' },
    });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: false, reason: 'cross-user' });
    assert.strictEqual(calls.updateNotebook.length, 0);
    assert.strictEqual(calls.run.length, 0);
});

// ── 7. No conversation row in either table → not seeded ────────────────
test('no row found → not seeded', async () => {
    resetState({ agentRow: null, directRow: null });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: false, reason: 'no-row' });
    assert.strictEqual(calls.getOne.length, 2, 'tried agent then direct');
});

// ── 8. Direct-conversation fallback routing ────────────────────────────
test('agent lookup empty → falls back to direct_conversations', async () => {
    resetState({
        agentRow: null,
        directRow: { workspace_content: 'old', workspace_notebook_id: null, user_id: 'u1' },
        runRowCount: 1,
    });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: true, reason: 'legacy' });
    assert.strictEqual(calls.run.length, 1);
    assert.match(calls.run[0].sql, /UPDATE direct_conversations SET workspace_content/);
    assert.deepStrictEqual(calls.run[0].params, ['new', 'conv-1', 'u1']);
});

// ── 9. No conversationId → guarded early ───────────────────────────────
test('missing conversationId → not seeded', async () => {
    resetState({});
    const r = await syncClientWorkspaceContent('', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: false, reason: 'no-conversation' });
    assert.strictEqual(calls.getOne.length, 0);
});
