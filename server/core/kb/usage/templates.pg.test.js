'use strict';

/**
 * The templates module's part of "who uses this knowledge base?" (./templates.js), against a REAL
 * Postgres (@electric-sql/pglite, in-process; ../kbUsage.pg.testkit.js): the scrub removes the id from a template. Moved from
 * ../kbUsage.pg.test.js, which says why the scans are proved on Postgres.
 *
 * Run: cd server && node --test --test-force-exit core/kb/usage/templates.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const kit = require('../kbUsage.pg.testkit');
const { db } = kit.usePgKbUsage(test);
const { KB } = kit;
const { usageForKb, scrubReferences } = require('../kbUsage');

test('scrub removes the id from a template', async () => {
    await scrubReferences(KB, { db });
    const kinds = new Set((await usageForKb(KB, { db })).rows.map(r => r.kind));
    assert.ok(!kinds.has('template'));
});
