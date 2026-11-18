'use strict';

// The definition side of web search in AI steps: the human-set aiWebSearch key and the step's
// webSearch field, through the real canonicalizer and validator.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');

function app(steps, extra = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'Research', description: '', icon: 'Zap' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        roles: [],
        homeScreenId: 'scr_home0001',
        screens: [
            { id: 'scr_home0001', name: 'Home', icon: null, showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_home0001', style: { padding: 4, gap: 3, background: 'none' }, children: [
                { id: 'cmp_btn00001', type: 'button', props: { label: 'Go' }, onClick: 'act_seq00001', style: { span: 4 }, visible: true },
            ] }] },
        ],
        actions: { act_seq00001: { kind: 'sequence', steps } },
        ...extra,
    };
}

const canon = (def) => canonicalizeAppDefinition(def).def;
const check = (def) => validateAppDefinition(canon(def));
const generate = { kind: 'ai_generate', prompt: 'What is the current VAT rate?', output: 'text', webSearch: true, resultVar: 'answer' };

test('aiWebSearch keeps only enabled, as a boolean, and an absent key stays absent', () => {
    assert.deepEqual(canon(app([], { aiWebSearch: { enabled: true, extra: 'x' } })).aiWebSearch, { enabled: true });
    assert.deepEqual(canon(app([], { aiWebSearch: { enabled: 'yes' } })).aiWebSearch, { enabled: false });
    assert.equal('aiWebSearch' in canon(app([])), false);
    assert.equal('aiWebSearch' in canon(app([], { aiWebSearch: 'on' })), false);
});

test('a webSearch step in an app whose switch is off is an error, and passes once it is on', () => {
    const off = check(app([generate]));
    assert.deepEqual(off.errors.filter((e) => e.code === 'web_search.not_enabled').map((e) => e.path).length, 1);
    const on = check(app([generate], { aiWebSearch: { enabled: true } }));
    assert.equal(on.errors.some((e) => e.code === 'web_search.not_enabled'), false);
    assert.deepEqual(on.errors, []);
});

test('the step keeps webSearch through the canonicalizer, for ai_extract too', () => {
    const extract = { kind: 'ai_extract', source: { kind: 'formula', expr: 'form.file' }, schema: [{ name: 'title', type: 'string' }], webSearch: true };
    const def = canon(app([generate, extract], { aiWebSearch: { enabled: true } }));
    assert.equal(def.actions.act_seq00001.steps[0].webSearch, true);
    assert.equal(def.actions.act_seq00001.steps[1].webSearch, true);
});
