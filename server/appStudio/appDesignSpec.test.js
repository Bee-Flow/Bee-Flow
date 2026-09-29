/**
 * App Design v2 — spec, canonicalization and validation contracts.
 *
 * The load-bearing test is BYTE PARITY: a definition without design/nav must
 * canonicalize to exactly the same object as before these keys existed —
 * that's the whole back-compat story for every published app and both shipped
 * templates.
 *
 * Run: cd server && node --test appStudio/appDesignSpec.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { canonDesign, canonNavShape, resolveNavScreens, DESIGN_SPEC, NAV_DEFAULT_STYLE } = require('./appDesignSpec');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { getTemplate } = require('./templates');

function collect() {
    const repairs = [];
    return { repairs, push: (code, path, message) => repairs.push({ code, path, message }) };
}

// ── canonDesign ─────────────────────────────────────────────────────────────

test('canonDesign: completes a partial design with defaults, no repairs for absence', () => {
    const { repairs, push } = collect();
    const out = canonDesign({ surface: 'soft' }, push);
    assert.deepEqual(out, { preset: 'custom', font: 'system', surface: 'soft', motion: 'subtle', chartPalette: 'classic', accentEdge: 'bar', logoUrl: null });
    assert.deepEqual(repairs, []);
});

test('canonDesign: invalid enum + unknown key repair; logoUrl must be https and bounded', () => {
    const { repairs, push } = collect();
    const out = canonDesign({ font: 'comic-sans', glitter: true, logoUrl: 'http://nope' }, push);
    assert.equal(out.font, 'system');
    assert.equal(out.logoUrl, null);
    assert.ok(repairs.some((r) => r.code === 'design.value_invalid' && r.path === 'design.font'));
    assert.ok(repairs.some((r) => r.code === 'design.value_invalid' && r.path === 'design.logoUrl'));
    assert.ok(repairs.some((r) => r.code === 'design.unknown_key'));

    const { repairs: r2, push: p2 } = collect();
    const ok = canonDesign({ logoUrl: 'https://cdn.example.com/logo.svg' }, p2);
    assert.equal(ok.logoUrl, 'https://cdn.example.com/logo.svg');
    assert.deepEqual(r2, []);
});

// ── canonNavShape / resolveNavScreens ───────────────────────────────────────

test('canonNavShape: style enum, group ids assigned/deduped, label required', () => {
    const { repairs, push } = collect();
    const out = canonNavShape({
        style: 'sidebar',
        groups: [
            { id: 'nvg_aaaa11', label: 'Werk', icon: 'Inbox', screens: ['scr_a'] },
            { id: 'nvg_aaaa11', label: 'Beheer', screens: ['scr_b'] },   // dup id → reassigned
            { label: '', screens: ['scr_c'] },                            // no label → dropped
            'nope',                                                       // not an object → dropped
        ],
    }, push);
    assert.equal(out.style, 'sidebar');
    assert.equal(out.groups.length, 2);
    assert.equal(out.groups[0].id, 'nvg_aaaa11');
    assert.notEqual(out.groups[1].id, 'nvg_aaaa11');
    assert.match(out.groups[1].id, /^nvg_[0-9a-f]{6}$/);
    assert.ok(repairs.some((r) => r.code === 'nav.group_id'));
    assert.ok(repairs.filter((r) => r.code === 'nav.group_invalid').length === 2);
});

test('resolveNavScreens: renames, drops unknown + cross-group duplicates, drops empty groups, default-style-only nav vanishes', () => {
    const { repairs, push } = collect();
    const rename = new Map([['old_scr', 'scr_new1']]);
    const valid = new Set(['scr_new1', 'scr_keep1']);

    const nav = {
        style: NAV_DEFAULT_STYLE,
        groups: [
            { id: 'nvg_one001', label: 'A', icon: null, screens: ['old_scr', 'scr_ghost'] },
            { id: 'nvg_two002', label: 'B', icon: null, screens: ['scr_new1', 'scr_keep1'] }, // scr_new1 already claimed by A
            { id: 'nvg_thr003', label: 'C', icon: null, screens: ['scr_ghost'] },             // empties out → dropped
        ],
    };
    const out = resolveNavScreens(nav, rename, valid, push);
    assert.deepEqual(out.groups.map((g) => g.screens), [['scr_new1'], ['scr_keep1']]);
    assert.ok(repairs.some((r) => r.code === 'nav.screen_unknown'));
    assert.ok(repairs.some((r) => r.code === 'nav.screen_duplicate'));
    assert.ok(repairs.some((r) => r.code === 'nav.group_empty'));

    // A nav that reduces to { style: default } carries no information — gone.
    const { push: p2 } = collect();
    assert.equal(resolveNavScreens({ style: NAV_DEFAULT_STYLE }, new Map(), valid, p2), undefined);
    // …but a non-default style survives without groups.
    const kept = resolveNavScreens({ style: 'sidebar' }, new Map(), valid, p2);
    assert.deepEqual(kept, { style: 'sidebar' });
});

// ── canonicalizeAppDefinition integration ───────────────────────────────────

const BASE_DEF = {
    schemaVersion: 2,
    meta: { name: 'Parity', description: '', icon: 'LayoutGrid' },
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
    homeScreenId: 'scr_home01',
    roles: [],
    screens: [
        {
            id: 'scr_home01', name: 'Home', icon: null, showInNav: true, maxWidth: 'medium',
            sections: [{ id: 'sec_one001', style: { padding: 4, gap: 3, background: 'none' }, children: [] }],
        },
        {
            id: 'scr_two001', name: 'Twee', icon: null, showInNav: false, maxWidth: 'medium',
            sections: [{ id: 'sec_two001', style: { padding: 4, gap: 3, background: 'none' }, children: [] }],
        },
    ],
    actions: {},
};

test('BYTE PARITY: a definition without design/nav gains neither key and is idempotent', () => {
    const first = canonicalizeAppDefinition(BASE_DEF);
    assert.ok(!('design' in first.def), 'no design key materializes');
    assert.ok(!('nav' in first.def), 'no nav key materializes');
    const second = canonicalizeAppDefinition(first.def);
    assert.deepEqual(second.def, first.def, 'canonicalization is idempotent');
    const structural = second.repairs.filter((r) => !/defaulted|default/i.test(r.code));
    assert.deepEqual(structural, [], 'a canonical definition needs no structural repairs');
});

test('shipped templates stay byte-stable under the canonicalizer', () => {
    // The back-compat contract is EMIT-WHEN-PRESENT: a template that says
    // nothing about design or navigation must not grow the keys. The support
    // desk is the witness for that — it deliberately declares neither.
    const desk = canonicalizeAppDefinition(getTemplate('app-support-desk').definition);
    assert.ok(!('design' in desk.def) && !('nav' in desk.def), 'app-support-desk: no v2 keys appear');

    // Quote intake DOES declare them, and must keep exactly what it wrote —
    // this is the other half of the same contract.
    const quote = getTemplate('app-quote-intake');
    const { def, repairs } = canonicalizeAppDefinition(quote.definition);
    assert.deepEqual(def.design, quote.definition.design, 'app-quote-intake: design survives verbatim');
    assert.deepEqual(def.nav, quote.definition.nav, 'app-quote-intake: nav survives verbatim');

    for (const [id, result] of [['app-support-desk', desk], ['app-quote-intake', { repairs }]]) {
        const structural = result.repairs.filter((r) => !/defaulted|default/i.test(r.code));
        assert.deepEqual(structural.map((r) => `${r.code} @ ${r.path}`), [], `${id}: no structural repairs`);
    }
});

test('a design/nav definition canonicalizes deterministically and validates clean', () => {
    const withDesign = {
        ...BASE_DEF,
        design: { preset: 'cloud', font: 'satoshi', surface: 'soft', motion: 'full', chartPalette: 'brand', accentEdge: 'bar', logoUrl: null },
        nav: { style: 'sidebar', groups: [{ id: 'nvg_grp001', label: 'Alles', icon: 'Inbox', screens: ['scr_home01'] }] },
    };
    const { def } = canonicalizeAppDefinition(withDesign);
    assert.deepEqual(def.design, withDesign.design);
    assert.deepEqual(def.nav, withDesign.nav);
    // Idempotent with the keys present too.
    const again = canonicalizeAppDefinition(def);
    assert.deepEqual(again.def, def);

    const res = validateAppDefinition(def, {});
    assert.deepEqual(res.errors.map((e) => `${e.code} @ ${e.path}`), []);
    assert.deepEqual(res.warnings.map((w) => `${w.code} @ ${w.path}`), []);
});

test('nav group refs: renamed screen ids are rewritten; unknown dropped', () => {
    const input = {
        ...BASE_DEF,
        screens: [
            { ...BASE_DEF.screens[0], id: 'not-a-valid-id' }, // forces a rename
            BASE_DEF.screens[1],
        ],
        homeScreenId: 'not-a-valid-id',
        nav: { style: 'sidebar', groups: [{ id: 'nvg_grp001', label: 'Alles', icon: null, screens: ['not-a-valid-id', 'scr_ghost9'] }] },
    };
    const { def } = canonicalizeAppDefinition(input);
    assert.equal(def.nav.groups.length, 1);
    assert.equal(def.nav.groups[0].screens.length, 1);
    assert.match(def.nav.groups[0].screens[0], /^scr_/);
    assert.equal(def.nav.groups[0].screens[0], def.homeScreenId, 'group ref follows the same rename as homeScreenId');
});

// ── validate ────────────────────────────────────────────────────────────────

test('validate: design/nav errors on bad values; hidden-screen membership is a warning', () => {
    const { def } = canonicalizeAppDefinition(BASE_DEF);

    const badDesign = { ...def, design: { ...canonDesign({}, () => {}), font: 'papyrus' } };
    assert.ok(validateAppDefinition(badDesign, {}).errors.some((e) => e.code === 'design.value_invalid'));

    const badNav = { ...def, nav: { style: 'ribbon' } };
    assert.ok(validateAppDefinition(badNav, {}).errors.some((e) => e.code === 'nav.value_invalid'));

    const ghostNav = { ...def, nav: { style: 'sidebar', groups: [{ id: 'nvg_grp001', label: 'X', icon: null, screens: ['scr_ghost9'] }] } };
    assert.ok(validateAppDefinition(ghostNav, {}).errors.some((e) => e.code === 'nav.screen_unresolved'));

    // scr_two001 has showInNav:false — listing it in a group warns, not errors.
    const hiddenNav = { ...def, nav: { style: 'sidebar', groups: [{ id: 'nvg_grp001', label: 'X', icon: null, screens: ['scr_two001'] }] } };
    const res = validateAppDefinition(hiddenNav, {});
    assert.deepEqual(res.errors, []);
    assert.ok(res.warnings.some((w) => w.code === 'nav.group_screen_hidden'));
});

test('DESIGN_SPEC shape is frozen and enum-complete (mirror contract anchor)', () => {
    assert.deepEqual(Object.keys(DESIGN_SPEC), ['preset', 'font', 'surface', 'motion', 'chartPalette', 'accentEdge', 'logoUrl']);
    for (const spec of Object.values(DESIGN_SPEC)) {
        assert.ok(spec.type === 'enum' ? Array.isArray(spec.values) && spec.values.includes(spec.default) : spec.type === 'url');
    }
});
