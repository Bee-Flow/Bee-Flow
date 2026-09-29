/**
 * automation/orgStepUsage.js — what an organisation's routines are made of.
 *
 * Proven:
 *   - step counts use the ribbon's usage keys, walk loop bodies, parallel
 *     branches and layers, and skip notes, flowlet calls and junk;
 *   - value counts keep only short literals: no bindings, templates, objects,
 *     and never anything that looks like personal data or a credential;
 *   - top values are capped at five, most used first;
 *   - the aggregate is cached per scope for the TTL, loads are shared, and a
 *     failed load is retried.
 *
 * Run: cd server && node --test automation/orgStepUsage.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeOrgStepUsage, aggregate, topValues, usageKeyOf, chipValueOf, isUnsafeValue, FREE_TEXT_INPUT_RE } = require('./orgStepUsage');

const lit = (value) => ({ kind: 'literal', value });
const list = (path) => ({ id: `l${Math.random()}`, type: 'integration_action', tool: 'nextcloud_list_files', inputs: { path } });

const DEFS = [
    {
        trigger: { id: 't', type: 'manual' },
        steps: [
            list(lit('/Invoices')),
            { id: 'ai', type: 'ai_step', prompt: 'x' },
            { id: 'n', type: 'note', text: 'sticky' },
            { id: 'lp', type: 'loop', overRef: 'steps.x.output', body: [{ id: 'b1', type: 'ai_step' }, list('/Invoices')] },
            { id: 'par', type: 'parallel', branches: [[{ id: 'p1', type: 'notification' }], [list(lit('/Photos'))]] },
            { id: 'cl', type: 'call_layer', layerKey: 'sub' },
            { id: 'cb', type: 'call_block', blockId: 'blk_1' },
        ],
        layers: { sub: { steps: [{ id: 'ls', type: 'ai_step' }, list('/Documents')] } },
    },
    {
        steps: [
            list('/Invoices'),
            list({ kind: 'ref', path: 'steps.a.output.path' }),
            list('{{steps.a.output.folder}}'),
            list('/Users/jan@example.com/Mail'),
            list(lit(42)),
            { id: 'bad', type: 'integration_action' },
            { id: 'evil', type: 'drop table;' },
            null,
        ],
    },
    'not a definition',
];

test('step counts: ribbon usage keys, nested steps and layers, no notes or flowlets', () => {
    const { steps } = aggregate(DEFS);
    const byKey = Object.fromEntries(steps.map(r => [r.key, r.count]));
    assert.strictEqual(byKey['action:nextcloud_list_files'], 9);
    assert.strictEqual(byKey['step:ai_step'], 3);
    assert.strictEqual(byKey['step:notification'], 1);
    assert.strictEqual(byKey['step:loop'], 1);
    assert.strictEqual(byKey['step:parallel'], 1);
    assert.strictEqual(byKey['block:blk_1'], 1);
    assert.strictEqual(byKey['step:note'], undefined);
    assert.strictEqual(byKey['step:call_layer'], undefined);
    assert.ok(!steps.some(r => /drop|integration_action$/.test(r.key)));
    // Most used first.
    assert.strictEqual(steps[0].key, 'action:nextcloud_list_files');
});

test('value counts: literals only, personal data skipped, top five by count', () => {
    const agg = aggregate(DEFS);
    const rows = topValues(agg, 'nextcloud_list_files', 'path');
    assert.deepStrictEqual(rows, [
        { value: '/Invoices', count: 3 },
        { value: '/Documents', count: 1 },
        { value: '/Photos', count: 1 },
        { value: '42', count: 1 },
    ]);
    assert.deepStrictEqual(topValues(agg, 'nextcloud_list_files', 'inputs.path'), rows, 'inputs. prefix is read as the bare name');
    assert.deepStrictEqual(topValues(agg, 'nextcloud_list_files', 'nope'), []);
    assert.deepStrictEqual(topValues(agg, 'unknown_tool', 'path'), []);

    const many = aggregate([{ steps: ['/a', '/b', '/c', '/d', '/e', '/f', '/a'].map(v => list(v)) }]);
    const top = topValues(many, 'nextcloud_list_files', 'path');
    assert.strictEqual(top.length, 5);
    assert.deepStrictEqual(top[0], { value: '/a', count: 2 });
});

test('the personal-data and credential screen', () => {
    const unsafe = [
        'jan@example.com', '+31 6 12345678', '0612345678', '(020) 123-4567', 'NL91ABNA0417164300',
        'NL91 ABNA 0417 1643 00', '1234 AB', '192.168.1.10', 'fe80::1ff:fe23:4567:890a',
        // Assembled at run time so the secret scan never sees a key-shaped literal.
        ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_'), 'a3f1c2e4b5d6978812ab34cd56ef7890a1b2c3d4',
        'https://example.com/share?token=abc', 'https://user@example.com/x',
    ];
    for (const v of unsafe) assert.ok(isUnsafeValue(v), `should skip ${v}`);
    const safe = [
        '/Invoices', '/Documents/Invoices-2026/Q3', 'Invoices_2026_Q3_archive_final', '2026-09-28',
        'Board 12', '/Shared/Team Finance/Receipts 2026', 'https://example.com/feed.xml', '42',
    ];
    for (const v of safe) assert.ok(!isUnsafeValue(v), `should keep ${v}`);
});

test('free-text and people settings are never counted; others\' one-off values stay theirs', () => {
    for (const input of ['to', 'subject', 'body', 'prompt', 'name', 'title', 'attendees', 'message', 'query']) {
        assert.ok(FREE_TEXT_INPUT_RE.test(input), input);
    }
    for (const input of ['path', 'folder', 'fileId', 'boardId', 'stackId', 'calendarId', 'model']) {
        assert.ok(!FREE_TEXT_INPUT_RE.test(input), input);
    }
    const mail = (subject) => ({ id: 'm', type: 'integration_action', tool: 'gmail_send', inputs: { subject, to: 'Team', label: 'x' } });
    const agg = aggregate([
        { ownerId: 'u1', definition: { steps: [mail('Weekly report'), list('/HR/Jan de Vries'), list('/Shared')] } },
        { ownerId: 'u2', definition: { steps: [mail('Weekly report'), list('/Shared')] } },
    ]);
    assert.deepStrictEqual(topValues(agg, 'gmail_send', 'subject'), []);
    assert.deepStrictEqual(topValues(agg, 'gmail_send', 'to'), []);
    assert.deepStrictEqual(topValues(agg, 'nextcloud_list_files', 'path', 5, { viewerId: 'u3' }), [{ value: '/Shared', count: 2 }]);
    assert.deepStrictEqual(topValues(agg, 'nextcloud_list_files', 'path', 5, { viewerId: 'u1' }).map(r => r.value), ['/Shared', '/HR/Jan de Vries']);
});

test('chip values: short strings and numbers only', () => {
    assert.strictEqual(chipValueOf(' /Invoices '), '/Invoices');
    assert.strictEqual(chipValueOf(lit(7)), '7');
    assert.strictEqual(chipValueOf({ kind: 'template', value: 'x' }), null);
    assert.strictEqual(chipValueOf({ kind: 'expr', value: 'a + b' }), null);
    assert.strictEqual(chipValueOf('=A1+B1'), null);
    assert.strictEqual(chipValueOf('two\nlines'), null);
    assert.strictEqual(chipValueOf('x'.repeat(121)), null);
    assert.strictEqual(chipValueOf(true), null);
    assert.strictEqual(chipValueOf(['a']), null);
    assert.strictEqual(chipValueOf(lit({ a: 1 })), null);
});

test('usageKeyOf mirrors agent-hub getUsageKey', () => {
    assert.strictEqual(usageKeyOf({ type: 'integration_action', tool: 'gmail_send' }), 'action:gmail_send');
    assert.strictEqual(usageKeyOf({ type: 'call_block', blockId: 'b' }), 'block:b');
    assert.strictEqual(usageKeyOf({ type: 'filter' }), 'step:filter');
    assert.strictEqual(usageKeyOf({ type: 'call_layer', layerKey: 'x' }), null);
    assert.strictEqual(usageKeyOf({}), null);
});

test('cache: one load per scope per TTL, shared by concurrent callers, retried after a failure', async () => {
    let clock = 1000;
    const loads = [];
    let fail = false;
    const usage = makeOrgStepUsage({
        now: () => clock,
        ttlMs: 60_000,
        loadDefinitions: async (scope) => {
            loads.push(scope);
            if (fail) throw new Error('db down');
            // u1 and u2 both use the DEFS, so their values count as shared.
            return [...DEFS.map(definition => ({ ownerId: 'u1', definition })), ...DEFS.map(definition => ({ ownerId: 'u2', definition }))];
        },
    });
    const org = { orgId: 'org1', userId: 'u1' };
    const [a, b] = await Promise.all([usage.stepUsage(org), usage.valueUsage(org, 'nextcloud_list_files', 'path')]);
    assert.strictEqual(loads.length, 1);
    assert.ok(a.length > 0);
    assert.strictEqual(b[0].value, '/Invoices');

    // Another member of the same org shares the cache; another org does not.
    await usage.stepUsage({ orgId: 'org1', userId: 'u2' });
    assert.strictEqual(loads.length, 1);
    await usage.stepUsage({ orgId: 'org2', userId: 'u3' });
    assert.strictEqual(loads.length, 2);
    // A personal install is scoped to the user.
    await usage.stepUsage({ orgId: null, userId: 'solo' });
    assert.deepStrictEqual(loads[2], { orgId: null, userId: 'solo' });

    clock += 60_001;
    fail = true;
    await assert.rejects(usage.stepUsage(org), /db down/);
    fail = false;
    await usage.stepUsage(org);
    assert.strictEqual(loads.filter(s => s.orgId === 'org1').length, 3, 'expired, failed, then reloaded');
});
