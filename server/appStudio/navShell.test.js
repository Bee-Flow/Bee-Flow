'use strict';

/**
 * The shell options of definition.nav (navShell.mts): style none, a hidden header, the app's
 * own links, a footer line and the brand. What is stored, the schema version, the validator,
 * the public page and the builder tool app_set_shell.
 *
 * Run: cd server && node --test appStudio/navShell.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { cleanNavUrl, isNavItemId } = require('./navShell.mts');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { emptyDefinition } = require('./componentSpecs');
const { buildPublicDefinition, resolvePublicSurface } = require('./publicAccess');
const { collectAssetRefs } = require('./appAssets.mts');

function app(nav) {
    return {
        schemaVersion: 2,
        meta: { name: 'Desk' },
        ...(nav ? { nav } : {}),
        screens: [
            { id: 'scr_home', name: 'Home', sections: [{ id: 'sec_a', children: [] }] },
            { id: 'scr_help', name: 'Help', showInNav: false, sections: [{ id: 'sec_b', children: [] }] },
        ],
    };
}

const canon = (def) => canonicalizeAppDefinition(structuredClone(def));
const errorsOf = (def) => validateAppDefinition(def).errors.map((e) => `${e.code} @ ${e.path}`);

test('a link opens an http or https address only', () => {
    assert.equal(cleanNavUrl(' https://example.org/help '), 'https://example.org/help');
    assert.equal(cleanNavUrl('http://intranet.example/x?y=1'), 'http://intranet.example/x?y=1');
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '//example.org', '/api/users/me', 'https://user:pw@example.org', 'https://exa mple.org', 'ftp://example.org', `https://example.org/${'a'.repeat(600)}`, 7, null]) {
        assert.equal(cleanNavUrl(bad), null, String(bad));
    }
    assert.equal(isNavItemId('nvi_ab12'), true);
    assert.equal(isNavItemId('nvi_AB12'), false);
});

test('a nav without shell keys keeps its bytes and schema version', () => {
    const plain = canon(app({ style: 'sidebar' }));
    assert.deepEqual(plain.def.nav, { style: 'sidebar' });
    assert.equal(plain.def.schemaVersion, 2);
    assert.equal(canon(app({ style: 'tabs' })).def.nav, undefined);
});

test('the shell keys are stored in their own order, need schema 3 and save again unchanged', () => {
    const { def, repairs } = canon(app({
        brand: { showName: false, logo: 'asset:logo01', name: ' Field desk ' },
        footerText: 'Facilities · ext. 4410',
        items: [
            { label: 'Help', screenId: 'scr_help', icon: 'LifeBuoy' },
            { label: 'Handbook', url: 'https://example.org/handbook' },
            { label: 'Evil', url: 'javascript:alert(1)' },
            { label: 'Gone', screenId: 'scr_nope' },
        ],
        header: 'hidden',
        style: 'none',
    }));
    assert.deepEqual(Object.keys(def.nav), ['style', 'header', 'items', 'footerText', 'brand']);
    assert.equal(def.nav.style, 'none');
    assert.deepEqual(def.nav.items.map((i) => [i.label, i.screenId || i.url, i.icon]), [['Help', 'scr_help', 'LifeBuoy'], ['Handbook', 'https://example.org/handbook', null]]);
    assert.ok(def.nav.items.every((i) => isNavItemId(i.id)));
    assert.deepEqual(def.nav.brand, { name: 'Field desk', logo: 'asset:logo01', showName: false });
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(repairs.filter((r) => r.code.startsWith('nav.')).map((r) => r.code), ['nav.item_target', 'nav.item_screen_unknown']);
    assert.deepEqual(errorsOf(def), []);
    assert.deepEqual(canon(def).def, def);
    assert.deepEqual(collectAssetRefs(def).get('logo01'), ['nav.brand.logo']);
});

test('only nav.style none needs schema 3 among the styles', () => {
    assert.equal(canon(app({ style: 'rail' })).def.schemaVersion, 2);
    assert.equal(canon(app({ style: 'none' })).def.schemaVersion, 3);
});

test('a screen whose id the canonicalizer reassigns keeps its nav item; an item to no screen goes', () => {
    const input = app({ items: [{ label: 'Start', screenId: 'home' }] });
    input.screens[0].id = 'home';
    const { def } = canon(input);
    assert.notEqual(def.screens[0].id, 'home');
    assert.equal(def.nav.items[0].screenId, def.screens[0].id);
    assert.equal(canon(app({ items: [{ label: 'Gone', screenId: 'scr_nope' }] })).def.nav, undefined);
});

test('the validator refuses stored bytes the canonicalizer would have changed', () => {
    const { def } = canon(app({ header: 'hidden', items: [{ label: 'Docs', url: 'https://example.org/' }] }));
    const tampered = structuredClone(def);
    tampered.nav.header = 'floating';
    tampered.nav.items[0].url = 'javascript:alert(1)';
    tampered.nav.footerText = 'x'.repeat(200);
    assert.deepEqual(errorsOf(tampered), ['nav.value_invalid @ nav.header', 'nav.item_invalid @ nav.items[0]', 'nav.value_invalid @ nav.footerText']);
});

test('a public page never receives the nav, its links or its brand', () => {
    const { def } = canon({
        ...app({ items: [{ label: 'Help', screenId: 'scr_help' }], footerText: 'Internal line', brand: { name: 'Desk' } }),
        publicAccess: { enabled: true, entryScreenId: 'scr_home', screenIds: ['scr_home'] },
    });
    const served = buildPublicDefinition(def, resolvePublicSurface(def));
    assert.equal('nav' in served, false);
    assert.equal(JSON.stringify(served).includes('Internal line'), false);
});

test('app_set_shell sets keys, keeps the others, and null removes one', async () => {
    const { applyToolCall, MUTATING_TOOLS } = require('./builderTools');
    assert.ok(MUTATING_TOOLS.has('app_set_shell'));
    const wrap = { def: emptyDefinition('Desk') };
    const set = await applyToolCall('app_set_shell', { header: 'hidden', footerText: 'Desk', items: [{ label: 'Docs', url: 'https://example.org' }, { label: 'Bad', url: 'ftp://x' }] }, wrap);
    assert.equal(set.nav.header, 'hidden');
    assert.equal(set.nav.items.length, 1);
    assert.ok(set._hints.some((h) => h.includes('"Bad"')), JSON.stringify(set._hints));
    const kept = await applyToolCall('app_set_shell', { footerText: null }, wrap);
    assert.deepEqual([kept.nav.header, kept.nav.footerText], ['hidden', undefined]);
    const none = await applyToolCall('app_set_shell', { style: 'none' }, wrap);
    assert.equal(none.nav.style, 'none');
    const back = await applyToolCall('app_set_shell', { style: null, header: null, items: null }, wrap);
    assert.equal(back.nav, null);
    assert.match((await applyToolCall('app_set_shell', {}, wrap)).error, /Pass at least one/);
    assert.match((await applyToolCall('app_set_shell', { style: 'dock' }, wrap)).error, /Unknown style/);
});
