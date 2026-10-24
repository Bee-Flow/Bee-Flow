// @typecheck
'use strict';

/**
 * A Reusable Step used as a chat tool is the caller's own, so the caller is the
 * run's starter (runPolicy.connections = 'caller' then has a person to act for
 * instead of refusing an agent_call that names nobody).
 *
 * Run: node --test core/automationRunner/stepAsTool.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const executions = [];
const restore = installResolveStub({
    './execution': { executeAutomation: async (automation, opts) => { executions.push(opts); return { lastOutput: { ok: 1 } }; } },
    '../../stores/automationStore': {
        getAutomation: async () => ({ id: 'b1', kind: 'block', userId: 'u1', publishedVersion: 2, exposeAsTool: true, title: 'T', definition: {} }),
        getVersionDefinition: async () => ({ trigger: { id: 't' }, steps: [] }),
    },
});
const { runStepAsTool } = require('./stepAsTool');
after(() => { restore(); setImmediate(() => process.exit(process.exitCode || 0)); });

test('the owner calling their own Step is recorded as the starter', async () => {
    const out = await runStepAsTool('b1', { a: 1 }, { userId: 'u1', callerAgentId: 'agt' });
    assert.deepStrictEqual(out, { ok: 1 });
    assert.strictEqual(executions[0].startedByUserId, 'u1');
    assert.strictEqual(executions[0].callerAgentId, 'agt');
});

test('an explicit starter in the context wins; someone else\'s Step is still refused', async () => {
    await runStepAsTool('b1', {}, { userId: 'u1', startedByUserId: 'u9' });
    assert.strictEqual(executions[1].startedByUserId, 'u9');
    await assert.rejects(() => runStepAsTool('b1', {}, { userId: 'other' }), /Forbidden/);
});
