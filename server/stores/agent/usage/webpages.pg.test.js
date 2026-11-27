'use strict';

/**
 * The webpages module's part of "what breaks if I delete this agent?" (./webpages.js), against a
 * REAL Postgres (@electric-sql/pglite, in-process): the consumer tables as their stores declare
 * them and one consumer of every kind (../agentUsage.testkit.js). Moved from
 * ../agentUsage.pg.test.js, which says why the scans are proved on Postgres.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/usage/webpages.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const kit = require('../agentUsage.testkit');
const { db } = kit.usePgUsage(test);
const { AGENT } = kit;
const { usageForAgent } = require('../agentUsage');

test('all three bridge-grant shapes are found — the guard does not depend on W3 picking one', async () => {
    const { rows } = await usageForAgent(AGENT, { db });
    const pages = rows.filter(r => r.kind === 'webpage').map(r => r.id).sort();
    assert.deepStrictEqual(pages, ['wp-list', 'wp-nested', 'wp-scalar']);
});
