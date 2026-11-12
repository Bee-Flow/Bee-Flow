/**
 * The Nextcloud uid stored on a user, written by the link a person makes
 * after a normal sign-in (auth/connector/ncLinkTicket.mts).
 *
 * One statement, conditional: the user is a member of the organisation, its
 * stored uid is still the one the link was issued for ('' = none), and no
 * other user of the organisation holds the new uid. A link therefore writes
 * once, and never moves a uid away from another account.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { run } = nodeRequire('../../db') as { run: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null } | null | undefined> };
const { initDB } = nodeRequire('./schema') as { initDB: () => Promise<void> };

/** True when this call wrote the uid. */
export async function setNcUidIfUnchanged(userId: string, orgId: string, ncUid: string, expectedStoredUid: string): Promise<boolean> {
    if (!userId || !orgId || !ncUid) return false;
    await initDB();
    const res = await run(
        `UPDATE users SET nc_uid = $3
          WHERE id = $1 AND "organizationId" = $2
            AND COALESCE(nc_uid, '') = $4
            AND NOT EXISTS (SELECT 1 FROM users other
                             WHERE other."organizationId" = $2 AND other.nc_uid = $3 AND other.id <> $1)`,
        [userId, orgId, ncUid, expectedStoredUid || ''],
    );
    return (res?.rowCount || 0) > 0;
}
