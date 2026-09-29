/**
 * Unit tests for same-batch side-effect tool-call dedup.
 *
 * Run: node --test core/agentRuntime/toolCallDedupe.test.js
 */

const test = require('node:test');
const assert = require('assert');
const { dedupeSideEffectToolCalls } = require('./toolCallDedupe');

const call = (name, args, id) => ({
    id: id || `call_${Math.random().toString(36).slice(2)}`,
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

test('drops an identical side-effect pair, keeps one', () => {
    const calls = [
        call('youtrack_create_issue', { projectId: '0-1', summary: 'Bug' }),
        call('youtrack_create_issue', { projectId: '0-1', summary: 'Bug' }),
    ];
    const { kept, dropped } = dedupeSideEffectToolCalls(calls);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(dropped, 1);
    assert.strictEqual(kept[0], calls[0], 'first occurrence wins');
});

test('keeps side-effect calls with differing args', () => {
    const calls = [
        call('youtrack_create_issue', { projectId: '0-1', summary: 'Bug A' }),
        call('youtrack_create_issue', { projectId: '0-1', summary: 'Bug B' }),
    ];
    const { kept, dropped } = dedupeSideEffectToolCalls(calls);
    assert.strictEqual(kept.length, 2);
    assert.strictEqual(dropped, 0);
});

test('keeps identical read-only duplicates', () => {
    const calls = [
        call('youtrack_search_issues', { query: 'project: X' }),
        call('youtrack_search_issues', { query: 'project: X' }),
    ];
    const { kept, dropped } = dedupeSideEffectToolCalls(calls);
    assert.strictEqual(kept.length, 2, 'read-only tools are never deduped');
    assert.strictEqual(dropped, 0);
});

test('key is stable across argument key order', () => {
    const calls = [
        call('youtrack_create_issue', '{"projectId":"0-1","summary":"Bug"}'),
        call('youtrack_create_issue', '{"summary":"Bug","projectId":"0-1"}'),
    ];
    const { kept, dropped } = dedupeSideEffectToolCalls(calls);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(dropped, 1);
});

test('malformed JSON args fall back to raw-string key', () => {
    const calls = [
        call('youtrack_create_issue', '{"broken'),
        call('youtrack_create_issue', '{"broken'),
        call('youtrack_create_issue', '{"other broken'),
    ];
    const { kept, dropped } = dedupeSideEffectToolCalls(calls);
    assert.strictEqual(kept.length, 2, 'identical raw strings deduped, differing kept');
    assert.strictEqual(dropped, 1);
});

test('unknown tools are treated as side-effecting (fail-closed)', () => {
    const calls = [
        call('mcp_some_server_do_thing', { a: 1 }),
        call('mcp_some_server_do_thing', { a: 1 }),
    ];
    const { kept, dropped } = dedupeSideEffectToolCalls(calls);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(dropped, 1);
});

test('classifier is injectable', () => {
    const calls = [
        call('anything', { a: 1 }),
        call('anything', { a: 1 }),
    ];
    const { kept } = dedupeSideEffectToolCalls(calls, { isSideEffect: () => false });
    assert.strictEqual(kept.length, 2, 'read-only per injected classifier');
});

test('empty and missing input is safe', () => {
    assert.deepStrictEqual(dedupeSideEffectToolCalls([]).kept, []);
    assert.deepStrictEqual(dedupeSideEffectToolCalls(null).kept, []);
});
