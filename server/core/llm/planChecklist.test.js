/**
 * The agent's to-do list, shared by the routine and App Studio builders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./planChecklist');

test('normalizePlanTodos caps, coerces and keeps done flags', () => {
    const out = P.normalizePlanTodos(['a', { text: 'b', done: true }, { nope: 1 }, null, 7]);
    assert.deepEqual(out, [{ text: 'a', done: false }, { text: 'b', done: true }]);
    assert.equal(P.normalizePlanTodos(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, P.MAX_TODOS);
    assert.equal(P.normalizePlanTodos(['x'.repeat(500)])[0].text.length, P.MAX_TODO_CHARS);
    assert.deepEqual(P.normalizePlanTodos('not a list'), []);
});

test('applyPlanMarkDone ticks by index without mutating the input', () => {
    const todos = [{ text: 'a', done: false }, { text: 'b', done: false }];
    const out = P.applyPlanMarkDone(todos, [1, 5, -1, 'x']);
    assert.deepEqual(out, [{ text: 'a', done: false }, { text: 'b', done: true }]);
    assert.equal(todos[1].done, false);
    assert.deepEqual(P.applyPlanMarkDone(todos, null), todos);
});

test('planEcho carries indices and the next open item', () => {
    assert.deepEqual(P.planEcho([{ text: 'a', done: true }, { text: 'b' }]), {
        ok: true,
        todos: [{ i: 0, text: 'a', done: true }, { i: 1, text: 'b', done: false }],
        next: 'b',
    });
    assert.deepEqual(P.planEcho([]), { ok: true, todos: [], next: null });
});

test('the tokenizer needs two shared significant tokens and stems a trailing s', () => {
    const { tokens, matchesItem } = P.makeTokenizer();
    assert.deepEqual([...tokens('Add the Facturen tables and totals')], ['facturen', 'table', 'total']);
    assert.equal(matchesItem('Read each file', tokens('list files in folder')), false, 'one shared word is not a match');
    assert.equal(matchesItem('Link the Facturen table', tokens('linked table facturen')), true);
    assert.equal(matchesItem('', tokens('anything')), false);
    const custom = P.makeTokenizer(new Set(['facturen']));
    assert.deepEqual([...custom.tokens('the Facturen table')], ['the', 'table'], 'caller stop words replace the default list');
});

test('mergePlanTodos: an identical list keeps the previous ticks and reports unchanged; a changed list carries done over by text', () => {
    const prev = [{ text: 'Create Suppliers table', done: true }, { text: 'Create Invoices table', done: false }, { text: 'Build the dashboard', done: false }];
    const { mergePlanTodos } = P;
    const same = mergePlanTodos(prev, [{ text: 'Create Suppliers table' }, { text: 'Create Invoices table' }, { text: 'Build the dashboard' }]);
    assert.equal(same.unchanged, true);
    assert.deepEqual(same.todos, prev, 'the previous list, ticks included');
    const cased = mergePlanTodos(prev, ['create suppliers table ', 'Create Invoices table', 'Build the dashboard']);
    assert.equal(cased.unchanged, true, 'case and whitespace do not make a new plan');
    const changed = mergePlanTodos(prev, [{ text: 'Create Invoices table' }, { text: 'Create Suppliers table' }, { text: 'Build the dashboard' }, { text: 'Finalize', done: true }]);
    assert.equal(changed.unchanged, false);
    assert.deepEqual(changed.todos, [
        { text: 'Create Invoices table', done: false },
        { text: 'Create Suppliers table', done: true },
        { text: 'Build the dashboard', done: false },
        { text: 'Finalize', done: true },
    ]);
    assert.deepEqual(mergePlanTodos([], [{ text: 'a' }]), { todos: [{ text: 'a', done: false }], unchanged: false });
    assert.deepEqual(mergePlanTodos(null, null), { todos: [], unchanged: true });
});
