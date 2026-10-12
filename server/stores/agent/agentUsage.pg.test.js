'use strict';

/**
 * The agent usage scans, against a REAL Postgres (@electric-sql/pglite,
 * in-process).
 *
 * ── WHY THIS EXISTS ALONGSIDE agentUsage.test.js ────────────────────
 * The sibling suite proves the POLICY: a missing table is partial and never
 * zero, one failing scan does not abandon the rest, no id enters a jsonpath.
 * It cannot prove the queries are RIGHT, because its fake `query()` never
 * parses SQL — so a scan naming a column the table has not got passes there
 * and finds nothing in production, which is the same wound the knowledge-base
 * scans took (five of eight named a column that did not exist).
 *
 * So this creates the consumer tables as their stores declare them, seeds one
 * consumer of every kind, and asserts the scan FINDS it. A column rename that
 * breaks a scan fails here loudly instead of going quiet.
 *
 * ── THE FORWARD-LOOKING SHAPES ARE PINNED HERE ──────────────────────
 * `ai_step.agentId` (R2), the app AI block (P) and the webpage bridge grant
 * (W3) do not exist yet. The shapes this suite seeds are the contract: a
 * consumer that records an agent under the key `agentId` at ANY depth is
 * found, and so is a bare string at `bridge_grants.agent`. Whoever builds
 * those features can read this file to see what the delete guard will notice.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentUsage.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

function adapt(res, sql) {
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    const rows = r.rows || [];
    const fields = r.fields || [];
    const rowCount = fields.length > 0
        ? rows.length
        : (typeof r.affectedRows === 'number' ? r.affectedRows : 0);
    return { rows, fields, rowCount, command: String(sql).trim().split(/\s+/)[0].toUpperCase() };
}

async function q(sql, params) {
    if (Array.isArray(params) && params.length > 0) return adapt(await pg.query(sql, params), sql);
    if (/;\s*\S/.test(String(sql).trim())) return adapt(await pg.exec(sql), sql);
    return adapt(await pg.query(sql), sql);
}
const db = { query: q };

const { usageForAgent, usageCountsForAgents, KINDS } = require('./agentUsage');

const AGENT = 'agent-under-test';
const OTHER = 'some-other-agent';
const INBOX = '00000000-0000-4000-8000-0000000000aa';

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

before(async () => {
    await pg.exec(DDL);
    await seed();
});
after(async () => { await pg.close(); });

test('every scan finds its consumer — no scan is quietly matching nothing', async () => {
    const { rows, partial } = await usageForAgent(AGENT, { db });
    assert.deepStrictEqual(partial, [], 'all six tables exist here');
    const found = new Set(rows.map(r => r.kind));
    for (const kind of KINDS) {
        assert.ok(found.has(kind), `the ${kind} scan found nothing — check its columns`);
    }
});

test('a task carries its title, owner and last run', async () => {
    const { rows } = await usageForAgent(AGENT, { db });
    const task = rows.find(r => r.kind === 'task');
    assert.strictEqual(task.id, 'task-1');
    assert.strictEqual(task.title, 'Nightly report');
    assert.strictEqual(task.ownerId, 'u1');
    assert.strictEqual(task.role, 'automation');
    assert.strictEqual(new Date(task.lastAt).toISOString(), '2026-09-01T06:00:00.000Z');
});

test('a support inbox comes back with a TEXT id, like every other kind', async () => {
    const { rows } = await usageForAgent(AGENT, { db });
    const inbox = rows.find(r => r.kind === 'support');
    assert.strictEqual(inbox.id, INBOX);
    assert.strictEqual(typeof inbox.id, 'string');
    assert.strictEqual(inbox.title, 'Helpdesk');
    assert.strictEqual(inbox.role, 'auto_reply');
});

test('an automation that names the agent in two steps is ONE automation that breaks', async () => {
    const { rows } = await usageForAgent(AGENT, { db });
    const automations = rows.filter(r => r.kind === 'automation');
    assert.deepStrictEqual(automations.map(r => r.id), ['au-1']);
    assert.strictEqual(automations[0].title, 'Weekly digest');
});

test('an app is found through its PUBLISHED definition, not only its draft', async () => {
    const { rows } = await usageForAgent(AGENT, { db });
    const apps = rows.filter(r => r.kind === 'app');
    assert.deepStrictEqual(apps.map(r => r.id), ['app-1']);
    assert.strictEqual(apps[0].title, 'Intake app');
});

test('all three bridge-grant shapes are found — the guard does not depend on W3 picking one', async () => {
    const { rows } = await usageForAgent(AGENT, { db });
    const pages = rows.filter(r => r.kind === 'webpage').map(r => r.id).sort();
    assert.deepStrictEqual(pages, ['wp-list', 'wp-nested', 'wp-scalar']);
});

test('an agent nothing uses comes back empty — and that emptiness was really checked', async () => {
    const { rows, partial } = await usageForAgent('agent-nobody-uses', { db });
    assert.deepStrictEqual(rows, []);
    assert.deepStrictEqual(partial, []);
});

test('the other agent gets only its own consumers', async () => {
    const { rows } = await usageForAgent(OTHER, { db });
    assert.deepStrictEqual(rows.map(r => `${r.kind}:${r.id}`).sort(), ['automation:au-2', 'task:task-2']);
});

test('a NULL definition and a non-string agentId are walked past, not crashed on', async () => {
    // au-3 has definition_json NULL, au-4 has `agentId: 42` and `agentId:
    // null`. Either would take the whole automation scan down — and a scan
    // that is down reports every automation as "not using this agent".
    const { rows, partial } = await usageForAgent(AGENT, { db });
    assert.ok(!partial.includes('automation'));
    assert.ok(rows.some(r => r.kind === 'automation'));
});

test('an id carrying jsonpath syntax is data, not syntax', async () => {
    await assert.doesNotReject(() => usageForAgent('ag" ? (@ == "x', { db }));
    const { rows, partial } = await usageForAgent('ag" ? (@ == "x', { db });
    assert.deepStrictEqual(rows, []);
    assert.deepStrictEqual(partial, []);
});

test('the batch counter agrees with the per-agent scan, over both agents at once', async () => {
    const out = await usageCountsForAgents([AGENT, OTHER, 'agent-nobody-uses'], { db });
    assert.deepStrictEqual(out[AGENT].counts, {
        task: 1, cowork: 1, support: 1, automation: 1, app: 1, webpage: 3,
    });
    assert.deepStrictEqual(out[OTHER].counts, { task: 1, automation: 1 });
    assert.deepStrictEqual(out['agent-nobody-uses'].counts, {});
    assert.deepStrictEqual(out[AGENT].partial, []);
});

test('a consumer table that is dropped becomes UNKNOWN, and the count does not silently fall', async () => {
    // The scan is re-probed every call on purpose: a cached "present" would
    // 500 the tab, and a cached "absent" would hide a whole feature from the
    // delete guard until the process restarted.
    const before_ = await usageCountsForAgents([AGENT], { db });
    assert.strictEqual(before_[AGENT].counts.app, 1);
    await pg.exec('ALTER TABLE studio_apps RENAME TO studio_apps_gone');
    try {
        const during = await usageCountsForAgents([AGENT], { db });
        assert.ok(during[AGENT].partial.includes('app'), 'unknown, not zero');
        assert.strictEqual(during[AGENT].counts.app, undefined);
        const one = await usageForAgent(AGENT, { db });
        assert.ok(one.partial.includes('app'));
    } finally {
        await pg.exec('ALTER TABLE studio_apps_gone RENAME TO studio_apps');
    }
    const after_ = await usageCountsForAgents([AGENT], { db });
    assert.strictEqual(after_[AGENT].counts.app, 1, 'and it comes back the moment the table does');
});
