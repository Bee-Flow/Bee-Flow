/**
 * themeDesignSchema.mts: the theme and design parameters of app_set_theme and
 * app_set_public_access, built from THEME_SPEC and DESIGN_SPEC. With extension keys in the
 * tables: themeDesignSchema.fixture.test.js.
 * Run: node --test appStudio/builderTools/themeDesignSchema.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const S = require('./themeDesignSchema.mts');
const { THEME_SPEC, DESIGN_SPEC } = require('../componentSpecs');
const { isExtensionSince } = require('../catalogTiers.mts');
const { TOOL_SCHEMAS } = require('./schemas');

const params = (/** @type {string} */ name) => TOOL_SCHEMAS.find((t) => t.function.name === name).function.parameters;
const baseKeys = (/** @type {Record<string, any>} */ table) => Object.keys(table).filter((k) => !isExtensionSince(table[k].since));
const formKeys = (/** @type {string} */ form) => S.THEME_DESIGN_FORMS[form].base.map((/** @type {any[]} */ entry) => entry[1]);

test('every base key of the tables is in each form that takes its table (preset is set by the preset parameter)', () => {
    const designBase = baseKeys(DESIGN_SPEC).filter((k) => k !== 'preset');
    assert.deepEqual([...formKeys('setTheme')].sort(), [...baseKeys(THEME_SPEC), ...designBase].sort());
    assert.deepEqual([...formKeys('publicTheme')].sort(), [...baseKeys(THEME_SPEC)].sort());
    assert.deepEqual([...formKeys('publicDesign')].sort(), [...designBase].sort());
});

test('the tool schemas are the forms: base keys in the pinned order, then the extension keys', () => {
    const theme = params('app_set_theme').properties;
    assert.deepEqual(Object.keys(theme), [
        'preset', 'primary', 'accent', 'canvas', 'radius', 'density', 'fontScale', 'appearance', 'navStyle',
        'font', 'surface', 'motion', 'chartPalette', 'accentEdge', 'logoUrl',
        ...Object.keys(S.extensionThemeDesignProps('setTheme')),
    ]);
    const access = params('app_set_public_access').properties.publicAccess.properties;
    assert.deepEqual(Object.keys(access.theme.properties).slice(0, 7), ['primary', 'accent', 'canvas', 'radius', 'density', 'fontScale', 'appearance']);
    assert.deepEqual(Object.keys(access.design.properties).slice(0, 6), ['font', 'logoUrl', 'surface', 'motion', 'accentEdge', 'chartPalette']);
    assert.deepEqual(access.theme.properties, S.themeDesignProps('publicTheme'));
    assert.deepEqual(access.design.properties, S.themeDesignProps('publicDesign'));
});

test('a base key takes its enum from the spec, so an enum value marked since 3 joins it', () => {
    const theme = params('app_set_theme').properties;
    assert.deepEqual(theme.radius.enum, [...THEME_SPEC.radius.values]);
    assert.deepEqual(theme.font.enum, [...DESIGN_SPEC.font.values]);
    assert.equal(theme.primary.enum, undefined);
    assert.equal(theme.logoUrl.type, 'string');
});

test('every shipped extension key reaches the schemas: one of a type the fragment cannot write needs a toolSchema', () => {
    const theme = params('app_set_theme').properties;
    const access = params('app_set_public_access').properties.publicAccess.properties;
    for (const [table, form, place] of /** @type {const} */ ([[THEME_SPEC, 'theme', access.theme], [DESIGN_SPEC, 'design', access.design]])) {
        for (const [key, spec] of Object.entries(table)) {
            if (!isExtensionSince(/** @type {any} */ (spec).since)) continue;
            assert.ok(theme[key], `${form}.${key} is not in app_set_theme: give its spec entry a type the fragment knows or a toolSchema`);
            assert.ok(place.properties[key], `${form}.${key} is not in app_set_public_access.${form}`);
        }
    }
});

test('an extension key: its value schema by type, a gloss and where to read the entry', () => {
    const table = {
        old: { type: 'enum', values: ['a'], default: 'a' },
        zz_mode: { type: 'enum', values: ['x', 'y'], since: 3, optional: true, description: 'How it looks. More text here.' },
        zz_ink: { type: 'color', since: 3, optional: true, description: 'A second colour.' },
        zz_sheet: { type: 'css', since: 3, optional: true, maxLen: 10, description: 'A stylesheet of the app' },
        zz_list: { type: 'fontList', since: 3, optional: true, description: 'Fonts.', toolSchema: { type: 'array', items: { type: 'string' } } },
        zz_opaque: { type: 'fontList', since: 3, optional: true, description: 'No schema.' },
    };
    const out = Object.fromEntries(S.extensionProps('design', table));
    assert.deepEqual(Object.keys(out), ['zz_mode', 'zz_ink', 'zz_sheet', 'zz_list'], 'base keys and a key without a known schema stay out');
    assert.deepEqual(out.zz_mode, { type: 'string', enum: ['x', 'y'], description: 'How it looks. Read its entry before you use it: app_inspect_catalog {extensions:["design.zz_mode"]}.' });
    assert.deepEqual(out.zz_ink.type, ['string', 'null']);
    assert.match(out.zz_sheet.description, /^A stylesheet of the app\. Read its entry/);
    assert.deepEqual(out.zz_list.items, { type: 'string' });
    assert.notEqual(out.zz_list, table.zz_list.toolSchema, 'a copy');
});

test('firstSentence: the gloss before any cut, without its full stop', () => {
    assert.equal(S.firstSentence('One. Two.'), 'One');
    assert.equal(S.firstSentence('Only one.'), 'Only one');
    assert.equal(S.firstSentence('No stop'), 'No stop');
    assert.equal(S.firstSentence(undefined), '');
});

test('strip leaves a schema copy with no extension key, and only touches its own two tools', () => {
    const copy = JSON.parse(JSON.stringify(TOOL_SCHEMAS.find((t) => t.function.name === 'app_set_theme')));
    copy.function.parameters.properties.zz_fake = { type: 'string' };
    S.stripThemeDesignExtensions(copy);
    assert.ok(copy.function.parameters.properties.zz_fake, 'a key the tables do not mark is not touched');
    const other = { function: { name: 'app_add_screen', parameters: { type: 'object', properties: { a: {} } } } };
    S.stripThemeDesignExtensions(other);
    assert.deepEqual(other.function.parameters.properties, { a: {} });
});
