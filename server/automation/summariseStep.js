// @typecheck strict
/**
 * One automation step in words, twice: the line the author reads in the
 * summary (summariseDefinition) and the line the builder model reads in the
 * draft state (renderAgentDraftState), plus whether a live run of the step
 * leaves something behind. Each is a table with one entry per step type; a
 * type without an entry falls back to the table steps' own wording
 * (summariseTables.js) or a plain "<type> step" line.
 */

const { isSideEffect } = require('./sideEffectMap');
const { flattenSentenceParts } = require('./expr');

/**
 * @typedef {Record<string, any>} AnyStep
 * @typedef {{ codeParams?: (code: string) => Array<object> | null }} StateOpts
 */

/** @param {unknown} value */
function describeRef(value) {
    if (value == null) return '∅';
    if (typeof value !== 'object') return JSON.stringify(value);
    const binding = /** @type {{ kind?: unknown, path?: unknown, value?: unknown }} */ (value);
    if (binding.kind === 'literal') return JSON.stringify(binding.value);
    if (binding.kind === 'ref') return `\`${binding.path}\``;
    if (binding.kind === 'template') return `"${binding.value}"`;
    if (binding.kind === 'expr') return `\`${binding.value}\``;
    return JSON.stringify(binding);
}

/** `a=…, b=…` for an input map. @param {Record<string, unknown> | undefined} inputs */
const inputList = (inputs) => Object.entries(inputs || {}).map(([k, v]) => `${k}=${describeRef(v)}`).join(', ');

/** @param {Record<string, unknown> | undefined} map */
function bindingMap(map) {
    const entries = Object.entries(map || {});
    if (!entries.length) return '∅';
    return `{ ${entries.map(([k, v]) => `${k}=${describeRef(v)}`).join(', ')} }`;
}

/**
 * ` — <label>` unless the label is absent or the type's default.
 * @param {AnyStep} step
 * @param {string} [byDefault]
 */
const labelSuffix = (step, byDefault) => (step.label && step.label !== byDefault ? ` — ${step.label}` : '');

/** The field names a step declares. @param {unknown} fields @returns {string[]} */
const fieldNames = (fields) => (Array.isArray(fields) ? fields : []).map((f) => f && f.name).filter(Boolean);

/** The personal-data categories a guard or tokenize step looks for. @param {AnyStep} step */
const scanCategories = (step) => (Array.isArray(step.categories) && step.categories.length
    ? step.categories.join(', ') : 'every category the organisation looks for');

/**
 * "one row per attachment of messages (copies from, to, subject, date)", or
 * null before the inner list is picked.
 * @param {AnyStep} step
 */
function flattenSentence(step) {
    const parts = flattenSentenceParts({}, step);
    if (!parts.child) return null;
    const copies = (Array.isArray(step.parents) ? step.parents : []).slice().reverse()
        .flatMap((/** @type {AnyStep | null} */ p) => (Array.isArray(p?.fields) ? p.fields : []).filter((/** @type {AnyStep | null} */ f) => f && f.mode === 'copy').map((/** @type {AnyStep} */ f) => f.to));
    const keep = step.keepEmpty ? ', keeps items without one' : '';
    return `one row per ${parts.child} of ${parts.parents} (copies ${copies.length ? copies.join(', ') : 'nothing yet'}${keep})`;
}

/** @param {AnyStep} step */
function describeFlatten(step) {
    const sentence = flattenSentence(step);
    return sentence ? ` ${sentence} over \`${step.arrayRef}\`` : ` over \`${step.arrayRef || ''}\` (the list inside each item is not picked yet)`;
}

// ── The parameters a code step declares ─────────────────────────────
// The step settings render the JSDoc on main as the step's input form
// (automation/codeSafety, analyzeCode().params), and the builder binds the
// step's `inputs` by those names. Without the names in the draft state the
// model saw a code step as "(N chars)" and had to guess what to bind.
//
// Loaded on first use and remembered per code text: the draft state is
// rebuilt every turn and an automation rarely changes its code between turns.
// Never throws: a summary line is not worth a failed turn, and without the
// analyser the line keeps only the size.
const CODE_PARAMS_CACHE_MAX = 64;
/** @type {Map<string, Array<object> | null>} */
const codeParamsCache = new Map();
/** @type {((code: string) => any) | null | undefined} */
let codeAnalyser;

/**
 * @param {unknown} code
 * @returns {Array<object> | null | undefined}
 */
function declaredCodeParams(code) {
    if (typeof code !== 'string' || !code.trim()) return null;
    if (codeParamsCache.has(code)) return codeParamsCache.get(code);
    if (codeAnalyser === undefined) {
        try { codeAnalyser = require('./codeSafety').analyzeCode; } catch (_) { codeAnalyser = null; }
    }
    let params = null;
    if (typeof codeAnalyser === 'function') {
        try {
            const analysis = codeAnalyser(code);
            params = analysis && Array.isArray(analysis.params) ? analysis.params : null;
        } catch (_) { params = null; }
    }
    if (codeParamsCache.size >= CODE_PARAMS_CACHE_MAX) codeParamsCache.delete(/** @type {string} */ (codeParamsCache.keys().next().value));
    codeParamsCache.set(code, params);
    return params;
}

/** ` params=[amount*, vatRate=21]`: * required, =value the default. @param {unknown} params */
function describeCodeParams(params) {
    if (!Array.isArray(params) || !params.length) return '';
    const names = params.filter((p) => p && p.name).map((p) => {
        if (p.required) return `${p.name}*`;
        if (p.default === undefined) return p.name;
        /** @type {string} */
        let def;
        try { def = JSON.stringify(p.default); } catch (_) { def = String(p.default); }
        return `${p.name}=${String(def).slice(0, 30)}`;
    });
    return names.length ? ` params=[${names.join(', ')}]` : '';
}

/**
 * @param {AnyStep} step
 * @param {((code: string) => Array<object> | null) | undefined} codeParams
 */
function describeCodeStep(step, codeParams) {
    const read = typeof codeParams === 'function' ? codeParams : declaredCodeParams;
    let params = null;
    try { params = read(step.code); } catch (_) { params = null; }
    const tools = Array.isArray(step.allowedTools) && step.allowedTools.length ? ` tools=[${step.allowedTools.join(', ')}]` : '';
    return ` (${(step.code || '').length} chars)${describeCodeParams(params)}${tools}`;
}

// ── The author's line ───────────────────────────────────────────────

/** @param {AnyStep} step @param {string} n */
function slideLine(step, n) {
    const visual = step.chart && step.chart.type ? ` with a ${step.chart.type} chart` : (step.stats ? ' with KPI tiles' : (step.layout === 'timeline' ? ' as a timeline' : ''));
    return `${n} Slide${step.title ? ` "${step.title}"` : ''}${visual}${step.forEach ? ` — one per item of ${describeRef(step.forEach.overRef)}` : ''}${labelSuffix(step, 'Slide')}.`;
}

/** @param {AnyStep} step @param {string} n */
function datatableLine(step, n) {
    const where = Array.isArray(step.where) && step.where.length
        ? ` where ${step.where.map((/** @type {AnyStep | null} */ w) => w && w.field).filter(Boolean).join(' and ')} matches`
        : '';
    const table = step.label && step.label !== 'Datatable' ? ` "${step.label}"` : ' a datatable';
    switch (step.op) {
        case 'add_row':     return `${n} Add a row to${table}.`;
        case 'save_row':    return `${n} Add or update a row in${table}, matched on ${step.matchColumn || 'a column'}.`;
        case 'update_rows': return `${n} Update rows in${table}${where}.`;
        case 'delete_rows': return `${n} Delete rows from${table}${where}.`;
        default:            return `${n} Look up rows in${table}${where}.`;
    }
}

/** @param {AnyStep} step @param {string} n */
function guardLine(step, n) {
    /** @type {string[]} */
    const acts = [];
    if (step.onFound && step.onFound.stop) acts.push('stop the run');
    if (step.onFound && step.onFound.mask) acts.push('pass a masked copy on');
    return `${n} Scan \`${step.sourceRef || '?'}\` for personal data (${scanCategories(step)})`
        + `${acts.length ? `, and on a hit ${acts.join(' and ')}` : ''}`
        + '. Routes **personal data** / **clean**.';
}

/**
 * The author's line per step type; `n` is the step's number ("3.").
 * @type {Record<string, (step: AnyStep, n: string) => string>}
 */
const STEP_LINES = {
    integration_action: (step, n) => {
        const inputs = inputList(step.inputs);
        const line = `Call \`${step.tool}\`${inputs ? ` with ${inputs}` : ''}${step.label ? ` — ${step.label}` : ''}.`;
        return `${n} ${isSideEffect(step.tool) ? '**' + line + '**' : line}`;
    },
    ai_step: (step, n) => {
        const promptShort = (step.prompt || '').replace(/\s+/g, ' ').slice(0, 140) + ((step.prompt || '').length > 140 ? '…' : '');
        return `${n} Ask the AI (${step.modelTier || 'fast'}): "${promptShort}"`;
    },
    condition: (step, n) => `${n} If \`${step.expr}\` then go to "then"-branch, else "else"-branch.`,
    loop: (step, n) => `${n} For each item in \`${step.overRef}\` (as \`loop.${step.itemVar}\`), run a sub-flow of ${(step.body || []).length} step(s) (max ${step.maxIterations || 100}).`,
    code: (step, n) => `${n} **Run sandboxed JavaScript** (${(step.code || '').length} chars).`,
    notification: (step, n) => {
        const channels = (step.channels || ['notification']).join(', ');
        const title = step.title ? ` titled "${step.title}"` : '';
        return `${n} Send notification on **${channels}**${title}.`;
    },
    guard: guardLine,
    tokenize: (step, n) => `${n} Replace the personal data in \`${step.sourceRef || '?'}\` (${scanCategories(step)}) with reversible `
        + 'placeholders. The real values are put back automatically wherever the run uses them again.',
    parse_json: (step, n) => {
        const names = fieldNames(step.fields);
        const src = step.sourceRef ? `\`${step.sourceRef}\`` : "the previous step's output";
        return `${n} Extract ${names.length} field(s) (${names.join(', ') || 'none yet'}) from ${src}${step.mode === 'ai' ? ' **using AI**' : ''}.`;
    },
    call_layer: (step, n) => {
        const inputs = inputList(step.inputs);
        return `${n} Run flowlet \`${step.layerKey || step.layerId || '?'}\`${inputs ? ` with ${inputs}` : ''}${labelSuffix(step, 'Call layer')}.`;
    },
    call_block: (step, n) => `${n} Run the building block "${step.label || 'Step'}"${Object.keys(step.inputs || {}).length ? ` with ${inputList(step.inputs)}` : ''}.`,
    generate_document: (step, n) => {
        const named = step.fileName || step.title;
        return `${n} Make a ${step.format === 'docx' ? 'Word document' : 'PDF'}${named ? ` called "${named}"` : ''}${step.label ? ` — ${step.label}` : ''}.`;
    },
    slide: slideLine,
    presentation: (step, n) => {
        const named = step.fileName || step.title;
        return `${n} Make a ${step.format === 'pdf' ? 'PDF deck' : 'PowerPoint'}${named ? ` called "${named}"` : ''}${labelSuffix(step, 'Presentation')}.`;
    },
    // Say WHICH document: it IS the step — "fill a document" without the name
    // tells the author nothing they did not already see.
    fill_document: (step, n) => {
        const named = step.fileName || step.documentName || step.documentId || '';
        const holes = Object.keys(step.values || {}).length;
        return `${n} Fill the document${named ? ` "${named}"` : ''}${holes ? ` with ${holes} value(s)` : ''} and keep the PDF${labelSuffix(step, 'Fill a document')}.`;
    },
    // Say WHICH fields: they are the step's whole contract, and the one thing
    // the author cannot see from a card that reads "Extract data".
    data_extraction: (step, n) => {
        const names = fieldNames(step.fields);
        const src = step.source == null ? 'the text' : describeRef(step.source);
        return `${n} Extract ${names.length} field(s) (${names.join(', ') || 'none yet'}) from ${src}${labelSuffix(step, 'Extract data')}.`;
    },
    datatable: datatableLine,
    // Say WHERE and say IDEMPOTENT-or-not: those are the two things an author
    // reading the summary cannot see from the canvas, and the second is the
    // difference between one document and one per night.
    knowledge_write: (step, n) => {
        const title = typeof step.title === 'string' && step.title.trim() ? ` "${step.title.trim()}"` : '';
        const repeats = typeof step.sourceUri === 'string' && step.sourceUri.trim()
            ? ' (replacing its own earlier version)'
            : ' (a new document each run)';
        return `${n} Save${title || ' text'} into a knowledge base${repeats}.`;
    },
    flatten: (step, n) => {
        const sentence = flattenSentence(step);
        return `${n} ${sentence ? `Make ${sentence}` : 'Flatten a list (the list inside each item is not picked yet)'}.`;
    },
};

/**
 * The author's line for step number `idx + 1`.
 * @param {AnyStep} step
 * @param {number} idx
 */
function describeStep(step, idx) {
    const n = `${idx + 1}.`;
    if (Object.hasOwn(STEP_LINES, step.type)) return STEP_LINES[step.type](step, n);
    return require('./summariseTables').describeTableStep(step, n) || `${n} ${step.type} step (${step.id}).`;
}

/**
 * Whether a live run of the step leaves something behind the author should be
 * told about.
 * @type {Record<string, (step: AnyStep) => boolean>}
 */
const SIDE_EFFECTS = {
    integration_action: (s) => isSideEffect(s.tool),
    code: () => true,
    notification: () => true,
    // It writes a real file that persists past the run and can be downloaded
    // by whoever the automation hands it to. Cheaper than an email, but not
    // nothing — the author should be told a live run will actually produce it.
    generate_document: () => true,
    // Same for a filled document — and more so with saveCopy, which also
    // leaves a document behind in the library.
    fill_document: () => true,
    // And for a deck — a real file kept past the run. A slide is an object in
    // the run state, nothing outlives it.
    presentation: () => true,
    // A datatable WRITE outlives the run and other automations read it, so the
    // author must be told a live run will really change it. Decided per FIELD
    // rather than per type, like integration_action's isSideEffect(s.tool).
    datatable: (s) => !!s.op && s.op !== 'find_rows',
    // A knowledge-base write outlives the run like a datatable write, and goes
    // one further: an agent will later state its text as fact with a citation.
    // There is no read variant of this step, so it is decided per TYPE.
    knowledge_write: () => true,
};

/** @param {AnyStep} step */
const stepHasSideEffect = (step) => Object.hasOwn(SIDE_EFFECTS, step.type) && SIDE_EFFECTS[step.type](step);

// ── The builder model's line ────────────────────────────────────────

/** A collection step over a list. @param {AnyStep} step */
const overList = (step) => ` over \`${step.arrayRef || ''}\`${step.field ? ` field=${step.field}` : ''}${step.op ? ` op=${step.op}` : ''}`;

/** @param {AnyStep} step */
function returnToAppDetail(step) {
    return ` → app${step.navigateTo?.screenId ? ` screen=\`${step.navigateTo.screenId}\`` : ''}${step.toast?.message ? ` says "${String(step.toast.message).slice(0, 40)}"` : ''}${step.refresh ? ` refresh=${step.refresh}` : ''} (ends the run)`;
}

/** @param {AnyStep} step */
function slideDetail(step) {
    return ` "${step.title || ''}"${step.layout ? ` layout=${step.layout}` : ''}${step.chart && step.chart.type ? ` chart=${step.chart.type}` : ''}${step.stats ? ' stats' : ''}${step.style ? ` style=${step.style}` : ''}${step.forEach ? ` per item of \`${step.forEach.overRef || ''}\`` : ''}`;
}

/**
 * The detail after `id type` in the model's line, per step type.
 * @type {Record<string, (step: AnyStep, opts: StateOpts) => string>}
 */
const STEP_DETAILS = {
    integration_action: (step) => ` ${step.tool || '?'}`,
    ai_step: (step) => ` (${step.modelTier || 'auto'})`,
    condition: (step) => ` if \`${step.expr}\``,
    tokenize: (step) => ` hide \`${step.sourceRef || '?'}\` cats=[${(step.categories || []).join(', ') || 'org'}]`,
    guard: (step) => ` scan \`${step.sourceRef || '?'}\` cats=[${(step.categories || []).join(', ') || 'org'}]${step.onFound && step.onFound.stop ? ' stop' : ''}${step.onFound && step.onFound.mask ? ' mask' : ''}`,
    switch: (step) => ` on \`${step.expr}\` cases=[${(step.cases || []).map((/** @type {AnyStep} */ c) => c.name).join(', ')}]`,
    loop: (step) => ` over \`${step.overRef}\` as loop.${step.itemVar} (${(step.body || []).length} body step(s))`,
    set: (step) => ` fields=${bindingMap(step.fields)}`,
    parse_json: (step) => ` (${step.mode === 'ai' ? 'ai' : 'paths'}) fields=[${fieldNames(step.fields).join(', ')}]${step.sourceRef ? ` src=\`${step.sourceRef}\`` : ''}`,
    layer_output: (step) => ` returns=${bindingMap(step.fields)}`,
    call_layer: (step) => ` layer=\`${step.layerKey || '?'}\``,
    call_block: (step) => ` block=\`${step.blockId || '?'}\``,
    notification: (step) => ` ${(step.channels || ['notification']).join(',')}${step.title ? ` "${step.title}"` : ''}`,
    code: (step, opts) => describeCodeStep(step, opts.codeParams),
    datetime: (step) => ` op=${step.op || 'now'}${typeof step.arrayRef === 'string' ? ' (per row)' : ''}`,
    wait: (step) => ` ${step.seconds || 0}s`,
    approval: (step) => (step.prompt ? ` ask: ${String(step.prompt).slice(0, 60)}` : ' no question yet'),
    form_page: (step) => (step.mode === 'ending' ? ' closing page' : ` ask ${(step.form?.fields || []).length} question(s)`),
    stop_error: (step) => ` "${step.message || ''}"`,
    return_to_app: returnToAppDetail,
    generate_document: (step) => ` ${step.format === 'docx' ? 'Word' : 'PDF'} from \`${step.content || ''}\``,
    fill_document: (step) => ` doc=\`${step.documentId || 'not picked'}\` values=[${Object.keys(step.values || {}).join(', ')}]`,
    slide: slideDetail,
    presentation: (step) => ` ${step.format === 'pdf' ? 'PDF deck' : 'PowerPoint'} from ${Array.isArray(step.slides) ? `${step.slides.length} slide reference(s)` : `\`${typeof step.slides === 'string' ? step.slides : ''}\``}`,
    data_extraction: (step) => ` fields=[${(Array.isArray(step.fields) ? step.fields : []).map((/** @type {AnyStep | null} */ f) => (f && f.name ? `${f.name}:${f.type || 'string'}` : null)).filter(Boolean).join(', ')}] from ${describeRef(step.source)}`,
    knowledge_write: (step) => ` → kb \`${step.knowledgeBaseId || 'not picked'}\` from \`${step.content || ''}\`${step.sourceUri ? ` src=\`${step.sourceUri}\`` : ' (no sourceUri — a new document each run)'}`,
    filter: overList,
    limit: overList,
    dedupe: overList,
    aggregate: overList,
    summarize: overList,
    flatten: describeFlatten,
    // A canvas annotation — never runs, never wired. Shown so the agent can
    // see (and edit) it without mistaking it for a step it could chain
    // something after.
    note: (step) => ` "${String(step.text || '').replace(/\s+/g, ' ').slice(0, 60)}" (annotation — never runs)`,
};

/** The step types whose model line ends with their input bindings. */
const SHOWS_INPUTS = new Set(['integration_action', 'ai_step', 'call_layer', 'call_block', 'code']);

/**
 * One line per step: `id` type detail — label [forEach] ← inputs.
 *
 * `opts.codeParams(code)` answers a code step's declared parameters
 * (default: analyzeCode's `params`); tests hand in their own.
 * @param {AnyStep} step
 * @param {StateOpts} [opts]
 */
function renderStepState(step, opts = {}) {
    const detail = Object.hasOwn(STEP_DETAILS, step.type)
        ? STEP_DETAILS[step.type](step, opts)
        : require('./summariseTables').tableDetail(step);
    const inputs = SHOWS_INPUTS.has(step.type) ? bindingMap(step.inputs) : '';
    const fe = step.forEach?.overRef ? `  [forEach over \`${step.forEach.overRef}\` as loop.${step.forEach.itemVar || 'item'}]` : '';
    const label = step.label ? `  — ${step.label}` : '';
    const inLine = inputs && inputs !== '∅' ? `  ← inputs ${inputs}` : '';
    return `  - \`${step.id}\` ${step.type}${detail}${label}${fe}${inLine}`;
}

module.exports = { describeStep, stepHasSideEffect, renderStepState };
