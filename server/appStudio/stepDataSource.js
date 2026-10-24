/**
 * Read a DATA binding (record / records / aggregate) from inside a server step.
 *
 * WHY THIS EXISTS
 * `resolveBinding` in actionExecutor.js deliberately resolves only static/field/
 * formula. That is the right rule for it: a formula must never be able to read a
 * table, or a computed column would become an unaudited query channel. But it
 * left `ai_generate.promptContext` and `ai_extract` with nowhere to get live data
 * from — a promptContext bound to "the open ticket" resolved to null, so the AI
 * draft button sent the instruction sentence and nothing else. It looked like a
 * bad model; it was an empty prompt.
 *
 * WHY NOT RESOLVE IT IN THE BROWSER
 * The obvious shortcut is to let the client send the context along. But
 * ai_generate is a heavy step billed to the app OWNER, and that would let the
 * browser choose the payload it pays for — including rows the viewer's role
 * cannot read. Everything here goes through rlsGateway.compileAccessFilter and
 * the same query compiler the data routes use, acting as the VIEWER.
 *
 * Bounded on purpose: MAX_CONTEXT_ROWS rows, and the caller caps the serialised
 * characters on top. This is context for a prompt, not an export channel.
 *
 * ── THE SECOND KIND OF TABLE ────────────────────────────────────────
 * A model table that fetches its rows from a Studio datatable does not exist in
 * `studioAppDbStore`. This was the four-and-a-half-th read path that did not know that: the
 * read touched the empty shadow table, returned `[]`, and the catch below turned an SQL error
 * into `null`. An AI step that binds "the open tickets" as context thus received an empty answer
 * that could not be told apart from "there are no rows" — precisely the distinction that
 * readError.js does make elsewhere.
 *
 * The link now goes through `datatableSource.resolveDatatableRead`, the same body as
 * dataReadRunner. The promise above ("everything here runs as the VIEWER") is thereby also true
 * for this kind: the grade is that of the viewer, narrowed with that of the app owner, with the
 * app role and with the mode. A REFUSAL is NOT flattened to `null` here but thrown on — it carries
 * `safe:true` and a status, and the dispatcher puts the reason in the step error. Only in this
 * way do "empty" and "not allowed" remain different answers.
 */

'use strict';

const queryCompiler = require('./queryCompiler');
const rlsGateway = require('./rlsGateway');
const studioAppDbStore = require('../stores/studioAppDbStore');
// De tweede tabelsoort — dezelfde beslissing als het leespad van de routes.
const datatableSource = require('./datatableSource');

// Enough for a ticket's message thread; far below the row cap of a real query.
// A prompt that needs more than this wants a knowledge base, not a table dump.
const MAX_CONTEXT_ROWS = 50;

const DATA_KINDS = new Set(['record', 'records', 'aggregate']);

function isDataBinding(binding) {
    return !!binding && typeof binding === 'object' && DATA_KINDS.has(binding.kind);
}

function findTable(model, tableId) {
    const tables = (model && Array.isArray(model.tables)) ? model.tables : [];
    if (typeof tableId !== 'string' || !tableId) return null;
    return tables.find((t) => t && (t.id === tableId || t.key === tableId)) || null;
}

/**
 * Turn an authored filter list into literal values.
 *
 * A filter entry's `value` may itself be a binding ({kind:'formula', expr:
 * 'vars.thread'}) — that is how "the ticket that is open right now" is
 * expressed. `required: true` means the filter cannot be dropped: with nothing
 * to resolve against, the honest answer is NO ROWS, never every row in the
 * table. Silently dropping it is what once made a conversation pane list every
 * attachment in the app.
 */
function resolveFilters(filters, resolveValue) {
    if (!Array.isArray(filters)) return { filters: [], blocked: false };
    const out = [];
    for (const entry of filters) {
        if (!entry || typeof entry !== 'object') continue;
        const { required, ...rest } = entry;
        // A literal (string/number/bool) stays as it is; only a binding object
        // is re-resolved.
        const raw = entry.value;
        const value = (raw && typeof raw === 'object' && typeof raw.kind === 'string')
            ? resolveValue(raw)
            : raw;
        if (value === undefined || value === null || value === '') {
            if (required) return { filters: [], blocked: true };
            continue;
        }
        out.push({ ...rest, value });
    }
    return { filters: out, blocked: false };
}

/**
 * Resolve one data binding to rows (or a single row for kind:'record').
 *
 * Returns null rather than throwing on anything unresolvable — a prompt with no
 * context is a worse answer, not a failed step, and the caller cannot usefully
 * distinguish "empty table" from "table gone" here.
 *
 * `maxRows` defaults to the prompt cap. generate_file passes a higher export
 * ceiling — an export legitimately wants every project line, where a prompt
 * wants a summary — but the query compiler's own MAX_RESULT_ROWS still
 * ceilings whatever is asked for, so no caller can escape the hard limit.
 *
 * @param {object} app           { id, userId, organizationId }
 * @param {object} model         the app's data model
 * @param {object} binding       a record / records / aggregate binding
 * @param {object} opts          { viewer, role, resolveValue, maxRows? }
 */
async function resolveDataBinding(app, model, binding, { viewer, role, resolveValue, maxRows = MAX_CONTEXT_ROWS }) {
    if (!isDataBinding(binding)) return null;
    const table = findTable(model, binding.tableId);
    if (!table) return null;

    const { filters, blocked } = resolveFilters(binding.filter, resolveValue);
    if (blocked) return binding.kind === 'record' ? null : [];

    // WHERE the rows are stored and with which rights — the only place in this file where the two
    // kinds of table part ways. Everything after it is one implementation. A refusal of the link
    // does NOT go through the catches below: those turn "could not" into an empty context, and that
    // is exactly the answer that must not be given here.
    const plan = await readPlan(app, table, viewer, role);

    const accessFilter = rlsGateway.compileAccessFilter(
        plan.tableMeta, plan.role, plan.viewer, 'read', { dialect: plan.dialect });

    let compiled;
    try {
        if (binding.kind === 'aggregate') {
            compiled = queryCompiler.compileAggregate(plan.tableMeta, {
                filters,
                groupBy: binding.groupBy,
                aggregates: binding.aggregates,
                sort: binding.sort,
                limit: Math.min(Number.isFinite(binding.limit) ? binding.limit : maxRows, maxRows),
                dialect: plan.dialect,
            }, accessFilter);
        } else {
            compiled = queryCompiler.compileRecordList(plan.tableMeta, {
                filters,
                sort: binding.sort,
                limit: binding.kind === 'record'
                    ? 1
                    : Math.min(Number.isFinite(binding.limit) ? binding.limit : maxRows, maxRows),
                dialect: plan.dialect,
            }, accessFilter);
        }
    } catch {
        // A CompileError here is an authoring mistake (unknown column, bad op).
        // The validator reports those at save time; at run time the step keeps
        // going without the context rather than failing the whole action.
        return null;
    }

    let rows;
    try {
        const res = await plan.query(compiled.sql, compiled.params);
        rows = Array.isArray(res) ? res : (res?.rows || []);
    } catch {
        return null;
    }

    // compileRecordList fetches one probe row past the limit to build a cursor;
    // nothing here paginates, so trim it off rather than leaking an extra row
    // into the prompt.
    if (binding.kind === 'record') return rows[0] ?? null;
    return rows.slice(0, maxRows);
}

/**
 * The table description, the role, the viewer, the dialect and the storage — for both kinds of
 * table in the same shape. The twin of `dataReadRunner.readPlan`; that there are two of them comes
 * from the fact that a STEP has no request ctx (no memoisation, no ownerScope) — the DECISION is
 * the same function, and that is the part that must not be duplicated.
 */
async function readPlan(app, table, viewer, role) {
    if (!datatableSource.isDatatableBacked(table)) {
        return {
            tableMeta: table,
            role,
            viewer,
            // `undefined` laat resolveDialect op de procesbrede
            // STUDIO_APP_ENGINE uitkomen, precies zoals het weglaten van de
            // optie deed.
            dialect: undefined,
            query: (sql, params) => studioAppDbStore.query(app.userId, app.id, sql, params),
        };
    }
    const v = (viewer && typeof viewer === 'object') ? viewer : {};
    const resolved = await datatableSource.resolveDatatableRead(
        { app, viewerId: v.id ?? null, role, viewer: v }, table,
    );
    return {
        tableMeta: resolved.tableMeta,
        // The GRADE is the role here: the access block comes from the datatable.
        role: resolved.grade,
        viewer: resolved.viewer,
        dialect: resolved.dialect,
        query: (sql, params) => require('../stores/datatableDbStore')
            .query(resolved.scopeKey, resolved.scopeKey, sql, params),
    };
}

module.exports = {
    resolveDataBinding,
    isDataBinding,
    MAX_CONTEXT_ROWS,
    _resolveFilters: resolveFilters,
};
