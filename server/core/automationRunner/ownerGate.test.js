'use strict';
/** ownerRefusal: the owner gate executeAutomation asks. Run: node --test core/automationRunner/ownerGate.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ownerRefusal } = require('./ownerGate.mts');

const isActiveAccount = (row) => !!row && (!row.status || row.status === 'active');
const deps = (row, entitled = true) => ({ getUser: async () => row, isActiveAccount, hasCapability: async () => entitled });

test('an active, entitled owner may run', async () => {
    assert.equal(await ownerRefusal({ userId: 'u1', organizationId: 'o1' }, deps({ status: 'active' })), null);
});

test('a suspended owner is refused', async () => {
    assert.equal(await ownerRefusal({ userId: 'u1' }, deps({ status: 'suspended' })), 'inactive');
});

test('an owner whose organisation lost the capability is refused', async () => {
    let asked = null;
    const d = { ...deps({ status: 'active' }), hasCapability: async (cap, ctx) => { asked = [cap, ctx]; return false; } };
    assert.equal(await ownerRefusal({ userId: 'u1', organizationId: 'o1' }, d), 'not_entitled');
    assert.deepEqual(asked, ['automations', { userId: 'u1', orgId: 'o1' }]);
});

// A missing owner passes the gate on purpose: erasing an account deletes its
// automations (and their schedules by cascade), so no automation is left that
// names an owner who no longer exists. This pins that assumption on the
// erasure map; migrateDb.integration.test.js runs the erasure against the real
// schema and checks the automations are gone.
test('erasing an owner deletes the automations keyed by them', () => {
    const { ERASURE_COVERAGE } = require('../../stores/user/erasureCoverage');
    assert.deepEqual({ ...ERASURE_COVERAGE.automations }, { mode: 'deleted', column: 'user_id' });
    assert.equal(ERASURE_COVERAGE.automation_schedules.mode, 'cascade');
    assert.equal(ERASURE_COVERAGE.automation_schedules.parent, 'automations');
});
