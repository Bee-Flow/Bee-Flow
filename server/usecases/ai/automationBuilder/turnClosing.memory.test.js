/**
 * The builder session's memory across turns (turnClosing.js sessionMemory,
 * F7): the tool names inspected so far and the last test run's per-step shape
 * hints, written into the snapshot at the end of every turn. The next turn
 * seeds `_inspectedTools` from `inspectedTools` (turnSetup.js) and renders
 * `lastDryRunHints` as "## Last test run" (promptAssembly.js).
 *
 * Run: cd server && node --test usecases/ai/automationBuilder/turnClosing.memory.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionMemory } = require('./turnClosing');
const { LAST_TEST_RUN_MAX_BYTES } = require('../../../automation/builderPrompt/lastTestRun.mts');

const DEF = { trigger: { id: 'trg', kind: 'manual' }, steps: [{ id: 'fetch', type: 'integration_action' }, { id: 'ai', type: 'ai_step' }] };

/** An assistant round with one dry run and the compact copy the model got. */
function dryRunRound(id, steps, extra = {}) {
    return [
        { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'builder_request_dry_run', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: id, content: JSON.stringify({ run: { id: `run_${id}`, status: 'success' }, ok: true, steps, ...extra }) },
    ];
}
const wrapOf = (over = {}) => ({ def: structuredClone(DEF), _inspectedTools: new Set(), _availableToolNames: null, ...over });

test('the last dry run of the turn is remembered: hints only, never an error text or an input', () => {
    const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'test it' },
        ...dryRunRound('c1', [{ stepId: 'fetch', status: 'success', _hint: { outputType: 'object', shape: '{ old }' } }]),
        ...dryRunRound('c2', [
            { stepId: 'fetch', stepType: 'integration_action', status: 'success', _hint: { outputType: 'object', topKeys: ['value'], shape: '{ value[*]: { id, subject } }' } },
            { stepId: 'ai', stepType: 'ai_step', status: 'error', error: 'Jan <jan@example.com> refused', input: { text: 'private' }, _hint: { outputType: 'null' } },
        ]),
        { role: 'assistant', content: 'Done.' },
    ];
    const mem = sessionMemory({ messages, fewShotMessages: [], snapshot: null, draftWrap: wrapOf(), proposal: null });
    assert.deepEqual(mem.lastDryRunHints, {
        fetch: { outputType: 'object', shape: '{ value[*]: { id, subject } }', status: 'success', stepType: 'integration_action' },
        ai: { outputType: 'null', status: 'error', stepType: 'ai_step' },
    });
    assert.doesNotMatch(JSON.stringify(mem), /jan@example|private/);
});

test('the few-shot examples\' synthetic dry runs are not this session\'s test run', () => {
    const fewShots = dryRunRound('fs1', [{ stepId: 'fetch', status: 'success', _hint: { outputType: 'object', shape: '{ fake }' } }]);
    const messages = [{ role: 'system', content: 'sys' }, ...fewShots, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello.' }];
    const mem = sessionMemory({ messages, fewShotMessages: fewShots, snapshot: null, draftWrap: wrapOf(), proposal: null });
    assert.deepEqual(mem, {}, 'an empty memory writes no keys (a missing key reads as empty)');
});

test('a refused dry run does not erase the one before it; a turn without one keeps the stored hints', () => {
    const refused = [
        { role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'builder_request_dry_run', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'x', content: JSON.stringify({ error: 'Unknown triggerStepId' }) },
    ];
    const ok = dryRunRound('y', [{ stepId: 'fetch', status: 'success', _hint: { outputType: 'array' } }]);
    const mem = sessionMemory({ messages: [...ok, ...refused], fewShotMessages: [], snapshot: null, draftWrap: wrapOf(), proposal: null });
    assert.deepEqual(Object.keys(mem.lastDryRunHints), ['fetch']);

    const stored = { lastDryRunHints: { ai: { outputType: 'string', status: 'success' } } };
    const kept = sessionMemory({ messages: [{ role: 'assistant', content: 'Sure.' }], fewShotMessages: [], snapshot: stored, draftWrap: wrapOf(), proposal: null });
    assert.deepEqual(kept.lastDryRunHints, stored.lastDryRunHints);
});

test('hints of steps that left the draft are dropped; a step only the waiting proposal has stays', () => {
    const stored = { lastDryRunHints: { gone: { outputType: 'object' }, fetch: { outputType: 'object' }, staged: { outputType: 'array' } } };
    const mem = sessionMemory({ messages: [], snapshot: stored, draftWrap: wrapOf(), proposal: { definition: { steps: [{ id: 'staged' }] } } });
    assert.deepEqual(Object.keys(mem.lastDryRunHints), ['fetch', 'staged']);
});

test('the hint record stays within 4 KB, dropping the oldest steps first', () => {
    const steps = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, type: 'code' }));
    const run = steps.map((s) => ({ stepId: s.id, status: 'success', _hint: { outputType: 'object', shape: `{ ${'k'.repeat(300)} }` } }));
    const mem = sessionMemory({ messages: dryRunRound('z', run), snapshot: null, draftWrap: wrapOf({ def: { steps } }), proposal: null });
    assert.ok(JSON.stringify(mem.lastDryRunHints).length <= LAST_TEST_RUN_MAX_BYTES);
    assert.ok('s39' in mem.lastDryRunHints && !('s0' in mem.lastDryRunHints));
});

test('inspected tools: the stored names then this turn\'s, newest last, deduplicated, narrowed to what the user can still run', () => {
    const snapshot = { inspectedTools: ['gmail_search', 'gone_tool', 'nextcloud_list_files', 42] };
    const draftWrap = wrapOf({
        _inspectedTools: new Set(['gmail_search', 'mcp:srv1:lookup']),
        _availableToolNames: new Set(['gmail_search', 'nextcloud_list_files', 'mcp:srv1:lookup']),
    });
    const mem = sessionMemory({ messages: [], snapshot, draftWrap, proposal: null });
    assert.deepEqual(mem.inspectedTools, ['nextcloud_list_files', 'gmail_search', 'mcp:srv1:lookup']);
    // Could not tell what is runnable: keep them all.
    const open = sessionMemory({ messages: [], snapshot, draftWrap: wrapOf({ _inspectedTools: new Set(['x']) }), proposal: null });
    assert.deepEqual(open.inspectedTools, ['gmail_search', 'gone_tool', 'nextcloud_list_files', 'x']);
});

test('inspected tools are capped at the newest 100', () => {
    const many = Array.from({ length: 150 }, (_, i) => `tool_${i}`);
    const mem = sessionMemory({ messages: [], snapshot: { inspectedTools: many }, draftWrap: wrapOf(), proposal: null });
    assert.equal(mem.inspectedTools.length, 100);
    assert.equal(mem.inspectedTools[0], 'tool_50');
    assert.equal(mem.inspectedTools.at(-1), 'tool_149');
});
