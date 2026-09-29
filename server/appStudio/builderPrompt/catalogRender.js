/**
 * App Studio builder — render componentSpecs.js into compact prompt text.
 *
 * Everything here is derived from the spec tables (componentSpecs.js for the
 * component/action/step/binding contract, dataModel.js for the data-engine
 * contract) — no hand-written copies that can drift — and is DETERMINISTIC:
 * the rendered catalog is byte-stable across process restarts, which is what
 * keeps provider prompt caches warm across builder turns (see the
 * cache-discipline note in the route). catalogRender.test.js pins both the
 * byte-stability and a prompt budget (see catalogRender.test.js).
 *
 * Two renderings share every section builder:
 *   renderCatalogText()        — the FULL catalog (cloud models, ~50k chars);
 *   renderCompactCatalogText() — the small-band catalog: every type on ONE
 *                                line, the common step kinds only, no theme /
 *                                design / variables sections (~20k chars).
 *                                The full entry of any type or step kind is
 *                                served on demand by the app_inspect_catalog
 *                                tool (renderComponentEntry / renderStepEntry).
 * The compact form is NOT filtered by brief relevance on purpose: a catalog
 * that varies per ask varies the system prompt per ask, and the local box's
 * prompt cache is a prefix cache — one byte moved and the whole ~7k-token
 * prefix is re-read.
 */

'use strict';

const {
    LIMITS,
    THEME_SPEC,
    STYLE_KNOBS,
    COLOR_ROLES,
    ACTION_KINDS,
    ACTION_SPECS,
    STEP_KINDS,
    STEP_SPECS,
    DATA_MUTATING_STEP_KINDS,
    FORMULA_SCOPE_ROOTS,
    VARIABLE_TYPES,
    VARIABLE_NAME_RE,
    RESERVED_VARIABLE_NAMES,
    TOAST_TONES,
    SCREEN_SPEC,
    SECTION_STYLE_KNOBS,
    SECTION_STYLE_DEFAULTS,
    COMPONENT_SPECS,
    DESIGN_SPEC,
    NAV_STYLES,
    NAV_DEFAULT_STYLE,
    ADVANCED_WIDTH_KNOBS,
    ADVANCED_HEIGHT_KNOBS,
} = require('../componentSpecs');
const { APP_DESIGN_PRESETS } = require('../appDesignPresets');
const {
    FIELD_TYPES,
    FILTER_OPS,
    AGG_FNS,
    DATE_BUCKETS,
    ACCESS_MODES,
    DATA_LIMITS,
    SYSTEM_COLUMNS,
    KEY_RE,
} = require('../dataModel');
// The shared expression engine, via the project's CJS re-export (same boundary
// appStudio/validate.js uses). The formula vocabulary is DERIVED from it — see
// renderFormulaFunctions.
const { EXPR_FUNCTIONS, EXPR_FUNCTION_NAMES } = require('../../automation/expr');
// The validation-rule vocabulary, from the same module that declares it to the
// tool schemas — so the catalog and the tool surface cannot teach two lists.
const { NODE_VALIDATION_TYPES } = require('../builderTools/schemas');

/**
 * The default annotation — or null for the defaults that teach nothing.
 *
 * `undefined`, `null`, `[]` and `false` all mean the same thing to the
 * builder: omit the key and the feature is simply off. Annotating them spent
 * ~2.3k chars of the prompt budget saying "absent means absent" 150+ times
 * (the Sep-2026 design wave pushed the catalog past its ceiling and this was
 * the largest pure-boilerplate line item). The convention is stated once, at
 * the top of the Components section; real defaults ("title", 25, "primary",
 * true) keep their annotation — those are the ones a model cannot guess.
 */
function fmtDefault(v) {
    if (v === undefined || v === null || v === false) return null;
    if (Array.isArray(v) && v.length === 0) return null;
    return `default ${JSON.stringify(v)}`;
}

/**
 * One compact line for a prop spec: `text: string REQUIRED ≤200 (default "Heading")`.
 * A spec that carries a `description` gets it appended after an em-dash — that
 * is where the look/accent/cardLook enums explain what each value LOOKS like
 * (striped = zebra rows, hero = a tall centered masthead, …); without it the
 * model sees only opaque enum tokens and always picks the default.
 */
function renderPropSpec(key, fs) {
    const bits = [];
    if (fs.type === 'enum') {
        bits.push(fs.values.map((v) => JSON.stringify(v)).join('|') + (fs.allowIsoDate ? '|YYYY-MM-DD' : ''));
    } else if (fs.type === 'int' || fs.type === 'number') {
        bits.push(fs.type + (fs.min !== undefined && fs.min !== null && fs.max !== undefined && fs.max !== null ? ` ${fs.min}..${fs.max}` : ''));
    } else if (fs.type === 'list') {
        const shape = Object.entries(fs.itemShape || {}).map(([ik, ifs]) => {
            const t = ifs.type === 'enum' ? ifs.values.join('|') : ifs.type;
            return `${ik}:${t}${ifs.required ? '!' : ''}`;
        }).join(', ');
        bits.push(`list of {${shape}}${fs.maxItems ? ` (max ${fs.maxItems})` : ''}`);
    } else if (fs.type === 'binding') {
        bits.push('binding');
    } else {
        bits.push(fs.type);
    }
    if (fs.required) bits.push('REQUIRED');
    if (fs.maxLen) bits.push(`≤${fs.maxLen}`);
    const d = fmtDefault(fs.default);
    if (d && fs.type !== 'binding') bits.push(`(${d})`);
    if (fs.description) bits.push(`— ${fs.description}`);
    return `${key}: ${bits.join(' ')}`;
}

/**
 * One knob token for the closed-vocabulary line.
 *
 * `unitInt` (widthValue/heightValue) renders its range PER UNIT, because that
 * is the only thing the model needs and cannot guess: the legal window depends
 * on the sibling mode knob, so a bare `widthValue` teaches nothing and a single
 * merged range would teach a lie (40..2000 is right for px and absurd for pct).
 */
function renderStyleKnob(key) {
    const knob = STYLE_KNOBS[key];
    if (knob.type === 'int') return `${key}(${knob.min}..${knob.max})`;
    if (knob.type === 'enum') return `${key}(${knob.values.map((v) => (v === null ? 'null' : v)).join('|')})`;
    if (knob.type === 'colorOrRole') return `${key}(null|role|#rrggbb)`;
    if (knob.type === 'unitInt') {
        const ranges = Object.entries(knob.units).map(([unit, r]) => `${unit} ${r.min}..${r.max}`).join(', ');
        return `${key}(int, by ${knob.modeKnob}: ${ranges})`;
    }
    return key;
}

function renderComponent(type) {
    const spec = COMPONENT_SPECS[type];
    const flags = [
        spec.container ? 'CONTAINER' : null,
        spec.isInput ? 'input(in-form)' : null,
        spec.events && spec.events.length ? `events: ${spec.events.join(', ')}` : null,
    ].filter(Boolean).join(' · ');
    const lines = [`${type} [${spec.category}]${flags ? ` — ${flags}` : ''} — ${spec.description}`];
    const props = Object.entries(spec.props);
    if (props.length) {
        lines.push(`  props: ${props.map(([k, fs]) => renderPropSpec(k, fs)).join('; ')}`);
    }
    lines.push(`  style: ${spec.styleKnobs.join(', ')}${Object.keys(spec.defaultStyle || {}).length ? ` (defaults ${JSON.stringify(spec.defaultStyle)})` : ''}`);
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Action / step field rendering — one compact fragment per field, driven by
// the same field-spec vocabulary ACTION_SPECS and STEP_SPECS use.
// ---------------------------------------------------------------------------

function renderActionField(key, fs) {
    const bits = [];
    switch (fs.type) {
        case 'string': bits.push(fs.nullable ? 'string|null' : 'string'); break;
        case 'url': bits.push('https URL'); break;
        case 'enum': bits.push(fs.values.map((v) => JSON.stringify(v)).join('|')); break;
        case 'boolean': bits.push('boolean'); break;
        case 'int': bits.push('int' + (fs.min !== undefined ? ` ${fs.min}..${fs.max}` : '')); break;
        case 'formula': bits.push('formula expr string (compiled, never executed)'); break;
        case 'binding': bits.push('binding'); break;
        case 'inputMapping': bits.push('{ <param>: {kind:"static",value} | {kind:"field",name,formId?} }'); break;
        case 'effects': bits.push('Effects'); break;
        case 'recordValues': bits.push('{ <field key>: binding }'); break;
        case 'steps': bits.push('[Step] (nested)'); break;
        case 'switchCases': bits.push('[{ value, steps: [Step] }]'); break;
        case 'navParams': bits.push(`{ <key>: {kind:"static",value}|{kind:"formula",expr} } (≤${LIMITS.MAX_NAVIGATE_PARAMS}, → screen.params.<key>)`); break;
        case 'stringList': bits.push('[string]'); break;
        case 'approvalQuestions': bits.push('[{ name, label, type: "text"|"textarea"|"number"|"date"|"email"|"select"|"checkbox", required?, options? }] (≤20 approver questions; answers reach onDecided templates as {{answers.<name>}})'); break;
        case 'approvalOnDecided': bits.push('{ tableId, recordId: binding, set: { approved?|rejected?|expired?|cancelled?: { <field key>: literal | "{{answers.<q>}}"|"{{reason}}"|"{{decidedByName}}"|"{{decision}}"|"{{context.<key>}}" } } } (the record write executed when the decision lands)'); break;
        default: bits.push(fs.type);
    }
    if (fs.required) bits.push('REQUIRED');
    if (fs.maxLen) bits.push(`≤${fs.maxLen}`);
    const d = fmtDefault(fs.default);
    if (d) bits.push(`(${d})`);
    return `${key}: ${bits.join(' ')}`;
}

function renderSpecFields(fields) {
    return Object.entries(fields).map(([k, fs]) => renderActionField(k, fs)).join(', ');
}

/**
 * One action kind. Nine of the eleven kinds are byte-identical twins of the
 * step of the same name, and both sections used to render the full field list
 * — ~1.5k chars of the prompt saying exactly the same thing twice, ~30 lines
 * apart. When the twin IS identical (checked, not assumed — run_automation
 * differs and keeps its own fields) and the pointer is the shorter rendering,
 * the fields are taught once, in ### Sequence steps (the complete step
 * enumeration), and referenced here — the same by-reference idiom the
 * advanced-sizing rule and the "see ### Formulas" line already use. A kind
 * whose full shape is shorter than the pointer (open_modal, close_modal)
 * keeps it inline: never render the longer of two equivalent forms.
 */
function renderActionKind(kind) {
    const full = `${kind}: { ${renderSpecFields(ACTION_SPECS[kind].fields)} }`;
    const step = STEP_SPECS[kind];
    if (step && JSON.stringify(step.fields) === JSON.stringify(ACTION_SPECS[kind].fields)) {
        const ref = `${kind}: { …fields exactly as the ${kind} step below (### Sequence steps) }`;
        if (ref.length < full.length) return ref;
    }
    return full;
}

function renderStepKind(kind) {
    const spec = STEP_SPECS[kind];
    const side = DATA_MUTATING_STEP_KINDS.includes(kind) ? 'SERVER' : 'client';
    return `${kind} [${side}]: { ${renderSpecFields(spec.fields)} }`;
}

// ---------------------------------------------------------------------------
// Formula vocabulary — DERIVED from the shared expression engine
// ---------------------------------------------------------------------------

/**
 * The callable names a formula may use, rendered from the engine itself.
 *
 * The enumeration walks EXPR_FUNCTION_NAMES — which is `Object.keys(FUNCTIONS)`,
 * i.e. the exact set the parser accepts at PARSE time — so it cannot drift from
 * the engine the way a hand-maintained list does. It did drift, expensively: the
 * whole maths family (pow/sqrt/ln/log/exp/trig, PI(), E(), the `^` operator)
 * existed with nothing anywhere in the prompt naming any of it, and the builder
 * told a user their scientific calculator was unbuildable. Signatures come from
 * the EXPR_FUNCTIONS doc table; a name that table has not caught up with still
 * renders as `name(…)` rather than vanishing from the prompt.
 *
 * Wrapping is a fixed-width greedy fill over a fixed input — deterministic, so
 * the catalog stays byte-stable (prompt-cache discipline).
 */
const FORMULA_WRAP_COLS = 108;

function renderFormulaFunctions() {
    const signatureByName = new Map(EXPR_FUNCTIONS.map((f) => [f.name, f.signature]));
    const lines = [];
    let line = '';
    for (const name of EXPR_FUNCTION_NAMES) {
        const sig = signatureByName.get(name) || `${name}(…)`;
        const next = line ? `${line}, ${sig}` : sig;
        if (line && next.length > FORMULA_WRAP_COLS) {
            lines.push(`${line},`);
            line = sig;
        } else {
            line = next;
        }
    }
    if (line) lines.push(line);
    return lines.join('\n');
}

let _sections = null;

/**
 * Every section of the catalog, rendered once per process (the spec is
 * immutable). Both catalog forms assemble from these — the full text takes
 * them verbatim, the compact text takes the ones a small model needs and
 * swaps `components` / `steps` for their one-line forms.
 */
function buildCatalogSections() {
    if (_sections) return _sections;

    const theme = [
        ...Object.entries(THEME_SPEC).map(([k, spec]) => {
            if (spec.type === 'color') {
                if (spec.optional) return `${k}: #rrggbb or unset — ${spec.description}`;
                return `${k}: #rrggbb (default ${spec.default}; presets: ${spec.presets.join(' ')})`;
            }
            return `${k}: ${spec.values.join('|')} (default ${spec.default})`;
        }),
        'A public page (app_set_public_access) may override theme + design partially: the customer-facing form wears that brand, the app keeps its own.',
    ].join('\n');

    // App Design v2: the whole-look layer, also set through app_set_theme.
    // Rendered from the same specs so the model can never learn a stale enum.
    const design = [
        `preset: ${APP_DESIGN_PRESETS.map((p) => p.id).join('|')} — one call sets theme + design + navStyle together (an app with no preset renders as classic).`,
        ...Object.entries(DESIGN_SPEC)
            .filter(([k]) => k !== 'preset')
            .map(([k, spec]) => (spec.type === 'enum'
                ? `${k}: ${spec.values.join('|')} (default ${spec.default})`
                : `${k}: https:// URL or null (default null)`)),
        `navStyle: ${NAV_STYLES.join('|')} (default ${NAV_DEFAULT_STYLE}) — sidebar/rail/mega group screens; mega shows each screen's description and needs groups.`,
    ].join('\n');

    const knobs = Object.keys(STYLE_KNOBS).map(renderStyleKnob).join(', ');

    // Advanced sizing. Availability is DERIVED (componentSpecs.expandStyleKnobs:
    // the width pair follows `span`, the height pair follows `height`), so it is
    // taught ONCE as a rule instead of being appended to ~50 per-type `style:`
    // lines — which would cost ~1_500 chars of the prompt budget to say the same
    // sentence 48 times, and would drift the moment one array was missed.
    //
    // The three things the model cannot infer from the knob list are all here:
    // that `span` keeps owning placement (so the two knobs compose rather than
    // compete), that a percentage height needs something definite to measure
    // (and is an ERROR, not a no-op, when it does not have one), and that an
    // exact width is capped on mobile so it can never overflow a phone.
    const advancedSizing = [
        `Advanced sizing — widthMode/widthValue and heightMode/heightValue are NOT listed per component: a type takes the WIDTH pair exactly when its \`style:\` line below includes \`span\`, and the HEIGHT pair exactly when it includes \`height\` (sections included). Their defaults (widthMode "${STYLE_KNOBS.widthMode.default}", heightMode "${STYLE_KNOBS.heightMode.default}") ARE the ordinary column behaviour — omit all four unless a span or a height preset genuinely cannot express the box.`,
        // The one layout the grid genuinely cannot express. A pct width is a
        // fraction of the CELL, so "fixed sidebar + the rest" is unreachable
        // with span alone — and a model that does not know the pane trick
        // reaches for pct, gets a fraction of three columns, and concludes the
        // platform cannot do sidebars.
        `A FIXED sidebar beside something that takes the remainder is the one shape span cannot express (a "pct" width is a fraction of its own cell): use a \`pane\` with direction "horizontal", an exact widthMode "px" on the sidebar and height "fill" on the other child. Below 640px it stacks and the fixed width is released.`,
        `\`span\` still owns PLACEMENT: how many of the 12 columns the CELL reserves, and therefore what sits beside it. widthValue only sizes the painted box INSIDE that cell ("pct" is a percentage OF that cell), so the two compose — span 4 + widthMode "px" + widthValue 240 is a 240px box inside a third-width cell.`,
        // A parent HAVING a height and a parent PASSING IT DOWN are different
        // questions, and only the second one lets a percentage resolve: the
        // height lands on the parent's grid cell, and card/container only
        // thread it through their wrapper on the fill path. Promising the
        // looser rule here sent the model to a validator error it could have
        // been told to avoid.
        `heightMode "px"/"vh" always work — prefer them. "pct" needs a parent that PASSES ITS HEIGHT DOWN, which is narrower than a parent merely having one: a \`pane\` or \`section\` with a definite height does; a \`card\` or \`container\` does ONLY when its own height is "fill" inside a full-height parent; \`form\`/\`tabs\`/\`tab\`/\`modal\`/\`repeater\`/\`page_header\` never do. Anywhere else it is the ERROR style.height_pct_indefinite (whose hint names the fix). On a SECTION "pct" is never legal — a section is auto-height in the screen's stack, so use "vh" for a share of the viewport. Note "fill" is itself relative: it only makes a definite box inside a parent that is definite too.`,
        `Every explicit width is emitted with max-width:100%, and below 640px every component stacks full-width regardless — an exact width can never overflow a phone.`,
        // Same derivation as the width pair, so it is taught in the same breath.
        `hideBelow/hideAbove (none|sm|md|lg, default none) follow \`span\` the same way: hideBelow "md" hides the component on viewports narrower than 1024px, hideAbove "md" at 1024px and wider (sm=640, md=1024, lg=1280). CSS-only — prefer them over duplicate screens for a narrow/wide variant.`,
    ].join('\n');

    const screen = Object.entries(SCREEN_SPEC)
        .map(([k, fs]) => renderPropSpec(k, fs))
        .join('; ');

    const components = Object.keys(COMPONENT_SPECS).map(renderComponent).join('\n');

    // Node logic — the fields that sit BESIDE props/style on a component node.
    // `computed` is the important one and was invisible for a release: most
    // component types have no binding-typed prop, so without it every string on
    // a heading/text/button/callout/card/page_header is static forever, and a
    // builder that wants a live number there concludes the platform cannot do
    // it. It can, on any prop, on any type.
    const nodeLogicLines = [
        `Beside \`props\` and \`style\`, a component node takes these OPTIONAL fields — set them on an app_add_components entry or with app_update_component:`,
        `  computed: { "<propKey>": {"kind":"formula","expr":"<expr>"} } — makes ANY prop LIVE. The formula is re-evaluated every render and overrides that prop; the authored props.<propKey> stays as the fallback (and is what shows if the formula errors). This is the ONLY way to put a live value on a type whose props are plain strings — heading/text, button labels, callout bodies, card titles, page_header text, badge counts — none of which has a binding-typed prop. e.g. computed { "text": {"kind":"formula","expr":"concat('Total: ', toStr(vars.total))"} } on a heading.`,
        `  visibleWhen / enabledWhen / readOnly: true | false | {"kind":"formula","expr":"<expr>"} — gate visibility, enablement and (inputs) read-only state. Same formula scope as any binding formula.`,
        `  visibleToRoles: ["<roleKey>", …] — only these roles see the node; absent or empty means everyone.`,
        `  validations: [{ "type": ${NODE_VALIDATION_TYPES.join('|')}, "value"?: <int, minLength>, "format"?: "<name, format>", "expr"?: "<formula>", "message"?: "<what the user is told>" }] — max ${LIMITS.MAX_VALIDATIONS_PER_FIELD} per component, enforced only on form inputs.`,
    ];
    const nodeLogic = nodeLogicLines.join('\n');

    const actions = [
        `Kinds: ${ACTION_KINDS.join(' | ')}. The actions map key IS the action id (act_…); \`kind\` is the discriminator.`,
        ...ACTION_KINDS.map(renderActionKind),
        `Effects (bounded, never chain): { toast?: {message ≤500, tone ${TOAST_TONES.join('|')}}, navigateTo?: <screenId>|null }`,
        `open_modal/close_modal target a \`modal\` component's cmp_… id — end a save sequence with close_modal so the dialog does not stay open over the form it just submitted. A sequence runs its steps in order (max ${LIMITS.MAX_ACTION_STEPS} steps, nesting ≤${LIMITS.MAX_ACTION_DEPTH}).`,
    ].join('\n');

    const stepsLead = [
        `A Step is { kind, …fields }. Kinds: ${STEP_KINDS.join(' | ')}.`,
        `[SERVER] steps (${DATA_MUTATING_STEP_KINDS.join(', ')}) read/write persistent data and run on the API; [client] steps are chrome/navigation/flow-control and may NEVER carry data fields (tableId/values/recordId/automationId/inputMapping).`,
    ];
    const steps = [
        ...stepsLead,
        ...STEP_KINDS.map(renderStepKind),
    ].join('\n');

    const bindingLines = [
        `Binding-typed props accept EXACTLY these shapes (kind is the discriminator):`,
        `  { "kind": "static", "value": <any JSON> } — fixed data.`,
        `  { "kind": "actionResult", "actionId": "<act_…>", "path": "rows" } — the last result of an action; path is dot-separated, numeric indices as plain segments (items.0.name), no brackets.`,
        `  { "kind": "formula", "expr": "<expr>" } — computed from live scope. Roots: ${FORMULA_SCOPE_ROOTS.join(', ')}. Callable names + operators: see ### Formulas.`,
        `  { "kind": "record", "tableId": "<tbl_…>", "recordId"?, "filter"?, "sort"?, "limit"?, "path"? } — ONE row from an app data table (first match).`,
        `  { "kind": "records", "tableId": "<tbl_…>", "filter"?, "sort"?, "limit"? } — an array of rows from an app data table.`,
        `  { "kind": "aggregate", "tableId": "<tbl_…>", "filter"?, "groupBy"?: [{ "field", "bucket"?: ${DATE_BUCKETS.join('|')}, "as"? }], "aggregates"?: [{ "fn": ${AGG_FNS.join('|')}, "field"?, "as"? }], "sort"?, "limit"?, "pick"? } — counts/totals per group; add "pick":{"row":"first","column":"<as>"} for ONE number.`,
        `  { "kind": "dataset", "datasetId": "<ds_…>", "params"? } — a saved dataset's rows (grouped/aggregated queries).`,
        `  { "kind": "connector", "connectorId": "<conn_…>", "params"? } — rows from an owner-authored EXTERNAL connector (run acts-as-owner). params: { <key>: <literal> | {"kind":"formula","expr":"<expr>"} }. You WIRE existing connectors (app_list_connectors) — you never author them or their credentials.`,
        `filter: [{ "field": "<field key>", "op": ${FILTER_OPS.join('|')}, "value"?: <literal> | [<literals>] | {"kind":"formula","expr":"<expr>"} }] — formula values resolve client-side against live scope before the fetch (e.g. {"field":"created_by","op":"eq","value":{"kind":"formula","expr":"currentUser.id"}}).`,
        `sort: [{ "field": "<field key>", "dir": "asc"|"desc" }] (default created_at desc). System columns ${SYSTEM_COLUMNS.join('/')} are filterable/sortable on every table.`,
        `inputMapping values (run_automation) accept ONLY:`,
        `  { "kind": "static", "value": <any JSON> }`,
        `  { "kind": "field", "name": "<input props.name>", "formId": "<form cmp id, optional>" }`,
    ];
    const bindings = bindingLines.join('\n');

    const formulas = [
        renderFormulaFunctions(),
        `That is the WHOLE vocabulary: the parser rejects any other name before the formula runs. No eval, no user-defined helpers, no method calls on values.`,
        `Operators: + - * / % ^ · == != === !== < <= > >= · && || ! · ternary cond ? a : b · dotted and [indexed] paths. \`^\` is exponent — RIGHT-associative (2^3^2 = 512), binding TIGHTER than unary minus (-2^2 = -4; write (-2)^2 for the other reading), and it IS pow(). π and e are PI() and E(), with brackets.`,
        `TOTALITY, and its one hole: every helper above is null-safe and total — a domain error, a pole or an overflow (sqrt(-1), ln(0), exp(1000), 2^10000) returns NOTHING, never NaN. The bare arithmetic operators do NOT: + - * / % over a value that has not arrived yet is NaN, and x/0 is Infinity — both render as an empty tile. Guard arithmetic over forms/vars: number(x) and round(x, 2) collapse the hole to nothing, \`isEmpty(x) ? 0 : <maths>\` is the general form.`,
    ].join('\n');

    const variables = [
        `The app's shared named values (definition.variables), declared with app_set_variables.`,
        `  { "name", "label"?, "type": ${VARIABLE_TYPES.join('|')}, "default"?, "description"? }`,
        `name: one word a formula can read as vars.<name> — /${VARIABLE_NAME_RE.source}/. Max ${LIMITS.MAX_VARIABLES} per app.`,
        `Reserved: ${RESERVED_VARIABLE_NAMES.join(', ')}. "filters" belongs to the filter_bar component (vars.filters.<field>).`,
        `Formulas READ them as vars.<name>; set_variable steps and a server step's resultVar WRITE them. Declared defaults are seeded before anything runs — on the client AND the server — so a records filter bound to vars.<name> filters on the FIRST paint instead of being dropped for having no value. Declare a variable BEFORE the formula that reads it.`,
    ].join('\n');

    const dataModel = [
        `Every app can carry its own database: tables → fields → rows, plus roles and per-table access rules (RLS).`,
        `Field types: ${FIELD_TYPES.join(', ')}. number takes subtype "integer"; select/multiselect need an options array; relation needs relation:{tableId}; computed is read-only.`,
        `Table/field keys match ${String(KEY_RE)} (lowercase snake_case). System columns on EVERY table (server-managed, never declared or written): ${SYSTEM_COLUMNS.join(', ')}.`,
        `Access modes per table: ${ACCESS_MODES.join(' | ')} — "app" = every member reads/writes, "owner" = rows scoped to created_by, "role" = per-role rules, "none" = owner only. Prefer "app" for shared/demo data (owner-seeded rows are invisible to members under "owner").`,
        `Caps: ${DATA_LIMITS.MAX_TABLES_PER_APP} tables/app, ${DATA_LIMITS.MAX_FIELDS_PER_TABLE} fields/table, ${DATA_LIMITS.MAX_ROWS_PER_TABLE} rows/table, ${DATA_LIMITS.MAX_ROWS_PER_APP} rows/app, ${Math.round(DATA_LIMITS.MAX_DB_BYTES / (1024 * 1024))}MB per app database.`,
    ].join('\n');

    const limits = `${LIMITS.MAX_SCREENS} screens; ${LIMITS.MAX_SECTIONS_PER_SCREEN} sections/screen; ${LIMITS.MAX_TOTAL_NODES} total sections+components; ${LIMITS.MAX_ACTIONS} actions; nesting depth ${LIMITS.MAX_DEPTH} (section=1, each container +1); strings ≤${LIMITS.MAX_STRING} chars; formulas ≤${LIMITS.MAX_FORMULA_LEN} chars.`;

    _sections = {
        theme, design, knobs, advancedSizing, screen, components, nodeLogic, actions, steps,
        bindings, formulas, variables, dataModel, limits,
        // The line lists the compact form composes from: it keeps the shapes
        // that ARE the contract (bindings, node logic) and drops the lines
        // that name a tool or a kind the core menu cannot reach.
        _nodeLogicLines: nodeLogicLines, _bindingLines: bindingLines, _stepsLead: stepsLead,
    };
    return _sections;
}

let _cached = null;

/**
 * The full catalog text injected into the static system prompt. Computed
 * once per process (the spec is immutable) — byte-stable by construction.
 */
function renderCatalogText() {
    if (_cached) return _cached;
    const s = buildCatalogSections();

    _cached = `### Theme (app_set_theme)
${s.theme}

### Design & navigation (app_set_theme — the whole-look layer)
${s.design}

### Style knobs (closed vocabulary — the only legal style keys, per component below)
${s.knobs}
color roles: ${COLOR_ROLES.join(', ')}
${s.advancedSizing}

### Screens (app_add_screen / app_update_screen)
${s.screen}
Sections: style knobs ${SECTION_STYLE_KNOBS.join(', ')} (defaults ${JSON.stringify(SECTION_STYLE_DEFAULTS)}).

### Components (${Object.keys(COMPONENT_SPECS).length} types — the ONLY legal types)
A prop with no (default …) note is simply empty/off until set — everywhere in this catalog.
${s.components}

### Node logic (computed / gating / validations — on ANY component, beside props+style)
${s.nodeLogic}

### Actions (app_set_action)
${s.actions}

### Sequence steps
${s.steps}

### Bindings
${s.bindings}

### Formulas (the expression language — every formula expr and formula-typed field)
${s.formulas}

### Variables (app_set_variables)
${s.variables}

### Data model (the app's own database)
${s.dataModel}

### Limits
${s.limits}`;
    return _cached;
}

// ---------------------------------------------------------------------------
// The compact catalog — one line per component type, the common step kinds
// ---------------------------------------------------------------------------
//
// Measured 2026-09-17 on the demo box (Gemma 4 26B-A4B, llama.cpp): the full
// component section alone was ~30k of the 77k-char core system prompt — 40 %
// of what a 3.8B-active model read before the user's first word, most of it
// props it never touches (message_thread's sideMap, kanban's swimlanes). The
// one-line form keeps what a builder needs to CHOOSE a type and write its
// common props; the full entry is one app_inspect_catalog call away, and the
// prompt says so. Every rule of the full renderer still holds: derived from
// the spec tables, deterministic, cached.

// The props that name a component's job — shown even when neither required
// nor binding-typed, so a stat has its label, a chart its xKey and series, a
// filter_bar its fields. Derived selection first (required ∪ binding-typed),
// then these, capped at COMPACT_MAX_PROPS.
const COMPACT_KEY_PROP_NAMES = [
    'name', 'label', 'text', 'title', 'subtitle', 'icon', 'placeholder', 'columns', 'fields', 'source',
    'submitLabel', 'chartType', 'xKey', 'series', 'look', 'variant', 'titleKey', 'subtitleKey',
    'groupByField', 'emptyText', 'options', 'level', 'value', 'inputType', 'searchable', 'rowActions',
    'valueFormat', 'selectable', 'role', 'iconLeft', 'description',
    // The one prop that makes a type usable at all where nothing above applies:
    // an image's src, a relation input's table, a pane's direction, a markdown
    // block's content, a stepper's steps, an input's required flag.
    'src', 'alt', 'required', 'tableId', 'displayField', 'direction', 'content', 'steps',
    'orientation', 'multiple', 'defaultValue', 'defaultChecked', 'size', 'systemPrompt',
];
const COMPACT_MAX_PROPS = 8;
const COMPACT_MAX_ENUM = 7;        // an enum longer than this shows the first values + a count
const COMPACT_MAX_ITEM_ENUM = 5;   // inside a list item shape (filter_bar.fields.type: 4 values)
const COMPACT_MAX_ITEM_KEYS = 6;
const COMPACT_SENTENCE_CHARS = 90;

/** The first sentence of a description (with its full stop), cut at a word boundary past the cap. */
function firstSentence(text, max = COMPACT_SENTENCE_CHARS) {
    const s = String(text || '').trim();
    // A full stop followed by a capital (or a quote/bracket) — not the one in
    // "e.g. props", which is where the split first landed.
    const dot = s.search(/\.(?=\s+[A-Z(`"]|$)/);
    const first = dot >= 0 ? s.slice(0, dot) : s;
    if (first.length <= max) return `${first}.`;
    const cut = first.lastIndexOf(' ', max);
    return `${first.slice(0, cut > max / 2 ? cut : max)}…`;
}

/** `a|b|c` for a short enum; `a|b|c|…(+N)` for a long one. An empty-string value shows as "". */
function compactEnum(values, max) {
    const show = (v) => (v === '' ? '""' : (v === null ? 'null' : String(v)));
    if (values.length <= max) return values.map(show).join('|');
    return `${values.slice(0, max - 1).map(show).join('|')}|…(+${values.length - (max - 1)})`;
}

/** The type token of one prop in the one-line form. */
function compactPropType(fs) {
    switch (fs.type) {
        case 'enum': return compactEnum(fs.values, COMPACT_MAX_ENUM) + (fs.allowIsoDate ? '|YYYY-MM-DD' : '');
        case 'int': case 'number': return 'number';
        case 'boolean': return 'bool';
        case 'binding': return 'binding';
        case 'formula': return 'formula';
        case 'stringList': return '[string]';
        case 'list': {
            const shape = Object.entries(fs.itemShape || {});
            const shown = shape.slice(0, COMPACT_MAX_ITEM_KEYS).map(([ik, ifs]) => {
                const star = ifs.required ? '*' : '';
                if (ifs.type === 'enum' && ifs.values.length <= COMPACT_MAX_ITEM_ENUM) return `${ik}${star}:${compactEnum(ifs.values, COMPACT_MAX_ITEM_ENUM)}`;
                return `${ik}${star}`;
            });
            const more = shape.length > shown.length ? `,+${shape.length - shown.length}` : '';
            return `[{${shown.join(',')}${more}}]`;
        }
        default: return fs.type; // string, icon, url, markdown
    }
}

/**
 * The props worth a place on the one line: required ones, binding-typed ones
 * (the data contract), then the identity props by name — in the spec's own
 * order, capped. `look` and the other enum props survive because their
 * VALUES are what a small model cannot guess.
 */
function pickCompactProps(spec) {
    const all = Object.entries(spec.props || {});
    const wanted = new Set(COMPACT_KEY_PROP_NAMES);
    const picked = all.filter(([k, fs]) => fs.required || fs.type === 'binding' || wanted.has(k));
    return { picked: picked.slice(0, COMPACT_MAX_PROPS), total: all.length };
}

/** One line for a component type: what it is, its key props, its style knobs with defaults. */
function renderComponentCompact(type) {
    const spec = COMPONENT_SPECS[type];
    const flags = [
        spec.container ? 'CONTAINER' : null,
        spec.isInput ? 'input' : null,
        spec.events && spec.events.length ? `events:${spec.events.join(',')}` : null,
    ].filter(Boolean).join(' ');
    const { picked, total } = pickCompactProps(spec);
    const props = picked.map(([k, fs]) => `${k}${fs.required ? '*' : ''}:${compactPropType(fs)}`).join(' ');
    const more = total - picked.length;
    const defaults = spec.defaultStyle || {};
    const style = spec.styleKnobs.map((k) => (defaults[k] !== undefined ? `${k}=${JSON.stringify(defaults[k])}` : k)).join(',');
    return `${type} [${spec.category}]${flags ? ` ${flags}` : ''} — ${firstSentence(spec.description)}`
        + (props ? ` props: ${props}` : '')
        + (more > 0 ? ` +${more}` : '')
        + ` style: ${style}`;
}

// The step kinds a small-band build writes (the form-save sequence, record
// steps, navigation, the flow-control trio, fill_document); the rest are
// named once and fetched on demand.
const COMPACT_STEP_KINDS = [
    'navigate', 'toast', 'open_url', 'open_modal', 'close_modal', 'reset_form', 'confirm', 'refresh',
    'set_variable', 'run_automation', 'create_record', 'update_record', 'delete_record', 'fill_document',
    'condition', 'switch', 'loop',
];

function renderStepKindCompact() {
    const full = COMPACT_STEP_KINDS.filter((k) => STEP_SPECS[k]).map(renderStepKind);
    const rest = STEP_KINDS.filter((k) => !COMPACT_STEP_KINDS.includes(k));
    return [
        ...full,
        `Other step kinds (full shape via app_inspect_catalog {steps:[…]}): ${rest.join(', ')}.`,
    ].join('\n');
}

let _compact = null;

/**
 * The small-band catalog. Same sources, same determinism, ~20k chars: every
 * component type present on one line, the common step kinds in full, the
 * binding shapes the core menu can wire, and the formula vocabulary whole
 * (a name a small model cannot see is a name it will not use).
 */
function renderCompactCatalogText() {
    if (_compact) return _compact;
    const s = buildCatalogSections();
    // The advanced-sizing knobs are dropped from the vocabulary line: the
    // core prompt says "layout is spans only", and a knob the prompt forbids
    // has no business in the list of legal keys.
    const advanced = new Set([...ADVANCED_WIDTH_KNOBS, ...ADVANCED_HEIGHT_KNOBS]);
    const knobs = Object.keys(STYLE_KNOBS).filter((k) => !advanced.has(k)).map(renderStyleKnob).join(', ');
    const components = Object.keys(COMPONENT_SPECS).map(renderComponentCompact).join('\n');
    // Node logic: computed and visibleWhen only — the two node fields the
    // core app_add_components / app_update_component schemas declare
    // (builderTools/schemasCore.js). enabledWhen and readOnly are pruned
    // there, visibleToRoles needs roles the core menu cannot declare, and
    // validations are an edit-phase tool; a field the catalog teaches and
    // the schema does not show is the drift the lockstep test guards. The
    // computed line is the short form: the core prompt's ANY PROP CAN BE
    // LIVE bullet already says which types need it and why.
    const nodeLogic = [
        s._nodeLogicLines[0],
        `  computed: { "<propKey>": {"kind":"formula","expr":"<expr>"} } — makes ANY prop LIVE: re-evaluated every render, overrides that prop (the authored props.<propKey> stays as the fallback). e.g. computed { "text": {"kind":"formula","expr":"concat('Total: ', toStr(vars.total))"} } on a heading.`,
        `  visibleWhen: true | false | {"kind":"formula","expr":"<expr>"} — gates visibility. Same formula scope as any binding formula.`,
    ].join('\n');
    // Bindings: the five kinds the core menu can satisfy. dataset needs
    // app_upsert_dataset and connector needs app_list_connectors — neither is
    // on the menu, and a shape the model cannot fulfil is one it invents ids for.
    const bindings = s._bindingLines.filter((l) => !/"kind": "(dataset|connector)"/.test(l)).join('\n');
    const steps = [...s._stepsLead, renderStepKindCompact()].join('\n');
    // Actions: the full section renders nine kinds as pointers to their step
    // twin; the compact step list does not carry four of those twins, so the
    // rule is stated once instead. Derived from the same specs (renderActionKind
    // decides inline-vs-twin), so a kind that stops being a twin renders inline.
    const twinKinds = ACTION_KINDS.filter((k) => STEP_SPECS[k] && JSON.stringify(STEP_SPECS[k].fields) === JSON.stringify(ACTION_SPECS[k].fields));
    const ownKinds = ACTION_KINDS.filter((k) => !twinKinds.includes(k));
    const actions = [
        `Kinds: ${ACTION_KINDS.join(' | ')}. The actions map key IS the action id (act_…); \`kind\` is the discriminator. ${twinKinds.join(', ')} take exactly the fields of the step of the same name (### Sequence steps).`,
        ...ownKinds.map((kind) => `${kind}: { ${renderSpecFields(ACTION_SPECS[kind].fields)} }`),
        `Effects (bounded, never chain): { toast?: {message ≤500, tone ${TOAST_TONES.join('|')}}, navigateTo?: <screenId>|null }`,
        `open_modal/close_modal target a \`modal\` component's cmp_… id — end a save sequence with close_modal. A sequence runs its steps in order (max ${LIMITS.MAX_ACTION_STEPS} steps, nesting ≤${LIMITS.MAX_ACTION_DEPTH}).`,
    ].join('\n');
    // Screens: the fields the core app_add_screen declares (maxWidth and
    // refreshInterval are pruned from that menu; `kind` is not on any menu);
    // sections cannot be styled from the core menu at all (no app_add_section).
    const screen = Object.entries(SCREEN_SPEC)
        .filter(([k]) => ['name', 'icon', 'showInNav', 'description'].includes(k))
        .map(([k, fs]) => renderPropSpec(k, fs))
        .join('; ');
    // Formulas: the TOTALITY line is the core prompt's guard bullet, said once there.
    const formulas = s.formulas.split('\n').filter((l) => !l.startsWith('TOTALITY')).join('\n');

    _compact = `### Style knobs (closed vocabulary — the only legal style keys; each type lists its own below)
${knobs}
color roles: ${COLOR_ROLES.join(', ')}
Exact sizing (widthMode/widthValue/heightMode/heightValue) is not for this menu — layout is spans.

### Screens (app_add_screen)
${screen}

### Components (${Object.keys(COMPONENT_SPECS).length} types — the ONLY legal types; one line each)
Line grammar: type [category] CONTAINER|input events:… — what it is. props: name*:type (* = required; +N = more props not shown — fetch them with app_inspect_catalog {components:[…]} BEFORE using a type's rarer props) style: knob=default,knob. A prop with no default is empty/off until set.
${components}

### Node logic (computed / gating — on ANY component, beside props+style)
${nodeLogic}

### Actions (app_set_action)
${actions}

### Sequence steps
${steps}

### Bindings
${bindings}
Variables: \`vars.filters.<name>\` is written by a filter_bar (read it in records filters as {"kind":"formula","expr":"vars.filters.<name>"}); any other app variable needs a tool this menu lacks — say so instead of inventing one.

### Formulas (the expression language — every formula expr and formula-typed field)
${formulas}

### Data model (the app's own database)
${s.dataModel}

### Limits
${s.limits}`;
    return _compact;
}

/** The full catalog entry of one component type (what app_inspect_catalog serves). */
function renderComponentEntry(type) {
    if (!COMPONENT_SPECS[type]) return null;
    return renderComponent(type);
}

/** The full catalog line of one step kind (what app_inspect_catalog serves). */
function renderStepEntry(kind) {
    if (!STEP_SPECS[kind]) return null;
    return renderStepKind(kind);
}

module.exports = {
    renderCatalogText,
    renderCompactCatalogText,
    buildCatalogSections,
    renderComponentEntry,
    renderStepEntry,
    renderComponentCompact,
    renderStepKindCompact,
    COMPACT_STEP_KINDS,
    COMPACT_KEY_PROP_NAMES,
};
