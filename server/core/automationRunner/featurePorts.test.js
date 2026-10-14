/**
 * core/automationRunner/featurePorts.js: the registry, and the contract that
 * the features fill every port the runner calls.
 *
 * Run: cd server && node --test core/automationRunner/featurePorts.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ports = require('./featurePorts');

test('a registered port is returned; an unregistered one throws naming the boot module', () => {
    ports.registerRunnerPorts({ _probe: { ping: () => 'pong' } });
    assert.strictEqual(ports.runnerPort('_probe').ping(), 'pong');
    assert.ok(ports.hasRunnerPort('_probe'));
    ports._clearRunnerPortsForTests('_probe');
    assert.ok(!ports.hasRunnerPort('_probe'));
    assert.throws(() => ports.runnerPort('_probe'), /"_probe" is not registered \(boot\/featureRegistrations\.js/);
});

test('registering again replaces the port; a non-function member is refused', () => {
    ports.registerRunnerPorts({ _probe: { ping: () => 1 } });
    ports.registerRunnerPorts({ _probe: { ping: () => 2 } });
    assert.strictEqual(ports.runnerPort('_probe').ping(), 2);
    assert.throws(() => ports.registerRunnerPorts({ _bad: { ping: 'no' } }), TypeError);
    assert.throws(() => ports.registerRunnerPorts({ _bad: null }), TypeError);
    assert.ok(!ports.hasRunnerPort('_bad'));
    ports._clearRunnerPortsForTests('_probe');
});

// Every port function core calls, by port. A call site added in core needs
// its function here AND in the registering module, or the server throws at
// the call instead of at boot.
const EXPECTED = {
    approvals: ['projectStamp', 'dispatchApprovalRequested', 'dispatchApprovalDecided', 'runOnDecidedHook',
        'notifyApproval', 'automationForApproval', 'pollTalkReactions'],
    triggerBus: ['runPollingPass', 'renewExpiringSubscriptions'],
    formQueue: ['recoverPending', 'stop'],
    evolution: ['evaluateCanaries'],
    periodicJobs: ['runRetentionPass', 'purgeTrashPass', 'datatableRetentionPass', 'digestPass'],
};

test('the feature registrations fill every port the runner calls', () => {
    require('../../automation/runnerPorts');
    require('../../jobs/runnerPorts');
    for (const [name, fns] of Object.entries(EXPECTED)) {
        const port = ports.runnerPort(name);
        for (const fn of fns) assert.strictEqual(typeof port[fn], 'function', `${name}.${fn} is not registered`);
    }
});

test('a port call reaches the feature module lazily, through require.cache', async () => {
    require('../../automation/runnerPorts');
    const resolved = require.resolve('../../automation/evolution');
    const saved = require.cache[resolved];
    let called = 0;
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { evaluateCanaries: async () => { called += 1; } } };
    try {
        await ports.runnerPort('evolution').evaluateCanaries();
    } finally {
        if (saved) require.cache[resolved] = saved; else delete require.cache[resolved];
    }
    assert.strictEqual(called, 1);
});
