/**
 * audit.mts: the access-audit rows of the KB query log, written so a failure is a failure.
 *
 * userStore.logAccessAudit swallows a failed write, so a caller cannot tell a recorded read from
 * an unrecorded one. Here the write THROWS: the routes record first and only then change or reveal
 * anything (the pattern of stores/adoption/audit.js). Same table, same columns, so the access-audit
 * page shows these rows next to the others.
 *
 * Payloads are explicit allow-lists made by the caller: ids, counts, settings. Never a query,
 * an answer, a name or an e-mail address.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);

export const AUDIT_ACTIONS = [
    'kb.query_log.enabled', 'kb.query_log.disabled', 'kb.query_log.retention_changed', 'kb.query_log.purged',
    'kb.query_log.exported', 'kb.query_log.content_viewed', 'kb.query_log.subject_exported', 'kb.query_log.subject_deleted',
] as const;
export type AuditAction = typeof AUDIT_ACTIONS[number];

export interface AuditEntry {
    action: AuditAction;
    /** 'knowledge_base', 'user' (a data subject) or 'organization' (an org-wide export). */
    targetType: 'knowledge_base' | 'user' | 'organization';
    targetId: string;
    orgId: string | null;
    actorId: string;
    oldValues?: Record<string, unknown> | null;
    newValues?: Record<string, unknown> | null;
}

export interface AuditDb { query: (sql: string, params?: unknown[]) => Promise<unknown> }

export async function recordKbQueryLogAudit(entry: AuditEntry, db?: AuditDb): Promise<void> {
    const handle = db ?? nodeRequire('../../../db.js').pool;
    await handle.query(
        `INSERT INTO access_audit_log (id, action, target_type, target_id, organization_id, changed_by, old_values, new_values)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), entry.action, entry.targetType, entry.targetId, entry.orgId, entry.actorId,
            entry.oldValues ? JSON.stringify(entry.oldValues) : null, entry.newValues ? JSON.stringify(entry.newValues) : null],
    );
}
