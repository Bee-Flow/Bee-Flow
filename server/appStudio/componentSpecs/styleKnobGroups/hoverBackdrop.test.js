// @typecheck
/**
 * Style knob groups "hover" and "backdrop" (package LK23): who gets them, what canonicalize
 * keeps, and the validator warning for text over a picture without a veil.
 * Run: node --test appStudio/componentSpecs/styleKnobGroups/hoverBackdrop.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('../../componentSpecs');
const hover = require('./hover');
const backdrop = require('./backdrop');
const { canonicalizeAppDefinition } = require('../../canonicalize');
const { validateAppDefinition } = require('../../validate');

const { COMPONENT_SPECS, STYLE_KNOBS, SECTION_STYLE_KNOBS, expandStyleKnobs } = specs;

function appWith(children) {
    return {
        schemaVersion: 3,
        meta: { name: 'Hover' },
        theme: { primary: '#0F766E' },
        homeScreenId: 'scr_hvr0001',
        screens: [{ id: 'scr_hvr0001', name: 'Hover', sections: [{ id: 'sec_hvr0001', style: { padding: 4, gap: 3, background: 'none' }, children }] }],
    };
}
const node = (id, type, style, props = {}) => ({ id, type, props, style });

test('hover is granted to every type with span, backdrop to the same minus the types that frame their own box', () => {
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
        const has = spec.styleKnobs.includes('span');
        const knobs = expandStyleKnobs(spec.styleKnobs, undefined, type);
        for (const k of Object.keys(hover.knobs)) assert.equal(knobs.includes(k), has, `${type} ${k}`);
        const gets = has && !backdrop.withheldFrom.includes(type);
        for (const k of Object.keys(backdrop.knobs)) assert.equal(knobs.includes(k), gets, `${type} ${k}`);
        for (const k of [...Object.keys(hover.knobs), ...Object.keys(backdrop.knobs)]) assert.ok(!Object.hasOwn(spec.defaultStyle || {}, k));
    }
    for (const k of [...Object.keys(hover.knobs), ...Object.keys(backdrop.knobs)]) {
        assert.ok(!expandStyleKnobs(SECTION_STYLE_KNOBS).includes(k), `a section does not get ${k}`);
        assert.ok(STYLE_KNOBS[k]);
    }
    for (const type of backdrop.withheldFrom) assert.ok(COMPONENT_SPECS[type], `${type} is a component type`);
});

test('canonicalize keeps what is set, drops what is unusable, and writes nothing for a node that sets none', () => {
    const { def } = canonicalizeAppDefinition(appWith([
        node('cmp_hvr0001', 'heading', { span: 6, hover: 'lift', backgroundImage: 'asset:abc_1', backgroundFit: 'tile', backgroundOverlay: 'dim' }, { text: 'A', level: 2 }),
        node('cmp_hvr0002', 'heading', { span: 6, hover: 'sparkle', backgroundImage: 'https://example.com/x.png' }, { text: 'B', level: 2 }),
        node('cmp_hvr0003', 'heading', { span: 6 }, { text: 'C', level: 2 }),
    ]));
    const [a, b, c] = def.screens[0].sections[0].children.map((n) => n.style);
    assert.deepEqual(a, { span: 6, hover: 'lift', backgroundImage: 'asset:abc_1', backgroundFit: 'tile', backgroundOverlay: 'dim' });
    assert.equal(b.backgroundImage, undefined);
    assert.notEqual(b.hover, 'sparkle');
    assert.deepEqual(c, { span: 6 });
});

test('a picture under text warns until a veil is set; a picture on an image or with a veil does not', () => {
    const run = (children) => validateAppDefinition(canonicalizeAppDefinition(appWith(children)).def).warnings
        .filter((w) => w.code === 'style.image_without_overlay');
    const heading = (id, style) => node(id, 'heading', { span: 6, backgroundImage: 'asset:abc_1', ...style }, { text: 'T', level: 2 });
    const warned = run([heading('cmp_hvr0001', {})]);
    assert.equal(warned.length, 1);
    assert.match(warned[0].path, /children\[0\]\.style\.backgroundImage$/);
    assert.equal(run([heading('cmp_hvr0001', { backgroundOverlay: 'dim' })]).length, 0);
    assert.equal(run([heading('cmp_hvr0001', { backgroundOverlay: 'light' })]).length, 0);
    assert.equal(run([node('cmp_hvr0001', 'divider', { span: 6, backgroundImage: 'asset:abc_1' })]).length, 0);
});
