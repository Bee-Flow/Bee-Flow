/**
 * Which organisations have an administrator with a verified sign-in address
 * on an e-mail domain.
 *
 * An organisation's contact address names a domain, but anyone can type an
 * address. The domain is the organisation's for placing new accounts
 * (auth/orgDomainMatch.mts) once one of its administrators signs in with a
 * verified address on it: confirmed through the e-mailed link, or by Google
 * at sign-in (`users.email_verified_at`, cleared when the address changes).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { getAll } = nodeRequire('../../db') as { getAll: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>> };
const { initDB } = nodeRequire('./schema') as { initDB: () => Promise<void> };

/** Ids of the organisations with an active administrator whose verified address is on `domain`. */
export async function orgIdsWithVerifiedAdminAtDomain(domain: string): Promise<string[]> {
    const d = String(domain || '').trim().toLowerCase();
    if (!d) return [];
    await initDB();
    const rows = await getAll(
        `SELECT DISTINCT "organizationId" AS id FROM users
          WHERE "orgRole" IN ('org_admin', 'admin')
            AND COALESCE("organizationId", '') <> ''
            AND email_verified_at IS NOT NULL
            AND COALESCE(status, 'active') = 'active'
            AND LOWER(SPLIT_PART(email, '@', 2)) = $1`,
        [d],
    );
    return rows.map((r) => String(r.id));
}
