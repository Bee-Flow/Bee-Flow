/**
 * App Studio builder — function-calling tool schemas (OpenAI format).
 *
 * The apply() implementations live in ../builderTools.js; this file is the
 * single place the LLM-facing surface is declared (mirrors
 * automation/builderTools/schemas.js). Component/prop/action detail is NOT
 * repeated here — the system prompt renders the full catalog from
 * componentSpecs.js (builderPrompt/catalogRender.js); these descriptions
 * only teach the call protocol.
 *
 * LOCKSTEP RULE: every enum/value list in these schemas is DERIVED from the
 * authoritative vocabulary exports (componentSpecs.js, appDesignPresets.js,
 * dataModel.js) — never re-typed here. The section-background bug is the
 * cautionary tale: componentSpecs grew background "panel"/"gradient" but this
 * file still said ["none","surface","tint"], so the model PHYSICALLY could
 * not emit the new values and nothing anywhere failed. Deriving makes the
 * next vocabulary addition flow into the tool surface automatically;
 * builderTools.test.js pins the derivation (and the prose lists) with
 * lockstep tests. Every input below is a module constant, so TOOL_SCHEMAS
 * stays byte-stable per build (prompt-cache discipline).
 */

'use strict';

const {
    LIMITS,
    THEME_SPEC,
    DESIGN_SPEC,
    NAV_STYLES,
    MAX_NAV_GROUPS,
    MAX_NAV_GROUP_LABEL,
    STYLE_KNOBS,
    SCREEN_SPEC,
    EVENT_NAMES,
    ACTION_KINDS,
    STEP_KINDS,
    TOAST_TONES,
    VARIABLE_TYPES,
} = require('../componentSpecs');
const { APP_DESIGN_PRESETS } = require('../appDesignPresets');
const {
    FIELD_TYPES,
    FILTER_OPS,
    AGG_FNS,
    DATE_BUCKETS,
    ACCESS_MODES,
} = require('../dataModel');

// ── Call-protocol caps ───────────────────────────────────────────────
// Declared HERE (the LLM-facing surface) and imported by ../builderTools.js
// for enforcement, so the number the schema teaches and the number the tool
// rejects on can never drift apart.

const MAX_COMPONENTS_PER_CALL = 40; // top-level entries per app_add_components
const MAX_SEED_RECORDS = 25;        // rows per app_seed_records call
const TEMP_ID_MAX = 25;             // tempId handle length
const TEMP_ID_RX = new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${TEMP_ID_MAX - 1}}$`);

// app_update_component / app_set_action / app_bind_action also take a BATCH
// form (an array of patches). Derived from MAX_COMPONENTS_PER_CALL rather than
// re-typed, so the whole mutating surface teaches ONE batching ceiling: a
// builder that has learned "40 per call" for components does not have to
// rediscover a different number for updates, actions and wiring.
const MAX_BATCH_PATCHES_PER_CALL = MAX_COMPONENTS_PER_CALL;

// app_inspect_catalog: how many full entries one call may expand. A data_grid
// entry is ~2.5k chars; eight of them is the whole compact section again.
const INSPECT_CATALOG_MAX_COMPONENTS = 8;
const INSPECT_CATALOG_MAX_STEPS = 6;

// Node-level validation rule types. validate.js owns the authoritative list
// (VALIDATION_TYPES) but does not export it; builderTools.test.js pins this
// copy against the validator's own rejection message so the two cannot drift.
const NODE_VALIDATION_TYPES = ['required', 'format', 'minLength', 'formula'];

/** Render a value list for a description: "a"|"b" / 0|15|30. */
const orList = (values) => values.map((v) => JSON.stringify(v)).join('|');

const PRESET_IDS = APP_DESIGN_PRESETS.map((p) => p.id);

const STYLE_HINT = `Style knobs are a closed vocabulary per component (see the catalog); the most important is span (${STYLE_KNOBS.span.min}-${STYLE_KNOBS.span.max} grid columns inside the section).`;

// ── Advanced sizing (DERIVED availability) ───────────────────────────
//
// widthMode/widthValue and heightMode/heightValue are in STYLE_KNOBS but in no
// type's `styleKnobs` array: componentSpecs.expandStyleKnobs() gives a type the
// width pair when it has `span` and the height pair when it has `height`, so
// node styles (a free-form object here) already accept them end to end. The
// SECTION style is the one place this file enumerates keys, so it is the one
// place the pair has to be declared — and the one place a mode has to be
// SUBTRACTED: a section is a flex item in the screen's auto-height stack, so
// "pct" has nothing to be a percentage of. canonicalize repairs it back to
// "preset" and validate rejects it; teaching it here would only produce calls
// that get repaired. Derived by filtering, never re-typed, so a new height unit
// in componentSpecs reaches sections automatically.
const SECTION_ILLEGAL_HEIGHT_MODES = ['pct'];
const SECTION_HEIGHT_MODES = STYLE_KNOBS.heightMode.values.filter((m) => !SECTION_ILLEGAL_HEIGHT_MODES.includes(m));

/** "px 24-4000, vh 5-100" — the per-unit windows of a unitInt knob, optionally narrowed to `modes`. */
const unitList = (knobName, modes = null) => Object.entries(STYLE_KNOBS[knobName].units)
    .filter(([unit]) => !modes || modes.includes(unit))
    .map(([unit, r]) => `${unit} ${r.min}-${r.max}`)
    .join(', ');

/** `"px"/"pct"` — the modes that are an escape hatch, i.e. every one but the default. */
const escapeModes = (knobName) => STYLE_KNOBS[knobName].values
    .filter((m) => m !== STYLE_KNOBS[knobName].default)
    .map((m) => JSON.stringify(m))
    .join('/');

const SIZING_HINT = `Beyond span, a component that has span also takes style.widthMode ${escapeModes('widthMode')} + widthValue (${unitList('widthValue')}) and — if it has height — style.heightMode ${escapeModes('heightMode')} + heightValue (${unitList('heightValue')}). span still places the CELL; the value sizes the box INSIDE it. Spans stay right for almost everything: reach for these only when a column count cannot say it (a 240px rail, a square tile, a 400px map), and never put a fixed px WIDTH on anything holding text.`;

// ── Node logic fields (siblings of props/style on any component) ─────
//
// These are NOT props: they live on the node itself and are the only way to
// make a component whose props are plain strings (heading, text, button,
// callout, page_header, …) show a LIVE value. `computed` overrides any prop
// with a formula every render; the When-flags gate visibility/enablement;
// `validations` attaches input rules. All four were already canonicalized,
// validated and rendered — they were simply missing from this surface, so the
// model could not reach them and concluded live text was impossible.
const COMPUTED_DESC = 'Make ANY prop live: { "<propKey>": "<formula expr>" | {kind:"formula",expr} }. The formula overrides that prop on every render (the authored props value stays as the fallback), e.g. { "text": "concat(\'Total: \', toStr(vars.total))" } on a heading. This is how components with no binding-typed prop show a running value.';
const VALIDATIONS_DESC = `Form-input rules: [{ type: ${orList(NODE_VALIDATION_TYPES)}, value?: <int for minLength>, format?: <string for format>, expr?: <formula for formula>, message?: <what the user is told> }] (max ${LIMITS.MAX_VALIDATIONS_PER_FIELD}). Only components that are form inputs enforce them.`;
// Typed `string` (a boolean is accepted too — shared.normalizeLogicValue reads
// both). A property with NO type renders as `properties:{}` on Gemma's chat
// template, and a `type:[...]` union renders as the literal list.
const READ_ONLY_DESC = 'Show the value but block editing: "true"/"false" or a formula expression string (e.g. "vars.locked == true").';

/** The node-logic block for app_add_components entries. */
const ADD_NODE_LOGIC_PROPS = {
    visibleWhen: { type: 'string', description: 'Optional formula expression gating visibility, e.g. "form.email != \'\'" or "currentUser.id == item.created_by". Compiled, never executed as code.' },
    enabledWhen: { type: 'string', description: 'Optional formula expression gating whether the component is enabled (inputs/buttons).' },
    readOnly: { type: 'string', description: READ_ONLY_DESC },
    visibleToRoles: { type: 'array', items: { type: 'string' }, description: 'Optional role keys (from definition.roles) that may see this component.' },
    computed: { type: 'object', description: COMPUTED_DESC },
    validations: { type: 'array', items: { type: 'object' }, description: VALIDATIONS_DESC },
};

/** The same block for app_update_component patches, where null CLEARS. */
const UPDATE_NODE_LOGIC_PROPS = {
    visibleWhen: { type: 'string', description: 'Formula expression gating visibility (pass null to clear), e.g. "vars.showDetails == true".' },
    enabledWhen: { type: 'string', description: 'Formula expression gating enablement (pass null to clear).' },
    readOnly: { type: 'string', description: `${READ_ONLY_DESC} Pass null to clear.` },
    visibleToRoles: { type: 'array', items: { type: 'string' }, description: 'Role keys that may see this component (pass null to clear).' },
    computed: { type: 'object', description: `${COMPUTED_DESC} REPLACES the whole computed map (pass null to clear).` },
    validations: { type: 'array', items: { type: 'object' }, description: `${VALIDATIONS_DESC} Replaces the whole list (pass null to clear).` },
};

/** The per-component patch shape shared by app_update_component's two forms. */
const UPDATE_COMPONENT_PATCH_PROPS = {
    id: { type: 'string', description: 'The component id (cmp_…).' },
    props: { type: 'object', description: 'Prop patch (merged into the existing props).' },
    style: { type: 'object', description: `Style patch (merged into the existing style). The advanced sizing knobs patch like any other: to drop a component back to its column span / height preset, send { widthMode: "${STYLE_KNOBS.widthMode.default}", widthValue: null } / { heightMode: "${STYLE_KNOBS.heightMode.default}", heightValue: null } — the mode alone leaves the number behind as an inert value.` },
    visible: { type: 'boolean', description: 'Show/hide the component.' },
    ...UPDATE_NODE_LOGIC_PROPS,
};

const ACTION_OBJECT_DESC = `{ kind, …fields of that kind } — shapes: catalog Actions / Sequence steps. SAVE A FORM: {kind:"sequence", steps:[{kind:"create_record", tableId, values:{<fieldKey>:{kind:"formula",expr:"form.<inputName>"}}}, {kind:"refresh", tableId}, {kind:"toast", message}]} wired to the form's onSubmit. {kind:"field"} exists ONLY in run_automation inputMapping. A sequence has no onError/onSuccess.`;

// The action object's declared shape. An object with NO `properties` renders
// as `properties:{}` on Gemma's chat template — the model was shown an empty
// box and wrote whatever it guessed into it. This block is deliberately
// MINIMAL (the kind enum, the step-kind enum, the fields every common step
// carries); the full per-kind field lists stay in the catalog, and
// actionNormalise.repairAction keeps reading whatever arrives.
const ACTION_STEP_PROPS = {
    kind: { type: 'string', enum: [...STEP_KINDS] },
    tableId: { type: 'string', description: 'tbl_… id (record steps, refresh).' },
    recordId: { type: 'object', description: 'update/delete_record: a binding, e.g. {kind:"formula",expr:"form.item.id"}.' },
    values: { type: 'object', description: '{ <fieldKey>: {kind:"formula",expr:"form.<inputName>"} | {kind:"static",value} } (create/update_record).' },
    message: { type: 'string', description: 'toast / confirm text.' },
    tone: { type: 'string', enum: [...TOAST_TONES] },
    screenId: { type: 'string', description: 'navigate: scr_… id.' },
    form: { type: 'string', description: 'reset_form: the form\'s props.name.' },
    modalId: { type: 'string', description: 'open_modal / close_modal: the modal cmp_… id.' },
    resultVar: { type: 'string', description: 'Server steps: variable name the result is written to.' },
    automationId: { type: 'string', description: 'run_automation: the automation id.' },
    inputMapping: { type: 'object', description: 'run_automation: { <param>: {kind:"static",value} | {kind:"field",name,formId?} }.' },
};
const ACTION_OBJECT_PROPS = {
    kind: { type: 'string', enum: [...ACTION_KINDS] },
    steps: {
        type: 'array',
        description: 'sequence only: the steps, in order.',
        items: { type: 'object', properties: ACTION_STEP_PROPS, required: ['kind'] },
    },
    // nullable, like actionId: the prompt says "automationId:null" for a
    // automation the user connects later, and a template that renders nullable
    // (Gemma) should show it beside a string type, not contradict the prose.
    automationId: { type: 'string', nullable: true, description: 'run_automation: the automation id (null until the user connects one).' },
    inputMapping: { type: 'object', description: 'run_automation: { <param>: {kind:"static",value} | {kind:"field",name,formId?} }.' },
    screenId: { type: 'string', description: 'navigate: scr_… id.' },
    params: { type: 'object', description: 'navigate: { <key>: {kind:"static",value}|{kind:"formula",expr} } → screen.params.<key>.' },
    message: { type: 'string', description: 'toast text.' },
    tone: { type: 'string', enum: [...TOAST_TONES] },
    modalId: { type: 'string', description: 'open_modal / close_modal: the modal cmp_… id.' },
    url: { type: 'string', description: 'open_url: https URL.' },
};
const ACTION_OBJECT_SCHEMA = { type: 'object', description: ACTION_OBJECT_DESC, properties: ACTION_OBJECT_PROPS, required: ['kind'] };

/** How each batch-capable tool tells the model about its array form. */
const batchHint = (key, single) => `BATCH FORM: pass \`${key}\` — an array of up to ${MAX_BATCH_PATCHES_PER_CALL} ${single} objects applied in order — instead of the single form, and do a whole screen's worth of work in ONE call. Each entry that fails is reported at its index in \`failed\` and the others still land.`;

const TOOL_SCHEMAS = [
    {
        type: 'function',
        function: {
            name: 'app_set_meta',
            description: 'Name the app. Call it in your FIRST call group on a new app, with app_set_plan and app_set_theme. name: in the user\'s language, 2–4 words, ≤ 40 chars (max 80), what the user would call it. description: one sentence. icon: a Lucide name such as ClipboardList, Receipt, Users, BarChart3, ShoppingCart, Calendar, FileText, Gauge.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The app\'s name (2–4 words, ≤ 40 chars; max 80).' },
                    description: { type: 'string', description: 'One sentence: what the app does.' },
                    icon: { type: 'string', description: 'Lucide icon name, e.g. "ClipboardList", "Receipt", "Users".' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_theme',
            description: 'Restyle the whole app in one call. Fastest path: pass `preset` for a complete, designed look (colour, corners, density, font, surfaces, motion AND navigation style); add individual knobs to adjust it — they win over the preset. Only pass what you want to change.',
            parameters: {
                type: 'object',
                properties: {
                    preset: {
                        type: 'string',
                        enum: PRESET_IDS,
                        description: 'A whole look at once. classic = the plain default; cloud = modern light SaaS with a sidebar; atlas = product-style mega menu; midnight = dark ops console with an icon rail; field = large, airy, mobile-first; paper = warm editorial; mono = dense expert tool.',
                    },
                    primary: { type: 'string', description: 'Primary color as #rrggbb (prefer a catalog preset; never purple/violet/indigo).' },
                    accent: { type: 'string', description: 'Call-to-action colour as #rrggbb: primary buttons and form submits paint with it, everything else stays on the primary. Unset = the primary. Pass an empty string to clear it.' },
                    canvas: { type: 'string', description: 'Page ground colour as #rrggbb — the colour behind the sections. Unset = the platform light/dark ground. Pass an empty string to clear it.' },
                    radius: { type: 'string', enum: [...THEME_SPEC.radius.values] },
                    density: { type: 'string', enum: [...THEME_SPEC.density.values] },
                    fontScale: { type: 'string', enum: [...THEME_SPEC.fontScale.values] },
                    appearance: { type: 'string', enum: [...THEME_SPEC.appearance.values], description: 'dark/light now really re-theme the app itself, whatever theme the host is on.' },
                    navStyle: { type: 'string', enum: [...NAV_STYLES], description: 'How screens are navigated. tabs = a top row; sidebar = grouped and labelled, right from ~6 screens; mega = a top bar whose groups open a panel with a description per screen (needs nav groups); rail = an icon-only sidebar.' },
                    font: { type: 'string', enum: [...DESIGN_SPEC.font.values], description: 'Typeface pairing. system = the host UI font (default).' },
                    surface: { type: 'string', enum: [...DESIGN_SPEC.surface.values], description: 'How cards, stats and grids sit on the page. soft/elevated add depth; hairline is the default outline.' },
                    motion: { type: 'string', enum: [...DESIGN_SPEC.motion.values], description: 'Animation level. Reduced-motion users always get none.' },
                    chartPalette: { type: 'string', enum: [...DESIGN_SPEC.chartPalette.values], description: 'brand derives chart colours from the primary colour.' },
                    accentEdge: { type: 'string', enum: [...DESIGN_SPEC.accentEdge.values], description: 'The coloured edge on accent cards, callouts and bar headings. bar = the default stripe; none removes it everywhere at once.' },
                    logoUrl: { type: 'string', description: 'https:// URL of a logo shown in the app chrome instead of the icon tile. Pass an empty string to remove it.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_nav_groups',
            description: 'Group the screens in the nav under labelled headings — what the "mega" and "sidebar" nav styles render as dropdowns / sections. Pass the COMPLETE list: a screen belongs to exactly one group, and the order of the groups (and of the screens inside them) is the order shown. A screen you leave out still appears in the nav, just loose beside the groups. Pass groups:null to ungroup everything.',
            parameters: {
                type: 'object',
                required: ['groups'],
                properties: {
                    groups: {
                        type: 'array',
                        description: `Up to ${MAX_NAV_GROUPS} groups, in nav order. Omit ids to have them minted.`,
                        items: {
                            type: 'object',
                            required: ['label', 'screens'],
                            properties: {
                                id: { type: 'string', description: 'Existing group id (nvg_...) — keep it to preserve a group across edits.' },
                                label: { type: 'string', description: `The heading shown in the nav (max ${MAX_NAV_GROUP_LABEL} chars).` },
                                icon: { type: 'string', description: 'Lucide icon name, e.g. "BarChart3", "Settings".' },
                                screens: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Screen ids (scr_...) in the order they should appear under the heading.',
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_add_screen',
            description: 'Add a new screen (a page). Returns { screenId, sectionId } — the sectionId is the screen\'s first (empty) section, ready for app_add_components. Navigation is automatic: every screen with showInNav appears in the app\'s nav.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Screen name (labels the nav entry).' },
                    icon: { type: 'string', description: 'Lucide icon name for the nav entry.' },
                    description: { type: 'string', description: 'One line (≤120 chars) saying what the screen is for — shown in the mega menu, the mobile drawer and the collapsed sidebar. Write it for every screen.' },
                    showInNav: { type: 'boolean', description: 'Show in the app navigation (default true). Use false for detail/thanks screens reached via actions.' },
                    maxWidth: { type: 'string', enum: [...SCREEN_SPEC.maxWidth.values], description: `Content width (default ${SCREEN_SPEC.maxWidth.default}).` },
                    refreshInterval: { type: 'number', enum: [...SCREEN_SPEC.refreshInterval.values], description: "Seconds between background refreshes of this screen's data; 0 = off. Use 30 for an inbox-style screen." },
                    visibleToRoles: { type: 'array', items: { type: 'string' }, description: 'Role keys (from app_set_roles) that may open this screen. Omit or leave empty for everyone. Gates the whole screen including its nav entry — the coarse control that belongs on an admin-only page.' },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_update_screen',
            description: 'Change a screen\'s settings in place (name, icon, nav visibility, width) and/or make it the home screen.',
            parameters: {
                type: 'object',
                properties: {
                    screenId: { type: 'string', description: 'The screen id (scr_…).' },
                    name: { type: 'string' },
                    icon: { type: 'string' },
                    description: { type: 'string', description: 'One line (≤120 chars) saying what the screen is for. Pass an empty string to remove it.' },
                    showInNav: { type: 'boolean' },
                    maxWidth: { type: 'string', enum: [...SCREEN_SPEC.maxWidth.values] },
                    refreshInterval: { type: 'number', enum: [...SCREEN_SPEC.refreshInterval.values] },
                    visibleToRoles: { type: 'array', items: { type: 'string' }, description: 'Role keys that may open this screen (pass an empty array to clear the restriction).' },
                    makeHome: { type: 'boolean', description: 'Set this screen as the app\'s home screen (homeScreenId).' },
                },
                required: ['screenId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_remove_screen',
            description: 'Delete a screen. An app must keep at least one screen; homeScreenId is repointed automatically. Actions that navigated to the removed screen must be fixed or removed.',
            parameters: {
                type: 'object',
                properties: { screenId: { type: 'string' } },
                required: ['screenId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_add_section',
            description: 'Add an empty section (a 12-column grid row) to a screen. Returns { sectionId }. Screens are a vertical stack of sections; use several sections to separate header / form / results areas.',
            parameters: {
                type: 'object',
                properties: {
                    screenId: { type: 'string' },
                    index: { type: 'number', description: 'Insert position among the screen\'s sections (omit to append).' },
                    style: {
                        type: 'object',
                        description: `Section style: { padding ${STYLE_KNOBS.padding.min}-${STYLE_KNOBS.padding.max}, gap ${STYLE_KNOBS.gap.min}-${STYLE_KNOBS.gap.max}, background ${orList(STYLE_KNOBS.background.values)}, height ${orList(STYLE_KNOBS.height.values)}, heightMode ${orList(SECTION_HEIGHT_MODES)} + heightValue (${unitList('heightValue', SECTION_HEIGHT_MODES)}) }. background "panel" = a recessed grouping surface, "gradient" = a soft wash from the app primary. height "fill" makes the section take the whole screen height — combine it with two pane components for a sidebar + detail layout that scroll independently. heightMode overrides the preset for an EXACT section height: "px" for a fixed band, "vh" for a share of the viewport ("vh" 50 = half the screen). A section can never take "pct" — it is auto-height in the screen's stack, so a percentage has nothing to measure.`,
                        properties: {
                            padding: { type: 'number' },
                            gap: { type: 'number' },
                            background: { type: 'string', enum: [...STYLE_KNOBS.background.values] },
                            height: { type: 'string', enum: [...STYLE_KNOBS.height.values] },
                            heightMode: { type: 'string', enum: [...SECTION_HEIGHT_MODES] },
                            heightValue: { type: 'number' },
                        },
                    },
                },
                required: ['screenId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_update_section',
            description: 'Restyle an existing section. Sections could only ever be styled at creation, so a section whose components have moved elsewhere kept its padding and rendered as a band of empty space nothing could close.',
            parameters: {
                type: 'object',
                properties: {
                    sectionId: { type: 'string', description: 'The section id (sec_…) to restyle.' },
                    style: {
                        type: 'object',
                        description: 'The same style knobs app_add_section takes; only the keys you pass are changed.',
                        properties: {
                            padding: { type: 'number' },
                            gap: { type: 'number' },
                            background: { type: 'string', enum: [...STYLE_KNOBS.background.values] },
                            height: { type: 'string', enum: [...STYLE_KNOBS.height.values] },
                            heightMode: { type: 'string', enum: [...SECTION_HEIGHT_MODES] },
                            heightValue: { type: 'number' },
                        },
                    },
                },
                required: ['sectionId', 'style'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_add_components',
            description: `Add one or MANY components in a single call — always prefer one batched call over serial calls. \`parentId\` is a section id (sec_…) or a container component id (card/form cmp_…). Containers take nested \`children\` trees in the same entry shape, so a whole form (inputs included) lands in ONE call. Give entries a \`tempId\` handle to read their real ids from the result (\`ids\` map) — e.g. the form node you will wire with app_bind_action. Entries belong in \`components[]\` only — never a type or children at the root, and never resend a batch that already landed (its ids are in the result). ${STYLE_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    parentId: { type: 'string', description: 'Section id or container component id the components go into. The key is parentId (not sectionId) — the `sectionId` app_add_screen returns IS the value to pass here.' },
                    index: { type: 'number', description: 'Insert position among the parent\'s children (omit to append).' },
                    components: {
                        type: 'array',
                        description: `Component entries, applied in order (max ${MAX_COMPONENTS_PER_CALL} top-level entries per call).`,
                        items: {
                            type: 'object',
                            properties: {
                                tempId: { type: 'string', description: `Optional handle ([A-Za-z][A-Za-z0-9_]*, max ${TEMP_ID_MAX} chars) to look up the real id in the result's \`ids\` map.` },
                                type: { type: 'string', description: 'A component type from the catalog (heading, text, button, form, input_text, table, …).' },
                                props: { type: 'object', description: 'Props per the catalog\'s prop table for this type. Missing props are filled with spec defaults.' },
                                style: { type: 'object', description: `Style knobs per the catalog (span 1-12, size, align, …). ${SIZING_HINT}` },
                                children: { type: 'array', items: { type: 'object' }, description: 'Containers (card/form) only: nested component entries in this same shape.' },
                                ...ADD_NODE_LOGIC_PROPS,
                            },
                            required: ['type'],
                        },
                    },
                },
                required: ['parentId', 'components'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_update_component',
            description: `Edit existing components IN PLACE — props/style are shallow-MERGED (only the keys you pass change), keeping ids and wiring. Never remove + re-add a component just to tweak it. ${batchHint('updates', 'patch')}`,
            parameters: {
                type: 'object',
                properties: {
                    ...UPDATE_COMPONENT_PATCH_PROPS,
                    updates: {
                        type: 'array',
                        description: `Batch form: up to ${MAX_BATCH_PATCHES_PER_CALL} patches, each in the same shape as the single form ({ id, props?, style?, visible?, … }). Pass this OR the single-component fields, never both.`,
                        items: {
                            type: 'object',
                            properties: { ...UPDATE_COMPONENT_PATCH_PROPS },
                            required: ['id'],
                        },
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_move_node',
            description: 'Move a component to another parent (section or container) and/or position. `index` addresses the destination children AFTER the node is lifted out.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The component id to move.' },
                    toParentId: { type: 'string', description: 'Destination section id or container component id.' },
                    index: { type: 'number', description: 'Position among the destination children (omit to append).' },
                },
                required: ['id', 'toParentId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_remove_node',
            description: 'Delete a component (and, for containers, its whole subtree).',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_action',
            description: `Create or update named actions. Omit \`actionId\` to create (the result returns the new id); pass an existing id to update it in place. Actions are the app's behaviours — wire them onto buttons/forms with app_bind_action, and bind their results into components via {kind:"actionResult", actionId, path} bindings. ${batchHint('actions', '{ actionId?, action }')}`,
            parameters: {
                type: 'object',
                properties: {
                    actionId: { type: 'string', description: 'Existing action id (act_…) to update; omit to create a new action.' },
                    action: ACTION_OBJECT_SCHEMA,
                    actions: {
                        type: 'array',
                        // A patch batch is PARTIAL (see runPatchBatch): failed
                        // entries are skipped, so the flat `actionId` array is
                        // the SUCCESSES packed together — position N in it is
                        // not entry N once anything has failed. Read ids off
                        // `actions[].index` instead, or a following
                        // app_bind_action batch wires the wrong action.
                        description: `Batch form: up to ${MAX_BATCH_PATCHES_PER_CALL} { actionId?, action } entries applied in order. The result's \`actions\` array pairs every real id with the \`index\` of the entry that made it — read ids from there. The flat \`actionId\` array lists ONLY the entries that succeeded, so it lines up with your entries only when \`failed\` is absent. Pass this OR the single-action fields, never both.`,
                        items: {
                            type: 'object',
                            properties: {
                                actionId: { type: 'string', description: 'Existing action id (act_…) to update; omit to create.' },
                                // Not the properties block again: the same
                                // ~3k of schema twice per menu, for a shape
                                // `action` already declares one line up.
                                action: { type: 'object', description: 'Same shape as `action`.' },
                            },
                            required: ['action'],
                        },
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_remove_action',
            description: 'Delete an action. Every onClick/onSubmit that pointed at it is unwired automatically; actionResult bindings that referenced it must be re-bound.',
            parameters: {
                type: 'object',
                properties: { actionId: { type: 'string' } },
                required: ['actionId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_bind_action',
            description: `Wire (or clear) component events to actions: a button's onClick, a form's onSubmit, a table/timeline's onRowClick/onRowSelect, a kanban's onCardMove, or a discrete input's onChange (select/checkbox/date — fires when the value changes). The action must already exist (app_set_action first). Pass actionId null to unwire. Each component type supports only the events its catalog entry lists. ${batchHint('bindings', '{ nodeId, event, actionId }')}`,
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'The component id carrying the event (e.g. a button for onClick, a form for onSubmit, a kanban for onCardMove).' },
                    event: { type: 'string', enum: [...EVENT_NAMES] },
                    // `type: ['string','null']` renders as the literal list
                    // ['STRING', 'NULL'] on Gemma's template; `nullable` is the
                    // form every template renders.
                    actionId: { type: 'string', nullable: true, description: 'Action id (act_…); null to unwire.' },
                    bindings: {
                        type: 'array',
                        description: `Batch form: up to ${MAX_BATCH_PATCHES_PER_CALL} { nodeId, event, actionId } entries applied in order — wire a whole keypad in ONE call. Pass this OR the single-binding fields, never both.`,
                        items: {
                            type: 'object',
                            properties: {
                                nodeId: { type: 'string', description: 'The component id carrying the event.' },
                                event: { type: 'string', enum: [...EVENT_NAMES] },
                                actionId: { type: 'string', nullable: true, description: 'Action id (act_…); null to unwire.' },
                            },
                            required: ['nodeId', 'event', 'actionId'],
                        },
                    },
                },
            },
        },
    },
    // ── Data engine (per-app database) ─────────────────────────────
    {
        type: 'function',
        function: {
            name: 'app_set_plan',
            description: 'Record (and update) your own to-do list for building this app, shown to the user as a live checklist on the canvas. Call it with `todos` bundled with your FIRST build call for any build of more than one call; later bundle the cheap `markDone` diff form with the calls that complete an item. NEVER send this tool as your only call in a reply. It does not change the app.',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        description: 'The full ordered checklist (replaces the previous one). Use for the initial plan or a restructure.',
                        items: { type: 'object', properties: { text: { type: 'string', description: 'Short task description.' }, done: { type: 'boolean', description: 'true once completed.' } }, required: ['text'] },
                    },
                    markDone: {
                        type: 'array',
                        items: { type: 'integer' },
                        description: '0-based indices of existing todos to flip done:true. Cheaper than resending todos — use this for progress updates, bundled with your next build call.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_link_datatable',
            description: 'Link an EXISTING Studio table — a Nextcloud Tables mirror the owner set up in Studio > Datatables, or any organisation table — into this app by name, key or id. Its rows stay where they are and the app reads them LIVE; the result carries the tbl_ id and the exact field keys to bind ("Excl. btw" is stored as excl_btw). Prefer this over app_upsert_table whenever the ask names a table that already exists (for example one an automation fills). Never seed a linked table. Calling it again for the same table refreshes its field copy — it never makes a second table.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The table\'s title as shown in Studio > Datatables (case-insensitive), e.g. "Facturen". Use when you do not know the id.' },
                    key: { type: 'string', description: 'The table\'s key, e.g. "facturen".' },
                    datatableId: { type: 'string', description: 'The Studio table id (tbl_…) when you know it.' },
                    mode: { type: 'string', enum: ['read', 'readwrite'], description: 'read (default): the app only reads. readwrite: record actions write back to the source table (needs editor access).' },
                    tableKey: { type: 'string', description: 'Optional key for the table inside this app (lowercase snake_case). Defaults to the source table\'s key.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_upsert_table',
            description: 'Create or evolve ONE data table in the app\'s database (the app\'s OWN storage — for a table that already exists in Studio use app_link_datatable instead). Omit `tableId` to create; pass an existing tbl_… id to evolve it. `fields` is the table\'s COMPLETE field list: existing fields are matched by fieldId (or by key) and keep their stable ids; fields you leave out are DROPPED with their column data. Returns the real tbl_/fld_ ids to use in bindings and app_seed_records, plus a migration summary. DDL limits: a field\'s type can never be converted in place (add a new field instead), and a required field added to a populated table needs a `default` to backfill.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: 'string', description: 'Existing table id (tbl_…) to evolve; omit to create a new table.' },
                    key: { type: 'string', description: 'Physical table key: lowercase snake_case, starts with a letter (e.g. "tasks"). Derived from `name` when omitted on create; pass a new key on evolve to RENAME the table.' },
                    name: { type: 'string', description: 'Human table name (e.g. "Tasks") — on create, the key is derived from it when you give none.' },
                    icon: { type: 'string', description: 'Lucide icon name for the table.' },
                    fields: {
                        type: 'array',
                        description: 'The COMPLETE field list, in order.',
                        items: {
                            type: 'object',
                            properties: {
                                fieldId: { type: 'string', description: 'Existing field id (fld_…) — pass it to rename a field (same id, new key). Omit for new fields; same-key fields match automatically.' },
                                key: { type: 'string', description: 'Column key: lowercase snake_case (derived from `name` when omitted). Never a system column (id, created_at, updated_at, created_by, org_id — those exist automatically).' },
                                name: { type: 'string', description: 'Human label (defaults to the key; a key is derived from it when the key is omitted).' },
                                type: { type: 'string', enum: [...FIELD_TYPES] },
                                subtype: { type: 'string', description: 'number only: "integer" for whole numbers.' },
                                required: { type: 'boolean' },
                                unique: { type: 'boolean' },
                                default: { type: 'string', description: 'Default for new records, written as a string and read by the field\'s type: "false" on a bool, "0" on a number, "2026-01-01" on a date (a JSON boolean or number is accepted too); also backfills when adding a required field to a populated table.' },
                                options: { type: 'array', items: { type: 'string' }, description: 'select/multiselect: the allowed values (strings; {value,label} objects are accepted too).' },
                                relation: {
                                    type: 'object',
                                    description: 'relation only: the table this field points at.',
                                    properties: {
                                        tableId: { type: 'string', description: 'Target table id (tbl_…) — must already exist in the model (create parent tables first).' },
                                        displayFieldKey: { type: 'string', description: 'Which field on the target table labels each record.' },
                                    },
                                    required: ['tableId'],
                                },
                                computed: {
                                    type: 'object',
                                    description: 'computed only: a SQL expression over this table\'s columns.',
                                    properties: {
                                        expr: { type: 'string' },
                                        type: { type: 'string', description: 'Result type: "number", "integer" or "text" (default).' },
                                        // Without this key the tool could not express a stored
                                        // computed column at all — and because unknown keys are
                                        // dropped, re-sending an existing table through this tool
                                        // silently DOWNGRADED one to read-time. Everything that
                                        // filtered or aggregated on it then failed with "is a
                                        // read-time computed field and cannot be queried", from a
                                        // call whose only intent was to edit a different field.
                                        stored: { type: 'boolean', description: 'true materialises a real column, so the field can be FILTERED, SORTED and AGGREGATED on (a read-time expression can only be read). Set at table creation; adding one to a populated table backfills it.' },
                                    },
                                    required: ['expr'],
                                },
                            },
                            required: ['key', 'type'],
                        },
                    },
                    access: {
                        type: 'object',
                        description: 'Row-level access. default: "app" (everyone with the app; use this for demo/shared data), "owner" (each user sees only their own rows), "role" (only roles listed in `roles`), "none". roles: { [roleKey]: { read: "none"|"own"|"all", create: boolean, update: …, delete: … } }. rowFilters: { [roleKey]: "<formula over row fields and viewer.*>" }.',
                        properties: {
                            default: { type: 'string', enum: [...ACCESS_MODES] },
                            roles: { type: 'object' },
                            rowFilters: { type: 'object' },
                        },
                    },
                },
                required: ['fields'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_remove_table',
            description: 'Delete a data table AND all its rows. Refused while the definition still references the table (bindings, sequence steps, relation inputs) — re-bind or remove those first.',
            parameters: {
                type: 'object',
                properties: { tableId: { type: 'string', description: 'The table id (tbl_…).' } },
                required: ['tableId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_roles',
            description: 'Define the app\'s roles in ONE call — writes both the data model\'s roles/roleMapping (drives row-level security) and the definition\'s role list (drives visibleToRoles) so they stay in lockstep. Replaces the existing role list.',
            parameters: {
                type: 'object',
                properties: {
                    roles: {
                        type: 'array',
                        description: 'The complete role list.',
                        items: {
                            type: 'object',
                            properties: {
                                key: { type: 'string', description: 'Role key: lowercase snake_case (e.g. "manager").' },
                                label: { type: 'string', description: 'Human label (e.g. "Manager").' },
                            },
                            required: ['key'],
                        },
                    },
                    orgDirectory: {
                        type: 'boolean',
                        description: 'Let this app read the organisation\'s member list, so `input_person` and the `sys_org_members` dataset can offer real colleagues. Off unless set. Only names are exposed, never e-mail, and only to people who can already open the app — but ask the user before turning it on.',
                    },
                    roleMapping: {
                        type: 'object',
                        description: 'How viewers get a role: default = the role every org member gets when not mapped explicitly (a role key); byGroup = { [groupName]: roleKey }.',
                        properties: {
                            default: { type: 'string' },
                            byGroup: { type: 'object' },
                        },
                    },
                },
                required: ['roles'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_variables',
            description: 'Declare the shared variables of this app in ONE call — the named values every formula reads as vars.<name> and set_variable / resultVar steps write. Replaces the existing list. Declare a variable BEFORE any formula reads it: an undeclared name resolves to nothing, and a records filter using it is DROPPED, so the component lists every row instead of the ones you meant. "filters" is reserved — a filter_bar component owns vars.filters.<field>.',
            parameters: {
                type: 'object',
                properties: {
                    variables: {
                        type: 'array',
                        description: `The complete variable list (max ${LIMITS.MAX_VARIABLES}).`,
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Identifier a formula can read as vars.<name>: a letter or _ first, then letters, digits or _ (e.g. "selectedTicketId").' },
                                label: { type: 'string', description: 'Human label shown in the editor.' },
                                type: { type: 'string', enum: [...VARIABLE_TYPES], description: 'What it holds.' },
                                default: { description: 'Starting value, matching the type. Seeded before anything runs, on the client AND the server, so a filter bound to it filters on first paint.' },
                                description: { type: 'string', description: 'What it holds and who writes it.' },
                            },
                            required: ['name', 'type'],
                        },
                    },
                },
                required: ['variables'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_set_public_access',
            description: 'Open ONE part of this app to anonymous visitors: name the screen(s) reachable without a login, and the app gets a public URL (/p/<token>, minted separately by its owner). Everything else stays behind the login — other screens, the nav that names them, and every action wired only there are stripped before the definition leaves the server. Anonymous visitors carry the RESERVED role "public", which is DENIED BY DEFAULT on every table: grant it explicitly per table with app_upsert_table `access.roles.public` ({create:true, read:"own"} is the usual intake shape — "own" lets a visitor see back what they themselves submitted and nothing else). The public page may carry its OWN look via `theme` / `design` (partial, merged over the app\'s when served): the form a customer fills in wears the customer\'s brand while the back office keeps the app\'s — restyling the page changes nothing about the app\'s own screens. Pass publicAccess:null to close it again. The app must be PUBLISHED for the URL to work: anonymous visitors are always served the frozen published definition.',
            parameters: {
                type: 'object',
                properties: {
                    publicAccess: {
                        type: ['object', 'null'],
                        description: 'The public surface, or null to close it.',
                        properties: {
                            entryScreenId: { type: 'string', description: 'The screen an anonymous visitor lands on (scr_…). Required.' },
                            screenIds: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Every screen they may reach, including the entry screen (which is added automatically if omitted). Prefer ONE screen with sections gated by visibleWhen over several: a multi-screen wizard can be skipped through by navigating.',
                            },
                            title: { type: 'string', description: 'Browser title for the public page. Defaults to the app name.' },
                            theme: {
                                type: 'object',
                                description: 'The public page\'s own theme, merged over the app theme. Name only what differs — e.g. { canvas: "#ffda00", accent: "#009b3e", primary: "#0064b0" } for a customer whose brand is a yellow ground, green buttons and blue headings.',
                                properties: {
                                    primary: { type: 'string', description: '#rrggbb — headings, links, progress, badges.' },
                                    accent: { type: 'string', description: '#rrggbb — primary buttons and form submits. Unset = the primary.' },
                                    canvas: { type: 'string', description: '#rrggbb — the page ground behind the sections.' },
                                    radius: { type: 'string', enum: [...THEME_SPEC.radius.values] },
                                    density: { type: 'string', enum: [...THEME_SPEC.density.values] },
                                    fontScale: { type: 'string', enum: [...THEME_SPEC.fontScale.values] },
                                    appearance: { type: 'string', enum: [...THEME_SPEC.appearance.values] },
                                },
                            },
                            design: {
                                type: 'object',
                                description: 'The public page\'s own design knobs, merged over the app design. Typically just the typeface and a logo.',
                                properties: {
                                    font: { type: 'string', enum: [...DESIGN_SPEC.font.values] },
                                    logoUrl: { type: 'string', description: 'https:// URL of the customer\'s logo.' },
                                    surface: { type: 'string', enum: [...DESIGN_SPEC.surface.values] },
                                    motion: { type: 'string', enum: [...DESIGN_SPEC.motion.values] },
                                    accentEdge: { type: 'string', enum: [...DESIGN_SPEC.accentEdge.values] },
                                    chartPalette: { type: 'string', enum: [...DESIGN_SPEC.chartPalette.values] },
                                },
                            },
                        },
                        required: ['entryScreenId'],
                    },
                },
                required: ['publicAccess'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_seed_records',
            description: `Insert sample/demo rows into a table (1-${MAX_SEED_RECORDS} per call). Each record is { fieldKey: value } using the table's field keys — system columns are filled automatically. Returns the real rec_… ids: seed PARENT tables first and use those ids as the values of relation fields in later calls. Rows that fail (unknown field, quota) are reported per-row without blocking the others.`,
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: 'string', description: 'The table id (tbl_…).' },
                    records: {
                        type: 'array',
                        description: 'Row objects, e.g. [{ title: "Fix login bug", status: "todo" }].',
                        items: { type: 'object' },
                    },
                },
                required: ['tableId', 'records'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_upsert_dataset',
            description: 'Create or update a saved dataset — a named aggregation over ONE table for charts/stats ({kind:"dataset",datasetId} bindings). Omit `datasetId` to create. The dataset is executed once immediately: the result returns a preview (first 10 rows) so you can verify it before binding.',
            parameters: {
                type: 'object',
                properties: {
                    datasetId: { type: 'string', description: 'Existing dataset id to update; omit to create.' },
                    name: { type: 'string', description: 'Dataset name (required on create).' },
                    tableId: { type: 'string', description: 'The source table id (tbl_…).' },
                    descriptor: {
                        type: 'object',
                        description: `The aggregation: groupBy?: [{field, bucket?}] (bucket for date fields: ${DATE_BUCKETS.join('|')}); aggregates: [{fn: ${AGG_FNS.join('|')}, field?, as}] (count needs no field); filters?: [{field, op, value?}] (ops: ${FILTER_OPS.join(', ')}).`,
                        properties: {
                            groupBy: { type: 'array', items: { type: 'object' } },
                            aggregates: { type: 'array', items: { type: 'object' } },
                            filters: { type: 'array', items: { type: 'object' } },
                        },
                        required: ['aggregates'],
                    },
                    cacheTtlSeconds: { type: 'number', description: 'Result cache TTL (default 60).' },
                },
                required: ['tableId', 'descriptor'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_get_data_model',
            description: 'Read the app\'s current data model: every table with its real tbl_/fld_ ids, field keys/types, row counts, datasets and roles. Use it to re-check ids before binding; the same block is also injected into the conversation each turn.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_query_data',
            description: 'Read rows from the app\'s data (owner-scoped, never mutates) — verify seeds landed, inspect real values, or check what a dataset returns. Pass tableId for raw rows (with optional filter/sort) OR datasetId for a saved aggregation.',
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: 'string', description: 'Table id (tbl_…) to list rows from.' },
                    datasetId: { type: 'string', description: 'Saved dataset id to run instead of a raw table read.' },
                    filter: {
                        type: 'array',
                        description: `Optional literal filters: [{field, op, value?}] with ops ${FILTER_OPS.join(', ')}.`,
                        items: { type: 'object' },
                    },
                    sort: { type: 'object', description: 'Optional { field, dir: "asc"|"desc" }.' },
                    limit: { type: 'number', description: 'Max rows (default 5, max 20).' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_list_connectors',
            description: "List the app's external connectors — owner-authored data sources (a platform tool, an automation, or an allow-listed REST endpoint) that a viewer can run to pull live rows. Read-only, NO arguments. Returns each connector's id (conn_…), kind, name and declared viewer params — never its pinned args, url or credentials. Wire one into a component's data prop with a { kind:\"connector\", connectorId, params? } binding (params values are literals or { kind:\"formula\", expr }). You can only WIRE connectors that already exist — you never author connectors or credentials (the app owner sets those up in the Connectors tab).",
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_list_documents',
            description: "List the DESIGNED documents the app owner made in Studio → Documents — an invoice, a quote, a letter on the company's letterhead — with the placeholders each one carries. Read-only, NO arguments. Returns [{ documentId, name, docType, placeholders:[{key, kind, fields?}] }].\n\nCall it before writing a `fill_document` step: `documentId` must be one of these (never invent one, and you cannot create a document — the owner designs it), and the keys of `values` are the placeholder names EXACTLY as listed. A placeholder of kind \"list\" must be bound to a binding that resolves to an ARRAY; its `fields` are what each item needs. If the list comes back empty, say the owner has to design the document in Studio → Documents first — do not fall back to a text export and call it an invoice.",
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_dry_run',
            description: 'Pre-flight the app before app_finalize: statically cross-checks the definition against the data model AND actually EXECUTES every record/records/dataset binding read-only (as the owner, and — with asRole — as a role) so you catch a component bound to an EMPTY table, a member who would see an empty screen, or a sequence step that writes a missing field before the user ever runs the app. Never mutates. Returns { ok, static:{errors,warnings}, bindings:[{nodeId,prop,kind,ok,rowCount|error|skipped}], roleFindings, actions, emptyTables, _hints }. Zero rows is a warning (seed data / fix the filter), not a blocker. Run it — and fix its findings — for any app with data bindings before finalizing.',
            parameters: {
                type: 'object',
                properties: {
                    screenId: { type: 'string', description: 'Limit the data pass to one screen (scr_…); omit to check every screen.' },
                    asRole: { type: 'string', description: 'Also re-run the bindings as this role key (from the data model\'s roles) to see what a member with that role would see — surfaces empty role views.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_screenshot',
            description: 'SEE the screen you just built: renders one screen of the current draft in a real headless browser — with its REAL data, read through the app\'s access rules — and returns a screenshot plus render diagnostics. Use it to catch what validation cannot: a row whose spans wrapped past 12 columns, a region rendered empty because a binding returned nothing, a chart with no bars, clipped or cramped content. If your model has vision the image is attached for you to inspect; either way the user sees it in the chat. Expensive (a real browser render) and capped per turn — take one after a batch of edits, not after every change.',
            parameters: {
                type: 'object',
                properties: {
                    screenId: { type: 'string', description: 'Screen to render (scr_…); omit for the app\'s home screen.' },
                    asRole: { type: 'string', description: 'Render — and read data — as this role key (from the data model\'s roles), exactly as a member with that role would see the screen.' },
                    viewport: { type: 'string', enum: ['desktop', 'tablet', 'mobile'], description: 'Screen width to render at (default desktop). Shoot "mobile" once per screen before finalizing: a 12-column row that reads well on a laptop wraps into a stack on a phone, and that is where cramped or clipped layouts show up.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_get_draft',
            description: 'Read the current draft as a compact ID-bearing tree (screens → sections → components, plus actions). Use when you need to re-check ids or structure; the latest draft state is also injected into the conversation each turn. On a large app read it in parts — `screenId` for one screen, or `section` for just the actions / tables / meta — instead of pulling the whole tree.',
            parameters: {
                type: 'object',
                properties: {
                    screenId: { type: 'string', description: 'Return only this screen\'s tree (scr_…). Implies section:"screens".' },
                    section: { type: 'string', enum: ['screens', 'actions', 'tables', 'meta'], description: 'Return only one part of the draft. Omit for everything.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_find_nodes',
            description: 'Search the draft for the nodes that match a query instead of reading the whole tree: by component type, by the table an action or binding touches, by an action id, or by a variable name. Returns each hit with its id, type, screen and path. Use it to answer "where is this used" and "what breaks if I remove this" — deleting a table or renaming a variable without checking is how a draft ends up with dangling references.',
            parameters: {
                type: 'object',
                properties: {
                    componentType: { type: 'string', description: 'Component type to find, e.g. "chart" or "data_grid".' },
                    tableId: { type: 'string', description: 'Find components bound to this table and actions that read or write it (tbl_…).' },
                    actionId: { type: 'string', description: 'Find components whose events run this action (act_…).' },
                    variable: { type: 'string', description: 'Find components and actions that read or write this variable name.' },
                    screenId: { type: 'string', description: 'Limit the search to one screen (scr_…).' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_list_automations',
            description: 'List the automations (automations) the app owner can wire into run_automation actions: id, title, description, active state, trigger kind, and — for agent_call automations — the input parameter names to map via inputMapping.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_inspect_automation',
            description: 'Inspect ONE automation in detail: its trigger and, for agent_call automations, the full input parameter schema — so the inputMapping you write matches the automation\'s real parameter names.',
            parameters: {
                type: 'object',
                properties: { automationId: { type: 'string' } },
                required: ['automationId'],
            },
        },
    },
    // ── Plan-first UX, phased generation & templates ───────────────
    {
        type: 'function',
        function: {
            name: 'app_propose_plan',
            description: 'Present an editable BUILD PLAN to the user and PAUSE for their approval — use this instead of building directly when the ask implies a NEW app with two or more screens OR any data model. The plan lists the tables, roles, screens, datasets, actions and the phases you will build in. The turn ends after you propose: the user reviews/edits the plan in the chat and approves it, and only THEN do you build. Do not call any other tool in the same turn as app_propose_plan. Small asks (a single screen, an edit, a fix) skip planning and build directly.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Short app title.' },
                    summary: { type: 'string', description: 'One-paragraph summary of what the app does (max 400 chars).' },
                    tables: {
                        type: 'array',
                        description: 'The data tables you will create.',
                        items: {
                            type: 'object',
                            properties: {
                                key: { type: 'string', description: 'Snake_case table key (e.g. "tasks").' },
                                name: { type: 'string', description: 'Human table name.' },
                                fields: {
                                    type: 'array',
                                    description: 'Planned fields.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            key: { type: 'string' },
                                            type: { type: 'string', description: `A field type (${FIELD_TYPES.join(', ')}).` },
                                            options: { type: 'array', items: { type: 'string' }, description: 'select/multiselect option values.' },
                                            relationTo: { type: 'string', description: 'For a relation field: the key of the table it points at.' },
                                        },
                                        required: ['key', 'type'],
                                    },
                                },
                                seedCount: { type: 'number', description: 'How many sample rows you plan to seed (0-50).' },
                            },
                            required: ['key', 'name', 'fields'],
                        },
                    },
                    roles: {
                        type: 'array',
                        description: 'The roles the app defines.',
                        items: {
                            type: 'object',
                            properties: { key: { type: 'string' }, label: { type: 'string' } },
                            required: ['key', 'label'],
                        },
                    },
                    screens: {
                        type: 'array',
                        description: 'The screens (pages) you will build.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                icon: { type: 'string', description: 'Lucide icon name.' },
                                purpose: { type: 'string', description: 'What the screen is for (max 200 chars).' },
                                contents: { type: 'array', items: { type: 'string' }, description: 'Bullet list of the key components/areas on the screen.' },
                                forRoles: { type: 'array', items: { type: 'string' }, description: 'Role keys this screen is scoped to (omit for everyone).' },
                            },
                            required: ['name', 'purpose', 'contents'],
                        },
                    },
                    datasets: {
                        type: 'array',
                        description: 'Saved aggregations for charts/stats.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                tableKey: { type: 'string', description: 'The source table key.' },
                                purpose: { type: 'string' },
                            },
                            required: ['name', 'tableKey'],
                        },
                    },
                    actions: {
                        type: 'array',
                        description: 'The behaviours (create/update records, run automations, navigate, …).',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                kind: { type: 'string' },
                                description: { type: 'string' },
                            },
                            required: ['name', 'kind'],
                        },
                    },
                    phases: {
                        type: 'array',
                        description: 'The ordered phases you will build in (data → screens → wiring → polish). A checkpoint is saved at each phase boundary so the user can revert.',
                        items: {
                            type: 'object',
                            properties: {
                                label: { type: 'string' },
                                covers: { type: 'array', items: { type: 'string' }, description: 'What this phase delivers.' },
                            },
                            required: ['label'],
                        },
                    },
                    openQuestions: { type: 'array', items: { type: 'string' }, description: 'Anything you need the user to confirm before building.' },
                    baseTemplateId: { type: 'string', description: 'When a starter template matches the ask, its id — it will be applied first on approval (call app_list_templates to discover ids).' },
                },
                required: ['title', 'summary', 'screens'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_mark_phase',
            description: 'Announce that you are starting a build phase (from the approved plan). Zero-cost: it emits progress to the user AND saves a checkpoint the user can revert to. Call it once at the start of each phase.',
            parameters: {
                type: 'object',
                properties: {
                    index: { type: 'number', description: '0-based phase index (matches the approved plan\'s phases order).' },
                    label: { type: 'string', description: 'The phase label (e.g. "Data model", "Screens", "Wiring").' },
                },
                required: ['index', 'label'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_list_templates',
            description: 'List the starter templates you can install as a data-backed starting point (id, name, description, screen and table counts). Match one to the ask, then app_apply_template it on a fresh draft and customise from there.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_apply_template',
            description: 'Install a starter template as the foundation of the app — deep-copies its screens, creates its tables, seeds sample rows and datasets in one step. VALID ONLY on a fresh, untouched draft (one empty screen, nothing built yet); on a draft you have already started building it is refused. After applying, customise with the normal tools.',
            parameters: {
                type: 'object',
                properties: {
                    templateId: { type: 'string', description: 'The template id from app_list_templates.' },
                },
                required: ['templateId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_save_as_template',
            description: 'Save THIS app as a reusable template that anyone in the organisation can start a new app from (the inverse of app_apply_template). Captures the screens, actions and data model. Automation ids are cleared and file values, system columns and relations to rows that were not captured are stripped, so the template installs clean elsewhere. Refused while the app still has validation errors. Pass the same templateId again later to save a NEW VERSION over an existing template.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Template name as it appears in the gallery (max 80 chars).' },
                    description: { type: 'string', description: 'One or two sentences on what an app made from this does.' },
                    category: { type: 'string', description: 'Gallery grouping, e.g. "Sales" or "Compliance". Defaults to "Van je team".' },
                    icon: { type: 'string', description: 'Lucide icon name, e.g. "ClipboardList". Defaults to the app\'s own icon.' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Up to 8 short search tags.' },
                    seedTables: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Table IDS (tbl_…) whose rows to ship WITH the template, up to 100 rows each. Use this ONLY for vocabulary the app needs to work — option lists, material lists, column maps. Never name a table holding customer records, e-mail bodies or personal data: those rows would be copied into every app installed from this template. Default: no rows at all.',
                    },
                    templateId: { type: 'string', description: 'Optional: the utpl_… id of a template YOU created, to replace with a new version instead of creating a second one.' },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_inspect_catalog',
            description: 'Full props/style of named component types and full field lists of named step kinds — the one-line catalog is a summary. Ask for everything you will use in ONE call, before adding them. Read-only.',
            parameters: {
                type: 'object',
                properties: {
                    components: { type: 'array', items: { type: 'string' }, description: `Component types to expand (max ${INSPECT_CATALOG_MAX_COMPONENTS}), e.g. ["data_grid", "kanban"].` },
                    steps: { type: 'array', items: { type: 'string' }, description: `Step kinds to expand (max ${INSPECT_CATALOG_MAX_STEPS}), e.g. ["request_approval", "send_email"].` },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'app_finalize',
            description: 'Finish the build: canonicalize + validate the draft and persist it. Only succeeds when the definition has NO validation errors — otherwise the structured errors come back for you to fix first. Call once, when the app is complete.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

TOOL_SCHEMAS.push(...require('../../core/documents/documentDiscovery').schemas('app'));

module.exports = {
    TOOL_SCHEMAS,
    MAX_COMPONENTS_PER_CALL,
    MAX_BATCH_PATCHES_PER_CALL,
    MAX_SEED_RECORDS,
    INSPECT_CATALOG_MAX_COMPONENTS,
    INSPECT_CATALOG_MAX_STEPS,
    ACTION_OBJECT_DESC,
    ACTION_OBJECT_PROPS,
    ACTION_STEP_PROPS,
    NODE_VALIDATION_TYPES,
    TEMP_ID_MAX,
    TEMP_ID_RX,
    // Exported for the lockstep test: the section height modes are STYLE_KNOBS'
    // minus the one a section physically cannot have. A test asserts the
    // subtraction is exactly "pct" and that canonicalize agrees, so nobody can
    // quietly widen (or narrow) what a section is offered.
    SECTION_HEIGHT_MODES,
};
