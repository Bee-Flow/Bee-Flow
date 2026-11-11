'use strict';

/**
 * The font roles of an app's design (design.fonts, appFontRoles.js): what is stored, the
 * schema version it needs, the validator, the public page, the builder tool and the limits.
 *
 * Run: cd server && node --test appStudio/appFontRoles.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FONT_ROLE_FAMILIES, cleanFontRoles, fontRolesRepairNote, fontMaxBytes, DEFAULT_FONT_MAX_BYTES } = require('./appFontRoles');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { collectAssetRefs } = require('./appAssets.mts');
const { emptyDefinition } = require('./componentSpecs');
const { buildPublicDefinition, resolvePublicSurface } = require('./publicAccess');

function app(design) {
    return {
        schemaVersion: 2,
        meta: { name: 'Typed' },
        ...(design ? { design } : {}),
        screens: [{ id: 'scr_home', name: 'Home', sections: [{ id: 'sec_main', children: [{ id: 'cmp_title', type: 'heading', props: { text: 'Hello' } }] }] }],
    };
}

const canon = (def) => canonicalizeAppDefinition(structuredClone(def));
const errorsOf = (def) => validateAppDefinition(def).errors.map((e) => `${e.code} @ ${e.path}`);

test('a role takes a self-hosted family or an uploaded font; the rest is left out and named', () => {
    assert.deepEqual(cleanFontRoles({ mono: 'fira-code', heading: 'fraunces', body: 'asset:font_1' }), { heading: 'fraunces', body: 'asset:font_1', mono: 'fira-code' });
    assert.deepEqual(cleanFontRoles({ heading: 'roboto', display: 'inter' }), undefined);
    for (const value of [null, 'inter', [], 7]) assert.equal(cleanFontRoles(value), undefined);
    const note = fontRolesRepairNote({ heading: 'roboto', display: 'inter', body: 'inter' });
    assert.match(note, /heading "roboto"/);
    assert.match(note, /display \(not a role/);
    assert.equal(fontRolesRepairNote({ body: 'inter' }), null);
});

test('every family is one of the font files Bee Flow serves itself', () => {
    const fontsDir = path.join(__dirname, '../../agent-hub/public/fonts');
    for (const [id, { dir }] of Object.entries(FONT_ROLE_FAMILIES)) {
        const files = fs.readdirSync(path.join(fontsDir, dir));
        assert.ok(files.some((f) => f.endsWith('.woff2')), `${id}: a WOFF2 under agent-hub/public/fonts/${dir}`);
    }
});

test('an app without font roles keeps its bytes and schema version; with them it needs schema 3', () => {
    const plain = canon(app({ font: 'satoshi' }));
    assert.equal('fonts' in plain.def.design, false);
    assert.equal(plain.def.schemaVersion, 2);
    const typed = canon(app({ font: 'satoshi', fonts: { heading: 'fraunces', mono: 'plex-mono' } }));
    assert.deepEqual(typed.def.design.fonts, { heading: 'fraunces', mono: 'plex-mono' });
    assert.equal(typed.def.schemaVersion, 3);
    assert.deepEqual(errorsOf(typed.def), []);
    // Saved again, nothing moves.
    assert.deepEqual(canon(typed.def).def, typed.def);
});

test('null or an object with nothing usable removes the key, with a repair for the second', () => {
    assert.equal('fonts' in canon(app({ fonts: null })).def.design, false);
    const dropped = canon(app({ fonts: { heading: 'comic-sans' } }));
    assert.equal('fonts' in dropped.def.design, false);
    assert.ok(dropped.repairs.some((r) => r.code === 'design.value_invalid' && r.path === 'design.fonts'));
});

test('the validator refuses stored bytes the canonicalizer would have changed', () => {
    const { def } = canon(app({ fonts: { body: 'inter' } }));
    const tampered = structuredClone(def);
    tampered.design.fonts = { body: 'https://fonts.example/x.woff2' };
    assert.deepEqual(errorsOf(tampered), ['design.value_invalid @ design.fonts']);
});

test('an uploaded font is an asset reference: counted, checked and served to the public page', () => {
    const { def } = canon({
        ...app({ fonts: { heading: 'asset:brandfont' } }),
        publicAccess: { enabled: true, entryScreenId: 'scr_home', screenIds: ['scr_home'] },
    });
    assert.deepEqual(collectAssetRefs(def).get('brandfont'), ['design.fonts.heading']);
    const served = buildPublicDefinition(def, resolvePublicSurface(def));
    assert.deepEqual(served.design.fonts, { heading: 'asset:brandfont' });
    assert.deepEqual([...collectAssetRefs(served).keys()], ['brandfont']);
    const missing = validateAppDefinition(def, { assetIds: [] }).warnings.map((w) => w.code);
    assert.ok(missing.includes('asset.missing'));
});

test('app_set_theme sets and clears the roles', async () => {
    const { applyToolCall } = require('./builderTools');
    const wrap = { def: emptyDefinition('Typed') };
    const set = await applyToolCall('app_set_theme', { fonts: { heading: 'fraunces', body: 'inter', mono: 'nope' } }, wrap);
    assert.deepEqual(set.design.fonts, { heading: 'fraunces', body: 'inter' });
    assert.ok(set._hints.some((hint) => hint.includes('mono "nope"')), JSON.stringify(set._hints));
    assert.equal(wrap.def.schemaVersion, 3);
    const cleared = await applyToolCall('app_set_theme', { fonts: null }, wrap);
    assert.equal('fonts' in cleared.design, false);
});

test('the tool schema and the catalogue offer the key without touching the base', () => {
    const { extensionProps } = require('./builderTools/themeDesignSchema.mts');
    const props = Object.fromEntries(extensionProps('design'));
    assert.deepEqual(props.fonts.type, ['object', 'null']);
    assert.match(props.fonts.description, /app_inspect_catalog \{extensions:\["design\.fonts"\]\}/);
});

test('the font size limit comes from the environment, 0 leaving only the per-file limit', () => {
    assert.equal(fontMaxBytes({}), DEFAULT_FONT_MAX_BYTES);
    assert.equal(fontMaxBytes({ STUDIO_APP_FONT_MAX_BYTES: '2048' }), 2048);
    assert.equal(fontMaxBytes({ STUDIO_APP_FONT_MAX_BYTES: '0' }), Infinity);
    assert.equal(fontMaxBytes({ STUDIO_APP_FONT_MAX_BYTES: 'lots' }), DEFAULT_FONT_MAX_BYTES);
});
