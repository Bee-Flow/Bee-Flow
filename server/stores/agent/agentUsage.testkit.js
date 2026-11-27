'use strict';
/**
 * The test beds of "what breaks if I delete this agent?" (agentUsage.js).
 *
 *   registerUsageDoubles()   a double of every module part (stores/agent/usage/<module>.js),
 *                            registered under its name: the same kinds, tables and roles, a
 *                            marker for the SQL. For the policy suite, which never parses SQL.
 *   assertPathIsConstant(kind)  the path proof of a part's jsonpath scan, through the policy.
 *   usePgUsage()             PGlite with every consumer table as its store declares it and one
 *                            consumer of every kind (before/after of the file); { db, pg, ... }.
 *
 * Test-only (`.testkit.js`: neither the server nor the layering scan loads it).
 */

const assert = require('node:assert');

/** The parts of agentUsage.js, by name, with the kinds each declares. */
const DOUBLE_SCANS = {
    'stores/agent/usage/cowork': {
        task: { table: 'ai_tasks', role: 'automation', sql: '-- scan task' },
        cowork: { table: 'cowork_schedules', role: 'automation', sql: '-- scan cowork' },
    },
    'stores/agent/usage/support': { support: { table: 'support_inboxes', role: 'auto_reply', sql: '-- scan support' } },
    'stores/agent/usage/automation': { automation: { table: 'automations', role: 'ai_step', sql: '-- scan automation' } },
    'stores/agent/usage/apps': { app: { table: 'studio_apps', role: 'ai_block', sql: '-- scan app' } },
    'stores/agent/usage/webpages': { webpage: { table: 'webpages', role: 'bridge', sql: '-- scan webpage' } },
};

/** Register a double of every part under its name (after the modules registered theirs). */
function registerUsageDoubles() {
    const registry = require('../../core/featureModules');
    registry.optionalFeatureModule('stores/agent/usage/cowork');
    registry.registerFeatureModules(Object.fromEntries(Object.entries(DOUBLE_SCANS).map(([name, SCANS]) => [name, () => ({ SCANS })])));
}

/**
 * No agent id ever enters the jsonpath of `kind`'s scan — the ids are bound, the path is a
 * constant. An agent id is a route parameter. Concatenated into a jsonpath, a value carrying a
 * quote would close the string literal and be parsed as path syntax — an injection into the
 * path, placeholder or not.
 * @param {string} kind
 */
async function assertPathIsConstant(kind) {
    const { usageForAgent, SCANS } = require('./agentUsage');
    /** @type {Array<{ sql: string, params: unknown[] }>} */
    const queries = [];
    const db = {
        query: async (sql, params) => {
            if (/to_regclass/.test(sql)) return { rows: [Object.fromEntries(params.map((_, i) => [`t${i}`, true]))] };
            queries.push({ sql, params });
            return { rows: [] };
        },
    };
    await usageForAgent('ag" ? (@ == "x', { db });
    const mine = queries.filter((q) => q.sql === SCANS[kind].sql);
    assert.strictEqual(mine.length, 1, `the ${kind} scan ran`);
    for (const q of mine) {
        assert.match(q.sql, /'\$\.\*\*\.agentId'/, 'the path is a literal constant');
        assert.ok(!/\$1/.test(q.sql.match(/jsonb_path_query\([^)]*\)/)[0]), 'no parameter inside the path call');
        assert.deepStrictEqual(q.params, [['ag" ? (@ == "x']], 'the raw id, bound as text[]');
    }
}

const AGENT = 'agent-under-test';
const OTHER = 'some-other-agent';
const INBOX = '00000000-0000-4000-8000-0000000000aa';

/** @type {(sql: string, params?: unknown[]) => Promise<any>} */
let q = async () => { throw new Error('usePgUsage() first'); };

/**
 * The consumer tables as their stores declare them — same column names, same
 * types, trimmed to what the scans read. `support_inboxes.id` is a UUID on
 * purpose: the scan has to hand back text like every other kind.
 */
const DDL = `
CREATE TABLE ai_tasks (
    id TEXT PRIMARY KEY, user_id TEXT, title TEXT, agent_id TEXT,
    last_run_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE cowork_schedules (
    id TEXT PRIMARY KEY, user_id TEXT, title TEXT, agent_id TEXT,
    last_run_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE support_inboxes (
    id UUID PRIMARY KEY, organization_id TEXT, created_by TEXT, display_name TEXT,
    default_agent_id TEXT, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE automations (
    id TEXT PRIMARY KEY, title TEXT, user_id TEXT, definition_json JSONB,
    updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE studio_apps (
    id TEXT PRIMARY KEY, name TEXT, user_id TEXT,
    definition JSONB NOT NULL DEFAULT '{}'::jsonb, published_definition JSONB,
    updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE webpages (
    id TEXT PRIMARY KEY, name TEXT, user_id TEXT, bridge_grants JSONB,
    updated_at TIMESTAMPTZ DEFAULT now());
`;

async function seed() {
    await q(`INSERT INTO ai_tasks (id, user_id, title, agent_id, last_run_at) VALUES
        ('task-1','u1','Nightly report',$1,'2026-09-01T06:00:00Z'),
        ('task-2','u2','Unrelated',$2,NULL)`, [AGENT, OTHER]);
    await q(`INSERT INTO cowork_schedules (id, user_id, title, agent_id) VALUES ('cw-1','u1','Morning brief',$1)`, [AGENT]);
    await q(`INSERT INTO support_inboxes (id, organization_id, created_by, display_name, default_agent_id)
             VALUES ($1,'org1','u2','Helpdesk',$2)`, [INBOX, AGENT]);

    // The id at an unknown depth, twice in the same automation — the recursive
    // accessor is the whole reason for jsonb_path_query, and an automation that
    // names the agent in two steps is ONE automation that breaks.
    await q(`INSERT INTO automations (id, title, user_id, definition_json) VALUES ('au-1','Weekly digest','u1',$1::jsonb)`, [
        JSON.stringify({
            steps: [
                { id: 's1', type: 'ai_step', agentId: AGENT },
                { id: 's2', type: 'loop', body: [{ id: 's3', type: 'ai_step', agentId: AGENT }] },
            ],
        }),
    ]);
    await q(`INSERT INTO automations (id, title, user_id, definition_json) VALUES ('au-2','Unrelated automation','u2',$1::jsonb)`, [
        JSON.stringify({ steps: [{ type: 'ai_step', agentId: OTHER }] }),
    ]);
    // A definition that is NULL, and one whose agentId is not a string: both
    // must be walked past rather than crash the scan for everybody else.
    await q(`INSERT INTO automations (id, title, user_id, definition_json) VALUES ('au-3','Half-built','u2',NULL)`);
    await q(`INSERT INTO automations (id, title, user_id, definition_json) VALUES ('au-4','Odd shape','u2',$1::jsonb)`, [
        JSON.stringify({ steps: [{ agentId: 42 }, { agentId: null }] }),
    ]);

    // Only in the PUBLISHED definition: the version people actually run.
    await q(`INSERT INTO studio_apps (id, name, user_id, definition, published_definition) VALUES
        ('app-1','Intake app','u2','{}'::jsonb,$1::jsonb)`, [
        JSON.stringify({ screens: [{ blocks: [{ type: 'ai_chat', props: { agentId: AGENT } }] }] }),
    ]);

    // Three plausible shapes for W3's bridge grant. All three must be found;
    // the guard cannot depend on a key W3 has not chosen yet.
    await q(`INSERT INTO webpages (id, name, user_id, bridge_grants) VALUES ('wp-nested','Nested','u1',$1::jsonb)`, [
        JSON.stringify({ ai: { enabled: true }, agent: { agentId: AGENT } }),
    ]);
    await q(`INSERT INTO webpages (id, name, user_id, bridge_grants) VALUES ('wp-list','List','u1',$1::jsonb)`, [
        JSON.stringify({ agents: [{ agentId: AGENT, label: 'Ask sales' }] }),
    ]);
    await q(`INSERT INTO webpages (id, name, user_id, bridge_grants) VALUES ('wp-scalar','Scalar','u1',$1::jsonb)`, [
        JSON.stringify({ agent: AGENT }),
    ]);
    await q(`INSERT INTO webpages (id, name, user_id, bridge_grants) VALUES ('wp-none','Unrelated','u2',$1::jsonb)`, [
        JSON.stringify({ ai: { enabled: true }, automations: [], integrations: [] }),
    ]);
    await q(`INSERT INTO webpages (id, name, user_id, bridge_grants) VALUES ('wp-null','No grants','u2',NULL)`);
}

/**
 * PGlite with the consumer tables and the seed, for the file (before / after).
 * @param {{ before: Function, after: Function }} t  node:test
 */
function usePgUsage(t) {
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
    return { pg, db };
}

module.exports = { registerUsageDoubles, assertPathIsConstant, usePgUsage, AGENT, OTHER, INBOX };
