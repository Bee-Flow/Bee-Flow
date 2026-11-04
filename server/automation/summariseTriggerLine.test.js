'use strict';

/**
 * The trigger line of the agent-facing draft state.
 *
 * Run: cd server && node --test automation/summariseTriggerLine.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { triggerStateLine } = require('./summariseTriggerLine');
const { renderAgentDraftState } = require('./summarise');

const FORM = {
    id: 'trg', kind: 'form', form: { fields: [
        { name: 'name', type: 'text' },
        { name: 'email', type: 'email' },
        { name: 'topic', type: 'select', options: ['a', 'b'] },
        { name: 'cv', type: 'file' },
        { name: 'btn', type: 'download' },
        { name: 'note' },
    ] },
};

test('a form trigger names each answer with its form field type, leaves display fields out, and counts one page', () => {
    assert.equal(triggerStateLine(FORM, { steps: [] }),
        '  - `trg` trigger:form  inputs: name (text), email (email), topic (select), cv (file), note (text)  · 1 page  (bind as trigger.output.<name>)');
});

test('every form_page step of the graph is one more page', () => {
    const graph = { steps: [
        { id: 'p2', type: 'form_page', mode: 'input' },
        { id: 'a', type: 'ai_step' },
        { id: 'end', type: 'form_page', mode: 'ending' },
    ] };
    assert.match(triggerStateLine(FORM, graph), /· 3 pages {2}\(bind/);
});

test('a form without fields still says how many pages it has', () => {
    assert.equal(triggerStateLine({ id: 't1', kind: 'form', form: { fields: [] } }, {}), '  - `t1` trigger:form  · 1 page');
});

test('the other kinds keep their line', () => {
    assert.equal(triggerStateLine({ kind: 'manual' }, {}), '  - `trg` trigger:manual');
    assert.equal(triggerStateLine({ id: 'f', kind: 'layer_input', params: ['a', { name: 'b' }] }, {}),
        '  - `f` trigger:layer_input  inputs: a, b  (bind inside as trigger.output.<name>)');
    assert.equal(triggerStateLine({ id: 'x', kind: 'app_trigger', params: [{ name: 'q', type: 'string' }] }, {}),
        '  - `x` trigger:app_trigger  inputs: q  (bind as trigger.output.<name>)');
});

test('renderAgentDraftState counts the form pages of the main flow', () => {
    const s = renderAgentDraftState({ trigger: FORM, steps: [{ id: 'p2', type: 'form_page', mode: 'input' }], edges: [] });
    assert.match(s, /trigger:form {2}inputs: name \(text\), email \(email\)[^\n]* · 2 pages/);
});
