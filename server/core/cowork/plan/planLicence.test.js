/**
 * What a plan needs of its owner's licence (./planLicence.mts): a step that waits for a decision needs approvals.
 *
 * Run: cd server && node --test core/cowork/plan/planLicence.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { licenceFindings } = require('./planLicence.mts');
const { planOf, supplierRadar } = require('./plan.testkit');

const OWNER = { userId: 'u1', organizationId: 'org-1' };
const withAsk = planOf([{ id: 'a', type: 'set', fields: {} }, { id: 'ask', type: 'approval', prompt: 'Send?' }, { id: 'loop', type: 'loop', body: [{ id: 'inner', type: 'approval', prompt: 'This one?' }] }]);

test('without approvals in the licence every step that waits for a decision is a finding, with the step it is about', async () => {
    const asked = [];
    const found = await licenceFindings(withAsk, OWNER, async (owner) => { asked.push(owner); return false; });
    assert.deepStrictEqual(found.map((f) => [f.code, f.stepId]), [['ask.not_licensed', 'ask'], ['ask.not_licensed', 'inner']]);
    assert.match(found[0].message, /needs approvals/);
    assert.deepStrictEqual(asked, [OWNER]);
});

test('with approvals there is nothing to say, and a plan without such a step never asks the licence', async () => {
    assert.deepStrictEqual(await licenceFindings(withAsk, OWNER, async () => true), []);
    let asked = false;
    assert.deepStrictEqual(await licenceFindings(supplierRadar(), OWNER, async () => { asked = true; return false; }), []);
    assert.strictEqual(asked, false);
    assert.deepStrictEqual(await licenceFindings(null, OWNER, async () => false), []);
});
