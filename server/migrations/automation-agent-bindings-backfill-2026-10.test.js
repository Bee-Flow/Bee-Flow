/**
 * automation-agent-bindings-backfill-2026-10 against a real Postgres (PGlite):
 * an agent_call automation (active or paused) is bound to the agents its OWNER already chose
 * per agent, and to nothing else, and a second run changes nothing.
 *
 * Proven:
 *   - an agent whose config.tools.automations lists the automation is bound;
 *   - a persona hand-off to the automation binds that agent too;
 *   - the published copy of the config counts as well;
 *   - an agent that curated nothing is NOT bound (nobody touched the list);
 *   - an agent of someone else that names the id is NOT bound (wider than today);
 *   - a paused automation is bound too (resuming it made it callable before
 *     the upgrade; the dispatch still refuses it while paused);
 *   - one that is not an agent trigger (live copy decides) and a trashed one
 *     are skipped;
 *   - a second run adds nothing, and a replay (a changed checksum, an unreadable
 *     ledger, --force) does not re-bind a pair the owner unlinked since;
 *   - a first run that found nothing still ends it, so an automation created
 *     after the upgrade is never bound by a replay;
 *   - the migration waits (throws) while a table is missing, and is registered
 *     in the boot ladder.
 *
 * Run: cd server && node --test migrations/automation-agent-bindings-backfill-2026-10.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { up, chosenAutomationIds } = require('./automation-agent-bindings-backfill-2026-10');
const tableMigration = require('./automation-agent-bindings-2026-10');

const { pg, db } = pgliteDb();

const agentCall = JSON.stringify({ trigger: { kind: 'agent_call', toolName: 't' } });
const manual = JSON.stringify({ trigger: { kind: 'manual' } });

async function automation(id, { owner = 'u1', active = true, def = agentCall, live = null, deleted = false, kind = 'automation' } = {}) {
    await pg.query(
        `INSERT INTO automations (id, user_id, kind, is_active, definition_json, live_definition_json, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, owner, kind, active, def, live, deleted ? new Date().toISOString() : null],
    );
}
async function agent(id, owner, { config = null, published = null, persona = null } = {}) {
    await pg.query(
        `INSERT INTO agents (id, owner_id, config, published_config, persona) VALUES ($1, $2, $3, $4, $5)`,
        [id, owner, config === null ? '{}' : JSON.stringify(config), published, persona],
    );
}
const bound = async () => (await pg.query(
    `SELECT automation_id, agent_id FROM automation_agent_bindings ORDER BY automation_id, agent_id`,
)).rows.map((r) => `${r.automation_id}>${r.agent_id}`);

before(async () => {
    await pg.exec(`
        CREATE TABLE automations (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'automation',
            is_active BOOLEAN NOT NULL DEFAULT FALSE, definition_json JSONB NOT NULL,
            live_definition_json JSONB, deleted_at TIMESTAMPTZ
        );
        CREATE TABLE agents (
            id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, config TEXT DEFAULT '{}',
            published_config JSONB, persona JSONB
        );
    `);
    await tableMigration.up({ exec: (sql) => pg.exec(sql) });

    await automation('a-granted');
    await automation('a-handoff');
    await automation('a-published-only');
    await automation('a-uncurated');
    await automation('a-colleague');
    await automation('a-paused', { active: false });
    await automation('a-retired', { def: agentCall, live: manual });          // live copy is no longer an agent trigger
    await automation('a-went-live-as-tool', { def: manual, live: agentCall });  // live copy decides
    await automation('a-trashed', { deleted: true });
    await automation('a-step', { kind: 'block' });
    await automation('a-other-owner', { owner: 'u2' });

    await agent('g1', 'u1', { config: { tools: { automations: { 'a-granted': { confirm: 'ask' }, 'a-paused': {}, 'a-retired': {}, 'a-trashed': {}, 'a-step': {} } } } });
    await agent('g2', 'u1', { persona: { unknown: { mode: 'handoff', automationId: 'a-handoff' } } });
    await agent('g3', 'u1', { published: { tools: { automations: { 'a-published-only': {} } } } });
    await agent('g4', 'u1', { config: { tools: { gmail: { actions: ['gmail_search'] } } } });                   // curated an app, not automations
    await agent('g5', 'u1', { config: {} });                                                                     // nothing at all
    await agent('g6', 'u2', { config: { tools: { automations: { 'a-colleague': {}, 'a-granted': {} } } } });    // someone else's agent naming u1's ids
    await agent('g7', 'u1', { config: { tools: { automations: { 'a-went-live-as-tool': {} } } } });
    await agent('g8', 'u1', { persona: { unknown: { mode: 'honest', automationId: 'a-uncurated' } } });         // not a hand-off
    await agent('g9', 'u1', { config: 'not json {' });
    await pg.query(`UPDATE agents SET config = 'not json {' WHERE id = 'g9'`);
    await agent('g10', 'u2', { config: { tools: { automations: { 'a-other-owner': {} } } } });
});
after(async () => { await pg.close(); });

test('binds the agents the owner already chose per agent, and nothing else', async () => {
    const out = await up({ db });
    assert.deepStrictEqual(await bound(), [
        'a-granted>g1',
        'a-handoff>g2',
        'a-other-owner>g10',
        'a-paused>g1',
        'a-published-only>g3',
        'a-went-live-as-tool>g7',
    ]);
    assert.strictEqual(out.bound, 6);
});

test('an uncurated agent, a colleague\'s agent, a retired, trashed or Step automation stay unbound', async () => {
    const rows = await bound();
    for (const nope of ['a-uncurated', 'a-colleague', 'a-retired', 'a-trashed', 'a-step']) {
        assert.ok(!rows.some((r) => r.startsWith(`${nope}>`)), `${nope} must stay unbound`);
    }
    assert.ok(!rows.includes('a-granted>g6'), 'an agent of someone else cannot be given u1\'s automation');
});

test('a second run changes nothing', async () => {
    const before = await bound();
    const out = await up({ db });
    assert.deepStrictEqual(await bound(), before);
    assert.strictEqual(out.bound, 0);
});

test('a replay does not bring back a link the owner removed after the upgrade', async () => {
    // The boot ledger re-runs an entry when its file changes, when the ledger is
    // unreadable and on --force; the migration has to hold on its own.
    await pg.query(`DELETE FROM automation_agent_bindings WHERE automation_id = 'a-granted' AND agent_id = 'g1'`);
    const out = await up({ db });
    assert.strictEqual(out.skipped, true);
    assert.ok(!(await bound()).includes('a-granted>g1'), 'the unlinked pair stays unlinked');
});

test('a first run that found nothing to bind still ends the backfill', async () => {
    const { pgliteDb: fresh } = require('../testUtils/pgliteDb');
    const other = fresh();
    try {
        await other.pg.exec(`
            CREATE TABLE automations (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'automation',
                is_active BOOLEAN NOT NULL DEFAULT FALSE, definition_json JSONB NOT NULL,
                live_definition_json JSONB, deleted_at TIMESTAMPTZ
            );
            CREATE TABLE agents (
                id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, config TEXT DEFAULT '{}',
                published_config JSONB, persona JSONB
            );
        `);
        await tableMigration.up({ exec: (sql) => other.pg.exec(sql) });
        assert.deepStrictEqual(await up({ db: other.db }), { automations: 0, bound: 0 });
        // Created AFTER the upgrade, with an agent that lists it: not an existing link.
        await other.pg.query(
            `INSERT INTO automations (id, user_id, is_active, definition_json) VALUES ('late', 'u1', TRUE, $1)`, [agentCall]);
        await other.pg.query(
            `INSERT INTO agents (id, owner_id, config) VALUES ('g1', 'u1', $1)`,
            [JSON.stringify({ tools: { automations: { late: {} } } })]);
        const again = await up({ db: other.db });
        assert.strictEqual(again.skipped, true);
        const rows = (await other.pg.query(`SELECT 1 FROM automation_agent_bindings`)).rows;
        assert.strictEqual(rows.length, 0);
    } finally {
        await other.pg.close();
    }
});

test('it reads the three places a choice is written, tolerating junk', () => {
    assert.deepStrictEqual([...chosenAutomationIds({
        config: '{"tools":{"automations":{"x":{}}}}',
        published_config: { tools: { automations: { y: {} } } },
        persona: { unknown: { mode: 'handoff', automationId: 'z' } },
    })].sort(), ['x', 'y', 'z']);
    assert.deepStrictEqual([...chosenAutomationIds({ config: 'junk', published_config: null, persona: 'junk' })], []);
    assert.deepStrictEqual([...chosenAutomationIds({ config: { tools: { automations: ['x'] } } })], [], 'a list is not the grant shape');
});

test('it waits while a table it needs is missing, so the ledger does not record it', async () => {
    const { pgliteDb: fresh } = require('../testUtils/pgliteDb');
    const other = fresh();
    try {
        await assert.rejects(up({ db: other.db }), /does not exist yet/);
    } finally {
        await other.pg.close();
    }
});

test('it is a boot migration of the loose ladder', () => {
    const { LOOSE_MIGRATIONS } = require('../boot/bootMigrations');
    assert.strictEqual(LOOSE_MIGRATIONS.filter((m) => m === 'automation-agent-bindings-backfill-2026-10').length, 1);
});
