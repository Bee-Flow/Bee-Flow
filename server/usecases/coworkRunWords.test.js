// @typecheck
/**
 * The tools of a run in a person's words (./coworkRunWords.mts): a label and an effect beside each tool, Cowork's own
 * tools marked internal, and a lookup that fails costs the words, never the history.
 *
 * Run: cd server && node --test usecases/coworkRunWords.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { withToolWords, withPlainWords } = require('./coworkRunWords.mts');

/** @type {{ effectOfTool: (t: string) => 'reads' | 'writes' | 'sends', labelOfTool: (t: string) => string | null }} */
const lookups = {
    effectOfTool: (tool) => (tool === 'outlook_send' ? 'sends' : tool === 'outlook_create_draft' ? 'writes' : 'reads'),
    labelOfTool: (tool) => (tool === 'outlook_send' ? 'Outlook: send' : null),
};

const tool = (/** @type {string} */ name) => ({ name, app: 'outlook', ok: 1, failed: 0, refused: 0, reasons: [] });

test('each tool of a run carries what a person calls it and what it does', () => {
    const [run] = withToolWords([{ id: 'r1', activity: { tools: [tool('outlook_send'), tool('outlook_create_draft')], skills: [], toolCalls: 2 } }], lookups);
    assert.deepStrictEqual(run.activity.tools.map((t) => [t.name, t.label, t.effect, t.internal]), [
        ['outlook_send', 'Outlook: send', 'sends', false],
        ['outlook_create_draft', null, 'writes', false],
    ]);
    assert.strictEqual(run.activity.toolCalls, 2, 'the rest of the activity stays');
});

test('Cowork\'s own tools are marked internal: they are no step of the work', () => {
    const [run] = withToolWords([{ id: 'r1', activity: { tools: [tool('cowork_request_review'), tool('cowork_report_outcome')] } }], lookups);
    assert.deepStrictEqual(run.activity.tools.map((t) => [t.internal, t.label]), [[true, null], [true, null]]);
});

test('a run without activity is left as it is', () => {
    const runs = [{ id: 'r1', activity: null }, { id: 'r2' }];
    assert.deepStrictEqual(withToolWords(runs, lookups), runs);
});

test('a lookup that fails reads the tool as one that changes something, and the history still answers', () => {
    const broken = { effectOfTool: () => { throw new Error('registry down'); }, labelOfTool: () => null };
    const [run] = withToolWords([{ id: 'r1', activity: { tools: [tool('mystery')] } }], broken);
    assert.deepStrictEqual([run.activity.tools[0].effect, run.activity.tools[0].label], ['writes', null]);
});

// ── `plain`: how a run ended, in its owner's words ───────────────────────────────────────────────────────────────────

/** The plan the failed runs below followed: titles a person reads, and the tool of each app step. */
const DEFINITION = {
    trigger: { id: 'trg', type: 'trigger', kind: 'schedule' },
    steps: [
        { id: 'list', type: 'action', tool: 'fireflies_list_transcripts', label: 'List last week\'s meetings' },
        { id: 'each', type: 'action', tool: 'fireflies_get_summary', label: 'Get each meeting summary' },
        { id: 'dt_ac3ed7', type: 'datetime', label: 'A week ago' },
        { id: 'write', type: 'ai', label: 'Write the summary' },
    ],
    edges: [{ from: 'trg', to: 'list' }, { from: 'list', to: 'each' }, { from: 'each', to: 'dt_ac3ed7' }, { from: 'dt_ac3ed7', to: 'write' }],
};
const planLookups = /** @type {any} */ ({
    appOfTool: (name) => (name.startsWith('fireflies_') ? 'fireflies' : null),
    effectOfTool: () => 'reads',
    isOpenWebRead: () => false,
    labelOfTool: (name) => (name === 'fireflies_list_transcripts' ? 'Fireflies: list transcripts' : name.startsWith('fireflies_') ? 'Fireflies' : null),
});
const plainDeps = (asked = []) => ({ planOfRun: async (scheduleId, runId) => { asked.push([scheduleId, runId]); return { plan: { definition: DEFINITION } }; }, lookups: planLookups });
const failedAt = (stepId, sourceStepId = null, errorClass = 'IntegrationError') => ({ failure: { stepId, errorClass, sourceStepId }, outcome: { kind: 'step_failed', stepId, sourceStepId } });

/** The plain sentence of one run of the plan. @param {Record<string, unknown>} run */
const plainOf = async (run) => (await withPlainWords('cw-1', [{ id: 'r1', planId: 'plan-1', status: 'error', ...run }], plainDeps()))[0].plain;

/** Nothing of the engine reaches the sentence. @param {string | null} text */
function assertPlain(text) {
    assert.ok(text, 'there is a sentence');
    for (const raw of ['{{', '_', 'automation', 'dt_ac3ed7', 'IntegrationError']) assert.ok(!String(text).toLowerCase().includes(raw.toLowerCase()), `"${raw}" in: ${text}`);
}

test('an app that is not allowed any more: the step and the app by their names, never the tool', async () => {
    const error = 'You no longer have permission to use "fireflies_list_transcripts". Ask your organisation admin to re-enable this integration, or remove the step from the automation.';
    const text = await plainOf({ error, ...failedAt('list') });
    assert.strictEqual(text, "'List last week's meetings' could not run: Fireflies is no longer allowed for this task.");
    assertPlain(text);
    // Without the plan (an older run, a plan that cannot be read) the app still comes from the refusal itself.
    const [bare] = await withPlainWords('cw-1', [{ id: 'r2', status: 'error', error }], plainDeps());
    assert.strictEqual(bare.plain, 'Fireflies is no longer allowed for this task.');
});

test('a step that could not read from another step names both, never the reference', async () => {
    const error = 'datetime: input "{{steps.dt_ac3ed7.output.iso}}" did not resolve to a parseable date';
    const text = await plainOf({ error, ...failedAt('write', 'each', 'datetime_unresolved_input') });
    assert.strictEqual(text, "'Write the summary' could not read what it needs from 'Get each meeting summary'.");
    assertPlain(text);
    assert.strictEqual(await plainOf({ error, ...failedAt('write', null, 'datetime_unresolved_input') }), "'Write the summary' could not read what it needs.");
});

test('a sign-in that ran out says which app, and what to do', async () => {
    const text = await plainOf({ error: 'Token refresh failed: invalid_grant', ...failedAt('each') });
    assert.strictEqual(text, "The sign-in of Fireflies ran out, so 'Get each meeting summary' could not run. Sign in again, then run it again.");
    const [paused] = await withPlainWords('cw-1', [{ id: 'r3', status: 'needs_reauth', error: null }], plainDeps());
    assert.strictEqual(paused.plain, 'The sign-in of an app ran out. Sign in again, then run it again.');
});

test('the AI\'s own verdict: failed with its reason, and nothing to do', async () => {
    assert.strictEqual(
        await plainOf({ error: 'The AI says: there were no meetings with a transcript last week.', outcome: { kind: 'ai_failed', stepId: 'write', sourceStepId: null } }),
        'The AI says: there were no meetings with a transcript last week.',
    );
    assert.strictEqual(await plainOf({ error: 'The AI says: {{steps.list.output}} was empty', outcome: { kind: 'ai_failed', stepId: 'write', sourceStepId: null } }), 'The AI says it could not do what the task asks.', 'a reason that is no sentence is left out');
    const [quiet] = await withPlainWords('cw-1', [{ id: 'r4', status: 'success', outcome: { kind: 'nothing_to_do', stepId: null, sourceStepId: null } }], plainDeps());
    assert.strictEqual(quiet.plain, 'The AI checked and found nothing to do this time.');
});

test('a list that never arrived, a run that took too long, a step that just failed, and anything else', async () => {
    assert.strictEqual(
        await plainOf({ status: 'incomplete', error: null, outcome: { kind: 'incomplete', stepId: 'each', sourceStepId: 'list' } }),
        "'Get each meeting summary' got nothing to work on from 'List last week's meetings', so the run did not do its work.",
    );
    assert.strictEqual(await plainOf({ error: 'This run took too long and was stopped after 20 minutes.' }), 'The run took too long and was stopped.');
    assert.strictEqual(await plainOf({ error: 'ECONNRESET', ...failedAt('each') }), "'Get each meeting summary' did not work.");
    assert.strictEqual(await plainOf({ error: 'connect ECONNREFUSED 10.0.0.7:5432 (password=hunter2)' }), 'The run did not finish.', 'never the reason itself');
    assert.strictEqual(await plainOf({ error: 'This task waits for its owner: its steps are not approved yet.' }), 'It did not run: the task waits for you to approve its steps.');
    // A step nobody named is not called by its id.
    assert.strictEqual(await plainOf({ error: 'boom', ...failedAt('no_such_step') }), 'A step did not work.');
});

test('a run that went well has nothing to say, the raw error stays where it is, and one plan is read once', async () => {
    const asked = [];
    const runs = /** @type {any[]} */ ([
        { id: 'r1', status: 'success', result: 'Overview written.', planId: 'plan-1' },
        { id: 'r2', status: 'error', error: 'ECONNRESET', planId: 'plan-1', ...failedAt('each') },
        { id: 'r3', status: 'error', error: 'ECONNRESET', planId: 'plan-1', ...failedAt('list') },
    ]);
    const out = await withPlainWords('cw-1', runs, plainDeps(asked));
    assert.deepStrictEqual(out.map((r) => r.plain), [null, "'Get each meeting summary' did not work.", "'List last week's meetings' did not work."]);
    assert.strictEqual(out[1].error, 'ECONNRESET');
    assert.deepStrictEqual(asked, [['cw-1', 'r2']], 'the plan of the two failed runs is read once, and not for the run that went well');
});

test('a plan that cannot be read costs the step\'s name, never the history', async () => {
    const deps = { planOfRun: async () => { throw new Error('store down'); }, lookups: planLookups };
    const [run] = await withPlainWords('cw-1', [{ id: 'r1', planId: 'plan-1', status: 'error', error: 'ECONNRESET', ...failedAt('each') }], deps);
    assert.strictEqual(run.plain, 'A step did not work.');
});
