'use strict';

/**
 * The apps module's part of "who uses this knowledge base?" (./apps.js), against a REAL
 * Postgres (@electric-sql/pglite, in-process; ../kbUsage.pg.testkit.js): an app is found through its published definition, and the scrub leaves it untouched. Moved from
 * ../kbUsage.pg.test.js, which says why the scans are proved on Postgres.
 *
 * Run: cd server && node --test --test-force-exit core/kb/usage/apps.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const kit = require('../kbUsage.pg.testkit');
const { db } = kit.usePgKbUsage(test);
const { KB } = kit;
const { usageForKb, scrubReferences } = require('../kbUsage');

test('an app is found through its published definition alone', async () => {
    const { rows } = await usageForKb(KB, { db });
    const app = rows.find(r => r.kind === 'app');
    assert.strictEqual(app.id, 'sa1', 'the working definition is {} — only the published one names it');
});

test('scrub leaves an app untouched', async () => {
    await scrubReferences(KB, { db });
    const kinds = new Set((await usageForKb(KB, { db })).rows.map(r => r.kind));
    // Deliberately untouched — rewriting arbitrary definition JSON in place
    // risks corrupting what somebody spent an afternoon building.
    assert.ok(kinds.has('app'));
});
