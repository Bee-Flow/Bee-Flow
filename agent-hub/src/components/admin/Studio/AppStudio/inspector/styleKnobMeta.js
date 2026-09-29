/**
 * App Studio inspector — client mirror of the style-knob vocabulary.
 *
 * server/appStudio/componentSpecs.js is AUTHORITATIVE for everything in this
 * file (STYLE_KNOBS ranges, per-type styleKnobs lists, section knobs, theme
 * spec, action kinds, toast tones, input types, events). The values below are
 * mirrored verbatim so the inspector can render offline; keep them in
 * lockstep with the server file.
 */

import { KIND_OPTIONS } from './actionKindCatalog';

// Mirror of COLOR_ROLES (componentSpecs.js).
export const COLOR_ROLES = ['primary', 'neutral', 'success', 'warning', 'danger', 'info'];

// Mirror of STYLE_KNOBS (componentSpecs.js) — the closed visual vocabulary.
// Sliders take min/max/step from here; enum knobs render their `values`.
export const STYLE_KNOBS = {
    span:       { type: 'int', min: 1, max: 12, step: 1, default: 12 },
    size:       { type: 'enum', values: ['sm', 'md', 'lg'], default: 'md' },
    align:      { type: 'enum', values: ['start', 'center', 'end'], default: 'start' },
    color:      { type: 'colorOrRole', roles: COLOR_ROLES, default: null },
    radius:     { type: 'enum', values: [null, 'none', 'sm', 'md', 'lg', 'full'], default: null },
    padding:    { type: 'int', min: 0, max: 6, step: 1, default: 0 },
    gap:        { type: 'int', min: 0, max: 6, step: 1, default: 3 },
    weight:     { type: 'enum', values: ['regular', 'medium', 'semibold'], default: 'regular' },
    height:     { type: 'enum', values: ['auto', 'sm', 'md', 'lg', 'xl', 'fill'], default: 'auto' },
    background: { type: 'enum', values: ['none', 'surface', 'tint', 'panel', 'gradient'], default: 'none' },
    border:     { type: 'enum', values: ['none', 'subtle', 'default'], default: 'none' },
    // Responsive visibility — CSS-only hide per viewport band; bands mirror
    // runtime.css (sm=640, md=1024, lg=1280). hideBelow 'md' = hidden under
    // 1024px, hideAbove 'md' = hidden at 1024px and wider.
    hideBelow:  { type: 'enum', values: ['none', 'sm', 'md', 'lg'], default: 'none' },
    hideAbove:  { type: 'enum', values: ['none', 'sm', 'md', 'lg'], default: 'none' },
    // Advanced sizing — the grid owns placement, these own the box.
    widthMode:  { type: 'enum', values: ['span', 'px', 'pct'], default: 'span' },
    widthValue: {
        type: 'unitInt', modeKnob: 'widthMode', default: null,
        units: {
            px:  { min: 40, max: 2000, step: 10, default: 320 },
            pct: { min: 5,  max: 100,  step: 5,  default: 50 },
        },
    },
    heightMode: { type: 'enum', values: ['preset', 'px', 'pct', 'vh'], default: 'preset' },
    heightValue: {
        type: 'unitInt', modeKnob: 'heightMode', default: null,
        units: {
            px:  { min: 24, max: 4000, step: 10, default: 240 },
            pct: { min: 5,  max: 100,  step: 5,  default: 50 },
            vh:  { min: 5,  max: 100,  step: 5,  default: 50 },
        },
    },
};

// Mirror of ADVANCED_WIDTH_KNOBS / ADVANCED_HEIGHT_KNOBS (componentSpecs.js).
// These four are DERIVED, never listed in a type's styleKnobs: a type gets the
// width pair when it has `span` and the height pair when it has `height`, so
// TYPE_STYLE_KNOBS below stays a verbatim mirror and the lockstep test keeps
// its meaning.
export const ADVANCED_WIDTH_KNOBS = ['widthMode', 'widthValue'];
export const ADVANCED_HEIGHT_KNOBS = ['heightMode', 'heightValue'];
// Mirror of RESPONSIVE_VISIBILITY_KNOBS (componentSpecs.js) — derived from
// span, like the width pair: a type without a grid cell has nothing to hide.
export const RESPONSIVE_VISIBILITY_KNOBS = ['hideBelow', 'hideAbove'];

/**
 * What each knob is CALLED in the inspector.
 *
 * One map, deliberately: StyleSection and MultiInspector each kept their own
 * copy, both were missing `border`, and the two failed differently — the single
 * panel rendered an anonymous None/Subtle/Default control (FormField skips the
 * <label> when it gets undefined) while the multi-selection captioned it with
 * the literal string "undefined". knobLabel() falls back to the key, so the
 * next knob added to STYLE_KNOBS shows its own name rather than nothing.
 */
export const KNOB_LABELS = {
    span: 'Width',
    size: 'Size',
    align: 'Align',
    color: 'Color',
    radius: 'Corners',
    padding: 'Padding',
    gap: 'Gap',
    weight: 'Weight',
    height: 'Height',
    background: 'Background',
    border: 'Border',
    widthMode: 'Width unit',
    widthValue: 'Exact width',
    heightMode: 'Height unit',
    heightValue: 'Exact height',
    hideBelow: 'Hide below',
    hideAbove: 'Hide from',
};

export function knobLabel(knob) {
    return KNOB_LABELS[knob] || String(knob).charAt(0).toUpperCase() + String(knob).slice(1);
}

// Mirror of each type's `styleKnobs` list in COMPONENT_SPECS (componentSpecs.js).
// EVERY catalog type appears here — runtime/catalogLockstep.test.js fails the
// build when this map drifts from the server spec.
export const TYPE_STYLE_KNOBS = {
    heading:        ['span', 'align', 'color'],
    text:           ['span', 'align', 'color', 'weight', 'size'],
    button:         ['span', 'size', 'align'],
    image:          ['span', 'height', 'radius', 'align'],
    file_preview:   ['span', 'height', 'radius'],
    browser_view:   ['span'],
    divider:        ['span'],
    spacer:         ['span'],
    callout:        ['span'],
    stat:           ['span', 'size', 'align', 'color'],
    keyValue:       ['span', 'size'],
    table:          ['span', 'size'],
    list:           ['span', 'size', 'height'],
    card:           ['span', 'padding', 'gap', 'radius', 'background', 'height', 'border'],
    form:           ['span', 'gap', 'padding', 'background', 'radius', 'border'],
    input_text:     ['span', 'size'],
    input_textarea: ['span'],
    input_number:   ['span', 'size'],
    input_select:   ['span', 'size'],
    input_checkbox: ['span'],
    input_date:     ['span', 'size'],
    // v2 data & visualization
    data_grid:      ['span', 'size', 'height'],
    chart:          ['span', 'height'],
    pivot:          ['span', 'size'],
    // v2 rich inputs
    input_file:        ['span', 'size'],
    input_dataset:     ['span'],
    input_richtext:    ['span'],
    input_html:        ['span'],
    input_datetime:    ['span', 'size'],
    input_relation:    ['span', 'size'],
    input_person:      ['span', 'size'],
    input_multiselect: ['span', 'size'],
    // v2 containers
    tabs:     ['span', 'gap', 'padding', 'height'],
    tab:      ['gap', 'padding', 'height'],
    modal:    ['gap', 'padding'],
    repeater: ['span', 'gap', 'padding'],
    // v2.1 batch
    container:     ['span', 'padding', 'gap', 'background', 'radius', 'height', 'border'],
    pane:          ['span', 'padding', 'gap', 'background', 'radius', 'height', 'border'],
    page_header:   ['span', 'padding', 'gap'],
    markdown:      ['span', 'color'],
    badge_list:    ['span', 'size', 'align'],
    progress:      ['span', 'size'],
    stepper:       ['span', 'size', 'align'],
    file_gallery:  ['span', 'size', 'height'],
    connector_status: ['span', 'padding', 'background', 'radius', 'border'],
    timeline:      ['span', 'size', 'height'],
    message_thread: ['span', 'size', 'height'],
    record_detail: ['span', 'padding', 'background', 'radius', 'border', 'height'],
    filter_bar:    ['span', 'size', 'gap'],
    kanban:        ['span', 'size', 'height'],
    calendar:      ['span', 'height'],
    // AI
    ai_chat:       ['span', 'height'],
    // v2 approvals
    approval_list: ['span', 'size', 'height'],
};

// Mirror of SECTION_STYLE_KNOBS / SECTION_STYLE_DEFAULTS (componentSpecs.js).
export const SECTION_STYLE_KNOBS = ['padding', 'gap', 'background', 'height'];
export const SECTION_STYLE_DEFAULTS = { padding: 4, gap: 3, background: 'none' };

// Mirror of THEME_SPEC enums (componentSpecs.js); the preset hex list lives
// in runtime/themeVars.js (APP_COLOR_PRESETS) — import it from there.
export const THEME_ENUMS = {
    radius:     ['none', 'sm', 'md', 'lg', 'xl'],
    density:    ['compact', 'comfortable', 'spacious'],
    fontScale:  ['sm', 'md', 'lg'],
    appearance: ['light', 'dark', 'auto'],
};

// Mirror of the enum-valued SCREEN_SPEC fields (componentSpecs.js).
//
// These were AI-builder-only for a long time: updateScreen has always accepted
// the whole patch, but the only caller passed { name }. So an app defaulted to
// maxWidth 'medium' (960px) and there was no hand-editable way out of it — on a
// wide monitor the app used a third of the screen and the author could do
// nothing about it. catalogLockstep pins these against the server spec.
export const SCREEN_ENUMS = {
    maxWidth:        ['narrow', 'medium', 'wide', 'full'],
    refreshInterval: [0, 15, 30, 60, 300],
};
export const SCREEN_DEFAULTS = { maxWidth: 'medium', refreshInterval: 0, showInNav: true };

// The action kinds the inspector can wire, DERIVED from the one catalog rather
// than typed out again.
//
// This used to be a hand-maintained list of seven with a comment saying the
// rest were "authored by the AI builder, not here" — which had stopped being
// true (open_modal and sequence were both in the select), while send_email and
// close_modal were missing from the list AND from the comment. Three lists,
// three answers. actionKinds.lockstep.test.js now pins all of them, and this
// one cannot drift because it is computed.
export const ACTION_KINDS = KIND_OPTIONS.map((o) => o.value);
export const TOAST_TONES = ['info', 'success', 'warning', 'danger'];

// Full mirror of each type's `events` array in COMPONENT_SPECS — the lockstep
// test pins this against the server spec. A type absent here carries no events.
export const TYPE_EVENT_LISTS = {
    button: ['onClick'],
    list: ['onRowClick'],
    form: ['onSubmit'],
    data_grid: ['onRowClick', 'onRowSelect'],
    timeline: ['onRowClick'],
    stepper: ['onRowClick'],
    file_gallery: ['onRowClick'],
    badge_list: ['onRowClick'],
    input_select: ['onChange'],
    input_checkbox: ['onChange'],
    input_date: ['onChange'],
    input_multiselect: ['onChange'],
    // Fires once per upload batch, after the descriptor lands — the hook a form
    // uses to check a file the moment it arrives instead of at submit time.
    input_file: ['onChange'],
    // Fires when a dataset becomes the value: on pick, or on upload AFTER the
    // background ingest reaches 'ready' (an indexing dataset is not queryable).
    input_dataset: ['onChange'],
    message_thread: ['onRowClick'],
    kanban: ['onRowClick', 'onCardMove'],
    calendar: ['onRowClick'],
    // Fires with the clicked point's row (the synthetic time column stripped),
    // so a trend chart can open the reading behind a spike.
    chart: ['onRowClick'],
    // Fires after a decision lands in the in-app approvals inbox, with
    // { approvalId, decision, reason, answers, context } in the form scope.
    approval_list: ['onDecided'],
};

// Which event slot the inspector's Actions section can WIRE today. This stays
// limited to onClick/onSubmit because state/definitionOps.setNodeEvent only
// accepts those two; widening it (row/card events) needs setNodeEvent +
// ActionsSection changes — until then the AI builder wires row/card events.
export const TYPE_EVENTS = { button: 'onClick', form: 'onSubmit' };

/**
 * Mirror of FORMULA_SCOPE_ROOTS (componentSpecs.js) — every root a formula may
 * start with. The expression editor's inline autocomplete completes exactly
 * these, so what it offers is what the engine accepts.
 *
 * A mirror rather than a catalog read on purpose: the catalog arrives through
 * react-query, and requiring a QueryClientProvider around every field that
 * happens to hold a formula would push a network concern into leaf components.
 * The lockstep test pins this against the server list, so drift fails CI
 * instead of quietly changing what autocompletes.
 */
export const FORMULA_SCOPE_ROOTS = [
    'actions', 'form', 'forms', 'screen', 'vars', 'item', 'index', 'value',
    'currentUser', 'records', 'datasets', 'connectors', 'now', 'today',
];

// Mirror of INPUT_TYPES (componentSpecs.js) — types that collect a form value.
export const INPUT_TYPES = [
    'input_text', 'input_textarea', 'input_number',
    'input_select', 'input_checkbox', 'input_date',
    'input_file', 'input_dataset', 'input_richtext', 'input_html', 'input_datetime',
    'input_relation', 'input_person', 'input_multiselect',
];

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Knob list for a component type (empty array for unknown types). */
export function getKnobsForType(type) {
    return TYPE_STYLE_KNOBS[type] || [];
}

/**
 * The advanced sizing knobs a knob list earns — mirror of expandStyleKnobs()
 * in componentSpecs.js. Width refines `span`, height refines `height`, so a
 * type that cannot express the basic knob never offers the advanced one
 * (a `tab` has neither; a section has height but no span).
 */
export function advancedKnobsFor(knobs) {
    const list = Array.isArray(knobs) ? knobs : [];
    return [
        ...(list.includes('span') ? ADVANCED_WIDTH_KNOBS : []),
        ...(list.includes('height') ? ADVANCED_HEIGHT_KNOBS : []),
        ...(list.includes('span') ? RESPONSIVE_VISIBILITY_KNOBS : []),
    ];
}

/** The unit a *Value knob is measured in right now (its *Mode sibling, or the default). */
export function effectiveSizeMode(style, knobName) {
    const spec = STYLE_KNOBS[knobName];
    if (!spec || spec.type !== 'unitInt') return null;
    const modeSpec = STYLE_KNOBS[spec.modeKnob];
    const v = (style || {})[spec.modeKnob];
    return modeSpec.values.includes(v) ? v : modeSpec.default;
}

/** The min/max/step for a unitInt knob under `mode` — null when that mode carries no value. */
export function unitRange(knobName, mode) {
    const spec = STYLE_KNOBS[knobName];
    if (!spec || spec.type !== 'unitInt') return null;
    return spec.units[mode] || null;
}

/**
 * Clamp a knob value to the server's vocabulary so a bad slider event can
 * never commit an out-of-range value (the server clamps again — this just
 * keeps the live preview honest).
 *
 * `style` is only consulted for the unitInt pairs, whose legal range depends on
 * the unit their *Mode sibling names (40..2000 px vs 5..100 %).
 */
function clampUnitInt(knob, value, style) {
    if (value === null || value === undefined) return null;   // the "not set" state
    const range = unitRange(knob, effectiveSizeMode(style, knob));
    if (!range) return null;                                  // this mode carries no value at all
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return range.default;
    return Math.max(range.min, Math.min(range.max, n));
}

export function clampKnob(knob, value, style = null) {
    const spec = STYLE_KNOBS[knob];
    if (!spec) return value;
    if (spec.type === 'unitInt') return clampUnitInt(knob, value, style);
    if (spec.type === 'int') {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n)) return spec.default;
        return Math.max(spec.min, Math.min(spec.max, n));
    }
    if (spec.type === 'enum') {
        return spec.values.includes(value) ? value : spec.default;
    }
    if (spec.type === 'colorOrRole') {
        if (value == null) return null;
        if (spec.roles.includes(value)) return value;
        if (typeof value === 'string' && HEX_RE.test(value)) return value;
        return null;
    }
    return value;
}
