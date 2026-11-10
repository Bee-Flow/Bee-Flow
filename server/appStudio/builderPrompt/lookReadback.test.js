/**
 * The look read-back in the per-turn draft message (lookReadback.mts, wired into
 * builderPrompt.renderDraftState). Everything is emit-when-non-default: a draft holding
 * only defaults renders exactly as before, and an authored look shows up compactly.
 *
 * Run: node --test appStudio/builderPrompt/lookReadback.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderDraftState } = require('../builderPrompt');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { emptyDefinition } = require('../componentSpecs');
const { nodeLookBits, sectionLookSuffix, themeLookSuffix, designLine, lookValue } = require('./lookReadback.mts');

function draft({ theme = {}, design, sectionStyle = {}, children }) {
    const raw = {
        meta: { name: 'Look app' }, homeScreenId: 'scr_look01', theme,
        screens: [{ id: 'scr_look01', name: 'Home', sections: [{ id: 'sec_look01', style: sectionStyle, children }] }],
        actions: {},
    };
    if (design) raw.design = design;
    return canonicalizeAppDefinition(raw).def;
}

const PLAIN = [
    { id: 'cmp_head01', type: 'heading', props: { text: 'Hello' } },
    { id: 'cmp_card01', type: 'card', props: { title: 'Box' }, children: [{ id: 'cmp_text01', type: 'text', props: { text: 'Body' } }] },
    { id: 'cmp_tabs01', type: 'tabs', props: {}, children: [{ id: 'cmp_tab001', type: 'tab', props: { label: 'One' }, children: [] }] },
];

test('a draft holding only defaults renders without any look bit', () => {
    const out = renderDraftState(draft({ children: PLAIN }));
    for (const marker of ['style{', 'look=', '\ndesign ', 'accent=', 'canvas=']) {
        assert.ok(!out.includes(marker), `${marker} must not appear in:\n${out}`);
    }
    assert.ok(out.includes('theme primary=#0F766E radius=md density=comfortable fontScale=md appearance=auto | home=scr_look01'), out);
    assert.ok(out.includes('  section sec_look01 (padding=4 gap=3 bg=none)\n'), out);
    assert.ok(!renderDraftState(emptyDefinition('x')).includes('style{'));
});

test('a component line names its look and the knobs off the type default', () => {
    const def = draft({
        children: [
            { id: 'cmp_head01', type: 'heading', props: { text: 'Hello' }, style: { align: 'center', color: 'primary' } },
            { id: 'cmp_tabs01', type: 'tabs', props: { look: 'pills' }, style: { gap: 2 }, children: [] },
            // card's defaultStyle has padding 3 and background surface: those are not news.
            { id: 'cmp_card01', type: 'card', props: { title: 'Box' }, style: { padding: 3, background: 'surface', border: 'subtle' } },
        ],
    });
    const out = renderDraftState(def);
    assert.match(out, /cmp_head01 heading text="Hello" span=12 style\{align=center,color=primary\}/);
    assert.match(out, /cmp_tabs01 tabs span=12 look=pills style\{gap=2\}/);
    assert.match(out, /cmp_card01 card title="Box" span=6 style\{border=subtle\}/);
});

test('a look prop on its default and a knob on its default stay silent', () => {
    assert.deepEqual(nodeLookBits({ type: 'tabs', props: { look: 'underline' }, style: { span: 12, gap: 3, padding: 0 } }), []);
    assert.deepEqual(nodeLookBits({ type: 'kanban', props: { cardLook: 'tinted' }, style: {} }), ['cardLook=tinted']);
    // An unknown type still reports what it carries against the knob defaults.
    assert.deepEqual(nodeLookBits({ type: 'zz_unknown', props: {}, style: { size: 'md', border: 'default' } }), ['style{border=default}']);
});

test('the section line adds the knobs it did not already show', () => {
    const out = renderDraftState(draft({ sectionStyle: { height: 'fill' }, children: PLAIN }));
    assert.ok(out.includes('  section sec_look01 (padding=4 gap=3 bg=none) style{height=fill}\n'), out);
    assert.equal(sectionLookSuffix({ padding: 2, gap: 1, background: 'tint' }), '', 'padding/gap/bg are on the line already');
});

test('the theme line carries accent and canvas when they are set', () => {
    const out = renderDraftState(draft({ theme: { accent: '#B45309', canvas: '#F5F5F4' }, children: PLAIN }));
    assert.ok(out.includes('appearance=auto accent=#B45309 canvas=#F5F5F4 | home=scr_look01'), out);
    assert.equal(themeLookSuffix({ accent: null }), '');
});

test('one design line lists the keys off their default, right under the theme line', () => {
    const def = draft({ design: { preset: 'custom', font: 'inter', surface: 'soft', motion: 'subtle' }, children: PLAIN });
    const lines = renderDraftState(def).split('\n');
    assert.equal(lines[2], 'design font=inter surface=soft');
    assert.equal(designLine({ preset: 'custom', motion: 'subtle' }), null);
    assert.equal(designLine(undefined), null);
});

test('a long or odd value is quoted and cut, so one value never floods the line', () => {
    assert.equal(lookValue('lg'), 'lg');
    assert.equal(lookValue(4), '4');
    assert.equal(lookValue('two words'), '"two words"');
    const long = lookValue('x'.repeat(200));
    assert.ok(long.length < 50 && long.endsWith('…"'), long);
    assert.equal(lookValue({ a: 1 }), '"{\\"a\\":1}"');
    const asset = 'asset:0b6f2c1e-4a8d-4e1f-9c3b-1d2e3f4a5b6c';
    assert.equal(lookValue(asset), asset, 'an asset ref stays whole, so the builder can reuse it');
});
