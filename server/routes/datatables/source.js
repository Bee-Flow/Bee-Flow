/**
 * A table that MIRRORS an external source: its settings, its relations, its
 * linker, its refresh — and the write-through every row write goes through
 * when the rows are somebody else's.
 *
 * Two path families, one behaviour: `/:id/source/*` is the kind-agnostic
 * family every kind answers on, and the `/:id/nextcloud/*` twins are what the
 * shipped Nextcloud client calls. The kind's own adapter comes from the
 * registry in core/dataEngine/sources; nothing here compares a kind string.
 *
 * ── NO REQUEST SCHEMA HERE, ON PURPOSE ──────────────────────────────
 * The three writing routes — settings, relations, relink — carry a body whose
 * SHAPE IS THE KIND'S, not this router's. `applySettings`, `setRelations` and
 * `relink` are adapter methods: a spreadsheet mirror takes a header row, a key
 * column and a column re-map, a Nextcloud mirror takes a schedule and a view,
 * and a kind added next year takes whatever it takes. Each adapter validates
 * its own block against the source it actually reads and throws a 400 by name.
 *
 * A `.strict()` schema at this level could only be the UNION of every kind's
 * keys, which refuses nothing a caller would get wrong and has to be edited
 * every time a kind is added — the second copy would be the one that drifts.
 * This is the same reason the aggregate body in answers.js stays open.
 *
 * The four READING routes take nothing at all, and say so with an empty
 * strict query: `?refresh=1` on a pulse was silently ignored, and a client
 * that believed it had forced a refresh had not.
 */

'use strict';

const datatableStore = require('../../stores/datatableStore');
const sources = require('../../core/dataEngine/sources');
const { requireDatatableGrade, requireManageForOrgScope } = require('./grade');
const { answerDatatableError } = require('./refusals');
const { publicTable, publicSource } = require('./projection');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

/** The reading routes take nothing but the table in the path. */
const NO_QUERY = validate({ query: z.object({}).strict() });

/**
 * The context the mirror engine's write-through takes, from what the grade
 * middleware already resolved. Only ever built for a mirror
 * (sources.isSourceMirror); the write-through module is the kind's own,
 * found through the registry by the table in the context.
 */
function mirrorCtx(req, meta) {
    return sources.writeThrough(req.datatable).contextOf({
        table: req.datatable, scope: req.datatableScope, scopeKey: req.datatableScopeKey,
        tableMeta: meta, grade: req.datatableGrade, viewerId: req.datatablePrincipal.userId,
    });
}

/** The write-through for whichever kind the context's table is. */
function mirrorWrites() {
    const via = (method) => (ctx, ...rest) => sources.writeThrough(ctx.table)[method](ctx, ...rest);
    return { insertRow: via('insertRow'), updateRow: via('updateRow'), deleteRow: via('deleteRow') };
}

/** 404 for a table that is not a mirror, so `/source` never leaks on an ordinary one. */
function requireMirror(req, res, next) {
    if (!sources.isSourceMirror(req.datatable)) return res.status(404).json({ error: 'Not found' });
    next();
}

/** The kind's adapter for the table the grade middleware resolved. */
function adapterOf(req) {
    return sources.adapterFor(req.datatable.managedKind);
}

function sendSource(req, res) {
    res.json({ source: publicSource(req.datatable.source, req.datatable.managedKind), sync: req.datatable.syncState || null });
}

async function refreshNow(req, res) {
    try {
        const result = await sources.syncRows(req.datatable, { reason: 'manual' });
        if (result.alreadyRunning) return res.status(202).json({ alreadyRunning: true, sync: result.syncState });
        const fresh = await datatableStore.getDatatable(req.datatable.id, req.datatableScope);
        res.json({
            ok: result.ok,
            sync: fresh ? fresh.syncState : result.syncState,
            warnings: result.warnings || [],
            ...(result.ok ? {} : { error: result.error && result.error.message, code: result.error && result.error.code }),
        });
    } catch (e) {
        if (answerDatatableError(res, e, req.datatableScope)) return;
        log.error('[datatables] mirror refresh failed:', e.message);
        res.status(500).json({ error: `Could not refresh this table from ${sources.sourceLabel(req.datatable)}` });
    }
}

/**
 * The mirror's settings. What a setting IS is the kind's: the adapter
 * validates the body against its own `source` block and answers the next
 * block plus whether the change leaves the copy behind (a re-mapped column
 * does; refresh-on-open does not) — in which case the copy is marked and a
 * pass kicked behind the answer.
 */
async function saveSettings(req, res) {
    try {
        // The table's org rides along: a setting that must read the sheet
        // (a new key column) reads it as the linker, under the same tenant
        // gates as the pass (linkerAuth: linker still in the org, same
        // Nextcloud instance).
        const { next, stale } = await adapterOf(req).link.applySettings(req.datatable.source, req.body || {}, { orgId: req.datatable.organizationId || null });
        const t = await datatableStore.setSource(req.datatable.id, req.datatableScope, next);
        if (!t) return res.status(404).json({ error: 'Not found' });
        if (stale) {
            await datatableStore.markSourceStale(t.id, typeof stale === 'string' ? stale : 'settings');
            const fresh = await datatableStore.getDatatable(t.id, req.datatableScope);
            if (fresh) sources.kickStale(fresh, { reason: 'settings', delayMs: 0 });
        }
        res.json({ datatable: publicTable(t, req.datatableGrade) });
    } catch (e) {
        if (answerDatatableError(res, e, req.datatableScope)) return;
        log.error('[datatables] mirror settings failed:', e.message);
        res.status(500).json({ error: 'Could not save the settings of this table' });
    }
}

async function saveRelations(req, res) {
    try {
        const t = await adapterOf(req).link.setRelations(req.datatable, req.body && req.body.relations);
        if (!t) return res.status(404).json({ error: 'Not found' });
        sources.kickStale(t, { reason: 'relations', delayMs: 0 });
        res.json({ datatable: publicTable(t, req.datatableGrade) });
    } catch (e) {
        if (answerDatatableError(res, e, req.datatableScope)) return;
        log.error('[datatables] mirror relations failed:', e.message);
        res.status(500).json({ error: 'Could not save the relations' });
    }
}

/** Make the caller the mirror's linker; a body may re-point the source (a moved file). */
async function relinkNow(req, res) {
    try {
        const t = await adapterOf(req).link.relink(req.datatable, req.datatablePrincipal, req.session, req.body || {});
        if (!t) return res.status(404).json({ error: 'Not found' });
        sources.kickStale(t, { reason: 'relink', delayMs: 0 });
        res.json({ datatable: publicTable(t, req.datatableGrade) });
    } catch (e) {
        if (answerDatatableError(res, e, req.datatableScope)) return;
        log.error('[datatables] relink failed:', e.message);
        res.status(500).json({ error: 'Could not re-link this table' });
    }
}

function register(router) {
    router.get('/:id/source', requireDatatableGrade('viewer'), requireMirror, NO_QUERY, sendSource);

    // The PULSE: what a client polls while it has a mirror open. Answers the
    // row version (so the client reloads only when the rows moved) and the sync
    // state, and re-checks the source behind the answer when the last pass is
    // older than LIVE_STALE_MS — that is what makes the table live while
    // somebody is looking at it. Viewer grade: looking is all it takes. Written
    // out twice rather than shared, so the answer-then-kick order stays readable
    // as text at both paths.
    router.get('/:id/source/pulse', requireDatatableGrade('viewer'), requireMirror, NO_QUERY, (req, res) => {
        res.json({ dataVersion: req.datatable.dataVersion, rowCount: req.datatable.rowCount, sync: req.datatable.syncState || null });
        sources.kickStale(req.datatable, { reason: 'live', delayMs: 0 });
    });
    router.post('/:id/source/refresh', requireDatatableGrade('editor'), requireMirror, NO_QUERY, refreshNow);
    router.put('/:id/source',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        requireMirror,
        saveSettings);
    router.put('/:id/source/relations',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        requireMirror,
        saveRelations);
    router.post('/:id/source/relink',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        requireMirror,
        relinkNow);

    // The Nextcloud-era twins, what the shipped client calls. Same handlers.
    router.get('/:id/nextcloud', requireDatatableGrade('viewer'), requireMirror, NO_QUERY, sendSource);

    router.get('/:id/nextcloud/pulse', requireDatatableGrade('viewer'), requireMirror, NO_QUERY, (req, res) => {
        res.json({ dataVersion: req.datatable.dataVersion, rowCount: req.datatable.rowCount, sync: req.datatable.syncState || null });
        sources.kickStale(req.datatable, { reason: 'live', delayMs: 0 });
    });

    router.post('/:id/nextcloud/refresh', requireDatatableGrade('editor'), requireMirror, NO_QUERY, refreshNow);

    router.put('/:id/nextcloud',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        requireMirror,
        saveSettings);

    router.put('/:id/nextcloud/relations',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        requireMirror,
        saveRelations);

    router.post('/:id/nextcloud/relink',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        requireMirror,
        relinkNow);
}

module.exports = { register, mirrorCtx, mirrorWrites };
