// @typecheck
/**
 * RM-5 (d): a dry-run WRITE asks the permission question a live run asks.
 *
 * The permission gate used to run after the dry-run synthesis returned, so a
 * write to an integration the org admin had switched off showed a green,
 * synthesised step and failed on the next live run. Now the rehearsal checks
 * first (./execCode.js header): a refusal about the environment is an amber
 * 'would_fail_live' row that still hands its sample on; a step that names a
 * built-in step type is the automation's own fault and fails, as live.
 *
 * Run: node --test core/automationRunner/execIntegrationAction.dryRunPermission.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
/** Results are read loosely here: each case asserts the fields it is about. */
const anyOf = (/** @type {any} */ v) => v;
const { registerRunnerPorts } = require('./featurePorts');
const { execIntegrationAction } = require('./execIntegrationAction');

registerRunnerPorts({
    outputSchemas: {
        synthesizeDryRunOutput: (tool) => ({ id: 'sample-1', tool }),
        emptyDryRunOutput: () => ({}),
    },
    stepTypes: { isBuiltinStepType: (name) => name === 'notification' },
});

const deps = () => ({
    safety: {
        resolveAutomationPolicy: async () => ({}),
        buildAuditBase: () => ({}),
        guardToolInput: async (value) => ({ value, wouldBlock: false, categories: [] }),
    },
    stepInputsSynthetic: () => false,
    integrationTools: () => ({ getIntegrationTools: async () => ({ tools: [] }), isIntegrationPermittedForUser: async () => false }),
});
const state = () => ({ steps: {}, trigger: { output: {} }, _templateWarnings: [] });
const send = (tool = 'gmail_send_email') => ({ id: 'send', type: 'integration_action', tool, inputs: { to: { kind: 'literal', value: 'a@example.test' } } });

test('a permitted write is synthesised as before (no skip)', async () => {
    const ctx = { userId: 'u1', allowedToolNames: new Set(['gmail_send_email']) };
    const out = anyOf(await execIntegrationAction(send(), ctx, state(), 'dry_run', deps()));
    assert.equal(out.dryRunSynthesised, true);
    assert.equal(out.skippedReason, undefined);
    assert.equal(out.output.id, 'sample-1');
});

test('a write the owner may no longer use is an amber would_fail_live row, never success', async () => {
    const ctx = { userId: 'u1', allowedToolNames: new Set(['gmail_search']) };
    const out = anyOf(await execIntegrationAction(send(), ctx, state(), 'dry_run', deps()));
    assert.equal(out.skippedReason, 'would_fail_live');
    assert.equal(out.dryRunFallback, 'not_permitted');
    assert.equal(out.dryRunSynthesised, true, 'the sample still flows on, tainted');
    assert.match(out.output.skipped, /a live run would fail here/);
    assert.match(out.output.skipped, /no longer have permission/);
});

test('live refuses the same write', async () => {
    const ctx = { userId: 'u1', allowedToolNames: new Set(['gmail_search']) };
    const d = { ...deps(), safety: { ...deps().safety, prepareForEgress: (v) => v } };
    await assert.rejects(() => execIntegrationAction(send(), ctx, state(), 'live', d), /no longer have permission/);
});

test('a step that names a built-in step type fails in a dry run, as live', async () => {
    const ctx = { userId: 'u1', allowedToolNames: new Set(['gmail_search']) };
    await assert.rejects(() => execIntegrationAction(send('notification'), ctx, state(), 'dry_run', deps()), /built-in step type/);
});
