/**
 * The rows themselves — ungated by licence (the drain exemption).
 *
 * Read a page, read one, add, edit, import a spreadsheet, export the lot as
 * CSV, delete one, delete a selection. Every statement is compiled by
 * core/dataEngine/queryCompiler with the access filter ANDed in; a table that
 * mirrors an external source writes to the source first and copies back.
 *
 * A Solution stage's reference table (descriptor `rowsLocked`) refuses every
 * write in the compiler with 409 `managed_part`; answerDatatableError answers
 * it like any other refusal, and the bulk import lets it through whole.
 */

'use strict';

const queryCompiler = require('../../core/dataEngine/queryCompiler');
const { requireDatatableGrade } = require('./grade');
const H = require('./rowHandlers');
const T = require('./rowTransfer');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded, bodyOf, choice, idText } = require('./schemas');

// ── What a caller may send ──────────────────────────────────────────
//
// The LIST query is `.strict()`, and that is the point of this block. Every
// parameter here NARROWS what comes back, so a misspelled one used to be
// dropped and the list then answered a WIDER question than the one it was
// asked — `?fitlers=[…]` returned the whole table to somebody looking at what
// they believed was a filtered view, under a 200. The descriptor's own checks
// (rowDescriptor.js) close the INSIDE of `filters`; nothing closed the set of
// parameter names.
//
// The Studio sends exactly these seven (datatablesApi.listRows).
const NUM_TEXT = 'limit is a number of rows.';
const one = (name, what) => worded(`${name} is ${what}.`).trim().min(1, `${name} is ${what}.`).optional();
const ListQuery = z.object({
    // JSON on the wire; rowDescriptor.readFilters parses it and resolves
    // every field key against THIS table's declared columns.
    filters: one('filters', 'a list of {field, op, value} as JSON'),
    match: choice(queryCompiler.MATCH_MODES, 'Rows match all of the conditions, or any of them').optional(),
    sort: one('sort', 'a column of this table'),
    dir: choice(['asc', 'desc'], 'Sort ascending or descending').optional(),
    q: worded('q is the text to look for.').optional(),
    // Clamped by the compiler's own rule (queryCompiler.clampLimit), never
    // re-derived here — a route that derived its own let `?limit=-5` through
    // and then sliced by it. What the schema adds is that `?limit=veel` is
    // named rather than silently becoming the default page.
    limit: z.coerce.number({ error: typeError({ invalid: NUM_TEXT }) }).int(NUM_TEXT).positive(NUM_TEXT).optional(),
    cursor: one('cursor', 'the value a previous page returned as nextCursor'),
}).strict();

const VALUES_TEXT = 'Say which columns to set — { values: { … } }';
const values = () => z.record(z.string(), z.unknown(), { error: typeError({ required: VALUES_TEXT, invalid: VALUES_TEXT }) });

const UPDATED_AT_TEXT = 'Send the updated_at you read, so a colleague\'s edit is not silently overwritten';

// `values` is REQUIRED, not `req.body?.values || {}`. That fall-back turned a
// misspelled key — `{"valeus": {...}}` — into an INSERT of a row with nothing
// in it, answered 200 with the id of the empty row it had just made.
const InsertBody = bodyOf({ values: values() });

const UpdateBody = bodyOf({
    values: values().refine((v) => Object.keys(v).length > 0, { message: VALUES_TEXT }),
    expectedUpdatedAt: idText(UPDATED_AT_TEXT),
});

const ROWS_TEXT = 'Send { rows: [...] }';
const BulkBody = bodyOf({
    // Per-ROW shape is reported by LINE from inside the handler: a 400-row
    // paste with two bad dates in it is a fixable import, not one refusal.
    rows: z.array(z.unknown(), { error: ROWS_TEXT }),
});

const IDS_TEXT = 'Send { ids: ["rec_…", …] }';
const BulkDeleteBody = bodyOf({
    ids: z.array(idText(IDS_TEXT), { error: IDS_TEXT }),
});

// The routes that read nothing at all from the request but the path.
const NO_QUERY = z.object({}).strict();
const NOTHING = bodyOf({});

/**
 * The CSV export takes no descriptor, and says so.
 *
 * It streams the whole table under the same access filter as a read — there
 * is no `?filters=` here and there never was. Strict rather than ignored: a
 * client that appended the row list's filters would otherwise download
 * EVERY row while believing it had exported the view on screen.
 */
const ExportQuery = z.object({}).strict();

/**
 * The route table. Handler bodies live in rowHandlers.js (one row, a page, a
 * selection) and rowTransfer.js (the bulk import and the CSV export).
 */
function register(router) {
    router.get('/:id/rows', requireDatatableGrade('viewer'), validate({ query: ListQuery }), H.listRows);

    /**
     * ONE row. The access filter is ANDed in, so a row the caller may not see
     * returns 0 rows and reads as 404 — the same rule the whole surface follows.
     */
    router.get('/:id/rows/:rowId', requireDatatableGrade('viewer'), validate({ query: NO_QUERY }), H.getRow);

    router.post('/:id/rows', requireDatatableGrade('editor'), validate({ body: InsertBody, query: NO_QUERY }), H.insertRow);

    /**
     * EDIT a row.
     *
     * There was no way to change one anywhere in the product, so fixing a typo
     * meant delete-and-retype: a new id, a new created_at, a lost created_by, and
     * every automation keyed on the row id pointing at nothing.
     *
     * `expectedUpdatedAt` is REQUIRED, not optional. compileUpdate has carried the
     * token from the start and every read returns `updated_at`, so a client cannot
     * fail to have one — while a save without it is last-write-wins on a surface
     * two colleagues can have open at once. 400 when it is absent, 409
     * `row_conflict` when it is stale, and the two are told apart by re-reading the
     * row: "changed under you" and "gone / not yours" need different answers.
     */
    router.put('/:id/rows/:rowId', requireDatatableGrade('editor'), validate({ body: UpdateBody, query: NO_QUERY }), H.updateRow);

    /**
     * BULK IMPORT — a spreadsheet, in one request.
     *
     * Every row is validated against the declared columns BEFORE anything is
     * written, and the answer is per-row errors WITH THEIR LINE NUMBERS rather than
     * one refusal for the whole file: a 400-row paste with two bad dates in it is a
     * fixable import, and "invalid input syntax for type timestamptz" is not an
     * answer a person can act on.
     *
     * Writes go through datatableDbStore.batch in chunks — one transaction per
     * chunk, so a failure part-way leaves the chunk unapplied instead of half of
     * it, and row_count is bumped by what actually landed.
     */
    router.post('/:id/rows/bulk', requireDatatableGrade('editor'), validate({ body: BulkBody, query: NO_QUERY }), T.bulkImport);

    /**
     * CSV EXPORT — the whole table, in ONE response.
     *
     * Streamed by keyset page rather than buffered: a 100,000-row table is 2,000
     * requests at the row list's page size and one array of 100,000 objects in
     * memory if it is assembled first. The access filter is compiled exactly as it
     * is for a read, so an export can never contain a row the caller could not
     * already see on screen.
     */
    router.get('/:id/rows.csv', requireDatatableGrade('viewer'), validate({ query: ExportQuery }),
        require('../../compliance/dataPortability/stampExport')('datatables'), T.exportCsv);

    router.delete('/:id/rows/:rowId', requireDatatableGrade('editor'), validate({ body: NOTHING, query: NO_QUERY }), H.deleteRow);

    /**
     * POST /:id/rows/bulk-delete { ids } — a selection, deleted in ONE transaction.
     *
     * The single delete's path, N times: the same compiled statement with the same
     * access predicate ANDed in, so a row the caller may not see is not deleted
     * and not counted, and the counter only moves by what Postgres reports gone.
     * One engine batch rather than N round trips, and all-or-nothing: a selection
     * that half-vanished is harder to reason about than one that did not.
     *
     * Answers `{ deleted, requested }` — a 200 with `deleted: 0` when none of the
     * ids were there or visible, where the single delete says 404. A selection is
     * a set of guesses about the current page; "none of them applied" is a result,
     * not a missing resource.
     */
    router.post('/:id/rows/bulk-delete', requireDatatableGrade('editor'), validate({ body: BulkDeleteBody, query: NO_QUERY }), H.bulkDelete);
}

module.exports = { register };

