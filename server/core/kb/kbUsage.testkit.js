'use strict';
/**
 * The test bed of "who uses this knowledge base?" (kbUsage.js): the boot
 * ladder's schema on PGlite (testUtils/pgliteTemplate.js), handed in through
 * the `db` seam, emptied before every test, and one consumer of every kind of
 * this installation. A kind whose module is not loaded has no table in the
 * ladder and gets no row (kbUsage.js leaves it out).
 *
 *   const k = require('./kbUsage.testkit');      // core/kb/kbUsage.testkit
 *   k.useKbUsageDb(test);
 *   await k.everyKind();
 *   await usageForKb(k.KB1, { db: k.db });
 *
 * Test-only (`.testkit.js`: neither the server nor the layering scan loads it).
 */

const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { pgliteQuery } = require('../../testUtils/pglitePool');
const { insertRow } = require('../../testUtils/pgliteSeed');

// A knowledge base id is a uuid (support_inboxes.kb_ingest_kb_id holds one).
const KB1 = '6f1c2a4e-0b7d-4c1e-9a3f-2d5e8b9c0a11';
const S1 = '0e9a7b51-3c2d-4e6f-8a1b-5c4d3e2f1a01';
const S2 = '0e9a7b51-3c2d-4e6f-8a1b-5c4d3e2f1a02';

const pg = ladderPglite();
/** @type {string[]} */
const queries = [];
const run = pgliteQuery(pg);
/** The `db` seam: real statements, recorded so "no work" is a fact. */
const db = { query: (sql, params) => { if (!/to_regclass/.test(sql)) queries.push(sql); return run(sql, params); } };

/** The kinds of this installation (kbUsage.js asks the modules by name). */
const kinds = () => [...require('./kbUsage').KINDS];

/**
 * Close PGlite after the file, and empty every consumer table of this installation before each test.
 * @param {typeof import('node:test')} test
 */
function useKbUsageDb(test) {
    test.after(() => pg.close());
    test.beforeEach(async () => {
        const tables = Object.values(require('./kbUsage').SCANS).map((s) => s.table);
        await pg.exec(`TRUNCATE ${tables.join(', ')} CASCADE`);
        queries.length = 0;
    });
}

const agent = (id, kbIds, over = {}) => insertRow(pg, 'agents', { id, name: id, owner_id: 'u1', config: JSON.stringify({ knowledge_base_ids: kbIds }), ...over });
const kbIdsOf = async (table, id, col = 'knowledge_base_ids') => (await pg.query(`SELECT ${col} AS v FROM ${table} WHERE id = $1`, [id])).rows[0].v;

/** One consumer of kb1 per kind, in Used-by order (the agent kind also has one that uses another base). */
const SEEDS = {
    agent: async () => {
        await agent('ag1', [KB1], { name: 'Support assistant', updated_at: '2026-09-01T00:00:00Z' });
        await agent('ag-other', ['kb2']);
    },
    automation: () => insertRow(pg, 'automations', { id: 'au1', user_id: 'u1', title: 'Flow', definition_json: { steps: [{ type: 'ai_step', config: { knowledgeBaseIds: [KB1] } }] } }),
    app: () => insertRow(pg, 'studio_apps', { id: 'app1', user_id: 'u1', name: 'App', definition: {}, published_definition: { screens: [{ blocks: [{ knowledgeBaseIds: [KB1] }] }] } }),
    webpage: () => insertRow(pg, 'webpages', { id: 'w1', user_id: 'u1', name: 'Page', knowledge_base_ids: [KB1] }),
    project: () => insertRow(pg, 'projects', { id: 'p1', name: 'Project', owner_id: 'u1', knowledge_base_ids: [KB1, 'kb2'] }),
    notebook: () => insertRow(pg, 'notebooks', { id: 'n1', user_id: 'u1', name: 'Notebook', knowledge_base_ids: [KB1] }),
    template: () => insertRow(pg, 'word_templates', { id: 't1', user_id: 'u1', name: 'Template', storage_key: 'k', knowledge_base_ids: [KB1] }),
    support: async () => {
        await insertRow(pg, 'support_inboxes', { id: S1, display_name: 'Inbox', created_by: 'u1', organization_id: 'org1', provider: 'gmail', kb_ids: [KB1] });
        await insertRow(pg, 'support_inboxes', { id: S2, display_name: 'Ingest', created_by: 'u1', organization_id: 'org1', provider: 'gmail', kb_ids: [], kb_ingest_kb_id: KB1, kb_ingest_enabled: true });
    },
};

/** One consumer of kb1 of every kind of this installation, plus one agent that uses another base. */
async function everyKind() {
    for (const kind of kinds()) await SEEDS[kind]();
}

module.exports = { pg, db, queries, KB1, S1, S2, kinds, useKbUsageDb, agent, kbIdsOf, everyKind, insertRow };
