'use strict';
/**
 * The Postgres bed of "who uses this knowledge base?" (kbUsage.js): PGlite with every consumer
 * table as production has it and one consumer of every kind, for the file (before / after).
 * Why the scans are proved on Postgres: ./kbUsage.pg.test.js.
 *
 *   const { db, q } = usePgKbUsage(test);
 *
 * Test-only (`.testkit.js`: neither the server nor the layering scan loads it).
 */

/** @type {(sql: string, params?: unknown[]) => Promise<any>} */
let q = async () => { throw new Error('usePgKbUsage() first'); };

const KB = 'kb-under-test';
const OTHER = 'some-other-kb';

/**
 * The consumer tables as their stores declare them — same column names, same
 * types, trimmed to what the scans read. `agents.config` is TEXT holding JSON
 * on this table and `knowledge_base_ids` is jsonb on the rest; both shapes
 * matter, so both are reproduced.
 */
const DDL = `
CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT, owner_id TEXT, config TEXT DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE automations (
    id TEXT PRIMARY KEY, title TEXT, user_id TEXT, definition_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE studio_apps (
    id TEXT PRIMARY KEY, name TEXT, user_id TEXT,
    definition JSONB NOT NULL DEFAULT '{}'::jsonb, published_definition JSONB,
    updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE webpages (
    id TEXT PRIMARY KEY, name TEXT, user_id TEXT,
    knowledge_base_ids JSONB DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT, owner_id TEXT,
    knowledge_base_ids JSONB DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE notebooks (
    id TEXT PRIMARY KEY, name TEXT, user_id TEXT,
    knowledge_base_ids JSONB DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE word_templates (
    id TEXT PRIMARY KEY, name TEXT, user_id TEXT,
    knowledge_base_ids JSONB DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE support_inboxes (
    id TEXT PRIMARY KEY, display_name TEXT, created_by TEXT,
    kb_ids JSONB DEFAULT '[]'::jsonb,
    kb_ingest_enabled BOOLEAN DEFAULT false, kb_ingest_kb_id UUID,
    updated_at TIMESTAMPTZ DEFAULT now());
`;

const INGEST_KB = '00000000-0000-4000-8000-00000000beef';   // kb_ingest_kb_id is UUID

async function seed() {
    const arr = JSON.stringify([KB]);
    const other = JSON.stringify([OTHER]);
    await q(`INSERT INTO agents (id, name, owner_id, config) VALUES
        ('ag1','Support assistant','u1',$1),
        ('ag2','Unrelated agent','u2',$2)`, [
        JSON.stringify({ knowledge_base_ids: [KB] }),
        JSON.stringify({ knowledge_base_ids: [OTHER] }),
    ]);
    // The id at an unknown depth, which is the whole reason for jsonb_path_exists.
    await q(`INSERT INTO automations (id, title, user_id, definition_json) VALUES
        ('au1','Weekly digest','u1',$1),
        ('au2','Unrelated automation','u2',$2)`, [
        JSON.stringify({ steps: [{ type: 'ai_step', branches: [{ steps: [{ knowledgeBaseIds: [KB] }] }] }] }),
        JSON.stringify({ steps: [{ knowledgeBaseIds: [OTHER] }] }),
    ]);
    // Only in the PUBLISHED definition: the version people actually run.
    await q(`INSERT INTO studio_apps (id, name, user_id, definition, published_definition) VALUES
        ('sa1','Intake app','u1','{}'::jsonb,$1)`, [
        JSON.stringify({ screens: [{ blocks: [{ knowledgeBaseIds: [KB] }] }] }),
    ]);
    await q(`INSERT INTO webpages (id, name, user_id, knowledge_base_ids) VALUES ('wp1','Landing','u1',$1::jsonb)`, [arr]);
    await q(`INSERT INTO projects (id, name, owner_id, knowledge_base_ids) VALUES ('pr1','Migration','u1',$1::jsonb)`, [arr]);
    await q(`INSERT INTO notebooks (id, name, user_id, knowledge_base_ids) VALUES ('nb1','Research','u1',$1::jsonb)`, [arr]);
    await q(`INSERT INTO word_templates (id, name, user_id, knowledge_base_ids) VALUES ('wt1','Offer letter','u1',$1::jsonb)`, [arr]);
    await q(`INSERT INTO support_inboxes (id, display_name, created_by, kb_ids) VALUES ('sb1','Helpdesk','u1',$1::jsonb)`, [arr]);
    await q(`INSERT INTO webpages (id, name, user_id, knowledge_base_ids) VALUES ('wp2','Other','u2',$1::jsonb)`, [other]);
}

/**
 * @param {{ before: Function, after: Function }} t  node:test
 */
function usePgKbUsage(t) {
    const { newPglite } = require('../../testUtils/pgliteTemplate');
    const { pgliteQuery } = require('../../testUtils/pglitePool');
    const pg = newPglite();
    // node-postgres's `query(sql, params)` over this PGlite.
    q = pgliteQuery(pg);
    const db = { query: q };
    t.before(async () => {
        await pg.exec(DDL);
        await seed();
    });
    t.after(async () => { await pg.close(); });
    return { pg, db, q };
}

module.exports = { usePgKbUsage, KB, OTHER, INGEST_KB };
