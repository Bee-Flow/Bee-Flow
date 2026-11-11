/**
 * Layout v2 in the canonicalizer and the validator: the placement and grid_columns knob
 * groups are kept only when set, raise the schema version, and warn where they cannot work.
 *
 * Run: cd server && node --test appStudio/validate/layoutChecks.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAppDefinition } = require('../validate');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { SECTION_STYLE_DEFAULTS, STYLE_KNOBS, COMPONENT_SPECS, expandStyleKnobs, SECTION_STYLE_KNOBS } = require('../componentSpecs');
const { GRID_TYPES } = require('./layoutChecks.mts');

/** An app of one screen with one section; `sectionStyle` and `children` as given. */
function app(children, sectionStyle = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'Layout' },
        theme: {},
        homeScreenId: 'scr_main01',
        screens: [{
            id: 'scr_main01', name: 'Home',
            sections: [{ id: 'sec_main01', style: { ...SECTION_STYLE_DEFAULTS, ...sectionStyle }, children }],
        }],
        actions: {},
    };
}

const heading = (id, style) => ({ id, type: 'heading', props: { text: 'Hi' }, style });
const card = (id, style, children = []) => ({ id, type: 'card', props: {}, style, children });

function run(def) {
    const canon = canonicalizeAppDefinition(def);
    const result = validateAppDefinition(canon.def);
    return { def: canon.def, hints: canon.hints || canon.repairs || [], ...result };
}

const layoutCodes = (result) => result.warnings.filter((w) => w.code.startsWith('layout.')).map((w) => `${w.code} @ ${w.path}`);
const firstSection = (def) => def.screens[0].sections[0];

test('a definition without the layout knobs stores none of them and stays schema version 2', () => {
    const out = run(app([heading('cmp_head01', { span: 6 }), card('cmp_card01', { span: 6 })]));
    assert.equal(out.def.schemaVersion, 2);
    const section = firstSection(out.def);
    const knobs = ['spanMd', 'spanSm', 'rowSpan', 'alignSelf', 'sticky', 'stickyOffset', 'columns', 'responsive'];
    for (const holder of [section, ...section.children]) {
        for (const knob of knobs) assert.equal(Object.hasOwn(holder.style, knob), false, `${holder.id} has no ${knob}`);
    }
    assert.deepEqual(layoutCodes(out), []);
    assert.equal(out.ok, true);
});

test('the knobs are kept as written, clamped to their range, and make the definition version 3', () => {
    const out = run(app([
        heading('cmp_head01', { span: 2, spanMd: 3, spanSm: 99, rowSpan: 2, alignSelf: 'center', sticky: 'top', stickyOffset: 2 }),
        card('cmp_card01', { span: 3, columns: 4, responsive: 'manual' }),
    ], { columns: 5 }));
    assert.equal(out.def.schemaVersion, 3);
    const section = firstSection(out.def);
    assert.equal(section.style.columns, 5);
    assert.deepEqual(
        { ...section.children[0].style },
        { ...COMPONENT_SPECS.heading.defaultStyle, span: 2, spanMd: 3, spanSm: 12, rowSpan: 2, alignSelf: 'center', sticky: 'top', stickyOffset: 2 },
    );
    assert.equal(section.children[1].style.columns, 4);
    assert.equal(section.children[1].style.responsive, 'manual');
    assert.equal(out.ok, true, JSON.stringify(out.errors));
});

test('null clears a layout knob: the key is left out and nothing is reported', () => {
    const canon = canonicalizeAppDefinition(app([heading('cmp_head01', { spanMd: null, sticky: null, rowSpan: null })], { columns: null }));
    const section = firstSection(canon.def);
    assert.equal(Object.hasOwn(section.style, 'columns'), false);
    for (const knob of ['spanMd', 'sticky', 'rowSpan']) assert.equal(Object.hasOwn(section.children[0].style, knob), false);
    assert.equal(canon.def.schemaVersion, 2);
    assert.equal(JSON.stringify(canon).includes('style.invalid'), false);
});

test('a value that is not a number is dropped, never replaced by a default', () => {
    const canon = canonicalizeAppDefinition(app([heading('cmp_head01', { spanMd: 'wide' })]));
    assert.equal(Object.hasOwn(firstSection(canon.def).children[0].style, 'spanMd'), false);
    assert.equal(JSON.stringify(canon).includes('spanMd must be an integer 1..12 — dropped.'), true);
});

test('the grid knobs reach the section and exactly the types that carry gap', () => {
    assert.equal(expandStyleKnobs(SECTION_STYLE_KNOBS).includes('columns'), true);
    assert.equal(SECTION_STYLE_KNOBS.includes('columns'), false, 'granted by rule, not listed');
    for (const type of GRID_TYPES) {
        assert.equal(expandStyleKnobs(COMPONENT_SPECS[type].styleKnobs).includes('columns'), true, `${type} has columns`);
        assert.equal(COMPONENT_SPECS[type].container, true, `${type} is a container`);
    }
    assert.equal(expandStyleKnobs(COMPONENT_SPECS.heading.styleKnobs).includes('columns'), false);
    assert.equal(expandStyleKnobs(COMPONENT_SPECS.heading.styleKnobs).includes('spanMd'), true);
    for (const knob of ['spanMd', 'spanSm', 'rowSpan', 'stickyOffset', 'columns']) assert.equal(STYLE_KNOBS[knob].default, undefined, `${knob} has no default`);
});

test('columns on a type without a column grid is a warning', () => {
    const out = run(app([{ id: 'cmp_pane01', type: 'pane', props: {}, style: { columns: 3, responsive: 'manual' }, children: [] }]));
    assert.deepEqual(layoutCodes(out), [
        'layout.columns_not_a_grid @ screens[0].sections[0].children[0].style.columns',
        'layout.columns_not_a_grid @ screens[0].sections[0].children[0].style.responsive',
    ]);
    assert.equal(out.ok, true);
});

test('a span above the parent columns warns, except 12 (the full row)', () => {
    const out = run(app([
        heading('cmp_head01', { span: 8, spanMd: 6, spanSm: 2 }),
        heading('cmp_head02', { span: 12 }),
        card('cmp_card01', { span: 5, columns: 3 }, [heading('cmp_head03', { span: 4 }), heading('cmp_head04', { span: 3 })]),
    ], { columns: 5 }));
    assert.deepEqual(layoutCodes(out), [
        'layout.span_exceeds_columns @ screens[0].sections[0].children[0].style.span',
        'layout.span_exceeds_columns @ screens[0].sections[0].children[0].style.spanMd',
        'layout.span_exceeds_columns @ screens[0].sections[0].children[2].children[0].style.span',
    ]);
});

test('rowSpan directly inside a fill grid warns, in a section and in a container', () => {
    const out = run(app([
        heading('cmp_head01', { span: 6, rowSpan: 2 }),
        card('cmp_card01', { span: 6, height: 'fill' }, [heading('cmp_head02', { rowSpan: 3 }), heading('cmp_head03', { rowSpan: 1 })]),
    ], { height: 'fill' }));
    assert.deepEqual(layoutCodes(out), [
        'layout.row_span_in_fill @ screens[0].sections[0].children[0].style.rowSpan',
        'layout.row_span_in_fill @ screens[0].sections[0].children[1].children[0].style.rowSpan',
    ]);
});

test('sticky inside a fixed-height box warns, at any depth, and stickyOffset alone warns', () => {
    const out = run(app([
        card('cmp_card01', { height: 'md' }, [
            { id: 'cmp_cont01', type: 'container', props: {}, style: {}, children: [heading('cmp_head01', { sticky: 'top' })] },
        ]),
        heading('cmp_head02', { sticky: 'bottom', stickyOffset: 2 }),
        heading('cmp_head03', { stickyOffset: 3 }),
        heading('cmp_head04', { sticky: 'none', stickyOffset: 0 }),
    ]));
    assert.deepEqual(layoutCodes(out), [
        'layout.sticky_in_scroll_box @ screens[0].sections[0].children[0].children[0].children[0].style.sticky',
        'layout.sticky_offset_unused @ screens[0].sections[0].children[2].style.stickyOffset',
    ]);
    const boxed = run(app([heading('cmp_head01', { sticky: 'top' })], { heightMode: 'px', heightValue: 400 }));
    assert.deepEqual(layoutCodes(boxed), ['layout.sticky_in_scroll_box @ screens[0].sections[0].children[0].style.sticky']);
});
