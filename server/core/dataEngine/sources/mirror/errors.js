/**
 * The ONE error shape any source mirror answers with, whoever asked.
 *
 * Three callers surface it and each reads a different property:
 *   • routes/datatables.js answerDatatableError reads `status` + string `code`
 *   • the runner's on_error branches match `errorClass`
 *   • appStudio/actionExecutor/records.js sourceRefusal and datatableRuntime
 *     pass a `safe` error's status/code/message through to the client
 * So every refusal carries all three, and `safe` is what says the message may
 * be shown to a person — it never contains a URL, a token or a stack.
 *
 * Each kind subclasses this (NextcloudSourceError, SpreadsheetSourceError) and
 * registers its code → errorClass map; `isSourceError` recognises all of them
 * by name so a route can answer any kind with one check.
 */

'use strict';

const ERROR_CLASSES = new Map();

/** A kind registers the errorClass its codes fall in (idempotent). */
function registerErrorClasses(map) {
    for (const [code, cls] of Object.entries(map || {})) ERROR_CLASSES.set(code, cls);
}

class SourceError extends Error {
    constructor(status, code, message, { errorClass = null, ref = null, detail = null, datatableId = null } = {}) {
        super(message);
        this.name = 'SourceError';
        this.status = status;
        this.code = code;
        this.errorClass = errorClass || ERROR_CLASSES.get(code) || 'datatable_source_error';
        this.safe = true;
        if (ref) this.ref = ref;
        if (detail) this.detail = detail;
        if (datatableId) this.datatableId = datatableId;
    }
}

const SOURCE_ERROR_NAMES = new Set(['SourceError', 'NextcloudSourceError', 'SpreadsheetSourceError']);

function isSourceError(e) {
    return !!e && SOURCE_ERROR_NAMES.has(e.name);
}

// A storage's own sentence is passed on, bounded: it is the only thing that
// tells an editor WHICH required column they left empty.
const MAX_DETAIL = 200;

module.exports = { SourceError, registerErrorClasses, isSourceError, MAX_DETAIL, SOURCE_ERROR_NAMES };
