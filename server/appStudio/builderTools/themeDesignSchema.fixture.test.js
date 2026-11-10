/**
 * themeDesignSchema.mts with a theme key marked since 3 in THEME_SPEC (the testkit's zz_tint),
 * put in BEFORE the tool schemas load (they are module constants). DESIGN_SPEC is frozen, so its
 * extension keys are proven with a table of their own in themeDesignSchema.test.js.
 * Run: node --test appStudio/builderTools/themeDesignSchema.fixture.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { installExtensionFixtures } = require('../../testUtils/appCatalogExtensions.testkit');

const uninstall = installExtensionFixtures();
after(uninstall);

const { TOOL_SCHEMAS } = require('./schemas');
const { applyToolCall } = require('../builderTools');
const { selectToolMenu } = require('../builderModelProfiles');
const { stripThemeDesignExtensions } = require('./themeDesignSchema.mts');

const fn = (/** @type {any[]} */ list, /** @type {string} */ name) => list.find((t) => t.function.name === name).function;

test('the extension theme key joins app_set_theme and the public theme, after every base key', () => {
    const theme = fn(TOOL_SCHEMAS, 'app_set_theme').parameters.properties;
    const keys = Object.keys(theme);
    assert.equal(keys.indexOf('zz_tint'), keys.indexOf('logoUrl') + 1, 'after the last base key');
    assert.deepEqual(theme.zz_tint, {
        type: ['string', 'null'],
        description: 'A second brand colour for charts. Read its entry before you use it: app_inspect_catalog {extensions:["theme.zz_tint"]}.',
    });
    const publicTheme = fn(TOOL_SCHEMAS, 'app_set_public_access').parameters.properties.publicAccess.properties.theme.properties;
    assert.equal(Object.keys(publicTheme).at(-1), 'zz_tint');
});

test('the small band and a stripped copy are the base again', () => {
    const core = fn(selectToolMenu({ toolset: 'core' }, TOOL_SCHEMAS), 'app_set_theme').parameters.properties;
    assert.ok(!('zz_tint' in core));
    const copy = JSON.parse(JSON.stringify(TOOL_SCHEMAS.find((t) => t.function.name === 'app_set_public_access')));
    stripThemeDesignExtensions(copy);
    assert.ok(!('zz_tint' in copy.function.parameters.properties.publicAccess.properties.theme.properties));
    assert.ok('zz_tint' in fn(TOOL_SCHEMAS, 'app_set_public_access').parameters.properties.publicAccess.properties.theme.properties, 'the shared schema is untouched');
});

test('app_set_theme writes the extension key with no code of its own, and clears it with null', async () => {
    const { canonicalizeAppDefinition } = require('../canonicalize');
    const { emptyDefinition } = require('../componentSpecs');
    const wrap = { userId: 'usr_test', def: canonicalizeAppDefinition(emptyDefinition('Fixture app')).def };
    const before = { ...wrap.def.theme };
    const set = await applyToolCall('app_set_theme', { zz_tint: '#112233' }, wrap);
    assert.equal(set.error, undefined);
    assert.equal(wrap.def.theme.zz_tint, '#112233');
    assert.deepEqual({ ...wrap.def.theme, zz_tint: undefined }, { ...before, zz_tint: undefined }, 'nothing else moved');
    await applyToolCall('app_set_theme', { zz_tint: null }, wrap);
    assert.ok(!('zz_tint' in wrap.def.theme), 'absent again');
});
