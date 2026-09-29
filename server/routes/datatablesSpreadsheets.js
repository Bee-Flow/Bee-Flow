/**
 * /api/datatables/spreadsheets/* — LINKING spreadsheet files as datatables.
 *
 * The collection half of the spreadsheet-mirror feature (core/dataEngine/
 * sources/spreadsheetFile): which storages this account can browse, what is
 * in them, what one sheet would arrive as, and making one or several
 * mirrors. The per-table half — refresh, settings, relations, relink — is
 * the kind-agnostic `/:id/source/*` family in routes/datatables.js, because
 * it needs that file's grade middleware.
 *
 * Mounted by routes/datatables.js right after `/nextcloud` and BEFORE any
 * `/:id` route (or "spreadsheets" reads as a table id), and built by a
 * factory so the projection stays the parent's one function — a second
 * `publicTable` here would be a second answer to "what may the client see".
 *
 * ── GATES, SPELLED OUT PER ROUTE ────────────────────────────────────
 * No feature flag of its own: linking is a capability of the account's
 * storage connections, and the parent router's gates (the GA `automations`
 * beta, the licence feature, the rate limit) already apply. Per route, the
 * SAME chain POST / spells out: the principal, the scope, the org
 * membership, `manage_datatables` for an organisation table. Written out
 * rather than folded into a helper because the route tests read these
 * bodies as text and a helper would hide the gate from them.
 *
 * Everything storage-shaped — is the account connected, may it see this
 * folder, is the file a spreadsheet at all — is the engine's (link.js), and
 * answers as a SpreadsheetSourceError with its own status and code, a `ref`
 * naming the file and sheet it is about, for `already_linked` the datatable
 * that has it, and — when the error carries them — `detail` (the storage's
 * own sentence, or `needs_reauth`), `header` (the column a key refusal is
 * about) and `key` (the technical name a `key_taken` is about). The client
 * builds its sentences from THOSE fields, never from the message, so a
 * field left off the wire is a garbled or duplicated sentence.
 *
 * Browsing, describing, linking and re-linking all reach the storage (a
 * folder listing; a download and a parse of up to 20 MB — ten of them per
 * link), so they share ONE per-user bucket on top of the parent's limit —
 * the engine's `storageLimiter`, the same 30 a minute the Nextcloud scope
 * pickers have (routes/ncScope.js). Browse and describe mount it here as
 * middleware; link and relink spend it inside the engine (link.js), because
 * the relink route lives in routes/datatables.js where this router's
 * middleware cannot reach — so `/link` below carries no limiter of its own,
 * or a link would be charged twice.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Every query and body is `.strict()`, in the vocabulary of
 * routes/datatables/schemas.js. The schema is the SHAPE; the storage words —
 * which provider, whether a header row or key column exists — stay link.js's
 * to judge, because its refusals carry the `ref` the wizard marks a sheet by.
 * What the shape closes:
 *
 *   - `?headerrow=3` (one letter off) was dropped and the sheet was described
 *     from row 1; `?shared=True` listed the caller's OWN files instead of
 *     "shared with me" — both answered 200 with the wrong folder or columns;
 *   - a column typed in the wizard arrived as `{ col: '2', type: 'number' }`
 *     or `{ col: 2, tpye: 'number' }` and was skipped: the mirror got the
 *     INFERRED type, not the one the person chose, under a 201;
 *   - `sharedWriteOptIn: 'true'` (text) left a shared file read-only, and a
 *     misspelled `descripton` recorded the kind's default purpose.
 *
 * The limiter stays the first thing on /browse and /describe: a refused
 * query still spends from the bucket, as a request the storage never saw.
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const { assertUserCanUseOrg, hasPermission, Permissions } = require('../auth');
const datatableStore = require('../stores/datatableStore');
const { resolveDatatablePrincipal } = require('../auth/datatableAccess');
const { isSourceError } = require('../core/dataEngine/sources/mirror/errors');
const { validate } = require('../core/http/validate');
const { worded, bodyOf, flag, scopeWord } = require('./datatables/schemas');
const log = require('../telemetry/log');

// ── What a caller may send ──────────────────────────────────────────

/** Free text a storage hands out — ids, paths, page tokens. The storage judges it. */
const text = (name) => worded(`${name} is text.`).optional();

const ScopeQuery = z.object({ scope: scopeWord() }).strict();

const BrowseQuery = z.object({
    scope: scopeWord(),
    provider: text('provider'),
    folderId: text('folderId'),
    q: text('q'),
    shared: flag('shared is true or false.'),
    pageToken: text('pageToken'),
}).strict();

const DescribeQuery = z.object({
    scope: scopeWord(),
    provider: text('provider'),
    fileId: text('fileId'),
    driveId: text('driveId'),
    path: text('path'),
    sheet: text('sheet'),
    // Judged by link.js (1..50), which answers in the wizard's own terms.
    headerRow: text('headerRow'),
}).strict();

const COLUMN_TEXT = 'Each declared column is { col, header, type } — col the 0-based column number.';
const SheetColumn = z.object({
    col: z.number({ required_error: COLUMN_TEXT, invalid_type_error: COLUMN_TEXT }).int(COLUMN_TEXT).min(0, COLUMN_TEXT),
    // What the wizard saw in the header cell, for the "is now …" warning.
    header: z.union([z.string(), z.number()], { errorMap: () => ({ message: COLUMN_TEXT }) }).nullish(),
    // The word is link.js's to judge (DECLARABLE_TYPES), with the sheet's ref on the refusal.
    type: worded(COLUMN_TEXT).nullish(),
}, { invalid_type_error: COLUMN_TEXT }).strict();

const SHEET_TEXT = 'Each sheet to link is { provider, fileId, sheet, headerRow, keyColumn, columns, name, key }.';
const whole = (message) => z.number({ invalid_type_error: message }).int(message).nullish();
const LinkSheet = z.object({
    provider: worded(SHEET_TEXT).optional(),
    fileId: worded(SHEET_TEXT).optional(),
    driveId: worded(SHEET_TEXT).nullish(),
    path: worded(SHEET_TEXT).nullish(),
    sheet: worded('sheet is the name of a sheet in the file, or null for a CSV.').nullish(),
    headerRow: whole('headerRow is the row number of the header, from 1.'),
    keyColumn: whole('keyColumn is the 0-based number of the key column, or null for row numbers.'),
    columns: z.array(SheetColumn, { invalid_type_error: COLUMN_TEXT }).optional(),
    sharedWriteOptIn: z.boolean({ invalid_type_error: 'sharedWriteOptIn is true or false.' }).optional(),
    name: worded('A table name is text.').optional(),
    key: worded('A technical name is text.').optional(),
    description: worded('A table\'s purpose is text.').optional(),
}, { invalid_type_error: SHEET_TEXT }).strict();

const LinkBody = bodyOf({
    scope: scopeWord(),
    // An empty or missing list is link.js's refusal, in its own words.
    tables: z.array(LinkSheet, { invalid_type_error: SHEET_TEXT }).optional(),
    // A side that names no linked sheet is a WARNING from link.js, not a refusal.
    relations: z.array(z.record(z.unknown()), { invalid_type_error: 'relations is a list of { from, to } pairs.' }).optional(),
});

const KIND = 'spreadsheet_file';

// SQLSTATE the link answers for by name — the store's unique index on the
// technical name, hit when two links race past the engine's own pre-check.
// A SQLSTATE is never echoed (see answerDatatableError in datatables.js).
const PG_UNIQUE_VIOLATION = '23505';

function adapter() {
    return require('../core/dataEngine/sources').adapterFor(KIND);
}

// Opening the wizard lists a folder; every click lists another; a header-row
// change re-describes. The bucket is the engine's, shared with link and
// relink (see the header); resolved per request so the registry loads lazily.
const storageLimiter = (req, res, next) => adapter().link.storageLimiter(req, res, next);

function answer(res, e) {
    if (e && e.code === PG_UNIQUE_VIOLATION && String(e.constraint || '') === 'uq_datatables_scope_key') {
        res.status(409).json({ error: 'A table with this technical name already exists here', code: 'key_taken' });
        return true;
    }
    if (isSourceError(e) || (e && e.status)) {
        const body = { error: e.message };
        if (typeof e.code === 'string' && !/^\d/.test(e.code)) body.code = e.code;
        if (e.ref && typeof e.ref === 'object') body.ref = e.ref;
        if (e.datatableId) body.datatableId = e.datatableId;
        if (typeof e.reason === 'string' && e.reason) body.reason = e.reason;
        if (typeof e.detail === 'string' && e.detail) body.detail = e.detail;
        if (typeof e.header === 'string' && e.header) body.header = e.header;
        if (typeof e.key === 'string' && e.key) body.key = e.key;
        if (e.limit !== undefined && e.used !== undefined) { body.limit = e.limit; body.used = e.used; }
        if (e.status === 429 && e.retryAfter) res.set('Retry-After', String(e.retryAfter));
        res.status(e.status || 500).json(body);
        return true;
    }
    return false;
}

/**
 * The scope a request addresses — the same words and the same chain as
 * POST /: `organisation` (default when the account has one) or `personal`.
 * Returns the scope, or answers the refusal itself and returns null.
 */
async function resolveScope(req, res, principal, wanted) {
    if (wanted !== undefined && wanted !== 'organisation' && wanted !== 'personal') {
        res.status(400).json({ error: 'A table belongs either to your organisation or to this account', code: 'bad_scope' });
        return null;
    }
    const preferred = wanted || (principal.orgId ? 'organisation' : 'personal');
    if (preferred === 'organisation') {
        if (!principal.orgId) {
            res.status(400).json({ error: 'Datatables belong to an organisation, and this account is not in one', code: 'no_organisation' });
            return null;
        }
        await assertUserCanUseOrg(req, principal.orgId);
        if (!await hasPermission(principal.userId, Permissions.MANAGE_DATATABLES, req.session)) {
            res.status(403).json({ error: `Permission '${Permissions.MANAGE_DATATABLES}' required` });
            return null;
        }
        return datatableStore.orgScope(principal.orgId);
    }
    if (!principal.userId) { res.status(401).json({ error: 'Not authenticated' }); return null; }
    return datatableStore.userScope(principal.userId);
}

function makeSpreadsheetsRouter({ publicTable }) {
    if (typeof publicTable !== 'function') throw new Error('datatablesSpreadsheets needs the parent projection');
    const router = express.Router();

    // Which storages this account could link from — a CHEAP answer (a vault
    // row, the session's provider, the Nextcloud binding), never a call to
    // the storage itself: the create dialog asks this to decide whether to
    // show the card at all.
    router.get('/providers', validate({ query: ScopeQuery }), async (req, res) => {
        try {
            const principal = await resolveDatatablePrincipal(req);
            const scope = await resolveScope(req, res, principal, req.query.scope);
            if (!scope) return;
            res.json(await adapter().link.providers(req.session, principal, scope));
        } catch (e) {
            if (answer(res, e)) return;
            log.error('[datatables/spreadsheets] providers failed:', e.message);
            res.status(500).json({ error: 'Could not list the connected storages' });
        }
    });

    // One folder of one storage: sub-folders and spreadsheet files, with
    // which mirrors in the scope already copy a sheet of each.
    router.get('/browse', storageLimiter, validate({ query: BrowseQuery }), async (req, res) => {
        try {
            const principal = await resolveDatatablePrincipal(req);
            const scope = await resolveScope(req, res, principal, req.query.scope);
            if (!scope) return;
            const q = req.query || {};
            res.json(await adapter().link.browse(req.session, principal, scope, {
                provider: q.provider, folderId: q.folderId, q: q.q, shared: q.shared, pageToken: q.pageToken,
            }));
        } catch (e) {
            if (answer(res, e)) return;
            log.error('[datatables/spreadsheets] browse failed:', e.message);
            res.status(500).json({ error: 'Could not read that folder' });
        }
    });

    // The columns one sheet would arrive with, before it is linked.
    router.get('/describe', storageLimiter, validate({ query: DescribeQuery }), async (req, res) => {
        try {
            const principal = await resolveDatatablePrincipal(req);
            const scope = await resolveScope(req, res, principal, req.query.scope);
            if (!scope) return;
            const q = req.query || {};
            if (!q.provider || !q.fileId) {
                return res.status(400).json({ error: 'Say which file (provider and fileId) to describe', code: 'spreadsheet_rejected' });
            }
            // `driveId` and `path` are optional spellings of the same identity
            // (a OneDrive item outside the own drive; a Nextcloud path) — the
            // browser's `id` already carries them, so a client need not.
            res.json(await adapter().link.describe(req.session, principal, scope, {
                provider: q.provider, fileId: q.fileId, driveId: q.driveId, path: q.path, sheet: q.sheet, headerRow: q.headerRow,
            }));
        } catch (e) {
            if (answer(res, e)) return;
            log.error('[datatables/spreadsheets] describe failed:', e.message);
            res.status(500).json({ error: 'Could not read that spreadsheet' });
        }
    });

    // Link one or several sheets. The first refresh runs in the background;
    // the answer says `sync.status: 'running'` and the client polls GET /:id.
    // The storage budget is spent inside linkSpreadsheets (see the header).
    router.post('/link', validate({ body: LinkBody }), async (req, res) => {
        try {
            const principal = await resolveDatatablePrincipal(req);
            const body = req.body || {};
            const scope = await resolveScope(req, res, principal, body.scope);
            if (!scope) return;
            const out = await adapter().link.linkSpreadsheets({
                scope, principal, session: req.session,
                tables: body.tables, relations: body.relations,
            });
            res.status(out.partial ? 207 : 201).json({
                datatables: out.datatables.map(t => publicTable(t, 'owner')),
                warnings: out.warnings,
                partial: out.partial,
            });
        } catch (e) {
            if (answer(res, e)) return;
            log.error('[datatables/spreadsheets] link failed:', e.message);
            res.status(500).json({ error: 'Could not link the spreadsheet' });
        }
    });

    return router;
}

module.exports = makeSpreadsheetsRouter;
