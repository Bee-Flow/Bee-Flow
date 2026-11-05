/**
 * The ledger row of a parse_json step in AI mode: the owner pays (`user_id`),
 * the person who started the run is `actor_user_id`, the run is `run_id`, and
 * the automation stays the Studio object (`agent_id`). The model, the guard
 * and the ledger sink go in through execParseJson's deps.
 *
 * Run: node --test core/automationRunner/execData.usage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { areaOf } = require('../../shared/usageAreas');
const { execParseJson } = require('./execData');

const usageRows = [];
const deps = {
    modelResolver: { async resolveModelForTierName() { return 'model-fast'; } },
    llmClient: {
        async chatForcedTool() { return { structured: { naam: 'Acme' }, usage: { promptTokens: 20, completionTokens: 4 } }; },
    },
    safety: {
        async resolveAutomationPolicy() { return { action: 'off' }; },
        buildAuditBase() { return {}; },
        async guardAiInput() { return { blocked: false }; },
        async guardAiOutput(content) { return { content }; },
        restoreForRunState: (v) => v,
        buildPiiSummary() { return null; },
    },
    usageStore: { async logUsage(row) { usageRows.push(row); } },
};

const step = {
    id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.s1.output.doc',
    fields: [{ name: 'naam', path: 'naam', type: 'string' }],
};
const state = () => ({
    trigger: { output: {} }, vars: {}, secrets: {}, loop: {},
    steps: { s1: { output: { doc: { tekst: 'Invoice from Acme' } }, status: 'success' } },
});

test('parse_json (ai): the usage row names the run and its starter', async () => {
    usageRows.length = 0;
    const ctx = { userId: 'owner-1', orgId: 'org-1', automationId: 'auto-1', automationTitle: 'Inbox', runId: 'run-3', actorUserId: 'starter-4' };
    const out = await execParseJson(step, ctx, state(), 'live', deps);
    assert.deepStrictEqual(out.output, { naam: 'Acme' });
    assert.strictEqual(usageRows.length, 1);
    const row = usageRows[0];
    assert.strictEqual(row.user_id, 'owner-1');
    assert.strictEqual(row.organization_id, 'org-1');
    assert.strictEqual(row.actor_user_id, 'starter-4');
    assert.strictEqual(row.run_id, 'run-3');
    assert.strictEqual(row.agent_id, 'auto-1');
    assert.strictEqual(row.model, 'model-fast');
    assert.notStrictEqual(areaOf(row.source), 'other');
});
