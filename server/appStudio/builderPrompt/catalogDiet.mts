/**
 * App Studio builder: the diet of the cached catalogue text.
 *
 * catalogRender.js renders every section of the catalogue COMPLETE (buildCatalogSections). The
 * text that rides in the system prompt is a selection of it: what a build needs on most turns
 * stays, and rare material is named in one line and served on request by app_inspect_catalog:
 *
 *   a rarely used component type   one summary line; full entry by {components:[…]}
 *   a rarely used step kind        named in the "Other step kinds" line; full entry by {steps:[…]}
 *   everything else that moved     a TOPIC (catalogTopics.mts), asked as {components:["topic:<name>"]}
 *
 * Nothing here is filtered per request: the selection is a constant, so the text stays
 * byte-stable (prompt-cache discipline). catalogTopics.test.js holds, for every fact that left
 * the base text, "the base text points at X and X contains the fact".
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { renderFormulaFunctions, LIST_FORMS_TEXT, NOT_IN_COMPACT } = nodeRequire('./formulaGuide.js') as {
    renderFormulaFunctions: (opts?: { compact?: boolean; skip?: ReadonlySet<string> }) => string;
    LIST_FORMS_TEXT: string;
    NOT_IN_COMPACT: ReadonlySet<string>;
};
const { EXPR_FUNCTION_NAMES } = nodeRequire('../../shared/expr/index.mjs') as { EXPR_FUNCTION_NAMES: readonly string[] };

/** How a topic is asked for: a name with this prefix in the `components` (or `steps`) list. */
export const TOPIC_PREFIX = 'topic:';
export const askTopic = (name: string): string => `app_inspect_catalog {components:["${TOPIC_PREFIX}${name}"]}`;

/** Component types the full catalogue shows as ONE summary line. */
export const ON_REQUEST_TYPES: readonly string[] = Object.freeze([
    'pdf_compare', 'browser_view', 'approval_list', 'input_dataset', 'input_html', 'pivot', 'badge_list', 'stepper',
    'file_gallery', 'connector_status', 'timeline', 'message_thread', 'calendar', 'ai_chat', 'document_viewer',
    'document_compare', 'input_document',
]);

/** Step kinds the full catalogue only names. */
export const ON_REQUEST_STEP_KINDS: readonly string[] = Object.freeze([
    'request_approval', 'generate_file', 'generate_presentation', 'redact_pdf', 'file_intake', 'dataset_query',
    'ai_browse', 'copy_document', 'kb_log_query', 'kb_log_review', 'transaction',
]);

/** Functions the base text names without their signature. */
export const LONG_TAIL_FUNCTIONS: ReadonlySet<string> = new Set([
    'cbrt', 'exp', 'ln', 'log10', 'log', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
    'degrees', 'radians', 'sign', 'trunc', 'mod', 'hypot', 'factorial', 'fileType', 'anyOf', 'everyOf', 'noneOf',
    'padStart', 'sumCounts', 'yesNoText', 'groupSummary', 'asTable', 'regexMatch', 'regexReplace',
]);

export const STEP_LEAD = 'A Step is { kind, …fields }. [SERVER] steps read/write persistent data and run on the API; [client] steps are chrome/navigation/flow-control and may NEVER carry data fields (tableId/values/recordId/automationId/inputMapping).';
const STEP_RULES_POINTER = `Writing many rows by filter, writeTo upsertKey / replaceWhere and the transaction step have rules of their own: ${askTopic('sequences')} BEFORE you write one.`;
const CALL_ACTION_SHORT = `call_action runs another action as a subroutine: its params.<name> come from \`params\`, it shares vars/form (not item/index/value) and its result is the called action's last server result (→ resultVar). Depth, access and public-page rules: ${askTopic('actions')}.`;
const SIZING_POINTER = `A FIXED sidebar beside a pane that takes the rest, which parents a "pct" height may measure, the phone behaviour of an exact width and hideBelow/hideAbove: ${askTopic('sizing')} BEFORE you use one of them.`;
const DATA_CHANGES_POINTER = `Changing a table that already holds rows (stored computed fields, which field types convert, dryRun): ${askTopic('data_model')}.`;
const SUMMARY_GRAMMAR = 'A type written on ONE line (props: name*:type, * = required, +N = props not shown) is a SUMMARY of a rarely used type: read its full entry with app_inspect_catalog {components:[…]} BEFORE you add it.';

/** One line that names every topic the full catalogue leans on. */
export const TOPIC_INDEX_FULL = `On request, several per call: ${askTopic('<name>')} with formulas (every signature, the regex subset, what a domain error returns), sizing, sequences (step error handling, bulk writes, transaction), actions, data_model, mail_apps, documents. Every section of this catalog is a topic too (theme, screens, node_logic, bindings, variables, limits).`;
/** The same for the compact catalogue: only topics that name no tool the small menu lacks. */
export const TOPIC_INDEX_COMPACT = `Changing a table that already holds rows (which field types convert, stored computed fields): ${askTopic('data_model')}.`;

export interface DietInput {
    sections: Record<string, string> & { _stepNotes: string[] };
    componentTypes: readonly string[];
    stepKinds: readonly string[];
    serverKinds: readonly string[];
    colorRoles: readonly string[];
    sectionsLine: string;
    renderComponent: (type: string) => string;
    renderComponentLine: (type: string) => string;
    renderStep: (kind: string) => string;
}

/** The step section: the lead, the given notes, the shown kinds in full and the rest named by side. */
export function renderBaseSteps(shown: readonly string[], input: Pick<DietInput, 'stepKinds' | 'serverKinds'>, renderLine: (kind: string) => string, notes: readonly string[] = []): string {
    const rest = input.stepKinds.filter((kind) => !shown.includes(kind));
    const bySide = (['SERVER', 'client'] as const).map((side) => {
        const kinds = rest.filter((kind) => input.serverKinds.includes(kind) === (side === 'SERVER'));
        return kinds.length ? `[${side}] ${kinds.join(', ')}` : '';
    }).filter(Boolean).join('; ');
    return [
        STEP_LEAD,
        ...notes,
        ...shown.filter((kind) => input.stepKinds.includes(kind)).map(renderLine),
        ...(rest.length ? [`Other step kinds (full shape via app_inspect_catalog {steps:[…]} BEFORE you use one): ${bySide}.`] : []),
    ].join('\n');
}

/**
 * The formula section of a base text: the common signatures, the long tail by name, the
 * vocabulary sentence and the operators. `complete` is the whole section (sections.formulas).
 */
export function renderBaseFormulas(complete: string, { compact = false }: { compact?: boolean } = {}): string {
    const named = EXPR_FUNCTION_NAMES.filter((name) => LONG_TAIL_FUNCTIONS.has(name) && !(compact && NOT_IN_COMPACT.has(name)));
    const regexAt = LIST_FORMS_TEXT.indexOf(' regexMatch/regexReplace:');
    const listForms = regexAt >= 0 ? LIST_FORMS_TEXT.slice(0, regexAt) : LIST_FORMS_TEXT;
    const kept = complete.split('\n')
        .filter((line) => line.startsWith('That is the WHOLE vocabulary') || line.startsWith('Operators:'))
        .map((line) => line.replace(LIST_FORMS_TEXT, compact ? '' : listForms));
    return [
        renderFormulaFunctions({ compact, skip: LONG_TAIL_FUNCTIONS }),
        `Also callable, signatures on request (${askTopic('formulas')}): ${named.join(', ')}.`,
        ...kept,
    ].join('\n');
}

/** The action section with the call_action paragraph cut to its first sentence. */
function renderBaseActions(complete: string): string {
    return complete.split('\n').map((line) => (line.startsWith('call_action runs another action') ? CALL_ACTION_SHORT : line)).join('\n');
}

/** The full catalogue as the system prompt carries it. */
export function renderBaseCatalog(input: DietInput): string {
    const s = input.sections;
    const components = input.componentTypes
        .map((type) => (ON_REQUEST_TYPES.includes(type) ? input.renderComponentLine(type) : input.renderComponent(type)))
        .join('\n');
    const shownSteps = input.stepKinds.filter((kind) => !ON_REQUEST_STEP_KINDS.includes(kind));
    const envelope = s._stepNotes.slice(0, 1); // onError / retry: every server step may carry it
    return `${TOPIC_INDEX_FULL}

### Theme (app_set_theme)
${s.theme}

### Design & navigation (app_set_theme — the whole-look layer)
${s.design}

### Style knobs (each type takes only the keys on its own style line below)
${s.knobs}
color roles: ${input.colorRoles.join(', ')}
background: surface = the card colour; tint = a soft primary wash; panel = a RAISED band (card colour plus shadow); gradient = a primary wash.
${s.advancedSizing.split('\n')[0]}
${SIZING_POINTER}

### Screens (app_add_screen / app_update_screen)
${s.screen}
${input.sectionsLine}

### Components (${input.componentTypes.length} types)
A prop with no (default …) note is simply empty/off until set — everywhere in this catalog.
${SUMMARY_GRAMMAR}
${components}

### Node logic (computed / gating / validations — on ANY component, beside props+style)
${s.nodeLogic}

### Actions (app_set_action)
${renderBaseActions(s.actions)}

### Sequence steps
${renderBaseSteps(shownSteps, input, input.renderStep, [...envelope, STEP_RULES_POINTER])}

### Bindings
${s.bindings}

### Formulas (the expression language — every formula expr and formula-typed field)
${renderBaseFormulas(s.formulas)}

### Variables (app_set_variables)
${s.variables}

### Data model (the app's own database)
${s.dataModel}
${DATA_CHANGES_POINTER}

### Limits
${s.limits}`;
}
