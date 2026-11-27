'use strict';
/**
 * The playbooks module's kind of the Adoption report (kinds.playbooks.js),
 * against the real schemas (PGlite, ./adoption.testkit.js).
 *
 * Run: cd server && node --test stores/adoption/kinds.playbooks.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');

kit.use();

test('a playbook has no ledger area: no cost', async () => {
    const out = await kit.store().studio(kit.scope());
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    assert.equal(k.playbook.cost, null);
});
