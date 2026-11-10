/**
 * TEST FIXTURE, never shipped: App Studio catalogue entries marked `since: 3`, one per place a
 * mark can sit, put into the live spec tables for the length of a test.
 *
 * The registries ship empty, so the extension tier of the AI builder's catalogue
 * (appStudio/catalogTiers.mts) has nothing to show until a feature adds a file. These entries
 * prove the mechanism: a component type, a prop on an existing type, an enum value on an
 * existing prop, a style knob, an enum value on an existing knob, a step kind, a field on an
 * existing step kind, a binding kind and a top-level key; and (KEY_FIXTURE_NAMES) a field on an
 * existing action kind, an enum value on a step field, a key and an enum value of the items of
 * a list prop (also of a nested list), a screen key and value, a section key, a knob newly
 * allowed on sections, a theme and a design key and value, a node key, a nav key, a nav group
 * key, a nav style, an event an existing type newly fires, a word of each family of the
 * data vocabulary, a key of a data binding (one of them holding a clause list) and two query
 * shapes: a form of a filter with its predicate, and a key of a groupBy entry.
 *
 * DESIGN_SPEC, NAV_STYLES and the data vocabulary are frozen, so their fixtures live in an
 * overlay only the catalogue tiers and the schema-version index read
 * (catalogTiers._setCatalogueOverlay): canonicalize and the tool schemas never see those.
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

/** The fixtures of the places outside the component, knob and kind tables, by index family. */
const KEY_FIXTURE_NAMES = Object.freeze({
    itemKeys: ['table.columns[].toneMap[].zz_icon', 'table.columns[].zz_note'],
    enumValues: [
        'design.motion=zz_expressive', 'nav.style=zz_dock', 'screen.maxWidth=zz_ultra', 'step.generate_file.format=zz_tsv',
        'table.columns[].align=zz_justify', 'theme.radius=zz_pill',
    ],
    screenKeys: ['screen.zz_layout'],
    sectionKeys: ['section.style.weight', 'section.zz_title'],
    nodeKeys: ['divider.onCardMove', 'node.zz_styleWhen'],
    themeKeys: ['theme.zz_tint'],
    designKeys: ['design.zz_backdrop'],
    navKeys: ['nav.groups[].zz_badge', 'nav.zz_footer'],
    actionFields: ['toast.zz_sticky'],
    data: [
        'aggFn.zz_median', 'binding.zz_expand', 'binding.zz_having', 'dateBucket.zz_fortnight', 'fieldOption.zz_mask', 'fieldType.zz_money',
        'filter.zz_all', 'filterOp.zz_near', 'groupBy.zz_step',
    ],
});
const ALL_FIXTURE_NAMES = Object.freeze([...Object.values(FIXTURE_NAMES), ...Object.values(KEY_FIXTURE_NAMES).flat()]);

/** True for the name of one of the fixture items (a test looks at these among whatever ships). */
const isFixtureName = (/** @type {string} */ name) => ALL_FIXTURE_NAMES.includes(name);

const KEY_MARK_FIXTURES = Object.freeze({
    section: { zz_title: { since: 3, shape: 'string ≤80', description: 'A title shown above the section. Empty hides it.' } },
    sectionStyle: { weight: { since: 3, description: 'The weight of the text in the section band.' } },
    node: { zz_styleWhen: { since: 3, shape: '[{ when: formula, style: { <knob>: value } }]', description: 'Style overrides applied while a formula is true.' } },
    nav: {
        zz_footer: { since: 3, shape: 'string ≤120', description: 'A line of text under the navigation.' },
        style: { valuesSince: { zz_dock: 3 }, shape: 'tabs|sidebar|mega|rail|zz_dock', description: 'zz_dock pins the screens to the bottom edge.' },
    },
    navGroup: { zz_badge: { since: 3, shape: 'formula', description: 'A count shown beside the group label.' } },
    binding: {
        zz_expand: {
            since: 3, kinds: ['record', 'records'], shape: '[<relation field key>] ≤5', description: 'Related rows a read takes along.',
            clean: (/** @type {unknown} */ v) => (Array.isArray(v) ? v.filter((name) => typeof name === 'string' && name).slice(0, 5) : undefined),
        },
        zz_having: {
            since: 3, kinds: ['aggregate'], holds: 'filter', shape: '[clause]', description: 'A filter on the groups of an aggregate.',
            clean: (/** @type {unknown} */ v) => (Array.isArray(v) ? v : undefined),
        },
    },
    queryShape: {
        'filter.zz_all': {
            since: 3, shape: '{ "zz_all": [clause, …] }', description: 'A group whose clauses must all match.',
            uses: (/** @type {unknown} */ list) => Array.isArray(list) && list.some((entry) => entry !== null && typeof entry === 'object' && Array.isArray(entry.zz_all)),
        },
        'groupBy.zz_step': {
            since: 3, entryKey: true, shape: 'number > 0', description: 'The width of a number bin.',
            clean: (/** @type {unknown} */ v) => (typeof v === 'number' && v > 0 ? v : undefined),
        },
    },
});

const DATA_MARK_FIXTURES = Object.freeze({
    fieldTypes: { zz_money: { since: 3, description: 'An amount with its currency. Stored as a number of cents.' } },
    fieldOptions: { zz_mask: { since: 3, shape: 'string ≤40', description: 'An input mask for a text field.' } },
    filterOps: { zz_near: { since: 3, description: 'Matches values within a distance of the given one.' } },
    aggFns: { zz_median: { since: 3, description: 'The middle value of the group.' } },
    dateBuckets: { zz_fortnight: { since: 3, description: 'Two-week periods, starting on a Monday.' } },
});

/**
 * The shipped data-vocabulary marks with the fixtures' added to them, per family: the overlay
 * replaces the mark table, so a word a feature marked must stay marked while the fixtures are in.
 */
function fixtureDataMarks() {
    const { DATA_VOCABULARY_MARKS } = require('../core/dataEngine/dataModel/vocabularySince');
    /** @type {Record<string, Record<string, any>>} */
    const out = {};
    for (const family of new Set([...Object.keys(DATA_VOCABULARY_MARKS), ...Object.keys(DATA_MARK_FIXTURES)])) {
        out[family] = { .../** @type {Record<string, any>} */ (DATA_VOCABULARY_MARKS)[family], .../** @type {Record<string, any>} */ (DATA_MARK_FIXTURES)[family] };
    }
    return out;
}

/** @param {Record<string, any>} spec @param {string} value @returns {() => void} the undo */
function addEnumValue(spec, value) {
    const before = spec.valuesSince;
    spec.values.push(value);
    spec.valuesSince = { ...before, [value]: 3 };
    return () => {
        spec.values.splice(spec.values.indexOf(value), 1);
        if (before) spec.valuesSince = before; else delete spec.valuesSince;
    };
}

/**
 * Put `entry` under `key`; the undo puts back what was there (a shipped entry may hold the key).
 * @param {Record<string, any>} table @param {string} key @param {unknown} entry @returns {() => void}
 */
function addKey(table, key, entry) {
    const had = Object.hasOwn(table, key);
    const before = table[key];
    table[key] = entry;
    return () => { if (had) table[key] = before; else delete table[key]; };
}

/**
 * The fixtures outside the component, knob and kind tables: the entries that can be written in
 * place, and the overlay for the frozen tables. Returns the undo.
 * @returns {() => void}
 */
function installKeyFixtures() {
    const { _setCatalogueOverlay } = require('../appStudio/catalogTiers.mts');
    const vocabulary = require('../core/dataEngine/dataModel/vocabulary');
    const { COMPONENT_SPECS, STEP_SPECS, ACTION_SPECS, SCREEN_SPEC, THEME_SPEC, DESIGN_SPEC, NAV_STYLES, SECTION_STYLE_KNOBS, KEY_MARKS } = specs;
    /** @type {Record<string, any>} */
    const columns = COMPONENT_SPECS.table.props.columns.itemShape;
    const undo = [
        addKey(columns, 'zz_note', { type: 'string', maxLen: 80, since: 3, description: 'A footnote under the column header.' }),
        addKey(columns.toneMap.itemShape, 'zz_icon', { type: 'icon', since: 3, description: 'An icon shown before the label.' }),
        addEnumValue(columns.align, 'zz_justify'),
        addKey(ACTION_SPECS.toast.fields, 'zz_sticky', { type: 'boolean', since: 3, description: 'Keeps the toast up until it is dismissed.' }),
        addEnumValue(STEP_SPECS.generate_file.fields.format, 'zz_tsv'),
        addKey(SCREEN_SPEC, 'zz_layout', { type: 'enum', values: [null, 'split'], default: null, since: 3, description: 'split = two columns of sections side by side.' }),
        addEnumValue(SCREEN_SPEC.maxWidth, 'zz_ultra'),
        addKey(THEME_SPEC, 'zz_tint', { type: 'color', optional: true, since: 3, description: 'A second brand colour for charts.' }),
        addEnumValue(THEME_SPEC.radius, 'zz_pill'),
        addEnumValue(DESIGN_SPEC.motion, 'zz_expressive'),
    ];
    // An existing type newly fires an existing event (a pairing no feature will ship).
    /** @type {Record<string, any>} */
    const divider = COMPONENT_SPECS.divider;
    const eventsBefore = { events: divider.events, eventsSince: divider.eventsSince };
    divider.events = [...(divider.events || []), 'onCardMove'];
    divider.eventsSince = { ...divider.eventsSince, onCardMove: 3 };
    undo.push(() => {
        for (const name of /** @type {const} */ (['events', 'eventsSince'])) {
            if (eventsBefore[name] === undefined) delete divider[name]; else divider[name] = eventsBefore[name];
        }
    });
    for (const [family, marks] of Object.entries(KEY_MARK_FIXTURES)) {
        for (const [key, mark] of Object.entries(marks)) {
            // A shipped mark on the same base key keeps its values: the fixture's are added to them.
            const shipped = KEY_MARKS[family][key];
            const merged = shipped && 'valuesSince' in mark ? { ...mark, valuesSince: { ...shipped.valuesSince, ...mark.valuesSince } } : mark;
            undo.push(addKey(KEY_MARKS[family], key, merged));
        }
    }
    // A knob no section takes. expandStyleKnobs remembers its answer per list, so it goes onto that answer too.
    const sectionLists = [...new Set([SECTION_STYLE_KNOBS, specs.expandStyleKnobs(SECTION_STYLE_KNOBS)])];
    for (const list of sectionLists) list.push('weight');
    undo.push(() => { for (const list of sectionLists) list.splice(list.indexOf('weight'), 1); });
    _setCatalogueOverlay({
        DESIGN_SPEC: { ...DESIGN_SPEC, zz_backdrop: { type: 'enum', values: ['none', 'dots'], default: 'none', optional: true, since: 3, description: 'A pattern behind the whole app.' } },
        NAV_STYLES: [...NAV_STYLES, 'zz_dock'],
        FIELD_TYPES: [...vocabulary.FIELD_TYPES, 'zz_money'],
        FILTER_OPS: [...vocabulary.FILTER_OPS, 'zz_near'],
        AGG_FNS: [...vocabulary.AGG_FNS, 'zz_median'],
        DATE_BUCKETS: [...vocabulary.DATE_BUCKETS, 'zz_fortnight'],
        dataMarks: fixtureDataMarks(),
    });
    return () => {
        for (const fn of undo.reverse()) fn();
        _setCatalogueOverlay(null);
    };
}

/** The schema-version catalogue with every fixture in it: the live tables plus the overlay's. */
function fixtureSinceCatalogue() {
    const since = require('../appStudio/schemaSince.mts');
    const { fullCatalogue } = require('../appStudio/catalogTiers.mts');
    const { queryValuesSince } = require('../core/dataEngine/dataModel/vocabularySince');
    const live = since.liveCatalogue();
    return { ...live, keyTables: { ...live.keyTables, design: fullCatalogue().DESIGN_SPEC }, queryValuesSince: queryValuesSince(fixtureDataMarks()) };
}

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
    const uninstallKeys = installKeyFixtures();
    _catalogueChanged();

    return function uninstall() {
        uninstallKeys();
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
            return since._withCatalogue(fixtureSinceCatalogue(), fn);
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

module.exports = { installExtensionFixtures, withExtensionFixtures, fixtureSinceCatalogue, baseToolSchemaHashes, pinnedOnly, isFixtureName, FIXTURE_NAMES, KEY_FIXTURE_NAMES, ALL_FIXTURE_NAMES, FIXTURE_KEY_ENTRY };
