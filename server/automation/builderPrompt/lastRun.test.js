/**
 * The "## Last run" block (lastRun.mts): the automation's latest run as the
 * builder's model reads it. Statuses, codes and masked error texts; never an
 * input or output value.
 *
 * Run: cd server && node --test automation/builderPrompt/lastRun.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    summariseRunSteps, renderLastRun, runIsNewer, LAST_RUN_MAX_STEPS, LAST_RUN_MAX_MESSAGE,
} = require('./lastRun.mts');

const RUN = { id: 'r1', mode: 'live', isTest: true, status: 'error', startedAt: '2026-11-04T11:55:00.000Z', finishedAt: '2026-11-04T11:55:09.000Z' };
// The owner's screen: a form, an AI step whose answer check reads a variable nothing sets, steps after it never ran.
const ROWS = [
    { stepId: 'form', stepType: 'form_trigger', status: 'success', input: { naam: 'Jan de Vries' }, output: { email: 'jan@example.com' } },
    { stepId: 'beoordeel', stepType: 'ai_step', status: 'error', input: { text: 'Mijn laptop is kapot' }, output: null, error: "This AI step's answer did not pass its checks after one repair round: prioriteit: the list of allowed values is empty", errorInfo: { code: 'ai_checks_failed', title: 'x' } },
    { stepId: 'goedkeuring', stepType: 'approval', status: 'awaiting_approval' },
    { stepId: 'later', stepType: 'datatable', status: 'skipped' },
];

test('one line per step: ran, failed with its code and message, waiting, skipped', () => {
    const { steps, errors } = summariseRunSteps(ROWS);
    assert.deepEqual(steps.map((s) => [s.stepId, s.state]), [['form', 'ran'], ['beoordeel', 'failed'], ['goedkeuring', 'waiting'], ['later', 'skipped']]);
    assert.equal(steps[1].code, 'ai_checks_failed');
    assert.deepEqual(Object.keys(errors), ['beoordeel']);
    const text = renderLastRun(RUN, steps, { beoordeel: errors.beoordeel });
    assert.match(text, /^## Last run\n/);
    assert.match(text, /a test run started 2026-11-04T11:55:00\.000Z, it failed\./);
    assert.match(text, /- `form` \(form_trigger\) ran/);
    assert.match(text, /- `beoordeel` \(ai_step\) failed with code `ai_checks_failed`: This AI step's answer did not pass its checks after one repair round: prioriteit: the list of allowed values is empty/);
    assert.match(text, /- `goedkeuring` \(approval\) is waiting/);
    assert.match(text, /- `later` \(datatable\) was skipped/);
});

test('no input or output value reaches the block, and the message is only the one handed in', () => {
    const { steps } = summariseRunSteps(ROWS);
    const text = renderLastRun(RUN, steps, {});
    assert.doesNotMatch(text, /Jan de Vries|jan@example\.com|laptop/);
    assert.doesNotMatch(text, /prioriteit/, 'without a masked message the raw error text is not shown');
    assert.match(text, /failed with code `ai_checks_failed`\n/);
});

test('a failed step brings the doctrine: read the run first, never ask for a description', () => {
    const { steps } = summariseRunSteps(ROWS);
    assert.match(renderLastRun(RUN, steps), /FIRST read this run with builder_inspect_run on the failed step, then name the step that failed and why in one sentence\. Never ask them to describe an error this run already holds\./);
    assert.match(renderLastRun(RUN, steps, {}, { canInspect: false }), /FIRST name the step that failed and why in one sentence, from this block/);
    const clean = summariseRunSteps([{ stepId: 'a', status: 'success' }]).steps;
    assert.doesNotMatch(renderLastRun({ ...RUN, status: 'success' }, clean), /FIRST|builder_inspect_run/);
    assert.match(renderLastRun({ ...RUN, status: 'success' }, clean), /it finished\./);
});

test('the message is cut to 200 characters, before and after the mask', () => {
    const long = 'x'.repeat(500);
    const { steps, errors } = summariseRunSteps([{ stepId: 's', status: 'error', error: long }]);
    assert.equal(errors.s.length, LAST_RUN_MAX_MESSAGE);
    const line = renderLastRun(RUN, steps, { s: long }).split('\n').find((l) => l.startsWith('- `s`'));
    assert.ok(line.length < LAST_RUN_MAX_MESSAGE + 40);
});

test('a code is an identifier, from errorInfo first, else the error class', () => {
    const { steps } = summariseRunSteps([
        { stepId: 'a', status: 'error', errorClass: 'timeout' },
        { stepId: 'b', status: 'error', errorInfo: { code: 'bad code <script>' } },
        { stepId: 'c', status: 'handled_error', errorInfo: { code: 'rate_limited' } },
    ]);
    assert.deepEqual(steps.map((s) => s.code), ['timeout', 'badcodescript', 'rate_limited']);
    assert.match(renderLastRun(RUN, steps), /- `c` failed with code `rate_limited` \(its error path took over\)/);
});

test('a step recorded more than once keeps its failure, else its last row', () => {
    const { steps } = summariseRunSteps([
        { stepId: 'body', status: 'success' },
        { stepId: 'body', status: 'error', error: 'second item failed' },
        { stepId: 'body', status: 'success' },
        { stepId: 'retry', status: 'error' },
        { stepId: 'retry', status: 'success' },
    ]);
    assert.deepEqual(steps.map((s) => [s.stepId, s.state]), [['body', 'failed'], ['retry', 'failed']]);
});

test('a long run keeps every failed step and says how many it left out', () => {
    const rows = Array.from({ length: LAST_RUN_MAX_STEPS + 10 }, (_, i) => ({ stepId: `s${i}`, status: 'success' }));
    rows.push({ stepId: 'broken', status: 'error' });
    const { steps } = summariseRunSteps(rows);
    const text = renderLastRun(RUN, steps);
    assert.match(text, /- `broken` failed/);
    assert.match(text, /… and 11 more steps that did not fail/);
    assert.equal(text.split('\n').filter((l) => l.startsWith('- `')).length, LAST_RUN_MAX_STEPS);
});

test('the run kind in words: dry run, test run, live run', () => {
    const steps = summariseRunSteps([{ stepId: 'a', status: 'success' }]).steps;
    assert.match(renderLastRun({ ...RUN, mode: 'dry_run', isTest: false }, steps), /a dry run \(nothing was sent\)/);
    assert.match(renderLastRun({ ...RUN, mode: 'live', isTest: false }, steps), /a live run/);
    assert.match(renderLastRun({ ...RUN, status: 'awaiting_approval' }, steps), /it is still awaiting approval\./);
});

test('nothing to say, nothing rendered', () => {
    assert.equal(renderLastRun(RUN, []), '');
    assert.equal(renderLastRun(null, summariseRunSteps(ROWS).steps), '');
    assert.deepEqual(summariseRunSteps(null), { steps: [], errors: {} });
    assert.deepEqual(summariseRunSteps([null, 'x', { status: 'error' }]).steps, []);
});

test('newer than the session: by the run end, else its start; a session that never wrote knows nothing', () => {
    assert.equal(runIsNewer(RUN, '2026-11-04T11:55:05.000Z'), true, 'finished after the session wrote');
    assert.equal(runIsNewer(RUN, '2026-11-04T12:00:00.000Z'), false);
    assert.equal(runIsNewer({ startedAt: '2026-11-04T12:01:00.000Z' }, '2026-11-04T12:00:00.000Z'), true, 'still running');
    assert.equal(runIsNewer(RUN, undefined), true);
    assert.equal(runIsNewer({ id: 'r' }, undefined), false, 'a run without a time is not trusted');
    assert.equal(runIsNewer(null, undefined), false);
});
