/**
 * How a plan run that the runner called a success really ended (./runOutcome.mts): an unresolved list reference makes
 * it incomplete whatever an AI step said; a list that resolved and was empty is a success; an AI step's "failed" makes
 * it failed; "done" and "nothing to do" make it nothing better than it is.
 *
 * Run: cd server && node --test core/cowork/runOutcome.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { outcomeOfRun, unresolvedOf, factsOf, listRefsOf, unresolvedSentence, incompleteText } = require('./runOutcome.mts');
const { fakeLookups } = require('./plan/plan.testkit');

const lookups = fakeLookups();
const plan = (overRef = 'steps.list.output.transcripts') => ({
    schemaVersion: 1,
    trigger: { id: 'trg', type: 'trigger', kind: 'schedule' },
    steps: [
        { id: 'list', type: 'integration_action', label: 'List meetings', tool: 'fireflies_list_transcripts', inputs: {} },
        { id: 'sums', type: 'integration_action', label: 'Get summaries', tool: 'fireflies_get_summary', forEach: { overRef, itemVar: 't' }, inputs: {} },
        { id: 'ai', type: 'ai_step', label: 'Write the overview', prompt: 'Summarise {{steps.sums.output.results}}.' },
    ],
    edges: [],
});
const recorded = (entries) => new Map(Object.entries(entries));
const listed = (results) => ({ status: 'success', output: { results, count: results.length, message: 'Found.' } });

test('a list step skipped over a path the earlier step does not have: incomplete, with the facts', () => {
    const steps = recorded({ list: listed([{ id: 't1' }]), sums: { status: 'skipped', output: { iterations: 0, results: [] } }, ai: { status: 'success', output: 'No meetings found.' } });
    const outcome = outcomeOfRun(plan(), steps, lookups);
    assert.strictEqual(outcome.kind, 'incomplete');
    assert.deepStrictEqual(factsOf(outcome), { kind: 'incomplete', unresolved: [{ stepId: 'sums', field: 'forEach.overRef', ref: 'steps.list.output.transcripts', sourceStepId: 'list', found: 'nothing' }] });
    assert.strictEqual(incompleteText(outcome.unresolved), "Did not do its work: step 'Get summaries' found nothing to work on.");
    assert.strictEqual(unresolvedSentence(outcome.unresolved[0]), "Step 'Get summaries' reads `transcripts` from 'List meetings', which returns no such field.");
});

test('"done" from an AI step does not clear an incomplete run: the runner\'s own finding wins', () => {
    const steps = recorded({
        list: listed([{ id: 't1' }]), sums: { status: 'skipped', output: {} },
        ai: { status: 'success', output: 'No meetings found.', verdict: { outcome: 'nothing_to_do', reason: 'There were no meetings.' } },
    });
    assert.strictEqual(outcomeOfRun(plan(), steps, lookups).kind, 'incomplete');
    const done = recorded({ ...Object.fromEntries(steps), ai: { status: 'success', output: 'x', verdict: { outcome: 'done', reason: null } } });
    assert.strictEqual(outcomeOfRun(plan(), done, lookups).kind, 'incomplete');
});

test('a list that resolved and was empty is a success, and "nothing to do" is trusted then', () => {
    const steps = recorded({
        list: listed([]), sums: { status: 'success', output: { iterations: 0, results: [] } },
        ai: { status: 'success', output: 'No meetings this week.', verdict: { outcome: 'nothing_to_do', reason: 'No meetings in the period.' } },
    });
    const outcome = outcomeOfRun(plan('steps.list.output.results'), steps, lookups);
    assert.deepStrictEqual(outcome, { kind: 'success', verdict: 'nothing_to_do' });
    assert.deepStrictEqual(factsOf(outcome), { kind: 'nothing_to_do' });
});

test('an AI step that says it failed makes the run failed, with its reason; its facts keep no reason', () => {
    const steps = recorded({
        list: listed([{ id: 't1' }]), sums: { status: 'success', output: { iterations: 1, results: [] } },
        ai: { status: 'success', output: 'x', verdict: { outcome: 'failed', reason: 'No meeting data reached me.' } },
    });
    const outcome = outcomeOfRun(plan('steps.list.output.results'), steps, lookups);
    assert.deepStrictEqual(outcome, { kind: 'ai_failed', stepId: 'ai', stepTitle: 'Write the overview', reason: 'No meeting data reached me.' });
    assert.deepStrictEqual(factsOf(outcome), { kind: 'ai_failed', stepId: 'ai' });
});

test('a value that is no list is named by its kind, never shown; a step that did not run, or a source that failed, is not judged', () => {
    const notList = recorded({ list: { status: 'success', output: { results: { a: 1 } } }, sums: { status: 'skipped', output: {} } });
    assert.strictEqual(unresolvedOf(plan('steps.list.output.results'), notList, lookups)[0].found, 'object');
    const sourceFailed = recorded({ list: { status: 'error', output: null }, sums: { status: 'skipped', output: {} } });
    assert.deepStrictEqual(unresolvedOf(plan(), sourceFailed, lookups), []);
    assert.deepStrictEqual(listRefsOf(plan()).map((r) => [r.stepId, r.field, r.sourceStepId]), [['sums', 'forEach.overRef', 'list']]);
});
