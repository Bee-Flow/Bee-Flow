'use strict';

/**
 * The apps module's part of "what breaks if I delete this agent?" (./apps.js), against a
 * REAL Postgres (@electric-sql/pglite, in-process): the consumer tables as their stores declare
 * them and one consumer of every kind (../agentUsage.testkit.js). Moved from
 * ../agentUsage.pg.test.js, which says why the scans are proved on Postgres.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/usage/apps.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const kit = require('../agentUsage.testkit');
const { pg, db } = kit.usePgUsage(test);
const { AGENT } = kit;
const { usageForAgent, usageCountsForAgents } = require('../agentUsage');

test('an app is found through its PUBLISHED definition, not only its draft', async () => {
    const { rows } = await usageForAgent(AGENT, { db });
    const apps = rows.filter(r => r.kind === 'app');
    assert.deepStrictEqual(apps.map(r => r.id), ['app-1']);
    assert.strictEqual(apps[0].title, 'Intake app');
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
