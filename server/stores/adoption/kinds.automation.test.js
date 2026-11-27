'use strict';
/**
 * The automation module's kinds of the Adoption report (kinds.automation.js),
 * against the real schemas (PGlite, ./adoption.testkit.js).
 *
 * Run: cd server && node --test stores/adoption/kinds.automation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');

kit.use();

test('counts, usage and cost of the automations of org A', async () => {
    const out = await kit.store().studio(kit.scope());
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    // The automation has no organisation of its own: it is the owner's.
    assert.equal(k.automation.total, 1);
    assert.equal(k.automation.newInPeriod, 0);
    assert.deepEqual(k.automation.usage, { events: 1, people: 1, label: 'runs' });
    assert.equal(k.automation.cost, 0.5);
});

test('org B\'s private automation is counted, not listed', async () => {
    const flows = await kit.store().studioItems(kit.scope(kit.ORG_B), 'automation', 50);
    assert.equal(flows?.total, 1, 'the private automation of B is counted, not listed');
});

test('the owner of an automation has built it', async () => {
    const out = await kit.store().people(kit.scope(), { limit: 50, cursor: 0 });
    const owner = out.people.find((p) => p.id === 'a-owner');
    assert.equal(owner?.built.automation, 1);
});
