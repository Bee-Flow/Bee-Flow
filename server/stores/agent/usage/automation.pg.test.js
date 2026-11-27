'use strict';

/**
 * The automation module's part of "what breaks if I delete this agent?" (./automation.js), against a
 * REAL Postgres (@electric-sql/pglite, in-process): the consumer tables as their stores declare
 * them and one consumer of every kind (../agentUsage.testkit.js). Moved from
 * ../agentUsage.pg.test.js, which says why the scans are proved on Postgres.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/usage/automation.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const kit = require('../agentUsage.testkit');
const { db } = kit.usePgUsage(test);
const { AGENT } = kit;
const { usageForAgent } = require('../agentUsage');

test('an automation that names the agent in two steps is ONE automation that breaks', async () => {
    const { rows } = await usageForAgent(AGENT, { db });
    const automations = rows.filter(r => r.kind === 'automation');
    assert.deepStrictEqual(automations.map(r => r.id), ['au-1']);
    assert.strictEqual(automations[0].title, 'Weekly digest');
});

test('a NULL definition and a non-string agentId are walked past, not crashed on', async () => {
    // au-3 has definition_json NULL, au-4 has `agentId: 42` and `agentId:
    // null`. Either would take the whole automation scan down — and a scan
    // that is down reports every automation as "not using this agent".
    const { rows, partial } = await usageForAgent(AGENT, { db });
    assert.ok(!partial.includes('automation'));
    assert.ok(rows.some(r => r.kind === 'automation'));
});
