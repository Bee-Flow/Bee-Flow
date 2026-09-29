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
 * ── DE TWEEDE TABELSOORT ────────────────────────────────────────────
 * Een modeltabel die haar rijen uit een Studio-datatabel haalt bestaat niet in
 * `studioAppDbStore`. Dit was het vierde-en-een-half leespad dat dat niet wist:
 * de lezing raakte de lege schaduwtabel, gaf `[]`, en de catch hieronder maakte
 * van een SQL-fout `null`. Een AI-stap die "de openstaande tickets" als context
 * bindt kreeg dus een leeg antwoord dat niet te onderscheiden was van "er zijn
 * geen rijen" — precies het onderscheid dat readError.js elders wél maakt.
 *
 * De koppeling gaat nu door `datatableSource.resolveDatatableRead`, dezelfde
 * body als dataReadRunner. De belofte hierboven ("alles hier gaat als de
 * VIEWER") wordt daarmee ook voor deze soort waar: de graad is die van de
 * kijker, versmald met die van de app-eigenaar, met de app-rol en met de mode.
 * Een WEIGERING wordt hier NIET tot `null` afgevlakt maar doorgegooid — hij
 * draagt `safe:true` en een status, en de dispatcher zet de reden in de
 * stapfout. Alleen zo blijven "leeg" en "mocht niet" verschillende antwoorden.
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

    // WAAR de rijen staan en met welke rechten — de enige plek in dit bestand
    // waar de twee tabelsoorten uit elkaar gaan. Alles erna is één
    // implementatie. Een weigering van de koppeling gaat NIET door de catches
    // hieronder: die maken van "kon niet" een lege context, en dat is precies
    // het antwoord dat hier niet gegeven mag worden.
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
 * De tabelbeschrijving, de rol, de viewer, de dialect en de opslag — voor
 * allebei de tabelsoorten in dezelfde vorm. De tweelingbroer van
 * `dataReadRunner.readPlan`; dat die twee er zijn komt doordat een STAP geen
 * request-ctx heeft (geen memoïsatie, geen ownerScope) — de BESLISSING is
 * dezelfde functie, en dat is het stuk dat niet mag verdubbelen.
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
        // De GRAAD is hier de rol: het access-blok komt van de datatabel.
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
