// @typecheck
/**
 * Threads — the support_threads row itself: creating one, finding it (by id,
 * by ticket reference, or by the email-threading hints an inbound sync has),
 * listing and filtering the inbox, patching it, counting it per status, and
 * purging what a disconnected mailbox left behind.
 */

const { pool } = require('../../db');
const { initDB } = require('./schema');
const { buildUpdate } = require('../lib/sqlBuilder');
const log = require('../../telemetry/log');

// ── CRUD ──────────────────────────────────────────────────────────────────

async function createThread({
    organizationId = null,
    requesterUserId = null,
    requesterEmail,
    requesterName = null,
    requesterOrgRole = null,
    requesterOrgName = null,
    source,
    subject,
    priority = 'normal',
    requesterIp = null,
    requesterUa = null,
    // iteration 5: tenant Support inbox (email-sourced) threading
    inboxId = null,
    rfc822MessageId = null,
    providerThreadId = null,
}) {
    await initDB();
    if (!requesterEmail) throw new Error('requesterEmail is required');
    if (!subject) throw new Error('subject is required');
    if (!['in_app', 'marketing', 'email'].includes(source)) throw new Error('invalid source');

    const { rows } = await pool.query(
        `INSERT INTO support_threads
            (organization_id, requester_user_id, requester_email, requester_name,
             requester_org_role, requester_org_name,
             source, subject, priority, requester_ip, requester_ua,
             inbox_id, rfc822_message_id, provider_thread_id, status, last_message_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open',now())
         RETURNING *`,
        [organizationId, requesterUserId, requesterEmail, requesterName,
            requesterOrgRole, requesterOrgName,
            source, subject, priority, requesterIp, requesterUa,
            inboxId, rfc822MessageId, providerThreadId]
    );
    const row = rows[0];
    log.info(`[SupportStore] Thread created ${row.id} (${source}${inboxId ? `, inbox ${inboxId}` : ''}) for ${requesterEmail}`);
    return row;
}

/**
 * Find a thread in an inbox whose provider thread id (Gmail threadId / Graph
 * conversationId) matches — the cheap second-tier threading hint.
 */
async function findThreadByProviderThread(inboxId, providerThreadId) {
    await initDB();
    if (!inboxId || !providerThreadId) return null;
    const { rows } = await pool.query(
        `SELECT * FROM support_threads WHERE inbox_id = $1 AND provider_thread_id = $2 LIMIT 1`,
        [inboxId, providerThreadId]
    );
    return rows[0] || null;
}

/**
 * Find a thread by correlating an inbound In-Reply-To / References id against a
 * message (or thread) we previously stored in this inbox — the primary,
 * RFC-correct threading path.
 */
async function findThreadByRfcMessageId(inboxId, rfc822MessageIds = []) {
    await initDB();
    const ids = (Array.isArray(rfc822MessageIds) ? rfc822MessageIds : [rfc822MessageIds])
        .map(x => String(x || '').trim()).filter(Boolean);
    if (!inboxId || !ids.length) return null;
    const { rows } = await pool.query(
        `SELECT t.* FROM support_threads t
          JOIN support_messages m ON m.thread_id = t.id
         WHERE t.inbox_id = $1 AND m.rfc822_message_id = ANY($2::text[])
         ORDER BY m.created_at DESC LIMIT 1`,
        [inboxId, ids]
    );
    if (rows[0]) return rows[0];
    // Also try the thread's own first-message id.
    const { rows: t2 } = await pool.query(
        `SELECT * FROM support_threads
          WHERE inbox_id = $1 AND rfc822_message_id = ANY($2::text[]) LIMIT 1`,
        [inboxId, ids]
    );
    return t2[0] || null;
}

async function getThread(id) {
    await initDB();
    const { rows } = await pool.query(`SELECT * FROM support_threads WHERE id = $1`, [id]);
    return rows[0] || null;
}

async function listThreads({
    status = null,
    statusIn = null,
    organizationId = null,
    requesterUserId = null,
    assigneeUserId = null,
    requesterEmail = null,
    q = null,
    limit = 100,
    offset = 0,
    // iteration 5: tenant Support inbox scoping. inboxId → a single inbox;
    // inboxIdIn → any of several inboxes (org "all inboxes" view); inboxIsNull
    // true → Bee Flow's own company inbox only (admin), false → tenant inboxes only.
    inboxId = null,
    inboxIdIn = null,
    inboxIsNull = null,
    // Tag filters (used by the non-support routing): tagsIn → only threads
    // carrying any of these tags; excludeTags → drop threads carrying any.
    tagsIn = null,
    excludeTags = null,
    // iteration 7: only tickets a linked issue moved under, that nobody has
    // followed up on yet. Backs the inbox's Follow-up filter.
    followupOnly = false,
} = {}) {
    await initDB();
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (statusIn && statusIn.length) {
        params.push(statusIn);
        where.push(`status = ANY($${params.length}::text[])`);
    }
    if (organizationId) { params.push(organizationId); where.push(`organization_id = $${params.length}`); }
    if (inboxId) { params.push(inboxId); where.push(`inbox_id = $${params.length}`); }
    if (inboxIdIn && inboxIdIn.length) {
        params.push(inboxIdIn);
        where.push(`inbox_id = ANY($${params.length}::uuid[])`);
    }
    if (followupOnly) { where.push(`followup_needed_at IS NOT NULL AND status NOT IN ('resolved','closed')`); }
    if (inboxIsNull === true) { where.push(`inbox_id IS NULL`); }
    else if (inboxIsNull === false) { where.push(`inbox_id IS NOT NULL`); }
    if (requesterUserId) { params.push(requesterUserId); where.push(`requester_user_id = $${params.length}`); }
    if (assigneeUserId) { params.push(assigneeUserId); where.push(`assignee_user_id = $${params.length}`); }
    if (requesterEmail) { params.push(requesterEmail.toLowerCase()); where.push(`LOWER(requester_email) = $${params.length}`); }
    if (q) {
        params.push(`%${q}%`);
        where.push(`(subject ILIKE $${params.length} OR requester_email ILIKE $${params.length} OR requester_name ILIKE $${params.length})`);
    }
    if (tagsIn && tagsIn.length) {
        params.push(tagsIn);
        where.push(`jsonb_exists_any(tags, $${params.length}::text[])`);
    }
    if (excludeTags && excludeTags.length) {
        params.push(excludeTags);
        where.push(`(tags IS NULL OR NOT jsonb_exists_any(tags, $${params.length}::text[]))`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
    params.push(Math.max(parseInt(offset, 10) || 0, 0));
    const { rows } = await pool.query(
        `SELECT * FROM support_threads ${whereClause}
         ORDER BY last_message_at DESC NULLS LAST
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
}

/**
 * The writable columns of a ticket. The patch already speaks column names, so
 * the map is an identity — but it is still a map, not a list of allowed keys
 * echoed into the SQL: the column literal must come from here and never from
 * whatever the caller happened to name its field.
 */
const THREAD_COLUMNS = Object.freeze({
    status: 'status',
    priority: 'priority',
    assignee_user_id: 'assignee_user_id',
    ai_handled: 'ai_handled',
    ai_escalated_reason: 'ai_escalated_reason',
    first_response_at: 'first_response_at',
    resolved_at: 'resolved_at',
    last_message_at: 'last_message_at',
    subject: 'subject',
    category: 'category',
    auto_assigned: 'auto_assigned',
    sla_paused: 'sla_paused',
    sla_first_response_due_at: 'sla_first_response_due_at',
    sla_resolution_due_at: 'sla_resolution_due_at',
    sla_first_response_breached_at: 'sla_first_response_breached_at',
    sla_resolution_breached_at: 'sla_resolution_breached_at',
    resolution_confirmed_at: 'resolution_confirmed_at',
    resolution_disputed_at: 'resolution_disputed_at',
});

/**
 * @param {string} id
 * @param {Record<string, any>} [patch] column -> value; see the whitelist above
 */
async function updateThread(id, patch = {}) {
    await initDB();
    const effective = { ...patch };
    // The SLA clock pauses while waiting on the customer. Derive it from the
    // status transition unless the caller set sla_paused explicitly.
    if (effective.status !== undefined && effective.sla_paused === undefined) {
        effective.sla_paused = effective.status === 'awaiting_user';
    }
    const built = buildUpdate({
        table: 'support_threads',
        updates: effective,
        columnMap: THREAD_COLUMNS,
        extraSet: ['updated_at = now()'],
        where: [{ col: 'id', value: id }],
        returning: '*',
    });
    if (!built) return getThread(id);
    const { rows } = await pool.query(built.sql, built.params);
    return rows[0] || null;
}

/**
 * Hard-delete the tickets that came in over a mailbox. `support_messages` and
 * `support_thread_events` disappear with them (ON DELETE CASCADE);
 * `support_audit_log` deliberately survives — it is append-only, carries no FK,
 * and is the only remaining record that the mailbox was ever connected.
 *
 * Two shapes, both narrow on purpose — disconnecting a mailbox is the only
 * caller:
 *   { inboxId }              — every ticket belonging to that Support-studio inbox
 *   { companyMailbox: true } — mailbox-sourced tickets stranded in Bee Flow's own
 *                              company inbox (source 'email' + inbox_id IS NULL).
 *                              Those can only be residue of a mailbox that was
 *                              removed before deleteInbox purged its threads.
 * Returns the number of threads removed.
 */
async function deleteMailboxThreads({ inboxId = null, companyMailbox = false } = {}) {
    await initDB();
    if (inboxId) {
        const { rowCount } = await pool.query(`DELETE FROM support_threads WHERE inbox_id = $1`, [inboxId]);
        return rowCount;
    }
    if (companyMailbox) {
        const { rowCount } = await pool.query(
            `DELETE FROM support_threads WHERE inbox_id IS NULL AND source = 'email'`
        );
        return rowCount;
    }
    // No selector → refuse rather than empty the table.
    throw new Error('deleteMailboxThreads requires inboxId or companyMailbox');
}

/**
 * What a mailbox left behind in the company inbox: how many tickets and the
 * window they span. Drives the "a mailbox is feeding this inbox" banner in the
 * admin Customer Support panel.
 */
async function getCompanyMailboxSummary() {
    await initDB();
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int AS active_count,
                MIN(created_at) AS first_at,
                MAX(last_message_at) AS last_at
           FROM support_threads
          WHERE inbox_id IS NULL AND source = 'email'`
    );
    const r = rows[0] || {};
    return {
        count: r.count || 0,
        activeCount: r.active_count || 0,
        firstAt: r.first_at || null,
        lastAt: r.last_at || null,
    };
}

async function countThreadsByStatus({ organizationId = null, inboxId = null, inboxIdIn = null, inboxIsNull = null, tagsIn = null, excludeTags = null } = {}) {
    await initDB();
    const params = [];
    const clauses = [];
    if (organizationId) { params.push(organizationId); clauses.push(`organization_id = $${params.length}`); }
    if (inboxId) { params.push(inboxId); clauses.push(`inbox_id = $${params.length}`); }
    if (inboxIdIn && inboxIdIn.length) { params.push(inboxIdIn); clauses.push(`inbox_id = ANY($${params.length}::uuid[])`); }
    if (inboxIsNull === true) { clauses.push(`inbox_id IS NULL`); }
    else if (inboxIsNull === false) { clauses.push(`inbox_id IS NOT NULL`); }
    if (tagsIn && tagsIn.length) { params.push(tagsIn); clauses.push(`jsonb_exists_any(tags, $${params.length}::text[])`); }
    if (excludeTags && excludeTags.length) { params.push(excludeTags); clauses.push(`(tags IS NULL OR NOT jsonb_exists_any(tags, $${params.length}::text[]))`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(
        `SELECT status, COUNT(*)::int AS count FROM support_threads ${where} GROUP BY status`,
        params
    );
    const out = {};
    for (const r of rows) out[r.status] = r.count;
    return out;
}

/**
 * Atomically transition a thread to "first staff reply" state. Sets
 * `first_response_at` only if it was NULL, picks the calling staff as
 * assignee if none assigned yet, and flips status → `awaiting_user`.
 *
 * Race-safe: if two staff replies arrive concurrently, the database guarantees
 * exactly one timestamp/assignee wins. Returns the updated row.
 */
async function firstStaffReplyTransition(threadId, staffUserId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET first_response_at = COALESCE(first_response_at, now()),
                assignee_user_id = COALESCE(assignee_user_id, $2),
                status = 'awaiting_user',
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [threadId, staffUserId || null]
    );
    return rows[0] || null;
}

/** Look a thread up by its human reference ('BF-2451'), case-insensitively. */
async function getThreadByRef(ticketRef) {
    await initDB();
    if (!ticketRef) return null;
    const { rows } = await pool.query(
        `SELECT * FROM support_threads WHERE upper(ticket_ref) = upper($1) LIMIT 1`,
        [String(ticketRef).trim()]
    );
    return rows[0] || null;
}

module.exports = {
    createThread,
    findThreadByProviderThread,
    findThreadByRfcMessageId,
    getThread,
    listThreads,
    updateThread,
    deleteMailboxThreads,
    getCompanyMailboxSummary,
    countThreadsByStatus,
    firstStaffReplyTransition,
    getThreadByRef,
};
