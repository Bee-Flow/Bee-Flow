'use strict';

// Theme scope and tokens (package LK16): screen.theme and section.theme are partial themes kept
// only when they name a usable key, design.tokens / radiusPx / dark are optional design keys, a
// token:<name> colour raises the schema version, the validator warns where an override makes text
// unreadable or a token is unknown, and the builder tools take all of them.

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const { emptyDefinition } = require('../componentSpecs');
const { requiredSchemaVersion } = require('../schemaSince.mts');
const { applyToolCall } = require('../builderTools');

const canon = (def) => canonicalizeAppDefinition(def).def;
const warningCodes = (def) => validateAppDefinition(def).warnings.map((w) => `${w.code} @ ${w.path}`);

function app(edit) {
    const def = emptyDefinition('Scope');
    def.screens[0].sections[0].children.push({ id: 'cmp_scope001', type: 'heading', props: { text: 'Hi' }, style: { span: 12 } });
    edit(def);
    return def;
}

test('an app without the keys keeps its bytes and the base version', () => {
    const def = app(() => {});
    const out = canon(def);
    assert.ok(!('theme' in out.screens[0]) && !('theme' in out.screens[0].sections[0]));
    assert.equal(out.schemaVersion, def.schemaVersion);
});

test('screen and section themes keep their legal keys in theme order; a section takes no canvas', () => {
    const out = canonicalizeAppDefinition(app((d) => {
        d.screens[0].theme = { appearance: 'dark', primary: '#38BDF8', canvas: '#0F172A', bogus: 1, radius: 'huge' };
        d.screens[0].sections[0].theme = { density: 'compact', canvas: '#000000' };
    }));
    assert.deepEqual(out.def.screens[0].theme, { primary: '#38BDF8', canvas: '#0F172A', appearance: 'dark' });
    assert.deepEqual(out.def.screens[0].sections[0].theme, { density: 'compact' });
    assert.equal(out.def.schemaVersion, 3);
    const codes = out.repairs.map((r) => r.code);
    assert.ok(codes.includes('theme_override.unknown_key') && codes.includes('theme_override.value_invalid'));
    assert.equal(JSON.stringify(canon(out.def)), JSON.stringify(out.def), 'a second pass changes nothing');
    const empty = canon(app((d) => { d.screens[0].theme = { bogus: 1 }; d.screens[0].sections[0].theme = {}; }));
    assert.ok(!('theme' in empty.screens[0]) && !('theme' in empty.screens[0].sections[0]));
});

test('design tokens, radiusPx and dark are kept only when usable, and token colours raise the version', () => {
    const out = canon(app((d) => {
        d.design = { tokens: { brand: '#e0f2fe', gap: 12, Bad: '#fff' }, radiusPx: 40, dark: { primary: '#5eead4', junk: 1 } };
        d.screens[0].sections[0].children[0].style.color = 'token:brand';
    }));
    assert.deepEqual(out.design.tokens, { brand: '#e0f2fe', gap: 12 });
    assert.equal(out.design.radiusPx, 32);
    assert.deepEqual(out.design.dark, { primary: '#5eead4' });
    assert.equal(out.screens[0].sections[0].children[0].style.color, 'token:brand');
    const bare = app((d) => { d.schemaVersion = 2; d.screens[0].sections[0].children[0].style.color = 'token:brand'; });
    assert.equal(requiredSchemaVersion(bare), 3, 'a token colour alone needs schema 3');
    assert.equal(requiredSchemaVersion(app(() => {})), 2);
});

test('the validator warns for an unreadable canvas, an unknown token and a refused override', () => {
    const def = canon(app((d) => {
        d.screens[0].theme = { appearance: 'dark', canvas: '#ffffff' };
        d.design = { dark: { canvas: '#fafafa' } };
        d.screens[0].sections[0].children[0].style.color = 'token:missing';
    }));
    assert.deepEqual(warningCodes(def).filter((c) => c.startsWith('theme_override') || c.startsWith('style.token')), [
        'theme_override.low_contrast @ screens[0].theme.canvas',
        'style.token_unknown @ screens[0].sections[0].children[0].style.color',
        'theme_override.low_contrast @ design.dark.canvas',
    ]);
    def.screens[0].sections[0].theme = { canvas: '#000000' };
    assert.ok(validateAppDefinition(def).errors.some((e) => e.code === 'theme_override.invalid'));
});

test('the builder tools set the screen theme, the section theme and the design keys', async () => {
    const wrap = { def: canon(app(() => {})), dataModel: { tables: [] } };
    const screenId = wrap.def.screens[0].id;
    const sectionId = wrap.def.screens[0].sections[0].id;
    assert.ok(!(await applyToolCall('app_update_screen', { screenId, theme: { appearance: 'dark' } }, wrap)).error);
    assert.ok(!(await applyToolCall('app_update_section', { sectionId, theme: { primary: '#B45309' } }, wrap)).error);
    const set = await applyToolCall('app_set_theme', { tokens: { brand: '#e0f2fe' }, radiusPx: 6, dark: { primary: '#5eead4' } }, wrap);
    assert.ok(!set.error, set.error);
    assert.deepEqual(wrap.def.screens[0].theme, { appearance: 'dark' });
    assert.deepEqual(wrap.def.screens[0].sections[0].theme, { primary: '#B45309' });
    assert.deepEqual([wrap.def.design.tokens, wrap.def.design.radiusPx, wrap.def.design.dark], [{ brand: '#e0f2fe' }, 6, { primary: '#5eead4' }]);
    await applyToolCall('app_update_screen', { screenId, theme: null }, wrap);
    assert.ok(!('theme' in wrap.def.screens[0]));
});
