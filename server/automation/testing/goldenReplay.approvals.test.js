'use strict';
/**
 * A golden replay plays the approver's decision and answers, not only the form
 * answers (tests-and-docs F12). A golden whose later steps bind
 * steps.<approval>.output.answers.budget used to replay with answers {} and
 * come out "Different" though nothing had changed.
 *
 *   approvalAnswersFromJourney   the decided approval rows of a journey, answers
 *                                allow-listed like formAnswers (declared
 *                                questions only, no file or app pick, never who,
 *                                when or why)
 *   replayGoldens                hands them to the dry run as harness.approvals
 *
 * Synthetic rows only, every collaborator faked.
 * Run: cd server && node --test automation/testing/goldenReplay.approvals.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { approvalAnswersFromJourney } = require('./approvalAnswers.mts');
const { replayGoldens } = require('./goldenReplay');

const definition = {
    trigger: { id: 'trig', kind: 'manual' },
    steps: [
        {
            id: 'ap', type: 'approval', prompt: 'Budget?',
            approval: {
                fields: [
                    { name: 'budget', label: 'Budget', type: 'number' },
                    { name: 'quote', label: 'Quote', type: 'file' },
                    { name: 'intro', type: 'markdown', content: 'Read this' },
                ],
            },
        },
        { id: 'ap2', type: 'approval', prompt: 'Second?' },
        { id: 'ap3', type: 'approval', prompt: 'Third?' },
        { id: 'ap4', type: 'approval', prompt: 'Simulated?' },
        { id: 'use', type: 'set', fields: {} },
    ],
    edges: [],
};

const decided = (stepId, output, extra = {}) => ({ runId: 'leg-2', stepId, parentStepId: null, status: 'success', output, ...extra });
const ROWS = [
    { runId: 'leg-1', stepId: 'ap', parentStepId: null, status: 'awaiting_approval', output: { prompt: 'Budget?' } },
    decided('ap', {
        approved: true, by: 'person-7', reason: 'looks fine', decidedAt: '2026-10-01T10:00:00.000Z', votes: [],
        answers: { budget: 1200, quote: { kind: 'form_upload', fileId: 'f-1' }, undeclared: 'x', _meta: 1 },
    }),
    decided('ap2', { approved: false, by: 'person-8', reason: 'no', decidedAt: '2026-10-01T10:00:00.000Z', answers: {}, votes: [] }),
    { runId: 'leg-1', stepId: 'ap3', parentStepId: null, status: 'rejected', output: { prompt: 'Third?' } },
    decided('ap4', { approved: true, by: 'dry_run', answers: {}, votes: [], _dryRun: true, _dryRunSynthesised: true }),
    // A row inside a layer is never a top-level approval.
    decided('ap', { approved: false, answers: {} }, { parentStepId: 'layer-1' }),
];

test('decided rows become decisions; answers keep only the declared, keepable questions', () => {
    const out = approvalAnswersFromJourney({ definition, steps: ROWS });
    assert.deepStrictEqual(out, {
        ap: { decision: 'approve', answers: { budget: 1200 } },
        ap2: { decision: 'reject', answers: {} },
        ap3: { decision: 'reject', answers: {} },
    });
});

test('who decided, when and why never leave the journey; a synthesised approval is no decision', () => {
    const json = JSON.stringify(approvalAnswersFromJourney({ definition, steps: ROWS }));
    for (const v of ['person-7', 'person-8', 'looks fine', '2026-10-01', 'f-1']) assert.ok(!json.includes(v), `kept ${v}`);
    assert.ok(!('ap4' in approvalAnswersFromJourney({ definition, steps: ROWS })));
});

test('nothing to read gives nothing', () => {
    assert.deepStrictEqual(approvalAnswersFromJourney({ definition: null, steps: null }), {});
    assert.deepStrictEqual(approvalAnswersFromJourney({ definition, steps: [] }), {});
});

test('replayGoldens hands the journey decisions to the dry run as harness.approvals', async () => {
    const exec = [];
    const goldenRun = { id: 'g-run', automationId: 'a1', version: 2, rootStepId: null, triggerPayload: null, status: 'success' };
    const results = await replayGoldens({ automation: { id: 'a1', definition }, goldens: [{ id: 'gold_1', runId: 'g-run' }], userId: 'u1' }, {
        store: /** @type {any} */ ({
            getRun: async () => goldenRun,
            getRunsInChain: async () => [goldenRun],
            getRunStepsForChain: async () => ROWS,
            getVersionDefinition: async () => definition,
        }),
        testingStore: { setGoldenReplay: async () => {} },
        answersFromJourney: () => ({ v: 1, trigger: null, pages: {}, skipped: [] }),
        runEntry: { entryDefinitionOf: async () => definition, resolveTriggerStepId: () => ({ trigger: definition.trigger, rootStepId: null }) },
        executeAutomation: /** @type {any} */ (async (_a, opts) => { exec.push(opts); return { id: 'replay-1', status: 'success' }; }),
        compareRuns: /** @type {any} */ (async () => ({ verdict: 'same', summary: {}, steps: [], truncated: false })),
        log: { warn: () => {} },
    });
    assert.deepStrictEqual(results, [{ goldenId: 'gold_1', status: 'same' }]);
    assert.deepStrictEqual(exec[0].harness.approvals, {
        ap: { decision: 'approve', answers: { budget: 1200 } },
        ap2: { decision: 'reject', answers: {} },
        ap3: { decision: 'reject', answers: {} },
    });
});
