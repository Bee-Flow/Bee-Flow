/**
 * TEST FIXTURE, never shipped: App Studio catalogue entries marked `since: 3`, one per place a
 * mark can sit, put into the live spec tables for the length of a test.
 *
 * The registries ship empty, so the extension tier of the AI builder's catalogue
 * (appStudio/catalogTiers.mts) has nothing to show until a feature adds a file. These entries
 * prove the mechanism: a component type, a prop on an existing type, an enum value on an
 * existing prop, a style knob, an enum value on an existing knob, a step kind, a field on an
 * existing step kind, a binding kind and a top-level key.
 *
 * In-process only (every test file runs in its own process), the way typeExtensions.test.js
 * does it: the spec-driven code reads the tables at call time.
 *
 *   installExtensionFixtures()   the table entries; returns the function that takes them out.
 *                                For async tests, and for a file that needs them in place
 *                                BEFORE it requires the tool schemas (module constants).
 *   withExtensionFixtures(fn)    the same plus the top-level key and the schema-version index,
 *                                through the registries' own hooks. Synchronous `fn` only.
 */

'use strict';

const specs = require('../appStudio/componentSpecs');
const { withErrorEnvelope } = require('../appStudio/componentSpecs/stepEnvelope');

const FIXTURE_TYPE = {
    since: 3,
    mobile: { reason: 'Fixture: not drawn on the phone.' },
    label: 'Gauge',
    category: 'Content',
    description: 'A radial meter for one number. It fills clockwise from min to max and shows the value in the middle.',
    props: {
        value: { type: 'binding', default: { kind: 'static', value: 0 } },
        label: { type: 'string', maxLen: 80, default: 'Gauge' },
        max: { type: 'int', min: 1, max: 1000, default: 100 },
    },
    styleKnobs: ['span', 'zz_glow'],
    defaultStyle: { span: 4 },
};

const FIXTURE_NAMES = Object.freeze({
    type: 'zz_gauge',
    prop: 'heading.zz_kicker',
    propValue: 'button.variant=zz_ghost',
    knob: 'zz_glow',
    knobValue: 'style.background=zz_mesh',
    stepKind: 'zz_wait',
    stepField: 'toast.zz_duration',
    bindingKind: 'zz_lookup',
    topLevelKey: 'zzNotes',
});

/** True for the name of one of the fixture items (a test looks at these among whatever ships). */
const isFixtureName = (/** @type {string} */ name) => Object.values(FIXTURE_NAMES).includes(name);

const FIXTURE_KEY_ENTRY = {
    key: 'zzNotes',
    since: 3,
    canon: (/** @type {unknown} */ value) => (typeof value === 'string' ? value.slice(0, 200) : undefined),
    public: false,
    description: 'A note the author keeps with the app. Never shown to a visitor.',
    shape: 'string ≤200',
};

/** Put the fixture entries into the live tables. Returns the function that takes them out again. */
function installExtensionFixtures() {
    const { _catalogueChanged } = require('../appStudio/catalogTiers.mts');
    const { COMPONENT_SPECS, COMPONENT_TYPES, STYLE_KNOBS, STEP_KINDS, STEP_SPECS, BINDING_KINDS, BINDING_KIND_SINCE, BINDING_KIND_DOCS } = specs;
    /** @type {Record<string, any>} */
    const button = COMPONENT_SPECS.button.props.variant;
    /** @type {Record<string, any>} */
    const background = STYLE_KNOBS.background;
    /** @type {Record<string, any>} */
    const toastFields = STEP_SPECS.toast.fields;

    COMPONENT_SPECS.zz_gauge = FIXTURE_TYPE;
    COMPONENT_TYPES.push('zz_gauge');
    COMPONENT_SPECS.heading.props.zz_kicker = { type: 'string', maxLen: 60, since: 3, description: 'A small line above the heading text.' };
    button.values.push('zz_ghost');
    const marks = { button: button.valuesSince, background: background.valuesSince }; // a shipped entry may have its own
    button.valuesSince = { ...marks.button, zz_ghost: 3 };
    STYLE_KNOBS.zz_glow = { type: 'enum', values: ['none', 'soft', 'strong'], default: 'none', since: 3, description: 'A coloured halo around the box.' };
    background.values.push('zz_mesh');
    background.valuesSince = { ...marks.background, zz_mesh: 3 };
    STEP_KINDS.push('zz_wait');
    Object.assign(STEP_SPECS, withErrorEnvelope({
        zz_wait: { mutatesData: false, since: 3, retrySafe: true, description: 'Pause the sequence for a moment.', fields: { ms: { type: 'int', min: 0, max: 5000, required: true } } },
    }));
    toastFields.zz_duration = { type: 'int', min: 1, max: 30, since: 3, description: 'Seconds the toast stays up.' };
    BINDING_KINDS.push('zz_lookup');
    BINDING_KIND_SINCE.zz_lookup = 3;
    BINDING_KIND_DOCS.zz_lookup = { shape: '{ "kind": "zz_lookup", "tableId": "<tbl_…>", "match": "<field key>" }', description: 'ONE value from another table, matched on a field.' };
    _catalogueChanged();

    return function uninstall() {
        delete COMPONENT_SPECS.zz_gauge;
        COMPONENT_TYPES.splice(COMPONENT_TYPES.indexOf('zz_gauge'), 1);
        delete COMPONENT_SPECS.heading.props.zz_kicker;
        button.values.splice(button.values.indexOf('zz_ghost'), 1);
        if (marks.button) button.valuesSince = marks.button; else delete button.valuesSince;
        delete STYLE_KNOBS.zz_glow;
        background.values.splice(background.values.indexOf('zz_mesh'), 1);
        if (marks.background) background.valuesSince = marks.background; else delete background.valuesSince;
        STEP_KINDS.splice(STEP_KINDS.indexOf('zz_wait'), 1);
        delete STEP_SPECS.zz_wait;
        delete toastFields.zz_duration;
        BINDING_KINDS.splice(BINDING_KINDS.indexOf('zz_lookup'), 1);
        delete BINDING_KIND_SINCE.zz_lookup;
        delete BINDING_KIND_DOCS.zz_lookup;
        _catalogueChanged();
    };
}

/**
 * Run the synchronous `fn` with every fixture in place: the table entries, the top-level key
 * (definitionKeyRegistry._withDefinitionKeys) and the schema-version index (schemaSince._withCatalogue).
 * @template R
 * @param {() => R} fn
 * @returns {R}
 */
function withExtensionFixtures(fn) {
    const registry = require('../appStudio/definitionKeyRegistry.mts');
    const since = require('../appStudio/schemaSince.mts');
    const { _catalogueChanged } = require('../appStudio/catalogTiers.mts');
    const uninstall = installExtensionFixtures();
    try {
        return registry._withDefinitionKeys([...registry.definitionKeys(), FIXTURE_KEY_ENTRY], () => {
            _catalogueChanged(); // the key registry changed after the tables did
            return since._withCatalogue({
                componentSpecs: specs.COMPONENT_SPECS, styleKnobs: specs.STYLE_KNOBS, stepSpecs: specs.STEP_SPECS,
                actionSpecs: specs.ACTION_SPECS, bindingKindSince: specs.BINDING_KIND_SINCE, definitionKeys: registry.definitionKeys(),
            }, fn);
        });
    } finally {
        uninstall();
    }
}

/**
 * `{ full, core }`: tool name → sha256 of its schema, in the shape of
 * appStudio/builderTools/__tests__/toolSchemaHashes.base.json. `full` is hashed WITHOUT its extension tier
 * (schemaTiers.stripExtensionTier on a copy), which is the schema itself while the registries are
 * empty; `core` is hashed as the small band gets it.
 */
function baseToolSchemaHashes() {
    const crypto = require('node:crypto');
    const { TOOL_SCHEMAS } = require('../appStudio/builderTools/schemas');
    const { selectToolMenu } = require('../appStudio/builderModelProfiles');
    const { stripExtensionTier } = require('../appStudio/builderTools/schemaTiers.mts');
    const sha = (/** @type {unknown} */ tool) => crypto.createHash('sha256').update(JSON.stringify(tool)).digest('hex');
    const byName = (/** @type {any[]} */ tools) => Object.fromEntries(tools.map((tool) => [tool.function.name, sha(tool)]));
    const stripped = TOOL_SCHEMAS.map((/** @type {unknown} */ tool) => {
        const copy = JSON.parse(JSON.stringify(tool));
        stripExtensionTier(copy);
        return copy;
    });
    return { full: byName(stripped), core: byName(selectToolMenu({ toolset: 'core' }, TOOL_SCHEMAS)) };
}

/**
 * `now` narrowed to the tools of `pinned`, in the order of `pinned` (a tool added after the capture is not compared).
 * @param {Record<string, string>} now
 * @param {Record<string, string>} pinned
 */
function pinnedOnly(now, pinned) {
    return Object.fromEntries(Object.keys(pinned).map((name) => [name, now[name]]));
}

module.exports = { installExtensionFixtures, withExtensionFixtures, baseToolSchemaHashes, pinnedOnly, isFixtureName, FIXTURE_NAMES, FIXTURE_KEY_ENTRY };
