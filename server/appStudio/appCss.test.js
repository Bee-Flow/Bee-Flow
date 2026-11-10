'use strict';

/**
 * The app's own stylesheet (design.customCss) and a node's cssClass: the sanitiser, how the
 * canonicalizer and the validator treat both keys, and that an app without them is untouched.
 * The vectors in appCss.vectors.json are also run by the client half
 * (agent-hub …/runtime/appCss.test.ts).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeAppCss, cleanAppCss, wrapAppCss, cssAssetIds, isCssClassName, APP_CSS_MAX_CHARS, APP_CSS_ROOT_ATTR } = require('./appCss.mts');
const { sanitizeFormCss } = require('../core/forms/formCss.mts');
const { vectors } = require('./appCss.vectors.json');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { collectAssetRefs } = require('./appAssets.mts');
const { DESIGN_SPEC, LIMITS, emptyDefinition } = require('./componentSpecs');
const { KEY_MARKS } = require('./componentSpecs/keyMarks');
const { buildPublicDefinition, resolvePublicSurface } = require('./publicAccess');

const sorted = (list) => [...list].sort();

function app(design, nodeKeys = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'Styled' },
        ...(design ? { design } : {}),
        screens: [{ id: 'scr_home', name: 'Home', sections: [{ id: 'sec_main', children: [{ id: 'cmp_title', type: 'heading', props: { text: 'Hello' }, ...nodeKeys }] }] }],
    };
}

const canon = (def) => canonicalizeAppDefinition(structuredClone(def));
const errorsOf = (def) => validateAppDefinition(def).errors.map((e) => `${e.code} @ ${e.path}`);

for (const vector of vectors) {
    test(`sanitizeAppCss: ${vector.name}`, () => {
        const { css, removed } = sanitizeAppCss(vector.css);
        assert.deepEqual(sorted(removed), sorted(vector.removed));
        for (const kept of vector.keeps) assert.ok(css.includes(kept), `keeps ${kept}: ${css}`);
        for (const gone of vector.drops) assert.ok(!css.includes(gone), `drops ${gone}: ${css}`);
        // What is stored is a fixed point: saving it again changes nothing and reports nothing.
        assert.deepEqual(sanitizeAppCss(css), { css, removed: [] });
    });
}

test('an app is stricter than a form about addresses on this server', () => {
    const css = '.a{background:url(/api/users/me)}';
    assert.deepEqual(sanitizeFormCss(css), { css, removed: [] });
    assert.deepEqual(sanitizeAppCss(css), { css: '.a{}', removed: ['outside address'] });
    // A form has no assets; an app reads its own.
    assert.deepEqual(sanitizeFormCss('.a{background:url(asset:abc)}').removed, ['outside address']);
    assert.deepEqual(sanitizeAppCss('.a{background:url(asset:abc)}').removed, []);
});

test('nothing but text of at most the limit is a stylesheet', () => {
    assert.equal(APP_CSS_MAX_CHARS, LIMITS.MAX_CUSTOM_CSS_LEN);
    for (const value of [undefined, null, 7, {}, []]) assert.deepEqual(sanitizeAppCss(value), { css: '', removed: [] });
    const long = `.a{color:red}${' '.repeat(APP_CSS_MAX_CHARS)}`;
    assert.deepEqual(sanitizeAppCss(long), { css: '', removed: [`over ${APP_CSS_MAX_CHARS} characters`] });
    assert.equal(cleanAppCss('  .a { color: red; }  '), '.a { color: red; }');
});

test('wrapAppCss scopes the text to the app root and leaves empty text empty', () => {
    assert.equal(APP_CSS_ROOT_ATTR, 'data-app-css-root');
    assert.equal(wrapAppCss('.a{color:red}'), '@scope ([data-app-css-root]) {\n.a{color:red}\n}');
    assert.equal(wrapAppCss('  '), '');
    // The author cannot open a scope of their own or close this one.
    const hostile = sanitizeAppCss('} @scope (body) { nav { color: red } } .a { color: blue }').css;
    assert.ok(!hostile.includes('@scope') && !hostile.trimStart().startsWith('}'), hostile);
});

test('cssAssetIds reads every asset the text names', () => {
    assert.deepEqual(cssAssetIds('.a{background:url(asset:abc)} .b{background:url("asset:d-e_1")}'), ['abc', 'd-e_1']);
    assert.deepEqual(cssAssetIds('.a{color:red} asset:'), []);
    assert.deepEqual(cssAssetIds(null), []);
    assert.equal(cssAssetIds(`url(asset:${'a'.repeat(80)})`)[0].length, 64);
});

test('isCssClassName', () => {
    for (const ok of ['a', 'hero', 'hero-2', 'a'.repeat(LIMITS.MAX_CSS_CLASS_LEN)]) assert.equal(isCssClassName(ok), true, ok);
    for (const bad of ['', 'Hero', '2col', '-x', 'a b', 'a_b', 'a.b', 'é', 'a'.repeat(LIMITS.MAX_CSS_CLASS_LEN + 1), null, 3]) assert.equal(isCssClassName(bad), false, String(bad));
});

test('the design key and the node key are marked, optional and described', () => {
    const key = DESIGN_SPEC.customCss;
    assert.equal(key.since, 3);
    assert.equal(key.optional, true);
    assert.equal(key.type, 'css');
    assert.equal(key.maxLen, LIMITS.MAX_CUSTOM_CSS_LEN);
    for (const word of ['data-app-screen', 'data-section-id', 'data-node-id', 'data-app-type', '.u-<name>', 'bfa-<type>__<part>', 'data-app-dark', 'high-contrast', 'asset:<id>', 'app_set_theme']) {
        assert.ok(key.description.includes(word), `the description names ${word}`);
    }
    assert.equal(KEY_MARKS.node.cssClass.since, 3);
});

test('an app without a stylesheet or a class keeps its bytes and its schema version', () => {
    const plain = canon(app({ font: 'inter' }));
    assert.equal(plain.def.schemaVersion, 2);
    assert.equal('customCss' in plain.def.design, false);
    assert.equal('cssClass' in plain.def.screens[0].sections[0].children[0], false);
    // null and empty text are "not set": no key, no repair, the same bytes.
    for (const empty of [null, '', '   ']) {
        const again = canon(app({ font: 'inter', customCss: empty }, { cssClass: empty === '   ' ? '' : empty }));
        assert.equal(JSON.stringify(again.def), JSON.stringify(plain.def), JSON.stringify(empty));
        assert.deepEqual(again.repairs.filter((r) => r.path.includes('ustomCss') || r.path.includes('cssClass')), []);
    }
    assert.equal(canon(app(null)).def.design, undefined);
});

test('canonicalize stores the stylesheet sanitised and says what it took out', () => {
    const { def, repairs } = canon(app({ customCss: '@import "x"; .u-hero { color: red; position: fixed; background: url(asset:abc) }' }, { cssClass: 'hero' }));
    assert.equal(def.schemaVersion, 3);
    assert.equal(def.design.customCss, '.u-hero { color: red; background: url(asset:abc) }');
    assert.equal(def.screens[0].sections[0].children[0].cssClass, 'hero');
    const note = repairs.find((r) => r.code === 'design.value_cleaned');
    assert.equal(note.path, 'design.customCss');
    assert.match(note.message, /@import/);
    assert.match(note.message, /position: fixed/);
    // A second pass is silent and byte-equal; the validator accepts the stored form.
    const again = canon(def);
    assert.equal(JSON.stringify(again.def), JSON.stringify(def));
    assert.deepEqual(again.repairs, []);
    assert.deepEqual(errorsOf(def), []);
});

test('a stylesheet with nothing left, or over the limit, leaves no key', () => {
    const emptied = canon(app({ customCss: '@import "x";' }));
    assert.equal('customCss' in emptied.def.design, false);
    assert.ok(emptied.repairs.some((r) => r.code === 'design.value_invalid' && r.path === 'design.customCss' && r.message.includes('@import')));
    const long = canon(app({ customCss: `.a{color:red}${' '.repeat(LIMITS.MAX_CUSTOM_CSS_LEN)}` }));
    assert.equal('customCss' in long.def.design, false);
    assert.ok(long.repairs.some((r) => r.code === 'design.value_invalid' && r.path === 'design.customCss'));
});

test('an invalid class name is dropped with a repair', () => {
    const { def, repairs } = canon(app(null, { cssClass: 'Hero Banner' }));
    assert.equal('cssClass' in def.screens[0].sections[0].children[0], false);
    assert.ok(repairs.some((r) => r.code === 'node.css_class_invalid'));
    assert.equal(def.schemaVersion, 2);
});

test('the validator refuses bytes the canonicalizer would have changed', () => {
    const { def } = canon(app({ customCss: '.a{color:red}' }, { cssClass: 'hero' }));
    const tampered = structuredClone(def);
    tampered.design.customCss = '.a{background:url(/api/users/me)}';
    tampered.screens[0].sections[0].children[0].cssClass = 'Hero';
    assert.deepEqual(errorsOf(tampered), ['design.value_invalid @ design.customCss', 'node.css_class_invalid @ screens[0].sections[0].children[0].cssClass']);
});

test('the public page takes its own stylesheet through the look override', () => {
    const withPublic = (css) => ({
        ...app({ customCss: '.a{color:red}' }),
        publicAccess: { enabled: true, entryScreenId: 'scr_home', screenIds: ['scr_home'], design: { customCss: css } },
    });
    const { def } = canon(withPublic('.a{color:blue;background:url(asset:pub1)}'));
    assert.equal(def.publicAccess.design.customCss, '.a{color:blue;background:url(asset:pub1)}');
    assert.deepEqual(errorsOf(def), []);
    const served = buildPublicDefinition(def, resolvePublicSurface(def));
    assert.equal(served.design.customCss, '.a{color:blue;background:url(asset:pub1)}');
    // The public asset route serves what the served definition names, the stylesheet included.
    assert.deepEqual([...collectAssetRefs(served).keys()], ['pub1']);
    // Text that is not in its stored form is not taken over, and the validator says so for direct bytes.
    const refused = canon(withPublic('.a{position:fixed}'));
    assert.equal(refused.def.publicAccess.design, undefined);
    const tampered = structuredClone(def);
    tampered.publicAccess.design.customCss = '.a{position:fixed}';
    assert.deepEqual(errorsOf(tampered), ['publicAccess.design_value_invalid @ publicAccess.design.customCss']);
});

test('collectAssetRefs finds the assets a stylesheet names, beside the plain references', () => {
    const def = { design: { logoUrl: 'asset:logo1', customCss: '.a{background:url(asset:bg1)} .b{background:url(asset:logo1)}' } };
    const refs = collectAssetRefs(def);
    assert.deepEqual([...refs.keys()].sort(), ['bg1', 'logo1']);
    assert.deepEqual(refs.get('bg1'), ['design.customCss']);
    assert.deepEqual(refs.get('logo1'), ['design.logoUrl', 'design.customCss']);
});

test('app_set_theme writes the stylesheet and reports what was removed', async () => {
    const { applyToolCall } = require('./builderTools');
    const wrap = { def: emptyDefinition('Styled') };
    const set = await applyToolCall('app_set_theme', { customCss: '@import "x"; .u-a { color: red }' }, wrap);
    assert.equal(set.design.customCss, '.u-a { color: red }');
    assert.ok(set._hints.some((hint) => hint.includes('@import')), JSON.stringify(set._hints));
    assert.equal(wrap.def.schemaVersion, 3);
    const cleared = await applyToolCall('app_set_theme', { customCss: null }, wrap);
    assert.equal('customCss' in cleared.design, false);
});

/**
 * The scope, in a real browser. Skipped unless APP_CSS_TEST_CHROME names a Chrome or
 * Chromium binary (there is none in CI): `APP_CSS_TEST_CHROME=/path/to/chrome node --test
 * appStudio/appCss.test.js`. Each selector is written to reach an element OUTSIDE the root.
 */
const chrome = process.env.APP_CSS_TEST_CHROME;
// Run in the page, so they are handed over as text.
const OUTSIDE_COLOURS = "['before', 'after'].map((id) => getComputedStyle(document.getElementById(id)).color).concat(getComputedStyle(document.body).color, getComputedStyle(document.documentElement).color)";
const INSIDE_OUTSIDE_COLOURS = "['inside', 'outside'].map((id) => getComputedStyle(document.getElementById(id)).color)";
test('in a browser, no selector reaches outside the scope root', { skip: chrome ? false : 'set APP_CSS_TEST_CHROME to run' }, async () => {
    const { chromium } = require('playwright-core');
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
        const page = await browser.newPage();
        const red = 'rgb(255, 0, 0)';
        const reaching = [
            'body:has(&) nav', ':root:has(&)', ':root:has(&) nav', 'html nav', ':is(body:has(&)) nav', ':is(&, nav)',
            'body:has(:scope) nav', ':scope ~ nav', '& ~ nav', '& + nav', 'nav', ':root', 'body', '*',
        ];
        for (const selector of reaching) {
            const css = wrapAppCss(sanitizeAppCss(`${selector} { color: ${red} !important; }`).css);
            await page.setContent(`<html><head><style>${css}</style></head><body><nav id="before">x</nav><div ${APP_CSS_ROOT_ATTR}><p id="inside">x</p></div><nav id="after">x</nav></body></html>`);
            const colours = await page.evaluate(OUTSIDE_COLOURS);
            assert.ok(!colours.includes(red), `${selector} coloured something outside the root`);
        }
        // And a rule for something inside does apply.
        await page.setContent(`<html><head><style>${wrapAppCss('p { color: rgb(255, 0, 0); }')}</style></head><body><div ${APP_CSS_ROOT_ATTR}><p id="inside">x</p></div><p id="outside">x</p></body></html>`);
        assert.deepEqual(await page.evaluate(INSIDE_OUTSIDE_COLOURS), [red, 'rgb(0, 0, 0)']);
    } finally {
        await browser.close();
    }
});
