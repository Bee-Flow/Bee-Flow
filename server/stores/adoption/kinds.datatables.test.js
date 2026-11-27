'use strict';
/**
 * The datatables module's kind of the Adoption report (kinds.datatables.js),
 * against the real schemas (PGlite, ./adoption.testkit.js).
 *
 * Run: cd server && node --test stores/adoption/kinds.datatables.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');

kit.use();

test('the datatables of org A are counted, and no usage signal is invented', async () => {
    const out = await kit.store().studio(kit.scope());
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    assert.equal(k.datatable.total, 1);
    assert.equal(k.datatable.usage, null, 'no signal is said, not invented');
});
