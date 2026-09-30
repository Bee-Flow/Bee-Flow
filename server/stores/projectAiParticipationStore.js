// @typecheck
/**
 * The bookkeeping behind the AI that decides by itself when to take part
 * (projects/participation/): a queue of debounced "watches", an audit log of
 * decisions that is also the source of every cap, and the "not helpful"
 * feedback that pauses automatic answers.
 *
 *   project_ai_watch      one PENDING row per (surface, container, kind):
 *                         `quiet` (the conversation went quiet after a human
 *                         message) or `unanswered` (a question the gate chose
 *                         to leave to people first). A new message pushes the
 *                         pending row back instead of adding one (debounce),
 *                         up to a ceiling counted from its first message.
 *   project_ai_decisions  what was decided and why, as CODES: replied, silent,
 *                         deferred, skipped (+ skip_reason), the gate's
 *                         reason_code and confidence, the model, the answer's
 *                         message id. One row per gate call is reserved BEFORE
 *                         the call, unique per (container, last seq, trigger
 *                         kind), so a re-claimed watch never pays twice.
 *   project_ai_feedback   one row per (message, person): "not helpful".
 *
 * ── No content ──────────────────────────────────────────────────────────────
 *
 * None of these tables has a column that could hold text people wrote, or
 * text the model wrote: ids, codes, numbers and timestamps only. The gate's
 * free-text reason is never passed in. Decisions are pruned after 90 days.
 *
 * ── Many servers ────────────────────────────────────────────────────────────
 *
 * `claimDue` flips due rows to `claimed` in the statement that selects them
 * (FOR UPDATE SKIP LOCKED), so two replicas never process the same watch, and
 * it skips a container that already has a claimed watch, so one conversation
 * is handled by one worker at a time and its caps are read exactly. That
 * second rule needs the claims to take turns: under READ COMMITTED a claim
 * statement cannot see another replica's claim that is not committed yet, so
 * two overlapping claims could each take a different watch of the same
 * container. Each claim therefore runs in a transaction that first takes one
 * advisory transaction lock (CLAIM_LOCK); its statement's snapshot is taken
 * after the lock, so it sees every claim committed before it. A claim is a
 * few milliseconds every few seconds per replica, so the turns cost nothing.
 * A claim that is never finished is released by `reapStuck`.
 *
 * Built by a factory over a `{ query, tx }` handle so the pg test runs the
 * store's own SQL against PGlite; the default instance wraps the pool.
 */

'use strict';

const crypto = require('crypto');
const { exec, pool, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const SURFACES = Object.freeze(['chat', 'comment']);
const WATCH_KINDS = Object.freeze(['quiet', 'unanswered']);
const TRIGGER_KINDS = Object.freeze(['quiet', 'unanswered', 'explicit', 'always']);
const DECISIONS = Object.freeze(['pending', 'replied', 'silent', 'deferred', 'skipped']);
const DECISION_RETENTION_DAYS = 90;
const WATCH_RETENTION_DAYS = 2;
const FEEDBACK_WINDOW_HOURS = 24;
/** The advisory lock every claim takes in turn (see "Many servers"). */
const CLAIM_LOCK = 'beeflow:ai-watch-claim';

const DDL = `
    CREATE TABLE IF NOT EXISTS project_ai_watch (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        surface        TEXT NOT NULL CHECK (surface IN ('chat', 'comment')),
        container_id   TEXT NOT NULL,
        message_id     TEXT NOT NULL,
        author_user_id TEXT NOT NULL,
        org_id         TEXT,
        limit_org_id   TEXT,
        kind           TEXT NOT NULL CHECK (kind IN ('quiet', 'unanswered')),
        due_at         TIMESTAMPTZ NOT NULL,
        first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        state          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'claimed', 'done', 'cancelled')),
        claim_id       TEXT,
        claimed_at     TIMESTAMPTZ,
        attempts       INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_ai_watch_pending
        ON project_ai_watch(surface, container_id, kind) WHERE state = 'pending';
    CREATE INDEX IF NOT EXISTS idx_project_ai_watch_due
        ON project_ai_watch(due_at) WHERE state = 'pending';
    CREATE INDEX IF NOT EXISTS idx_project_ai_watch_claimed
        ON project_ai_watch(container_id) WHERE state = 'claimed';

    CREATE TABLE IF NOT EXISTS project_ai_decisions (
        id                 TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        org_id             TEXT,
        surface            TEXT NOT NULL CHECK (surface IN ('chat', 'comment')),
        container_id       TEXT NOT NULL,
        trigger_message_id TEXT,
        trigger_kind       TEXT NOT NULL CHECK (trigger_kind IN ('quiet', 'unanswered', 'explicit', 'always')),
        decision           TEXT NOT NULL CHECK (decision IN ('pending', 'replied', 'silent', 'deferred', 'skipped')),
        skip_reason        TEXT,
        reason_code        TEXT,
        confidence         REAL,
        model              TEXT,
        gate_called        BOOLEAN NOT NULL DEFAULT FALSE,
        last_seq           BIGINT,
        reply_message_id   TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at         TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_ai_decisions_gate
        ON project_ai_decisions(surface, container_id, last_seq, trigger_kind) WHERE gate_called;
    CREATE INDEX IF NOT EXISTS idx_project_ai_decisions_container
        ON project_ai_decisions(container_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_ai_decisions_project
        ON project_ai_decisions(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_ai_decisions_org_gate
        ON project_ai_decisions(org_id, created_at DESC) WHERE gate_called;

    CREATE TABLE IF NOT EXISTS project_ai_feedback (
        message_id   TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        surface      TEXT NOT NULL CHECK (surface IN ('chat', 'comment')),
        container_id TEXT NOT NULL,
        helpful      BOOLEAN NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_ai_feedback_container
        ON project_ai_feedback(container_id, created_at DESC);
`;

const toIso = (v) => (v ? new Date(v).toISOString() : null);
const toInt = (v) => (v === null || v === undefined ? 0 : Number(v));
const secs = (n) => Math.max(0, Math.round(Number(n) || 0));

function rowToWatch(r) {
    if (!r) return null;
    return {
        id: r.id,
        projectId: r.project_id,
        surface: r.surface,
        containerId: r.container_id,
        messageId: r.message_id,
        authorUserId: r.author_user_id,
        orgId: r.org_id || null,
        limitOrgId: r.limit_org_id || null,
        kind: r.kind,
        dueAt: toIso(r.due_at),
        firstSeenAt: toIso(r.first_seen_at),
        state: r.state,
        claimId: r.claim_id || null,
        attempts: toInt(r.attempts),
    };
}

function rowToDecision(r) {
    if (!r) return null;
    return {
        id: r.id,
        projectId: r.project_id,
        orgId: r.org_id || null,
        surface: r.surface,
        containerId: r.container_id,
        triggerMessageId: r.trigger_message_id || null,
        triggerKind: r.trigger_kind,
        decision: r.decision,
        skipReason: r.skip_reason || null,
        reasonCode: r.reason_code || null,
        confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
        model: r.model || null,
        gateCalled: !!r.gate_called,
        lastSeq: r.last_seq === null || r.last_seq === undefined ? null : Number(r.last_seq),
        replyMessageId: r.reply_message_id || null,
        createdAt: toIso(r.created_at),
        decidedAt: toIso(r.decided_at),
    };
}

/** A short code, never free text: the only strings this store accepts in its code columns. */
const code = (v) => (typeof v === 'string' && /^[a-z0-9_]{1,64}$/.test(v) ? v : null);

/**
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {{ ready?: () => Promise<void>, newId?: () => string }} [opts]
 */
function makeProjectAiParticipationStore(db, { ready = async () => {}, newId = () => crypto.randomUUID() } = {}) {
    // ── Watches ────────────────────────────────────────────────────────────

    /**
     * Start or push back the pending watch of this kind for a container.
     *
     * A new pending row is due `delaySeconds` from now. An existing one takes
     * the new message, author and org ids and is pushed back to now +
     * `delaySeconds`, but never past `first_seen_at + maxDelaySeconds`, so a
     * chat that never goes quiet is still looked at.
     *
     * @param {{ projectId: string, surface: string, containerId: string, messageId: string,
     *           authorUserId: string, orgId?: string|null, limitOrgId?: string|null,
     *           kind: 'quiet'|'unanswered', delaySeconds: number, maxDelaySeconds?: number }} w
     */
    async function upsertWatch(w) {
        await ready();
        if (!SURFACES.includes(w.surface) || !WATCH_KINDS.includes(w.kind)) throw new Error('upsertWatch: unknown surface or kind');
        const delay = secs(w.delaySeconds);
        const ceiling = Math.max(delay, secs(w.maxDelaySeconds ?? delay));
        const r = await db.query(
            `INSERT INTO project_ai_watch
                (id, project_id, surface, container_id, message_id, author_user_id, org_id, limit_org_id, kind, due_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + $10::int * INTERVAL '1 second')
             ON CONFLICT (surface, container_id, kind) WHERE state = 'pending'
             DO UPDATE SET message_id = EXCLUDED.message_id,
                           author_user_id = EXCLUDED.author_user_id,
                           org_id = EXCLUDED.org_id,
                           limit_org_id = EXCLUDED.limit_org_id,
                           due_at = LEAST(EXCLUDED.due_at, project_ai_watch.first_seen_at + $11::int * INTERVAL '1 second'),
                           updated_at = NOW()
             RETURNING *`,
            [newId(), w.projectId, w.surface, w.containerId, w.messageId, w.authorUserId,
                w.orgId || null, w.limitOrgId || null, w.kind, delay, ceiling],
        );
        return rowToWatch(r.rows[0]);
    }

    /**
     * Push back a pending watch without changing its trigger: a message that
     * did not pass the rules still means people are talking.
     * @returns {Promise<boolean>} whether a pending watch was there
     */
    async function postponeWatch({ surface, containerId, kind = 'quiet', delaySeconds, maxDelaySeconds }) {
        await ready();
        const delay = secs(delaySeconds);
        const ceiling = Math.max(delay, secs(maxDelaySeconds ?? delay));
        const r = await db.query(
            `UPDATE project_ai_watch
                SET due_at = GREATEST(due_at, LEAST(NOW() + $4::int * INTERVAL '1 second',
                                                    first_seen_at + $5::int * INTERVAL '1 second')),
                    updated_at = NOW()
              WHERE surface = $1 AND container_id = $2 AND kind = $3 AND state = 'pending'`,
            [surface, containerId, kind, delay, ceiling],
        );
        return (r.rowCount || 0) > 0;
    }

    /** The pending watch of a kind, if any. */
    async function getPendingWatch(surface, containerId, kind) {
        await ready();
        const r = await db.query(
            `SELECT * FROM project_ai_watch WHERE surface = $1 AND container_id = $2 AND kind = $3 AND state = 'pending'`,
            [surface, containerId, kind],
        );
        return rowToWatch(r.rows[0] || null);
    }

    /**
     * Cancel pending watches of a container (all kinds, or one).
     * @returns {Promise<number>}
     */
    async function cancelPending(surface, containerId, kind = null) {
        await ready();
        const params = [surface, containerId];
        let only = '';
        if (kind) { params.push(kind); only = ' AND kind = $3'; }
        const r = await db.query(
            `UPDATE project_ai_watch SET state = 'cancelled', updated_at = NOW()
              WHERE surface = $1 AND container_id = $2 AND state = 'pending'${only}`,
            params,
        );
        return r.rowCount || 0;
    }

    /**
     * Claim up to `limit` due watches for this worker. Only the given
     * surfaces (the ones this process can serve), and never a container that
     * another worker is still handling.
     *
     * @param {number} limit
     * @param {{ surfaces?: string[], claimId?: string }} [opts]
     */
    async function claimDue(limit, { surfaces = [...SURFACES], claimId = newId() } = {}) {
        await ready();
        const n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 1)));
        const served = surfaces.filter((s) => SURFACES.includes(s));
        if (served.length === 0) return [];
        return db.tx(async (q) => {
            await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CLAIM_LOCK]);
            return claimInTurn(q, n, claimId, served);
        });
    }

    /** The claim itself, holding CLAIM_LOCK: nothing another replica claimed is invisible here. */
    async function claimInTurn(q, n, claimId, served) {
        const r = await q.query(
            `UPDATE project_ai_watch w
                SET state = 'claimed', claim_id = $2, claimed_at = NOW(), attempts = w.attempts + 1, updated_at = NOW()
              WHERE w.id IN (
                    SELECT d.id FROM project_ai_watch d
                     WHERE d.state = 'pending' AND d.due_at <= NOW() AND d.surface = ANY($3::text[])
                       AND NOT EXISTS (SELECT 1 FROM project_ai_watch c
                                        WHERE c.container_id = d.container_id AND c.state = 'claimed')
                     ORDER BY d.due_at ASC
                     LIMIT $1
                     FOR UPDATE SKIP LOCKED)
              RETURNING *`,
            [n, claimId, served],
        );
        // One per container, even if two kinds came due in the same instant.
        const seen = new Set();
        const out = [];
        for (const row of r.rows.map(rowToWatch).sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))) {
            if (seen.has(row.containerId)) {
                await q.query(`UPDATE project_ai_watch SET state = 'pending', claim_id = NULL, claimed_at = NULL, updated_at = NOW()
                                 WHERE id = $1 AND claim_id = $2`, [row.id, claimId]);
                continue;
            }
            seen.add(row.containerId);
            out.push(row);
        }
        return out;
    }

    /** Close a claimed watch. Only the claim that holds it can. */
    async function finishWatch(id, claimId, state = 'done') {
        await ready();
        const final = state === 'cancelled' ? 'cancelled' : 'done';
        const r = await db.query(
            `UPDATE project_ai_watch SET state = $3, updated_at = NOW()
              WHERE id = $1 AND claim_id = $2 AND state = 'claimed'`,
            [id, claimId, final],
        );
        return (r.rowCount || 0) > 0;
    }

    /**
     * Claims older than `minutes` belong to a worker that died: they are
     * cancelled, not retried (the next human message starts a new watch, and
     * a retry would answer an old conversation).
     */
    async function reapStuck(minutes = 5) {
        await ready();
        const r = await db.query(
            `UPDATE project_ai_watch SET state = 'cancelled', updated_at = NOW()
              WHERE state = 'claimed' AND claimed_at < NOW() - $1::int * INTERVAL '1 minute'`,
            [Math.max(1, Math.floor(Number(minutes) || 5))],
        );
        return r.rowCount || 0;
    }

    // ── Decisions ──────────────────────────────────────────────────────────

    function decisionParams(d) {
        return [
            d.projectId, d.orgId || null, d.surface, d.containerId, d.triggerMessageId || null,
            d.triggerKind, code(d.skipReason), code(d.reasonCode),
            Number.isFinite(d.confidence) ? Number(d.confidence) : null,
            typeof d.model === 'string' ? d.model.slice(0, 200) : null,
            d.replyMessageId || null,
        ];
    }

    /**
     * Log a decision that needed no gate call (a rule said no, an explicit
     * request was answered).
     *
     * @param {{ projectId: string, orgId?: string|null, surface: string, containerId: string,
     *           triggerMessageId?: string|null, triggerKind: string, decision: string,
     *           skipReason?: string|null, reasonCode?: string|null, confidence?: number|null,
     *           model?: string|null, replyMessageId?: string|null }} d
     */
    async function recordDecision(d) {
        await ready();
        if (!TRIGGER_KINDS.includes(d.triggerKind) || !DECISIONS.includes(d.decision)) throw new Error('recordDecision: unknown trigger kind or decision');
        const r = await db.query(
            `INSERT INTO project_ai_decisions
                (id, project_id, org_id, surface, container_id, trigger_message_id, trigger_kind,
                 skip_reason, reason_code, confidence, model, reply_message_id, decision, decided_at)
             VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $13, NOW())
             RETURNING *`,
            [...decisionParams(d), newId(), d.decision],
        );
        return rowToDecision(r.rows[0]);
    }

    /**
     * Reserve the one gate call for (container, last seq, trigger kind).
     * Returns the reservation, or null when this exact state was gated
     * already (a re-claimed watch, a second replica).
     */
    async function reserveGate(d) {
        await ready();
        if (!TRIGGER_KINDS.includes(d.triggerKind)) throw new Error('reserveGate: unknown trigger kind');
        const r = await db.query(
            `INSERT INTO project_ai_decisions
                (id, project_id, org_id, surface, container_id, trigger_message_id, trigger_kind,
                 decision, gate_called, last_seq)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', TRUE, $8)
             ON CONFLICT (surface, container_id, last_seq, trigger_kind) WHERE gate_called DO NOTHING
             RETURNING *`,
            [newId(), d.projectId, d.orgId || null, d.surface, d.containerId, d.triggerMessageId || null,
                d.triggerKind, Number.isFinite(d.lastSeq) ? d.lastSeq : 0],
        );
        return rowToDecision(r.rows[0] || null);
    }

    /** Fill in a reserved decision. */
    async function completeDecision(id, { decision, skipReason = null, reasonCode = null, confidence = null, model = null, replyMessageId = null }) {
        await ready();
        if (!DECISIONS.includes(decision) || decision === 'pending') throw new Error('completeDecision: unknown decision');
        const r = await db.query(
            `UPDATE project_ai_decisions
                SET decision = $2, skip_reason = $3, reason_code = $4, confidence = $5,
                    model = COALESCE($6, model), reply_message_id = $7, decided_at = NOW()
              WHERE id = $1
              RETURNING *`,
            [id, decision, code(skipReason), code(reasonCode), Number.isFinite(confidence) ? confidence : null,
                typeof model === 'string' ? model.slice(0, 200) : null, replyMessageId || null],
        );
        return rowToDecision(r.rows[0] || null);
    }

    /**
     * Everything the caps need, in one round trip:
     *   lastReplyAt       the last answer of ANY kind in the container (an
     *                     explicit answer restarts the automatic cooldown);
     *   autoInChatHour    automatic answers (and gates still in flight) in the
     *                     container, last hour;
     *   autoInProjectDay  the same over the project, last 24 hours;
     *   gatesInChatHour   gate calls in the container, last hour;
     *   gatesInOrgDay     gate calls in the organisation, last 24 hours.
     */
    async function capsFor({ surface, containerId, projectId, orgId = null }) {
        await ready();
        const r = await db.query(
            `SELECT
                (SELECT MAX(decided_at) FROM project_ai_decisions
                  WHERE surface = $1 AND container_id = $2 AND decision = 'replied') AS last_reply_at,
                (SELECT COUNT(*)::int FROM project_ai_decisions
                  WHERE surface = $1 AND container_id = $2 AND trigger_kind IN ('quiet', 'unanswered')
                    AND decision IN ('replied', 'pending') AND created_at > NOW() - INTERVAL '1 hour') AS auto_chat_hour,
                (SELECT COUNT(*)::int FROM project_ai_decisions
                  WHERE project_id = $3 AND trigger_kind IN ('quiet', 'unanswered')
                    AND decision IN ('replied', 'pending') AND created_at > NOW() - INTERVAL '24 hours') AS auto_project_day,
                (SELECT COUNT(*)::int FROM project_ai_decisions
                  WHERE surface = $1 AND container_id = $2 AND gate_called
                    AND created_at > NOW() - INTERVAL '1 hour') AS gates_chat_hour,
                (SELECT COUNT(*)::int FROM project_ai_decisions
                  WHERE $4::text IS NOT NULL AND org_id = $4 AND gate_called
                    AND created_at > NOW() - INTERVAL '24 hours') AS gates_org_day`,
            [surface, containerId, projectId, orgId || null],
        );
        const row = r.rows[0] || {};
        return {
            lastReplyAt: toIso(row.last_reply_at),
            autoInChatHour: toInt(row.auto_chat_hour),
            autoInProjectDay: toInt(row.auto_project_day),
            gatesInChatHour: toInt(row.gates_chat_hour),
            gatesInOrgDay: toInt(row.gates_org_day),
        };
    }

    /** The latest decisions of a container, newest first (for tests and support). */
    async function listDecisions(containerId, { limit = 50 } = {}) {
        await ready();
        const r = await db.query(
            'SELECT * FROM project_ai_decisions WHERE container_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
            [containerId, Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)))],
        );
        return r.rows.map(rowToDecision);
    }

    /**
     * Counts per decision for a project over a window: what a compliance view
     * may show about automatic participation, without any content.
     */
    async function summarizeProject(projectId, { days = 30 } = {}) {
        await ready();
        const r = await db.query(
            `SELECT decision, trigger_kind, COUNT(*)::int AS n FROM project_ai_decisions
              WHERE project_id = $1 AND created_at > NOW() - $2::int * INTERVAL '1 day'
              GROUP BY decision, trigger_kind`,
            [projectId, Math.max(1, Math.min(365, Math.floor(Number(days) || 30)))],
        );
        return r.rows.map((row) => ({ decision: row.decision, triggerKind: row.trigger_kind, count: toInt(row.n) }));
    }

    // ── Feedback ───────────────────────────────────────────────────────────

    /**
     * Record one person's feedback on one answer (idempotent per person and
     * answer; a second click changes nothing) and return how many "not
     * helpful" the container collected in the back-off window.
     *
     * @param {{ messageId: string, userId: string, projectId: string, surface: string,
     *           containerId: string, helpful: boolean }} f
     */
    async function recordFeedback(f) {
        await ready();
        return db.tx(async (q) => {
            const inserted = await q.query(
                `INSERT INTO project_ai_feedback (message_id, user_id, project_id, surface, container_id, helpful)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (message_id, user_id) DO UPDATE SET helpful = EXCLUDED.helpful
                 RETURNING (xmax = 0) AS created`,
                [f.messageId, f.userId, f.projectId, f.surface, f.containerId, !!f.helpful],
            );
            const count = await q.query(
                `SELECT COUNT(*)::int AS n FROM project_ai_feedback
                  WHERE surface = $1 AND container_id = $2 AND helpful = FALSE
                    AND created_at > NOW() - $3::int * INTERVAL '1 hour'`,
                [f.surface, f.containerId, FEEDBACK_WINDOW_HOURS],
            );
            return { created: !!inserted.rows[0]?.created, notHelpfulRecently: toInt(count.rows[0]?.n) };
        });
    }

    /** The caller's own feedback on some messages: Map<messageId, helpful>. */
    async function feedbackFor(userId, messageIds) {
        await ready();
        const ids = (messageIds || []).filter((x) => typeof x === 'string' && x);
        if (!userId || ids.length === 0) return new Map();
        const r = await db.query(
            'SELECT message_id, helpful FROM project_ai_feedback WHERE user_id = $1 AND message_id = ANY($2::text[])',
            [userId, ids],
        );
        return new Map(r.rows.map((row) => [row.message_id, !!row.helpful]));
    }

    // ── Housekeeping and the data subject ─────────────────────────────────

    /** Drop old decisions, finished watches and old feedback. */
    async function prune({ decisionDays = DECISION_RETENTION_DAYS, watchDays = WATCH_RETENTION_DAYS, feedbackDays = DECISION_RETENTION_DAYS } = {}) {
        await ready();
        const d = await db.query(`DELETE FROM project_ai_decisions WHERE created_at < NOW() - $1::int * INTERVAL '1 day'`, [decisionDays]);
        const w = await db.query(
            `DELETE FROM project_ai_watch WHERE state IN ('done', 'cancelled') AND updated_at < NOW() - $1::int * INTERVAL '1 day'`,
            [watchDays],
        );
        const f = await db.query(`DELETE FROM project_ai_feedback WHERE created_at < NOW() - $1::int * INTERVAL '1 day'`, [feedbackDays]);
        return { decisions: d.rowCount || 0, watches: w.rowCount || 0, feedback: f.rowCount || 0 };
    }

    /**
     * Erase what ties a deleted account to this bookkeeping: its feedback and
     * the watches it started. Decisions hold no person.
     */
    async function eraseUser(userId) {
        await ready();
        if (!userId) return { feedback: 0, watches: 0 };
        const f = await db.query('DELETE FROM project_ai_feedback WHERE user_id = $1', [userId]);
        const w = await db.query('DELETE FROM project_ai_watch WHERE author_user_id = $1', [userId]);
        return { feedback: f.rowCount || 0, watches: w.rowCount || 0 };
    }

    return {
        upsertWatch,
        postponeWatch,
        getPendingWatch,
        cancelPending,
        claimDue,
        finishWatch,
        reapStuck,
        recordDecision,
        reserveGate,
        completeDecision,
        capsFor,
        listDecisions,
        summarizeProject,
        recordFeedback,
        feedbackFor,
        prune,
        eraseUser,
    };
}

const initDB = makeStoreInit('ProjectAiParticipationStore', _initDB);

async function _initDB() {
    // Boot starts every init at once: the FK target first, not assumed.
    await require('./projectStore').initDB();
    await exec(DDL);
    log.info('[ProjectAiParticipationStore] PostgreSQL initialized');
}

const defaultStore = makeProjectAiParticipationStore({
    query: (sql, params) => pool.query(sql, params),
    tx: (fn) => withTransaction((client) => fn({ query: (sql, params) => client.query(sql, params) })),
}, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    SURFACES,
    WATCH_KINDS,
    TRIGGER_KINDS,
    DECISIONS,
    DECISION_RETENTION_DAYS,
    FEEDBACK_WINDOW_HOURS,
    CLAIM_LOCK,
    makeProjectAiParticipationStore,
    rowToWatch,
    rowToDecision,
    ...defaultStore,
};
