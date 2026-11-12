// @typecheck strict
/**
 * Compliance — the knowledge-base query log, seen by the people who answer for it.
 *
 *   GET    /kb-query-log/overview                        per base: on or off, term, who, managers, counts. No text.
 *   GET    /kb-query-log/entries                         metadata only (time, base, person, channel, outcome, status)
 *   GET    /kb-query-log/entries/export.csv              the same as a file (audited, capped)
 *   GET    /kb-query-log/subjects/:userId                counts for one person
 *   GET    /kb-query-log/subjects/:userId/content        the text, for an open data-subject request
 *   GET    /kb-query-log/subjects/:userId/export         the person's rows as JSON or CSV, for an open request
 *   DELETE /kb-query-log/subjects/:userId                erase the person's rows, for an open request
 *
 * ── GATES ───────────────────────────────────────────────────────────
 * `admin_compliance` (and the Compliance Hub, at the mount). Deliberately NOT the `kb_query_log`
 * licence: after a licence ends the rows stay until their term runs out, and the people who answer
 * for GDPR must still be able to see, export and erase them. Writing new rows and the KB-level
 * routes are what the licence gates.
 *
 * ── ORGANISATION ────────────────────────────────────────────────────
 * Every query is pinned to the caller's home organisation, with no fallback to a shared bucket.
 *
 * ── TEXT ONLY BEHIND A REQUEST ──────────────────────────────────────
 * What people asked and what they were answered is shown to compliance for one reason: a data
 * subject request that is open in this organisation and is about that person. The access-audit
 * row is written BEFORE the text is read, and an audit that fails is a refusal. The overview and
 * the entries carry no text at all (the store returns none without `includeContent`).
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission, hasPermission, hasPermissionInOrg } = require('../../auth/permissions');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { worded, choice, bodyOf, queryOf, wholeNumber } = require('../../core/http/schemaParts');
const license = require('../../license');
const dsrStore = require('../../stores/dsrStore');
const userStore = require('../../stores/userStore');
const { resolveOrgIdStrict } = require('./shared');
const { metadataShape, pagingShape, metadataFilter, auditFirst } = require('../knowledgeBases/queryLogFilters');
const { toCsv } = require('../../core/kb/queryLog/csvExport.mts');
const queryLogStore = require('../../stores/kb/queryLog/index.mts');
const orgViews = require('../../stores/kb/queryLog/orgViews.mts');
const { fallback } = require('../../utils/bestEffort');
const { recordKbQueryLogEvidence } = require('../../compliance/kbQueryLogEvidence');

const FEATURE = 'kb_query_log';
const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;
const EXPORT_CAP = 50_000;
const EXPORT_PAGE = 500;
const MANAGERS_SCAN_CAP = 2000;
const REASON_MAX = 1000;
/** A request in one of these states is being handled; anything else is closed. */
const OPEN_DSR = new Set(['pending', 'in_progress']);

const exportLimiter = perUserRateLimit({ windowMs: 60 * 60 * 1000, max: 20, name: 'kb-query-log-export' });

// ── What a caller may send ──────────────────────────────────────────

const DSR_TEXT = 'dsrRequestId is the number of an open data-subject request of this organisation.';
const dsrRequestId = wholeNumber(DSR_TEXT, { min: 1 });

const EntriesQuery = queryOf({
    ...metadataShape,
    kbId: worded('kbId is the id of a knowledge base.').trim().min(1).max(100).optional(),
    ...pagingShape(PAGE_MAX),
}, 'The query-log entries');
const EntriesExportQuery = queryOf({
    ...metadataShape,
    kbId: worded('kbId is the id of a knowledge base.').trim().min(1).max(100).optional(),
}, 'The query-log export');
const NoQuery = queryOf({}, 'This request');
const ContentQuery = queryOf({ dsrRequestId, ...pagingShape(200) }, 'The data-subject content');
const SubjectExportQuery = queryOf({
    dsrRequestId,
    format: choice(['json', 'csv'], 'format is json or csv.').optional(),
}, 'The data-subject export');
const DeleteBody = bodyOf({
    dsrRequestId,
    reason: worded('Say why the rows are erased.').trim().min(1, 'Say why the rows are erased.').max(REASON_MAX, `The reason is at most ${REASON_MAX} characters.`),
}, 'The erasure');

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * The caller's own organisation. Never a default: this decides whose log is read. The gate's
 * `admin_compliance` may come from any organisation the caller is in; the log is read only when
 * the caller holds it IN this one (auth/permissionGrants.mts).
 * @param {import('express').Request} req
 */
async function orgOf(req) {
    const orgId = await resolveOrgIdStrict(/** @type {import('../../auth/orgScope').OrgScopeRequest} */ (/** @type {unknown} */ (req)));
    if (!orgId) throw new HttpError(403, 'no_organisation', 'This account is not in an organisation, so it has no query log to show.');
    if (!(await hasPermissionInOrg(req.session?.user?.id, 'admin_compliance', orgId, req.session))) {
        throw new HttpError(403, 'permission_required', 'This needs the compliance permission in this organisation.');
    }
    return orgId;
}

/** @param {Record<string, any> | null | undefined} u */
const nameOf = (u) => (u ? (u.displayName || u.username || null) : null);

/**
 * The request that opens a person's text, or a refusal. It must exist in THIS organisation, still
 * be open, and be about this person: a request about somebody else opens nothing here. One answer
 * for every miss, so the route is no oracle for request numbers.
 * @param {string} orgId
 * @param {string} userId
 * @param {number} requestId
 */
async function openRequestFor(orgId, userId, requestId) {
    const refuse = () => new HttpError(403, 'dsr_request_required', 'This needs an open data-subject request of this organisation about this person.');
    /** @type {Record<string, any> | null | undefined} */
    const row = await dsrStore.getRequest(orgId, requestId).catch((/** @type {unknown} */ e) => fallback('routes/compliance/kbQueryLog:getRequest', e, null));
    if (!row || !OPEN_DSR.has(row.status)) throw refuse();
    let subject = row.subject_user_id ? String(row.subject_user_id) : null;
    if (!subject && row.subject_email) subject = (await userStore.findOrgMemberIdByEmail(orgId, String(row.subject_email).trim().toLowerCase()).catch((/** @type {unknown} */ e) => fallback('routes/compliance/kbQueryLog:findMember', e, null))) || null;
    if (subject !== userId) throw refuse();
    return row;
}

/**
 * The base names of an organisation, id -> name.
 * @param {string} orgId
 */
const kbNames = (orgId) => orgViews.orgKbNames(orgId);

/**
 * The metadata of an entry, and nothing else: no text, no passages, no channel reference.
 * @param {Record<string, any>} r
 * @param {Map<string, string>} names
 */
function metaOut(r, names) {
    return {
        id: r.id, kbId: r.kbId, kbName: names.get(String(r.kbId)) || null, createdAt: r.createdAt,
        userId: r.userId, userName: r.userName || null, channel: r.channel, outcome: r.outcome,
        reviewStatus: r.reviewStatus, chunkCount: r.chunkCount, topScore: r.topScore, model: r.model, expiresAt: r.expiresAt,
    };
}

/**
 * Everyone in the organisation who may manage knowledge bases, once for the whole overview.
 * @param {string} orgId
 */
async function orgManagers(orgId) {
    const users = await orgViews.orgPeople(orgId, MANAGERS_SCAN_CAP);
    /** @type {{ id: string, name: string | null }[]} */
    const out = [];
    for (let i = 0; i < users.length; i += 20) {
        const batch = users.slice(i, i + 20);
        const flags = await Promise.all(batch.map((/** @type {{ id: string }} */ u) => hasPermission(u.id, 'manage_knowledge', null).catch((/** @type {unknown} */ e) => fallback('routes/compliance/kbQueryLog:hasPermission', e, false))));
        batch.forEach((/** @type {Record<string, any>} */ u, /** @type {number} */ k) => { if (flags[k]) out.push({ id: u.id, name: nameOf(u) }); });
    }
    return out;
}

// ── GET /kb-query-log/overview ──────────────────────────────────────

router.get('/kb-query-log/overview', requireAuth, requirePermission('admin_compliance'), validate({ query: NoQuery }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await orgOf(req);
    const kbs = await orgViews.listOrgKbs(orgId);
    const [counts, acks, managers, licensed] = await Promise.all([
        queryLogStore.countsByKb(orgId),
        queryLogStore.ackCountsByKb(kbs.map((k) => k.id)),
        orgManagers(orgId),
        license.hasFeature({ organizationId: orgId }, FEATURE),
    ]);
    const people = new Set(kbs.flatMap((/** @type {Record<string, any>} */ k) => [k.tenant_id, k.query_log_changed_by, k.query_log_attested_by]).filter(Boolean).map(String));
    /** @type {Map<string, string | null>} */
    const names = new Map(managers.map((m) => [m.id, m.name]));
    for (const id of people) {
        if (names.has(id)) continue;
        names.set(id, nameOf(await userStore.getUser(id).catch((/** @type {unknown} */ e) => fallback('routes/compliance/kbQueryLog:getUser', e, null))));
    }
    const rows = kbs
        .filter((/** @type {Record<string, any>} */ k) => k.query_log_enabled || counts[k.id]?.total)
        .map((/** @type {Record<string, any>} */ k) => {
            const c = counts[k.id] || { total: 0, byOutcome: {}, byStatus: {} };
            const managerIds = [...new Set([String(k.tenant_id), ...managers.map((m) => m.id)])];
            return {
                id: k.id, name: k.name, enabled: k.query_log_enabled === true, retentionDays: Number(k.query_log_retention_days),
                changedAt: k.query_log_changed_at, changedBy: k.query_log_changed_by || null,
                changedByName: k.query_log_changed_by ? names.get(String(k.query_log_changed_by)) || null : null,
                managers: managerIds.map((id) => ({ id, name: names.get(id) || null })),
                attestation: k.query_log_attestation ?? null, attestedBy: k.query_log_attested_by || null,
                attestedByName: k.query_log_attested_by ? names.get(String(k.query_log_attested_by)) || null : null,
                attestedAt: k.query_log_attested_at || null,
                showNames: k.query_log_show_names === true, highRisk: k.query_log_ai_act_high_risk === true,
                acknowledgedUsers: acks[k.id] || 0,
                total: c.total, byOutcome: c.byOutcome, byStatus: c.byStatus,
            };
        });
    res.json({ licensed, anyEnabled: rows.some((r) => r.enabled), kbs: rows });
});

// ── GET /kb-query-log/entries ───────────────────────────────────────

router.get('/kb-query-log/entries', requireAuth, requirePermission('admin_compliance'), validate({ query: EntriesQuery }), async (/** @type {import('express').Request<{}, any, any, import('zod').infer<typeof EntriesQuery>>} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await orgOf(req);
    const limit = req.query.limit ?? PAGE_DEFAULT;
    const offset = req.query.offset ?? 0;
    const [{ rows, total }, names] = await Promise.all([
        queryLogStore.listEntries({ orgId, kbId: req.query.kbId, ...metadataFilter(req.query), limit, offset, includeContent: false }),
        kbNames(orgId),
    ]);
    res.json({ rows: rows.map((r) => metaOut(r, names)), total, limit, offset });
});

const ENTRY_HEADERS = ['createdAt', 'knowledgeBase', 'user', 'channel', 'outcome', 'reviewStatus', 'chunkCount', 'topScore', 'model'];

router.get('/kb-query-log/entries/export.csv', requireAuth, requirePermission('admin_compliance'), exportLimiter, validate({ query: EntriesExportQuery }), async (/** @type {import('express').Request<{}, any, any, import('zod').infer<typeof EntriesExportQuery>>} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await orgOf(req);
    const filter = metadataFilter(req.query);
    await auditFirst([{
        action: 'kb.query_log.exported', targetType: 'organization', targetId: orgId, orgId,
        actorId: String(req.session?.user?.id), newValues: { scope: 'metadata', kbId: req.query.kbId || null, filters: filter, cap: EXPORT_CAP },
    }]);
    const names = await kbNames(orgId);
    /** @type {Array<Record<string, string | number | null>>} */
    const lines = [];
    for (let offset = 0; offset < EXPORT_CAP; offset += EXPORT_PAGE) {
        const { rows } = await queryLogStore.listEntries({ orgId, kbId: req.query.kbId, ...filter, limit: Math.min(EXPORT_PAGE, EXPORT_CAP - offset), offset, includeContent: false });
        for (const r of rows) {
            lines.push({
                createdAt: r.createdAt, knowledgeBase: names.get(String(r.kbId)) || r.kbId, user: r.userName || r.userId, channel: r.channel,
                outcome: r.outcome, reviewStatus: r.reviewStatus, chunkCount: r.chunkCount, topScore: r.topScore, model: r.model,
            });
        }
        if (rows.length < EXPORT_PAGE) break;
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="kb-query-log-metadata.csv"');
    res.set('Cache-Control', 'no-store');
    res.send(toCsv(ENTRY_HEADERS, lines));
});

// ── GET /kb-query-log/subjects/:userId ──────────────────────────────

router.get('/kb-query-log/subjects/:userId', requireAuth, requirePermission('admin_compliance'), validate({ query: NoQuery }), async (/** @type {import('express').Request<{ userId: string }>} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await orgOf(req);
    const userId = req.params.userId;
    const [counts, names, user] = await Promise.all([queryLogStore.countsForUser(orgId, userId), kbNames(orgId), userStore.getUser(userId).catch((/** @type {unknown} */ e) => fallback('routes/compliance/kbQueryLog:getUser', e, null))]);
    res.json({
        userId, userName: user && user.organizationId === orgId ? nameOf(user) : null, total: counts.total,
        byKb: Object.entries(counts.byKb).map(([kbId, count]) => ({ kbId, kbName: names.get(kbId) || null, count })),
    });
});

// ── GET /kb-query-log/subjects/:userId/content ──────────────────────

router.get('/kb-query-log/subjects/:userId/content', requireAuth, requirePermission('admin_compliance'), validate({ query: ContentQuery }), async (/** @type {import('express').Request<{ userId: string }, any, any, import('zod').infer<typeof ContentQuery>>} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await orgOf(req);
    const userId = req.params.userId;
    const requestId = req.query.dsrRequestId;
    await openRequestFor(orgId, userId, requestId);
    const limit = req.query.limit ?? 50;
    const offset = req.query.offset ?? 0;
    // Recorded before the text is read: no row, no text.
    await auditFirst([{
        action: 'kb.query_log.content_viewed', targetType: 'user', targetId: userId, orgId,
        actorId: String(req.session?.user?.id), newValues: { dsrRequestId: requestId, limit, offset },
    }]);
    const [{ rows, total }, names] = await Promise.all([
        queryLogStore.listEntries({ orgId, userId, limit, offset, includeContent: true }),
        kbNames(orgId),
    ]);
    res.json({ rows: rows.map((r) => ({ ...r, organizationId: undefined, kbName: names.get(String(r.kbId)) || null })), total, limit, offset });
});

// ── GET /kb-query-log/subjects/:userId/export ───────────────────────

const SUBJECT_HEADERS = ['createdAt', 'knowledgeBase', 'channel', 'outcome', 'query', 'answer', 'passages', 'model', 'reviewStatus'];

router.get('/kb-query-log/subjects/:userId/export', requireAuth, requirePermission('admin_compliance'), exportLimiter, validate({ query: SubjectExportQuery }), async (/** @type {import('express').Request<{ userId: string }, any, any, import('zod').infer<typeof SubjectExportQuery>>} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await orgOf(req);
    const userId = req.params.userId;
    const requestId = req.query.dsrRequestId;
    const format = req.query.format || 'json';
    await openRequestFor(orgId, userId, requestId);
    await auditFirst([{
        action: 'kb.query_log.subject_exported', targetType: 'user', targetId: userId, orgId,
        actorId: String(req.session?.user?.id), newValues: { dsrRequestId: requestId, format, cap: EXPORT_CAP },
    }]);
    const names = await kbNames(orgId);
    /** @type {Awaited<ReturnType<typeof queryLogStore.listEntries>>['rows']} */
    const all = [];
    for (let offset = 0; offset < EXPORT_CAP; offset += EXPORT_PAGE) {
        const { rows } = await queryLogStore.listEntries({ orgId, userId, limit: Math.min(EXPORT_PAGE, EXPORT_CAP - offset), offset, includeContent: true });
        all.push(...rows);
        if (rows.length < EXPORT_PAGE) break;
    }
    res.set('Cache-Control', 'no-store');
    if (format === 'csv') {
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="kb-query-log-subject.csv"');
        res.send(toCsv(SUBJECT_HEADERS, all.map((r) => ({
            createdAt: r.createdAt, knowledgeBase: names.get(String(r.kbId)) || r.kbId, channel: r.channel, outcome: r.outcome,
            query: r.query, answer: r.answer, passages: (r.chunks || []).map((c) => [c.title, c.sourceUri].filter(Boolean).join(' ')).join(' | '),
            model: r.model, reviewStatus: r.reviewStatus,
        }))));
        return;
    }
    res.set('Content-Disposition', 'attachment; filename="kb-query-log-subject.json"');
    res.json({ userId, exportedAt: new Date().toISOString(), total: all.length, entries: all.map((r) => ({ ...r, organizationId: undefined, kbName: names.get(String(r.kbId)) || null })) });
});

// ── DELETE /kb-query-log/subjects/:userId ───────────────────────────

router.delete('/kb-query-log/subjects/:userId', requireAuth, requirePermission('admin_compliance'), validate({ body: DeleteBody }), async (/** @type {import('express').Request<{ userId: string }, any, import('zod').infer<typeof DeleteBody>>} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await orgOf(req);
    const userId = req.params.userId;
    const actorId = String(req.session?.user?.id);
    const { dsrRequestId: requestId, reason } = req.body;
    await openRequestFor(orgId, userId, requestId);
    await auditFirst([{
        action: 'kb.query_log.subject_deleted', targetType: 'user', targetId: userId, orgId, actorId,
        newValues: { dsrRequestId: requestId, reason },
    }]);
    const deleted = await queryLogStore.deleteForUser(orgId, userId);
    await recordKbQueryLogEvidence(orgId, {
        action: 'subject_deleted', subjectType: 'user', subjectId: userId, actorId,
        details: { dsrRequestId: requestId, deleted, reasonLength: reason.length },
    });
    res.json({ deleted });
});

module.exports = router;
