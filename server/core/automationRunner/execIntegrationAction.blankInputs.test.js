/**
 * A live tool step that would write a hole fails before anything is sent.
 *
 * A Talk step bound `{{steps.ev.output.event.summary}}` while the real output
 * is flat: the run posted "event created:  at" and stayed green. The check
 * fails the step only for a field of a step that ran (and for a formula that
 * cannot be read); everything else stays a warning. `safety` is a stub that
 * throws a sentinel, so "the check let it through" is asserted by reaching it.
 *
 * Run: node --test core/automationRunner/execIntegrationAction.blankInputs.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execIntegrationAction } = require('./execIntegrationAction');
const { withBindingLog } = require('../automationModel/bind');

const REACHED = new Error('safety reached');
const deps = () => ({
    safety: { resolveAutomationPolicy: async () => { throw REACHED; } },
    stepInputsSynthetic: () => false,
});
const state = () => ({
    steps: { ev: { output: { summary: 'Standup', dtstart: '09:00' } } },
    trigger: { output: {} },
    _templateWarnings: [],
});
const talk = (inputs, tool = 'nextcloud_talk_send_message') => ({ id: 'say', type: 'integration_action', tool, inputs });
const tpl = (value) => ({ message: { kind: 'template', value } });
const run = (step, mode = 'live', d = deps()) => execIntegrationAction(step, {}, state(), mode, d);

test('live: a template reading a missing field of a step that ran fails the step', async () => {
    const step = talk(tpl('event created: {{steps.ev.output.event.summary}} at {{steps.ev.output.dtstart}}'));
    await assert.rejects(() => run(step), (e) => {
        assert.equal(e.errorClass, 'binding_unresolved');
        assert.match(e.message, /was not run/);
        assert.match(e.message, /message/);
        assert.match(e.message, /steps\.ev\.output\.event\.summary/);
        assert.match(e.message, /Nothing was sent/);
        assert.match(e.message, /\|\|/);
        return true;
    });
});

test('live: a formula that does not parse fails the step', async () => {
    const step = talk({ message: { kind: 'expr', value: '({ a: 1 })' } });
    await assert.rejects(() => run(step), (e) => e.errorClass === 'binding_unresolved');
});

test('live: a template that resolves reaches the safety stack', async () => {
    const step = talk(tpl('{{steps.ev.output.summary}} at {{steps.ev.output.dtstart}}'));
    await assert.rejects(() => run(step), (e) => e === REACHED);
});

test('live: a step that did not run (dead-branch join) stays a warning', async () => {
    await assert.rejects(() => run(talk(tpl('{{steps.other.output.summary}}'))), (e) => e === REACHED);
});

test('live: an optional trigger key stays a warning', async () => {
    await assert.rejects(() => run(talk(tpl('hi {{trigger.output.nickname}}'))), (e) => e === REACHED);
});

test('live: a bare ref that finds nothing is only a warning', async () => {
    const step = talk({ message: { kind: 'literal', value: 'hi' }, cc: { kind: 'ref', path: 'steps.ev.output.cc' } });
    await assert.rejects(() => run(step), (e) => e === REACHED);
});

test('live: a read-only tool is not stopped', async () => {
    const step = talk({ q: { kind: 'template', value: '{{steps.ev.output.event.summary}}' } }, 'nextcloud_search');
    await assert.rejects(() => run(step), (e) => e === REACHED);
});

test('dry run: the same template is not failed, and the miss reaches the step log', async () => {
    const step = talk(tpl('{{steps.ev.output.event.summary}}'));
    const log = [];
    await withBindingLog(log, async () => {
        await assert.rejects(() => run(step, 'dry_run'), (e) => e === REACHED);
    });
    assert.ok(log.some(m => m.kind === 'template'));
});
