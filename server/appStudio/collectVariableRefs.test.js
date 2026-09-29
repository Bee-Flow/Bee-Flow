'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { collectVariableWrites } = require('./collectVariableRefs');

/**
 * The write set decides whether a `vars.<name>` read is a typo, so a write this
 * misses turns into a false accusation on a working app. Every nesting shape
 * the runtime walks gets its own case.
 */

const sorted = (set) => [...set].sort();

function appWith(actions, children = []) {
    return {
        screens: [{ sections: [{ children }] }],
        actions,
    };
}

test('set_variable is found at every nesting depth', () => {
    const def = appWith({
        act_a: {
            kind: 'sequence',
            steps: [
                { kind: 'set_variable', name: 'top' },
                { kind: 'condition', then: [{ kind: 'set_variable', name: 'inThen' }], else: [{ kind: 'set_variable', name: 'inElse' }] },
                { kind: 'loop', steps: [{ kind: 'set_variable', name: 'inLoop' }] },
                { kind: 'switch', cases: [{ steps: [{ kind: 'set_variable', name: 'inCase' }] }], default: [{ kind: 'set_variable', name: 'inDefault' }] },
                { kind: 'create_record', onError: [{ kind: 'set_variable', name: 'inOnError' }] },
            ],
        },
    });
    assert.deepStrictEqual(sorted(collectVariableWrites(def).names), [
        'inCase', 'inDefault', 'inElse', 'inLoop', 'inOnError', 'inThen', 'top',
    ]);
});

test('resultVar is found on a step and on a bare v1 action', () => {
    const def = appWith({
        act_seq: { kind: 'sequence', steps: [{ kind: 'run_automation', resultVar: 'fromStep' }] },
        act_bare: { kind: 'ai_generate', resultVar: 'fromBare' },
    });
    assert.deepStrictEqual(sorted(collectVariableWrites(def).names), ['fromBare', 'fromStep']);
});

test('a loop’s item and index bindings are found, and marked loop-scoped', () => {
    const def = appWith({
        act_a: { kind: 'sequence', steps: [{ kind: 'loop', itemVar: 'row', indexVar: 'i', steps: [] }] },
    });
    const { names, loopScoped } = collectVariableWrites(def);
    assert.deepStrictEqual(sorted(names), ['i', 'row']);
    assert.deepStrictEqual(sorted(loopScoped), ['i', 'row']);
});

test('a filter bar claims the reserved `filters` name', () => {
    const def = appWith({}, [{ id: 'c1', type: 'filter_bar', props: { fields: [{ name: 'q' }] } }]);
    assert.ok(collectVariableWrites(def).names.has('filters'));
});

test('a filter bar with no fields claims nothing', () => {
    const def = appWith({}, [{ id: 'c1', type: 'filter_bar', props: { fields: [] } }]);
    assert.equal(collectVariableWrites(def).names.has('filters'), false);
});

test('a nested filter bar is still found', () => {
    const def = appWith({}, [{
        id: 'c1', type: 'card', children: [{ id: 'c2', type: 'filter_bar', props: { fields: [{ name: 'q' }] } }],
    }]);
    assert.ok(collectVariableWrites(def).names.has('filters'));
});

// The latent bug: any string up to 60 chars is accepted as a name, but the
// runtime stores it as a FLAT key — so `vars.my var` is a parse error and the
// value never arrives anywhere.
test('a name no formula can read lands in `invalid`, not in `names`', () => {
    const def = appWith({
        act_a: { kind: 'sequence', steps: [{ kind: 'set_variable', name: 'my var' }, { kind: 'set_variable', name: '2fast' }] },
    });
    const { names, invalid } = collectVariableWrites(def);
    assert.equal(names.size, 0);
    assert.deepStrictEqual(invalid.map((i) => i.name).sort(), ['2fast', 'my var']);
    assert.equal(invalid[0].kind, 'set_variable');
    assert.match(invalid[0].path, /^actions\.act_a/);
});

test('garbage in produces an empty result rather than a throw', () => {
    for (const def of [null, undefined, {}, { actions: 'nope', screens: 5 }, { actions: { a: null } }]) {
        const r = collectVariableWrites(def);
        assert.equal(r.names.size, 0);
        assert.equal(r.invalid.length, 0);
    }
});

test('a malformed step list does not derail the walk', () => {
    const def = appWith({
        act_a: { kind: 'sequence', steps: [null, { kind: 'switch', cases: 'nope' }, { kind: 'set_variable', name: 'ok' }] },
    });
    assert.deepStrictEqual(sorted(collectVariableWrites(def).names), ['ok']);
});
