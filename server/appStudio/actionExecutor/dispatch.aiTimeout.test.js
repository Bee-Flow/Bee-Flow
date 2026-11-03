/**
 * The dispatcher keeps the AI time-out message (and gives it its own code) instead of
 * collapsing it to "Step failed".
 *
 * Run: node --test appStudio/actionExecutor/dispatch.aiTimeout.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { aiTimeoutError } = require('../aiCallGuard.mts');

// Replace the step functions on the module object BEFORE dispatch destructures them.
Object.assign(require('./aiSteps'), {
    aiExtractStep: async () => { throw aiTimeoutError(120_000); },
    aiGenerateStep: async () => { throw aiTimeoutError(120_000); },
});

const { executeDataStep } = require('./dispatch');

test('an AI time-out is a step error with its message and code', async () => {
    const res = await executeDataStep({ id: 'a', userId: 'u' }, null, { kind: 'ai_generate' }, {});
    assert.deepStrictEqual(res, { ok: false, error: 'The AI gave no answer within 120 s', code: 'ai_timeout' });
});
