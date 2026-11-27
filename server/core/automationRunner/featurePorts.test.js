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
const { optionalLookupContract } = require('../../testUtils/optionalLookup.testkit');

optionalLookupContract({
    kind: 'runnerPorts',
    name: '_probeOptional',
    register: (port) => ports.registerRunnerPorts({ _probeOptional: /** @type {any} */ (port) }),
    required: (name) => ports.runnerPort(name),
    optional: (name) => ports.optionalRunnerPort(name),
    clear: (name) => ports._clearRunnerPortsForTests(name),
});

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

// The ports the automation runner calls, filled by the feature registrations, are the automation
// module's contract: featurePorts.automation.test.js.

test('runnerPortNames lists every registered port name', () => {
    ports.registerRunnerPorts({ _probeNames: { f: () => null } });
    assert.ok(ports.runnerPortNames().includes('_probeNames'));
    ports._clearRunnerPortsForTests('_probeNames');
    assert.ok(!ports.runnerPortNames().includes('_probeNames'));
});
