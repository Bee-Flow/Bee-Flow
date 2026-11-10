// @typecheck
/**
 * Style knob group "box" (package LK2): who gets it, what the canonicalizer keeps, what the
 * validator says, and the contrast warning on a hex fill.
 * Run: node --test appStudio/componentSpecs/styleKnobGroups/box.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const specs = require('../../componentSpecs');
const box = require('./box');
const { loadKnobGroupExtensions } = require('../knobGroupExtensions');
const { canonicalizeAppDefinition } = require('../../canonicalize');
const { validateAppDefinition } = require('../../validate');
const { contrastRatio, isHexColor } = require('../../validate/boxContrast.mts');

const { COMPONENT_SPECS, STYLE_KNOBS, SECTION_STYLE_KNOBS, expandStyleKnobs, BASE_STYLE_KNOB_GROUPS } = specs;
const BOX_KNOBS = Object.keys(box.knobs);

function appWith(children, theme = { primary: '#0F766E' }) {
    return {
        schemaVersion: 2,
        meta: { name: 'Box' },
        theme,
        homeScreenId: 'scr_box001',
        screens: [{ id: 'scr_box001', name: 'Box', sections: [{ id: 'sec_box001', style: { padding: 4, gap: 3, background: 'none' }, children }] }],
    };
}
const node = (id, type, style, props = {}) => ({ id, type, props, style });
const nodesOf = (def) => def.screens[0].sections[0].children;

test('every type with span earns the group, except the ones that frame their own box', () => {
    assert.deepEqual(box.knobs.borderColor.roles, specs.COLOR_ROLES);
    for (const type of box.withheldFrom) {
        assert.ok(COMPONENT_SPECS[type], `${type} is a component type`);
        assert.ok(COMPONENT_SPECS[type].styleKnobs.includes('span'), `${type} has span, so the withholding is what keeps it out`);
        const knobs = expandStyleKnobs(COMPONENT_SPECS[type].styleKnobs, undefined, type);
        for (const k of BOX_KNOBS) assert.ok(!knobs.includes(k), `${type} does not get ${k}`);
    }
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
        if (box.withheldFrom.includes(type)) continue;
        const knobs = expandStyleKnobs(spec.styleKnobs, undefined, type);
        const has = spec.styleKnobs.includes('span');
        for (const k of BOX_KNOBS) assert.equal(knobs.includes(k), has, `${type} ${has ? 'gets' : 'does not get'} ${k}`);
    }
    for (const k of BOX_KNOBS) assert.ok(!expandStyleKnobs(SECTION_STYLE_KNOBS).includes(k), `a section does not get ${k}`);
    // No knob of the group is part of a defaultStyle, so nothing is ever filled in.
    for (const spec of Object.values(COMPONENT_SPECS)) {
        for (const k of BOX_KNOBS) assert.ok(!Object.hasOwn(spec.defaultStyle || {}, k));
    }
    for (const k of BOX_KNOBS) assert.equal(STYLE_KNOBS[k], box.knobs[k]);
});

test('withheldFrom is optional and refused when malformed', () => {
    const dirs = [];
    after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
    const ctx = { styleKnobs: { span: {} }, baseGroupNames: BASE_STYLE_KNOB_GROUPS.map((g) => g.name) };
    const load = (withheldFrom) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-box-group-'));
        dirs.push(dir);
        const body = { since: 3, grantedBy: 'span', knobs: { glow: { type: 'enum', values: ['none', 'a'], default: 'none', since: 3 } }, withheldFrom };
        fs.writeFileSync(path.join(dir, 'g.js'), `module.exports = ${JSON.stringify(body)};\n`);
        return loadKnobGroupExtensions(dir, ctx);
    };
    assert.equal(load(undefined)[0].withheldFrom, undefined);
    assert.deepEqual(load(['button'])[0].withheldFrom, ['button']);
    for (const bad of [[], 'button', [''], ['a', 'a'], [3]]) assert.throws(() => load(bad), /withheldFrom/, JSON.stringify(bad));
    // A withheld type keeps the other groups; a list without a type withholds nothing.
    const groups = [...BASE_STYLE_KNOB_GROUPS, ...load(['button'])];
    assert.deepEqual(expandStyleKnobs(['span'], groups, 'button'), ['span', 'widthMode', 'widthValue', 'hideBelow', 'hideAbove']);
    assert.deepEqual(expandStyleKnobs(['span'], groups, 'heading').slice(-1), ['glow']);
    assert.deepEqual(expandStyleKnobs(['span'], groups).slice(-1), ['glow']);
});

test('canonicalize keeps what was set, leaves the rest absent, and repairs bad values', () => {
    const set = { span: 6, marginTop: 2, marginBottom: 8, shadow: 'md', opacity: 80, borderWidth: 3, borderSides: 'left', borderColor: 'primary', backgroundColor: '#fef3c7' };
    const { def, repairs: notes } = canonicalizeAppDefinition(appWith([
        node('cmp_box001', 'heading', set, { text: 'A' }),
        node('cmp_box002', 'heading', { span: 6 }, { text: 'B' }),
        node('cmp_box003', 'button', { span: 3, shadow: 'md' }, { label: 'Go' }),
        node('cmp_box004', 'text', { span: 12, backgroundColor: null, borderColor: 'navy', opacity: 400, marginTop: -1, shadow: 'huge' }, { text: 'C' }),
    ]));
    const [a, b, c, d] = nodesOf(def);
    assert.deepEqual(a.style, set);
    assert.deepEqual(b.style, { span: 6 });
    assert.deepEqual(c.style, { span: 3 });
    assert.ok(notes.some((n) => n.code === 'style.unknown_key' && n.path.endsWith('children[2].style')));
    // null and an unusable colour are "not set" for these colour knobs (nothing is written);
    // out-of-range numbers clamp; an unknown enum resets.
    assert.deepEqual(d.style, { span: 12, opacity: 100, marginTop: 0, shadow: 'none' });
    assert.ok(notes.some((n) => n.code === 'style.invalid' && n.path.endsWith('children[3].style.borderColor')));
    assert.equal(def.schemaVersion, 3);

    const plain = canonicalizeAppDefinition(appWith([node('cmp_box005', 'heading', { span: 6 }, { text: 'A' })])).def;
    assert.equal(plain.schemaVersion, 2, 'a definition that sets none of them keeps its version');
});

test('validate refuses a box knob on a withheld type and a value out of range', () => {
    const { errors } = validateAppDefinition(appWith([
        node('cmp_box001', 'button', { span: 3, borderWidth: 2 }, { label: 'Go', variant: 'primary', iconLeft: null, role: 'button', disabledWhen: null }),
        node('cmp_box002', 'heading', { span: 6, borderWidth: 9, borderSides: 'diagonal', backgroundColor: 'red' }, { text: 'A', level: 2, accent: 'none' }),
    ]));
    const at = (p) => errors.filter((e) => e.path.endsWith(p)).map((e) => e.code);
    assert.deepEqual(at('children[0].style.borderWidth'), ['style.unknown_key']);
    assert.deepEqual(at('children[1].style.borderWidth'), ['style.invalid']);
    assert.deepEqual(at('children[1].style.borderSides'), ['style.invalid']);
    assert.deepEqual(at('children[1].style.backgroundColor'), ['style.invalid']);
});

test('a hex fill warns when the text on it would be hard to read', () => {
    assert.ok(isHexColor('#A0b1C2') && !isHexColor('#abc') && !isHexColor('primary'));
    assert.equal(contrastRatio('#000000', '#ffffff').toFixed(1), '21.0');
    const warnings = (children, theme) => validateAppDefinition(canonicalizeAppDefinition(appWith(children, theme)).def).warnings
        .filter((w) => w.code === 'style.low_contrast').map((w) => w.path.replace(/^screens\[0\]\.sections\[0\]\./, ''));
    const heading = (id, style) => node(id, 'heading', { span: 6, ...style }, { text: 'A' });

    // appearance auto: white carries the dark theme's light text, near-black the light theme's dark text.
    assert.deepEqual(warnings([heading('cmp_box001', { backgroundColor: '#ffffff' })]), ['children[0].style.backgroundColor']);
    assert.deepEqual(warnings([heading('cmp_box001', { backgroundColor: '#111111' })]), ['children[0].style.backgroundColor']);
    // A fixed appearance is computable on one side only.
    assert.deepEqual(warnings([heading('cmp_box001', { backgroundColor: '#ffffff' })], { primary: '#0F766E', appearance: 'light' }), []);
    assert.deepEqual(warnings([heading('cmp_box001', { backgroundColor: '#ffffff' })], { primary: '#0F766E', appearance: 'dark' }), ['children[0].style.backgroundColor']);
    // The node's own text colour decides when it is set.
    assert.deepEqual(warnings([heading('cmp_box001', { backgroundColor: '#1e3a8a', color: '#ffffff' })]), []);
    assert.deepEqual(warnings([heading('cmp_box001', { backgroundColor: '#fde68a', color: 'warning' })]), ['children[0].style.backgroundColor']);
    // A role fill follows the theme, a picture carries no text, a filled card look hides the knob.
    assert.deepEqual(warnings([heading('cmp_box001', { backgroundColor: 'warning' })]), []);
    assert.deepEqual(warnings([node('cmp_box002', 'image', { span: 6, backgroundColor: '#ffffff' }, { src: 'https://example.com/a.png' })]), []);
    assert.deepEqual(warnings([node('cmp_box003', 'card', { span: 6, backgroundColor: '#ffffff' }, { look: 'solid' })]), []);
    // Nested: the path names the child.
    const card = { ...node('cmp_box004', 'card', { span: 6 }), children: [heading('cmp_box005', { backgroundColor: '#ffffff' })] };
    assert.deepEqual(warnings([card]), ['children[0].children[0].style.backgroundColor']);
});
