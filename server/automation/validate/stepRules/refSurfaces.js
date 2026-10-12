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

/** Field paths of the visitor-/approver-facing form texts the runner interpolates (formTriggerContract). */
const FORM_TEXT_KEYS = ['title', 'description', 'submitLabel', 'successMessage'];
const FIELD_TEXT_KEYS = ['label', 'placeholder', 'help'];

function collectStepRefs(step) {
    const refs = [];
    const template = (value, where) => {
        if (typeof value === 'string' && value) collectRefPaths({ kind: 'template', value }, refs, where);
    };
    // A string is a template; a binding object is a binding. Several fields
    // accept both (an import or an MCP patch can carry either shape).
    const templateOrBinding = (value, where) => {
        if (typeof value === 'string') template(value, where);
        else if (value && typeof value === 'object') collectRefPaths(value, refs, where);
    };
    const ref = (value, where) => {
        if (typeof value === 'string' && value) refs.push({ kind: 'ref', path: value, where });
    };
    const expr = (value, where, extra = {}) => {
        if (typeof value === 'string' && value) refs.push({ kind: 'expr', src: value, where, ...extra });
    };
    const formFields = (fields, where) => {
        (Array.isArray(fields) ? fields : []).forEach((f, i) => {
            if (!isObject(f)) return;
            for (const k of FIELD_TEXT_KEYS) template(f[k], `${where}[${i}].${k}`);
            (Array.isArray(f.options) ? f.options : []).forEach((o, j) => {
                if (isObject(o)) template(o.label, `${where}[${i}].options[${j}].label`);
            });
        });
    };

    collectRefPaths(step.inputs, refs, 'inputs');
    // forEach iteration source resolves like a loop's overRef — on any step.
    if (isObject(step.forEach)) ref(step.forEach.overRef, 'forEach.overRef');

    switch (step.type) {
        case 'notification':
            template(step.title, 'title');
            template(step.body, 'body');
            break;
        case 'condition':
            expr(step.expr, 'expr', { host: 'topics' });
            break;
        case 'guard':
        case 'tokenize':
        case 'untokenize':
        case 'parse_json':
            ref(step.sourceRef, 'sourceRef');
            break;
        case 'loop':
            ref(step.overRef, 'overRef');
            break;
        case 'set': {
            // Field exprs are parse-checked by the set rule (set.field_expr_parse).
            const from = refs.length;
            collectRefPaths(step.fields, refs, 'fields');
            for (let i = from; i < refs.length; i++) if (refs[i].kind === 'expr') refs[i].parse = false;
            ref(step.arrayRef, 'arrayRef');
            break;
        }
        case 'layer_output':
            collectRefPaths(step.fields, refs, 'fields');
            break;
        case 'datetime': {
            // Literal dates are a DOCUMENTED input (the executor falls back to
            // parsing the config value when walkPath misses) — running them
            // through the ref checks produced false `ref.invalid`/`unknown_root`
            // warnings for every fixed date (C10). `today` etc. still goes
            // through ref validation: the runtime genuinely can't parse it, so
            // its warning is CORRECT.
            const isDateLiteral = (v) => /^\d{4}-\d{2}-\d{2}([T ].+)?$/.test(v)
                || (!REF_ROOTS.has(rootOf(v)) && !Number.isNaN(Date.parse(v)));
            for (const f of ['input', 'input2']) {
                if (typeof step[f] === 'string' && step[f] && !isDateLiteral(step[f])) ref(step[f], f);
            }
            // The source list in list mode, so a renamed upstream step is caught
            // here exactly like a collection op's arrayRef.
            ref(step.arrayRef, 'arrayRef');
            break;
        }
        case 'stop_error':
            template(step.message, 'message');
            break;
        case 'return_to_app':
            // Both are {{…}} templates the runner interpolates. Without them a
            // renamed or copied step silently points nowhere: the toast is
            // empty and the app opens a record screen without a record.
            template(step.toast?.message, 'toast.message');
            template(step.navigateTo?.recordRef, 'navigateTo.recordRef');
            break;
        case 'data_extraction':
            // The text the step reads is a binding like any input, so a source
            // pointing at a renamed, deleted or LATER step is caught here
            // rather than at run time ("there is no text to read"). A bare
            // string is read the way the runner reads it: a template when it
            // has placeholders, a path when it starts with a data root, else
            // literal text.
            if (typeof step.source === 'string' && step.source.trim()) {
                if (hasPlaceholder(step.source)) template(step.source, 'source');
                else if (isBareRefString(step.source)) ref(step.source.trim(), 'source');
            } else {
                collectRefPaths(step.source, refs, 'source');
            }
            break;
        case 'generate_document':
            // `content` is almost always a reference to an upstream step, so a
            // typo there must warn like any other bad ref rather than silently
            // producing an empty document.
            for (const f of ['content', 'title', 'fileName']) template(step[f], f);
            break;
        case 'slide': {
            for (const f of ['title', 'content', 'notes', 'image']) template(step[f], f);
            // chart.data and stats are the visual bindings: a template string
            // or a {kind} binding either way; the chart's labels/values/unit
            // are interpolated too (execPresentation), and stats may be a list.
            const chart = isObject(step.chart) ? step.chart : {};
            templateOrBinding(chart.data, 'chart.data');
            for (const f of ['labels', 'values', 'unit']) template(chart[f], `chart.${f}`);
            if (Array.isArray(step.stats)) step.stats.forEach((s, i) => templateOrBinding(s, `stats[${i}]`));
            else templateOrBinding(step.stats, 'stats');
            break;
        }
        case 'presentation': {
            for (const f of ['title', 'subtitle', 'fileName', 'accent', 'background', 'logo', 'footerText', 'copyName']) template(step[f], f);
            // `slides` is the flexible one: a template string, or a list whose
            // string items (and the string values of object items) are
            // templates — a typo in "{{steps.s1.output.slide}}" must warn.
            const walk = (v, where, depth = 0) => {
                if (depth > 3 || v === null || v === undefined) return;
                if (typeof v === 'string') { template(v, where); return; }
                if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`, depth + 1)); return; }
                if (isObject(v)) {
                    if (typeof v.kind === 'string') { collectRefPaths(v, refs, where); return; }
                    for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`, depth + 1);
                }
            };
            walk(step.slides, 'slides');
            break;
        }
        case 'fill_document':
            // `fileName` and every VALUE is a `{{…}}` template resolved at run
            // time, and a value is almost always a reference to an upstream
            // step — so a typo there must warn instead of silently printing a
            // blank line on an invoice.
            template(step.fileName, 'fileName');
            template(step.copyName, 'copyName');
            if (isObject(step.values)) {
                for (const [k, v] of Object.entries(step.values)) templateOrBinding(v, `values.${k}`);
            }
            break;
        case 'switch':
            // The source list + the per-case rules resolve like any other
            // ref. Rule exprs reference `item` in list mode, which the runtime
            // injects per row. Parse errors are the switch rule's to report.
            expr(step.expr, 'expr', { host: 'topics' });
            ref(step.arrayRef, 'arrayRef');
            (Array.isArray(step.cases) ? step.cases : []).forEach((c, i) => {
                if (isObject(c)) expr(c.expr, `cases[${i}].expr`, { host: 'topics' });
            });
            break;
        case 'filter':
            // Its expr reads `item` per element; the filter rule parse-checks it.
            expr(step.expr, 'expr', { host: 'topics' });
            ref(step.arrayRef, 'arrayRef');
            break;
        case 'limit':
        case 'dedupe':
        case 'aggregate':
        case 'summarize':
            ref(step.arrayRef, 'arrayRef');
            break;
        case 'flatten':
            ref(step.arrayRef, 'arrayRef');
            (Array.isArray(step.parents) ? step.parents : []).forEach((p, i) => {
                if (isObject(p)) ref(p.overRef, `parents[${i}].overRef`);
            });
            break;
        case 'knowledge_write':
            // The same three-template shape generate_document has. A binding
            // OBJECT is accepted too: a definition is data, and an import or an
            // MCP patch can carry the shape the builder's older tools used.
            for (const f of ['content', 'title', 'sourceUri']) templateOrBinding(step[f], f);
            break;
        case 'datatable':
            // A datatable carries its bindings in `values`, `where[].value` and
            // `cursor`, not in `inputs`: a value pointing at a renamed, deleted
            // or LATER step reached run time, where a write turns it into NULL
            // and a condition into a skip. `cursor` is how a loop walks a table
            // bigger than one page ({{steps.page1.output.nextCursor}}).
            collectRefPaths(step.values, refs, 'values');
            templateOrBinding(step.cursor, 'cursor');
            (Array.isArray(step.where) ? step.where : []).forEach((w, i) => {
                if (isObject(w)) collectRefPaths(w.value, refs, `where[${i}].value`);
            });
            break;
        case 'http_request':
            // All three are interpolated (execHttpRequest), so a request that
            // names a renamed or deleted step sends blanks.
            template(step.url, 'url');
            if (isObject(step.headers)) {
                for (const [k, v] of Object.entries(step.headers)) template(v, `headers.${k}`);
            }
            template(step.body, 'body');
            // The structured query: keys, values and the JSON text are templates too.
            if (isObject(step.query)) {
                template(step.query.json, 'query.json');
                (Array.isArray(step.query.items) ? step.query.items : []).forEach((it, i) => {
                    if (!isObject(it)) return;
                    template(it.key, `query.items[${i}].key`);
                    template(it.value, `query.items[${i}].value`);
                });
            }
            break;
        case 'approval': {
            // The question and everything around it is rendered for the
            // approver against the paused run (execApproval): a reference to a
            // deleted step asks someone to approve a blank.
            template(step.prompt, 'prompt');
            const a = isObject(step.approval) ? step.approval : {};
            template(a.details, 'approval.details');
            formFields(a.fields, 'approval.fields');
            (Array.isArray(a.attachments) ? a.attachments : []).forEach((att, i) => {
                if (isObject(att)) template(att.binding, `approval.attachments[${i}].binding`);
            });
            (Array.isArray(a.stages) ? a.stages : []).forEach((st, i) => {
                if (!isObject(st)) return;
                template(st.name, `approval.stages[${i}].name`);
                template(st.description, `approval.stages[${i}].description`);
                // Evaluated with no host, like any binding; nothing else parses it.
                expr(st.when, `approval.stages[${i}].when`, { parse: true });
            });
            break;
        }
        case 'form_page': {
            // The visitor-facing texts, rendered against the run (renderFormPage).
            const form = isObject(step.form) ? step.form : {};
            for (const k of FORM_TEXT_KEYS) template(form[k], `form.${k}`);
            formFields(form.fields, 'form.fields');
            break;
        }
        default:
            break;
    }
    return refs;
}

module.exports = { collectStepRefs };
