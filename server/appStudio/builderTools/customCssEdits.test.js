'use strict';

/**
 * The app's stylesheet through the builder: app_set_theme customCssEdits changes it in place,
 * a whole customCss hands the old text back as previousCustomCss, and app_get_draft
 * {section:"meta"} returns it whole while the per-turn tree only names its size.
 *
 * Run: cd server && node --test appStudio/builderTools/customCssEdits.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyCssEdits } = require('./customCssEdits.mts');
const { applyToolCall } = require('../builderTools');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { renderDraftState } = require('../builderPrompt');

const CSS = '.u-hero { color: var(--app-primary) }\n.u-quiet { opacity: 0.8 }\n.u-card-wide { padding: 24px }';

function draft(customCss = CSS) {
    const def = canonicalizeAppDefinition({
        schemaVersion: 3,
        meta: { name: 'Stylesheet' },
        design: { customCss },
        screens: [{ id: 'scr_aaa111', name: 'A', sections: [{ id: 'sec_one111', children: [{ id: 'cmp_txt111', type: 'text', props: { text: 'hi' }, cssClass: 'hero' }] }] }],
        actions: {},
    }).def;
    return { userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_test', def };
}

test('edits apply in order; a find that is missing or ambiguous refuses the whole list', () => {
    assert.deepEqual(applyCssEdits('a b c', [{ find: 'b', replace: 'B' }, { find: 'B c', replace: 'x' }]), { css: 'a x' });
    assert.match(applyCssEdits('a b c', [{ find: 'b', replace: 'B' }, { find: 'zz', replace: '' }]).error, /\[1\]\.find does not occur/);
    assert.match(applyCssEdits('a a', [{ find: 'a', replace: 'b' }]).error, /occurs more than once/);
    assert.match(applyCssEdits('', [{ find: 'a', replace: 'b' }]).error, /no stylesheet yet/);
    assert.match(applyCssEdits('a', []).error, /1-20/);
    assert.match(applyCssEdits('a', [{ find: '', replace: 'b' }]).error, /non-empty/);
});

test('app_set_theme customCssEdits changes one rule and keeps the rest', async () => {
    const wrap = draft();
    const r = await applyToolCall('app_set_theme', { customCssEdits: [{ find: 'opacity: 0.8', replace: 'opacity: 0.6' }] }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.equal(wrap.def.design.customCss, CSS.replace('opacity: 0.8', 'opacity: 0.6'));
    assert.equal(r.previousCustomCss, undefined);
});

test('a refused edit changes nothing; customCss and customCssEdits together are refused', async () => {
    const wrap = draft();
    const before = JSON.stringify(wrap.def);
    const r = await applyToolCall('app_set_theme', { customCssEdits: [{ find: '.u-missing', replace: '' }] }, wrap);
    assert.match(r.error, /does not occur/);
    assert.match(r._fixHint, /app_get_draft \{section:"meta"\}/);
    const both = await applyToolCall('app_set_theme', { customCss: '.a{}', customCssEdits: [{ find: 'x', replace: 'y' }] }, wrap);
    assert.match(both.error, /not both/);
    assert.equal(JSON.stringify(wrap.def), before);
});

test('a whole new stylesheet hands the old one back', async () => {
    const wrap = draft();
    const r = await applyToolCall('app_set_theme', { customCss: '.u-hero { color: red }' }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.equal(r.previousCustomCss, CSS);
    const same = await applyToolCall('app_set_theme', { customCss: '.u-hero { color: red }' }, wrap);
    assert.equal(same.previousCustomCss, undefined, 'nothing was replaced');
});

test('the tree names the stylesheet by size and the cssClass of a node; the meta read returns it whole', async () => {
    const wrap = draft();
    const tree = renderDraftState(wrap.def);
    assert.ok(tree.includes(`customCss=<${CSS.length} chars; read it whole with app_get_draft {section:"meta"}>`), tree);
    assert.ok(!tree.includes('.u-quiet'), 'the stylesheet text itself stays out of the tree');
    assert.match(tree, /cmp_txt111 text .* css=\.u-hero/);
    const meta = await applyToolCall('app_get_draft', { section: 'meta' }, wrap);
    assert.equal(meta.customCss, CSS);
    const screens = await applyToolCall('app_get_draft', { section: 'screens' }, wrap);
    assert.equal(screens.customCss, undefined);
});
