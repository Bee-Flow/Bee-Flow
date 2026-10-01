import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultIntent, optionsFor, normalizePick, sourceFromPath, TAKES, AS, JOINS } from './intent.mjs';
import { pickProblems } from './validate.mjs';

const text = (multiLine) => ({ as: 'text', multiLine });

test('defaultIntent: the table of design §3', () => {
    assert.deepStrictEqual(defaultIntent('single', text(false)), { take: 'one', as: 'text' });
    assert.deepStrictEqual(defaultIntent('object', text(true)), { take: 'one', as: 'text' });
    assert.deepStrictEqual(defaultIntent('list', { as: 'list' }), { take: 'all', as: 'list' });
    assert.deepStrictEqual(defaultIntent('table', { as: 'list' }), { take: 'all', as: 'list' });
    assert.deepStrictEqual(defaultIntent('list', text(true)), { take: 'all', as: 'text', join: 'lines' });
    assert.deepStrictEqual(defaultIntent('table', text(false)), { take: 'all', as: 'text', join: 'comma' });
    assert.deepStrictEqual(defaultIntent('list', { as: 'number' }), { take: 'first', as: 'number', warning: 'many_for_one' });
    assert.deepStrictEqual(defaultIntent('list', { as: 'date' }), { take: 'first', as: 'date', warning: 'many_for_one' });
    assert.deepStrictEqual(defaultIntent('list', { as: 'json' }), { take: 'all', as: 'json' });
    assert.deepStrictEqual(defaultIntent('list', null), { take: 'all', as: 'native' }, 'no schema: native');
    assert.deepStrictEqual(defaultIntent('missing', undefined), { take: 'one', as: 'native' });
});

test('optionsFor: the PickOptions entries, default first', () => {
    assert.deepStrictEqual(optionsFor('list', text(true)).map(o => o.id), ['all_lines', 'all_comma', 'all_bullets', 'first', 'last', 'count']);
    assert.deepStrictEqual(optionsFor('list', text(false)).map(o => o.id), ['all_comma', 'all_lines', 'all_bullets', 'first', 'last', 'count']);
    assert.deepStrictEqual(optionsFor('list', { as: 'list' }).map(o => o.id), ['all', 'first', 'last']);
    assert.deepStrictEqual(optionsFor('list', { as: 'number' }).map(o => o.id), ['first', 'last', 'count']);
    assert.deepStrictEqual(optionsFor('list', { as: 'yesno' }).map(o => o.id), ['first', 'last']);
    assert.deepStrictEqual(optionsFor('single', text(true)), [{ id: 'one', take: 'one', as: 'text' }]);
    assert.deepStrictEqual(optionsFor('list', { as: 'list' }, { repeat: true })[0], { id: 'each', take: 'each', as: 'list' });
    for (const o of optionsFor('table', text(true))) {
        assert.ok(TAKES.includes(o.take) && AS.includes(o.as) && (o.join === undefined || JOINS.includes(o.join)), JSON.stringify(o));
    }
});

test('sourceFromPath: a legacy path as a v2 Source, [*] dropped', () => {
    assert.deepStrictEqual(sourceFromPath('steps.x.output.items[*].email'), { root: 'steps', id: 'x', path: ['items', 'email'] });
    assert.deepStrictEqual(sourceFromPath('trigger.output.Klant["E-mail adres"]'), { root: 'trigger', path: ['Klant', 'E-mail adres'] });
    assert.deepStrictEqual(sourceFromPath('trigger.firedAt'), { root: 'run', path: ['firedAt'] });
    assert.deepStrictEqual(sourceFromPath('item.amount'), { root: 'item', path: ['amount'] });
    assert.deepStrictEqual(sourceFromPath('steps.x.output.items.0.name'), { root: 'steps', id: 'x', path: ['items', 0, 'name'] }, 'repaired');
    assert.equal(sourceFromPath('secrets.k'), null);
    assert.equal(sourceFromPath('trigger.headers.x'), null);
    assert.equal(sourceFromPath('steps.x'), null);
    assert.equal(sourceFromPath('not a path at all {'), null);
    assert.equal(sourceFromPath(5), null);
});

test('normalizePick: the compact form and the stored form, to one spelling', () => {
    const compact = normalizePick({ pick: 'steps.x.output.items.email', take: 'all' });
    assert.deepStrictEqual(compact, { kind: 'pick', v: 1, from: { root: 'steps', id: 'x', path: ['items', 'email'] }, take: 'all', as: 'native' });
    assert.deepStrictEqual(pickProblems(compact), []);
    const stored = { kind: 'pick', v: 1, from: { root: 'trigger', path: ['a'] }, take: 'one', as: 'text', join: 'lines', label: 'A', junk: 1 };
    assert.deepStrictEqual(normalizePick(stored), { kind: 'pick', v: 1, from: { root: 'trigger', path: ['a'] }, take: 'one', as: 'text', join: 'lines', label: 'A' });
    assert.deepStrictEqual(normalizePick({ from: { root: 'vars', path: ['g'] } }, { part: true }), { from: { root: 'vars', path: ['g'] }, take: 'one', as: 'text' });
    assert.equal(normalizePick({ pick: 'nonsense here' }), null);
    assert.equal(normalizePick({ kind: 'ref', path: 'x' }), null);
    assert.equal(normalizePick(null), null);
    const from = { root: 'trigger', path: ['a'] };
    const copy = normalizePick({ kind: 'pick', v: 1, from, take: 'one', as: 'native' });
    copy.from.path.push('b');
    assert.deepStrictEqual(from.path, ['a'], 'the Source is copied, not shared');
});
