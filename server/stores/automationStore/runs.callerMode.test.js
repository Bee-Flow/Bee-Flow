'use strict';

/**
 * The run row remembers the mode it started in and the step row which identity
 * an integration step ran as.
 *
 * Run: node --test stores/automationStore/runs.callerMode.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { recordRunStepWith } = require('./runs');
const { rowToRun, rowToRunStep } = require('./rowMappers');
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

test('rowToRun exposes connections_mode as connectionsMode (null by default)', () => {
    assert.strictEqual(rowToRun({ id: 'r', connections_mode: 'caller' }).connectionsMode, 'caller');
    assert.strictEqual(rowToRun({ id: 'r' }).connectionsMode, null);
});

test('recordRunStep stores the identity an integration step ran as, and keeps it across upserts', async () => {
    const seen = [];
    const run = async (sql, params) => { seen.push({ sql, params }); };
    await recordRunStepWith(run, { runId: 'r', stepId: 's', stepType: 'integration_action', status: 'success', identityUserId: 'u-caller' });
    assert.match(seen[0].sql, /identity_user_id/);
    assert.match(seen[0].sql, /identity_user_id = COALESCE\(EXCLUDED\.identity_user_id/);
    assert.strictEqual(seen[0].params[17], 'u-caller');
    await recordRunStepWith(run, { runId: 'r', stepId: 's2', stepType: 'set', status: 'success' });
    assert.strictEqual(seen[1].params[17], null);
    assert.strictEqual(rowToRunStep({ run_id: 'r', step_id: 's', identity_user_id: 'u-caller' }).identityUserId, 'u-caller');
});
