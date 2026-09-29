/**
 * Notebook tool cross-user regression tests.
 *
 * The notebook tools resolve a client-supplied `conversationId` against
 * agent_conversations / direct_conversations BY ID ALONE, then persist as the
 * ROW's owner. The only thing separating a caller from another user's notebook
 * is denyIfCrossUser — and it used to short-circuit on a falsy callerUserId,
 * which the tool dispatcher never supplied. That made the guard permanently
 * inert.
 *
 * These tests lock both halves:
 *   1. a missing caller identity is a DENIAL, not a pass (fail closed);
 *   2. a caller who is not the owner is denied.
 *
 * The dispatcher side (that it forwards `userId` at all) is covered in
 * core/toolDispatcher.notebookAuthz.test.js.
 *
 * Run: node --test integrations/workspaceTools.crossUser.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// The conversation row belongs to `owner`. getWorkspace finds it by id alone,
// exactly as production does.
const state = {
    row: { workspace_content: 'bob private notes', workspace_notebook_id: null, user_id: 'owner' },
    writes: 0,
};

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        getOne: async () => state.row,
        run: async () => { state.writes++; return { rowCount: 1 }; },
        getAll: async () => [],
        exec: async () => undefined,
    },
};

const notebookStorePath = require.resolve('../stores/notebookStore');
require.cache[notebookStorePath] = {
    id: notebookStorePath,
    filename: notebookStorePath,
    loaded: true,
    exports: {
        getNotebook: async () => ({ documentContent: 'bob private notes' }),
        updateNotebook: async () => { state.writes++; return true; },
    },
};

const { executeWorkspaceTool } = require('./workspaceTools');

function assertDenied(r, label) {
    assert.ok(r && typeof r.error === 'string', `${label}: expected an error result, got ${JSON.stringify(r)}`);
    assert.match(r.error, /different user/i, `${label}: expected a cross-user refusal`);
}

// ── 1. Missing caller identity must fail CLOSED ───────────────────
test('notebook_read with no caller identity is denied', async () => {
    state.writes = 0;
    const r = await executeWorkspaceTool('notebook_read', {}, { conversationId: 'c-owner' });
    assertDenied(r, 'notebook_read/no-caller');
    assert.ok(!('content' in r), 'no content may leak on a denied read');
});

test('notebook_write with no caller identity is denied and persists nothing', async () => {
    state.writes = 0;
    const r = await executeWorkspaceTool('notebook_write', { content: 'overwritten' }, { conversationId: 'c-owner' });
    assertDenied(r, 'notebook_write/no-caller');
    assert.strictEqual(state.writes, 0, 'a denied write must not touch the database');
});

test('notebook_replace with no caller identity is denied and persists nothing', async () => {
    state.writes = 0;
    const r = await executeWorkspaceTool('notebook_replace', { find_text: 'bob', replace_text: 'mallory' }, { conversationId: 'c-owner' });
    assertDenied(r, 'notebook_replace/no-caller');
    assert.strictEqual(state.writes, 0, 'a denied replace must not touch the database');
});

test('notebook_insert with no caller identity is denied and persists nothing', async () => {
    state.writes = 0;
    const r = await executeWorkspaceTool('notebook_insert', { content: 'x', position: 'end' }, { conversationId: 'c-owner' });
    assertDenied(r, 'notebook_insert/no-caller');
    assert.strictEqual(state.writes, 0, 'a denied insert must not touch the database');
});

// ── 2. A non-owner caller is denied ───────────────────────────────
test('notebook_read by a non-owner is denied', async () => {
    state.writes = 0;
    const r = await executeWorkspaceTool('notebook_read', {}, { conversationId: 'c-owner', userId: 'mallory' });
    assertDenied(r, 'notebook_read/non-owner');
});

test('notebook_write by a non-owner is denied and persists nothing', async () => {
    state.writes = 0;
    const r = await executeWorkspaceTool('notebook_write', { content: 'overwritten' }, { conversationId: 'c-owner', userId: 'mallory' });
    assertDenied(r, 'notebook_write/non-owner');
    assert.strictEqual(state.writes, 0, 'a denied write must not touch the database');
});

// ── 3. The owner still works (no over-blocking) ───────────────────
test('the owner can still read and write', async () => {
    state.writes = 0;
    const r = await executeWorkspaceTool('notebook_read', {}, { conversationId: 'c-owner', userId: 'owner' });
    assert.strictEqual(r.error, undefined, `owner read must succeed, got ${JSON.stringify(r)}`);

    const w = await executeWorkspaceTool('notebook_write', { content: 'owner edit' }, { conversationId: 'c-owner', userId: 'owner' });
    assert.strictEqual(w.error, undefined, `owner write must succeed, got ${JSON.stringify(w)}`);
    assert.ok(state.writes > 0, 'the owner write must reach the database');
});
