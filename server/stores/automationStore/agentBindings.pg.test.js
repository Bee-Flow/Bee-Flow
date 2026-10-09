/**
 * automation_agent_bindings against a real Postgres (@electric-sql/pglite,
 * in-process). The store is built with makeAgentBindingsStore over the PGlite
 * handle: no module mocking.
 *
 * Proven:
 *   - the table is created by the migration and a second run changes nothing;
 *   - apply adds and removes in one go, keeps the row of a link that stays, and
 *     ignores a duplicate or a missing one;
 *   - the automations bound to an agent come back as store rows, with the live
 *     copy, and trashed automations and Steps are left out;
 *   - the rows go with the automation (ON DELETE CASCADE) and with the agent
 *     (deleteBindingsForAgent), and a binding never copies with the automation.
 *
 * Run: cd server && node --test stores/automationStore/agentBindings.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');

const { pg, db } = pgliteDb();

const handoff5 = require('../../migrations/automation-handoff5-2026-09');
const bindingsMigration = require('../../migrations/automation-agent-bindings-2026-10');
const { makeAgentBindingsStore } = require('./agentBindings');

const store = makeAgentBindingsStore(db);

async function seedAutomation(id, { kind = 'automation', deleted = false, active = true } = {}) {
    await pg.query(
        `INSERT INTO automations (id, user_id, organization_id, kind, title, definition_json, is_active, deleted_at)
         VALUES ($1, 'owner', 'org1', $2, $1, '{"trigger":{"kind":"agent_call"}}', $3, $4)`,
        [id, kind, active, deleted ? new Date().toISOString() : null],
    );
}

before(async () => {
    await pg.exec(`
        CREATE TABLE automations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            project_id TEXT,
            kind TEXT NOT NULL DEFAULT 'automation',
            title TEXT NOT NULL,
            description TEXT,
            definition_json JSONB NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            is_active BOOLEAN NOT NULL DEFAULT FALSE,
            is_draft BOOLEAN NOT NULL DEFAULT TRUE,
            needs_first_run_confirm BOOLEAN NOT NULL DEFAULT TRUE,
            trigger_type TEXT NOT NULL DEFAULT 'manual',
            schedule_cron TEXT,
            schedule_tz TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
            next_run_at TIMESTAMPTZ,
            run_timeout_ms INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE automation_versions (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            definition_json JSONB NOT NULL,
            saved_by_user_id TEXT NOT NULL,
            UNIQUE (automation_id, version)
        );
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            trigger_kind TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            finished_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE automation_run_steps (
            run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL,
            step_type TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (run_id, step_id, attempts)
        );
    `);
    await handoff5.up({ exec: (sql) => pg.exec(sql) });
});

after(async () => { await pg.close(); });

test('the migration creates the table, and a second run changes nothing', async () => {
    await bindingsMigration.up({ exec: (sql) => pg.exec(sql) });
    await bindingsMigration.up({ exec: (sql) => pg.exec(sql) });
    const cols = (await pg.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'automation_agent_bindings' ORDER BY ordinal_position`,
    )).rows.map((r) => r.column_name);
    assert.deepStrictEqual(cols, ['id', 'automation_id', 'agent_id', 'created_by', 'created_at']);
});

test('it is registered in the automationStore ladder', () => {
    const { MIGRATIONS } = require('./core');
    assert.strictEqual(MIGRATIONS.filter((m) => m === 'automation-agent-bindings-2026-10').length, 1);
});

test('apply adds and removes in one go and keeps the row of a link that stays', async () => {
    await seedAutomation('r1');
    let rows = await store.applyAgentBindings('r1', { add: ['agt1', 'agt2'] }, 'owner');
    assert.deepStrictEqual(rows.map((r) => [r.agentId, r.createdBy]), [['agt1', 'owner'], ['agt2', 'owner']]);
    const firstId = rows[0].id;

    rows = await store.applyAgentBindings('r1', { add: ['agt2', 'agt3'], remove: ['agt1', 'agt-never-there'] }, 'ed');
    assert.deepStrictEqual(rows.map((r) => [r.agentId, r.createdBy]), [['agt2', 'owner'], ['agt3', 'ed']],
        'agt2 keeps its row and who made it; agt3 is new');
    assert.notStrictEqual(rows[0].id, firstId);

    assert.strictEqual(await store.hasAgentBinding('r1', 'agt2'), true);
    assert.strictEqual(await store.hasAgentBinding('r1', 'agt1'), false);
    assert.strictEqual(await store.hasAgentBinding('r1', null), false);
});

test('a link is unique per automation and agent', async () => {
    await assert.rejects(
        pg.query(`INSERT INTO automation_agent_bindings (id, automation_id, agent_id) VALUES ('dup', 'r1', 'agt2')`),
        /unique|duplicate/i,
    );
});

test('the automations bound to an agent: live rows only, no trash, no Steps', async () => {
    await seedAutomation('b1');
    await seedAutomation('b2', { active: false });
    await seedAutomation('b3-trashed', { deleted: true });
    await seedAutomation('b4-step', { kind: 'block' });
    for (const id of ['b1', 'b2', 'b3-trashed', 'b4-step']) await store.applyAgentBindings(id, { add: ['agtX'] }, 'owner');
    await store.applyAgentBindings('b1', { add: ['agtY'] }, 'owner');

    const bound = await store.listAutomationsBoundToAgent('agtX');
    assert.deepStrictEqual(bound.map((a) => [a.id, a.isActive]).sort(), [['b1', true], ['b2', false]]);
    assert.deepStrictEqual((await store.listAutomationsBoundToAgent('agtY')).map((a) => a.id), ['b1']);
    assert.deepStrictEqual(await store.listAutomationsBoundToAgent('agt-nobody'), []);
    assert.deepStrictEqual(await store.listAutomationsBoundToAgent(null), []);
});

test('the rows go with the automation and with the agent', async () => {
    await seedAutomation('c1');
    await store.applyAgentBindings('c1', { add: ['agtC', 'agtD'] }, 'owner');
    assert.strictEqual(await store.deleteBindingsForAgent('agtC'), 1);
    assert.deepStrictEqual((await store.listBindingsForAutomation('c1')).map((b) => b.agentId), ['agtD']);

    await pg.query(`DELETE FROM automations WHERE id = 'c1'`);
    assert.deepStrictEqual(await store.listBindingsForAutomation('c1'), []);
    assert.strictEqual(await store.deleteBindingsForAgent(null), 0);
});

test('a copy of an automation does not carry the links: they are rows beside it, not part of its definition', async () => {
    await seedAutomation('d1');
    await store.applyAgentBindings('d1', { add: ['agtZ'] }, 'owner');
    // What duplicate / import / restore do: copy the definition into a new row.
    await pg.query(
        `INSERT INTO automations (id, user_id, organization_id, title, definition_json)
         SELECT 'd1-copy', user_id, organization_id, title, definition_json FROM automations WHERE id = 'd1'`,
    );
    assert.deepStrictEqual(await store.listBindingsForAutomation('d1-copy'), []);
    assert.strictEqual(await store.hasAgentBinding('d1-copy', 'agtZ'), false);
});
