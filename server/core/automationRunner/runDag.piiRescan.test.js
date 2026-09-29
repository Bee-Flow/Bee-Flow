/**
 * The builder-only PII rescan of step outputs — BFSF-359.
 *
 * Builder-initiated runs (dry-run, ▶ Execute, retry-from) scan each step's
 * output so the canvas can colour its lines by PII. That scan was applied to
 * EVERY step type, including the pure transformation nodes whose output is by
 * construction a subset of data the upstream step already had scanned — and on
 * an 8k-row window it cost single-digit seconds per node, which is most of why
 * ▶ Execute on a Limit felt broken.
 *
 * The exemption is deliberately narrow: anything that can INTRODUCE content
 * (ai_step, code, http_request, integration_action, parse_json, …) is still
 * scanned, and a summary the dispatcher already produced still rides through.
 *
 * Run: node --test core/automationRunner/runDag.piiRescan.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

const recorded = [];
mock('../../stores/automationStore', {
    getAutomation: async () => null,
    recordRunStep: async (rec) => { recorded.push(rec); },
});
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', { createNotification: async () => ({}) });
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

const scanned = [];
mock('./safety', {
    scanOutputForPiiSummary: async () => { scanned.push(true); return { categories: { Email: 1 } }; },
});

const { runDag } = require('./engine');

function state() {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [] };
}

const dispatch = async (step) => ({
    output: { rows: [{ email: 'a@b.c' }] },
    startedAt: new Date().toISOString(),
    inputSnapshot: null,
    ...(step.piiSummaryFromTool ? { piiSummary: { categories: { Person: 2 } } } : {}),
});

/** trigger → s1, where s1 is the step type under test. */
function defWith(step) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [step],
        edges: [{ from: 'trg', to: step.id }],
    };
}

async function run(step, ctxExtra = {}) {
    recorded.length = 0;
    scanned.length = 0;
    await runDag(defWith(step), { runId: 'r1', builderRun: true, ...ctxExtra }, state(), 'live', dispatch, { recordSteps: true });
    // LAST, not first: the runner records a 'running' placeholder when a step
    // starts and the real row when it lands (the store upserts them onto one
    // row; this stub keeps both). The result is the one under test.
    return [...recorded].reverse().find(r => r.stepId === step.id);
}

for (const type of ['limit', 'filter', 'dedupe', 'aggregate', 'set']) {
    test(`a ${type} step is not rescanned — its output is a subset of already-scanned data`, async () => {
        const row = await run({ id: 's1', type });
        assert.deepStrictEqual(scanned, [], `${type} must not pay for a rescan`);
        assert.strictEqual(row.piiSummary, null);
    });
}

test('a step that can introduce new content is still scanned', async () => {
    const row = await run({ id: 's1', type: 'ai_step' });
    assert.strictEqual(scanned.length, 1, 'an ai_step output is new content, not a re-shaped subset');
    assert.deepStrictEqual(row.piiSummary, { categories: { Email: 1 } });
});

test('a summary the dispatcher already produced rides through even for an exempt type', async () => {
    const row = await run({ id: 's1', type: 'limit', piiSummaryFromTool: true });
    assert.deepStrictEqual(scanned, [], 'still no rescan');
    assert.deepStrictEqual(row.piiSummary, { categories: { Person: 2 } }, 'the guard-derived summary is kept');
});

test('production runs never scan at all, exempt or not', async () => {
    const row = await run({ id: 's1', type: 'ai_step' }, { builderRun: false });
    assert.deepStrictEqual(scanned, []);
    assert.strictEqual(row.piiSummary, null);
});
