const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');
const h = createBuilderStream();
after(() => h.restore());

const definition = { schemaVersion: 2, trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'set', label: 'Original', settings: { assignments: [{ var: 'x', value: '1' }] } }], edges: [{ from: 'trg', to: 's1' }] };
const draft = () => ({ id: 'a1', userId: 'u1', title: 'My flow', description: '', definition: structuredClone(definition) });
const names = run => run.roundOptions(0).tools.map(t => t.function.name);

test('discuss refuses hallucinated mutation and dry-run calls before dispatch or persistence', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'discuss' },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' }), call('builder_request_dry_run')] }, { text: 'Advice only.' }] });
    assert.equal(run.toolCalls.length, 0);
    assert.equal(run.persists.length, 0);
    assert.equal(run.has('draft'), false);
    assert.equal(run.has('finalized'), false);
    assert.deepEqual(run.storedSessions.at(-1).payload.draft, definition);
    assert.ok(names(run).every(n => !['builder_update_step', 'builder_finalize', 'builder_request_dry_run'].includes(n)));
});

test('approval mode produces an isolated preview and saves the original definition in the session', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'Proposed' })] }, { text: 'Review this change.' }],
        tools: { builder_update_step: (_args, wrap) => { wrap.def.steps[0].label = 'Proposed'; return { ok: true }; } } });
    assert.equal(run.persists.length, 0);
    assert.equal(run.has('draft'), false);
    const proposal = run.last('proposal_preview');
    assert.ok(proposal.id);
    assert.equal(proposal.definition.steps[0].label, 'Proposed');
    assert.deepEqual(proposal.baseDefinition, definition);
    assert.deepEqual(run.storedSessions.at(-1).payload.draft, definition);
    assert.deepEqual(run.storedSessions.at(-1).payload.proposal, proposal);
});

test('preview cannot create tables, delegate a flowlet, finalize or execute a dry-run', async () => {
    const blocked = ['builder_create_datatable', 'builder_generate_layer', 'builder_generate_layers', 'builder_finalize', 'builder_request_dry_run', 'webpage_db_exec'];
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: blocked.map(n => call(n)) }, { text: 'Awaiting approval.' }] });
    assert.equal(run.toolCalls.length, 0);
    assert.equal(run.persists.length, 0);
    assert.ok(names(run).every(n => !blocked.includes(n)));
});

test('a plan is saved as a review document; no build happens before approval', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan' },
        rounds: [{ toolCalls: [call('builder_write_plan', { title: 'New flow', goal: 'Process files', steps: ['Read files', 'Send a summary'], tests: ['Check an empty folder'] }), call('builder_update_step', { stepId: 's1' })] }, { text: 'Approve the plan.' }] });
    assert.equal(run.toolCalls.length, 0);
    assert.equal(run.persists.length, 0);
    assert.equal(run.first('review_plan').plan.status, 'review');
    assert.equal(run.first('review_plan').plan.version, 1);
    assert.equal(run.storedSessions.at(-1).payload.reviewPlan.title, 'New flow');
    assert.equal(run.roundOptions(0).toolChoice, 'auto');
});

test('an outdated plan approval is refused without any model calls', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'old' },
        builderSession: { reviewPlan: { id: 'new', status: 'review' } } });
    assert.equal(run.rounds.length, 0);
    assert.match(run.first('error').error, /latest plan/);
});

test('a plan for a changed definition must be reviewed again', async () => {
    const oldDefinition = { ...definition, steps: [] };
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1' },
        builderSession: { reviewPlan: { id: 'p1', status: 'review', baseDefinition: oldDefinition } } });
    assert.equal(run.rounds.length, 0);
    assert.ok(run.has('error'));
});

test('bundled questions stop further tool execution until the user answers', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'approve' },
        rounds: [{ toolCalls: [call('builder_ask_questions', { questions: [{ prompt: 'Which inbox?', options: ['Finance', 'Sales'] }] }), call('builder_update_step', { stepId: 's1' })] }, { text: 'This round must not run.' }] });
    assert.equal(run.rounds.length, 1);
    assert.equal(run.toolCalls.length, 0);
    assert.equal(run.first('review_questions').questions[0].prompt, 'Which inbox?');
    assert.deepEqual(run.storedSessions.at(-1).payload.draft, definition);
});

test('an approved exact plan revision enables building and passes its scope to the model', async () => {
    const plan = { id: 'p1', status: 'review', title: 'Keep scope', steps: ['Rename the step'] };
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1' }, builderSession: { reviewPlan: plan },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' })] }, { text: 'Done.' }],
        tools: { builder_update_step: (_args, wrap) => { wrap.def.steps[0].label = 'Approved'; return { ok: true }; }, builder_finalize: () => ({ error: 'Not finalized in this test.' }) } });
    assert.ok(run.toolCalls.some(c => c.name === 'builder_update_step'));
    assert.equal(run.first('draft').definition.steps[0].label, 'Approved');
    assert.ok(run.roundMessages(0).some(m => m.content?.includes('Follow this approved plan')));
});

test('large direct builds become a plan without persisting any staged changes', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_add_steps', { steps: [] })] }, { text: 'Review these changes.' }],
        tools: { builder_add_steps: (_args, wrap) => { wrap.def.steps.push(...Array.from({ length: 4 }, (_, i) => ({ id: `new${i}`, type: 'set', label: `Step ${i}` }))); return { ok: true }; } } });
    assert.equal(run.persists.length, 0);
    assert.equal(run.has('draft'), false);
    assert.equal(run.last('review_plan').plan.steps.length, 4);
    assert.deepEqual(run.storedSessions.at(-1).payload.draft, definition);
});

test('small direct builds are committed once after the size check', async () => {
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'build', alwaysPlanLarge: true },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1', label: 'New' })] }, { text: 'Ready.' }],
        tools: { builder_update_step: (_args, wrap) => { wrap.def.steps[0].label = 'New'; return { ok: true }; } } });
    assert.equal(run.persists.length, 1);
    assert.equal(run.last('draft').definition.steps[0].label, 'New');
    assert.equal(run.has('proposal_preview'), false);
    assert.equal(run.storedSessions.at(-1).payload.draft.steps[0].label, 'New');
});

test('an approved plan pauses after one mutation and skips later calls', async () => {
    const plan = { id: 'p1', status: 'review', title: 'Rename', steps: ['Rename the step', 'Add another step'] };
    const run = await h.run({ draft: draft(), body: { automationId: 'a1', workMode: 'plan', approvedPlanId: 'p1', pauseAfterStep: true }, builderSession: { reviewPlan: plan },
        rounds: [{ toolCalls: [call('builder_update_step', { stepId: 's1' }), call('builder_add_steps', { steps: [{ id: 'next' }] })] }],
        tools: { builder_update_step: (_args, wrap) => { wrap.def.steps[0].label = 'Renamed'; return { ok: true }; } } });
    assert.equal(run.toolCalls.length, 1);
    assert.equal(run.rounds.length, 1);
    assert.equal(run.last('review_plan').plan.status, 'paused');
    assert.equal(run.last('review_plan').plan.baseDefinition.steps[0].label, 'Renamed');
    assert.equal(run.has('finalized'), false);
});
