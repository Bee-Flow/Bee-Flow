const test = require('node:test');
const assert = require('node:assert/strict');
const { summariseBuilderRun, isHealthyRun } = require('./builderRunSummary');

const RUN = [
    { at: 0, event: 'builder_session', data: {} },
    { at: 1, event: 'model_selected', data: { modelId: 'gemma', tier: 'fast' } },
    { at: 2, event: 'round_start', data: { iter: 0, modelId: 'gemma', promptChars: 90000, local: true } },
    { at: 500, event: 'prompt_progress', data: { processed: 100, total: 200 } },
    { at: 3000, event: 'thinking_start', data: {} },
    { at: 3200, event: 'tool_draft', data: {} },
    { at: 4000, event: 'tool_call', data: { name: 'app_set_plan', ok: true } },
    { at: 4001, event: 'plan', data: { todos: [{ text: 'a', done: false }, { text: 'b', done: false }] } },
    { at: 4002, event: 'tool_call', data: { name: 'app_link_datatable', ok: true } },
    { at: 4003, event: 'data_model', data: { tables: [{ id: 'tbl_1', key: 'facturen', rowCount: 57, linked: { kind: 'nextcloud', mode: 'read' } }] } },
    { at: 4004, event: 'plan', data: { todos: [{ text: 'a', done: true }, { text: 'b', done: false }] } },
    { at: 4005, event: 'usage', data: { prompt_tokens: 100 } },
    { at: 5000, event: 'round_start', data: { iter: 1, modelId: 'gemma', promptChars: 95000, local: true } },
    { at: 6000, event: 'tool_call', data: { name: 'app_add_components', ok: false, error: 'Unknown parentId', result: '{"error":"Unknown parentId","_repeated":2}' } },
    { at: 6001, event: 'usage', data: { prompt_tokens: 100 } },
    { at: 7000, event: 'round_start', data: { iter: 2, modelId: 'gemma', promptChars: 96000, local: true } },
    { at: 8000, event: 'tool_call', data: { name: 'app_add_components', ok: true } },
    { at: 8001, event: 'tool_call', data: { name: 'app_finalize', ok: true } },
    { at: 8002, event: 'validation_errors', data: { errors: [], warnings: [{ code: 'x' }] } },
    { at: 8003, event: 'usage', data: { prompt_tokens: 100 } },
    { at: 8004, event: 'done', data: { finalized: true } },
];

test('summariseBuilderRun reads the health numbers off a transcript', () => {
    const s = summariseBuilderRun(RUN);
    assert.equal(s.rounds, 3);
    assert.equal(s.finalized, true);
    assert.deepEqual(s.toolCallsPerRound, [2, 1, 2]);
    assert.deepEqual(s.callsByName, { app_set_plan: 1, app_link_datatable: 1, app_add_components: 2, app_finalize: 1 });
    assert.deepEqual(s.failedCalls, [{ name: 'app_add_components', error: 'Unknown parentId', repeated: 2 }]);
    assert.equal(s.repeatedMax, 2);
    assert.equal(s.lengthRounds, 0);
    assert.deepEqual(s.validation, { errors: [], warnings: 1 });
    assert.deepEqual(s.plan, { done: 1, total: 2 });
    assert.deepEqual(s.dataModel, [{ id: 'tbl_1', key: 'facturen', rowCount: 57, linked: 'nextcloud', mode: 'read' }]);
    assert.equal(s.promptCharsMax, 96000);
    assert.equal(s.local, true);
    assert.equal(s.modelId, 'gemma');
    assert.equal(s.ttfbMs, 3000, 'first token = the first event that is not plumbing');
    assert.equal(s.wallClockMs, 8004);
    assert.equal(s.toolDraftEvents, 1);
    assert.equal(isHealthyRun(s), true);
});

test('isHealthyRun refuses the shapes the rehearsal must catch', () => {
    const base = summariseBuilderRun(RUN);
    assert.equal(isHealthyRun({ ...base, finalized: false }), false);
    assert.equal(isHealthyRun({ ...base, repeatedMax: 3 }), false);
    assert.equal(isHealthyRun({ ...base, rounds: 9 }), false);
    assert.equal(isHealthyRun({ ...base, lengthRounds: 1 }), false);
    assert.equal(isHealthyRun({ ...base, errors: [{ code: 'model_truncated' }] }), false);
    assert.equal(isHealthyRun(null), false);
    assert.deepEqual(summariseBuilderRun([]).dataModel, []);
    assert.equal(summariseBuilderRun(null).rounds, 0);
});
