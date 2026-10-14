/**
 * Feature ports: what the automation runner asks of the features above it.
 *
 * The runner is core and may not require a feature (server/ARCHITECTURE.md),
 * yet a run has to tell approvers, sweep the form queue, and drive retention
 * jobs. Each such capability is a named PORT: a plain object of functions the
 * owning feature fills at boot, the way integrations fill
 * core/tools/toolFamilyRegistry.js.
 *
 *   automation/runnerPorts.js   approvals, triggerBus, formQueue, codeSandbox, ...
 *                               (the trigger bus also serves core/meetingNotes)
 *   jobs/runnerPorts.js         the retention and digest passes
 *   integrations/runnerPorts.js nextcloudAdmin, knowledgeBase, customIntegrations
 *   services/runnerPorts.js     presentations
 *
 * boot/featureRegistrations.js loads them for the server; a test that drives
 * the real code path through a port loads the registering module itself, or
 * registers a fake with registerRunnerPorts.
 *
 * The registering side keeps its requires LAZY (inside each function), so a
 * port costs nothing at boot and a test's require.cache stub of the feature
 * module is still what a call reaches.
 */

'use strict';

/** name -> { fnName: function } */
const ports = new Map();

/**
 * Register (or replace) ports: `{ portName: { fnName: fn, ... } }`. Registering
 * a name again replaces it, so loading a registering module twice is harmless.
 */
function registerRunnerPorts(map) {
    for (const [name, port] of Object.entries(map || {})) {
        if (!port || typeof port !== 'object') throw new TypeError(`registerRunnerPorts(${name}): a port is an object of functions`);
        for (const [fn, impl] of Object.entries(port)) {
            if (typeof impl !== 'function') throw new TypeError(`registerRunnerPorts(${name}.${fn}): not a function`);
        }
        ports.set(name, Object.freeze({ ...port }));
    }
}

/** The port, or a thrown Error naming what was not loaded. */
function runnerPort(name) {
    const port = ports.get(name);
    if (!port) {
        throw new Error(`automation runner port "${name}" is not registered (boot/featureRegistrations.js was not loaded)`);
    }
    return port;
}

function hasRunnerPort(name) {
    return ports.has(name);
}

/** Test seam: drop one port, or all of them. */
function _clearRunnerPortsForTests(name) {
    if (name) ports.delete(name);
    else ports.clear();
}

module.exports = { registerRunnerPorts, runnerPort, hasRunnerPort, _clearRunnerPortsForTests };
