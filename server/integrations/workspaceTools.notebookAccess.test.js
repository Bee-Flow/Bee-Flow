/**
 * The chat's notebook tools on a notebook linked to the conversation
 * (integrations/workspaceTools.js), over the REAL notebook store (PGlite)
 * and the real co-editing engine (core/collab/collab.testkit).
 *
 *   - the link is only an id the conversation's owner sent: it grants
 *     nothing. A project viewer who links a co-edited notebook to their own
 *     chat cannot have the AI write it, and someone with no role on it can
 *     neither read nor write it (the co-editing engine is a trusted server
 *     facade that checks no one, and the write used to go straight in);
 *   - on a co-edited notebook the tools read the LIVE document, not the row's
 *     mirror (which lags typing by minutes), and write only their own change:
 *     an insert used to rebuild the whole document from the stale mirror and
 *     take colleagues' recent typing out of every editor;
 *   - a whole-document notebook_write goes in only from the live update the
 *     model read (the revision notebook_read hands out): it used to rebase
 *     onto the text read at write time and silently undo typing since.
 *
 * Run: cd server && node --test integrations/workspaceTools.notebookAccess.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Y = require('yjs');

const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');
const { collabWorld, typeInto } = require('../core/collab/collab.testkit');

const { pg, close } = usePglitePool();
const projectRole = require('../stores/lib/projectRole');
const store = require('../stores/notebookStore');
const workspaceTools = require('./workspaceTools');

const { swap, restore } = makeSwaps();
const ROLES = { 'p1:erin': 'editor', 'p1:vic': 'viewer' };

let w;
let nb;

before(async () => {
    swap(projectRole.lookup, 'roleOf', async (userId, projectId) => ROLES[`${projectId}:${userId}`] || null);
    await pg.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('p1');
        CREATE TABLE agent_conversations (id TEXT PRIMARY KEY, user_id TEXT, workspace_content TEXT, workspace_notebook_id TEXT, updated_at TIMESTAMPTZ);
        CREATE TABLE direct_conversations (id TEXT PRIMARY KEY, user_id TEXT, workspace_content TEXT, workspace_notebook_id TEXT, updated_at TIMESTAMPTZ);
    `);
    await store.initDB();
});
after(async () => { restore(); await close(); });

beforeEach(async () => {
    w = await collabWorld();
    swap(workspaceTools.seams, 'collab', () => w.collab);
    await pg.exec('DELETE FROM direct_conversations');
    // alice's project notebook; its row mirror is empty (co-editing has not materialised yet).
    nb = await store.createNotebook({ userId: 'alice', name: 'Plan', projectId: 'p1', organizationId: 'org1' });
});
afterEach(async () => { await w.close(); });

/** The notebook, co-edited: `type(block, at, text)` is bob typing in his editor. */
async function coEdit(html) {
    w.addResource('notebook', nb.id, { html });
    const { docId } = await w.collab.openDoc({ projectId: 'p1', userId: 'bob', role: 'editor', kind: 'notebook', resourceId: nb.id });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from((await w.collab.sync({ projectId: 'p1', docId, sv: '', role: 'editor' })).update, 'base64'), 'remote');
    return (block, at, text) => {
        const updates = [];
        const keep = (u, origin) => { if (origin !== 'remote') updates.push(Buffer.from(u).toString('base64')); };
        doc.on('update', keep);
        typeInto(doc, block, at, text);
        doc.off('update', keep);
        return w.collab.applyClientUpdates({ projectId: 'p1', docId, userId: 'bob', clientId: doc.clientID, updates });
    };
}

/** `userId`'s own direct chat, with the notebook linked to it. */
async function chatOf(userId) {
    await pg.query('INSERT INTO direct_conversations (id, user_id, workspace_content, workspace_notebook_id) VALUES ($1, $2, $3, $4)',
        [`c-${userId}`, userId, '', nb.id]);
    return (tool, args) => workspaceTools.executeWorkspaceTool(tool, args, { conversationId: `c-${userId}`, userId });
}

const live = () => w.collab.readMarkdown('notebook', nb.id);

test('a project viewer who links a co-edited notebook to their own chat cannot have the AI write it', async () => {
    await coEdit('<p>Team plan.</p>');
    const asVic = await chatOf('vic');
    for (const [tool, args] of [
        ['notebook_write', { content: 'Overwritten by vic.' }],
        ['notebook_insert', { content: 'Appended by vic.', position: 'end' }],
        ['notebook_replace', { find_text: 'Team plan.', replace_text: 'Vic plan.' }],
    ]) {
        const r = await asVic(tool, args);
        assert.match(r.error || '', /can view the linked notebook but not change it/, tool);
        assert.strictEqual(r._action, undefined, `${tool}: nothing sent to the pane`);
    }
    assert.strictEqual(await live(), 'Team plan.', 'the live notebook is untouched');
    const read = await asVic('notebook_read', { mode: 'full' });
    assert.strictEqual(read.content, 'Team plan.', 'reading stays allowed');
});

test('someone with no role on the notebook can neither read nor write it through a linked chat', async () => {
    await coEdit('<p>Team plan.</p>');
    const asZed = await chatOf('zed');
    const write = await asZed('notebook_write', { content: 'Overwritten by zed.' });
    assert.match(write.error || '', /not accessible/);
    const insert = await asZed('notebook_insert', { content: 'x', position: 'end' });
    assert.match(insert.error || '', /not accessible/);
    const read = await asZed('notebook_read', { mode: 'full' });
    assert.match(read.error || '', /not accessible/);
    assert.strictEqual(read.content, undefined);
    assert.strictEqual(await live(), 'Team plan.');
});

test('an editor\'s insert reads the live document and keeps what colleagues typed since the mirror was written', async () => {
    const type = await coEdit('<p>Intro.</p>');
    await type(0, 6, ' Typed by bob a minute ago.');
    await type(1, 0, 'Second paragraph by bob.');
    const asErin = await chatOf('erin');

    const read = await asErin('notebook_read', { mode: 'full' });
    assert.strictEqual(read.content, 'Intro. Typed by bob a minute ago.\n\nSecond paragraph by bob.', 'the live text, not the stale mirror');

    const r = await asErin('notebook_insert', { content: 'Summary by the AI.', position: 'end' });
    assert.strictEqual(r._action, 'workspace_update', r.error);
    assert.strictEqual(await live(), 'Intro. Typed by bob a minute ago.\n\nSecond paragraph by bob.\n\nSummary by the AI.');
});

test('a full notebook_write never takes out what a colleague typed after the model read the notebook', async () => {
    const type = await coEdit('<p>Intro.</p><p>Budget line.</p>');
    const asErin = await chatOf('erin');
    const read = await asErin('notebook_read', { mode: 'full' });
    assert.strictEqual(read.content, 'Intro.\n\nBudget line.');
    assert.match(read.revision || '', /^live:\d+$/, 'a live read names the update it was made at');

    // bob types after the model read, before it writes its rewrite.
    await type(1, 12, ' Anna typed this.');
    const stale = await asErin('notebook_write', { content: 'Intro, rewritten by AI.\n\nBudget line.', revision: read.revision });
    assert.match(stale.error || '', /changed since you read it/);
    assert.strictEqual(stale._action, undefined, 'nothing sent to the pane');
    assert.strictEqual(await live(), 'Intro.\n\nBudget line. Anna typed this.', 'the colleague\'s typing stays in every editor');

    const blind = await asErin('notebook_write', { content: 'Intro, rewritten by AI.\n\nBudget line.' });
    assert.match(blind.error || '', /needs the revision notebook_read returns/, 'a whole write without a revision is refused');
    assert.strictEqual(await live(), 'Intro.\n\nBudget line. Anna typed this.');

    const again = await asErin('notebook_read', { mode: 'full' });
    const ok = await asErin('notebook_write', { content: 'Intro, rewritten by AI.\n\nBudget line. Anna typed this.', revision: again.revision });
    assert.strictEqual(ok._action, 'workspace_update', ok.error);
    assert.strictEqual(await live(), 'Intro, rewritten by AI.\n\nBudget line. Anna typed this.');
    const next = await asErin('notebook_write', { content: 'Intro, twice.\n\nBudget line. Anna typed this.', revision: ok.revision });
    assert.strictEqual(next._action, 'workspace_update', 'its own write names the revision a next whole write goes from');
});

test('linking a notebook to a chat takes edit rights on it', async () => {
    assert.strictEqual(await workspaceTools.notebookLinkRefusal(nb.id, 'alice'), null, 'the owner');
    assert.strictEqual(await workspaceTools.notebookLinkRefusal(nb.id, 'erin'), null, 'a project editor');
    assert.deepStrictEqual((await workspaceTools.notebookLinkRefusal(nb.id, 'vic'))?.status, 403, 'a project viewer');
    assert.deepStrictEqual((await workspaceTools.notebookLinkRefusal(nb.id, 'zed'))?.status, 404, 'no role at all');
    assert.strictEqual(await workspaceTools.notebookLinkRefusal(null, 'zed'), null, 'unlinking needs nothing');
});
