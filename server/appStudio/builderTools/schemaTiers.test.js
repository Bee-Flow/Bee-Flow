/**
 * schemaTiers.mts: the tool schemas with extension entries in the catalogue.
 *
 * The schemas are module constants, so the test-only entries (testUtils/appCatalogExtensions.testkit.js)
 * go into the spec tables BEFORE this file requires them: that is a process whose registries
 * were not empty at load. toolSchemaHashes.test.js is the same check with empty registries.
 * Run: node --test appStudio/builderTools/schemaTiers.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { installExtensionFixtures, baseToolSchemaHashes, pinnedOnly } = require('../../testUtils/appCatalogExtensions.testkit');

const uninstall = installExtensionFixtures();
after(uninstall);

const pinned = require('./__tests__/toolSchemaHashes.base.json');
const { TOOL_SCHEMAS } = require('./schemas');
const { selectToolMenu } = require('../builderModelProfiles');
const { baseCatalogue, fullCatalogue, EXTENSION_FAMILIES } = require('../catalogTiers.mts');
const { INSPECT_MAX_EXTENSIONS, INSPECT_MAX_FAMILY_ENTRIES } = require('./schemaTiers.mts');

const tool = (/** @type {any[]} */ list, /** @type {string} */ name) => list.find((t) => t.function.name === name).function;
const coreMenu = () => selectToolMenu({ toolset: 'core' }, TOOL_SCHEMAS);

/** Every enum array in a schema. @returns {unknown[][]} */
function enums(/** @type {unknown} */ node) {
    if (Array.isArray(node)) return node.flatMap(enums);
    if (!node || typeof node !== 'object') return [];
    const own = Array.isArray(/** @type {any} */ (node).enum) ? [/** @type {any} */ (node).enum] : [];
    return [...own, ...Object.values(node).flatMap(enums)];
}

test('the full schemas accept the extension values, after the base values', () => {
    const action = tool(TOOL_SCHEMAS, 'app_set_action').parameters.properties.action;
    const stepKinds = action.properties.steps.items.properties.kind.enum;
    const baseKinds = baseCatalogue().STEP_KINDS;
    assert.deepEqual(stepKinds, fullCatalogue().STEP_KINDS);
    assert.deepEqual(stepKinds.slice(0, baseKinds.length), baseKinds, 'the base kinds first, in their own order');
    assert.ok(stepKinds.indexOf('zz_wait') >= baseKinds.length);
    for (const name of ['app_add_section', 'app_update_section']) {
        const background = tool(TOOL_SCHEMAS, name).parameters.properties.style.properties.background.enum;
        const baseValues = baseCatalogue().STYLE_KNOBS.background.values;
        assert.deepEqual(background.slice(0, baseValues.length), baseValues, name);
        assert.ok(background.indexOf('zz_mesh') >= baseValues.length, name);
    }
});

test('a screen, theme or design enum takes its extension value after the base values', () => {
    const props = (/** @type {string} */ name) => tool(TOOL_SCHEMAS, name).parameters.properties;
    const cases = /** @type {const} */ ([
        [props('app_add_screen').maxWidth.enum, baseCatalogue().SCREEN_SPEC.maxWidth.values, 'zz_ultra'],
        [props('app_update_screen').maxWidth.enum, baseCatalogue().SCREEN_SPEC.maxWidth.values, 'zz_ultra'],
        [props('app_set_theme').radius.enum, baseCatalogue().THEME_SPEC.radius.values, 'zz_pill'],
        [props('app_set_theme').motion.enum, baseCatalogue().DESIGN_SPEC.motion.values, 'zz_expressive'],
    ]);
    for (const [live, base, value] of cases) {
        assert.deepEqual(live.slice(0, base.length), base, value);
        assert.ok(live.indexOf(value) >= base.length, value);
        assert.ok(!base.includes(value), value);
    }
});

test('the core projection drops the extension words of the data vocabulary and the nav styles from any enum built from them', () => {
    // Those lists are frozen, so their fixtures are an overlay the tiers read: a schema node
    // holding the whole list stands in for the enums the real schemas build from it.
    const { stripExtensionTier } = require('./schemaTiers.mts');
    const full = fullCatalogue();
    const base = baseCatalogue();
    const node = {
        function: {
            name: 'fixture_tool',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: [...full.FIELD_TYPES] },
                    filter: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: [...full.FILTER_OPS] } } } },
                    fn: { type: 'string', enum: [...full.AGG_FNS] },
                    bucket: { type: 'string', enum: [...full.DATE_BUCKETS] },
                    navStyle: { type: 'string', enum: [...full.NAV_STYLES] },
                    other: { type: 'string', enum: ['zz_keep', 'a'] },
                },
            },
        },
    };
    assert.ok(full.FIELD_TYPES.includes('zz_money') && full.NAV_STYLES.includes('zz_dock'));
    stripExtensionTier(node);
    const out = node.function.parameters.properties;
    assert.deepEqual(out.type.enum, [...base.FIELD_TYPES]);
    assert.deepEqual(out.filter.items.properties.op.enum, [...base.FILTER_OPS]);
    assert.deepEqual(out.fn.enum, [...base.AGG_FNS]);
    assert.deepEqual(out.bucket.enum, [...base.DATE_BUCKETS]);
    assert.deepEqual(out.navStyle.enum, [...base.NAV_STYLES]);
    assert.deepEqual(out.other.enum, ['zz_keep', 'a'], 'an enum that is not a tiered list is left alone');
    for (const list of [out.type.enum, out.filter.items.properties.op.enum, out.fn.enum, out.bucket.enum, out.navStyle.enum]) {
        assert.ok(!list.some((/** @type {string} */ v) => v.startsWith('zz_')), JSON.stringify(list));
    }
});

test('the wording of the data tools names the base words only', () => {
    // The enums take the whole list; a description that listed it would move with every word added.
    const vocabulary = require('../../core/dataEngine/dataModel/vocabularySince');
    const text = JSON.stringify(TOOL_SCHEMAS);
    assert.ok(text.includes(`ops ${vocabulary.BASE_FILTER_OPS.join(', ')}`));
    assert.ok(text.includes(`A field type (${vocabulary.BASE_FIELD_TYPES.join(', ')}).`));
    assert.ok(text.includes(`{fn: ${vocabulary.BASE_AGG_FNS.join('|')}, field?, as}`));
    assert.ok(text.includes(`bucket for date fields: ${vocabulary.BASE_DATE_BUCKETS.join('|')}`));
});

test('no schema closes its property list: an extension prop, knob or step field is not refused', () => {
    assert.ok(!JSON.stringify(TOOL_SCHEMAS).includes('additionalProperties'));
});

test('app_inspect_catalog gains extensions and family, and only those', () => {
    const { properties } = tool(TOOL_SCHEMAS, 'app_inspect_catalog').parameters;
    assert.deepEqual(Object.keys(properties), ['components', 'steps', 'extensions', 'family']);
    assert.match(properties.extensions.description, new RegExp(`\\(max ${INSPECT_MAX_EXTENSIONS}\\), e\\.g\\. \\["`));
    // Only the families that have an item, in the order of the index.
    for (const family of ['componentTypes', 'props', 'styleKnobs', 'enumValues', 'stepKinds', 'stepFields', 'bindingKinds']) assert.ok(properties.family.enum.includes(family), family);
    assert.deepEqual(properties.family.enum, EXTENSION_FAMILIES.filter((f) => properties.family.enum.includes(f)));
    assert.match(properties.family.description, new RegExp(`first ${INSPECT_MAX_FAMILY_ENTRIES}`));
});

test('without their extension tier the full schemas are byte-identical to the capture', () => {
    // Descriptions name base values only, so nothing but the enums and the two inspect
    // parameters moves when a registry entry is added.
    assert.deepEqual(pinnedOnly(baseToolSchemaHashes().full, pinned.full), pinned.full);
});

test('the core projection is the base: byte-identical to the capture, no extension value anywhere', () => {
    assert.deepEqual(pinnedOnly(baseToolSchemaHashes().core, pinned.core), pinned.core);
    const text = JSON.stringify(coreMenu());
    assert.ok(!text.includes('zz_'), 'no fixture name in the small band\'s schemas');
    assert.deepEqual(Object.keys(tool(coreMenu(), 'app_inspect_catalog').parameters.properties), ['components', 'steps']);
    for (const list of enums(coreMenu())) assert.ok(!list.some((v) => String(v).startsWith('zz_')), JSON.stringify(list));
    // The projection never edits the shared full schemas.
    assert.ok(JSON.stringify(TOOL_SCHEMAS).includes('zz_wait'));
    assert.equal(coreMenu(), coreMenu(), 'cached: two turns get the same object graph');
});

test('the MCP tool list is the full menu: its inspect tool takes extensions and family', () => {
    const mcpBuilder = require('../mcpBuilder');
    const inspect = mcpBuilder.buildToolList().find((/** @type {{ name: string }} */ t) => t.name === 'app_inspect_catalog');
    const schema = inspect.inputSchema || inspect.parameters;
    assert.deepEqual(Object.keys(schema.properties), ['appId', 'components', 'steps', 'extensions', 'family']);
});
