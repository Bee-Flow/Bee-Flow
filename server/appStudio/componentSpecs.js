/**
 * App Studio — component catalog & schema contract (single source of truth).
 *
 * Drives, without drift:
 *   - server validation   (appStudio/validate.js)
 *   - canonicalization    (appStudio/canonicalize.js — defaults, clamping)
 *   - the AI builder      (appStudio/builderPrompt/catalogRender.js)
 *   - the frontend        (served verbatim via GET /api/studio-apps/catalog;
 *                          the palette and inspector are generated from it)
 *
 * An app definition is a structured component tree — never code:
 *
 *   { schemaVersion: 2,
 *     meta:   { name, description, icon },
 *     theme:  { primary, radius, density, fontScale, appearance },
 *     homeScreenId,
 *     roles?:  [ { id, name } ],           // v2 — key references only (defs live server-side)
 *     screens: [ { id, name, icon, showInNav, maxWidth, kind?, visibleToRoles?, sections: [
 *                  { id, style, children: [node...] } ] } ],
 *     actions: { [actionId]: Action } }
 *
 *   node: { id, type, props, style, visible, onClick?/onSubmit?, children?,
 *           // v2 (all optional, additive):
 *           visibleWhen?, enabledWhen?, readOnly?, computed?, validations?, visibleToRoles? }
 *
 * SCHEMA VERSIONING — this file is the v2 contract. schemaVersion 1 defs still
 * validate/render: canonicalize accepts {1,2}, runs migrate.migrateV1toV2()
 * inline, and always emits SCHEMA_VERSION_CURRENT (2). Every v2 addition is a
 * SUPERSET of v1 — v1 defs migrate losslessly.
 *
 * Layout is a vertical stack of sections; each section is a 12-column grid
 * and children carry style.span (1–12). There are NO x/y coordinates in the
 * schema — overlapping/broken layouts are unrepresentable by construction.
 *
 * Prop value `type`s used below:
 *   string | markdown | number | boolean | enum | icon | url | color
 *   binding    — { kind:'static', value } | { kind:'actionResult', actionId, path }
 *                v2 also: { kind:'formula', expr } | { kind:'record', tableId, recordId?, path? }
 *                | { kind:'records', tableId, filter?, sort?, limit? }
 *                | { kind:'dataset', datasetId, params? }
 *   formula    — a raw expression string compiled (never executed) by the shared
 *                expr engine; its referenced roots must be in FORMULA_SCOPE_ROOTS
 *   actionRef  — id of an entry in definition.actions (stored on the NODE as
 *                onClick/onSubmit, not inside props — listed here only so the
 *                spec table knows which events a type supports)
 *   list       — array of objects; `itemShape` describes each entry
 *
 * The tables themselves live one level down, in `componentSpecs/`, a file per
 * domain — ids, limits, styleKnobs, bindings, variables, actionSpecs,
 * screenSpec, and one module per catalog family. This file is the hub: it
 * composes them and IS the public surface, so every existing
 * `require('./componentSpecs')` keeps resolving to the same objects.
 */

'use strict';

const {
    ID_PREFIXES,
    ID_RE,
    SCHEMA_VERSION_CURRENT,
    SCHEMA_VERSIONS_ACCEPTED,
    newId,
} = require('./componentSpecs/ids');
const { LIMITS } = require('./componentSpecs/limits');
const {
    HEX_RE,
    THEME_SPEC,
    THEME_PRIMARY_PRESETS,
    COLOR_ROLES,
    STYLE_KNOBS,
    ADVANCED_WIDTH_KNOBS,
    ADVANCED_HEIGHT_KNOBS,
    RESPONSIVE_VISIBILITY_KNOBS,
    expandStyleKnobs,
    unitRange,
    unitSpan,
    FIXED_HEIGHT_PRESETS,
    DEFINITE_HEIGHT_PRESETS,
    styleHeightIsDefinite,
    styleIsFill,
    CONTAINER_HEIGHT_ROUTES,
    containerHeightRoute,
    containerPassesHeightDown,
    sectionHeightIsDefinite,
} = require('./componentSpecs/styleKnobs');
const {
    BINDING_KINDS,
    INPUT_MAPPING_KINDS,
    FORMULA_SCOPE_ROOTS,
    CURRENT_USER_KEYS,
} = require('./componentSpecs/bindings');
const {
    VARIABLE_TYPES,
    VARIABLE_TYPE_DEFAULTS,
    VARIABLE_NAME_RE,
    RESERVED_VARIABLE_NAMES,
    VARIABLE_SPEC,
    coerceVariableDefault,
    seedVariableDefaults,
} = require('./componentSpecs/variables');
const {
    ACTION_KINDS,
    ACTION_SPECS,
    STEP_KINDS,
    STEP_SPECS,
    CLIENT_STEP_KINDS,
    DATA_MUTATING_STEP_KINDS,
    TOAST_TONES,
    SEND_EMAIL_FIELDS,
    CREATE_RECORD_FIELDS,
    AI_SCHEMA_FIELD_TYPES,
} = require('./componentSpecs/actionSpecs');
const {
    SCREEN_SPEC,
    EVENT_NAMES,
    SECTION_STYLE_KNOBS,
    SECTION_STYLE_DEFAULTS,
} = require('./componentSpecs/screenSpec');
const { CONTENT_SPECS } = require('./componentSpecs/contentSpecs');
const { RECORD_LIST_SPECS } = require('./componentSpecs/recordListSpecs');
const { FORM_SPECS } = require('./componentSpecs/formSpecs');
const { ANALYTICS_SPECS } = require('./componentSpecs/analyticsSpecs');
const { RICH_INPUT_SPECS } = require('./componentSpecs/richInputSpecs');
const { LAYOUT_SPECS } = require('./componentSpecs/layoutSpecs');
const { RECORD_DISPLAY_SPECS } = require('./componentSpecs/recordDisplaySpecs');
const { INTERACTIVE_SPECS } = require('./componentSpecs/interactiveSpecs');
// A leaf module, not mailboxConnector.js: this file is loaded by the mobile
// tests, and everything it requires is what ci.yml's mobile filter lists.
const { MAILBOX_TABLE_TEMPLATES } = require('./mailboxTableTemplates');

// ---------------------------------------------------------------------------
// The component catalog. v1 shipped 19 types; v2 ADDS data/chart/pivot, richer
// inputs, and container types (tabs/tab/modal/repeater) — every v1 type is
// unchanged, so v1 defs render identically. The v2.1 batch (still schema v2,
// purely additive) adds container/page_header/markdown, badge_list/progress/
// timeline/record_detail, and the interactive filter_bar/kanban/calendar.
//
// Per type:
//   label/description/category — palette + AI catalog copy
//   container — may hold children
//   isInput   — collects a value inside a form (must live inside one)
//   events    — which action refs the NODE may carry (onClick / onSubmit)
//   props     — typed prop table (defaults are what canonicalize fills in)
//   styleKnobs / defaultStyle — which knobs apply and their per-type defaults
// ---------------------------------------------------------------------------

// ── The look pass (v2.2, additive) ───────────────────────────────────────
// Every generated app used to look the same because every component had
// exactly one rendering. The `look` enums below (plus heading.accent and
// kanban.cardLook) give the display components visual REGISTERS the author —
// or the AI builder — can pick per instance. Two rules keep them safe:
//   1. IDENTITY FIRST: the first value of each enum is the default and names
//      what the component renders TODAY. The runtime emits no new class and
//      no new style for it, so a definition saved before this change stays
//      pixel-identical after canonicalize fills the prop in.
//   2. TOKENS ONLY: every non-default value is drawn from the app tokens
//      (--app-primary and friends) — no new colors, so dark mode and
//      high-contrast keep working unchanged.
// ─────────────────────────────────────────────────────────────────────────

// Null-prototype: inherited keys ("constructor", "toString", …) must never
// resolve as component types — every lookup below is a bare index access.
//
// The catalog families are composed in the order the catalog has always had —
// the key order is what the palette and the AI catalog list, so the slices are
// assigned in catalog order rather than grouped by family here.
const COMPONENT_SPECS = Object.assign(Object.create(null),
    CONTENT_SPECS,          // heading … stat
    RECORD_LIST_SPECS,      // table, list, approval_list
    FORM_SPECS,             // card, form, input_text … input_date
    ANALYTICS_SPECS,        // data_grid, chart, pivot
    RICH_INPUT_SPECS,       // input_file … input_multiselect
    LAYOUT_SPECS,           // tabs … markdown
    RECORD_DISPLAY_SPECS,   // badge_list … record_detail
    INTERACTIVE_SPECS,      // filter_bar, kanban, calendar, ai_chat
);

const COMPONENT_TYPES = Object.keys(COMPONENT_SPECS);
const CONTAINER_TYPES = COMPONENT_TYPES.filter((t) => COMPONENT_SPECS[t].container);
const INPUT_TYPES = COMPONENT_TYPES.filter((t) => COMPONENT_SPECS[t].isInput);

function getSpec(type) { return COMPONENT_SPECS[type] || null; }

/**
 * The serializable catalog served to the frontend (and rendered into the AI
 * prompt). Everything above, minus nothing — it is already plain data.
 */
function buildCatalog() {
    return {
        schemaVersion: SCHEMA_VERSION_CURRENT,
        acceptedSchemaVersions: SCHEMA_VERSIONS_ACCEPTED,
        limits: LIMITS,
        theme: THEME_SPEC,
        styleKnobs: STYLE_KNOBS,
        colorRoles: COLOR_ROLES,
        screen: SCREEN_SPEC,
        section: { styleKnobs: SECTION_STYLE_KNOBS, defaultStyle: SECTION_STYLE_DEFAULTS },
        components: COMPONENT_SPECS,
        events: EVENT_NAMES,
        actions: {
            kinds: ACTION_KINDS, specs: ACTION_SPECS, toastTones: TOAST_TONES,
            stepKinds: STEP_KINDS, stepSpecs: STEP_SPECS,
            clientStepKinds: CLIENT_STEP_KINDS, dataMutatingStepKinds: DATA_MUTATING_STEP_KINDS,
        },
        bindings: { kinds: BINDING_KINDS, inputMappingKinds: INPUT_MAPPING_KINDS, formulaScopeRoots: FORMULA_SCOPE_ROOTS },
        // `namePattern` is the regex SOURCE, not a RegExp: this object is
        // JSON.stringify'd over the wire and a RegExp serializes to {}.
        variables: {
            spec: VARIABLE_SPEC,
            types: VARIABLE_TYPES,
            typeDefaults: VARIABLE_TYPE_DEFAULTS,
            reserved: RESERVED_VARIABLE_NAMES,
            namePattern: VARIABLE_NAME_RE.source,
            max: LIMITS.MAX_VARIABLES,
        },
        // The fixed table shapes a mailbox connector writes. Served so the
        // editor can create them WITHOUT a round-trip: every other connector
        // kind has to be run once to discover its columns, but a mailbox's
        // columns are known in advance. Requiring the run created a deadlock —
        // the connector could not be saved without a table, and the table
        // button demanded a saved connector.
        mailboxTables: MAILBOX_TABLE_TEMPLATES,
    };
}

/** A minimal valid empty app (used by POST / and by the AI builder's first persist). */
function emptyDefinition(name = 'Untitled app') {
    const screenId = newId('screen');
    return {
        schemaVersion: SCHEMA_VERSION_CURRENT,
        meta: { name, description: '', icon: 'LayoutGrid' },
        theme: {
            primary: THEME_SPEC.primary.default,
            radius: THEME_SPEC.radius.default,
            density: THEME_SPEC.density.default,
            fontScale: THEME_SPEC.fontScale.default,
            appearance: THEME_SPEC.appearance.default,
        },
        homeScreenId: screenId,
        roles: [],
        screens: [{
            id: screenId,
            name: 'Home',
            icon: 'Home',
            showInNav: true,
            maxWidth: 'medium',
            sections: [{ id: newId('section'), style: { ...SECTION_STYLE_DEFAULTS }, children: [] }],
        }],
        actions: {},
    };
}

// App Design v2 (definition.design / definition.nav) — owned by
// appDesignSpec.js, re-exported here so consumers keep one spec hub.
const {
    DESIGN_SPEC,
    FONT_FAMILIES,
    NAV_STYLES,
    NAV_DEFAULT_STYLE,
    MAX_NAV_GROUPS,
    MAX_NAV_GROUP_LABEL,
} = require('./appDesignSpec');

module.exports = {
    ID_PREFIXES,
    ID_RE,
    newId,
    SCHEMA_VERSION_CURRENT,
    SCHEMA_VERSIONS_ACCEPTED,
    LIMITS,
    DESIGN_SPEC,
    FONT_FAMILIES,
    NAV_STYLES,
    NAV_DEFAULT_STYLE,
    MAX_NAV_GROUPS,
    MAX_NAV_GROUP_LABEL,
    HEX_RE,
    THEME_SPEC,
    THEME_PRIMARY_PRESETS,
    STYLE_KNOBS,
    ADVANCED_WIDTH_KNOBS,
    ADVANCED_HEIGHT_KNOBS,
    RESPONSIVE_VISIBILITY_KNOBS,
    FIXED_HEIGHT_PRESETS,
    DEFINITE_HEIGHT_PRESETS,
    CONTAINER_HEIGHT_ROUTES,
    expandStyleKnobs,
    unitRange,
    unitSpan,
    styleHeightIsDefinite,
    styleIsFill,
    containerHeightRoute,
    containerPassesHeightDown,
    sectionHeightIsDefinite,
    COLOR_ROLES,
    BINDING_KINDS,
    FORMULA_SCOPE_ROOTS,
    CURRENT_USER_KEYS,
    INPUT_MAPPING_KINDS,
    VARIABLE_TYPES,
    VARIABLE_TYPE_DEFAULTS,
    VARIABLE_NAME_RE,
    RESERVED_VARIABLE_NAMES,
    VARIABLE_SPEC,
    coerceVariableDefault,
    seedVariableDefaults,
    ACTION_KINDS,
    ACTION_SPECS,
    STEP_KINDS,
    STEP_SPECS,
    CLIENT_STEP_KINDS,
    DATA_MUTATING_STEP_KINDS,
    SEND_EMAIL_FIELDS,
    CREATE_RECORD_FIELDS,
    AI_SCHEMA_FIELD_TYPES,
    TOAST_TONES,
    SCREEN_SPEC,
    EVENT_NAMES,
    SECTION_STYLE_KNOBS,
    SECTION_STYLE_DEFAULTS,
    COMPONENT_SPECS,
    COMPONENT_TYPES,
    CONTAINER_TYPES,
    INPUT_TYPES,
    getSpec,
    buildCatalog,
    emptyDefinition,
};
