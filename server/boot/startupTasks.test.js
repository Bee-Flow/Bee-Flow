// @typecheck strict
/**
 * boot/startupTasks.js studioEngineReplicaWarning: the boot warning for a
 * server in Kubernetes on the single-replica App Studio engine.
 *
 * Run: cd server && node --test boot/startupTasks.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { studioEngineReplicaWarning } = require('./startupTasks');

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
