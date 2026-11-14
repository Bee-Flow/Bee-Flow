// @typecheck
/**
 * syncClientWorkspaceContent: seed-on-entry copies the live client editor
 * content into the SAME store the notebook tools read (notebooks.document_content
 * when a notebook is linked, else the conversation's workspace_content column)
 * so the agent builds on the user's current edits instead of its own last
 * write. These tests pin the routing, the no-op-when-unchanged guard, the
 * empty/cross-user/no-row guards, and last-writer-wins on the notebook.
 *
 * Against a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js) behind db.js's pool, with the real notebook
 * store, recorded by testUtils/routeHarness.js so "no DB access" is a fact.
 *
 * Run: node --test integrations/workspaceTools.syncClient.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');
const { recordDb } = require('../testUtils/routeHarness');

const pg = ladderPglite();
const rec = recordDb(undefined, { pg });
const notebookStore = require('../stores/notebookStore');
const { syncClientWorkspaceContent } = require('./workspaceTools');

before(() => notebookStore.initDB());
after(() => pg.close());
beforeEach(async () => {
    await pg.exec('TRUNCATE agent_conversations, direct_conversations, notebooks, agents CASCADE');
    await insertRow(pg, 'agents', { id: 'ag', name: 'A', owner_id: 'u1' });
    rec.reset();
});

const agentConv = (over) => insertRow(pg, 'agent_conversations', { id: 'conv-1', agent_id: 'ag', user_id: 'u1', workspace_content: 'x', ...over });
const directConv = (over) => insertRow(pg, 'direct_conversations', { id: 'conv-1', user_id: 'u1', workspace_content: 'x', ...over });
const notebookRow = async (id) => (await pg.query('SELECT * FROM notebooks WHERE id = $1', [id])).rows[0];
const convRow = async (table) => (await pg.query(`SELECT * FROM ${table} WHERE id = 'conv-1'`)).rows[0];

/** A notebook of u1 holding `content`. */
async function notebook(content) {
    const nb = await notebookStore.createNotebook({ userId: 'u1', name: 'N' });
    await notebookStore.updateNotebook(nb.id, 'u1', { documentContent: content });
    return nb.id;
}

test('linked notebook, content changed → written to the notebook, the legacy column untouched', async () => {
    const nb = await notebook('old');
    await agentConv({ workspace_notebook_id: nb });
    const before = await notebookRow(nb);
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: true, reason: 'linked' });
    assert.strictEqual((await notebookStore.getNotebook(nb, 'u1')).documentContent, 'new');
    assert.ok((await notebookRow(nb)).version > before.version, 'a normal notebook write: the version moves');
    assert.strictEqual((await convRow('agent_conversations')).workspace_content, 'x', 'legacy column never touched for a linked notebook');
});

test('linked notebook: last writer wins over a version the client never saw', async () => {
    const nb = await notebook('old');
    await agentConv({ workspace_notebook_id: nb });
    // Someone else wrote in between: no version check stands in the way.
    await notebookStore.updateNotebook(nb, 'u1', { documentContent: 'someone else' });
    assert.deepStrictEqual(await syncClientWorkspaceContent('conv-1', 'u1', 'mine'), { seeded: true, reason: 'linked' });
    assert.strictEqual((await notebookStore.getNotebook(nb, 'u1')).documentContent, 'mine');
});

test('linked notebook, content unchanged → no write', async () => {
    const nb = await notebook('same');
    await agentConv({ workspace_notebook_id: nb });
    const before = await notebookRow(nb);
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'same');
    assert.deepStrictEqual(r, { seeded: false, reason: 'unchanged' });
    assert.deepStrictEqual(await notebookRow(nb), before, 'no version bump when content equals stored');
});

test('a linked notebook that is gone → not seeded, nothing written', async () => {
    await agentConv({ workspace_notebook_id: 'nb-gone' });
    assert.deepStrictEqual(await syncClientWorkspaceContent('conv-1', 'u1', 'new'), { seeded: false, reason: 'notebook-missing' });
    assert.strictEqual((await convRow('agent_conversations')).workspace_content, 'x');
});

test('non-linked, content changed → workspace_content of that conversation, for its owner', async () => {
    await agentConv({ workspace_content: 'old' });
    await insertRow(pg, 'agent_conversations', { id: 'conv-2', agent_id: 'ag', user_id: 'u1', workspace_content: 'other' });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: true, reason: 'legacy' });
    assert.strictEqual((await convRow('agent_conversations')).workspace_content, 'new');
    assert.strictEqual((await pg.query(`SELECT workspace_content FROM agent_conversations WHERE id = 'conv-2'`)).rows[0].workspace_content, 'other');
    assert.deepStrictEqual((await pg.query('SELECT count(*)::int AS n FROM notebooks')).rows[0].n, 0, 'no notebook store write on the legacy path');
});

test('non-linked, content unchanged → no write', async () => {
    const before = await agentConv({ workspace_content: 'same', updated_at: '2026-01-01T00:00:00Z' });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'same');
    assert.deepStrictEqual(r, { seeded: false, reason: 'unchanged' });
    assert.deepStrictEqual(await convRow('agent_conversations'), before);
});

test('empty content → no DB access, not seeded', async () => {
    await agentConv({ workspace_notebook_id: 'nb1' });
    rec.reset();
    const r = await syncClientWorkspaceContent('conv-1', 'u1', '   ');
    assert.deepStrictEqual(r, { seeded: false, reason: 'empty' });
    assert.deepStrictEqual(rec.queries, [], 'guarded before any query');
});

test('caller does not own the conversation → blocked, no write', async () => {
    const nb = await notebook('old');
    await agentConv({ user_id: 'u2', workspace_content: 'old', workspace_notebook_id: nb });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: false, reason: 'cross-user' });
    assert.strictEqual((await notebookStore.getNotebook(nb, 'u1')).documentContent, 'old');
    assert.strictEqual((await convRow('agent_conversations')).workspace_content, 'old');
});

test('no row found → not seeded', async () => {
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: false, reason: 'no-row' });
    assert.strictEqual(rec.queries.length, 2, 'tried agent then direct');
});

test('agent lookup empty → falls back to direct_conversations', async () => {
    await directConv({ workspace_content: 'old' });
    const r = await syncClientWorkspaceContent('conv-1', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: true, reason: 'legacy' });
    assert.strictEqual((await convRow('direct_conversations')).workspace_content, 'new');
});

test('missing conversationId → not seeded', async () => {
    const r = await syncClientWorkspaceContent('', 'u1', 'new');
    assert.deepStrictEqual(r, { seeded: false, reason: 'no-conversation' });
    assert.deepStrictEqual(rec.queries, []);
});
