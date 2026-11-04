/**
 * What a finalised automation still needs (handoverNeeds.mts): the trigger
 * decides activate / share-form / run-once, and only the apps the draft USES
 * that are not connected for this user become connect:<app id>.
 *
 * Run: cd server && node --test automation/builderTools/handoverNeeds.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handoverNeeds } = require('./handoverNeeds.mts');

const def = (trigger, steps = [], more = {}) => ({ schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', ...trigger }, steps, edges: [], vars: {}, ...more });
const action = (id, tool) => ({ id, type: 'integration_action', tool, inputs: {} });

test('the trigger decides what the person does next', () => {
    assert.deepEqual(handoverNeeds(def({ kind: 'manual' })), ['run-once']);
    assert.deepEqual(handoverNeeds(def({ kind: 'schedule', cron: '0 8 * * *' })), ['activate']);
    assert.deepEqual(handoverNeeds(def({ kind: 'webhook' })), ['activate']);
    assert.deepEqual(handoverNeeds(def({ kind: 'agent_call' })), ['activate']);
    assert.deepEqual(handoverNeeds(def({ kind: 'form', fields: [] })), ['activate', 'share-form']);
    assert.deepEqual(handoverNeeds(def({ kind: 'layer_input', params: [] })), [], 'a building block is called, not started');
    assert.deepEqual(handoverNeeds(null), []);
});

test('an extra trigger adds its own need once', () => {
    const d = def({ kind: 'manual' }, [], { triggers: [{ id: 't2', type: 'trigger', kind: 'schedule', cron: '0 8 * * *' }, { id: 't3', type: 'trigger', kind: 'webhook' }] });
    assert.deepEqual(handoverNeeds(d), ['activate', 'run-once']);
});

test('an app the draft uses that is not connected comes first; a connected one does not show', () => {
    const d = def({ kind: 'schedule', cron: '0 8 * * *' }, [action('s1', 'gmail_search'), action('s2', 'sheets_list')]);
    const available = new Set(['sheets_list', 'sheets_list_tabs']);
    assert.deepEqual(handoverNeeds(d, { availableToolNames: available }), ['connect:gmail', 'activate']);
    assert.deepEqual(handoverNeeds(d, { availableToolNames: new Set(['gmail_search', 'sheets_list']) }), ['activate']);
});

test('only apps the draft uses: nothing about unconnected apps it does not touch', () => {
    const d = def({ kind: 'manual' }, [action('s1', 'sheets_list')]);
    assert.deepEqual(handoverNeeds(d, { availableToolNames: new Set(['sheets_list']) }), ['run-once']);
    assert.deepEqual(handoverNeeds(d, { availableToolNames: new Set() }), ['connect:google-sheets', 'run-once']);
});

test('tools inside a loop, an AI step\'s tool list, a code step and a layer count; each app once', () => {
    const d = def({ kind: 'manual' }, [
        { id: 'l1', type: 'loop', body: [action('b1', 'gmail_read')] },
        { id: 'a1', type: 'ai_step', prompt: 'x', allowTools: true, tools: ['gmail_search'] },
        { id: 'c1', type: 'code', code: 'return 1', allowedTools: ['sheets_list'] },
    ], { layers: { sub: { trigger: { id: 'li', kind: 'layer_input' }, steps: [action('x1', 'gmail_read_attachment')] } } });
    assert.deepEqual(handoverNeeds(d, { availableToolNames: new Set() }), ['connect:gmail', 'connect:google-sheets', 'run-once']);
});

test('an app-event trigger on an unconnected provider asks for that app', () => {
    const d = def({ kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new', filter: null } });
    assert.deepEqual(handoverNeeds(d, { availableToolNames: new Set() }), ['connect:gmail', 'activate']);
    assert.deepEqual(handoverNeeds(d, { availableToolNames: new Set(['gmail_search']) }), ['activate']);
});

test('without the user\'s tool set nothing is claimed about connections', () => {
    const d = def({ kind: 'manual' }, [action('s1', 'gmail_search')]);
    assert.deepEqual(handoverNeeds(d), ['run-once']);
    assert.deepEqual(handoverNeeds(d, { availableToolNames: null }), ['run-once']);
});

test('a tool no registry app owns (an MCP or custom tool) names no app', () => {
    const d = def({ kind: 'manual' }, [action('s1', 'mcp_srv__do_thing')]);
    assert.deepEqual(handoverNeeds(d, { availableToolNames: new Set() }), ['run-once']);
});
