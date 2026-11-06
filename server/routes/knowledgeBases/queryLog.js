// @typecheck strict
/**
 * Knowledge Bases — the query log, for the people who manage a base.
 *
 *   GET /query-log/notice               which of these bases log (the notice under the chat input)
 *   PUT /:id/query-log/settings         switch on or off, retention, "delete now"
 *   DELETE /:id/query-log               switch off and delete everything (no licence needed)
 *   GET /:id/query-log                  the entries, filtered
 *   GET /:id/query-log/export.csv       the same, as a file (audited, capped)
 *   GET /:id/query-log/:entryId         one entry in full
 *   PATCH /:id/query-log/:entryId/review  status and note
 *
 * Mounted BEFORE `detail`, like the other literal paths.
 *
 * ── WHO MAY SEE ANY OF THIS ─────────────────────────────────────────
 * Every KB route needs the licence (`kb_query_log`) and `canManageKB`. A caller who may only READ
 * the base (a published base, a member of the organisation) gets the same 404 as for a base that
 * does not exist: the log holds other people's questions, and its existence is not for them.
 * The notice is the one exception: it tells a reader that THEIR questions to a base they can
 * read are logged. It lists only bases the caller can read, and never says anything about the
 * others.
 *
 * ── AUDIT IS WRITTEN FIRST ──────────────────────────────────────────
 * A change of the settings and an export are recorded in the access audit BEFORE they happen
 * (stores/kb/queryLog/audit.mts throws when the row is not written). A failure answers 503 and
 * nothing has changed.
 */

const express = require('express');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth } = require('../../auth');
const { tagGate } = require('../../auth/gateMeta');
const { requireFeature: requireLicenseFeature } = require('../../license/middleware');
const license = require('../../license');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { z, worded, choice, bodyOf, queryOf, wholeNumber } = require('../../core/http/schemaParts');
const { getUserId, canAccessKB, canManageKB, blockIfSystemKB } = require('./shared');
const { metadataShape, pagingShape, textShape, metadataFilter, auditFirst } = require('./queryLogFilters');
const { REVIEW_STATUSES, RETENTION_DAYS } = require('../../core/kb/queryLog/vocab.mts');
const { invalidateKbQueryLogCache } = require('../../core/kb/queryLog/recorder.mts');
const { csvHead, csvLine } = require('../../core/kb/queryLog/csvExport.mts');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { once } = require('node:events');
const log = require('../../telemetry/log');
const { fallback } = require('../../utils/bestEffort');
const queryLogStore = require('../../stores/kb/queryLog/index.mts');
const { recordKbQueryLogEvidence } = require('../../compliance/kbQueryLogEvidence');

const FEATURE = 'kb_query_log';
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
/** One export holds at most this many rows; a narrower period is the way to more. */
const EXPORT_CAP = 50_000;
/** Same ceiling as the compliance export: what a stolen session can carry away per hour. */
const exportLimiter = perUserRateLimit({ windowMs: 60 * 60 * 1000, max: 20, name: 'kb-query-log-kb-export' });
const NOTICE_MAX_IDS = 50;
const NOTE_MAX = 4000;

// ── What a caller may send ──────────────────────────────────────────

const RETENTION_TEXT = `retentionDays is one of: ${RETENTION_DAYS.join(', ')}.`;
const SettingsBody = bodyOf({
    enabled: z.boolean({ error: 'Say whether the log is on: enabled is true or false.' }),
    retentionDays: wholeNumber(RETENTION_TEXT).refine((n) => /** @type {readonly number[]} */ (RETENTION_DAYS).includes(n), RETENTION_TEXT).optional(),
    // Only meaningful with enabled=false: "delete what is there now" instead of "keep until the term ends".
    deleteExisting: z.boolean({ error: 'deleteExisting is true or false.' }).optional(),
}, 'The query-log settings');

const ListQuery = queryOf({ ...metadataShape, ...textShape, ...pagingShape(PAGE_MAX) }, 'The query log');
const ExportQuery = queryOf({ ...metadataShape, ...textShape }, 'The query-log export');
const NoQuery = queryOf({}, 'This request');

const REVIEW_TEXT = `status is one of: ${REVIEW_STATUSES.join(', ')}.`;
const ReviewBody = bodyOf({
    status: choice(REVIEW_STATUSES, REVIEW_TEXT),
    note: worded('A note must be text.').max(NOTE_MAX, `A note is at most ${NOTE_MAX} characters.`).nullish(),
}, 'A review');

const NoticeQuery = queryOf({
    kbIds: worded('kbIds is a comma-separated list of knowledge base ids.').max(NOTICE_MAX_IDS * 40, 'kbIds is too long.'),
}, 'The notice');

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * The base, when the caller manages it and the base may carry a log. Everyone else, including a
 * reader, is told it does not exist.
 * @param {import('express').Request} req
 * @param {string} id
 */
async function managedKb(req, id) {
    const kb = await kbStore.getKB(id);
    if (!kb || !(await canManageKB(req, kb))) throw new HttpError(404, 'kb_not_found', 'KB not found');
    return kb;
}

/**
 * Gate of every KB route: the base is loaded and the caller must manage it, BEFORE the body or the
 * query is read, so a reader gets the 404 whatever they send. The base is left on `res.locals.kb`.
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function loadManagedKb(req, res, next) {
    try {
        res.locals.kb = await managedKb(req, req.params.id);
        next();
    } catch (err) { next(err); }
}
tagGate(loadManagedKb, { axis: 'scope', kind: 'kbManager', param: 'id', paramDependent: true });
const gates = [requireAuth, requireLicenseFeature(FEATURE), loadManagedKb];
// Switching off and purging must keep working after the licence ran out: manager-gated, not licence-gated.
const offGates = [requireAuth, loadManagedKb];

/** @param {Record<string, any>} row the entry as the store returns it */
function entryOut(row) {
    const { organizationId: _org, decryptFailed, ...rest } = row;
    return { ...rest, ...(decryptFailed ? { decryptFailed: true } : {}) };
}

// ── GET /query-log/notice ───────────────────────────────────────────

router.get('/query-log/notice', requireAuth, validate({ query: NoticeQuery }), async (/** @type {import('express').Request<{}, any, any, any>} */ req, res) => {
    const ids = [...new Set(String(req.query.kbIds).split(',').map((s) => s.trim()).filter(Boolean))].slice(0, NOTICE_MAX_IDS);
    const userId = getUserId(req);
    /** @type {Record<string, any>[]} */
    const readable = [];
    for (const id of ids) {
        const kb = await kbStore.getKB(id).catch((/** @type {unknown} */ e) => fallback('routes/knowledgeBases/queryLog:getKB', e, null));
        if (kb && (await canAccessKB(req, kb))) readable.push(kb);
    }
    const logging = new Set((await queryLogStore.getLoggingKbs(readable.map((k) => k.id))).map((k) => k.id));
    /** @type {{ id: string, name: string }[]} */
    const kbs = [];
    for (const kb of readable) {
        if (!logging.has(kb.id)) continue;
        // The same licence test the recorder applies: without it nothing is logged, so nothing is announced.
        if (!(await license.hasFeature({ organizationId: kb.organization_id ?? undefined, userId }, FEATURE))) continue;
        kbs.push({ id: kb.id, name: kb.name });
    }
    res.json({ active: kbs.length > 0, kbs });
});

/**
 * Apply a settings change: audit first, then write, purge and record the evidence.
 * @param {Record<string, any>} kb @param {string} actorId
 * @param {{ enabled: boolean, retentionDays?: number, deleteExisting?: boolean }} req
 */
async function applySettings(kb, actorId, { enabled, retentionDays, deleteExisting }) {
    const current = await queryLogStore.getQueryLogSettings(kb.id);
    if (!current) throw new HttpError(404, 'kb_not_found', 'KB not found');
    const nextRetention = retentionDays ?? current.retentionDays;
    const purge = !enabled && deleteExisting === true;

    const orgId = kb.organization_id ?? null;
    const old = { enabled: current.enabled, retentionDays: current.retentionDays };
    const next = { enabled, retentionDays: nextRetention };
    /** @type {import('../../stores/kb/queryLog/audit.mts').AuditEntry[]} */
    const audit = [];
    /** @param {'kb.query_log.enabled' | 'kb.query_log.disabled' | 'kb.query_log.retention_changed' | 'kb.query_log.purged'} action @param {Record<string, unknown>} [extra] */
    const push = (action, extra = {}) => audit.push({ action, targetType: 'knowledge_base', targetId: kb.id, orgId, actorId, oldValues: old, newValues: { ...next, ...extra } });
    if (enabled !== current.enabled) push(enabled ? 'kb.query_log.enabled' : 'kb.query_log.disabled');
    if (nextRetention !== current.retentionDays) push('kb.query_log.retention_changed');
    if (purge) push('kb.query_log.purged', { deleteExisting: true });

    if (audit.length > 0) {
        await auditFirst(audit);
        await queryLogStore.setQueryLogSettings(kb.id, { enabled, retentionDays: nextRetention, changedBy: actorId });
        invalidateKbQueryLogCache(kb.id);
    }
    const deleted = purge ? await queryLogStore.deleteForKb(kb.id) : 0;
    if (audit.length > 0) {
        await recordKbQueryLogEvidence(orgId, {
            action: audit.map((a) => a.action).join('+'), subjectType: 'knowledge_base', subjectId: kb.id, actorId,
            details: { enabled, retentionDays: nextRetention, deleted },
        });
    }
    const after = await queryLogStore.getQueryLogSettings(kb.id);
    return { ...after, deleted };
}

// ── PUT /:id/query-log/settings ─────────────────────────────────────

router.put('/:id/query-log/settings', ...gates, validate({ body: SettingsBody }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof SettingsBody>>} */ req, res) => {
    const kb = res.locals.kb;
    if (blockIfSystemKB(kb, res)) return;
    const actorId = getUserId(req);
    const { enabled, retentionDays, deleteExisting } = req.body;
    // A personal base has no organisation: nobody to manage, review or erase its log.
    if (enabled && !kb.organization_id) throw new HttpError(400, 'kb_query_log_needs_organization', 'The query log is only available for knowledge bases that belong to an organisation.');

    res.json(await applySettings(kb, actorId, { enabled, retentionDays, deleteExisting }));
});

// ── DELETE /:id/query-log ───────────────────────────────────────────
// Purge and switch off. Not licence-gated: after the licence expired a manager can still erase.

router.delete('/:id/query-log', ...offGates, validate({ query: NoQuery }), async (/** @type {import('express').Request<{ id: string }>} */ req, res) => {
    const kb = res.locals.kb;
    if (blockIfSystemKB(kb, res)) return;
    res.json(await applySettings(kb, getUserId(req), { enabled: false, deleteExisting: true }));
});

// ── GET /:id/query-log ──────────────────────────────────────────────

router.get('/:id/query-log', ...gates, validate({ query: ListQuery }), async (/** @type {import('express').Request<{ id: string }, any, any, import('zod').infer<typeof ListQuery>>} */ req, res) => {
    const kb = res.locals.kb;
    const limit = req.query.limit ?? PAGE_DEFAULT;
    const offset = req.query.offset ?? 0;
    const { rows, total } = await queryLogStore.listEntries({
        kbId: kb.id, orgId: kb.organization_id ?? null, ...metadataFilter(req.query), q: req.query.q || null,
        limit, offset, includeContent: true,
    });
    res.json({ rows: rows.map(entryOut), total, limit, offset });
});

// ── GET /:id/query-log/export.csv ───────────────────────────────────
// Literal path first: `:entryId` would otherwise read "export.csv" as an id.

const EXPORT_HEADERS = ['createdAt', 'user', 'channel', 'outcome', 'reviewStatus', 'query', 'answer', 'chunkCount', 'topScore', 'model', 'retrievalMs', 'answerMs', 'errorCode', 'reviewNote', 'reviewedAt'];

router.get('/:id/query-log/export.csv', ...gates, exportLimiter, validate({ query: ExportQuery }), async (/** @type {import('express').Request<{ id: string }, any, any, import('zod').infer<typeof ExportQuery>>} */ req, res) => {
    const kb = res.locals.kb;
    const filter = metadataFilter(req.query);
    const q = req.query.q || null;
    // The search text is the manager's own term and can name a person: only that it was used is recorded.
    await auditFirst([{
        action: 'kb.query_log.exported', targetType: 'knowledge_base', targetId: kb.id, orgId: kb.organization_id ?? null,
        actorId: getUserId(req), newValues: { filters: filter, text: q ? true : false, cap: EXPORT_CAP },
    }]);

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="knowledge-base-query-log.csv"');
    res.set('Cache-Control', 'no-store');
    res.write(csvHead(EXPORT_HEADERS));
    try {
        // One pass over the filter, a row at a time; only the question, answer and note are ever opened.
        for await (const r of queryLogStore.exportEntries({ kbId: kb.id, orgId: kb.organization_id ?? null, ...filter, q }, EXPORT_CAP)) {
            if (res.destroyed) return;
            const ok = res.write(csvLine(EXPORT_HEADERS, {
                createdAt: r.createdAt, user: r.userName || r.userId, channel: r.channel, outcome: r.outcome, reviewStatus: r.reviewStatus,
                query: r.query, answer: r.answer, chunkCount: r.chunkCount, topScore: r.topScore, model: r.model,
                retrievalMs: r.retrievalMs, answerMs: r.answerMs, errorCode: r.errorCode, reviewNote: r.reviewNote, reviewedAt: r.reviewedAt,
            }));
            if (!ok) await once(res, 'drain');
        }
    } catch (err) {
        // The head is on the wire already: cut the file off rather than hand over a short one that looks complete.
        log.error('[KbQueryLog] export failed mid-stream:', /** @type {Error} */ (err)?.message || err);
        res.destroy();
        return;
    }
    res.end();
});

// ── GET /:id/query-log/:entryId ─────────────────────────────────────

router.get('/:id/query-log/:entryId', ...gates, validate({ query: NoQuery }), async (/** @type {import('express').Request<{ id: string, entryId: string }>} */ req, res) => {
    const kb = res.locals.kb;
    const entry = await queryLogStore.getEntry(kb.id, req.params.entryId);
    if (!entry) throw new HttpError(404, 'entry_not_found', 'Entry not found');
    res.json(entryOut(entry));
});

// ── PATCH /:id/query-log/:entryId/review ────────────────────────────

router.patch('/:id/query-log/:entryId/review', ...gates, validate({ body: ReviewBody }), async (/** @type {import('express').Request<{ id: string, entryId: string }, any, import('zod').infer<typeof ReviewBody>>} */ req, res) => {
    const kb = res.locals.kb;
    const entry = await queryLogStore.setReview(kb.id, req.params.entryId, {
        status: req.body.status, note: req.body.note ?? null, reviewedBy: getUserId(req),
    });
    if (!entry) throw new HttpError(404, 'entry_not_found', 'Entry not found');
    res.json(entryOut(entry));
});

module.exports = router;
