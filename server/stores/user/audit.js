// @typecheck
// Audit logging — subscription + access-control audit trails and the one-shot
// notification claim ledger.

const crypto = require('crypto');
const { run, getAll } = require('../../db');
const { initDB } = require('./schema');
const { parseJSON } = require('./shared');
const log = require('../../telemetry/log');

// ── Audit Logging ─────────────────────────────
async function logSubscriptionAudit(action, targetType, targetId, changedBy, oldValues, newValues) {
    try {
        await initDB();
        const id = crypto.randomUUID();
        await run(`INSERT INTO subscription_audit_log (id, action, target_type, target_id, changed_by, old_values, new_values) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, action, targetType, targetId, changedBy || 'system',
                oldValues ? JSON.stringify(oldValues) : null,
                newValues ? JSON.stringify(newValues) : null]);
    } catch (e) { log.error('[UserStore] Audit log error:', e.message); }
}

// Try to claim a one-shot notification slot. Returns true if this caller
// is the one that gets to send (row inserted); false if the (target,
// kind) tuple has already been claimed. The ON CONFLICT DO NOTHING +
// rowCount check is the atomic primitive — no race between webhook
// retries.
async function claimNotification(targetType, targetId, kind, recipient = null, payload = null) {
    try {
        await initDB();
        const id = crypto.randomUUID();
        const result = await run(
            `INSERT INTO notifications_sent (id, target_type, target_id, kind, recipient, payload)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (target_type, target_id, kind) DO NOTHING`,
            [id, targetType, targetId, kind, recipient, payload ? JSON.stringify(payload) : null]
        );
        return (result?.rowCount ?? 0) > 0;
    } catch (e) {
        log.error('[UserStore] claimNotification error:', e.message);
        return false;
    }
}

// Access-control audit logger. Best-effort: writes a row to the access
// audit table and never throws on failure (logging must not break the
// caller's mutation). Pass the organization_id when known so org-scoped
// queries can find the row; pass null for global super-admin events.
async function logAccessAudit(action, targetType, targetId, changedBy, oldValues, newValues, organizationId = null) {
    try {
        await initDB();
        const id = crypto.randomUUID();
        await run(
            `INSERT INTO access_audit_log (id, action, target_type, target_id, organization_id, changed_by, old_values, new_values)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
                id,
                action,
                targetType,
                targetId,
                organizationId,
                changedBy || 'system',
                oldValues ? JSON.stringify(oldValues) : null,
                newValues ? JSON.stringify(newValues) : null,
            ]
        );
    } catch (e) { log.error('[UserStore] Access audit log error:', e.message); }
}

/**
 * Build the WHERE clause for an access-audit query.
 *
 * Split out so the list and the count cannot drift: a count computed under
 * looser conditions than the rows it counts turns "42 sign-ins this month" into
 * a number nobody can reproduce, which is worse in an audit view than no
 * number at all.
 *
 * ORG SCOPING IS THE ONE THAT MATTERS. `organizationId` narrows to one
 * organisation; `globalOnly` selects the rows that belong to no organisation
 * (platform-level events). Passing neither returns EVERYTHING, which is right
 * for a super admin and would be a cross-tenant leak for anyone else — so the
 * decision of which to pass is made at the route, never defaulted here.
 */
function accessAuditWhere(opts = {}) {
    const { targetType, targetId, organizationId, globalOnly, actions, changedBy, since, until } = opts;
    const params = [];
    const conditions = [];
    let idx = 1;
    if (targetType) { conditions.push(`target_type = $${idx++}`); params.push(targetType); }
    if (targetId) { conditions.push(`target_id = $${idx++}`); params.push(targetId); }
    if (organizationId) { conditions.push(`organization_id = $${idx++}`); params.push(organizationId); }
    else if (globalOnly) { conditions.push('organization_id IS NULL'); }
    if (Array.isArray(actions) && actions.length > 0) {
        conditions.push(`action = ANY($${idx++})`);
        params.push(actions.map(String));
    }
    if (changedBy) { conditions.push(`changed_by = $${idx++}`); params.push(changedBy); }
    if (since) { conditions.push(`created_at >= $${idx++}`); params.push(since); }
    if (until) { conditions.push(`created_at <= $${idx++}`); params.push(until); }
    return { where: conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '', params, nextIdx: idx };
}

async function getAccessAuditLog(opts = {}) {
    await initDB();
    const { limit = 50, offset = 0 } = opts;
    const { where, params, nextIdx } = accessAuditWhere(opts);
    const sql = `SELECT * FROM access_audit_log${where} ORDER BY created_at DESC LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`;
    const rows = await getAll(sql, [...params, limit, offset]);
    return rows.map(r => ({ ...r, old_values: parseJSON(r.old_values, null), new_values: parseJSON(r.new_values, null) }));
}

/** How many rows the same filter matches — for paging, and for "N events" counts. */
async function countAccessAuditLog(opts = {}) {
    await initDB();
    const { where, params } = accessAuditWhere(opts);
    const rows = await getAll(`SELECT COUNT(*)::int AS c FROM access_audit_log${where}`, params);
    return rows?.[0]?.c ?? 0;
}

/**
 * The distinct actions present under a filter, newest occurrence first.
 *
 * The UI's filter list is built from what the log CONTAINS rather than from a
 * hardcoded vocabulary, so an action added by a later feature appears in the
 * filter without anyone remembering to list it — and an action that has never
 * happened here does not offer an empty filter.
 */
async function listAccessAuditActions(opts = {}) {
    await initDB();
    const { where, params } = accessAuditWhere(opts);
    const rows = await getAll(
        `SELECT action, COUNT(*)::int AS count, MAX(created_at) AS last_at
           FROM access_audit_log${where}
          GROUP BY action ORDER BY MAX(created_at) DESC`,
        params,
    );
    return rows || [];
}

async function getAuditLog(opts = {}) {
    await initDB();
    const { targetType, targetId, limit = 50, offset = 0 } = opts;
    let sql = 'SELECT * FROM subscription_audit_log';
    const params = [];
    const conditions = [];
    let idx = 1;
    if (targetType) { conditions.push(`target_type = $${idx++}`); params.push(targetType); }
    if (targetId) { conditions.push(`target_id = $${idx++}`); params.push(targetId); }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    const rows = await getAll(sql, params);
    return rows.map(r => ({ ...r, old_values: parseJSON(r.old_values, null), new_values: parseJSON(r.new_values, null) }));
}

// `license_issuance_failed` rows for which the same (target_type, target_id)
// pair has NO later `license_issuance_succeeded` row. Drives the admin
// sidebar badge and the audit-view Retry button. Bounded by `limit` for the
// list view; counters get the row count back from the same query.
async function getUnresolvedLicenseIssuanceFailures(limit = 50) {
    await initDB();
    const rows = await getAll(
        `SELECT f.* FROM subscription_audit_log f
          WHERE f.action = 'license_issuance_failed'
            AND NOT EXISTS (
              SELECT 1 FROM subscription_audit_log s
               WHERE s.action = 'license_issuance_succeeded'
                 AND s.target_type = f.target_type
                 AND s.target_id = f.target_id
                 AND s.created_at > f.created_at
            )
          ORDER BY f.created_at DESC
          LIMIT $1`,
        [Math.max(1, Number(limit) || 50)]
    );
    return rows.map(r => ({ ...r, old_values: parseJSON(r.old_values, null), new_values: parseJSON(r.new_values, null) }));
}

module.exports = {
    logSubscriptionAudit, getAuditLog, getUnresolvedLicenseIssuanceFailures,
    logAccessAudit, getAccessAuditLog, countAccessAuditLog, listAccessAuditActions,
    claimNotification,
};
