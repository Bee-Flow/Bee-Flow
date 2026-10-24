// @typecheck
/**
 * fieldDiff(prev, next, { fullText: true }): a changed long-text setting also
 * carries its whole text, for the line diff. Synthetic definitions.
 *
 * Run: cd server && node --test automation/fieldDiff.fullText.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { fieldDiff } = require('./fieldDiff');
const { LONG_TEXT_SETTINGS, fullTextFields } = require('./fieldDiffText');

const clone = (x) => JSON.parse(JSON.stringify(x));

const BASE = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start' },
    steps: [
        { id: 'calc', type: 'code', label: 'Calculate', code: 'const a = 1;\nreturn a;\n' },
        { id: 'sum', type: 'ai_step', prompt: 'Summarise the items.\nKeep it short.', modelTier: 'fast' },
        { id: 'msg', type: 'notify', message: { kind: 'template', value: 'Hello {{trigger.output.name}}' }, channel: 'mail' },
    ],
    edges: [{ from: 'trg', to: 'calc' }, { from: 'calc', to: 'sum' }, { from: 'sum', to: 'msg' }],
};
const only = (changes, setting) => changes.filter((c) => c.setting === setting);

test('a changed code step and prompt carry the full text', () => {
    const next = clone(BASE);
    next.steps[0].code = 'const a = 2;\nreturn a;\n';
    next.steps[1].prompt = 'Summarise the items.\nKeep it very short.';
    const changes = fieldDiff(BASE, next, { fullText: true });
    const code = only(changes, 'code')[0];
    assert.strictEqual(code.beforeText, 'const a = 1;\nreturn a;\n');
    assert.strictEqual(code.afterText, 'const a = 2;\nreturn a;\n');
    const prompt = only(changes, 'prompt')[0];
    assert.strictEqual(prompt.beforeText, 'Summarise the items.\nKeep it short.');
    assert.strictEqual(prompt.afterText, 'Summarise the items.\nKeep it very short.');
    assert.ok(!('textTruncated' in code));
    assert.ok(!code.before.includes('\n'), 'the summary stays one line');
});

test('a template binding is text; a ref binding is not', () => {
    const next = clone(BASE);
    next.steps[2].message = { kind: 'template', value: 'Dear {{trigger.output.name}}' };
    let c = only(fieldDiff(BASE, next, { fullText: true }), 'message')[0];
    assert.strictEqual(c.beforeText, 'Hello {{trigger.output.name}}');
    assert.strictEqual(c.afterText, 'Dear {{trigger.output.name}}');

    // template -> ref: one side is text, the other is not
    const toRef = clone(BASE);
    toRef.steps[2].message = { kind: 'ref', path: 'steps.sum.output.text' };
    c = only(fieldDiff(BASE, toRef, { fullText: true }), 'message')[0];
    assert.strictEqual(c.beforeText, 'Hello {{trigger.output.name}}');
    assert.strictEqual(c.afterText, null);

    // ref -> ref: neither side is text, so no extra fields
    const a = clone(BASE); a.steps[2].message = { kind: 'ref', path: 'steps.sum.output.a' };
    const b = clone(BASE); b.steps[2].message = { kind: 'ref', path: 'steps.sum.output.b' };
    c = only(fieldDiff(a, b, { fullText: true }), 'message')[0];
    assert.ok(!('beforeText' in c) && !('afterText' in c));
});

test('an added or removed long text has null on the missing side', () => {
    const next = clone(BASE);
    delete next.steps[0].code;
    const c = only(fieldDiff(BASE, next, { fullText: true }), 'code')[0];
    assert.strictEqual(c.beforeText, 'const a = 1;\nreturn a;\n');
    assert.strictEqual(c.afterText, null);
});

test('the byte cap cuts each side and sets textTruncated', () => {
    process.env.AUTOMATION_VERSION_DIFF_TEXT_MAX_BYTES = '10';
    try {
        const next = clone(BASE);
        next.steps[0].code = 'const longer = 12345678901234567890;';
        const c = only(fieldDiff(BASE, next, { fullText: true }), 'code')[0];
        assert.strictEqual(c.textTruncated, true);
        assert.strictEqual(Buffer.byteLength(c.beforeText), 10);
        assert.strictEqual(Buffer.byteLength(c.afterText), 10);
        assert.ok(next.steps[0].code.startsWith(c.afterText));
        // 0 = unlimited
        process.env.AUTOMATION_VERSION_DIFF_TEXT_MAX_BYTES = '0';
        const u = only(fieldDiff(BASE, next, { fullText: true }), 'code')[0];
        assert.strictEqual(u.afterText, next.steps[0].code);
        assert.ok(!('textTruncated' in u));
    } finally { delete process.env.AUTOMATION_VERSION_DIFF_TEXT_MAX_BYTES; }
});

test('a cut never leaves half of a multi-byte character', () => {
    const out = fullTextFields({ parts: ['code'], before: 'ab€cd', after: 'x' }, { fullText: true });
    assert.ok(out.beforeText.length > 0);
    process.env.AUTOMATION_VERSION_DIFF_TEXT_MAX_BYTES = '4';
    try {
        const cut = fullTextFields({ parts: ['code'], before: 'ab€cd', after: null }, { fullText: true });
        assert.strictEqual(cut.beforeText, 'ab');
        assert.strictEqual(cut.textTruncated, true);
    } finally { delete process.env.AUTOMATION_VERSION_DIFF_TEXT_MAX_BYTES; }
});

test('without the option the entries are exactly what they were', () => {
    const next = clone(BASE);
    next.steps[0].code = 'const a = 2;\nreturn a;\n';
    for (const opts of [undefined, {}, { fullText: false }, { names: {} }]) {
        const c = only(opts === undefined ? fieldDiff(BASE, next) : fieldDiff(BASE, next, opts), 'code')[0];
        assert.ok(!('beforeText' in c) && !('afterText' in c) && !('textTruncated' in c), JSON.stringify(opts));
    }
});

test('settings outside the list get no full text, and the list is the documented one', () => {
    const next = clone(BASE);
    next.steps[1].modelTier = 'smart';
    const c = only(fieldDiff(BASE, next, { fullText: true }), 'modelTier')[0];
    assert.ok(c && !('beforeText' in c));
    assert.deepStrictEqual([...LONG_TEXT_SETTINGS].sort(), [
        'body', 'code', 'content', 'description', 'instructions', 'markdown', 'message', 'prompt', 'systemPrompt', 'template', 'text',
    ]);
});

test('automation-level and flowlet text settings carry it too', () => {
    const a = { ...clone(BASE), description: 'First line.\nSecond line.' };
    const b = { ...clone(BASE), description: 'First line.\nChanged line.' };
    const c = only(fieldDiff(a, b, { fullText: true }), 'description')[0];
    assert.strictEqual(c.stepLabel, 'Automation');
    assert.strictEqual(c.afterText, 'First line.\nChanged line.');
});
