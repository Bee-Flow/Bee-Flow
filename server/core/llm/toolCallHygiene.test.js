const test = require('node:test');
const assert = require('node:assert/strict');
const { noteRepeatedRejection } = require('./toolCallHygiene');

test('the second identical rejection is named, the third says stop; a different call or a successful mutation resets', () => {
    const state = {};
    const mutating = new Set(['add']);
    const r1 = noteRepeatedRejection('add', { a: 1 }, { error: 'bad' }, state, { mutating });
    assert.equal(r1._repeated, undefined);
    const r2 = noteRepeatedRejection('add', { a: 1 }, { error: 'bad', _fixHint: 'own hint' }, state, { mutating });
    assert.equal(r2._repeated, 2);
    assert.match(r2._fixHint, /^own hint This is the SAME call as your previous attempt \(2 times now\)/);
    assert.match(r2._fixHint, /Change exactly what the error names/);
    const r3 = noteRepeatedRejection('add', { a: 1 }, { error: 'bad' }, state, { mutating });
    assert.equal(r3._repeated, 3);
    assert.match(r3._fixHint, /Stop retrying: tell the user/);
    noteRepeatedRejection('add', { a: 2 }, { error: 'bad' }, state, { mutating });
    assert.equal(noteRepeatedRejection('add', { a: 1 }, { error: 'bad' }, state, { mutating })._repeated, undefined, 'a different call restarts the streak');
    noteRepeatedRejection('add', { a: 1 }, { error: 'bad' }, state, { mutating });
    noteRepeatedRejection('add', { ok: true }, { added: 1 }, state, { mutating });
    assert.equal(state._lastRejected, null, 'a successful mutation clears it');
    assert.equal(noteRepeatedRejection('add', { a: 1 }, { error: 'bad' }, state, { mutating })._repeated, undefined);
});

test('a successful NON-mutating call leaves the streak alone; no state → no-op; unserialisable args → no-op', () => {
    const state = {};
    const mutating = (n) => n === 'add';
    noteRepeatedRejection('add', { a: 1 }, { error: 'bad' }, state, { mutating });
    noteRepeatedRejection('inspect', {}, { ok: true }, state, { mutating });
    assert.equal(noteRepeatedRejection('add', { a: 1 }, { error: 'bad' }, state, { mutating })._repeated, 2);
    assert.deepEqual(noteRepeatedRejection('add', {}, { error: 'x' }, null), { error: 'x' });
    const cyc = {}; cyc.self = cyc;
    assert.deepEqual(noteRepeatedRejection('add', cyc, { error: 'x' }, {}, { mutating }), { error: 'x' });
});
