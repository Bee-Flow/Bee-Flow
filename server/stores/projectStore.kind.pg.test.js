/**
 * projects.kind — the split between collaborative projects ('workspace') and
 * Studio Solutions ('solution') — against a real Postgres (@electric-sql/pglite).
 *
 * The store is built with `makeProjectStore` over a pglite facade of db.js's
 * shape, and the schema is the store's own `applyProjectSchema`, so what runs
 * here is the production SQL with no module replaced.
 *
 * Pinned:
 *   - the schema applies twice without an error, and the CHECK refuses a kind
 *     that is neither of the two;
 *   - a new project is a workspace unless it says otherwise, and a legacy row
 *     (kind NULL) reads as `kind: null`;
 *   - the listing narrows by kind and keeps legacy rows on BOTH sides, for
 *     owned, user-shared and group-shared projects alike, and without a kind
 *     it lists everything (the access paths rely on that);
 *   - a legacy project is classified once, never re-classified; a kind the
 *     backfill GUESSED (`kind_guessed`) the owner may correct once, and then
 *     it is theirs;
 *   - the files knowledge base is recorded by the first writer only;
 *   - shared conversations are counted and listed (ids and owners only),
 *     and deleting a project that still has one is refused by the database
 *     itself — which is why the delete route asks for the unshare first;
 *   - a caller reads where their OWN conversation is filed, never another's;
 *   - the chats a Solution cannot hold are counted (filed conversations and
 *     team chats);
 *   - an owner who goes away hands the project to its longest-standing editor, and to nobody
 *     else: viewers and groups do not inherit it.
 *
 * Run: cd server && node --test stores/projectStore.kind.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { makeProjectStore, applyProjectSchema } = require('./projectStore');

/** PGlite's result in node-postgres's shape. */
function asPgResult(r) {
    const rows = r.rows || [];
    return { rows, rowCount: typeof r.affectedRows === 'number' ? r.affectedRows : rows.length };
}

/** The slice of db.js the store uses, over one PGlite connection. */
function facadeFor(pg) {
    const query = async (sql, params) => asPgResult(
        params && params.length ? await pg.query(sql, params) : await pg.query(sql),
    );
    return {
        run: query,
        getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
        getAll: async (sql, params) => (await query(sql, params)).rows,
        getClient: async () => ({ query, release() {} }),
        exec: (sql) => pg.exec(sql),
    };
}

/** runDdl's contract without its lock plumbing: every statement, in order. */
async function runStatements(pg, statements) {
    for (const stmt of statements) await pg.exec(typeof stmt === 'string' ? stmt : stmt.sql);
}

async function applySchema(pg) {
    await applyProjectSchema({
        exec: (sql) => pg.exec(sql),
        runDdl: (_tag, statements) => runStatements(pg, statements),
    });
}

// The two conversation tables as stores/agent/initSchema.js shapes the part
// that matters here: the FK that clears project_id on delete, and the CHECK
// that a shared conversation keeps its project.
const CONVERSATIONS = ['direct_conversations', 'agent_conversations'].map((t) => `
    CREATE TABLE ${t} (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        shared_scope TEXT NOT NULL DEFAULT 'private',
        shared_at TIMESTAMPTZ
    );
    ALTER TABLE ${t} ADD CONSTRAINT ${t}_project_fk
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
    ALTER TABLE ${t} ADD CONSTRAINT ${t}_shared_needs_project
        CHECK (shared_scope = 'private' OR project_id IS NOT NULL);
`).join('\n');

let pg;
let store;

before(async () => {
    pg = new PGlite();
    await applySchema(pg);
    await pg.exec(CONVERSATIONS);
    // Team chats, reduced to the column the count reads.
    await pg.exec(`CREATE TABLE project_chats (id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE)`);
    store = makeProjectStore(facadeFor(pg));
});

after(async () => { await pg.close(); });

async function kindColumn(id) {
    const r = await pg.query('SELECT kind FROM projects WHERE id = $1', [id]);
    return r.rows[0] ? r.rows[0].kind : undefined;
}

async function insertLegacy(id, ownerId, orgId = 'org1') {
    await pg.query(
        `INSERT INTO projects (id, name, owner_id, organization_id) VALUES ($1, $2, $3, $4)`,
        [id, `Legacy ${id}`, ownerId, orgId],
    );
}

// ── Schema ───────────────────────────────────────────────────────────

test('the schema applies a second time without an error', async () => {
    await applySchema(pg);
    const cols = await pg.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name IN ('kind', 'files_kb_id') ORDER BY column_name`,
    );
    assert.deepStrictEqual(cols.rows.map((r) => r.column_name), ['files_kb_id', 'kind']);
});

test('the database refuses a kind that is neither workspace nor solution', async () => {
    await assert.rejects(
        pg.query(`INSERT INTO projects (id, name, owner_id, kind) VALUES ('bad', 'Bad', 'alice', 'folder')`),
        (err) => err.code === '23514',
    );
});

test('a new column leaves existing rows unclassified (NULL), not defaulted', async () => {
    await insertLegacy('legacy-default', 'alice');
    assert.strictEqual(await kindColumn('legacy-default'), null);
    assert.strictEqual((await store.getProject('legacy-default')).kind, null);
});

// ── Create / read ────────────────────────────────────────────────────

test('a new project is a workspace unless it says otherwise', async () => {
    const plain = await store.createProject({ name: 'Team', ownerId: 'alice', organizationId: 'org1' });
    assert.strictEqual(plain.kind, 'workspace');
    assert.strictEqual(await kindColumn(plain.id), 'workspace');

    const sol = await store.createProject({ name: 'Invoicing', ownerId: 'alice', organizationId: 'org1', kind: 'solution' });
    assert.strictEqual(sol.kind, 'solution');
    const read = await store.getProject(sol.id);
    assert.strictEqual(read.kind, 'solution');
    assert.strictEqual(read.filesKbId, null);
});

test('an unknown kind is refused before anything is written', async () => {
    const before_ = (await pg.query('SELECT COUNT(*)::int AS n FROM projects')).rows[0].n;
    await assert.rejects(
        store.createProject({ name: 'X', ownerId: 'alice', kind: 'folder' }),
        /workspace' or 'solution'/,
    );
    const after_ = (await pg.query('SELECT COUNT(*)::int AS n FROM projects')).rows[0].n;
    assert.strictEqual(after_, before_);
});

// ── Listing by kind ──────────────────────────────────────────────────

test('the listing narrows by kind and keeps legacy rows on both sides', async () => {
    const ws = await store.createProject({ name: 'Carol team', ownerId: 'carol', organizationId: 'org2' });
    const sol = await store.createProject({ name: 'Carol solution', ownerId: 'carol', organizationId: 'org2', kind: 'solution' });
    await insertLegacy('carol-legacy', 'carol', 'org2');
    // Shared with carol by someone else: one workspace per user share, one
    // Solution through a group, one legacy through a group.
    const sharedWs = await store.createProject({ name: 'Dave team', ownerId: 'dave', organizationId: 'org2' });
    const sharedSol = await store.createProject({ name: 'Dave solution', ownerId: 'dave', organizationId: 'org2', kind: 'solution' });
    await insertLegacy('dave-legacy', 'dave', 'org2');
    await store.shareProject(sharedWs.id, 'user', 'carol', 'editor');
    await store.shareProject(sharedSol.id, 'group', 'grp-sales', 'viewer');
    await store.shareProject('dave-legacy', 'group', 'grp-sales', 'viewer');
    // Not carol's at all.
    await store.createProject({ name: 'Erin team', ownerId: 'erin', organizationId: 'org2' });

    const ids = (rows) => rows.map((r) => r.id).sort();

    const workspaces = await store.listUserProjects('carol', ['grp-sales'], { kind: 'workspace' });
    assert.deepStrictEqual(ids(workspaces), [ws.id, 'carol-legacy', sharedWs.id, 'dave-legacy'].sort());

    const solutions = await store.listUserProjects('carol', ['grp-sales'], { kind: 'solution' });
    assert.deepStrictEqual(ids(solutions), [sol.id, 'carol-legacy', sharedSol.id, 'dave-legacy'].sort());

    const everything = await store.listUserProjects('carol', ['grp-sales']);
    assert.deepStrictEqual(ids(everything),
        [ws.id, sol.id, 'carol-legacy', sharedWs.id, sharedSol.id, 'dave-legacy'].sort(),
        'without a kind the listing is every project the user can reach');

    const byId = Object.fromEntries(everything.map((r) => [r.id, r]));
    assert.strictEqual(byId[ws.id].kind, 'workspace');
    assert.strictEqual(byId[sol.id].kind, 'solution');
    assert.strictEqual(byId['carol-legacy'].kind, null);
    assert.strictEqual(byId[ws.id].permission, 'owner');
    assert.strictEqual(byId[sharedWs.id].permission, 'editor');
    assert.strictEqual(byId[sharedSol.id].permission, 'viewer');
});

test('without the group the group-shared rows are not listed, whatever the kind', async () => {
    const rows = await store.listUserProjects('carol', [], { kind: 'solution' });
    assert.ok(rows.every((r) => r.ownerId === 'carol'), JSON.stringify(rows.map((r) => r.id)));
});

test('an unknown kind filter is refused rather than ignored', async () => {
    await assert.rejects(store.listUserProjects('carol', [], { kind: 'folder' }), /workspace' or 'solution'/);
});

// ── Classifying a legacy project ─────────────────────────────────────

test('a legacy project is classified once', async () => {
    await insertLegacy('to-classify', 'alice');
    const versionBefore = (await pg.query('SELECT version FROM projects WHERE id = $1', ['to-classify'])).rows[0].version;

    const done = await store.setProjectKind('to-classify', 'workspace');
    assert.strictEqual(done.kind, 'workspace');
    assert.strictEqual(await kindColumn('to-classify'), 'workspace');
    const versionAfter = (await pg.query('SELECT version FROM projects WHERE id = $1', ['to-classify'])).rows[0].version;
    assert.strictEqual(versionAfter, versionBefore, 'an open settings form does not get a conflict from this');

    assert.strictEqual(await store.setProjectKind('to-classify', 'solution'), null, 'already classified');
    assert.strictEqual(await kindColumn('to-classify'), 'workspace', 'and unchanged');
});

test('a classified project is never re-classified, and a missing one reads as null', async () => {
    const sol = await store.createProject({ name: 'S', ownerId: 'alice', kind: 'solution' });
    assert.strictEqual(await store.setProjectKind(sol.id, 'workspace'), null);
    assert.strictEqual(await store.setProjectKind('no-such-project', 'workspace'), null);
    await assert.rejects(store.setProjectKind(sol.id, 'folder'), /workspace' or 'solution'/);
});

test('a kind the backfill guessed is the owner\'s to correct, once', async () => {
    await insertLegacy('guessed', 'alice');
    await pg.query(`UPDATE projects SET kind = 'solution', kind_guessed = TRUE WHERE id = 'guessed'`);
    const read = await store.getProject('guessed');
    assert.strictEqual(read.kind, 'solution');
    assert.strictEqual(read.kindGuessed, true, 'the page can offer the correction');

    const corrected = await store.setProjectKind('guessed', 'workspace');
    assert.strictEqual(corrected.kind, 'workspace');
    assert.strictEqual(corrected.kindGuessed, false, 'now the owner\'s answer');
    assert.strictEqual(await store.setProjectKind('guessed', 'solution'), null, 'and only once');
    assert.strictEqual(await kindColumn('guessed'), 'workspace');

    // Confirming the guess also makes it the owner's.
    await insertLegacy('confirmed', 'alice');
    await pg.query(`UPDATE projects SET kind = 'workspace', kind_guessed = TRUE WHERE id = 'confirmed'`);
    assert.strictEqual((await store.setProjectKind('confirmed', 'workspace')).kindGuessed, false);
    assert.strictEqual(await store.setProjectKind('confirmed', 'solution'), null);
});

test('a project made after the split is never a guess', async () => {
    const p = await store.createProject({ name: 'New', ownerId: 'alice' });
    assert.strictEqual(p.kindGuessed, false);
    assert.strictEqual((await store.getProject(p.id)).kindGuessed, false);
});

// ── The files knowledge base ─────────────────────────────────────────

test('the first recorded files base wins; a later one reads the winner back', async () => {
    const p = await store.createProject({ name: 'Files', ownerId: 'alice' });
    assert.strictEqual(await store.setFilesKbId(p.id, 'kb-first'), 'kb-first');
    assert.strictEqual(await store.setFilesKbId(p.id, 'kb-second'), 'kb-first');
    assert.strictEqual((await store.getProject(p.id)).filesKbId, 'kb-first');
});

test('a stale files base is replaced only when the caller names it', async () => {
    const p = await store.createProject({ name: 'Files 2', ownerId: 'alice' });
    await store.setFilesKbId(p.id, 'kb-gone');
    assert.strictEqual(await store.setFilesKbId(p.id, 'kb-new', { expected: 'kb-other' }), 'kb-gone');
    assert.strictEqual(await store.setFilesKbId(p.id, 'kb-new', { expected: 'kb-gone' }), 'kb-new');
    assert.strictEqual(await store.setFilesKbId('no-such-project', 'kb-x'), null);
});

// ── Shared conversations and deleting a project ─────────────────────

test('shared conversations are counted across both tables; private ones are not', async () => {
    const p = await store.createProject({ name: 'Shared', ownerId: 'alice' });
    assert.strictEqual(await store.countSharedThreads(p.id), 0);
    await pg.query(`INSERT INTO direct_conversations (id, user_id, project_id, shared_scope) VALUES ('d1', 'alice', $1, 'project')`, [p.id]);
    await pg.query(`INSERT INTO direct_conversations (id, user_id, project_id, shared_scope) VALUES ('d2', 'alice', $1, 'private')`, [p.id]);
    await pg.query(`INSERT INTO agent_conversations (id, user_id, project_id, shared_scope) VALUES ('a1', 'bob', $1, 'project')`, [p.id]);
    assert.strictEqual(await store.countSharedThreads(p.id), 2);
});

test('deleting a project that still holds a shared conversation is refused by the database', async () => {
    const p = await store.createProject({ name: 'Doomed', ownerId: 'alice' });
    await pg.query(`INSERT INTO direct_conversations (id, user_id, project_id, shared_scope) VALUES ('d-doomed', 'alice', $1, 'project')`, [p.id]);
    await pg.query(`INSERT INTO direct_conversations (id, user_id, project_id, shared_scope) VALUES ('d-filed', 'alice', $1, 'private')`, [p.id]);

    // ON DELETE SET NULL would leave a shared conversation without a project,
    // which the CHECK forbids: the whole DELETE fails with 23514.
    await assert.rejects(store.deleteProject(p.id), (err) => err.code === '23514');
    assert.ok(await store.getProject(p.id), 'the project is still there');

    await pg.query(`UPDATE direct_conversations SET shared_scope = 'private' WHERE id = 'd-doomed'`);
    assert.strictEqual(await store.deleteProject(p.id), true);
    const left = await pg.query(`SELECT id, project_id FROM direct_conversations WHERE id IN ('d-doomed', 'd-filed') ORDER BY id`);
    assert.deepStrictEqual(left.rows, [
        { id: 'd-doomed', project_id: null },
        { id: 'd-filed', project_id: null },
    ], 'the conversations survive, unfiled');
});

test('the shared conversations are listed as ids and owners, oldest share first', async () => {
    const p = await store.createProject({ name: 'Listed', ownerId: 'alice' });
    await pg.query(`INSERT INTO direct_conversations (id, user_id, project_id, shared_scope, shared_at)
                    VALUES ('ld1', 'bob', $1, 'project', NOW() - interval '2 days'),
                           ('ld2', 'alice', $1, 'private', NULL)`, [p.id]);
    await pg.query(`INSERT INTO agent_conversations (id, user_id, project_id, shared_scope, shared_at)
                    VALUES ('la1', 'carol', $1, 'project', NOW() - interval '1 day')`, [p.id]);
    assert.deepStrictEqual(await store.listSharedThreads(p.id), [
        { id: 'ld1', type: 'direct', ownerId: 'bob' },
        { id: 'la1', type: 'agent', ownerId: 'carol' },
    ]);
    assert.deepStrictEqual(await store.listSharedThreads(p.id, { limit: 1 }), [{ id: 'ld1', type: 'direct', ownerId: 'bob' }]);
});

test('a caller reads where their own conversation is filed, and nothing about anybody else\'s', async () => {
    const p = await store.createProject({ name: 'Filing', ownerId: 'alice' });
    await pg.query(`INSERT INTO direct_conversations (id, user_id, project_id, shared_scope) VALUES ('fd1', 'bob', $1, 'project')`, [p.id]);
    await pg.query(`INSERT INTO agent_conversations (id, user_id, project_id, shared_scope) VALUES ('fa1', 'bob', NULL, 'private')`);
    assert.deepStrictEqual(await store.getOwnConversationFiling('fd1', 'bob'), { projectId: p.id, shared: true });
    assert.deepStrictEqual(await store.getOwnConversationFiling('fa1', 'bob', 'agent_conversations'), { projectId: null, shared: false });
    assert.strictEqual(await store.getOwnConversationFiling('fd1', 'alice'), null, 'the project owner is not the chat\'s owner');
    assert.strictEqual(await store.getOwnConversationFiling('fa1', 'bob'), null, 'wrong table');
    assert.strictEqual(await store.getOwnConversationFiling('', 'bob'), null);
});

test('the chats a Solution cannot hold are counted: filed conversations and team chats', async () => {
    const p = await store.createProject({ name: 'Chatty', ownerId: 'alice' });
    assert.deepStrictEqual(await store.countChatHoldings(p.id), { conversations: 0, teamChats: 0 });
    await pg.query(`INSERT INTO direct_conversations (id, user_id, project_id) VALUES ('cd1', 'alice', $1), ('cd2', 'bob', $1)`, [p.id]);
    await pg.query(`INSERT INTO agent_conversations (id, user_id, project_id, shared_scope) VALUES ('ca1', 'bob', $1, 'project')`, [p.id]);
    await pg.query(`INSERT INTO project_chats (id, project_id) VALUES ('tc1', $1)`, [p.id]);
    assert.deepStrictEqual(await store.countChatHoldings(p.id), { conversations: 3, teamChats: 1 });
});

test('an installation without conversation tables has no shared conversations', async () => {
    const bare = new PGlite();
    try {
        await applySchema(bare);
        const bareStore = makeProjectStore(facadeFor(bare));
        const p = await bareStore.createProject({ name: 'Bare', ownerId: 'alice' });
        assert.strictEqual(await bareStore.countSharedThreads(p.id), 0);
        assert.deepStrictEqual(await bareStore.listSharedThreads(p.id), []);
        assert.strictEqual(await bareStore.getOwnConversationFiling('c1', 'alice'), null);
        assert.deepStrictEqual(await bareStore.countChatHoldings(p.id), { conversations: 0, teamChats: 0 });
    } finally {
        await bare.close();
    }
});

test('handOverProject: the longest-standing editor becomes owner and leaves the share list; nobody else inherits', async () => {
    await insertLegacy('hand-1', 'leaver');
    const share = (id, type, who, permission, at) => pg.query(
        `INSERT INTO project_shares (id, project_id, shared_with_type, shared_with_id, permission, created_at)
         VALUES ($1, 'hand-1', $2, $3, $4, $5)`, [id, type, who, permission, at]);
    await share('s1', 'user', 'viewer1', 'viewer', '2026-01-01T00:00:00Z');
    await share('s2', 'group', 'g1', 'editor', '2026-01-02T00:00:00Z');
    await share('s3', 'user', 'late', 'editor', '2026-03-01T00:00:00Z');
    await share('s4', 'user', 'early', 'editor', '2026-02-01T00:00:00Z');

    assert.strictEqual(await store.handOverProject('hand-1', 'somebody-else'), null, 'only while the named person still owns it');
    assert.strictEqual(await store.handOverProject('hand-1', 'leaver'), 'early');
    const owner = (await pg.query(`SELECT owner_id FROM projects WHERE id = 'hand-1'`)).rows[0].owner_id;
    assert.strictEqual(owner, 'early');
    const left = (await pg.query(`SELECT shared_with_id FROM project_shares WHERE project_id = 'hand-1' ORDER BY id`)).rows.map((r) => r.shared_with_id);
    assert.deepStrictEqual(left, ['viewer1', 'g1', 'late'], 'the new owner is no longer also a member');
});

test('handOverProject: a project without an editor is not handed to a viewer or a group', async () => {
    await insertLegacy('hand-2', 'leaver');
    await pg.query(`INSERT INTO project_shares (id, project_id, shared_with_type, shared_with_id, permission)
        VALUES ('h2a', 'hand-2', 'user', 'viewer1', 'viewer'), ('h2b', 'hand-2', 'group', 'g1', 'editor')`);
    assert.strictEqual(await store.handOverProject('hand-2', 'leaver'), null);
    assert.strictEqual((await pg.query(`SELECT owner_id FROM projects WHERE id = 'hand-2'`)).rows[0].owner_id, 'leaver');
});
