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
 * Tool steps check the misses of their own resolution (execIntegrationAction).
 * The other executors resolve their text themselves, so `preflightBlankInputs`
 * reads the same fields once more, ahead of the executor, the way it does.
 * Not covered on purpose: knowledge_write (an empty text is a documented
 * skip), fill_document `values` (reported as `missing`), approval prompts and
 * datatable writes (their own pause / per-row flows).
 */
'use strict';

const { withBindingLog, describeBindingMiss, interpolateTemplate, noteMiss } = require('../automationModel/bind');

const HTTP_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READS_STEP_OUTPUT = /^steps[.[]/;

/** Step type → the template strings the executor interpolates, as [field, value] pairs. */
const FIELDS = {
    notification: (s) => [['title', s.title], ['body', s.body]],
    http_request: (s) => [
        ['url', s.url],
        ...Object.entries(s.headers || {}).map(([k, v]) => [`headers.${k}`, v]),
        ...(HTTP_WRITE_METHODS.has(String(s.method || 'GET').toUpperCase()) ? [['body', s.body]] : []),
    ],
    generate_document: (s) => [['title', s.title], ['content', s.content]],
    fill_document: (s) => (s.saveCopy ? [['copyName', s.copyName]] : []),
    presentation: (s) => [['title', s.title], ['subtitle', s.subtitle], ...(s.saveCopy === true ? [['copyName', s.copyName]] : [])],
};

/** Misses that leave a hole in a write (see the header). */
const isBlank = (m) => (m.kind === 'expr' && (m.reason === 'syntax' || m.reason === 'error'))
    || ((m.kind === 'template' || m.kind === 'expr') && m.reason === 'missing'
        && typeof m.path === 'string' && READS_STEP_OUTPUT.test(m.path));

function failOnBlankInputs(step, misses) {
    const blank = misses.filter(isBlank);
    if (!blank.length) return;
    const lines = blank.slice(0, 3).map(m => describeBindingMiss(m)).join('; ');
    const more = blank.length > 3 ? ` (and ${blank.length - 3} more)` : '';
    /** @type {import('./runnerError.types').RunnerError} */
    const err = new Error(`Step ${step.id || '?'} was not run: its inputs read data that is not there. ${lines}${more}. `
        + 'Nothing was sent. If a field is optional, use an expr binding such as `x || \'\'`.');
    err.errorClass = 'binding_unresolved';
    throw err;
}

/** Throws before the executor runs when a live step of a covered type would write a hole. */
function preflightBlankInputs(step, runState, mode) {
    const fieldsOf = FIELDS[step.type];
    if (!fieldsOf || mode === 'dry_run') return;
    // The executor logs its own misses and run warnings; this pass stays out of both.
    const state = { ...runState, _templateWarnings: undefined };
    const misses = [];
    withBindingLog(misses, () => {
        for (const [field, value] of fieldsOf(step)) {
            if (typeof value === 'string' && value.includes('{{')) interpolateTemplate(value, state, { field });
        }
    });
    if (!misses.some(isBlank)) return;
    for (const m of misses) noteMiss({ ...m });
    failOnBlankInputs(step, misses);
}

module.exports = { failOnBlankInputs, preflightBlankInputs };

/**
 * The step fields this pass reads.
 * @typedef {{ id?: string, type?: string, title?: string, body?: string, url?: string, headers?: Record<string, string>,
 *             method?: string, content?: string, subtitle?: string, saveCopy?: boolean, copyName?: string }} BlankInputStep
 */
