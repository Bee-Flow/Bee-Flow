// @typecheck strict
/**
 * Knowledge Bases — the query log, for the people who manage a base.
 *
 *   (the notice, the acknowledgement and the DPIA list are in queryLogNotice.js)
 *   PUT /:id/query-log/settings         switch on or off, retention, "delete now"
 *   DELETE /:id/query-log               switch off and delete everything (no licence needed)
 *   GET /:id/query-log                  the entries, filtered (audited per page, rate limited)
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
 * A change of the settings, a page of the list and an export are recorded in the access audit BEFORE they happen
 * (stores/kb/queryLog/audit.mts throws when the row is not written). A failure answers 503 and
 * nothing has changed.
 */

const express = require('express');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth } = require('../../auth');
const { tagGate } = require('../../auth/gateMeta');
const { requireFeature: requireLicenseFeature } = require('../../license/middleware');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { z, worded, choice, bodyOf, queryOf, wholeNumber } = require('../../core/http/schemaParts');
const { getUserId, canManageKB, blockIfSystemKB } = require('./shared');
const { metadataShape, pagingShape, textShape, metadataFilter, auditFirst } = require('./queryLogFilters');
const { REVIEW_STATUSES, RETENTION_DAYS, HIGH_RISK_MIN_RETENTION_DAYS } = require('../../core/kb/queryLog/vocab.mts');
const { invalidateKbQueryLogCache } = require('../../core/kb/queryLog/recorder.mts');
const { validateAttestation } = require('../../core/kb/queryLog/attestation.mts');
const { maskAsker, resolveAskerFilter, showsNames } = require('../../core/kb/queryLog/askers.mts');
const { csvHead, csvLine } = require('../../core/kb/queryLog/csvExport.mts');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { envByteLimit } = require('../../core/http/httpResponseLimits');
const { once } = require('node:events');
const { isDeepStrictEqual } = require('node:util');
const log = require('../../telemetry/log');
const queryLogStore = require('../../stores/kb/queryLog/index.mts');
const { recordKbQueryLogEvidence } = require('../../compliance/kbQueryLogEvidence');

/** @typedef {{ id: string, organization_id?: string | null, query_log_show_names?: boolean | null }} KbRow */
/** @typedef {import('../../stores/kb/queryLog/index.mts').EntryRow} EntryRow */
/** @typedef {import('../../core/kb/queryLog/attestation.mts').Attestation} Attestation */

const FEATURE = 'kb_query_log';
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
/** One export holds at most this many rows; a narrower period is the way to more. */
const EXPORT_CAP = 50_000;
/** Same ceiling as the compliance export: what a stolen session can carry away per hour. */
const exportLimiter = perUserRateLimit({ windowMs: 60 * 60 * 1000, max: 20, name: 'kb-query-log-kb-export' });
/** Pages of the list (question and answer text) one person reads per hour: KB_QUERY_LOG_READS_PER_HOUR, 0 = no limit. */
const READS_PER_HOUR = envByteLimit('KB_QUERY_LOG_READS_PER_HOUR', 600);
/** @type {import('express').RequestHandler} */
const readLimiter = READS_PER_HOUR === Infinity ? (_req, _res, next) => next()
    : perUserRateLimit({ windowMs: 60 * 60 * 1000, max: READS_PER_HOUR, name: 'kb-query-log-kb-read' });
const NOTE_MAX = 4000;

// ── What a caller may send ──────────────────────────────────────────

const RETENTION_TEXT = `retentionDays is one of: ${RETENTION_DAYS.join(', ')}.`;
const SettingsBody = bodyOf({
    enabled: z.boolean({ error: 'Say whether the log is on: enabled is true or false.' }),
    retentionDays: wholeNumber(RETENTION_TEXT).refine((n) => /** @type {readonly number[]} */ (RETENTION_DAYS).includes(n), RETENTION_TEXT).optional(),
    // Only meaningful with enabled=false: "delete what is there now" instead of "keep until the term ends".
    deleteExisting: z.boolean({ error: 'deleteExisting is true or false.' }).optional(),
    // The organisation's statement of its preconditions; checked field by field in validateAttestation (400 with the missing fields).
    attestation: z.record(z.string(), z.unknown(), { error: 'attestation is an object.' }).optional(),
    // Managers see a pseudonym per asker unless this is on.
    showNames: z.boolean({ error: 'showNames is true or false.' }).optional(),
    // AI Act high-risk system: the log must be kept at least 180 days.
    aiActHighRisk: z.boolean({ error: 'aiActHighRisk is true or false.' }).optional(),
}, 'The query-log settings');

const ListQuery = queryOf({ ...metadataShape, ...textShape, ...pagingShape(PAGE_MAX) }, 'The query log');
const ExportQuery = queryOf({ ...metadataShape, ...textShape }, 'The query-log export');
const NoQuery = queryOf({}, 'This request');

const REVIEW_TEXT = `status is one of: ${REVIEW_STATUSES.join(', ')}.`;
const ReviewBody = bodyOf({
    status: choice(REVIEW_STATUSES, REVIEW_TEXT),
    note: worded('A note must be text.').max(NOTE_MAX, `A note is at most ${NOTE_MAX} characters.`).nullish(),
}, 'A review');

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

/**
 * @param {EntryRow} row the entry as the store returns it
 * @param {KbRow} kb  the base: decides whether the asker is named or a pseudonym
 */
function entryOut(row, kb) {
    const { organizationId: _org, decryptFailed, ...rest } = maskAsker(row, kb);
    return { ...rest, ...(decryptFailed ? { decryptFailed: true } : {}) };
}

/** The person filter of a manager: a user id when names are shown, otherwise a pseudonym id.
 * @param {KbRow} kb @param {string | null} userId */
const askerFilter = (kb, userId) => resolveAskerFilter(userId, { ...kb, id: String(kb.id) }, (/** @type {string} */ id) => queryLogStore.askersOfKb(id));

/**
 * Flat, scalar form of an attestation for the evidence payload (which holds scalars only).
 * @param {Partial<Attestation> | null | undefined} a
 * @returns {Record<string, string | boolean | null>}
 */
function attestationEvidence(a) {
    if (!a) return {};
    return {
        attPurpose: a.purpose ?? null, attDpia: a.dpia ?? null, attDpiaId: a.dpiaId ?? null,
        attWorksCouncil: a.worksCouncil ?? null, attWorksCouncilReason: a.worksCouncilReason ?? null,
        attPrivacyNoticeUpdated: a.privacyNoticeUpdated === true,
    };
}

/**
 * The attestation to store, or a refusal. Needed when the log is switched on; also checked whenever one is sent.
 * Naming the askers and the high-risk flag need one on file (sent now, or stored earlier).
 * @param {KbRow} kb @param {import('../../stores/kb/queryLog/types.mts').QueryLogSettings} current
 * @param {import('zod').infer<typeof SettingsBody>} body
 * @returns {Promise<Attestation | null>} the new attestation (null = keep the stored one)
 */
async function attestationFor(kb, current, body) {
    const turningOn = body.enabled === true && !current.enabled;
    const needsOnFile = body.showNames === true || body.aiActHighRisk === true;
    if (body.attestation === undefined) {
        if (turningOn || (needsOnFile && !current.attestation)) {
            throw new HttpError(400, 'kb_query_log_attestation_required', 'Confirm the preconditions of the query log first.', { missing: ['attestation'] });
        }
        return null;
    }
    const check = await validateAttestation(body.attestation, String(kb.organization_id));
    if (!check.ok) {
        throw new HttpError(400, 'kb_query_log_attestation_required', `The attestation is incomplete: ${check.missing.join(', ')}.`, { missing: check.missing });
    }
    return check.value;
}

/**
 * The audit rows of a settings change, one per thing that changed.
 * @param {KbRow} kb @param {string} actorId
 * @param {{ enabled: boolean, retentionDays: number, showNames: boolean, aiActHighRisk: boolean }} old
 * @param {{ enabled: boolean, retentionDays: number, showNames: boolean, aiActHighRisk: boolean }} next
 * @param {{ attestation: Attestation | null, current: import('../../stores/kb/queryLog/types.mts').QueryLogSettings, purge: boolean }} more
 */
function auditRows(kb, actorId, old, next, { attestation, current, purge }) {
    /** @type {import('../../stores/kb/queryLog/audit.mts').AuditEntry[]} */
    const audit = [];
    /** @param {import('../../stores/kb/queryLog/audit.mts').AuditAction} action @param {Record<string, unknown>} [extra] */
    const push = (action, extra = {}) => audit.push({
        action, targetType: 'knowledge_base', targetId: kb.id, orgId: kb.organization_id ?? null, actorId, oldValues: old,
        newValues: { ...next, ...(attestation ? { attestation } : {}), ...extra },
    });
    if (next.enabled !== current.enabled) push(next.enabled ? 'kb.query_log.enabled' : 'kb.query_log.disabled');
    else if (attestation && !isDeepStrictEqual(attestation, current.attestation)) push('kb.query_log.attested');
    if (next.retentionDays !== current.retentionDays) push('kb.query_log.retention_changed');
    if (next.showNames !== current.showNames) push('kb.query_log.names_changed');
    if (next.aiActHighRisk !== current.aiActHighRisk) push('kb.query_log.high_risk_changed');
    if (purge) push('kb.query_log.purged', { deleteExisting: true });
    return audit;
}

/**
 * Refuse a high-risk base with a term shorter than the AI Act allows (Art. 26(6): at least six months).
 * @param {{ enabled: boolean, aiActHighRisk: boolean, retentionDays: number }} next @param {boolean} flagSent
 */
function assertHighRiskTerm(next, flagSent) {
    if (next.aiActHighRisk && (next.enabled || flagSent) && next.retentionDays < HIGH_RISK_MIN_RETENTION_DAYS) {
        throw new HttpError(400, 'kb_query_log_retention_too_short', `A high-risk AI system keeps its logs for at least ${HIGH_RISK_MIN_RETENTION_DAYS} days: pick ${HIGH_RISK_MIN_RETENTION_DAYS} or 365.`);
    }
}

/**
 * Apply a settings change: audit first, then write, purge and record the evidence.
 * @param {KbRow} kb @param {string} actorId
 * @param {import('zod').infer<typeof SettingsBody>} body
 */
async function applySettings(kb, actorId, body) {
    const current = await queryLogStore.getQueryLogSettings(kb.id);
    if (!current) throw new HttpError(404, 'kb_not_found', 'KB not found');
    const next = {
        enabled: body.enabled, retentionDays: body.retentionDays ?? current.retentionDays,
        showNames: body.showNames ?? current.showNames, aiActHighRisk: body.aiActHighRisk ?? current.aiActHighRisk,
    };
    assertHighRiskTerm(next, body.aiActHighRisk === true);
    const attestation = await attestationFor(kb, current, body);
    const purge = !body.enabled && body.deleteExisting === true;
    const old = { enabled: current.enabled, retentionDays: current.retentionDays, showNames: current.showNames, aiActHighRisk: current.aiActHighRisk };
    const audit = auditRows(kb, actorId, old, next, { attestation, current, purge });

    if (audit.length > 0) {
        await auditFirst(audit);
        await queryLogStore.setQueryLogSettings(kb.id, { ...next, attestation, changedBy: actorId });
        invalidateKbQueryLogCache(kb.id);
    }
    const deleted = purge ? await queryLogStore.deleteForKb(kb.id) : 0;
    if (audit.length > 0) {
        await recordKbQueryLogEvidence(kb.organization_id ?? null, {
            action: audit.map((a) => a.action).join('+'), subjectType: 'knowledge_base', subjectId: kb.id, actorId,
            details: { ...next, deleted, ...attestationEvidence(attestation ?? /** @type {Partial<Attestation> | null} */ (current.attestation)) },
        });
    }
    return { ...(await queryLogStore.getQueryLogSettings(kb.id)), deleted };
}

// ── PUT /:id/query-log/settings ─────────────────────────────────────

router.put('/:id/query-log/settings', ...gates, validate({ body: SettingsBody }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof SettingsBody>>} */ req, res) => {
    const kb = res.locals.kb;
    if (blockIfSystemKB(kb, res)) return;
    const actorId = getUserId(req);
    const { enabled } = req.body;
    // A personal base has no organisation: nobody to manage, review or erase its log.
    if (enabled && !kb.organization_id) throw new HttpError(400, 'kb_query_log_needs_organization', 'The query log is only available for knowledge bases that belong to an organisation.');

    res.json(await applySettings(kb, actorId, req.body));
});

// ── DELETE /:id/query-log ───────────────────────────────────────────
// Purge and switch off. Not licence-gated: after the licence expired a manager can still erase.

router.delete('/:id/query-log', ...offGates, validate({ query: NoQuery }), async (/** @type {import('express').Request<{ id: string }>} */ req, res) => {
    const kb = res.locals.kb;
    if (blockIfSystemKB(kb, res)) return;
    res.json(await applySettings(kb, getUserId(req), { enabled: false, deleteExisting: true }));
});

// ── GET /:id/query-log/settings ─────────────────────────────────────
// Literal path before `:entryId`.

router.get('/:id/query-log/settings', ...gates, validate({ query: NoQuery }), async (/** @type {import('express').Request<{ id: string }>} */ req, res) => {
    const kb = res.locals.kb;
    const settings = await queryLogStore.getQueryLogSettings(kb.id);
    if (!settings) throw new HttpError(404, 'kb_not_found', 'KB not found');
    const acks = await queryLogStore.ackCountsByKb([kb.id]);
    res.json({ ...settings, acknowledgedUsers: acks[kb.id] || 0 });
});

// ── GET /:id/query-log ──────────────────────────────────────────────

router.get('/:id/query-log', ...gates, readLimiter, validate({ query: ListQuery }), async (/** @type {import('express').Request<{ id: string }, any, any, import('zod').infer<typeof ListQuery>>} */ req, res) => {
    const kb = res.locals.kb;
    const limit = req.query.limit ?? PAGE_DEFAULT;
    const offset = req.query.offset ?? 0;
    const filter = metadataFilter(req.query);
    // Every page carries question and answer text: who read which page is recorded first, as for the export.
    await auditFirst([{
        action: 'kb.query_log.content_viewed', targetType: 'knowledge_base', targetId: kb.id, orgId: kb.organization_id ?? null,
        actorId: getUserId(req), newValues: { filters: filter, text: req.query.q ? true : false, limit, offset, showNames: showsNames(kb) },
    }]);
    const { rows, total } = await queryLogStore.listEntries({
        kbId: kb.id, orgId: kb.organization_id ?? null, ...filter, userId: await askerFilter(kb, filter.userId), q: req.query.q || null,
        limit, offset, includeContent: true,
    });
    res.json({ rows: rows.map((r) => entryOut(r, kb)), total, limit, offset });
});

// ── GET /:id/query-log/export.csv ───────────────────────────────────
// Literal path first: `:entryId` would otherwise read "export.csv" as an id.

const EXPORT_HEADERS = ['createdAt', 'asker', 'channel', 'outcome', 'reviewStatus', 'query', 'answer', 'chunkCount', 'topScore', 'model', 'retrievalMs', 'answerMs', 'errorCode', 'reviewNote', 'reviewedAt'];

router.get('/:id/query-log/export.csv', ...gates, exportLimiter, validate({ query: ExportQuery }), async (/** @type {import('express').Request<{ id: string }, any, any, import('zod').infer<typeof ExportQuery>>} */ req, res) => {
    const kb = res.locals.kb;
    const filter = metadataFilter(req.query);
    const q = req.query.q || null;
    const userId = await askerFilter(kb, filter.userId);
    // The search text is the manager's own term and can name a person: only that it was used is recorded.
    await auditFirst([{
        action: 'kb.query_log.exported', targetType: 'knowledge_base', targetId: kb.id, orgId: kb.organization_id ?? null,
        actorId: getUserId(req), newValues: { filters: filter, text: q ? true : false, cap: EXPORT_CAP, showNames: showsNames(kb) },
    }]);

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="knowledge-base-query-log.csv"');
    res.set('Cache-Control', 'no-store');
    res.write(csvHead(EXPORT_HEADERS));
    try {
        // One pass over the filter, a row at a time; only the question, answer and note are ever opened.
        for await (const r of queryLogStore.exportEntries({ kbId: kb.id, orgId: kb.organization_id ?? null, ...filter, userId, q }, EXPORT_CAP)) {
            if (res.destroyed) return;
            const asker = (/** @type {EntryRow} */ row) => { const m = maskAsker(row, kb); return showsNames(kb) ? (m.userName || m.userId) : m.askerPseudonym; };
            const ok = res.write(csvLine(EXPORT_HEADERS, {
                createdAt: r.createdAt, asker: asker(r), channel: r.channel, outcome: r.outcome, reviewStatus: r.reviewStatus,
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
    res.json(entryOut(entry, kb));
});

// ── PATCH /:id/query-log/:entryId/review ────────────────────────────

router.patch('/:id/query-log/:entryId/review', ...gates, validate({ body: ReviewBody }), async (/** @type {import('express').Request<{ id: string, entryId: string }, any, import('zod').infer<typeof ReviewBody>>} */ req, res) => {
    const kb = res.locals.kb;
    const entry = await queryLogStore.setReview(kb.id, req.params.entryId, {
        status: req.body.status, note: req.body.note ?? null, reviewedBy: getUserId(req),
    });
    if (!entry) throw new HttpError(404, 'entry_not_found', 'Entry not found');
    res.json(entryOut(entry, kb));
});

module.exports = router;
