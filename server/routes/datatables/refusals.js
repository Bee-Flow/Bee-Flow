/**
 * Every way this router says no.
 *
 * The frozen quota body, the SQLSTATE a write failure is translated through,
 * the 400 a handler can throw from anywhere in its validation, the refusal of
 * SQL smuggled through a descriptor, and the confirmation a destructive schema
 * edit has to carry. They sit together because they are one contract: what a
 * client is told when the answer is not the thing it asked for.
 *
 * No request schema lives here: this file declares no route. `confirmBreaking`
 * is named in the query and body schemas of the routes that call it
 * (schemas.flag); reading it here keeps a route without that schema fail-safe.
 */

'use strict';

const datatableStore = require('../../stores/datatableStore');
const { assertDatatableQuota } = require('../../core/dataEngine/datatableLimits');

/** The frozen quota body, copied from routes/studioAppData.js. */
function quota(res, limit, used) {
    return res.status(409).json({ error: 'This datatable is full', code: 'quota_exceeded', limit, used });
}

/**
 * The storage envelope, checked by core/dataEngine/datatableLimits so the
 * runner enforces exactly the same numbers. It answers with the same frozen
 * 409 body `quota()` builds — via answerDatatableError, which carries
 * limit/used through.
 */
async function assertQuota(req, opts) {
    await assertDatatableQuota(req.datatableScope, { table: req.datatable, ...opts });
}

// SQLSTATEs the routes below answer for by name. Everything else is a 500.
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Answer a write failure, or return false so the caller logs and 500s.
 *
 * The metadata half of a create goes through `db.withTransaction`, which does
 * NOT run pgAppEngine.mapPgError — so a second table with the same key hit
 * `uq_datatables_scope_key` and came back as a bare 500 saying "Could not create
 * the datatable". The person then retried, and got the same 500 for ever.
 *
 * A SQLSTATE is never echoed: `e.code` on a pg error is five digits and means
 * nothing to a client, so only the codes this file mints are passed through.
 */
function answerDatatableError(res, e, scope = null) {
    if (e?.code === PG_UNIQUE_VIOLATION && String(e.constraint || '') === 'uq_datatables_scope_key') {
        return res.status(409).json({
            error: scope?.kind === 'user'
                ? 'You already have a table with this key'
                : 'A table with this key already exists in your organisation',
            code: 'key_taken',
        });
    }
    if (e?.status) {
        const code = (typeof e.code === 'string' && !/^\d/.test(e.code)) ? { code: e.code } : {};
        // limit/used ride along when they are there: the frozen quota body is
        // `{error, code, limit, used}`, and a client that only got the message
        // cannot say how full "full" is.
        const usage = (e.limit !== undefined && e.used !== undefined) ? { limit: e.limit, used: e.used } : {};
        // A source refusal may say WHY (reason: 'ods', 'not_owned' …), WHAT
        // (ref: {provider, fileId, sheet}; datatableId for an already-linked
        // sheet; key for a taken technical name) and WHICH COLUMN (header +
        // detail on a key that repeats) — the client turns each into a
        // sentence, so they ride along when the error carries them: the same
        // body the collection router (datatablesSpreadsheets.answer) ships,
        // so a refusal reads the same from PUT /:id/source or a relink as
        // from the link.
        const extra = {};
        for (const k of ['reason', 'detail', 'header', 'key']) if (typeof e[k] === 'string' && e[k]) extra[k] = e[k];
        if (e.ref && typeof e.ref === 'object') extra.ref = e.ref;
        if (e.datatableId) extra.datatableId = e.datatableId;
        if (e.status === 429 && e.retryAfter) res.set('Retry-After', String(e.retryAfter));
        return res.status(e.status).json({ error: e.message, ...code, ...usage, ...extra });
    }
    return false;
}

/**
 * Did the caller say "yes, break it"? Accepted on the body AND the query
 * string: a DELETE is routinely sent without one, and a confirmation the
 * client cannot express is a dead end rather than a guard.
 *
 * It used to read the query string as `=== 'true'` and nothing else, and that
 * WAS the dead end it exists to prevent. A URL carries no booleans, so the
 * Studio's answers-column drop sends `?confirmBreaking=1` (datatablesApi.
 * removeAnswersColumn) — which meant "no". The person confirmed a destructive
 * drop in a dialog, the server answered 409 `breaking_change` again, and there
 * was no other route to the column at all.
 *
 * Both spellings a client actually sends are therefore a yes. Anything else is
 * refused by the route's own query schema (schemas.flag) rather than read as a
 * no — but this set stays the single place that decides, so a route added
 * without that schema still honours a confirmation instead of swallowing it.
 */
const CONFIRMED = new Set([true, 'true', '1']);
function confirmedBreaking(req) {
    return CONFIRMED.has(req.body?.confirmBreaking) || CONFIRMED.has(req.query?.confirmBreaking);
}

/** A 400 the handler below can throw from anywhere in its validation. */
function bad(message, code) {
    const e = new Error(message);
    e.status = 400;
    if (code) e.code = code;
    throw e;
}

/**
 * Which automation steps name a column this save is dropping.
 *
 * Diffed BY ID, like the migration planner: a renamed column keeps its id and
 * is not a drop, and matching on key would refuse a rename while letting a real
 * drop through.
 */
async function breakingColumnUsage(datatableId, storedFields, nextFields) {
    const keptIds = new Set((nextFields || []).map(f => f && f.id).filter(Boolean));
    const out = [];
    for (const f of (storedFields || [])) {
        if (!f || !f.id || keptIds.has(f.id)) continue;
        for (const u of await datatableStore.listUsageForColumn(datatableId, f.key)) {
            out.push({ column: f.key, ...u });
        }
    }
    return out;
}

/** Refuse any attempt to smuggle SQL through a descriptor. */
function rejectSqlKeys(req, res, next) {
    const body = req.body || {};
    for (const k of ['sql', 'query', 'rawSql', 'rawQuery']) {
        if (Object.hasOwn(body, k)) {
            return res.status(400).json({
                error: 'Datatables are queried with filters, not SQL',
                code: 'sql_not_accepted',
            });
        }
    }
    next();
}

module.exports = {
    quota, assertQuota, answerDatatableError, bad,
    confirmedBreaking, breakingColumnUsage, rejectSqlKeys,
};
