// @typecheck
/**
 * valueTypes.js and the plumbing that reads it: value types of style knobs and design keys,
 * optional design keys, slot containers and emit-when-present keys.
 *
 * Knobs, keys and types made up here prove each mechanism and are removed again; whatever the
 * shipped catalogue uses of it is only held to the rules below.
 * Run: node --test appStudio/componentSpecs/valueTypes.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const specs = require('../componentSpecs');
const { VALUE_TYPES, valueTypeOf, isCleanValue, isAssetRef } = require('./valueTypes');
const { loadKnobGroupExtensions, EXTENSION_KNOB_TYPES } = require('./knobGroupExtensions');
const { cleanStyle } = require('../canonicalize/style');
const { emitOptionalKeys } = require('../canonicalize/shared');
const { canonDesign, DESIGN_SPEC } = require('../appDesignSpec');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { buildCatalogSections, renderStyleKnobEntry } = require('../builderPrompt/catalogRender');
const { _catalogueChanged } = require('../catalogTiers.mts');

const { STYLE_KNOBS } = specs;

/** A stand-in sanitiser: drops one marker, so a test can see it ran. */
const stripMarker = (/** @type {string} */ text) => text.split('@bad;').join('');
const imageKnob = { type: 'asset', default: null, since: 3 };
const cssKnob = { type: 'css', default: null, since: 3, maxLen: 40, sanitize: stripMarker };

/** Run `fn` with made-up knobs in STYLE_KNOBS (this file has its own process). */
function withKnobs(knobs, fn) {
    Object.assign(STYLE_KNOBS, knobs);
    try { return fn(); } finally { for (const k of Object.keys(knobs)) delete STYLE_KNOBS[k]; }
}

/** The seven design keys of the frozen base: always written, never optional, never value-typed. */
const BASE_DESIGN_KEYS = ['preset', 'font', 'surface', 'motion', 'chartPalette', 'accentEdge', 'logoUrl'];

test('whatever ships uses a value type, an optional design key or a slot container by the rules', () => {
    for (const name of ['asset', 'css']) assert.ok(Object.hasOwn(VALUE_TYPES, name), name);
    // A value-typed knob is new vocabulary, unset by default and passes its type's own check.
    for (const [name, knob] of Object.entries(STYLE_KNOBS)) {
        const valueType = valueTypeOf(knob);
        if (!valueType) continue;
        assert.ok(/** @type {any} */ (knob).since >= 3, `knob ${name} (${knob.type}): since 3 or more`);
        assert.equal(knob.default, null, `knob ${name} (${knob.type}): default null, so it is never written for a style that did not set it`);
        valueType.check(knob, `knob ${name}`);
    }
    // The base design keys are as they were; a key added later is optional and marked.
    assert.deepEqual(Object.keys(DESIGN_SPEC).slice(0, BASE_DESIGN_KEYS.length), BASE_DESIGN_KEYS);
    for (const [name, spec] of Object.entries(/** @type {Record<string, any>} */ (DESIGN_SPEC))) {
        if (BASE_DESIGN_KEYS.includes(name)) {
            assert.equal(valueTypeOf(spec), null, name);
            assert.equal(spec.optional, undefined, `${name} is a base design key: always written`);
            continue;
        }
        assert.equal(spec.optional, true, `design.${name}: a key added after the base is optional (written only when set)`);
        assert.ok(spec.since >= 3, `design.${name}: since 3 or more`);
        const valueType = valueTypeOf(spec);
        if (valueType) valueType.check(spec, `design.${name}`);
    }
    // A slot container is always a container.
    for (const [type, spec] of Object.entries(/** @type {Record<string, any>} */ (specs.COMPONENT_SPECS))) {
        if (!spec.slotContainer) continue;
        assert.equal(spec.container, true, `${type}: a slot container is a container`);
    }
});

test('asset: only the string asset:<id>', () => {
    for (const ok of ['asset:a', 'asset:logo_01', 'asset:9f3c-AB', `asset:${'x'.repeat(64)}`]) assert.equal(isAssetRef(ok), true, ok);
    for (const bad of ['asset:', 'asset', 'Asset:a', 'asset:a b', 'asset:a/b', 'asset:a.png', `asset:${'x'.repeat(65)}`, 'https://x.test/a.png', '', null, 5, {}]) {
        assert.equal(isAssetRef(bad), false, JSON.stringify(bad));
    }
    assert.equal(VALUE_TYPES.asset.clean('asset:logo', imageKnob), 'asset:logo');
    assert.equal(VALUE_TYPES.asset.clean('logo', imageKnob), undefined);
    assert.equal(VALUE_TYPES.asset.render('backgroundImage', imageKnob), 'backgroundImage(null|asset:<id>)');
});

test('css: text goes through the sanitiser its spec names, and nowhere without one', () => {
    const { css } = VALUE_TYPES;
    assert.equal(css.clean('a{color:red}', cssKnob), 'a{color:red}');
    assert.equal(css.clean('a{}@bad;b{}', cssKnob), 'a{}b{}');
    assert.equal(css.clean('x'.repeat(41), cssKnob), undefined, 'over maxLen');
    assert.equal(css.clean('@bad;', cssKnob), undefined, 'nothing left');
    assert.equal(css.clean(5, cssKnob), undefined);
    assert.equal(css.clean('a{}', { type: 'css', maxLen: 40 }), undefined, 'no sanitiser: nothing is accepted');
    assert.equal(css.clean('a{}', { type: 'css', maxLen: 40, sanitize: () => ({ css: 'a{}' }) }), undefined, 'a sanitiser returns the text');
    assert.throws(() => css.check({ type: 'css', sanitize: stripMarker }, 'here'), /maxLen/);
    assert.throws(() => css.check({ type: 'css', maxLen: 40 }, 'here'), /sanitize/);
    css.check(cssKnob, 'here');
    assert.equal(css.render('custom', cssKnob), 'custom(null|css, max 40 chars)');
    // The validator's question: is the stored value what clean() would store?
    assert.equal(isCleanValue(css, 'a{}', cssKnob), true);
    assert.equal(isCleanValue(css, 'a{}@bad;', cssKnob), false);
    assert.equal(isCleanValue(css, null, cssKnob), false);
});

test('cleanStyle: a value-typed knob is stored when valid and absent otherwise', () => {
    withKnobs({ image: imageKnob, custom: cssKnob }, () => {
        /** @type {Array<[string, string]>} */
        const notes = [];
        const push = (/** @type {string} */ code, /** @type {string} */ at) => notes.push([code, at]);
        const allowed = ['span', 'image', 'custom'];
        assert.deepEqual(cleanStyle({ span: 6 }, allowed, { span: 12 }, 'x', push), { span: 6 });
        assert.deepEqual(cleanStyle({ span: 6, image: null, custom: null }, allowed, { span: 12 }, 'x', push), { span: 6 });
        assert.deepEqual(cleanStyle({ image: 'asset:hero', custom: 'a{}@bad;' }, allowed, { span: 12 }, 'x', push), { span: 12, image: 'asset:hero', custom: 'a{}' });
        assert.deepEqual(notes, []);
        assert.deepEqual(cleanStyle({ image: 'https://x.test/a.png', custom: 7 }, allowed, { span: 12 }, 'x', push), { span: 12 });
        assert.deepEqual(notes, [['style.invalid', 'x.image'], ['style.invalid', 'x.custom']]);
    });
});

test('validate and the AI catalogue read the same table', () => {
    const type = 'heading';
    const spec = specs.COMPONENT_SPECS[type];
    const before = [...spec.styleKnobs];
    withKnobs({ image: imageKnob }, () => {
        spec.styleKnobs.push('image');
        try {
            const def = specs.emptyDefinition('value types');
            def.screens[0].sections[0].children = [{ id: 'cmp_head01', type, props: {}, style: { image: 'asset:hero' } }];
            const { def: canon } = canonicalizeAppDefinition(def);
            assert.equal(canon.screens[0].sections[0].children[0].style.image, 'asset:hero');
            assert.deepEqual(validateAppDefinition(canon).errors, []);
            canon.screens[0].sections[0].children[0].style.image = 'hero.png';
            const errors = validateAppDefinition(canon).errors;
            assert.equal(errors.length, 1, JSON.stringify(errors));
            assert.equal(errors[0].code, 'style.invalid');
            assert.match(errors[0].hint, /asset:<id>/);
            // The knob is marked since 3, so it is an extension (catalogTiers.mts): the catalogue
            // text leaves it out, and its entry is rendered from the same table on request.
            _catalogueChanged();
            assert.match(renderStyleKnobEntry('image'), /^image\(null\|asset:<id>\)$/);
            assert.doesNotMatch(JSON.stringify(buildCatalogSections()), /asset:<id>/);
        } finally {
            spec.styleKnobs.length = 0;
            spec.styleKnobs.push(...before);
            _catalogueChanged();
        }
    });
});

const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

/** A knob group registry directory holding one file with `source` as its text. */
function groupDir(source) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-value-types-'));
    made.push(dir);
    fs.writeFileSync(path.join(dir, 'backdrop.js'), source);
    return dir;
}

test('a knob group file may declare value-typed knobs', () => {
    assert.deepEqual([...EXTENSION_KNOB_TYPES], ['enum', 'int', 'colorOrRole', 'asset', 'css']);
    const ctx = { styleKnobs: STYLE_KNOBS, baseGroupNames: [] };
    const group = (knob) => `module.exports = { since: 3, grantedBy: 'span', knobs: { backdrop: ${knob} } };\n`;
    const [loaded] = loadKnobGroupExtensions(groupDir(group("{ type: 'asset', default: null, since: 3 }")), ctx);
    assert.deepEqual(loaded.knobs, ['backdrop']);
    loadKnobGroupExtensions(groupDir(group("{ type: 'css', default: null, since: 3, maxLen: 200, sanitize: (t) => t }")), ctx);
    assert.throws(() => loadKnobGroupExtensions(groupDir(group("{ type: 'asset', default: 'asset:x', since: 3 }")), ctx), /default null/);
    assert.throws(() => loadKnobGroupExtensions(groupDir(group("{ type: 'css', default: null, since: 3, maxLen: 200 }")), ctx), /sanitize/);
});

test('canonDesign: an optional key is written only when present and valid', () => {
    const spec = {
        ...DESIGN_SPEC,
        tone: { type: 'enum', values: ['calm', 'loud'], default: 'calm', optional: true },
        banner: { type: 'asset', optional: true },
        sheet: { type: 'css', optional: true, maxLen: 40, sanitize: stripMarker },
        mark: { type: 'url', default: null, maxLen: 60, optional: true },
    };
    /** @type {string[]} */
    const notes = [];
    const push = (/** @type {string} */ code, /** @type {string} */ at) => notes.push(`${code} ${at}`);
    const base = canonDesign({ surface: 'soft' }, () => {});

    // A design that never used the new keys comes out exactly as under the base table.
    assert.equal(JSON.stringify(canonDesign({ surface: 'soft' }, push, spec)), JSON.stringify(base));
    assert.equal(JSON.stringify(canonDesign({ surface: 'soft', tone: null, banner: null, sheet: null, mark: null }, push, spec)), JSON.stringify(base));
    assert.deepEqual(notes, []);

    // Present and valid: appended after the base keys, in table order. The default value of
    // an optional enum is kept when the author wrote it.
    const full = canonDesign({ mark: 'https://x.test/m.png', sheet: 'a{}@bad;', banner: 'asset:top', tone: 'calm', surface: 'soft' }, push, spec);
    assert.deepEqual(Object.keys(full), [...Object.keys(base), 'tone', 'banner', 'sheet', 'mark']);
    assert.deepEqual([full.tone, full.banner, full.sheet, full.mark], ['calm', 'asset:top', 'a{}', 'https://x.test/m.png']);
    assert.deepEqual(notes, []);

    // Present and invalid: dropped with a repair, never defaulted.
    const bad = canonDesign({ surface: 'soft', tone: 'shrill', banner: 'top.png', sheet: 9, mark: 'http://x.test' }, push, spec);
    assert.equal(JSON.stringify(bad), JSON.stringify(base));
    assert.deepEqual(notes, ['design.value_invalid design.tone', 'design.value_invalid design.banner', 'design.value_invalid design.sheet', 'design.value_invalid design.mark']);
});

test('a slot container writes children only when it has some', () => {
    const slot = { label: 'Slot', category: 'Layout', description: 'A test-only slot container.', container: true, slotContainer: true, props: {}, styleKnobs: ['span'], defaultStyle: { span: 12 } };
    specs.COMPONENT_SPECS.fixture_slot = slot;
    try {
        const def = specs.emptyDefinition('slot');
        def.screens[0].sections[0].children = [
            { id: 'cmp_slot01', type: 'fixture_slot', props: {} },
            { id: 'cmp_slot02', type: 'fixture_slot', props: {}, children: [] },
            { id: 'cmp_slot03', type: 'fixture_slot', props: {}, children: [{ id: 'cmp_head01', type: 'heading', props: {} }] },
            { id: 'cmp_card01', type: 'card', props: {} },
        ];
        const { def: canon } = canonicalizeAppDefinition(def);
        const [empty, emptyList, filled, card] = canon.screens[0].sections[0].children;
        assert.equal('children' in empty, false);
        assert.equal('children' in emptyList, false);
        assert.deepEqual(filled.children.map((c) => c.id), ['cmp_head01']);
        // An ordinary container is untouched: it always carries the key.
        assert.deepEqual(card.children, []);
        assert.deepEqual(validateAppDefinition(canon).errors, []);
        // Stable: a second pass changes nothing.
        assert.equal(JSON.stringify(canonicalizeAppDefinition(canon).def), JSON.stringify(canon));
    } finally {
        delete specs.COMPONENT_SPECS.fixture_slot;
    }
});

test('emitOptionalKeys: absent stays absent, present is cleaned, in table order', () => {
    /** @type {string[]} */
    const notes = [];
    const push = (/** @type {string} */ code, /** @type {string} */ at) => notes.push(`${code} ${at}`);
    const cleaners = {
        title: (v, at, p) => (typeof v === 'string' ? v.trim() || undefined : (p('section.field_invalid', at, 'title must be a string — dropped.'), undefined)),
        collapsible: (v) => (v === true ? true : undefined),
    };
    const base = () => ({ id: 'sec_a', style: {}, children: [] });
    assert.deepEqual(Object.keys(emitOptionalKeys(base(), { id: 'sec_a' }, cleaners, 's', push)), ['id', 'style', 'children']);
    assert.deepEqual(Object.keys(emitOptionalKeys(base(), { title: null, collapsible: false, stray: 1 }, cleaners, 's', push)), ['id', 'style', 'children']);
    assert.deepEqual(emitOptionalKeys(base(), { collapsible: true, title: ' Totals ' }, cleaners, 's', push), { id: 'sec_a', style: {}, children: [], title: 'Totals', collapsible: true });
    assert.deepEqual(notes, []);
    assert.deepEqual(emitOptionalKeys(base(), { title: 4 }, cleaners, 's', push), base());
    assert.deepEqual(notes, ['section.field_invalid s.title']);
    // The section table is empty: canonicalize writes exactly id, style and children.
    const def = specs.emptyDefinition('sections');
    def.screens[0].sections[0].title = 'Totals';
    assert.deepEqual(Object.keys(canonicalizeAppDefinition(def).def.screens[0].sections[0]), ['id', 'style', 'children']);
});
