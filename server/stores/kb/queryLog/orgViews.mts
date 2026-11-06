/**
 * orgViews.mts: the organisation-wide reads of the compliance view of the KB query log
 * (which bases of an organisation exist, which people it has). Metadata only, pinned to one organisation.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const pool = (): { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> } => nodeRequire('../../../db.js').pool;

export interface OrgKbRow {
    id: string; name: string; tenant_id: string; query_log_enabled: boolean; query_log_retention_days: number;
    query_log_changed_at: string | null; query_log_changed_by: string | null;
}

/** Every knowledge base of the organisation with its query-log settings. */
export async function listOrgKbs(orgId: string): Promise<OrgKbRow[]> {
    const { rows } = await pool().query(
        `SELECT id, name, tenant_id, query_log_enabled, query_log_retention_days, query_log_changed_at, query_log_changed_by
         FROM knowledge_bases WHERE organization_id = $1 ORDER BY name`, [orgId]);
    return rows;
}

/** Base id to name, for one organisation. */
export async function orgKbNames(orgId: string): Promise<Map<string, string>> {
    const { rows } = await pool().query('SELECT id, name FROM knowledge_bases WHERE organization_id = $1', [orgId]);
    return new Map(rows.map((r) => [String(r.id), String(r.name)]));
}

/** The people of the organisation, up to `cap`: the candidates for "may manage knowledge". */
export async function orgPeople(orgId: string, cap: number): Promise<Array<{ id: string; username: string | null; displayName: string | null }>> {
    const { rows } = await pool().query(
        `SELECT id, username, "displayName" FROM users WHERE "organizationId" = $1 AND id <> 'admin' ORDER BY id LIMIT $2`, [orgId, cap]);
    return rows;
}

/** The knowledge bases of an organisation that have logging switched on, for the processing register. */
export async function listLoggingKbsOfOrg(orgId: string): Promise<Array<{ id: string; name: string; query_log_retention_days: number }>> {
    const { rows } = await pool().query(
        `SELECT id, name, query_log_retention_days FROM knowledge_bases WHERE organization_id = $1 AND query_log_enabled = true ORDER BY name`, [orgId]);
    return rows;
}
