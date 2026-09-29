/**
 * App Studio — templateUpgrade (pristine hashing + availability).
 *
 * Pure-function tests: stableStringify must survive the JSONB round trip
 * (Postgres jsonb reorders object keys), hashDefinition must therefore be
 * key-order independent, and upgradeCandidate/isPristine/annotate must gate
 * availability on BOTH "registry version newer" and "definition untouched".
 * annotateTemplateUpgrades takes its registry + row loader injected, so no
 * store (and no DB pool) is ever loaded here.
 *
 * Run: cd server && node --test appStudio/templateUpgrade.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    stableStringify,
    hashDefinition,
    installedTemplateVersion,
    upgradeCandidate,
    isPristine,
    annotateTemplateUpgrades,
} = require('./templateUpgrade');
const { getTemplate, templateVersion, TEMPLATES } = require('./templates');

// A definition-ish fixture with nested objects and arrays.
function sampleDef() {
    return {
        schemaVersion: 2,
        meta: { name: 'Probe', icon: 'LayoutGrid' },
        screens: [{ id: 'scr_1', sections: [{ id: 'sec_1', children: [{ id: 'cmp_1', type: 'text', props: { text: 'hi' } }] }] }],
        actions: { act_a: { kind: 'navigate', screenId: 'scr_1' } },
    };
}

// The same content with every object's keys in a different order — what a
// JSONB round trip is allowed to do to the stored definition.
function sampleDefReordered() {
    return {
        actions: { act_a: { screenId: 'scr_1', kind: 'navigate' } },
        screens: [{ sections: [{ children: [{ props: { text: 'hi' }, type: 'text', id: 'cmp_1' }], id: 'sec_1' }], id: 'scr_1' }],
        meta: { icon: 'LayoutGrid', name: 'Probe' },
        schemaVersion: 2,
    };
}

// ── stableStringify / hashDefinition ────────────────────────────────────────

test('stableStringify is key-order independent but content sensitive', () => {
    assert.strictEqual(stableStringify(sampleDef()), stableStringify(sampleDefReordered()));
    // Array ORDER is content, not presentation — it must matter.
    assert.notStrictEqual(stableStringify({ a: [1, 2] }), stableStringify({ a: [2, 1] }));
    // undefined values disappear exactly like JSON.stringify drops them.
    assert.strictEqual(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }));
    // Scalars and null round-trip.
    assert.strictEqual(stableStringify(null), 'null');
    assert.strictEqual(stableStringify('x'), '"x"');
});

test('hashDefinition: equal content hashes equal, any change hashes different', () => {
    const h = hashDefinition(sampleDef());
    assert.match(h, /^[0-9a-f]{64}$/, 'sha256 hex');
    assert.strictEqual(hashDefinition(sampleDefReordered()), h, 'JSONB key reorder does not change the hash');

    const edited = sampleDef();
    edited.screens[0].sections[0].children[0].props.text = 'bye';
    assert.notStrictEqual(hashDefinition(edited), h, 'a one-character edit changes the hash');
});

// ── Version normalization ───────────────────────────────────────────────────

test('missing/invalid versions count as 1 on both sides', () => {
    assert.strictEqual(installedTemplateVersion({}), 1);
    assert.strictEqual(installedTemplateVersion({ templateVersion: null }), 1);
    assert.strictEqual(installedTemplateVersion({ templateVersion: 0 }), 1);
    assert.strictEqual(installedTemplateVersion({ templateVersion: 3 }), 3);
    assert.strictEqual(templateVersion({}), 1, 'registry side: missing version = 1');
    assert.strictEqual(templateVersion({ version: 2 }), 2);
    // The real registry surfaces a version on every template.
    for (const t of TEMPLATES.map((x) => getTemplate(x.id))) {
        assert.ok(Number.isInteger(t.version) && t.version >= 1, `${t.id} surfaces an integer version`);
    }
});

// ── upgradeCandidate / isPristine ───────────────────────────────────────────

function appRow({ def = sampleDef(), templateId = 'tpl_fake', tv = 1, hash } = {}) {
    return {
        id: 'app-1',
        templateId,
        templateVersion: tv,
        templateInstallHash: hash !== undefined ? hash : hashDefinition(def),
        definition: def,
    };
}

test('upgradeCandidate: equal versions → null; newer registry version → {from,to}', () => {
    const tplV1 = { id: 'tpl_fake', version: 1, definition: sampleDef() };
    const tplV2 = { id: 'tpl_fake', version: 2, definition: sampleDef() };

    assert.strictEqual(upgradeCandidate(appRow(), tplV1), null, 'freshly installed at the registry version');
    const cand = upgradeCandidate(appRow(), tplV2);
    assert.ok(cand);
    assert.strictEqual(cand.fromVersion, 1);
    assert.strictEqual(cand.toVersion, 2);

    // No stamp / unknown template / no hash → never a candidate.
    assert.strictEqual(upgradeCandidate({ id: 'x', definition: {} }, tplV2), null);
    assert.strictEqual(upgradeCandidate(appRow(), null), null);
    assert.strictEqual(upgradeCandidate(appRow({ hash: null }), tplV2), null);
    // Registry DOWNGRADE is not an upgrade.
    assert.strictEqual(upgradeCandidate(appRow({ tv: 3 }), tplV2), null);
});

test('isPristine: true only while the current definition hashes to the install hash', () => {
    const a = appRow();
    assert.strictEqual(isPristine(a), true);

    // The JSONB round-trip shape stays pristine.
    assert.strictEqual(isPristine({ ...a, definition: sampleDefReordered() }), true);

    // Any hand edit flips it.
    const edited = sampleDef();
    edited.meta.name = 'Renamed by hand';
    assert.strictEqual(isPristine({ ...a, definition: edited }), false);

    // No stamp → never pristine.
    assert.strictEqual(isPristine({ definition: sampleDef() }), false);
    assert.strictEqual(isPristine(null), false);
});

// ── annotateTemplateUpgrades ────────────────────────────────────────────────

test('annotate: available only when version newer AND pristine; hash loaded lazily', async () => {
    const fullRows = new Map();
    const loads = [];
    const loadApp = async (id) => { loads.push(id); return fullRows.get(id) || null; };
    const registry = {
        tpl_v1: { id: 'tpl_v1', version: 1, definition: {} },
        tpl_v2: { id: 'tpl_v2', version: 2, definition: {} },
    };
    const getTpl = (id) => registry[id] || null;

    const pristine = appRow({ templateId: 'tpl_v2' });
    fullRows.set('app-1', pristine);

    const edited = { ...appRow({ templateId: 'tpl_v2' }), id: 'app-2', definition: { changed: true } };
    fullRows.set('app-2', edited);

    const current = { ...appRow({ templateId: 'tpl_v1' }), id: 'app-3' };
    const blank = { id: 'app-4', definition: {} };

    const out = await annotateTemplateUpgrades(
        [{ ...pristine }, { ...edited }, { ...current }, blank],
        { loadApp, getTemplate: getTpl },
    );

    assert.deepStrictEqual(out[0].templateUpgrade, { available: true, fromVersion: 1, toVersion: 2 });
    assert.deepStrictEqual(out[1].templateUpgrade, { available: false, fromVersion: 1, toVersion: 2 });
    assert.deepStrictEqual(out[2].templateUpgrade, { available: false }, 'same version → no candidate at all');
    assert.deepStrictEqual(out[3].templateUpgrade, { available: false }, 'blank app → no candidate');

    // Cheapness: only the two version-newer apps were loaded and hashed.
    assert.deepStrictEqual(loads.sort(), ['app-1', 'app-2']);
});

test('annotate: a failing row load reports available:false instead of breaking the list', async () => {
    const registry = { tpl_v2: { id: 'tpl_v2', version: 2, definition: {} } };
    const out = await annotateTemplateUpgrades(
        [appRow({ templateId: 'tpl_v2' })],
        { loadApp: async () => { throw new Error('boom'); }, getTemplate: (id) => registry[id] || null },
    );
    assert.deepStrictEqual(out[0].templateUpgrade, { available: false, fromVersion: 1, toVersion: 2 });
});
