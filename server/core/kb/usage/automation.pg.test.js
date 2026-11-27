'use strict';

/**
 * The automation module's part of "who uses this knowledge base?" (./automation.js), against a REAL
 * Postgres (@electric-sql/pglite, in-process; ../kbUsage.pg.testkit.js): the title comes from the real column, and the scrub leaves an automation untouched. Moved from
 * ../kbUsage.pg.test.js, which says why the scans are proved on Postgres.
 *
 * Run: cd server && node --test --test-force-exit core/kb/usage/automation.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const kit = require('../kbUsage.pg.testkit');
const { db } = kit.usePgKbUsage(test);
const { KB } = kit;
const { usageForKb, scrubReferences } = require('../kbUsage');

test('the rows carry the Used-by shape, filled in from the real columns', async () => {
    const { rows } = await usageForKb(KB, { db });
    // The one that a `name AS title` / `title` mix-up would have blanked.
    assert.strictEqual(rows.find(r => r.kind === 'automation').title, 'Weekly digest');
});

test('scrub leaves an automation untouched', async () => {
    await scrubReferences(KB, { db });
    const kinds = new Set((await usageForKb(KB, { db })).rows.map(r => r.kind));
    // Deliberately untouched — rewriting arbitrary definition JSON in place
    // risks corrupting an automation somebody spent an afternoon building.
    assert.ok(kinds.has('automation'));
});
