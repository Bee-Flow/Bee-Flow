'use strict';

/**
 * The support module's part of "what breaks if I delete this agent?" (./support.js), against a
 * REAL Postgres (@electric-sql/pglite, in-process): the consumer tables as their stores declare
 * them and one consumer of every kind (../agentUsage.testkit.js). Moved from
 * ../agentUsage.pg.test.js, which says why the scans are proved on Postgres.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/usage/support.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const kit = require('../agentUsage.testkit');
const { db } = kit.usePgUsage(test);
const { AGENT, INBOX } = kit;
const { usageForAgent } = require('../agentUsage');

test('a support inbox comes back with a TEXT id, like every other kind', async () => {
    const { rows } = await usageForAgent(AGENT, { db });
    const inbox = rows.find(r => r.kind === 'support');
    assert.strictEqual(inbox.id, INBOX);
    assert.strictEqual(typeof inbox.id, 'string');
    assert.strictEqual(inbox.title, 'Helpdesk');
    assert.strictEqual(inbox.role, 'auto_reply');
});
