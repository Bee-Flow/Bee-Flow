// @typecheck strict
'use strict';

/**
 * The summary-template stamp: pure form of `summary_template_id` + `_version`.
 *
 * What is fixed here is precisely what the screen later presents as the truth: which template, which
 * version, and when we do NOT know.
 *
 * Run: cd server && node --test --test-force-exit core/meetingNotes/summaryStamp.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    BUILTIN_STAMP_PREFIX,
    EMPTY_STAMP,
    stampForBuiltin,
    stampForTemplate,
    parseStamp,
} = require('./summaryStamp');

test('een ingebouwd sjabloon krijgt een gemarkeerd id en géén versie', () => {
    assert.deepStrictEqual(stampForBuiltin('standup'), {
        summaryTemplateId: 'builtin:standup',
        summaryTemplateVersion: null,
    });
    // Built-in templates live in code, not in a table: there is no version to show,
    // and therefore none is invented either.
    assert.strictEqual(stampForBuiltin('general').summaryTemplateVersion, null);
});

test('een onbekende ingebouwde sleutel stempelt general — de prompt die echt gebruikt is', () => {
    // builtinPrompt() falls back to general; the stamp must make the same fallback,
    // otherwise the note names a template that did not write it.
    assert.strictEqual(stampForBuiltin('does-not-exist').summaryTemplateId, 'builtin:general');
    assert.strictEqual(stampForBuiltin(null).summaryTemplateId, 'builtin:general');
});

test('een opgeslagen sjabloon draagt zijn id en de versie van dit moment', () => {
    assert.deepStrictEqual(stampForTemplate({ id: 'tpl-9', version: 4 }), {
        summaryTemplateId: 'tpl-9',
        summaryTemplateVersion: 4,
    });
});

test('een sjabloonrij zonder bruikbare versie levert null, geen verzonnen 1', () => {
    for (const version of [undefined, null, 0, -3, 'v4', NaN, 2.5]) {
        const stamp = stampForTemplate({ id: 'tpl-9', version });
        assert.strictEqual(stamp.summaryTemplateId, 'tpl-9', `id blijft bij version=${String(version)}`);
        assert.strictEqual(stamp.summaryTemplateVersion, null, `versie is null bij version=${String(version)}`);
    }
});

test('geen sjabloon = een leeg paar, niet "laat de velden weg"', () => {
    // This is the ERASE value: a one-off prompt must remove an old stamp, and that can only
    // happen if something is written.
    assert.deepStrictEqual(EMPTY_STAMP, { summaryTemplateId: null, summaryTemplateVersion: null });
    assert.deepStrictEqual(stampForTemplate(null), { summaryTemplateId: null, summaryTemplateVersion: null });
    assert.deepStrictEqual(stampForTemplate({ version: 3 }), { summaryTemplateId: null, summaryTemplateVersion: null });
});

test('EMPTY_STAMP is bevroren en wordt per aanroep gekopieerd', () => {
    assert.ok(Object.isFrozen(EMPTY_STAMP));
    const a = stampForTemplate(null);
    a.summaryTemplateId = 'besmet';
    assert.strictEqual(EMPTY_STAMP.summaryTemplateId, null, 'een caller kan de gedeelde waarde niet vervuilen');
});

test('parseStamp onderscheidt ingebouwd van opgeslagen', () => {
    assert.deepStrictEqual(parseStamp('builtin:sales'), { kind: 'builtin', key: 'sales' });
    assert.deepStrictEqual(parseStamp('7f0e-uuid'), { kind: 'custom', key: '7f0e-uuid' });
    assert.strictEqual(BUILTIN_STAMP_PREFIX, 'builtin:');
});

test('parseStamp geeft null voor niets en voor onleesbaar', () => {
    for (const bad of [null, undefined, '', '   ', 42, {}, [], 'builtin:']) {
        assert.strictEqual(parseStamp(bad), null, `onleesbaar: ${JSON.stringify(bad)}`);
    }
});
