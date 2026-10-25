// @typecheck
/**
 * `/api/webpages-preview/:id/tables/:tid/*` — the runtime bridge
 * `window.beeflowTables` from a page to a BOUND datatable.
 *
 * ── THIS IS THE OTHER HALF OF THE BRIDGE FROM AI/AUTOMATIONS ────────
 *
 * All other preview bridges run ACTS-AS-AUTHOR: the page calls the LLM with the author's
 * budget, starts the author's automations, uses the author's integrations. That can work
 * there, because the author has explicitly handed those rights to their own page.
 *
 * A datatable is something else. It has its own grade per person (auth/datatableAccess),
 * and sharing a page must never mean that the reader borrows the author's table rights.
 * These routes therefore run as the LOGGED-IN VIEWER: `previewClaims.viewerUserId`, with
 * their own `gradeForPrincipal`, recalculated on every call.
 *
 * A token from before W3 has no such claim. Then there is NO fallback to the owner — that
 * would be exactly the leak — but a refusal with `viewer_unknown`; the client fetches a
 * fresh token and tries again.
 *
 * ── AND PUBLIC NEVER COMES THROUGH HERE ────────────────────────────
 *
 * `/w/<slug>` is a script-free snapshot, sanitised by DOMPurify, and the anonymous bridge
 * knows only /ai/chat and /ai/stream. On a public share `window.beeflowTables` therefore
 * does not exist; what is visible of a table there has been rendered server-side from
 * `publicColumns` by the snapshot writer (services/webpageBfTable.js). These routes are
 * deliberately NOT "also public with fewer rights": the preview token is bound to
 * (userId, webpageId) and may never be reused for a public reader. Should a LIVE public
 * table ever be wanted, that is a SEPARATE, share-scoped, read-only, rate-limited route
 * on the pattern of the public share bridge.
 *
 * ── THE TWO GATES, IN THIS ORDER ────────────────────────────────────
 *   1. the binding — is this table in `bridge_grants.tables` of THIS page, and with which
 *      mode and columns? Not bound → 404.
 *   2. the grade — may THIS VIEWER read (viewer) or write (editor) that table? That is
 *      decided by core/dataEngine/datatableRuntime.js, the shared runner that the other
 *      consumers of a datatable also use.
 * Both must say yes. The binding cannot widen the grade, and the grade cannot widen the
 * binding.
 *
 * ── WHAT A PAGE MAY SEND ────────────────────────────────────────────
 *
 * `beeflowTables.query(id, opts)` sends `opts` UNCHANGED as the body, so the keys are those
 * of the page code itself. Every key that this route did not read fell away, and falling
 * away meant here: fewer filters, so MORE rows.
 *
 *   - `{ "filter": [...] }` (singular) and `{ "search": {...} }` — a shape that the compiler
 *     knows but this bridge does not pass along — both gave every row that the viewer may
 *     see, under a 200.
 *   - `{ "filters": { "field": "status", "op": "eq", "value": "open" } }` — one filter instead
 *     of a list — became an empty list through readRows' own `Array.isArray(filters) ? filters : []`,
 *     before the compiler could say 'filters must be an array'. Also: every row.
 *
 * The schema fixes only the KEYS and their kind. What is inside a filter is the language of
 * the query compiler, which already gives a 400 `bad_descriptor` with a usable sentence for
 * every unknown operator; a schema that mimics that language would answer sooner but say less.
 * For the same reason `rowId`, `values` and `expectedUpdatedAt` stay with the runner, which
 * has its own codes for them (`row_required`, `no_values`, `expected_updated_at_required`).
 *
 * A sort is the exception, because the compiler refuses NOTHING there: resolvePrimarySort
 * reads only `dir` or `direction` and turns everything else into 'desc'. `{ field, order: 'asc' }`
 * or `dir: 'ascending'` therefore gave descending order, under a 200. The schema therefore
 * knows the keys of a sort (`field`, `dir`, `direction`) and their two directions.
 *
 * The bf elements send `{ limit }`; the shim sends `{ values }` and
 * `{ rowId, values, expectedUpdatedAt }`. All of those come through unchanged.
 */

const express = require('express');
const router = express.Router();

const { requirePreviewToken } = require('../auth/webpagePreviewToken');
const { tableReadBridgeLimiter, tableWriteBridgeLimiter } = require('./webpagesPreviewRateLimits');
const { getBridgeGrants } = require('../stores/webpage/bridgeGrants');
const { resolveDatatablePrincipalForUser } = require('../auth/datatableAccess');
const datatableRuntime = require('../core/dataEngine/datatableRuntime');
const { validate } = require('../core/http/validate');
const { HttpError } = require('../core/http/errors');
const { z, typeError } = require('../utils/zod');

/** A body that also accepts no body: Express 5 then leaves `req.body` undefined. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape).strict(),
);

const FILTERS_TEXT = 'filters is a list of { field, op, value } conditions.';
const MATCH_TEXT = 'match is "all" or "any".';
const SORT_TEXT = 'sort is { field, dir } or a list of those, dir "asc" or "desc".';
const LIMIT_TEXT = 'limit is a whole number of rows, at least 1.';
const CURSOR_TEXT = 'cursor is the nextCursor a previous page returned.';

/**
 * Eén voorwaarde: een object — wat erin staat is aan de compiler.
 * @param {string} message
 */
const clause = (message) => z.record(z.string(), z.unknown(), { error: typeError({ invalid: message }) });

// Every refusal within a sort is the same sentence: a union answers with the first
// branch that reached a CHECK, so an error on the union alone would leak
// "Unrecognized key(s) in object".
const sorted = { error: () => SORT_TEXT };
/** Een richting zoals resolvePrimarySort hem leest (hoofdletters telden altijd al). */
const sortDir = z.string(sorted).refine((v) => ['asc', 'desc'].includes(v.toLowerCase()), SORT_TEXT);
/** Eén sortering: de sleutels die de compiler leest, en niets dat hij stil negeert. */
const SortClause = z.object({
    field: z.string(sorted).min(1, SORT_TEXT),
    dir: sortDir.optional(),
    direction: sortDir.optional(),
}, sorted).strict();

// `null` is "niet ingesteld" en blijft dat: paginacode schrijft makkelijk
// `filters: actief ? [f] : null`, en dat vraagt om precies alle rijen.
const QueryBody = bodyOf({
    filters: z.array(clause(FILTERS_TEXT), { error: typeError({ invalid: FILTERS_TEXT }) }).nullish(),
    match: z.enum(['all', 'any'], { error: () => MATCH_TEXT }).nullish(),
    sort: z.union([SortClause, z.array(SortClause)], { error: () => SORT_TEXT }).nullish(),
    // Een getal als tekst ("20" uit een data-attribuut) telde altijd al; 0 of
    // een woord gaf stil de standaardpagina en is nu een zin.
    limit: z.coerce.number({ error: typeError({ invalid: LIMIT_TEXT }) }).int(LIMIT_TEXT).min(1, LIMIT_TEXT).nullish(),
    cursor: z.string({ error: typeError({ invalid: CURSOR_TEXT }) }).nullish(),
});

const InsertBody = bodyOf({ values: z.unknown().optional() });
const UpdateBody = bodyOf({ rowId: z.unknown().optional(), values: z.unknown().optional(), expectedUpdatedAt: z.unknown().optional() });

/**
 * Every refusal here THROWS, instead of answering on its own.
 *
 * A helper that writes `res` and at the same time returns `null` leaves the caller with
 * "and now what?": forget that one `return` and the request hangs until the browser gives
 * up — no error, no answer, nothing in the log. A single `catch` arm that handles everything
 * makes that impossible.
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function refuse(status, code, message) {
    /** @type {Error & { safe?: boolean }} */
    const e = new Error(message);
    e.status = status;
    e.code = code;
    e.safe = true;
    return e;
}

/**
 * De bezoeker.
 *
 * Nooit `previewClaims.userId` als terugval: dat is de EIGENAAR van de pagina,
 * en die terugval zou elke lezer van een gedeelde pagina de tabelrechten van de
 * auteur geven.
 * @param {import('express').Request} req
 */
function requireViewer(req) {
    const viewerUserId = req.previewClaims?.viewerUserId || null;
    if (!viewerUserId) {
        throw refuse(401, 'viewer_unknown',
            'This preview token does not say who is viewing. Reload the page to get a new one.');
    }
    return viewerUserId;
}

/**
 * The binding for `:tid` on this page.
 *
 * `write` asks for the LITERAL mode 'readwrite'; the normaliser has already narrowed every
 * other value to 'read', so here only that one string needs to be recognised.
 * @param {import('express').Request<{ tid: string }>} req
 * @param {{ write?: boolean }} [opts]
 */
async function requireBinding(req, { write = false } = {}) {
    const grants = await getBridgeGrants(req.previewClaims.webpageId);
    const binding = (grants.tables || []).find(t => t.datatableId === req.params.tid) || null;
    if (!binding) {
        // 404, not 403: whether this page hangs on a table is not information
        // that a viewer may probe.
        throw refuse(404, 'table_not_bound', 'This page is not linked to that table');
    }
    if (write && binding.mode !== 'readwrite') {
        throw refuse(403, 'binding_read_only', 'This page may only read that table');
    }
    return binding;
}

/**
 * Every refusal with `safe` may be returned verbatim; the rest becomes a 500.
 * @param {string} fallback
 */
function sendError(res, err, fallback) {
    if (err && err.safe === true && typeof err.status === 'number') {
        return res.status(err.status).json({
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
            ...(err.row ? { row: err.row } : {}),
        });
    }
    // A CompileError comes from the descriptor that the page ITSELF sent
    // (an unknown operator, a list where none is allowed) — that is a 400 with a usable
    // text, not an internal error.
    if (err && err.name === 'CompileError') {
        return res.status(400).json({ error: err.message, code: 'bad_descriptor' });
    }
    if (err instanceof HttpError) throw err;
    throw Object.assign(new Error(fallback), { cause: err });
}

/**
 * The viewer + their grade on this table. Throws if either is missing.
 * @param {string} needed
 */
async function resolveFor(req, needed) {
    const principal = await resolveDatatablePrincipalForUser(requireViewer(req));
    return datatableRuntime.resolveForPrincipal(req.params.tid, principal, { needed });
}

// ── Lezen ────────────────────────────────────────────────────────────

router.post('/:id/tables/:tid/query', requirePreviewToken, tableReadBridgeLimiter, validate({ body: QueryBody }), async (/** @type {import('express').Request<{ id: string, tid: string }>} */ req, /** @type {import('express').Response} */ res) => {
    try {
        const binding = await requireBinding(req);
        const resolved = await resolveFor(req, 'viewer');
        const { filters, match, sort, limit, cursor } = req.body;
        const out = await datatableRuntime.readRows(resolved, {
            allowColumns: binding.columns,
            filters, match, sort, limit, cursor,
        });
        res.json(out);
    } catch (err) {
        sendError(res, err, 'Could not read the table');
    }
});

// ── Schrijven ────────────────────────────────────────────────────────

router.post('/:id/tables/:tid/insert', requirePreviewToken, tableWriteBridgeLimiter, validate({ body: InsertBody }), async (/** @type {import('express').Request<{ id: string, tid: string }>} */ req, /** @type {import('express').Response} */ res) => {
    try {
        const binding = await requireBinding(req, { write: true });
        const resolved = await resolveFor(req, 'editor');
        const out = await datatableRuntime.insertRow(resolved, {
            allowColumns: binding.columns,
            values: req.body.values,
        });
        res.json({ ok: true, id: out.id });
    } catch (err) {
        sendError(res, err, 'Could not add the row');
    }
});

router.post('/:id/tables/:tid/update', requirePreviewToken, tableWriteBridgeLimiter, validate({ body: UpdateBody }), async (/** @type {import('express').Request<{ id: string, tid: string }>} */ req, /** @type {import('express').Response} */ res) => {
    try {
        const binding = await requireBinding(req, { write: true });
        const resolved = await resolveFor(req, 'editor');
        const out = await datatableRuntime.updateRow(resolved, {
            allowColumns: binding.columns,
            rowId: req.body.rowId,
            values: req.body.values,
            expectedUpdatedAt: req.body.expectedUpdatedAt,
        });
        res.json({ ok: true, row: out.row });
    } catch (err) {
        sendError(res, err, 'Could not save the row');
    }
});

module.exports = router;
