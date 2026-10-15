'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDeploymentsStore } = require('./deployments');

test('makeDeploymentsStore exposes exactly the documented API', () => {
    const store = makeDeploymentsStore({}, { ready: async () => {} });
    assert.deepEqual(Object.keys(store).sort(), [
        'appendStep', 'claimDeployment', 'closeAwaiting', 'getDeployment', 'getDeploymentByRequestKey', 'heartbeat',
        'insertDeployment', 'isActiveDeployment', 'listClaimable', 'listDeployments', 'listExpiredLeases', 'listSteps',
        'reclaimExpired', 'reconcileAwaitingApprovals', 'recordDeploymentDecision', 'retryConverge', 'setApprovalId',
        'transitionDeployment', 'updateStep',
    ]);
});
