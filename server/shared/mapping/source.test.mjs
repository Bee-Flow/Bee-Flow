/**
 * Source <-> legacy path: parseLegacyPath, formatPath (the one quoting rule)
 * and lastSegment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkPath } from './legacy.mjs';
import { WILD, isWild, parseLegacyPath, formatPath, formatSegment, lastSegment, repairLegacyPath } from './source.mjs';
import { makeState, WALK } from './corpus.mjs';

test('parseLegacyPath reads the four roots', () => {
    assert.deepStrictEqual(parseLegacyPath('steps.s1.output.items[0].subject'), { root: 'steps', id: 's1', path: ['items', 0, 'subject'] });
    assert.deepStrictEqual(parseLegacyPath('steps.$read.output'), { root: 'steps', id: '$read', path: [] });
    assert.deepStrictEqual(parseLegacyPath('trigger.output.Klant["E-mail adres"]'), { root: 'trigger', path: ['Klant', 'E-mail adres'] });
    assert.deepStrictEqual(parseLegacyPath('loop.row["Due date"]'), { root: 'loop', id: 'row', path: ['Due date'] });
    assert.deepStrictEqual(parseLegacyPath('loop._index'), { root: 'loop', id: '_index', path: [] });
    assert.deepStrictEqual(parseLegacyPath('vars.rate'), { root: 'vars', path: ['rate'] });
    assert.deepStrictEqual(parseLegacyPath('steps.s1.output.results[*].output.a'), {
        root: 'steps', id: 's1', path: ['results', WILD, 'output', 'a'],
    });
});

test('parseLegacyPath: a path that names no value Source is null', () => {
    for (const p of [
        // REF_RE rejects these, so the runtime resolves them to undefined
        'steps.s1.output.items.0.subject', 'trigger.output.body.content-type', 'steps..s1', ' vars.x', '', '[0]',
        // well-formed, but not a value: status, error, trigger metadata, secrets
        'steps.s1.status', 'steps.fail.error.message', 'trigger.id', 'trigger', 'steps', 'steps.s1', 'loop',
        'secrets.apiKey', 'nope.x', 'steps[0].output', 'steps[*].output',
    ]) {
        assert.equal(parseLegacyPath(p), null, p);
    }
    assert.equal(parseLegacyPath(null), null);
    assert.equal(parseLegacyPath(42), null);
});

test('formatPath writes the canonical spelling', () => {
    assert.equal(formatPath({ root: 'steps', id: 's1', path: ['items', 0, 'subject'] }), 'steps.s1.output.items[0].subject');
    assert.equal(formatPath({ root: 'trigger', path: [] }), 'trigger.output');
    assert.equal(formatPath({ root: 'trigger' }), 'trigger.output');
    assert.equal(formatPath({ root: 'vars', path: [] }), 'vars');
    assert.equal(formatPath({ root: 'loop', id: 'row', path: ['Due date'] }), 'loop.row["Due date"]');
    assert.equal(formatPath({ root: 'trigger', path: ['content-type'] }), 'trigger.output["content-type"]');
    assert.equal(formatPath({ root: 'trigger', path: ['say "hi"'] }), "trigger.output['say \"hi\"']");
    assert.equal(formatPath({ root: 'trigger', path: ['0'] }), 'trigger.output["0"]');
    assert.equal(formatPath({ root: 'trigger', path: [''] }), 'trigger.output[""]');
    assert.equal(formatPath({ root: 'steps', id: 'x-y', path: ['a'] }), 'steps["x-y"].output.a');
    assert.equal(formatPath({ root: 'steps', id: 's1', path: ['rows', WILD, 'sku'] }), 'steps.s1.output.rows[*].sku');
    // a WILD that went through JSON is still a WILD
    assert.equal(formatPath(JSON.parse(JSON.stringify({ root: 'vars', path: ['l', WILD] }))), 'vars.l[*]');
});

test('formatPath refuses what the grammar cannot hold, instead of writing another path', () => {
    for (const source of [
        { root: 'trigger', path: ['a]b'] },
        { root: 'trigger', path: [`both"'`] },
        { root: 'trigger', path: [-1] },
        { root: 'trigger', path: [1.5] },
        { root: 'trigger', path: [null] },
        { root: 'trigger', path: 'a.b' },
        { root: 'steps', path: ['a'] },
        { root: 'steps', id: '', path: [] },
        { root: 'secrets', path: ['k'] },
        { root: 'nope', path: [] },
        null,
        'steps.s1.output',
    ]) {
        assert.equal(formatPath(source), null, JSON.stringify(source));
    }
});

test('every formatted key resolves back to the key it was made from', () => {
    const keys = ['plain', 'content-type', 'E-mail adres', '0', '', 'it\'s', 'say "hi"', '$x', 'ü', 'a.b', 'a[b'];
    for (const key of keys) {
        const path = formatPath({ root: 'vars', path: [key] });
        assert.ok(path, key);
        assert.equal(walkPath(path, { vars: { [key]: 'HIT' } }), 'HIT', `${key} -> ${path}`);
    }
});

test('parse then format is the identity on canonical paths, and keeps the value of every corpus path', () => {
    for (const p of [
        'steps.s1.output.items[0].subject', 'trigger.output["content-type"]', 'loop.row["Due date"]',
        'steps.s1.output.results[*].output.attachments[*].name', 'vars.list', 'trigger.output', "trigger.output['say \"hi\"']",
    ]) {
        assert.equal(formatPath(parseLegacyPath(p)), p);
    }
    let parsed = 0;
    for (const { path } of WALK) {
        const source = parseLegacyPath(path);
        if (!source) continue;
        parsed++;
        const again = formatPath(source);
        assert.ok(again, `${path} formats`);
        assert.deepStrictEqual(walkPath(again, makeState()), walkPath(path, makeState()), `${path} -> ${again}`);
    }
    assert.ok(parsed > 50, `only ${parsed} corpus paths parsed`);
});

test('isWild', () => {
    assert.equal(isWild(WILD), true);
    assert.equal(isWild({ wild: true }), true);
    assert.equal(isWild('*'), false);
    assert.equal(isWild(null), false);
    assert.equal(isWild({ wild: 'yes' }), false);
});

test('lastSegment of a path string or a Source', () => {
    assert.equal(lastSegment('steps.s1.output.items[0].subject'), 'subject');
    assert.equal(lastSegment('steps.s1.output.items[*].sku'), 'sku');
    assert.equal(lastSegment('steps.s1.output.items[*]'), 'items');
    assert.equal(lastSegment('trigger.output["E-mail adres"]'), 'E-mail adres');
    assert.equal(lastSegment('steps.s1.output.items[3]'), 3);
    assert.equal(lastSegment('steps.s1.output.items.0.x'), undefined);
    assert.equal(lastSegment(''), undefined);
    assert.equal(lastSegment({ root: 'trigger', path: ['a', 'b'] }), 'b');
    assert.equal(lastSegment({ root: 'trigger', path: [] }), undefined);
    assert.equal(lastSegment({ root: 'trigger', path: [WILD] }), undefined);
    assert.equal(lastSegment(null), undefined);
});

test('repairLegacyPath reads what the writer meant and spells it canonically', () => {
    const cases = [
        ['steps.x.output.items.0.name', 'steps.x.output.items[0].name', ''],
        ['trigger.output.body.content-type', 'trigger.output.body["content-type"]', ''],
        ['trigger.output.Order date', 'trigger.output["Order date"]', ''],
        ['steps[x].output[y]', 'steps.x.output.y', ''],
        [' steps . x . output ', 'steps.x.output', ''],
        ['steps..x.output.', 'steps.x.output', ''],
        ['steps.s1.output.items[ 0 ].x', 'steps.s1.output.items[0].x', ''],
        ['steps.s1.output.results[*].output.a', 'steps.s1.output.results[*].output.a', ''],
        ["loop.row['say \"hi\"']", "loop.row['say \"hi\"']", ''],
        ['loop.x.output.a\\"}},tempId:', 'loop.x.output.a', '\\"}},tempId:'],
        ['x + 1', 'x', ' + 1'],
        ['steps.x.output.items[0', 'steps.x.output.items', '[0'],
    ];
    for (const [text, path, rest] of cases) {
        assert.deepStrictEqual(repairLegacyPath(text), { path, rest }, text);
    }
    assert.deepStrictEqual(repairLegacyPath('{{steps.x}}'), { path: null, rest: '{{steps.x}}' });
    assert.deepStrictEqual(repairLegacyPath(null), { path: null, rest: '' });
});

test('formatSegment is the one quoting rule', () => {
    assert.equal(formatSegment('a'), '.a');
    assert.equal(formatSegment(0), '[0]');
    assert.equal(formatSegment('a b'), '["a b"]');
    assert.equal(formatSegment('say "hi"'), '[\'say "hi"\']');
    assert.equal(formatSegment(WILD), '[*]');
    assert.equal(formatSegment('a]b'), null);
    assert.equal(formatSegment(-1), null);
});
