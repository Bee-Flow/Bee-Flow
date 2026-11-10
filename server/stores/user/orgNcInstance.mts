/**
 * The Nextcloud instance id of an organisation.
 *
 * An instance id belongs to one organisation, and an organisation has one
 * instance id: it is set, in one statement, only on an organisation that has
 * none or has this one already.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { run } = nodeRequire('../../db') as { run: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null } | null | undefined> };
const { initDB } = nodeRequire('./schema') as { initDB: () => Promise<void> };

/** True when the organisation holds this instance id afterwards. */
export async function claimNcInstanceForOrganization(orgId: string, ncInstanceId: string): Promise<boolean> {
    if (!orgId || !ncInstanceId) return false;
    await initDB();
    try {
        const res = await run(
            `UPDATE organizations SET nc_instance_id = $2
              WHERE id = $1 AND (nc_instance_id IS NULL OR nc_instance_id = $2)`,
            [orgId, ncInstanceId],
        );
        return (res?.rowCount || 0) > 0;
    } catch (e) {
        // idx_orgs_nc_instance_id: another organisation holds this instance id.
        if (/idx_orgs_nc_instance_id|duplicate key|unique/i.test((e as Error).message)) return false;
        throw e;
    }
}
