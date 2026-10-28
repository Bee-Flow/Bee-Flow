// @typecheck
/**
 * A live write must not go out with a hole in it.
 *
 * The step fails BEFORE anything is sent, naming the input and the path, when
 *   (a) an expr binding does not parse or throws, or
 *   (b) a `{{…}}` or formula reads a field of a step that DID run and the field
 *       is not there (the output has another shape than the mapping assumed).
 * Everything else stays a warning: a step that did not run (a join after a dead
 * branch, a partial or replayed run) and optional payload keys of the trigger,
 * a loop item or a layer input, which a template has no default syntax for.
 * The hint says how to make a field optional.
 *
 * Tool steps check the misses of their own resolution (execIntegrationAction),
 * and so does an AI step that is offered a tool with a side effect (execAi):
 * the model writes with whatever its prompt and inputs gave it.
 * The other executors resolve their text themselves, so `preflightBlankInputs`
 * reads the same fields once more, ahead of the executor, the way it does:
 * notification, http_request, the document steps, knowledge_write (a text
 * that is EMPTY is still the documented skip; a field that is not there is a
 * hole), approval (the prompt, details and attachments a person decides on),
 * the datatable writes (`values` of add_row, save_row and update_rows) and
 * return_to_app (the record and the toast the App Studio app is handed).
 * Not covered on purpose: fill_document `values` (reported as `missing`).
 */
'use strict';

const { withBindingLog, describeBindingMiss, interpolateTemplate, noteMiss, resolveValue, underField } = require('../automationModel/bind');

const HTTP_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READS_STEP_OUTPUT = /^steps[.[]/;

/**
 * Step type → what the executor resolves, as [field, value, how] triples.
 * `how` is 'template' (a `{{…}}` string; the default), 'mixed' (a template
 * string or a binding object, as knowledge_write reads them) or 'binding' (a
 * binding object; a bare string is a literal, as resolveInputs reads it).
 * @type {Record<string, (s: BlankInputStep) => Array<[string, unknown, ('template'|'mixed'|'binding')?]>>}
 */
const FIELDS = {
    notification: (s) => [['title', s.title], ['body', s.body]],
    http_request: (s) => [
        ['url', s.url],
        ...Object.entries(s.headers || {}).map(([k, v]) => /** @type {[string, unknown]} */ ([`headers.${k}`, v])),
        ...(HTTP_WRITE_METHODS.has(String(s.method || 'GET').toUpperCase()) ? [/** @type {[string, unknown]} */ (['body', s.body])] : []),
    ],
    generate_document: (s) => [['title', s.title], ['content', s.content]],
    fill_document: (s) => (s.saveCopy ? [['copyName', s.copyName]] : []),
    presentation: (s) => [['title', s.title], ['subtitle', s.subtitle], ...(s.saveCopy === true ? [/** @type {[string, unknown]} */ (['copyName', s.copyName])] : [])],
    knowledge_write: (s) => [['content', s.content, 'mixed'], ['title', s.title, 'mixed'], ['sourceUri', s.sourceUri, 'mixed']],
    approval: (s) => {
        const a = (s.approval && typeof s.approval === 'object') ? s.approval : {};
        const attachments = Array.isArray(a.attachments) ? a.attachments : [];
        return [
            ['prompt', s.prompt],
            ['details', a.details],
            ...attachments.map((att, i) => /** @type {[string, unknown]} */ ([`attachments[${i}]`, att && att.binding])),
        ];
    },
    datatable: (s) => (DATATABLE_VALUE_WRITES.has(s.op) && s.values && typeof s.values === 'object'
        ? Object.entries(s.values).map(([k, v]) => /** @type {[string, unknown, 'binding']} */ ([`values.${k}`, v, 'binding']))
        : []),
    return_to_app: (s) => [
        ['navigateTo.recordRef', s.navigateTo && s.navigateTo.recordRef],
        ['toast.message', s.toast && s.toast.message],
    ],
};

/** The datatable ops whose `values` become cells (delete_rows has none). */
const DATATABLE_VALUE_WRITES = new Set(['add_row', 'save_row', 'update_rows']);

/** Misses that leave a hole in a write (see the header). */
const isBlank = (/** @type {{ kind: string; reason: string; path: string; }} */ m) => (m.kind === 'expr' && (m.reason === 'syntax' || m.reason === 'error'))
    || ((m.kind === 'template' || m.kind === 'expr') && m.reason === 'missing'
        && typeof m.path === 'string' && READS_STEP_OUTPUT.test(m.path));

function failOnBlankInputs(step, misses) {
    const blank = misses.filter(isBlank);
    if (!blank.length) return;
    const lines = blank.slice(0, 3).map((/** @type {{ count: number; }} */ m) => describeBindingMiss(m)).join('; ');
    const more = blank.length > 3 ? ` (and ${blank.length - 3} more)` : '';
    /** @type {import('./runnerError.types').RunnerError} */
    const err = new Error(`Step ${step.id || '?'} was not run: its inputs read data that is not there. ${lines}${more}. `
        + 'Nothing was sent. If a field is optional, use an expr binding such as `x || \'\'`.');
    err.errorClass = 'binding_unresolved';
    throw err;
}

/** Resolve one field the way its executor does, so its misses land in the log. */
function resolveField(field, value, how, state) {
    if (typeof value === 'string') {
        if (how !== 'binding' && value.includes('{{')) interpolateTemplate(value, state, { field });
        return;
    }
    if (how !== 'template' && value && typeof value === 'object') underField(field, () => resolveValue(value, state, { allowSecrets: false }));
}

/** Throws before the executor runs when a live step of a covered type would write a hole. */
function preflightBlankInputs(step, runState, mode) {
    const fieldsOf = FIELDS[step.type];
    if (!fieldsOf || mode === 'dry_run') return;
    // The executor logs its own misses and run warnings; this pass stays out of both.
    const state = { ...runState, _templateWarnings: undefined };
    /**
     * @type {{ kind: string; reason: string; path: string; }[]}
     */
    const misses = [];
    withBindingLog(misses, () => {
        for (const [field, value, how = 'template'] of fieldsOf(step)) resolveField(field, value, how, state);
    });
    if (!misses.some(isBlank)) return;
    for (const m of misses) noteMiss({ ...m });
    failOnBlankInputs(step, misses);
}

module.exports = { failOnBlankInputs, preflightBlankInputs };

/**
 * The step fields this pass reads.
 * @typedef {{ id?: string, type?: string, title?: unknown, body?: string, url?: string, headers?: Record<string, string>,
 *             method?: string, content?: unknown, subtitle?: string, saveCopy?: boolean, copyName?: string,
 *             sourceUri?: unknown, prompt?: string, approval?: { details?: string, attachments?: Array<{ binding?: string }> },
 *             op?: string, values?: Record<string, unknown>,
 *             navigateTo?: { recordRef?: string }, toast?: { message?: string } }} BlankInputStep
 */
