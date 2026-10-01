/**
 * Where each step type keeps the values it is given: THE one table of it.
 *
 * A step keeps bindings in more places than `inputs`. A notification's body
 * and an HTTP request's url are `{{ }}` texts on the step itself, a set step
 * has `fields`, a datatable has `values` and `where[].value`, a loop reads
 * the list in `overRef`. Every check that has to see all of a step's values
 * (the validator, the builder, an upgrade) reads them through
 * stepBindingSites instead of keeping its own list of fields, so a field
 * added to a step type is added here once.
 *
 * Five kinds of site:
 *   text     a text the run renders with interpolateTemplate: a `{{ }}`
 *            string, or (where `compose` is true) a compose binding. `each`
 *            marks a map whose every value is such a text (fill_document's
 *            values, http_request's headers).
 *   binding  a structure holding binding objects at any depth.
 *   list     the list a step works through: a legacy path string, or (for
 *            a loop's `over` and a step's `repeat.over`) a Source.
 *   ref      a single value read by legacy path (a guard's sourceRef).
 *   expr     an expression ("cases" holds one per switch case).
 *
 * `compose: false` marks the texts whose executor still reads a plain string
 * only (it checks `typeof === 'string'` first); a compose stored there would
 * render as nothing, so the editor must not offer one. sites.test.mjs holds
 * every interpolateTemplate call in the runner to an entry here.
 *
 * `lift: false` marks a text that renders a compose but whose `{{ }}` text
 * is never turned into one (template.mjs templateToCompose), not by the AI
 * builder and not by the editor: an ai_step's prompt reads the step's own
 * inputs by name (`{{emails}}`), which no pick can say; a slide's content
 * renders a list as a markdown bullet list that starts its own block, which
 * a compose's 'bullets' join does not (yet). A compose stored there is still
 * read and kept as one.
 */

const text = (field, { compose = true, each = false, lift = compose } = {}) => Object.freeze({ field, compose, each, lift });

/** Sites every step has, whatever its type. */
export const COMMON_SITES = Object.freeze({
    bindings: Object.freeze(['inputs']),
    lists: Object.freeze(['forEach.overRef', 'repeat.over']),
});

/** The sites of each step type beyond COMMON_SITES. */
export const STEP_SITES = Object.freeze({
    ai_step: { text: [text('prompt', { lift: false })] },
    approval: { text: [text('prompt'), text('approval.details', { compose: false })] },
    form_page: { text: [text('form', { compose: false })] },
    notification: { text: [text('title'), text('body')] },
    http_request: { text: [text('url'), text('headers', { compose: false, each: true }), text('body')] },
    stop_error: { text: [text('message')] },
    return_to_app: { text: [text('toast.message', { compose: false }), text('navigateTo.recordRef', { compose: false })] },
    data_extraction: { text: [text('source')] },
    generate_document: { text: [text('content'), text('title'), text('fileName')] },
    fill_document: { text: [text('fileName'), text('copyName'), text('values', { each: true })] },
    knowledge_write: { text: [text('content'), text('title'), text('sourceUri')] },
    slide: {
        text: [
            text('title'), text('content', { lift: false }), text('notes'), text('image'),
            text('chart.labels', { compose: false }), text('chart.values', { compose: false }), text('chart.unit', { compose: false }),
        ],
        bindings: ['chart.data', 'stats'],
    },
    presentation: { text: [text('title'), text('subtitle'), text('fileName'), text('copyName')], bindings: ['slides'] },
    set: { bindings: ['fields'], lists: ['arrayRef'] },
    layer_output: { bindings: ['fields'] },
    datatable: { bindings: ['values', 'where', 'cursor'] },
    loop: { lists: ['overRef', 'over'] },
    filter: { lists: ['arrayRef'], exprs: ['expr'] },
    limit: { lists: ['arrayRef'] },
    dedupe: { lists: ['arrayRef'] },
    aggregate: { lists: ['arrayRef'] },
    summarize: { lists: ['arrayRef'] },
    switch: { lists: ['arrayRef'], exprs: ['expr', 'cases'] },
    condition: { exprs: ['expr'] },
    guard: { refs: ['sourceRef'] },
    tokenize: { refs: ['sourceRef'] },
    untokenize: { refs: ['sourceRef'] },
    parse_json: { refs: ['sourceRef'] },
    datetime: { refs: ['input', 'input2'], lists: ['arrayRef'] },
});

/** The value at a dotted field of a step (own properties only), or undefined. */
export function fieldValue(step, field) {
    let cur = step;
    for (const key of String(field).split('.')) {
        if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
        cur = cur[key];
    }
    return cur;
}

/**
 * The text sites of a step type, as `{ field, compose, each, lift }`. Empty for a
 * type that has none (or is not known).
 * @param {string} stepType
 */
export function textSitesOf(stepType) {
    const entry = Object.prototype.hasOwnProperty.call(STEP_SITES, stepType) ? STEP_SITES[stepType] : null;
    return entry && entry.text ? entry.text : [];
}

/**
 * Every place a step keeps a value, present on this step:
 * `{ kind, field, value, compose? }`, in table order. A field the step does
 * not have is left out.
 * @param {object} step
 * @returns {Array<{ kind: 'text'|'binding'|'list'|'ref'|'expr', field: string, value: unknown, compose?: boolean }>}
 */
export function stepBindingSites(step) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
    const out = [];
    const add = (kind, field, extra) => {
        const value = fieldValue(step, field);
        if (value !== undefined) out.push({ kind, field, value, ...extra });
    };
    for (const f of COMMON_SITES.bindings) add('binding', f);
    for (const f of COMMON_SITES.lists) add('list', f);
    const entry = Object.prototype.hasOwnProperty.call(STEP_SITES, step.type) ? STEP_SITES[step.type] : null;
    if (!entry) return out;
    for (const site of entry.text || []) {
        if (!site.each) { add('text', site.field, { compose: site.compose }); continue; }
        const map = fieldValue(step, site.field);
        if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
        for (const key of Object.keys(map)) {
            out.push({ kind: 'text', field: `${site.field}.${key}`, value: map[key], compose: site.compose });
        }
    }
    for (const f of entry.bindings || []) add('binding', f);
    for (const f of entry.lists || []) add('list', f);
    for (const f of entry.refs || []) add('ref', f);
    for (const f of entry.exprs || []) {
        if (f !== 'cases') { add('expr', f); continue; }
        const cases = Array.isArray(step.cases) ? step.cases : [];
        cases.forEach((c, i) => {
            if (c && typeof c === 'object' && c.expr !== undefined) out.push({ kind: 'expr', field: `cases.${i}.expr`, value: c.expr });
        });
    }
    return out;
}
