// @typecheck
/**
 * Audit — who did what. Two logs on purpose: the legacy per-thread
 * support_thread_events (three actor kinds) and the unified support_audit_log
 * (five, and it can carry inbox/config events with no thread at all).
 * recordThreadEvent dual-writes to both; recordAuditEvent is the direct way in.
 */

const { pool } = require('../../db');
const { initDB } = require('./schema');
const log = require('../../telemetry/log');

// Precise actor kinds for the unified audit log. The legacy
// support_thread_events CHECK only permits the first three; 'ai'/'automation'
// collapse to 'system' there but are preserved exactly in support_audit_log.
const AUDIT_ACTOR_KINDS = ['system', 'automation', 'ai', 'staff', 'requester'];
const LEGACY_ACTOR_KINDS = new Set(['staff', 'system', 'requester']);

/**
 * Append an audit-log event for a thread. Append-only, used by route handlers
 * and the AI responder. Failures here must never break the caller — wrap.
 *
 * Dual-writes: the legacy support_thread_events row (actor_kind collapsed to the
 * three legacy kinds, so the company inbox + per-thread timeline keep working
 * unchanged) AND the unified support_audit_log row carrying the PRECISE kind
 * (incl. 'ai'/'automation'). org/inbox are derived from the thread when not
 * supplied. The unified write is best-effort — never breaks the legacy write.
 */
async function recordThreadEvent({ threadId, actorUserId = null, actorKind, action, payload = {}, organizationId, inboxId, ip = null, ua = null }) {
    await initDB();
    if (!threadId || !actorKind || !action) return null;
    if (!AUDIT_ACTOR_KINDS.includes(actorKind)) {
        throw new Error('invalid actorKind');
    }
    const legacyKind = LEGACY_ACTOR_KINDS.has(actorKind) ? actorKind : 'system';
    const { rows } = await pool.query(
        `INSERT INTO support_thread_events (thread_id, actor_user_id, actor_kind, action, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING *`,
        [threadId, actorUserId, legacyKind, action, JSON.stringify(payload || {})]
    );
    try {
        let org = organizationId; let inbox = inboxId;
        if (org === undefined || inbox === undefined) {
            const { rows: tr } = await pool.query(
                `SELECT organization_id, inbox_id FROM support_threads WHERE id = $1`, [threadId]
            );
            if (tr[0]) {
                if (org === undefined) org = tr[0].organization_id;
                if (inbox === undefined) inbox = tr[0].inbox_id;
            }
        }
        await recordAuditEvent({
            organizationId: org ?? null, inboxId: inbox ?? null, threadId,
            actorKind, actorUserId, action, payload, ip, ua,
        });
    } catch (e) {
        log.warn('[SupportStore] audit dual-write failed:', e.message);
    }
    return rows[0];
}

async function listThreadEvents(threadId, { limit = 200 } = {}) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_thread_events WHERE thread_id = $1 ORDER BY created_at ASC LIMIT $2`,
        [threadId, Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000)]
    );
    return rows;
}

/**
 * Append an event to the unified support audit log. Called directly by services
 * (sync engine, AI responder, mailer, classifier) and indirectly via
 * recordThreadEvent's dual-write. Any of organizationId / inboxId / threadId may
 * be null — config-level events have no thread. Returns null on missing
 * actorKind/action so a partial call never throws into a fire-and-forget caller.
 * @param {{ organizationId?: string|null, inboxId?: string|null, threadId?: string|null, actorKind?: string, actorUserId?: string|null, action?: string, payload?: object, ip?: string|null, ua?: string|null }} [opts]
 */
async function recordAuditEvent({ organizationId = null, inboxId = null, threadId = null, actorKind, actorUserId = null, action, payload = {}, ip = null, ua = null } = {}) {
    await initDB();
    if (!actorKind || !action) return null;
    if (!AUDIT_ACTOR_KINDS.includes(actorKind)) throw new Error('invalid actorKind');
    const { rows } = await pool.query(
        `INSERT INTO support_audit_log
            (organization_id, inbox_id, thread_id, actor_kind, actor_user_id, action, payload, ip, ua)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
         RETURNING *`,
        [organizationId, inboxId, threadId, actorKind, actorUserId, action, JSON.stringify(payload || {}), ip, ua]
    );
    return rows[0];
}

function _decodeAuditCursor(cursor) {
    if (!cursor) return null;
    try {
        const obj = JSON.parse(Buffer.from(String(cursor), 'base64').toString('utf8'));
        if (obj && obj.t && obj.id) return obj;
    } catch { /* ignore malformed cursor */ }
    return null;
}
function _encodeAuditCursor(row) {
    const t = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
    return Buffer.from(JSON.stringify({ t, id: row.id })).toString('base64');
}

/**
 * List unified audit events newest-first with keyset pagination on
 * (created_at, id). Filters: organizationId / organizationIdIn, inboxId /
 * inboxIdIn (array also matches config events with inbox_id IS NULL), threadId,
 * actorKind, action, since, until. Returns { events, nextCursor }.
 * @param {{ organizationId?: string, organizationIdIn?: string[], inboxId?: string, inboxIdIn?: string[], threadId?: string, actorKind?: string, action?: string, since?: string|Date, until?: string|Date, limit?: number, cursor?: string }} [opts]
 */
async function listAuditEvents({ organizationId, organizationIdIn, inboxId, inboxIdIn, threadId, actorKind, action, since, until, limit = 50, cursor } = {}) {
    await initDB();
    const where = [];
    const vals = [];
    const add = (sql, val) => { vals.push(val); where.push(sql.replace('$$', `$${vals.length}`)); };
    if (organizationId !== undefined && organizationId !== null) add('organization_id = $$', organizationId);
    if (Array.isArray(organizationIdIn)) {
        if (organizationIdIn.length === 0) return { events: [], nextCursor: null };
        add('organization_id = ANY($$)', organizationIdIn);
    }
    if (inboxId !== undefined && inboxId !== null) add('inbox_id = $$', inboxId);
    if (Array.isArray(inboxIdIn)) {
        if (inboxIdIn.length === 0) {
            where.push('inbox_id IS NULL');
        } else {
            vals.push(inboxIdIn);
            where.push(`(inbox_id = ANY($${vals.length}) OR inbox_id IS NULL)`);
        }
    }
    if (threadId) add('thread_id = $$', threadId);
    if (actorKind) add('actor_kind = $$', actorKind);
    if (action) add('action = $$', action);
    if (since) add('created_at >= $$', since);
    if (until) add('created_at <= $$', until);
    const cur = _decodeAuditCursor(cursor);
    if (cur) {
        vals.push(cur.t); vals.push(cur.id);
        where.push(`(created_at, id) < ($${vals.length - 1}::timestamptz, $${vals.length}::uuid)`);
    }
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    vals.push(lim + 1);
    const sql = `SELECT * FROM support_audit_log
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC, id DESC
                 LIMIT $${vals.length}`;
    const { rows } = await pool.query(sql, vals);
    let nextCursor = null;
    if (rows.length > lim) {
        nextCursor = _encodeAuditCursor(rows[lim - 1]);
        rows.length = lim;
    }
    return { events: rows, nextCursor };
}

module.exports = {
    AUDIT_ACTOR_KINDS,
    recordThreadEvent,
    listThreadEvents,
    recordAuditEvent,
    listAuditEvents,
};
