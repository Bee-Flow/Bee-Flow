const {test} = require('node:test');
const assert = require('node:assert/strict');
const {planTriggerUpdate} = require('./coworkTrigger');

test('file subscriptions follow explicit pause and resume, including retries', async () => {
    const existing = {id: 'files', userId: 'owner', triggerKind: 'file'};
    const update = body => planTriggerUpdate({existing, body, userId: 'owner', resolvedAgentId: null, session: {}, resolveAgentId: async () => null});
    for (const isActive of [false, false, true]) assert.equal((await update({isActive})).syncs, true);
    assert.equal((await update({title: 'Invoices'})).syncs, false);
});
