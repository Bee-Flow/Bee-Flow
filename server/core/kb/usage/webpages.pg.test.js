'use strict';

/**
 * The webpages module's part of "who uses this knowledge base?" (./webpages.js), against a REAL
 * Postgres (@electric-sql/pglite, in-process; ../kbUsage.pg.testkit.js): the scrub removes the id from a page, and leaves the other base's page intact. Moved from
 * ../kbUsage.pg.test.js, which says why the scans are proved on Postgres.
 *
 * Run: cd server && node --test --test-force-exit core/kb/usage/webpages.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const kit = require('../kbUsage.pg.testkit');
const { db } = kit.usePgKbUsage(test);
const { KB, OTHER } = kit;
const { usageForKb, scrubReferences } = require('../kbUsage');

test('scrub removes the id from a page, and leaves the other base\'s page intact', async () => {
    await scrubReferences(KB, { db });
    const kinds = new Set((await usageForKb(KB, { db })).rows.map(r => r.kind));
    assert.ok(!kinds.has('webpage'));
    // And the other base's consumers were not collateral.
    const other = await usageForKb(OTHER, { db });
    assert.ok(other.rows.some(r => r.id === 'wp2'));
});
