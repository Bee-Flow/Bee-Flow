import { test } from 'node:test';
import assert from 'node:assert/strict';

import { picksIn, pickPaths, stepReadPaths, stepIdsRead, textAsTemplate } from './reads.mjs';

const pick = (from, extra = {}) => ({ kind: 'pick', v: 1, from, take: 'one', as: 'native', ...extra });
const part = (from, extra = {}) => ({ from, take: 'one', as: 'text', ...extra });

test('picksIn finds picks and compose parts at any depth, in order', () => {
    const a = pick({ root: 'steps', id: 's1', path: ['items', 'sku'] }, { take: 'all' });
    const b = part({ root: 'trigger', path: ['Klant', 'E-mail adres'] });
    const value = {
        to: a,
        body: { kind: 'compose', v: 1, parts: ['Beste ', b, '!'] },
        rows: [{ cell: pick({ root: 'loop', id: 'r', path: ['output', 'name'] }) }],
    };
    const found = picksIn(value);
    assert.equal(found.length, 3);
    assert.equal(found[0], a);
    assert.equal(found[1], b);
    assert.deepEqual(found[2].from, { root: 'loop', id: 'r', path: ['output', 'name'] });
});

test('picksIn does not look inside a legacy binding, and an invalid pick is a literal object', () => {
    const hidden = pick({ root: 'steps', id: 's1', path: ['x'] });
    assert.deepEqual(picksIn({ kind: 'literal', value: { inner: hidden } }), []);
    // No version: not a pick, so it is looked into like any other object.
    const notPick = { kind: 'pick', from: { root: 'steps', id: 's1', path: ['x'] }, take: 'one', as: 'native', nested: hidden };
    assert.deepEqual(picksIn(notPick), [hidden]);
});

test('pickPaths spells every Source the way a legacy path does', () => {
    const value = [
        pick({ root: 'steps', id: 's1', path: ['items', 0, 'Order date'] }),
        pick({ root: 'trigger', path: ['subject'] }),
        pick({ root: 'run', path: ['firedAt'] }),
        pick({ root: 'loop', id: 'r', path: ['output', 'total'] }),
        pick({ root: 'vars', path: ['rate'] }),
        pick({ root: 'item', path: ['amount'] }),
    ];
    assert.deepEqual(pickPaths(value), [
        'steps.s1.output.items[0]["Order date"]',
        'trigger.output.subject',
        'trigger.firedAt',
        'loop.r.output.total',
        'vars.rate',
        'item.amount',
    ]);
});

test('stepReadPaths adds the list a step repeats over and a loop\'s over', () => {
    const step = {
        id: 'a', type: 'integration_action',
        repeat: { over: { root: 'steps', id: 'list', path: ['files'] }, max: 100 },
        inputs: { path: pick({ root: 'steps', id: 'list', path: ['files', 'path'] }, { take: 'each' }) },
    };
    assert.deepEqual(stepReadPaths(step), ['steps.list.output.files.path', 'steps.list.output.files']);
    const loop = { id: 'l', type: 'loop', over: { root: 'steps', id: 's1', path: ['rows'] } };
    assert.deepEqual(stepReadPaths(loop), ['steps.s1.output.rows']);
    const loopPick = { id: 'l', type: 'loop', over: pick({ root: 'steps', id: 's1', path: ['rows'] }) };
    assert.deepEqual(stepReadPaths(loopPick), ['steps.s1.output.rows']);
    assert.deepEqual(stepReadPaths(null), []);
});

test('textAsTemplate writes a compose as {{ }} text, and leaves a string alone', () => {
    const compose = {
        kind: 'compose', v: 1,
        parts: ['Beste ', part({ root: 'trigger', path: ['name'] }), ', uw orders:\n', part({ root: 'steps', id: 's', path: ['items', 'product'] }, { take: 'all', join: 'bullets' })],
    };
    assert.equal(textAsTemplate(compose), 'Beste {{trigger.output.name}}, uw orders:\n{{steps.s.output.items.product}}');
    assert.equal(textAsTemplate('Hi {{trigger.output.name}}'), 'Hi {{trigger.output.name}}');
    assert.equal(textAsTemplate(pick({ root: 'steps', id: 's', path: ['total'] })), '{{steps.s.output.total}}');
    assert.equal(textAsTemplate({ kind: 'compose', parts: ['x'] }), '');
    assert.equal(textAsTemplate(undefined), '');
});

test('stepIdsRead names every step a value reads through picks, composes, repeats and loops', () => {
    const step = {
        type: 'loop',
        over: { root: 'steps', id: 'list', path: ['items'] },
        body: [{
            type: 'notification',
            repeat: { over: { root: 'steps', id: 'rows', path: [] } },
            body: { kind: 'compose', v: 1, parts: ['Hi ', part({ root: 'steps', id: 'ai_1', path: ['text'] })] },
            inputs: {
                // A key no legacy path can spell still names its step.
                odd: pick({ root: 'steps', id: 'odd', path: ['a]b'] }),
                old: { kind: 'literal', value: pick({ root: 'steps', id: 'hidden', path: [] }) },
                trig: pick({ root: 'trigger', path: ['x'] }),
            },
        }],
    };
    assert.deepEqual(stepIdsRead(step).sort(), ['ai_1', 'list', 'odd', 'rows']);
    assert.deepEqual(stepIdsRead(null), []);
});
