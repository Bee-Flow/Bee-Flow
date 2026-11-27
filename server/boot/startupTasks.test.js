// @typecheck strict
/**
 * Background work is started by boot, by name, and not by requiring the module
 * that owns it. The other side of that rule is that a start() nobody calls is a
 * job that silently never runs, so this file holds the wiring: the two phases
 * that start module-owned work are part of runStartupTasks(), and they call the
 * start of the config invalidation listener and the reminder checker, then the
 * job rows the modules contribute to the phase (the cowork runner and the
 * coverage prune: firstParty/cowork.jobs.js).
 *
 * The modules themselves are covered next to their source
 * (stores/reminderStore.start.test.js, core/cowork/coworkRunner.start.test.js,
 * core/aiTaskRunner.start.test.js, stores/configInvalidation.test.js).
 *
 * Run: node --test boot/startupTasks.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const log = require('../telemetry/log');
const { runStartupTasks, STARTUP_PHASES, studioEngineReplicaWarning } = require('./startupTasks');
const { startConfigInvalidationListener, startModuleSchedulers } = require('./startupJobs');

/**
 * A module double whose start() records its name.
 * @param {string[]} calls
 * @param {string} name
 */
function startable(calls, name) {
    return { start: () => { calls.push(name); } };
}

test('runStartupTasks runs every phase once, in the listed order and without arguments', () => {
    const real = STARTUP_PHASES.slice();
    /** @type {string[]} */
    const ran = [];
    const doubles = real.map((phase) => (/** @type {unknown[]} */ ...args) => {
        assert.equal(args.length, 0, `${phase.name} is called without arguments, so its test seam stays empty`);
        ran.push(phase.name);
    });
    STARTUP_PHASES.splice(0, STARTUP_PHASES.length, ...doubles);
    try {
        runStartupTasks();
    } finally {
        STARTUP_PHASES.splice(0, STARTUP_PHASES.length, ...real);
    }
    assert.deepEqual(ran, real.map((phase) => phase.name));
    assert.equal(new Set(real).size, real.length, 'no phase is listed twice');
});

test('the phases that start module-owned background work are part of boot', () => {
    assert.equal(STARTUP_PHASES[0], startConfigInvalidationListener, 'the config listener starts before the phases that read config');
    assert.ok(STARTUP_PHASES.includes(startModuleSchedulers), 'the module schedulers are a boot phase');
});

/**
 * A loader double whose runStartupPhase records the phase it was asked to run.
 * @param {string[]} calls
 */
function phaseRunner(calls) {
    return { runStartupPhase: (/** @type {string} */ phase) => { calls.push(`rows of ${phase}`); } };
}

test('the scheduler phase starts the reminder checker, then the module rows of its phase (the cowork runner and the coverage prune), once each', () => {
    /** @type {string[]} */
    const calls = [];
    startModuleSchedulers({ reminderStore: startable(calls, 'reminderStore'), loader: phaseRunner(calls) });
    // The cowork tick and the coverage prune are rows of the cowork module (firstParty/cowork.jobs.js, held there).
    assert.deepEqual(calls, ['reminderStore', 'rows of startModuleSchedulers']);
});

test('a scheduler that fails to start is reported by name and does not stop the ones after it', (t) => {
    /** @type {string[]} */
    const calls = [];
    const warn = t.mock.method(log, 'warn', () => {});
    startModuleSchedulers({
        reminderStore: { start: () => { throw new Error('boom'); } },
        loader: phaseRunner(calls),
    });
    assert.deepEqual(calls, ['rows of startModuleSchedulers']);
    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(warn.mock.calls[0].arguments, ['[Server] Reminder checker start failed:', 'boom']);
});

test('the listener phase starts the config invalidation listener and survives a start that throws', (t) => {
    let started = 0;
    /** @type {string[]} */
    const rows = [];
    startConfigInvalidationListener({ configStore: { startInvalidationListener: () => { started += 1; } }, loader: phaseRunner(rows) });
    assert.equal(started, 1);

    const warn = t.mock.method(log, 'warn', () => {});
    assert.doesNotThrow(() => startConfigInvalidationListener({
        configStore: { startInvalidationListener: () => { throw new Error('no pg'); } },
        loader: phaseRunner(rows),
    }));
    assert.deepEqual(rows, ['rows of startConfigInvalidationListener', 'rows of startConfigInvalidationListener']);
    assert.deepEqual(warn.mock.calls[0].arguments, ['[Server] Config invalidation listener start failed:', 'no pg']);
});

// The boot warning for a server in Kubernetes on the single-replica App Studio engine.

test('in a cluster on the default engine: a warning that names the variable, the way out and the one-replica case', () => {
    const line = studioEngineReplicaWarning({ inCluster: true, engine: 'sqlite' });
    assert.ok(line, 'a warning');
    assert.ok(line.includes('STUDIO_APP_ENGINE=pg'), line);
    assert.ok(line.includes('scripts/migrateStudioAppsToPg.js'), line);
    assert.ok(line.includes('With one replica this line does not apply'), 'the server cannot see the replica count, so the line says when to ignore it');
});

test('no warning on the Postgres engine, and none outside a cluster', () => {
    assert.strictEqual(studioEngineReplicaWarning({ inCluster: true, engine: 'pg' }), null);
    assert.strictEqual(studioEngineReplicaWarning({ inCluster: false, engine: 'sqlite' }), null, 'a compose install runs one server container');
    assert.strictEqual(studioEngineReplicaWarning({ inCluster: false, engine: 'pg' }), null);
});
