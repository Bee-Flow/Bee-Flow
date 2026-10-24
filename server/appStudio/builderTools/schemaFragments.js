// @typecheck
const { LIMITS, STYLE_KNOBS, ACTION_KINDS, STEP_KINDS, TOAST_TONES } = require('../componentSpecs');
const { APP_DESIGN_PRESETS } = require('../appDesignPresets');

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

module.exports = { MAX_COMPONENTS_PER_CALL, MAX_SEED_RECORDS, TEMP_ID_MAX, TEMP_ID_RX, MAX_BATCH_PATCHES_PER_CALL, INSPECT_CATALOG_MAX_COMPONENTS, INSPECT_CATALOG_MAX_STEPS, NODE_VALIDATION_TYPES, orList, PRESET_IDS, STYLE_HINT, SECTION_HEIGHT_MODES, unitList, SIZING_HINT, ADD_NODE_LOGIC_PROPS, UPDATE_COMPONENT_PATCH_PROPS, ACTION_OBJECT_DESC, ACTION_STEP_PROPS, ACTION_OBJECT_PROPS, ACTION_OBJECT_SCHEMA, batchHint };
