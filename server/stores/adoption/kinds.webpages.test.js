'use strict';
/**
 * The webpages module's kind of the Adoption report (kinds.webpages.js),
 * against the real schemas (PGlite, ./adoption.testkit.js).
 *
 * Run: cd server && node --test stores/adoption/kinds.webpages.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');

kit.use();

test('public views name nobody', async () => {
    const out = await kit.store().studio(kit.scope());
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    assert.equal(k.webpage.usage?.people, null, 'public views name nobody');
});

test('a webpage published inside the organisation is not "unused": its evidence cannot see internal visits', async () => {
    const out = await kit.store().studioItems(kit.scope(), 'webpage', 50);
    assert.deepEqual(out?.items.map((i) => [i.id, i.audience]), [['a-page', 'org']]);
    assert.deepEqual(out?.unused, []);
});
