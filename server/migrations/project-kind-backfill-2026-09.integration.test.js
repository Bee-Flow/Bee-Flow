/**
 * project-kind-backfill-2026-09 against a real Postgres (@electric-sql/pglite),
 * handed to up() through its `db` / `initSchema` seams, so db.js is never
 * swapped out in the module cache. The projects table is the project store's
 * own schema (applyProjectSchema), so `kind` and its CHECK are the real ones.
 *
 * Pinned:
 *   - every piece of Solution evidence classifies as 'solution': a Blueprint
 *     install, a release, a gallery row, filed automations / apps / webpages /
 *     tables, and the Studio icon when no chat is filed;
 *   - chats, notebooks or memories without any Solution evidence classify as
 *     'workspace'; the icon does not overrule a filed chat;
 *   - conflicting evidence classifies nothing: a project with a Solution's
 *     pieces AND filed chats, notebooks or memories stays NULL (before the
 *     split one project served both screens, so that is an ordinary
 *     project, and calling it a Solution would hide it from the Projects
 *     page and strip its chats of the project's context);
 *   - every kind the migration sets is marked as a guess (`kind_guessed`),
 *     which the owner may correct once; an owner's own choice is not;
 *   - no evidence stays NULL, and a row an owner already classified is never
 *     touched;
 *   - --dry-run reports and writes nothing; a second run is a no-op;
 *   - tables that are absent, or predate their project_id column, are skipped;
 *   - a failure rolls back and rejects, so the ledger does not record the run.
 *
 * Run: cd server && node --test migrations/project-kind-backfill-2026-09.integration.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { up, SOLUTION_ICON } = require('./project-kind-backfill-2026-09');
const { applyProjectSchema } = require('../stores/projectStore');

function adaptResult(res) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const rowCount = (r.fields || []).length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, rowCount };
}

/** The slice of the db.js facade the migration uses, over one PGlite connection. */
function facadeFor(pg, { failOn = null } = {}) {
    const query = async (sql, params) => {
        if (failOn && failOn.test(sql)) throw Object.assign(new Error('injected failure'), { code: 'XX000' });
        if (Array.isArray(params) && params.length > 0) return adaptResult(await pg.query(sql, params));
        return adaptResult(await pg.query(sql));
    };
    const client = { query };
    return {
        getOne: async (sql, params) => (await query(sql, params)).rows[0] || null,
        withTransaction: async (fn) => {
            await query('BEGIN');
            try {
                const out = await fn(client);
                await query('COMMIT');
                return out;
            } catch (e) {
                try { await query('ROLLBACK'); } catch { /* already aborted */ }
                throw e;
            }
        },
    };
}

async function projectSchema(pg) {
    await applyProjectSchema({
        exec: (sql) => pg.exec(sql),
        runDdl: async (_tag, statements) => {
            for (const s of statements) await pg.exec(typeof s === 'string' ? s : s.sql);
        },
    });
}

// The evidence tables, reduced to the column the migration reads.
const EVIDENCE = `
    CREATE TABLE project_releases (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE project_blueprints (id TEXT PRIMARY KEY, source_project_id TEXT);
    CREATE TABLE automations (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE studio_apps (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE webpages (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE datatables (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE direct_conversations (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE agent_conversations (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE notebooks (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE user_memories (id TEXT PRIMARY KEY, project_id TEXT);
`;

let seq = 0;
async function project(pg, id, { kind = null, icon = '📁', installedFrom = null } = {}) {
    await pg.query(
        `INSERT INTO projects (id, name, owner_id, icon, kind, installed_from_blueprint_id)
         VALUES ($1, $1, 'alice', $2, $3, $4)`,
        [id, icon, kind, installedFrom],
    );
}
async function filed(pg, table, projectId, column = 'project_id') {
    seq += 1;
    await pg.query(`INSERT INTO ${table} (id, ${column}) VALUES ($1, $2)`, [`${table}-${seq}`, projectId]);
}
async function kinds(pg) {
    const r = await pg.query('SELECT id, kind FROM projects ORDER BY id');
    return Object.fromEntries(r.rows.map((row) => [row.id, row.kind]));
}

let pg;
const noInit = async () => {};

before(async () => {
    pg = new PGlite();
    await projectSchema(pg);
    await pg.exec(EVIDENCE);

    // Solution evidence, one kind each.
    await project(pg, 'installed', { installedFrom: 'bp_1' });
    await project(pg, 'released'); await filed(pg, 'project_releases', 'released');
    await project(pg, 'published'); await filed(pg, 'project_blueprints', 'published', 'source_project_id');
    await project(pg, 'with-automation'); await filed(pg, 'automations', 'with-automation');
    await project(pg, 'with-app'); await filed(pg, 'studio_apps', 'with-app');
    await project(pg, 'with-webpage'); await filed(pg, 'webpages', 'with-webpage');
    await project(pg, 'with-table'); await filed(pg, 'datatables', 'with-table');
    await project(pg, 'boxed', { icon: SOLUTION_ICON });

    // Workspace evidence, one kind each.
    await project(pg, 'with-chat'); await filed(pg, 'direct_conversations', 'with-chat');
    await project(pg, 'with-agent-chat'); await filed(pg, 'agent_conversations', 'with-agent-chat');
    await project(pg, 'with-notebook'); await filed(pg, 'notebooks', 'with-notebook');
    await project(pg, 'with-memory'); await filed(pg, 'user_memories', 'with-memory');
    await project(pg, 'boxed-with-chat', { icon: SOLUTION_ICON }); await filed(pg, 'direct_conversations', 'boxed-with-chat');

    // Both kinds of evidence: ambiguous, so it stays NULL (listed on both
    // sides) until its owner decides. The legacy page filed routines and
    // tables next to chats, so this was ordinary use.
    await project(pg, 'mixed'); await filed(pg, 'automations', 'mixed'); await filed(pg, 'direct_conversations', 'mixed');
    for (let i = 0; i < 30; i += 1) await filed(pg, 'direct_conversations', 'mixed');
    await filed(pg, 'user_memories', 'mixed');
    await project(pg, 'installed-with-chats', { installedFrom: 'bp_2' }); await filed(pg, 'agent_conversations', 'installed-with-chats');
    await project(pg, 'table-and-notebook'); await filed(pg, 'datatables', 'table-and-notebook'); await filed(pg, 'notebooks', 'table-and-notebook');
    await project(pg, 'boxed-with-notebook', { icon: SOLUTION_ICON }); await filed(pg, 'notebooks', 'boxed-with-notebook');

    // No evidence.
    await project(pg, 'empty');

    // Already decided by their owners, against the evidence.
    await project(pg, 'owner-said-workspace', { kind: 'workspace' }); await filed(pg, 'automations', 'owner-said-workspace');
    await project(pg, 'owner-said-solution', { kind: 'solution' }); await filed(pg, 'direct_conversations', 'owner-said-solution');
});

after(async () => { await pg.close(); });

const EXPECTED = {
    installed: 'solution',
    released: 'solution',
    published: 'solution',
    'with-automation': 'solution',
    'with-app': 'solution',
    'with-webpage': 'solution',
    'with-table': 'solution',
    boxed: 'solution',
    'with-chat': 'workspace',
    'with-agent-chat': 'workspace',
    'with-notebook': 'workspace',
    'with-memory': 'workspace',
    'boxed-with-chat': 'workspace',
    mixed: null,
    'installed-with-chats': null,
    'table-and-notebook': null,
    'boxed-with-notebook': null,
    empty: null,
    'owner-said-workspace': 'workspace',
    'owner-said-solution': 'solution',
};

test('--dry-run reports what it would do and writes nothing', async () => {
    const before_ = await kinds(pg);
    const result = await up({ dryRun: true, db: facadeFor(pg), initSchema: noInit });
    assert.deepStrictEqual(result, { solution: 8, workspace: 5, unclassified: 5, dryRun: true });
    assert.deepStrictEqual(await kinds(pg), before_);
});

test('a failure part-way rolls the whole run back and rejects', async () => {
    const before_ = await kinds(pg);
    await assert.rejects(
        up({ db: facadeFor(pg, { failOn: /SET kind = 'workspace'/ }), initSchema: noInit }),
        /injected failure/,
    );
    assert.deepStrictEqual(await kinds(pg), before_, 'the Solution UPDATE was rolled back with it');
});

test('only unambiguous rows are classified; the rest and the owners\' choices are left alone', async () => {
    const result = await up({ db: facadeFor(pg), initSchema: noInit });
    assert.deepStrictEqual(result, { solution: 8, workspace: 5, unclassified: 5, dryRun: false });
    assert.deepStrictEqual(await kinds(pg), EXPECTED);
});

test('what the migration set is marked as a guess; what an owner chose is not', async () => {
    const r = await pg.query('SELECT id, kind, kind_guessed FROM projects ORDER BY id');
    const guessed = Object.fromEntries(r.rows.map((row) => [row.id, row.kind_guessed]));
    for (const [id, kind] of Object.entries(EXPECTED)) {
        const byOwner = id.startsWith('owner-said-');
        const expected = kind !== null && !byOwner;
        assert.strictEqual(guessed[id], expected, `${id}: kind_guessed`);
    }
});

test('a second run changes nothing', async () => {
    const result = await up({ db: facadeFor(pg), initSchema: noInit });
    assert.deepStrictEqual(result, { solution: 0, workspace: 0, unclassified: 5, dryRun: false });
    assert.deepStrictEqual(await kinds(pg), EXPECTED);
});

test('absent tables and tables without project_id are skipped, not fatal', async () => {
    const bare = new PGlite();
    try {
        await projectSchema(bare);
        // Only chats exist here, and an automations table from before its
        // project_id column.
        await bare.exec(`
            CREATE TABLE direct_conversations (id TEXT PRIMARY KEY, project_id TEXT);
            CREATE TABLE automations (id TEXT PRIMARY KEY, title TEXT);
        `);
        await project(bare, 'chat'); await filed(bare, 'direct_conversations', 'chat');
        await project(bare, 'boxed', { icon: SOLUTION_ICON });
        await project(bare, 'plain');

        const result = await up({ db: facadeFor(bare), initSchema: noInit });
        assert.deepStrictEqual(result, { solution: 1, workspace: 1, unclassified: 1, dryRun: false });
        assert.deepStrictEqual(await kinds(bare), { boxed: 'solution', chat: 'workspace', plain: null });
    } finally {
        await bare.close();
    }
});

test('without the kind column the run fails loudly instead of recording nothing done', async () => {
    const empty = new PGlite();
    try {
        await empty.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, icon TEXT)');
        await assert.rejects(up({ db: facadeFor(empty), initSchema: noInit }), /projects\.kind does not exist/);
    } finally {
        await empty.close();
    }
});
