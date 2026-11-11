// @typecheck
/**
 * Packages LK22 and LK19: rich markdown, the expressive motion value, component variants and
 * the text knobs inside components. What each one costs an existing definition (nothing: the
 * schema version and the bytes stay), what a definition that uses it is stamped with, how the
 * text knob group reaches the types it is granted to, and which assets a rich markdown block uses.
 * Run: node --test appStudio/richVariantsMotion.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('./componentSpecs');
const textGroup = require('./componentSpecs/styleKnobGroups/text');
const { loadKnobGroupExtensions } = require('./componentSpecs/knobGroupExtensions');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');

const { COMPONENT_SPECS, STYLE_KNOBS, SECTION_STYLE_KNOBS, expandStyleKnobs, DESIGN_SPEC } = specs;

function appWith(children, design) {
    return {
        schemaVersion: 2,
        meta: { name: 'Rich' },
        theme: { primary: '#0F766E' },
        ...(design ? { design } : {}),
        homeScreenId: 'scr_rvm0001',
        screens: [{ id: 'scr_rvm0001', name: 'Rich', sections: [{ id: 'sec_rvm0001', style: { padding: 4, gap: 3, background: 'none' }, children }] }],
    };
}
const node = (id, type, props, style = { span: 12 }) => ({ id, type, props, style });

async function versionOf(definition) {
    const { requiredSchemaVersion } = await import('./schemaSince.mts');
    return requiredSchemaVersion(canonicalizeAppDefinition(definition).def);
}

test('a definition that uses none of it keeps schema version 2 and gains no key', async () => {
    const children = [
        node('cmp_rvm0001', 'markdown', { content: '| a |\n| - |\n| 1 |' }),
        node('cmp_rvm0002', 'button', { label: 'Go', variant: 'outline' }),
        node('cmp_rvm0003', 'card', { title: 'T' }),
        node('cmp_rvm0004', 'callout', { text: 'Note' }),
    ];
    const def = appWith(children, { preset: 'custom', font: 'system', surface: 'hairline', motion: 'full', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null });
    const { def: canon } = canonicalizeAppDefinition(def);
    assert.equal(await versionOf(def), 2);
    const [md, , card, callout] = canon.screens[0].sections[0].children;
    assert.equal(Object.hasOwn(md.props, 'rich'), false);
    assert.equal(Object.hasOwn(card.props, 'variant'), false);
    assert.equal(Object.hasOwn(callout.props, 'variant'), false);
    assert.equal(canon.design.motion, 'full');
});

test('each new word stamps schema version 3, and only it', async () => {
    const one = (child, design) => versionOf(appWith([child], design));
    assert.equal(await one(node('cmp_rvm0001', 'markdown', { content: 'x', rich: true })), 3);
    assert.equal(await one(node('cmp_rvm0002', 'button', { label: 'Go', variant: 'link' })), 3);
    assert.equal(await one(node('cmp_rvm0003', 'card', { title: 'T', variant: 'elevated' })), 3);
    assert.equal(await one(node('cmp_rvm0004', 'callout', { text: 'Note', variant: 'solid' })), 3);
    assert.equal(await one(node('cmp_rvm0005', 'heading', { text: 'H', level: 2 }), { motion: 'expressive' }), 3);
    assert.equal(await one(node('cmp_rvm0006', 'button', { label: 'Go' }, { span: 3, textSize: 'lg' })), 3);
});

test('the variant values and the motion value are what the runtime draws', () => {
    assert.deepEqual(COMPONENT_SPECS.card.props.variant.values, ['plain', 'outlined', 'elevated']);
    assert.deepEqual(COMPONENT_SPECS.callout.props.variant.values, ['soft', 'outline', 'solid']);
    assert.deepEqual(COMPONENT_SPECS.button.props.variant.values.slice(-2), ['soft', 'link']);
    assert.deepEqual(COMPONENT_SPECS.button.props.variant.valuesSince, { link: 3 });
    assert.deepEqual(DESIGN_SPEC.motion.values, ['none', 'subtle', 'full', 'expressive']);
    assert.deepEqual(DESIGN_SPEC.motion.valuesSince, { expressive: 3 });
});

test('canonicalize keeps the new values and the validator refuses one outside the vocabulary', () => {
    const { def } = canonicalizeAppDefinition(appWith([
        node('cmp_rvm0001', 'card', { title: 'A', variant: 'outlined' }),
        node('cmp_rvm0002', 'card', { title: 'B', variant: 'glass' }),
        node('cmp_rvm0003', 'markdown', { content: 'x', rich: true }),
    ], { motion: 'expressive' }));
    const [a, b, c] = def.screens[0].sections[0].children;
    assert.equal(a.props.variant, 'outlined');
    assert.equal(c.props.rich, true);
    assert.equal(def.design.motion, 'expressive');
    const errors = validateAppDefinition(def).errors.map((e) => e.path);
    assert.deepEqual(errors, [`screens[0].sections[0].children[1].props.variant`]);
    assert.equal(b.props.variant, 'glass');
});

test('a definition with rich markdown and variants validates without errors', () => {
    const { def } = canonicalizeAppDefinition(appWith([
        node('cmp_rvm0001', 'markdown', { content: '| a |\n| - |\n| 1 |', rich: true }),
        node('cmp_rvm0002', 'callout', { text: 'Note', variant: 'outline' }),
        node('cmp_rvm0003', 'button', { label: 'Go', variant: 'link' }),
    ], { motion: 'expressive' }));
    assert.deepEqual(validateAppDefinition(def).errors, []);
});

// ── the text knob group reaches the types it is granted to ──────────────────

test('the text knobs reach the granted types and no other type that lacks colour', () => {
    const knobs = Object.keys(textGroup.knobs);
    for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
        const expanded = expandStyleKnobs(spec.styleKnobs, undefined, type);
        const earns = spec.styleKnobs.includes('color') || textGroup.grantedTo.includes(type);
        for (const k of knobs) assert.equal(expanded.includes(k), earns, `${type} ${k}`);
    }
    for (const type of textGroup.grantedTo) assert.ok(COMPONENT_SPECS[type], `${type} is a component type`);
    for (const k of knobs) {
        assert.ok(STYLE_KNOBS[k]);
        assert.ok(!expandStyleKnobs(SECTION_STYLE_KNOBS).includes(k), `a section does not get ${k}`);
    }
});

test('without a type nothing is added by name, and the base lists are untouched', () => {
    assert.equal(expandStyleKnobs(COMPONENT_SPECS.button.styleKnobs).includes('textSize'), false);
    assert.deepEqual(COMPONENT_SPECS.button.styleKnobs, ['span', 'size', 'align']);
});

test('canonicalize keeps a text knob on a granted type and still drops it elsewhere', () => {
    const { def } = canonicalizeAppDefinition(appWith([
        node('cmp_rvm0001', 'button', { label: 'Go' }, { span: 3, textSize: 'lg', tracking: 'wide', transform: 'uppercase', font: 'mono' }),
        node('cmp_rvm0002', 'divider', {}, { span: 12, textSize: 'lg' }),
    ]));
    const [button, divider] = def.screens[0].sections[0].children;
    assert.deepEqual(button.style, { span: 3, textSize: 'lg', tracking: 'wide', transform: 'uppercase', font: 'mono' });
    assert.equal(divider.style.textSize, undefined);
});

test('a group file may name types it is granted to, and refuses a list that is not names', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const ctx = { styleKnobs: { span: {} }, baseGroupNames: [] };
    const load = (grantedTo) => {
        // A directory of its own per list, so no module is ever loaded twice.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knobgroups-'));
        try {
            fs.writeFileSync(path.join(dir, 'tone.js'), `module.exports = { since: 3, grantedBy: 'span', grantedTo: ${grantedTo}, knobs: { zzTone: { type: 'enum', values: ['a', 'b'], default: 'a', since: 3 } } };`);
            return loadKnobGroupExtensions(dir, ctx);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
    assert.deepEqual(load("['button', 'card']")[0].grantedTo, ['button', 'card']);
    for (const bad of ['[]', "['button', 'button']", '[1]', "'button'"]) {
        assert.throws(() => load(bad), /grantedTo lists distinct component type names/, bad);
    }
});

// ── the pictures a rich markdown block draws ────────────────────────────────

test('markdownAssetRefs reads the pictures the web draws, and nothing else', async () => {
    const { markdownAssetRefs } = await import('./markdownAssets.mts');
    assert.deepEqual(markdownAssetRefs('![a](asset:one) text ![b]( asset:two_2-x ) ![c](asset:one)'), ['one', 'two_2-x', 'one']);
    assert.deepEqual(markdownAssetRefs('[a](asset:one) ![b](https://x/y.png) ![c](asset:) ![d](asset:a b) ![e](asset:../x)'), []);
    assert.deepEqual(markdownAssetRefs('![a](asset:' + 'x'.repeat(65) + ')'), []);
    assert.deepEqual(markdownAssetRefs('![unclosed](asset:one'), []);
    assert.deepEqual(markdownAssetRefs(null), []);
    assert.deepEqual(markdownAssetRefs('![](asset:no_alt)'), ['no_alt']);
});

test('collectAssetRefs counts a picture of a rich markdown block, and of no other text', async () => {
    const { collectAssetRefs } = await import('./appAssets.mts');
    const text = 'see ![Team](asset:img_team)';
    const refs = (children) => collectAssetRefs(appWith(children));
    assert.deepEqual([...refs([node('cmp_rvm0001', 'markdown', { content: text, rich: true })]).keys()], ['img_team']);
    assert.deepEqual(refs([node('cmp_rvm0001', 'markdown', { content: text, rich: true })]).get('img_team'), ['screens[0].sections[0].children[0].props.content']);
    // Not rich, another prop and another type: the text is only text, and the version does not move.
    assert.equal(refs([node('cmp_rvm0001', 'markdown', { content: text })]).size, 0);
    assert.equal(refs([node('cmp_rvm0001', 'markdown', { content: text, rich: false })]).size, 0);
    assert.equal(refs([node('cmp_rvm0001', 'text', { text })]).size, 0);
    assert.equal(refs([node('cmp_rvm0001', 'markdown', { content: 'x', contentFrom: { kind: 'static', value: text }, rich: true })]).size, 0);
});

test('a definition whose only asset use is in rich markdown is version 3, one with the same text unrich is not', async () => {
    const text = 'see ![Team](asset:img_team)';
    assert.equal(await versionOf(appWith([node('cmp_rvm0001', 'markdown', { content: text })])), 2);
    assert.equal(await versionOf(appWith([node('cmp_rvm0001', 'markdown', { content: text, rich: true })])), 3);
});
