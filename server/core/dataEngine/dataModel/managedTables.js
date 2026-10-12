/**
 * MANAGED datatables — a table whose COLUMNS the platform owns.
 *
 * An ordinary datatable is the author's: they add columns, rename them, drop
 * them. A managed one is the other way round. Its shape is a contract between
 * a feature that WRITES rows (today: the http_request step's "remember answers
 * in a table" tick) and a person who READS them — so the writer may assume
 * `cache_key` exists, is unique and is a text column, and the reader may assume
 * a dropped column is impossible rather than merely discouraged.
 *
 * `datatables.managed_kind` is the whole marker. NULL means an ordinary table
 * and is the overwhelming majority; a non-null value names the contract below.
 *
 * ── WHAT IS AND IS NOT LOCKED ───────────────────────────────────────
 * ONLY the declared columns. Everything else about a managed table is an
 * ordinary table: its rows are listable, sortable, filterable, exportable,
 * editable and deletable, another automation's `find_rows` can read it, it takes
 * the same Art. 30 description, it counts against the same quota and it is
 * swept by the same retention job. Adding a column of your own is allowed —
 * the writer names its columns explicitly, so an extra one costs it nothing.
 *
 * What is refused is DROPPING or RETYPING a declared column, because both turn
 * the next write into a 500 at 3am inside somebody's nightly automation, and the
 * person who did it has no way to know that. Renaming is a drop under another
 * name: `normalizeFields` matches by id first, so an edit that keeps the id and
 * changes the key is exactly how a column disappears from under the writer.
 *
 * ── WHY THE IDS ARE HARD-CODED ──────────────────────────────────────
 * `normalizeFields` mints an id for any field that arrives without one, and the
 * migration planner diffs BY ID. A managed table provisioned twice would
 * otherwise carry two different sets of ids for one contract, which is fine
 * until something wants to say "this column is the cache key" about a table it
 * did not create. The ids are part of the contract, so they are written down.
 */

'use strict';

/**
 * The visible half of "ask this web service only once": one row per answer,
 * expired by the ordinary retention sweeper rather than by an invisible TTL.
 *
 * NOTE what is NOT here: the resolved URL and its query string. `execOutbound`
 * interpolates `step.url` against RAW runState, so `{{secrets.api_key}}`
 * resolves INTO it — the standard shape for the keyed REST APIs this feature
 * targets — and these are plaintext, org-readable, CSV-exportable columns. The
 * query travels only inside the hashed `cache_key`.
 */
const HTTP_CACHE_FIELDS = Object.freeze([
    // Unique because the writer upserts on it: ON CONFLICT needs a unique index
    // to name as its conflict target, and it is precisely the assumption
    // execDatatable's own save_row cannot make about an author's table.
    { id: 'fld_hcachekey', key: 'cache_key', name: 'Answer key', type: 'text', required: true, unique: true },
    { id: 'fld_hcachehost', key: 'request_host', name: 'Service', type: 'text' },
    { id: 'fld_hcachepath', key: 'request_path', name: 'Path', type: 'text' },
    { id: 'fld_hcachemeth', key: 'request_method', name: 'Method', type: 'text' },
    { id: 'fld_hcachestat', key: 'response_status', name: 'Status', type: 'number' },
    { id: 'fld_hcachebody', key: 'response_body', name: 'Answer', type: 'text' },
    { id: 'fld_hcachehead', key: 'response_headers', name: 'Answer headers', type: 'text' },
    { id: 'fld_hcachetime', key: 'fetched_at', name: 'Fetched at', type: 'datetime' },
]);

/**
 * The two columns EVERY form-answers table has beside the form's questions:
 * which journey (root run) a submission started, and when it was complete.
 * `completed_at` stays NULL while a multi-page form is still being answered —
 * "open" is the honest reading of an abandoned page 2.
 */
const FORM_ANSWERS_FIELDS = Object.freeze([
    { id: 'fld_faxrunid', key: 'run_id', name: 'Run', type: 'text' },
    { id: 'fld_faxcompl', key: 'completed_at', name: 'Completed', type: 'datetime' },
]);

/**
 * The cells of a SPREADSHEET document (Studio → Documents, docType
 * 'spreadsheet'; core/documents/sheet). One row per sheet row: `row_no` is
 * the 1-based row number (unique, so a row is found by its number and two
 * writers cannot both create row 7), and `a` … `z` hold what was typed in
 * that column — a value or a formula as text (`=SUM(A1:A3)`). Formulas are
 * evaluated by the shared sheet engine (shared/expr/sheet.mjs), never stored
 * evaluated: the table holds what a person typed, like a spreadsheet file.
 *
 * Every column is text on purpose: a cell holds a number in one row and a
 * word in the next, and a typed column would refuse half of what people type.
 */
const SHEET_COLUMN_KEYS = Object.freeze('abcdefghijklmnopqrstuvwxyz'.split(''));
const DOCUMENT_SHEET_FIELDS = Object.freeze([
    { id: 'fld_sheetrowno', key: 'row_no', name: 'Row', type: 'number', subtype: 'integer', required: true, unique: true },
    ...SHEET_COLUMN_KEYS.map((k) => ({ id: `fld_sheetcol_${k}`, key: k, name: k.toUpperCase(), type: 'text' })),
]);

const MANAGED_KINDS = Object.freeze({
    /**
     * A spreadsheet document's cells (DOCUMENT_SHEET_FIELDS above). Made by the
     * document when it is created, never through POST /managed
     * (`madeByDocument`): a sheet table without its document is a grid nobody
     * can open. Its rows are an ordinary table's for everyone else — automations
     * and apps read them like any other.
     */
    document_sheet: Object.freeze({
        kind: 'document_sheet',
        label: 'Cells of a spreadsheet document',
        fields: DOCUMENT_SHEET_FIELDS,
        madeByDocument: true,
        // Like a form's answers: aged by when the row was made, and off until
        // the owner sets a window (a spreadsheet is kept until it is deleted).
        retentionField: 'created_at',
        defaultRetentionDays: null,
        defaultDescription: 'The cells of a spreadsheet in Documents: what was typed in each cell, values and formulas, one row per sheet row.',
        warning: 'The cells are stored in plain text, readable by everyone with access to the spreadsheet or this table.',
    }),
    /**
     * The answers to a FORM (automation/formAnswers): the third shape. Not an
     * external source (nothing to sync, no linker), not code-owned columns
     * (only the two above are) — the columns are the form's QUESTIONS, derived
     * from the automation's definition on every save and held in
     * `source.columnMap`. Rows are written by the platform when somebody
     * submits. `fieldsFromDefinition` is what makes the whole list locked here
     * and lets retention apply like an ordinary table.
     */
    form_answers: Object.freeze({
        kind: 'form_answers',
        label: 'Answers to a form',
        fields: FORM_ANSWERS_FIELDS,
        fieldsFromDefinition: true,
        // Answers age by when they were given; off until the owner sets it.
        retentionField: 'created_at',
        defaultRetentionDays: null,
        defaultDescription: 'Answers people gave on a form, one row per submission. Holds whatever the form asks for — treat it as personal data.',
        warning: 'Every answer is stored in plain text, readable and exportable by everyone with access to this table.',
    }),
    /**
     * A mirror of a Nextcloud Tables table or view
     * (core/dataEngine/sources/nextcloudTable). The inverse of http_cache:
     * there NOTHING is fixed — every column comes from Nextcloud — and so the
     * WHOLE list is locked (`fieldsFromSource`), not a declared subset. The
     * columns change when Nextcloud's do, through the mirror engine's own
     * reconciliation, never through the schema route.
     */
    nextcloud_table: Object.freeze({
        kind: 'nextcloud_table',
        label: 'A table from Nextcloud',
        // The word a sentence uses for where the rows live ("the columns of
        // this table come from Nextcloud"), and the badge the App Studio
        // builder shows on a table linked to it. Both are read through
        // core/dataEngine/sources — no consumer compares the kind itself.
        sourceLabel: 'Nextcloud',
        builderKind: 'nextcloud',
        fields: Object.freeze([]),
        fieldsFromSource: true,
        // No retention: the rows are Nextcloud's, and a sweep here would only
        // delete a copy the next refresh puts straight back.
        retentionField: null,
        defaultRetentionDays: null,
        defaultDescription: 'A copy of a Nextcloud table, kept in step with Nextcloud so automations, apps and pages can read and change it here.',
        // The one thing an editor would not guess: their edit reaches Nextcloud
        // under somebody else's name.
        warning: 'Rows added, changed or deleted here are written to the Nextcloud table on behalf of the account that linked it.',
    }),
    /**
     * A mirror of ONE worksheet of a spreadsheet file kept in Google Drive,
     * OneDrive or Nextcloud Files (core/dataEngine/sources/spreadsheetFile).
     * The same shape as nextcloud_table: the whole column list is the
     * file's header row, locked here, reconciled by the engine.
     */
    spreadsheet_file: Object.freeze({
        kind: 'spreadsheet_file',
        label: 'A spreadsheet from your files',
        sourceLabel: 'the spreadsheet',
        builderKind: 'spreadsheet',
        fields: Object.freeze([]),
        fieldsFromSource: true,
        retentionField: null,
        defaultRetentionDays: null,
        defaultDescription: 'A copy of one worksheet of a spreadsheet kept in Google Drive, OneDrive or Nextcloud Files, kept in step with the file so automations, apps and pages can read and change it here.',
        // Two things an editor would not guess: their edit lands in a file
        // under somebody else's name, and a file is not a database.
        warning: 'Rows added, changed or deleted here are written into the file on behalf of the account that linked it. Cell styles are kept where the format allows; charts, pivot tables and macros in the file are not touched but cannot be preserved on every write.',
    }),
    http_cache: Object.freeze({
        kind: 'http_cache',
        label: 'Web service answers',
        fields: HTTP_CACHE_FIELDS,
        // Rows age out by when the answer was FETCHED, never by created_at: a
        // row is rewritten in place on every refresh, so created_at is the day
        // the key was first seen and would keep a daily-refreshed answer alive
        // for ever or delete a fresh one, depending which way you read it.
        retentionField: 'fetched_at',
        defaultRetentionDays: 30,
        // Shown in the create dialog and stored as the Art. 30 purpose. It is
        // pre-filled rather than skipped: the sentence is the processing record,
        // and "third-party responses" is a category an auditor asks about.
        defaultDescription: 'Answers this workspace\'s automations received from web services, kept so the same question is not paid for twice.',
        // The one thing the UI must say out loud, because it is a real
        // reduction against the hidden tier and nobody would guess it.
        warning: 'Rows here hold what a third-party service answered, in plain text, readable and exportable by everyone with access to this table.',
    }),
});

/** Is this a kind the platform knows how to provision? */
function isManagedKind(kind) {
    return typeof kind === 'string' && Object.hasOwn(MANAGED_KINDS, kind);
}

/** The contract for a kind, or null. Never throws — callers 400 on null. */
function managedKindSpec(kind) {
    return isManagedKind(kind) ? MANAGED_KINDS[kind] : null;
}

/**
 * A kind whose ENTIRE column list belongs to an external source. Such a table
 * cannot be provisioned by POST /managed (it has no columns of its own to
 * provision — they arrive with the link) and refuses every schema save.
 */
function isSourceManagedKind(kind) {
    const spec = managedKindSpec(kind);
    return !!(spec && spec.fieldsFromSource === true);
}

/**
 * A kind whose column list is derived from a DEFINITION inside Bee Flow (a
 * form's questions): locked like a source kind, but with nothing external to
 * sync — and, unlike a mirror, aged by the ordinary retention sweeper.
 */
function isDefinitionManagedKind(kind) {
    const spec = managedKindSpec(kind);
    return !!(spec && spec.fieldsFromDefinition === true);
}

/** Every kind that refuses the schema route outright. */
function isSchemaLockedKind(kind) {
    return isSourceManagedKind(kind) || isDefinitionManagedKind(kind);
}

/**
 * Refuse a column list that drops or retypes a managed column. Returns null
 * when the save is allowed, or the sentence to show the owner.
 *
 * Matched BY KEY, not by id: the key is what the writer's SQL names, and an
 * edit that keeps the id while changing the key is a rename — which is a drop
 * as far as the writer is concerned, and the shape `normalizeFields`'s
 * id-first matching makes easy to do by accident.
 *
 * `unique` and `required` are checked too. Dropping the unique index under an
 * upsert does not break the next write loudly — it breaks it by writing a
 * DUPLICATE row every run, which is the failure class this whole plan spent a
 * workstream removing.
 */
function managedFieldsError(kind, nextFields) {
    const spec = managedKindSpec(kind);
    if (!spec) return null;
    // Every column is the source's, so ANY list — an identical one included —
    // is refused: the only writer of these fields is the mirror engine, and
    // a save that happened to change nothing would still teach the designer
    // that saving is a thing it can do here.
    if (spec.fieldsFromSource) {
        return `The columns of this table come from ${spec.sourceLabel || 'the source'} — change them there; the next refresh picks them up.`;
    }
    // Same rule for a definition-owned list: the form is the only editor of
    // these columns. A column whose question is gone has its own route.
    if (spec.fieldsFromDefinition) {
        return 'The columns of this table are the form\'s questions — change them on the form. A column for a question that is no longer on the form can be removed from the table\'s Columns tab.';
    }
    const byKey = new Map((Array.isArray(nextFields) ? nextFields : [])
        .filter(f => f && typeof f.key === 'string').map(f => [f.key, f]));
    for (const want of spec.fields) {
        const got = byKey.get(want.key);
        if (!got) {
            return `"${want.key}" is part of how this table is filled in automatically — it cannot be removed or renamed.`;
        }
        if (got.type !== want.type) {
            return `"${want.key}" has to stay a ${want.type} column — it is filled in automatically.`;
        }
        if (want.unique && got.unique !== true) {
            return `"${want.key}" has to stay unique — without it every refresh would add a second row instead of replacing the first.`;
        }
        if (want.required && got.required !== true) {
            return `"${want.key}" has to stay required.`;
        }
    }
    return null;
}

module.exports = {
    MANAGED_KINDS,
    SHEET_COLUMN_KEYS,
    DOCUMENT_SHEET_FIELDS,
    HTTP_CACHE_FIELDS,
    FORM_ANSWERS_FIELDS,
    isManagedKind,
    isSourceManagedKind,
    isDefinitionManagedKind,
    isSchemaLockedKind,
    managedKindSpec,
    managedFieldsError,
};
