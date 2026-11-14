// @typecheck
'use strict';

/**
 * Every place a step carries a reference the runner resolves, gathered into
 * one list for referenceScoping.js.
 *
 * Each step type keeps its references somewhere of its own — `inputs`, a
 * template string on the step, a rule's expression, a datatable's `values`
 * and `where[].value`, an approval's details and stage conditions — and a
 * surface missing from this file is one whose references reach run time
 * unchecked (an HTTP request pointing at a deleted step validated clean and
 * sent blanks). The list mirrors what the executors in
 * core/automationRunner/ read; portability.js renames ids on ALL of a step's
 * values, so it cannot miss one of these.
 *
 * Entries:
 *   { kind: 'ref',  path, where, template? }  a reference path (`where` names the field)
 *   { kind: 'expr', src, where, host?, parse?, binding? }
 *       `host: 'topics'` — the runner evaluates it with the topic host (isAbout);
 *       `parse`          — whether referenceScoping reports a parse error: true
 *                          where nothing else parses it; a `{kind:'expr'}`
 *                          binding (`binding: true`) defaults to true.
 */

const { isObject, collectRefPaths, rootOf } = require('../helpers');
const { REF_ROOTS, hasPlaceholder, isBareRefString } = require('../refPaths');
const { collectTableOpRefs } = require('./tableOpRefs.mts');

/** Field paths of the visitor-/approver-facing form texts the runner interpolates (formTriggerContract). */
const FORM_TEXT_KEYS = ['title', 'description', 'submitLabel', 'successMessage'];
const FIELD_TEXT_KEYS = ['label', 'placeholder', 'help'];

/** The surfaces' readers, each pushing onto one list. */
class RefCollector {
    constructor() {
        /** @type {any[]} */
        this.refs = [];
    }

    /** A `{{…}}` template string. @param {unknown} value @param {string} where */
    template(value, where) {
        if (typeof value === 'string' && value) collectRefPaths({ kind: 'template', value }, this.refs, where);
    }

    /**
     * A string is a template; a binding object is a binding. Several fields
     * accept both (an import or an MCP patch can carry either shape).
     * @param {unknown} value @param {string} where
     */
    templateOrBinding(value, where) {
        if (typeof value === 'string') this.template(value, where);
        else if (value && typeof value === 'object') collectRefPaths(value, this.refs, where);
    }

    /** A binding, or any structure of them. @param {unknown} value @param {string} where */
    bindings(value, where) {
        collectRefPaths(value, this.refs, where);
    }

    /** A plain reference path. @param {unknown} value @param {string} where */
    ref(value, where) {
        if (typeof value === 'string' && value) this.refs.push({ kind: 'ref', path: value, where });
    }

    /** An expression. @param {unknown} value @param {string} where @param {object} [extra] */
    expr(value, where, extra = {}) {
        if (typeof value === 'string' && value) this.refs.push({ kind: 'expr', src: value, where, ...extra });
    }

    /** The texts of form fields and their options. @param {unknown} fields @param {string} where */
    formFields(fields, where) {
        (Array.isArray(fields) ? fields : []).forEach((f, i) => {
            if (!isObject(f)) return;
            for (const k of FIELD_TEXT_KEYS) this.template(f[k], `${where}[${i}].${k}`);
            (Array.isArray(f.options) ? f.options : []).forEach((o, j) => {
                if (isObject(o)) this.template(o.label, `${where}[${i}].options[${j}].label`);
            });
        });
    }
}

/** @typedef {(step: any, c: RefCollector) => void} Surface */

/** @param {unknown} v @returns {any[]} */
const listOf = (v) => (Array.isArray(v) ? v : []);
/** @param {unknown} v @returns {Record<string, unknown>} */
const objectOf = (v) => (isObject(v) ? /** @type {Record<string, unknown>} */ (v) : {});
/** @param {...string} fields @returns {Surface} */
const templates = (...fields) => (step, c) => { for (const f of fields) c.template(step[f], f); };
/** @param {...string} fields @returns {Surface} */
const templatesOrBindings = (...fields) => (step, c) => { for (const f of fields) c.templateOrBinding(step[f], f); };
/** @param {string} field @returns {Surface} */
const refField = (field) => (step, c) => c.ref(step[field], field);

/** Field exprs are parse-checked by the set rule (set.field_expr_parse). @type {Surface} */
function setRefs(step, c) {
    const from = c.refs.length;
    c.bindings(step.fields, 'fields');
    for (let i = from; i < c.refs.length; i++) if (c.refs[i].kind === 'expr') c.refs[i].parse = false;
    c.ref(step.arrayRef, 'arrayRef');
}

/**
 * Literal dates are a DOCUMENTED input (the executor falls back to parsing the
 * config value when walkPath misses), so they are not refs: checking them gave
 * false `ref.invalid`/`unknown_root` warnings for every fixed date (C10).
 * `today` etc. still goes through ref validation: the runtime genuinely cannot
 * parse it, so its warning is CORRECT.
 * @param {string} v
 */
const isDateLiteral = (v) => /^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(v)
    || (!REF_ROOTS.has(rootOf(v)) && !Number.isNaN(Date.parse(v)));

/** @type {Surface} */
function datetimeRefs(step, c) {
    for (const f of ['input', 'input2']) {
        if (typeof step[f] === 'string' && step[f] && !isDateLiteral(step[f])) c.ref(step[f], f);
    }
    // The source list in list mode, so a renamed upstream step is caught
    // here exactly like a collection op's arrayRef.
    c.ref(step.arrayRef, 'arrayRef');
}

/**
 * The run data an AI step's allowed-value lists, checks and fallback read
 * (aiStepReliability.js). Plain run paths, not {{ }} templates: a path to a
 * deleted, renamed or LATER step reaches run time as a list that is not there,
 * and every answer then fails its check. The prompt and inputs keep the
 * behaviour described at the top of checkReferences (inputs are collected for
 * every step; the prompt has its own lint).
 * @type {Surface}
 */
function aiStepRefs(step, c) {
    listOf(step.enumFrom).forEach((e, i) => {
        if (isObject(e)) c.ref(e.ref, `enumFrom[${i}].ref`);
    });
    listOf(step.checks).forEach((ch, i) => {
        if (!isObject(ch)) return;
        c.ref(ch.ref, `checks[${i}].ref`);
        c.ref(ch.sameCountAs, `checks[${i}].sameCountAs`);
    });
    if (isObject(step.fallback)) c.bindings(step.fallback.fields, 'fallback.fields');
}

/**
 * The text the step reads is a binding like any input, so a source pointing at
 * a renamed, deleted or LATER step is caught here rather than at run time
 * ("there is no text to read"). A bare string is read the way the runner reads
 * it: a template when it has placeholders, a path when it starts with a data
 * root, else literal text.
 * @type {Surface}
 */
function dataExtractionRefs(step, c) {
    if (!(typeof step.source === 'string' && step.source.trim())) { c.bindings(step.source, 'source'); return; }
    if (hasPlaceholder(step.source)) c.template(step.source, 'source');
    else if (isBareRefString(step.source)) c.ref(step.source.trim(), 'source');
}

/**
 * chart.data and stats are the visual bindings: a template string or a {kind}
 * binding either way; the chart's labels/values/unit are interpolated too
 * (execPresentation), and stats may be a list.
 * @type {Surface}
 */
function slideRefs(step, c) {
    for (const f of ['title', 'content', 'notes', 'image']) c.template(step[f], f);
    const chart = objectOf(step.chart);
    c.templateOrBinding(chart.data, 'chart.data');
    for (const f of ['labels', 'values', 'unit']) c.template(chart[f], `chart.${f}`);
    if (Array.isArray(step.stats)) step.stats.forEach((s, i) => c.templateOrBinding(s, `stats[${i}]`));
    else c.templateOrBinding(step.stats, 'stats');
}

/**
 * A presentation's `slides`: a template string, or a list whose string items
 * (and the string values of object items) are templates — a typo in
 * "{{steps.s1.output.slide}}" must warn.
 * @param {RefCollector} c @param {unknown} v @param {string} where @param {number} depth
 */
function slidesRefs(c, v, where, depth) {
    if (depth > 3 || v === null || v === undefined) return;
    if (typeof v === 'string') { c.template(v, where); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => slidesRefs(c, x, `${where}[${i}]`, depth + 1)); return; }
    if (!isObject(v)) return;
    const o = /** @type {Record<string, unknown>} */ (v);
    if (typeof o.kind === 'string') { c.bindings(o, where); return; }
    for (const [k, x] of Object.entries(o)) slidesRefs(c, x, `${where}.${k}`, depth + 1);
}

/** @type {Surface} */
function presentationRefs(step, c) {
    templates('title', 'subtitle', 'fileName', 'accent', 'background', 'logo', 'footerText', 'copyName')(step, c);
    slidesRefs(c, step.slides, 'slides', 0);
}

/**
 * `fileName` and every VALUE is a `{{…}}` template resolved at run time, and a
 * value is almost always a reference to an upstream step — so a typo there must
 * warn instead of silently printing a blank line on an invoice.
 * @type {Surface}
 */
function fillDocumentRefs(step, c) {
    c.template(step.fileName, 'fileName');
    c.template(step.copyName, 'copyName');
    if (isObject(step.values)) {
        for (const [k, v] of Object.entries(step.values)) c.templateOrBinding(v, `values.${k}`);
    }
}

/**
 * The source list and the per-case rules resolve like any other ref. Rule
 * exprs reference `item` in list mode, which the runtime injects per row. Parse
 * errors are the switch rule's to report.
 * @type {Surface}
 */
function switchRefs(step, c) {
    c.expr(step.expr, 'expr', { host: 'topics' });
    c.ref(step.arrayRef, 'arrayRef');
    listOf(step.cases).forEach((cs, i) => {
        if (isObject(cs)) c.expr(cs.expr, `cases[${i}].expr`, { host: 'topics' });
    });
}

/** @type {Surface} */
function flattenRefs(step, c) {
    c.ref(step.arrayRef, 'arrayRef');
    listOf(step.parents).forEach((p, i) => {
        if (isObject(p)) c.ref(p.overRef, `parents[${i}].overRef`);
    });
}

/** @type {Surface} */
function kbQueryLogRefs(step, c) {
    templatesOrBindings('knowledgeBaseId', 'entryId', 'status', 'note')(step, c);
    if (isObject(step.filters)) for (const [k, v] of Object.entries(step.filters)) c.templateOrBinding(v, `filters.${k}`);
}

/**
 * A datatable carries its bindings in `values`, `where[].value` and `cursor`,
 * not in `inputs`: a value pointing at a renamed, deleted or LATER step reached
 * run time, where a write turns it into NULL and a condition into a skip.
 * `cursor` is how a loop walks a table bigger than one page
 * ({{steps.page1.output.nextCursor}}).
 * @type {Surface}
 */
function datatableRefs(step, c) {
    c.bindings(step.values, 'values');
    c.templateOrBinding(step.cursor, 'cursor');
    listOf(step.where).forEach((w, i) => {
        if (isObject(w)) c.bindings(w.value, `where[${i}].value`);
    });
}

/**
 * All three are interpolated (execHttpRequest), so a request that names a
 * renamed or deleted step sends blanks; the structured query's keys, values
 * and JSON text are templates too.
 * @type {Surface}
 */
function httpRequestRefs(step, c) {
    c.template(step.url, 'url');
    if (isObject(step.headers)) {
        for (const [k, v] of Object.entries(step.headers)) c.template(v, `headers.${k}`);
    }
    c.template(step.body, 'body');
    if (!isObject(step.query)) return;
    c.template(step.query.json, 'query.json');
    listOf(step.query.items).forEach((it, i) => {
        if (!isObject(it)) return;
        c.template(it.key, `query.items[${i}].key`);
        c.template(it.value, `query.items[${i}].value`);
    });
}

/**
 * The question and everything around it is rendered for the approver against
 * the paused run (execApproval): a reference to a deleted step asks someone to
 * approve a blank. A stage condition is evaluated with no host, like any
 * binding; nothing else parses it.
 * @type {Surface}
 */
function approvalRefs(step, c) {
    c.template(step.prompt, 'prompt');
    const a = objectOf(step.approval);
    c.template(a.details, 'approval.details');
    c.formFields(a.fields, 'approval.fields');
    listOf(a.attachments).forEach((att, i) => {
        if (isObject(att)) c.template(att.binding, `approval.attachments[${i}].binding`);
    });
    listOf(a.stages).forEach((st, i) => {
        if (!isObject(st)) return;
        c.template(st.name, `approval.stages[${i}].name`);
        c.template(st.description, `approval.stages[${i}].description`);
        c.expr(st.when, `approval.stages[${i}].when`, { parse: true });
    });
}

/**
 * The run-data sources of a form field's dynamic options and per-item
 * questions, and the texts it renders from them. `showIf` is NOT scanned: its
 * `form` root is page-local and would read as an unknown root.
 * @param {RefCollector} c
 * @param {{ optionsFrom?: { ref?: unknown }, fieldsFrom?: { ref?: unknown }, content?: unknown, options?: unknown }} f
 * @param {string} fp
 */
function formFieldSourceRefs(c, f, fp) {
    if (isObject(f.optionsFrom)) c.ref(f.optionsFrom.ref, `${fp}.optionsFrom.ref`);
    if (isObject(f.fieldsFrom)) c.ref(f.fieldsFrom.ref, `${fp}.fieldsFrom.ref`);
    c.template(f.content, `${fp}.content`);
    listOf(f.options).forEach((o, j) => {
        if (isObject(o)) c.template(o.hint, `${fp}.options[${j}].hint`);
    });
}

/** The visitor-facing texts, rendered against the run (renderFormPage), and the page condition. @type {Surface} */
function formPageRefs(step, c) {
    const form = objectOf(step.form);
    for (const k of FORM_TEXT_KEYS) c.template(form[k], `form.${k}`);
    c.formFields(form.fields, 'form.fields');
    c.expr(step.when, 'when', { parse: true });
    listOf(form.fields).forEach((f, i) => {
        if (isObject(f)) formFieldSourceRefs(c, f, `form.fields[${i}]`);
    });
}

const sourceRef = refField('sourceRef');
const arrayRef = refField('arrayRef');

/** Where each step type keeps its references, beyond `inputs` and `forEach`. @type {Record<string, Surface>} */
const SURFACES = {
    notification: templates('title', 'body'),
    condition: (step, c) => c.expr(step.expr, 'expr', { host: 'topics' }),
    guard: sourceRef,
    tokenize: sourceRef,
    untokenize: sourceRef,
    parse_json: sourceRef,
    loop: refField('overRef'),
    set: setRefs,
    layer_output: (step, c) => c.bindings(step.fields, 'fields'),
    datetime: datetimeRefs,
    stop_error: templates('message'),
    // Both are {{…}} templates the runner interpolates. Without them a renamed
    // or copied step silently points nowhere: the toast is empty and the app
    // opens a record screen without a record.
    return_to_app: (step, c) => {
        c.template(step.toast?.message, 'toast.message');
        c.template(step.navigateTo?.recordRef, 'navigateTo.recordRef');
    },
    ai_step: aiStepRefs,
    data_extraction: dataExtractionRefs,
    // `content` is almost always a reference to an upstream step, so a typo
    // there must warn like any other bad ref rather than silently producing an
    // empty document.
    generate_document: templates('content', 'title', 'fileName'),
    slide: slideRefs,
    presentation: presentationRefs,
    fill_document: fillDocumentRefs,
    switch: switchRefs,
    // Its expr reads `item` per element; the filter rule parse-checks it.
    filter: (step, c) => {
        c.expr(step.expr, 'expr', { host: 'topics' });
        c.ref(step.arrayRef, 'arrayRef');
    },
    limit: arrayRef,
    dedupe: arrayRef,
    aggregate: arrayRef,
    summarize: arrayRef,
    flatten: flattenRefs,
    // The file: a form answer, a generated file's handle, or a path to either.
    read_table: (step, c) => c.bindings(step.source, 'source'),
    table: (step, c) => {
        c.bindings(step.source, 'source');
        collectTableOpRefs(step, c.refs);
    },
    // The same three-template shape generate_document has. A binding OBJECT is
    // accepted too: a definition is data, and an import or an MCP patch can
    // carry the shape the builder's older tools used.
    knowledge_write: templatesOrBindings('content', 'title', 'sourceUri'),
    kb_query_log: kbQueryLogRefs,
    datatable: datatableRefs,
    http_request: httpRequestRefs,
    approval: approvalRefs,
    form_page: formPageRefs,
};

function collectStepRefs(step) {
    const c = new RefCollector();
    c.bindings(step.inputs, 'inputs');
    // forEach iteration source resolves like a loop's overRef — on any step.
    if (isObject(step.forEach)) c.ref(step.forEach.overRef, 'forEach.overRef');
    if (typeof step.type === 'string' && Object.hasOwn(SURFACES, step.type)) SURFACES[step.type](step, c);
    return c.refs;
}

module.exports = { collectStepRefs };
