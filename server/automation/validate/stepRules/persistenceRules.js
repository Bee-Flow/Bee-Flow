/**
 * The two steps whose effect OUTLIVES the run: `knowledge_write`, whose output
 * an agent will later state as fact, and `datatable`, which reads and writes
 * rows of a user-defined table.
 *
 * Two of the datatable rules are safety rather than tidiness: an update or a
 * delete with no condition would touch every row, and a free-text `sql` key
 * must never become a supported field — the whole design rests on the query
 * compiler being the only producer of SQL.
 *
 * Everything about authorisation — may this automation write to that knowledge
 * base, may it see that table — is checked where the database is in hand, at
 * save time and again at run time. This file stays DB-free.
 */

const { isObject } = require('../helpers');
// The datatable filter vocabulary, IMPORTED rather than restated: the query
// compiler is what rejects an unknown op at run time, and a hand-copied list
// here would drift into telling the author their step is fine right up to the
// point the compiler throws a raw `unknown filter op` string at them. Safe to
// require — vocabulary.js is frozen literals with no requires of its own.
// KEY_RE comes from the same place for the same reason: it is what
// POST /api/datatables accepts as a table key, so a step's advisory
// `datatableKey` is held to the grammar a real key must satisfy — a key that
// could never name a table can only ever mis-link an import.
const { FILTER_OPS, KEY_RE } = require('../../../core/dataEngine/dataModel/vocabulary');
const {
    KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES,
    DATATABLE_OPS, DATATABLE_WRITE_OPS, DATATABLE_FILTERED_OPS,
    DATATABLE_MAX_FILTERS, DATATABLE_MAX_LIMIT, DATATABLE_MATCH_MODES, PENDING_DATATABLE_RE,
} = require('../constants');

function checkKnowledgeWrite(ctx, step, at) {
    const { pushE, pushW } = ctx;
    // ── knowledge_write ──────────────────────────────────────────────
    //
    // The OTHER step whose effect outlives the run — and the one whose
    // output an agent will later state as fact. Everything about the
    // knowledge base's authorisation is checked elsewhere (the route pass
    // at save and activate, and again at run time), because it needs the
    // database and this file is deliberately DB-free. What is checkable
    // here is the shape.
    if (step.type === 'knowledge_write') {
        if (!step.knowledgeBaseId || typeof step.knowledgeBaseId !== 'string') {
            pushE({ code: 'knowledge_write.kb_required', severity: 'error', path: at + '.knowledgeBaseId', message: `Step ${step.id}: pick a knowledge base to write to.`, hint: 'Only a knowledge base you may manage can be written to.' });
        }
        // Content is what the step is FOR. Empty, it runs, succeeds and
        // stores nothing — the failure nobody notices until an agent
        // cannot answer from a base somebody believed was being filled.
        // Whitespace counts as empty: the runner trims before it decides.
        const hasContent = typeof step.content === 'string'
            ? step.content.trim() !== ''
            : (step.content !== undefined && step.content !== null && step.content !== '');
        if (!hasContent) {
            pushE({ code: 'knowledge_write.content_required', severity: 'error', path: at + '.content', message: `Step ${step.id}: there is nothing to write.`, hint: 'Point `content` at the text this step should store — usually the output of an earlier step.' });
        }
        if (step.nearDuplicateStrategy !== undefined
            && !KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES.includes(step.nearDuplicateStrategy)) {
            pushE({ code: 'knowledge_write.strategy_invalid', severity: 'error', path: at + '.nearDuplicateStrategy', message: `Step ${step.id}: "${step.nearDuplicateStrategy}" is not a way to handle a near-duplicate.`, hint: `One of: ${KNOWLEDGE_WRITE_DUPLICATE_STRATEGIES.join(', ')}.` });
        }
        /**
         * A `sourceUri` is what makes this step idempotent: the same one
         * REPLACES its document instead of adding a second copy. Without
         * it an automation that runs nightly writes a new document every
         * night, and nothing about the knowledge base says why it grew.
         *
         * A warning, not an error: a one-off run that appends is a real
         * thing to want, and stage:'draft' would otherwise block a save
         * halfway through wiring it up.
         */
        // Trimmed: `'   '` resolves to null at run time, so treating it
        // as a reference would silence the warning for a step that in fact
        // has none.
        if (!(typeof step.sourceUri === 'string' ? step.sourceUri.trim() : step.sourceUri)) {
            pushW({ code: 'knowledge_write.no_source_uri', severity: 'warning', path: at + '.sourceUri', message: `Step ${step.id}: without a source reference this adds a NEW document every run.`, hint: 'Give it something stable and unique per subject — a ticket URL, a record id — and each run replaces its own document instead.' });
        }
    }
}

function checkDatatable(ctx, step, at) {
    const { pushE, pushW } = ctx;
    // ── datatable ────────────────────────────────────────────────────
    // One of the two steps whose effect outlives the run (the other is
    // `knowledge_write`, above). Two rules here are safety rather than
    // tidiness: an update or delete with no condition
    // would touch every row, and a free-text `sql` key must never become a
    // supported field — the whole design rests on the query compiler being
    // the only producer of SQL.
    if (step.type === 'datatable') {
        for (const forbidden of ['sql', 'query', 'rawSql', 'rawQuery']) {
            if (step[forbidden] !== undefined) {
                pushE({ code: 'datatable.sql_field_forbidden', severity: 'error', path: at + '.' + forbidden, message: `Step ${step.id}: a datatable step never takes \`${forbidden}\`.`, hint: 'Pick columns and conditions; the table is queried for you.' });
            }
        }
        // `datatableKey` is ADVISORY — the table's own slug, carried so an
        // export (which blanks the id) still says which table the step
        // wanted, and an import can re-link by it. It is never resolved at
        // run time; a wrong one can only mis-link an import, so it is held
        // to the grammar a real table key must satisfy.
        if (step.datatableKey !== undefined && step.datatableKey !== '' && step.datatableKey !== null) {
            if (typeof step.datatableKey !== 'string' || !KEY_RE.test(step.datatableKey)) {
                pushE({ code: 'datatable.key_invalid', severity: 'error', path: at + '.datatableKey', message: `Step ${step.id}: "${step.datatableKey}" is not a datatable key.`, hint: 'A table key is lowercase letters, numbers and underscores — copy it from the table, or leave it empty.' });
            }
        }
        if (!step.datatableId || typeof step.datatableId !== 'string') {
            // An imported step arrives here on purpose: export blanks the
            // id and keeps the key. Naming the key is the whole difference
            // between "pick a table again" and knowing which one it was.
            const wanted = (typeof step.datatableKey === 'string' && step.datatableKey) ? step.datatableKey : null;
            pushE({ code: 'datatable.table_missing', severity: 'error', path: at + '.datatableId', message: wanted
                ? `Step ${step.id}: this step wants the datatable "${wanted}", which is not linked here.`
                : `Step ${step.id}: pick which datatable to use.`, hint: wanted
                ? `Pick the table called "${wanted}" from the list, or create it — an imported automation never carries another workspace's table.`
                : 'Choose a table from the list.' });
        }
        // A table the builder only PROPOSED. Always an error here; the builder's
        // own preview filters this out for the refs it staged (chatStream), and
        // anywhere else (a PUT, a live run) it is the backstop that keeps a
        // never-created table out of a saved automation. Deliberately not a
        // completeness code: it must block at stage 'draft' too.
        if (typeof step.datatableId === 'string' && PENDING_DATATABLE_RE.test(step.datatableId)) {
            pushE({ code: 'datatable.table_pending', severity: 'error', ref: step.datatableId, path: at + '.datatableId', message: `Step ${step.id}: its table "${step.datatableKey || step.datatableId}" has not been created yet.`, hint: 'Apply the assistant\'s proposal that creates it, or pick an existing table.' });
        }
        if (!step.op) {
            pushE({ code: 'datatable.op_missing', severity: 'error', path: at + '.op', message: `Step ${step.id}: choose what to do with the table.`, hint: 'Find rows, add a row, add or update a row, update rows, or delete rows.' });
        } else if (!DATATABLE_OPS.has(step.op)) {
            pushE({ code: 'datatable.op_unknown', severity: 'error', path: at + '.op', message: `Step ${step.id}: "${step.op}" is not something a datatable can do.`, hint: `One of ${Array.from(DATATABLE_OPS).join(', ')}.` });
        }
        if (step.where !== undefined && !Array.isArray(step.where)) {
            pushE({ code: 'datatable.where_invalid', severity: 'error', path: at + '.where', message: `Step ${step.id}: conditions must be a list.`, hint: 'Each condition is a column, a test and a value.' });
        } else if (Array.isArray(step.where)) {
            if (step.where.length > DATATABLE_MAX_FILTERS) {
                pushE({ code: 'datatable.where_too_many', severity: 'error', path: at + '.where', message: `Step ${step.id}: at most ${DATATABLE_MAX_FILTERS} conditions.`, hint: 'Narrow the table instead.' });
            }
            step.where.forEach((w, i) => {
                if (!w || typeof w !== 'object' || !w.field || typeof w.field !== 'string') {
                    pushE({ code: 'datatable.where_field_missing', severity: 'error', path: `${at}.where[${i}].field`, message: `Step ${step.id}: condition ${i + 1} has no column.`, hint: 'Pick a column from the table.' });
                }
                if (!w || !w.op || typeof w.op !== 'string') {
                    pushE({ code: 'datatable.where_op_missing', severity: 'error', path: `${at}.where[${i}].op`, message: `Step ${step.id}: condition ${i + 1} has no test.`, hint: 'For example "is", "contains" or "is empty".' });
                } else if (!FILTER_OPS.includes(w.op)) {
                    // Only PRESENCE was checked, so an op the compiler has
                    // never heard of survived save and surfaced at run time
                    // as a raw `unknown filter op` from the query compiler.
                    pushE({ code: 'datatable.where_op_unknown', severity: 'error', path: `${at}.where[${i}].op`, message: `Step ${step.id}: "${w.op}" is not a test a datatable understands.`, hint: `One of ${FILTER_OPS.join(', ')}.` });
                }
            });
        }
        if (DATATABLE_FILTERED_OPS.has(step.op) && !(Array.isArray(step.where) && step.where.length > 0)) {
            pushE({ code: 'datatable.filter_missing', severity: 'error', path: at + '.where', message: `Step ${step.id}: "${step.op}" needs at least one condition.`, hint: 'Without one this would change every row in the table.' });
        }
        if (DATATABLE_WRITE_OPS.has(step.op) && step.op !== 'delete_rows') {
            const vals = step.values;
            if (!vals || typeof vals !== 'object' || Array.isArray(vals) || Object.keys(vals).length === 0) {
                pushE({ code: 'datatable.values_missing', severity: 'error', path: at + '.values', message: `Step ${step.id}: say which columns to write.`, hint: 'Map at least one column to a value.' });
            }
        }
        if (step.op === 'save_row' && (!step.matchColumn || typeof step.matchColumn !== 'string')) {
            pushE({ code: 'datatable.match_column_missing', severity: 'error', path: at + '.matchColumn', message: `Step ${step.id}: choose the column that decides whether a row already exists.`, hint: 'Usually an id or an email — it has to be unique in the table.' });
        } else if (step.op === 'save_row' && isObject(step.values) && !Object.hasOwn(step.values, step.matchColumn)) {
            // A match column the step does not write can never identify the
            // row it just wrote, so "add or update" silently degrades to
            // "always add" — one duplicate per run, for ever.
            pushE({ code: 'datatable.match_column_unmapped', severity: 'error', path: at + '.values', message: `Step ${step.id}: "${step.matchColumn}" decides whether the row already exists, so this step has to write it too.`, hint: `Map "${step.matchColumn}" in the columns to write, or match on a column you do write.` });
        }
        if (step.match !== undefined && !DATATABLE_MATCH_MODES.has(step.match)) {
            pushE({ code: 'datatable.match_unknown', severity: 'error', path: at + '.match', message: `Step ${step.id}: "${step.match}" is not a way to combine conditions.`, hint: `Either "all" (every condition must hold) or "any" (one is enough).` });
        }
        if (step.match === 'any' && DATATABLE_FILTERED_OPS.has(step.op)) {
            // "any" on an update or a delete is one wrong condition away
            // from matching most of the table, and the author cannot see
            // the row count before it runs.
            pushW({ code: 'datatable.match_any_on_write', severity: 'warning', path: at + '.match', message: `Step ${step.id}: "${step.op}" with "any of these conditions" changes every row that matches ANY one of them.`, hint: 'Use "all" unless you really mean the union — a single broad condition then decides the whole write.' });
        }
        // `sort` is read by the executor and allowlisted for patching, but
        // compileRecordList honours sort[0] ONLY — a second entry is
        // silently ignored, which reads as "sorted by two columns" in the
        // editor and is not.
        if (step.sort !== undefined) {
            if (!Array.isArray(step.sort)) {
                pushE({ code: 'datatable.sort_invalid', severity: 'error', path: at + '.sort', message: `Step ${step.id}: the sort is a list of {field, dir}.`, hint: 'Pick one column and a direction.' });
            } else {
                step.sort.forEach((sEntry, i) => {
                    if (!isObject(sEntry) || typeof sEntry.field !== 'string' || !sEntry.field) {
                        pushE({ code: 'datatable.sort_field_missing', severity: 'error', path: `${at}.sort[${i}].field`, message: `Step ${step.id}: sort ${i + 1} has no column.`, hint: 'Pick a column from the table.' });
                    }
                    const dir = sEntry && (sEntry.dir || sEntry.direction);
                    if (dir !== undefined && dir !== null && !['asc', 'desc'].includes(String(dir).toLowerCase())) {
                        pushE({ code: 'datatable.sort_dir_unknown', severity: 'error', path: `${at}.sort[${i}].dir`, message: `Step ${step.id}: "${dir}" is not a sort direction.`, hint: 'Either "asc" or "desc".' });
                    }
                });
                if (step.sort.length > 1) {
                    pushW({ code: 'datatable.sort_extra_ignored', severity: 'warning', path: at + '.sort', message: `Step ${step.id}: only the first sort column is used.`, hint: 'The rows are ordered by that column and then by row id — remove the others so the step says what it does.' });
                }
            }
        }
        if (step.limit !== undefined) {
            const n = Number(step.limit);
            if (!Number.isInteger(n) || n < 1 || n > DATATABLE_MAX_LIMIT) {
                pushE({ code: 'datatable.limit_range', severity: 'error', path: at + '.limit', message: `Step ${step.id}: the row limit must be between 1 and ${DATATABLE_MAX_LIMIT}.`, hint: 'Leave it empty for the default.' });
            }
        }
    }
}

module.exports = { checkKnowledgeWrite, checkDatatable };
