/**
 * The layout hygiene warnings: stylesheet rules that place a cell or section against the grid,
 * empty cards and containers, and competing primary buttons in one group.
 *
 * Run: cd server && node --test appStudio/validate/layoutHygieneChecks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkLayoutHygiene, styleRules } = require('./layoutHygieneChecks.mts');

function app(children, design = undefined) {
    return {
        ...(design ? { design } : {}),
        screens: [{ id: 'scr_main01', sections: [{ id: 'sec_main01', children }] }],
    };
}

function codes(def) {
    const out = [];
    checkLayoutHygiene(def, (f) => out.push(`${f.code} @ ${f.path}`));
    return out;
}

const button = (id, props = {}) => ({ id, type: 'button', props: { label: id, ...props }, style: { span: 3 } });
const text = (id) => ({ id, type: 'text', props: { text: id }, style: { span: 12 } });

test('the stylesheet rules are read inside at-rules too, and an at-rule prelude is never a selector', () => {
    const rules = styleRules('.a{color:red}@media (max-width: 600px){.u-x{display:none}}');
    assert.deepEqual(rules.map((r) => r.selector), ['.a', '.u-x']);
});

test('grid placement on a cell or section is warned, once per rule; styling a part or a colour is not', () => {
    const css = [
        '.u-hero { grid-column: 1 / span 8; color: red }',
        '[data-section-id="sec_main01"] > [data-node-id="cmp_a"] { position: absolute; top: 0 }',
        '.u-hero .bfa-card__title { display: flex }',
        '[data-app-type="button"] { color: var(--app-primary) }',
        '.u-quiet { position: relative; background: var(--bg-card) }',
    ].join('\n');
    const out = [];
    checkLayoutHygiene(app([text('cmp_a')], { customCss: css }), (f) => out.push(f));
    assert.deepEqual(out.map((f) => f.code), ['layout.css_overrides_grid', 'layout.css_overrides_grid']);
    assert.match(out[0].message, /grid-column/);
    assert.match(out[1].message, /position: absolute/);
    assert.ok(out.every((f) => f.severity === 'warning' && f.path === 'design.customCss'));
});

test('an empty card or container is warned; an empty form or a filled card is not', () => {
    const def = app([
        { id: 'cmp_c1', type: 'card', props: {}, style: {}, children: [] },
        { id: 'cmp_c2', type: 'container', props: {}, style: {}, children: [] },
        { id: 'cmp_f1', type: 'form', props: {}, style: {}, children: [] },
        { id: 'cmp_c3', type: 'card', props: {}, style: {}, children: [text('cmp_t1')] },
    ]);
    assert.deepEqual(codes(def), [
        'layout.empty_container @ screens[0].sections[0].children[0]',
        'layout.empty_container @ screens[0].sections[0].children[1]',
    ]);
});

test('two primary buttons in one card are warned; one primary with a secondary, a keypad or a section row is not', () => {
    const card = (id, children) => ({ id, type: 'card', props: {}, style: {}, children });
    const def = app([
        card('cmp_c1', [button('cmp_b1'), button('cmp_b2', { variant: 'primary' })]),
        card('cmp_c2', [button('cmp_b3'), button('cmp_b4', { variant: 'secondary' })]),
        card('cmp_c3', ['1', '2', '3', '4', '5', '6'].map((n) => button(`cmp_k${n}`))),
        button('cmp_b5'), button('cmp_b6'),
    ]);
    assert.deepEqual(codes(def), ['layout.several_primary_actions @ screens[0].sections[0].children[0].children']);
});

test('a definition without a stylesheet, boxes or buttons gets no finding', () => {
    assert.deepEqual(codes(app([text('cmp_a')])), []);
    assert.deepEqual(codes(null), []);
});

test('the validator runs these checks only when the builder asks (opts.layoutHygiene)', () => {
    const { validateAppDefinition } = require('../validate');
    const { canonicalizeAppDefinition } = require('../canonicalize');
    const { def } = canonicalizeAppDefinition({
        schemaVersion: 2, meta: { name: 'Hygiene' }, homeScreenId: 'scr_main01',
        screens: [{ id: 'scr_main01', name: 'Home', sections: [{ id: 'sec_main01', children: [{ id: 'cmp_c1', type: 'card', props: {}, style: { span: 6 }, children: [] }] }] }],
        actions: {},
    });
    const hygiene = (r) => r.warnings.filter((w) => w.code === 'layout.empty_container').length;
    assert.equal(hygiene(validateAppDefinition(def)), 0, 'a save or publish gains no finding');
    assert.equal(hygiene(validateAppDefinition(def, { layoutHygiene: true })), 1);
});
