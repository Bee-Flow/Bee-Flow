const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const userStore = require('../../stores/userStore');
const { handleSubscriptionUpdated, handleSubscriptionDeletedForOrg } = require('./subscriptionEvents');

const saved = {};
const patch = (name, fn) => { if (!(name in saved)) saved[name] = userStore[name]; userStore[name] = fn; };
afterEach(() => { for (const [k, v] of Object.entries(saved)) userStore[k] = v; for (const k of Object.keys(saved)) delete saved[k]; });

let writes;
beforeEach(() => {
    writes = [];
    patch('getAllOrgSubscriptions', async () => []);
    patch('getAllConsumerSubscriptions', async () => []);
    patch('getOrgSubscription', async () => { throw new Error('db down'); });
    patch('downgradeOrgToFreePlan', async () => { writes.push('downgrade'); return true; });
    patch('setOrgSubscription', async () => { writes.push('set'); });
    patch('setOrgSubscriptionRespectingOverride', async () => { writes.push('setOverride'); return {}; });
    patch('logSubscriptionAudit', async () => {});
});

test('subscription.deleted: a failed subscription lookup throws instead of downgrading a paying org', async () => {
    await assert.rejects(handleSubscriptionDeletedForOrg('org1', {}), /db down/);
    assert.deepEqual(writes, []);
});

test('subscription.updated: a failed prior-row lookup throws before any write', async () => {
    const sub = { id: 'sub_1', status: 'active', metadata: { beeflow_org_id: 'org1' }, items: { data: [] } };
    await assert.rejects(handleSubscriptionUpdated(sub), /db down/);
    assert.deepEqual(writes, []);
});
