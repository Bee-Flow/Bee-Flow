// @typecheck
'use strict';

/**
 * TEST SUPPORT for the project checks' pglite tests — not loaded by anything
 * at runtime (checks/index.js only walks the checks directories).
 *
 * `applyProjectCheckSchema(pg)` builds, on a PGlite handle, the tables the
 * project checks read: the REAL DDL for projects/project_shares/
 * project_activity (stores/projectStore.applyProjectSchema), team chats
 * (stores/projectChatStore.DDL) and content signals
 * (stores/contentPiiSignalStore.DDL), plus the few columns of the other
 * tables (users, groups, notebooks, documents, knowledge bases, guardrail
 * events, shared conversations, studio documents, version tables) that the
 * checks' SQL names. So the SQL each check ships runs where the columns it
 * names exist, and a renamed column breaks a test instead of a sweep.
 *
 * `queryOf(pg)` is the `query(sql, params) → rows` a check's deps take, and
 * `useProjectCheckDb(seed)` the whole per-file lifecycle of such a database.
 */

/**
 * @param {any} pg  a PGlite handle
 * @param {{ versions?: boolean }} [opts]
 */
async function applyProjectCheckSchema(pg, { versions = true } = {}) {
    const { applyProjectSchema } = require('../../stores/projectStore');
    await applyProjectSchema({
        exec: (sql) => pg.exec(sql),
        runDdl: async (/** @type {string} */ _tag, /** @type {any[]} */ statements) => { for (const s of statements) await pg.exec(typeof s === 'string' ? s : s.sql); },
    });
    await pg.exec(require('../../stores/projectChatStore').DDL);
    await pg.exec(require('../../stores/contentPiiSignalStore').DDL);
    await pg.exec(`
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT DEFAULT '', status TEXT DEFAULT 'active',
            role TEXT DEFAULT 'user', "orgRole" TEXT DEFAULT '');
        CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, "organizationId" TEXT, name TEXT NOT NULL DEFAULT 'g');
        CREATE TABLE IF NOT EXISTS notebooks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, organization_id TEXT,
            pii_token_map TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS studio_documents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT, organization_id TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS knowledge_bases (id UUID PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 't', organization_id TEXT,
            source_kind TEXT);
        CREATE TABLE IF NOT EXISTS documents (id UUID PRIMARY KEY, knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            title TEXT, status TEXT DEFAULT 'processed', pii_status TEXT DEFAULT 'unscanned', pii_categories JSONB);
        CREATE TABLE IF NOT EXISTS guardrail_events (id SERIAL PRIMARY KEY, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            organization_id TEXT, conversation_id TEXT, violation_type TEXT NOT NULL DEFAULT 'pii', violation_categories TEXT,
            action_taken TEXT, source TEXT DEFAULT 'unknown', is_dry_run BOOLEAN DEFAULT false);
        CREATE TABLE IF NOT EXISTS direct_conversations (id TEXT PRIMARY KEY, user_id TEXT, project_id TEXT, shared_scope TEXT DEFAULT 'private',
            pii_token_map TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS agent_conversations (id TEXT PRIMARY KEY, user_id TEXT, agent_id TEXT, project_id TEXT, shared_scope TEXT DEFAULT 'private',
            pii_token_map TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS dpia_assessments (id SERIAL PRIMARY KEY, organization_id TEXT, agent_id TEXT NOT NULL,
            approved_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS project_comment_threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT 'document',
            target_id TEXT NOT NULL DEFAULT 'x', status TEXT NOT NULL DEFAULT 'open', ai_mode TEXT NOT NULL DEFAULT 'mention',
            created_by TEXT NOT NULL DEFAULT 'u', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS project_comments (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, project_id TEXT NOT NULL,
            author_user_id TEXT, deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    `);
    if (versions) {
        await pg.exec(`
            CREATE TABLE IF NOT EXISTS notebook_versions (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'legacy',
                contributors JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
            CREATE TABLE IF NOT EXISTS studio_document_versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'legacy',
                contributors JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        `);
    }
}

/** @param {any} pg  a PGlite handle */
function queryOf(pg) {
    return async (/** @type {string} */ sql, /** @type {any[]} */ params) => (await (params && params.length ? pg.query(sql, params) : pg.query(sql))).rows;
}

/**
 * One pglite database with the project-check schema for a whole test file:
 * the schema and then `seed` are applied in a top-level `before`, the handle
 * is closed in an `after`.
 *
 *   const { query } = useProjectCheckDb(`INSERT INTO projects ...`);
 *
 * @param {string} [seed]
 * @param {{ versions?: boolean }} [opts]  as applyProjectCheckSchema
 * @returns {{ pg: any, query: (sql: string, params?: any[]) => Promise<any[]> }}
 */
function useProjectCheckDb(seed = '', opts = {}) {
    const { before, after } = require('node:test');
    const { PGlite } = require('@electric-sql/pglite');
    const pg = new PGlite();
    before(async () => {
        await applyProjectCheckSchema(pg, opts);
        if (seed) await pg.exec(seed);
    });
    after(() => pg.close());
    return { pg, query: queryOf(pg) };
}

module.exports = { applyProjectCheckSchema, queryOf, useProjectCheckDb };
