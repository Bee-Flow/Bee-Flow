/**
 * routine-to-automation-2026-10 against a real Postgres (PGlite): the stored
 * word "routine" becomes "automation" everywhere the code now writes the new
 * one, a row of the old ai_tasks runner becomes "cowork", a second run changes
 * nothing, and an absent table is skipped rather than an error.
 *
 * Run: cd server && node --test migrations/routine-to-automation-2026-10.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pgliteDb } = require('../testUtils/pgliteDb');

const { pg, db } = pgliteDb();
const dbPath = path.join(__dirname, '..', 'db.js');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        getOne: async (sql, params) => (await db.query(sql, params)).rows[0] || null,
        run: (sql, params) => db.query(sql, params),
    },
};

const { up, BATCH } = require('./routine-to-automation-2026-10');

const col = async (sql, params) => (await pg.query(sql, params)).rows;

before(async () => {
    await pg.exec(`
        CREATE TABLE cowork_schedules (id TEXT PRIMARY KEY);
        CREATE TABLE ai_usage_log (id SERIAL PRIMARY KEY, source TEXT, agent_type TEXT, conversation_id TEXT);
        CREATE TABLE guardrail_events (id SERIAL PRIMARY KEY, source TEXT, automation_id TEXT, conversation_id TEXT);
        CREATE TABLE connection_grants (id SERIAL PRIMARY KEY, resource_type TEXT,
            CONSTRAINT connection_grants_resource_type_check CHECK (resource_type IS NULL OR resource_type IN ('agent','webpage','skill','routine','studio_app')));
        CREATE TABLE documents (id SERIAL PRIMARY KEY, source_type TEXT, metadata JSONB);
        CREATE TABLE kb_sources (id SERIAL PRIMARY KEY, config JSONB NOT NULL);
        CREATE TABLE playbooks (id TEXT PRIMARY KEY, phases JSONB NOT NULL, recipe JSONB, current_phase TEXT);
        CREATE TABLE automations (id TEXT PRIMARY KEY, definition_json JSONB NOT NULL, live_definition_json JSONB);
        CREATE TABLE notifications (id TEXT PRIMARY KEY, message TEXT DEFAULT '');
        INSERT INTO notifications VALUES ('n1', E'routine_reauth:google\\n\\nYour Google access has expired.'), ('n2', 'a routine_reauth: in the middle');

        INSERT INTO cowork_schedules VALUES ('cw1');
        INSERT INTO ai_usage_log (source, agent_type, conversation_id) VALUES
            ('routine', 'routine', 'auto-run-1'),
            ('routine', 'routine', 'cw1'),
            ('direct_chat', 'agent', 'c9');
        INSERT INTO guardrail_events (source, automation_id, conversation_id) VALUES
            ('routine', 'a1', 'a1'), ('routine', NULL, 'cw1');
        INSERT INTO connection_grants (resource_type) VALUES ('routine'), ('agent');
        INSERT INTO documents (source_type, metadata) VALUES
            ('routine_write', '{"ingestedBy":"routine","provider":"automation"}'),
            ('support_ticket', '{"ingestedBy":"support"}');
        INSERT INTO kb_sources (config) VALUES ('{"sourceType":"routine_write","automationId":"a1"}');
        INSERT INTO playbooks VALUES
            ('pb1', '[{"key":"routine","kind":"routine"},{"key":"approvals","kind":"routine","requires":"approvals"}]',
             '{"phases":[{"kind":"routine"}]}', 'routine');
        INSERT INTO automations VALUES
            ('a1', '{"steps":[{"type":"ai_step","enabledApps":["memory","routine-evolution"]}]}', NULL);
    `);
});
after(async () => { await pg.close(); });

test('relabels every stored "routine" and sends the old ai_tasks rows to cowork', async () => {
    await up();

    assert.deepEqual(await col('SELECT source, agent_type FROM ai_usage_log ORDER BY id'), [
        { source: 'automation', agent_type: 'automation' },
        { source: 'cowork', agent_type: 'cowork' },
        { source: 'direct_chat', agent_type: 'agent' },
    ]);
    assert.deepEqual((await col('SELECT source FROM guardrail_events ORDER BY id')).map((r) => r.source), ['automation', 'cowork'],
        'automation_id decides where the table has it');
    assert.deepEqual((await col('SELECT resource_type FROM connection_grants ORDER BY id')).map((r) => r.resource_type), ['automation', 'agent']);
    await pg.query(`INSERT INTO connection_grants (resource_type) VALUES ('automation')`);
    await assert.rejects(pg.query(`INSERT INTO connection_grants (resource_type) VALUES ('routine')`), /check/i,
        'the CHECK list now names automation, not routine');

    const docs = await col('SELECT source_type, metadata FROM documents ORDER BY id');
    assert.equal(docs[0].source_type, 'automation_write');
    assert.equal(docs[0].metadata.ingestedBy, 'automation');
    assert.equal(docs[1].metadata.ingestedBy, 'support', 'another origin is left alone');
    assert.equal((await col('SELECT config FROM kb_sources'))[0].config.sourceType, 'automation_write');

    const [pb] = await col('SELECT phases, recipe, current_phase FROM playbooks');
    assert.deepEqual(pb.phases, [{ key: 'automation', kind: 'automation' }, { key: 'approvals', kind: 'automation', requires: 'approvals' }]);
    assert.deepEqual(pb.recipe, { phases: [{ kind: 'automation' }] });
    assert.equal(pb.current_phase, 'automation');

    const notes = await col('SELECT message FROM notifications ORDER BY id');
    assert.equal(notes[0].message, 'automation_reauth:google\n\nYour Google access has expired.');
    assert.equal(notes[1].message, 'a routine_reauth: in the middle', 'only the token at the head');

    const [a] = await col('SELECT definition_json FROM automations');
    assert.deepEqual(a.definition_json.steps[0].enabledApps, ['memory', 'automation-evolution']);
});

test('a second run changes nothing', async () => {
    const summary = await up();
    assert.ok(Object.values(summary).every((n) => n === 0), JSON.stringify(summary));
});

test('the usage log is drained in batches until no old row is left', async () => {
    await pg.query(`INSERT INTO ai_usage_log (source, agent_type, conversation_id)
                    SELECT 'routine', 'routine', 'run-' || g FROM generate_series(1, ${BATCH + 5}) g`);
    const summary = await up();
    assert.equal(summary.ai_usage_log, BATCH + 5);
    assert.equal((await col(`SELECT COUNT(*)::int AS n FROM ai_usage_log WHERE source = 'routine'`))[0].n, 0);
});

test('a table that does not exist is skipped', async () => {
    const summary = await up();
    assert.equal(summary.integration_activity_log, undefined);
    assert.equal(summary.ai_task_termination_log, undefined);
});
