'use strict';

/**
 * The cowork module's part of "what breaks if I delete this agent?" (./cowork.js), against a
 * REAL Postgres (@electric-sql/pglite, in-process): the consumer tables as their stores declare
 * them and one consumer of every kind (../agentUsage.testkit.js). Moved from
 * ../agentUsage.pg.test.js, which says why the scans are proved on Postgres.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/usage/cowork.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const kit = require('../agentUsage.testkit');
const { db } = kit.usePgUsage(test);
const { AGENT } = kit;
const { usageForAgent } = require('../agentUsage');

test('a task carries its title, owner and last run', async () => {
    const { rows } = await usageForAgent(AGENT, { db });
    const task = rows.find(r => r.kind === 'task');
    assert.strictEqual(task.id, 'task-1');
    assert.strictEqual(task.title, 'Nightly report');
    assert.strictEqual(task.ownerId, 'u1');
    assert.strictEqual(task.role, 'automation');
    assert.strictEqual(new Date(task.lastAt).toISOString(), '2026-09-01T06:00:00.000Z');
});
