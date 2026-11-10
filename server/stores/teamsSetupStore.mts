/**
 * Read-only queries behind the Teams members overview
 * (GET /api/teams-setup/org/overview). No table of its own: it reads users,
 * automation_credentials and teams_import_jobs, whose stores create them.
 *
 * What it never selects: tokens, `last_error`, `title`, `email`. The Microsoft
 * identity columns come back lower-cased for an internal GUID check and never
 * reach a response.
 */

import { createRequire } from 'node:module';
import { TEAMS_EXPECTED_OUTCOME_CODES } from '../core/meetingNotes/teamsImportOutcomes.mts';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
const db = nodeRequire('../db.js') as { getAll: (sql: string, params?: unknown[]) => Promise<Row[]> };
type Initable = { initDB: () => Promise<unknown> };

export interface OrgMemberRow {
    userId: string;
    displayName: string | null;
    username: string | null;
    /** Lower-cased, internal only. */
    azureTenantId: string | null;
    /** Lower-cased, internal only. */
    azureUserId: string | null;
    credentialStatus: 'active' | 'needs_reauth' | 'revoked' | null;
    credentialScope: string | null;
}

const STATUSES = new Set(['active', 'needs_reauth', 'revoked']);

async function ready(): Promise<void> {
    await (nodeRequire('./userStore.js') as Initable).initDB();
    await (nodeRequire('./automationCredentialStore.js') as Initable).initDB();
    await (nodeRequire('./teamsImportStore.js') as Initable).initDB();
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function toMember(r: Row): OrgMemberRow {
    const status = typeof r.status === 'string' && STATUSES.has(r.status) ? r.status as OrgMemberRow['credentialStatus'] : null;
    return {
        userId: String(r.id),
        displayName: text(r.displayName),
        username: text(r.username),
        azureTenantId: text(r.azureTenantId),
        azureUserId: text(r.azureUserId),
        credentialStatus: status,
        credentialScope: text(r.scope),
    };
}

/**
 * The active members whose home organisation is `orgId`, sorted by display
 * name (else username), at most `limit` (0 = all). `truncated` says whether
 * there were more.
 */
export async function listOrgMemberRows(orgId: string, limit: number): Promise<{ rows: OrgMemberRow[]; truncated: boolean }> {
    if (!orgId) return { rows: [], truncated: false };
    await ready();
    const bounded = Number.isInteger(limit) && limit > 0;
    const params: unknown[] = bounded ? [orgId, limit + 1] : [orgId];
    const rows = await db.getAll(
        `SELECT u.id, u."displayName", u.username, LOWER(u."azureTenantId") AS "azureTenantId", LOWER(u."azureUserId") AS "azureUserId",
                c.status, c.scope
           FROM users u
           LEFT JOIN automation_credentials c ON c.user_id = u.id AND c.provider = 'microsoft'
          WHERE u."organizationId" = $1 AND COALESCE(u.status, 'active') = 'active'
          ORDER BY COALESCE(NULLIF(u."displayName", ''), u.username), u.id${bounded ? '\n          LIMIT $2' : ''}`,
        params,
    );
    const truncated = bounded && rows.length > limit;
    return { rows: (truncated ? rows.slice(0, limit) : rows).map(toMember), truncated };
}

/**
 * Failed Teams imports per user and code in the last `days` days, for one
 * organisation. Expected outcomes (a meeting nobody recorded, and the other
 * TEAMS_EXPECTED_OUTCOME_CODES) are no failures and are not counted.
 */
export async function countRecentTeamsFailures(orgId: string, days: number): Promise<{ userId: string; code: string; count: number }[]> {
    if (!orgId) return [];
    await ready();
    const window = Number.isInteger(days) && days > 0 ? days : 7;
    const rows = await db.getAll(
        `SELECT user_id, error_code, COUNT(*)::int AS count
           FROM teams_import_jobs
          WHERE org_id = $1 AND error_code IS NOT NULL AND NOT (error_code = ANY($3::text[]))
            AND updated_at >= NOW() - ($2::int * INTERVAL '1 day')
          GROUP BY 1, 2`,
        [orgId, window, [...TEAMS_EXPECTED_OUTCOME_CODES]],
    );
    return rows.map((r) => ({ userId: String(r.user_id), code: String(r.error_code), count: Number(r.count) || 0 }));
}
