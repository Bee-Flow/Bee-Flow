'use strict';
/**
 * The Adoption report's drill-down of the apps module's kind, through the real
 * router chain (./usageAdoption.authz.testkit.js): owners named, users
 * pseudonymous, and a top user never under their people-table label.
 *
 * Run: cd server && node --test routes/usageAdoption.authz.apps.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const r = require('./usageAdoption.authz.testkit');

const { as, LABEL, pseudonyms, get } = r;
r.useAdoptionApi();

test('the drill-down names owners but not users', async () => {
    const items = await get('/studio/items?kind=app', as('a-owner'));
    assert.equal(items.body.items[0].ownerName, 'Owner A');
    assert.match(items.body.topPeople[0].person, LABEL);
});

test('a top user of a kind never carries the label a people reveal names', async () => {
    const ps = pseudonyms();
    const items = await get('/studio/items?kind=app', as('a-owner'));
    assert.equal(items.status, 200, items.text);
    assert.deepEqual(items.body.topPeople.map((p) => p.person), [ps.top('a-colleague')]);
    const people = await get('/people?days=30', as('a-owner'));
    const tableLabels = new Set(people.body.people.map((p) => p.name));
    assert.ok(tableLabels.has(ps.label('a-colleague')));
    for (const p of items.body.topPeople) assert.ok(!tableLabels.has(p.person), `${p.person} is also a people-table label`);
});
