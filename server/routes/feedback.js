/**
 * Feedback API Routes — Submit and query user feedback on AI responses
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Every body and query below is `.strict()`. The reads are filters, and a
 * filter that is silently dropped is not "no filter" to the person asking:
 * `?raitng=down` answered with EVERY rating to someone looking for the
 * complaints, and `?rating=Down` with none at all — which reads as "nobody
 * complained". A date the database could not parse was a 500, and `/org`
 * handed `limit` to SQL unclamped (and `?limit=abc` as NaN: another 500).
 *
 * The POST keeps the two `source` words the dashboards know ('agent',
 * 'direct'); any other spelling was stored as a third one that no tab groups
 * on. `conversationSnapshot` stays open inside: it is the conversation as the
 * client holds it, stored verbatim when the person chose to attach it. The
 * schema asks only that it be a list of messages.
 *
 * `messageId` is REQUIRED. A rating's row id is conversation + message +
 * person (feedbackStore.saveFeedback), written with ON CONFLICT DO UPDATE, so
 * a rating without a message id filed every answer of that conversation under
 * the same `…_none_…` row: rating a second answer silently REPLACED the first
 * rating, comment and snapshot included. Both clients always name the message
 * (the web its id or `msg-<index>`, the phone its id).
 */

const express = require('express');
const feedbackStore = require('../stores/feedbackStore');
// Imported from auth/permissions rather than the ../auth barrel: the barrel
// also pulls in every auth router (and their module-scope timers), which a
// route module does not need and which keeps test processes alive.
const { resolveUserOrgIds, isOrgAdminRole, requireAuth, requireSuperAdmin } = require('../auth/permissions');
const userStore = require('../stores/userStore');
const { getAll } = require('../db');
const log = require('../telemetry/log');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const router = express.Router();

/**
 * The advanced-monitoring capability, applied per route rather than at the
 * mount.
 *
 * It used to gate the whole router, which meant a user on any plan below
 * enterprise got a 403 when they tried to rate an answer — so the one channel
 * by which someone could tell this product it had been wrong existed only for
 * the customers least likely to need it. Reading OTHER people's feedback is
 * genuinely an advanced-monitoring feature; leaving your own is not.
 *
 * It runs AFTER the identity check on every route below, never before. Whether
 * you are allowed to see other tenants' data does not depend on what your
 * organisation pays, and answering an org admin's request for the cross-tenant
 * list with "your plan does not include this" — or, when the entitlement lookup
 * itself is unavailable, with a 503 — tells them the wrong thing and hides a
 * refusal behind an outage.
 */
const requireAdvancedMonitoring = (req, res, next) =>
    require('../core/entitlements/entitlements')
        .requireCapability('advanced_usage_monitoring')(req, res, next);

// Upper bound on both lists. Without it a single request can pull the whole
// table — and on /org, every conversation snapshot the organisation holds.
const MAX_FEEDBACK_LIMIT = 500;
const DEFAULT_FEEDBACK_LIMIT = 200;

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** An id as the chat holds it: text, or a number the store keeps as text. */
const asIdText = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : v);
const idText = (message) => z.preprocess(asIdText, worded(message).trim().max(200, message));
/** The same, where leaving it out — or sending it empty — is not an option. */
const requiredIdText = (message) => z.preprocess(asIdText, worded(message).trim().min(1, message).max(200, message));

const RATING_TEXT = 'rating must be "up" or "down"';
const SOURCE_TEXT = 'source is "agent" or "direct".';
const rating = () => z.enum(['up', 'down'], { errorMap: () => ({ message: RATING_TEXT }) });
const source = () => z.enum(['agent', 'direct'], { errorMap: () => ({ message: SOURCE_TEXT }) });

/** A moment, handed to the database as ISO text rather than as a string it has to guess at. */
const moment = (name) => {
    const text = `${name} is a date, like 2026-09-01T00:00:00Z.`;
    return worded(text).refine((v) => !Number.isNaN(Date.parse(v)), text)
        .transform((v) => new Date(v).toISOString()).optional();
};

const SNAPSHOT_TEXT = 'conversationSnapshot is the list of messages in the conversation.';
const MESSAGE_TEXT = 'Say which message the rating is for (messageId).';
const FeedbackBody = z.object({
    conversationId: idText('conversationId is the id of the conversation.').nullish(),
    // Required: without it every rating in the conversation shares one row.
    messageId: requiredIdText(MESSAGE_TEXT),
    agentId: idText('agentId is the id of the agent.').nullish(),
    agentName: worded('agentName is text.').nullish(),
    model: worded('model is the id of a model.').nullish(),
    modelTier: worded('modelTier is the name of a model tier.').nullish(),
    rating: rating(),
    comment: worded('A comment is text.').nullish(),
    source: source().optional(),
    conversationSnapshot: z.array(
        z.record(z.unknown(), { invalid_type_error: SNAPSHOT_TEXT }),
        { invalid_type_error: SNAPSHOT_TEXT },
    ).nullish(),
}, { required_error: RATING_TEXT, invalid_type_error: RATING_TEXT }).strict();

const LIMIT_TEXT = `limit is a whole number from 1 to ${MAX_FEEDBACK_LIMIT}.`;
const RangeQuery = z.object({ startDate: moment('startDate'), endDate: moment('endDate') }).strict();
const ListQuery = RangeQuery.extend({
    rating: rating().optional(),
    agentId: idText('agentId is the id of the agent.').optional(),
    source: source().optional(),
    // Clamped rather than refused above the cap: a page size is a request, and
    // the answer to "more than that" is the most there is.
    limit: z.coerce.number({ invalid_type_error: LIMIT_TEXT }).int(LIMIT_TEXT).min(1, LIMIT_TEXT)
        .transform((n) => Math.min(n, MAX_FEEDBACK_LIMIT)).optional(),
}).strict();

// Resolves the caller's own org id and rejects when the caller is not an
// org admin for it. Super admins are also allowed (they can use the global
// /api/feedback endpoints, but this lets them sanity-check the org view).
async function requireOwnOrgAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';

    const orgIds = await resolveUserOrgIds(req);
    const orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    if (!orgId) return res.status(403).json({ error: 'No organisation context' });

    if (isSuperAdmin) {
        req.scopedOrgId = orgId;
        return next();
    }

    const user = await userStore.getUser(req.session.user.id);
    if (!user || !isOrgAdminRole(user.orgRole)) {
        return res.status(403).json({ error: 'Organization admin access required' });
    }
    req.scopedOrgId = orgId;
    next();
}

// Best-effort lookup of the concrete model + agent_name used for the most
// recent assistant call in this conversation. Lets us surface the actual
// resolved model in the feedback UI when the agent is configured with a
// tier (e.g. tier:auto). Returns { model, agent_name } or {}.
async function lookupConversationContext(conversationId) {
    if (!conversationId) return {};
    try {
        const rows = await getAll(
            `SELECT model, agent_name FROM ai_usage_log
             WHERE conversation_id = $1 AND tool_name IS NULL
             ORDER BY timestamp DESC LIMIT 1`,
            [conversationId]
        );
        return rows?.[0] || {};
    } catch (_) { return {}; }
}

// POST / — submit feedback
// requireAuth: the handler already assumes a session (it resolves userId and
// the owning org from it), and without a gate anyone could write rows —
// including an arbitrary conversationSnapshot — into the table the operator
// dashboard reads.
router.post('/', requireAuth, validate({ body: FeedbackBody }), async (req, res) => {
    const {
        conversationId, messageId, agentId, agentName,
        model, modelTier,
        rating, comment, source, conversationSnapshot,
    } = req.body;

    const userId = req.session?.user?.id || req.session?.user?.username || null;
    // Resolve org from user's groups
    const orgIds = await resolveUserOrgIds(req);
    const organizationId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

    // Backfill: when the frontend doesn't know the concrete model that
    // served the message (typical for tier:auto), look it up from the
    // most recent assistant call on this conversation. agent_name is
    // also pulled from there if the client didn't send it.
    let resolvedModel = model || null;
    let resolvedAgentName = agentName || null;
    if (!resolvedModel || !resolvedAgentName) {
        const ctx = await lookupConversationContext(conversationId);
        if (!resolvedModel) resolvedModel = ctx.model || null;
        if (!resolvedAgentName) resolvedAgentName = ctx.agent_name || null;
    }

    const result = await feedbackStore.saveFeedback({
        conversationId,
        messageId,
        agentId,
        agentName: resolvedAgentName,
        model: resolvedModel,
        modelTier: modelTier || null,
        userId,
        organizationId,
        rating,
        comment,
        source: source || 'agent',
        conversationSnapshot: conversationSnapshot || null,
    });

    res.json({ ok: true, id: result.id });
});

// GET / — list feedback across ALL tenants (platform operator only).
//
// This is not merely "admin": getFeedback() is `SELECT * FROM message_feedback`
// with no tenant predicate, and the rows carry conversation_snapshot — the
// verbatim, unencrypted text of every message in the conversation the user
// chose to attach. Until this gate existed the route was reachable
// unauthenticated, so the org-scoped siblings below (which DO filter) were the
// only protected path. Org admins belong on /org, not here.
router.get('/', requireSuperAdmin, requireAdvancedMonitoring, validate({ query: ListQuery }), async (req, res) => {
    const { startDate, endDate, rating, agentId, source, limit } = req.query;
    const data = await feedbackStore.getFeedback(
        { startDate, endDate, rating, agentId, source },
        limit ?? DEFAULT_FEEDBACK_LIMIT
    );
    res.json(data);
});

// GET /summary — aggregated stats across ALL tenants (platform operator only).
router.get('/summary', requireSuperAdmin, requireAdvancedMonitoring, validate({ query: RangeQuery }), async (req, res) => {
    const { startDate, endDate } = req.query;
    const data = await feedbackStore.getFeedbackSummary({ startDate, endDate });
    res.json(data);
});

// ── Org-scoped endpoints ───────────────────────────────────────────────────
// These mirror GET / and GET /summary but force-inject the caller's own
// organization_id into the filter, so org admins only see their org's data.

// Enriches a feedback row's conversation_snapshot with per-assistant-message
// duration_ms and model, sourced from ai_usage_log. Pairing is by position:
// the Nth non-tool ai_usage_log row for the conversation maps to the Nth
// assistant message in the snapshot. This is fragile if rows are missing on
// either side, so we only annotate when counts align — otherwise we leave
// snapshot messages untouched.
async function enrichSnapshotsWithUsage(rows) {
    const conversationIds = Array.from(new Set(
        rows.map(r => r.conversation_id).filter(Boolean)
    ));
    if (conversationIds.length === 0) return rows;

    let usageRows = [];
    try {
        usageRows = await getAll(
            `SELECT conversation_id, model, duration_ms, timestamp
             FROM ai_usage_log
             WHERE conversation_id = ANY($1::text[]) AND tool_name IS NULL
             ORDER BY conversation_id, timestamp ASC`,
            [conversationIds]
        );
    } catch (e) {
        // Best-effort: if usage log lookup fails, return raw rows.
        log.error('[Feedback API] enrich lookup failed:', e.message);
        return rows;
    }

    const byConv = new Map();
    for (const u of usageRows) {
        if (!byConv.has(u.conversation_id)) byConv.set(u.conversation_id, []);
        byConv.get(u.conversation_id).push(u);
    }

    return rows.map(r => {
        if (!r.conversation_snapshot) return r;
        let snap;
        try {
            snap = typeof r.conversation_snapshot === 'string'
                ? JSON.parse(r.conversation_snapshot)
                : r.conversation_snapshot;
        } catch {
            return r;
        }
        if (!Array.isArray(snap)) return r;

        const usage = byConv.get(r.conversation_id) || [];
        let assistantIdx = 0;
        const annotated = snap.map(msg => {
            if (msg.role !== 'assistant') return msg;
            const u = usage[assistantIdx++];
            if (!u) return msg;
            return {
                ...msg,
                duration_ms: msg.duration_ms ?? u.duration_ms ?? null,
                model: msg.model || u.model || null,
            };
        });
        return { ...r, conversation_snapshot: JSON.stringify(annotated) };
    });
}

// GET /org — list feedback for the caller's organisation
router.get('/org', requireOwnOrgAdmin, requireAdvancedMonitoring, validate({ query: ListQuery }), async (req, res) => {
    const { startDate, endDate, rating, agentId, source, limit } = req.query;
    const data = await feedbackStore.getFeedback(
        { startDate, endDate, rating, agentId, source, organizationId: req.scopedOrgId },
        limit ?? DEFAULT_FEEDBACK_LIMIT
    );
    const enriched = await enrichSnapshotsWithUsage(Array.isArray(data) ? data : []);
    res.json(enriched);
});

// GET /org/summary — aggregated stats for the caller's organisation
router.get('/org/summary', requireOwnOrgAdmin, requireAdvancedMonitoring, validate({ query: RangeQuery }), async (req, res) => {
    const { startDate, endDate } = req.query;
    const data = await feedbackStore.getFeedbackSummary({
        startDate, endDate, organizationId: req.scopedOrgId,
    });
    res.json(data);
});

module.exports = router;
