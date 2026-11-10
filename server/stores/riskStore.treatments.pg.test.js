// @typecheck
/**
 * riskStore.addTreatment against a real Postgres (pglite): a treatment is
 * added to a risk of the caller's own organisation only. A risk id of another
 * organisation, an unknown one, or one that is no number adds no row and
 * answers null instead of leaving a dangling treatment or failing the request.
 *
 * Run: cd server && node --test stores/riskStore.treatments.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const riskStore = require('./riskStore');

let riskA;
let riskB;

before(async () => {
    riskA = await riskStore.createRisk('org-a', { title: 'Risk of A', likelihood: 2, impact: 2 }, 'anna');
    riskB = await riskStore.createRisk('org-b', { title: 'Risk of B', likelihood: 4, impact: 4 }, 'ben');
});
after(close);

const treatments = async () => (await pg.query('SELECT organization_id, risk_id, option, owner_user_id FROM iso_risk_treatments ORDER BY id')).rows;

test('a treatment is added to a risk of the caller\'s organisation', async () => {
    const t = await riskStore.addTreatment('org-a', String(riskA.id), { option: 'transfer', description: 'Insure it', due_at: '2030-01-01T00:00:00Z' }, 'anna');
    assert.equal(t.risk_id, riskA.id);
    assert.equal(t.organization_id, 'org-a');
    assert.equal(t.option, 'transfer');
    assert.equal(t.owner_user_id, 'anna');
    assert.equal(new Date(t.due_at).toISOString(), '2030-01-01T00:00:00.000Z');

    const fallback = await riskStore.addTreatment('org-a', riskA.id, { option: 'no-such-option' });
    assert.equal(fallback.option, 'mitigate');
    assert.equal(fallback.due_at, null);
});

test('a risk of another organisation, an unknown risk and a non-numeric id add nothing and answer null', async () => {
    const before = await treatments();
    assert.equal(await riskStore.addTreatment('org-a', String(riskB.id), { description: 'not mine' }, 'anna'), null);
    assert.equal(await riskStore.addTreatment('org-a', '999999', {}, 'anna'), null);
    for (const id of ['abc', '1; DROP TABLE iso_risks', '1.5', '-1', '99999999999999999999']) {
        assert.equal(await riskStore.addTreatment('org-a', id, {}, 'anna'), null, `id ${id}`);
    }
    assert.deepEqual(await treatments(), before, 'no dangling treatment row');
});
