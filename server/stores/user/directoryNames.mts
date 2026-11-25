import { createRequire } from 'node:module';

interface DirectoryName {
    id: string;
    name: string;
}

const nodeRequire = createRequire(import.meta.url);
const { initDB } = nodeRequire('./schema') as typeof import('./schema.js');
const { getAll } = nodeRequire('../../db') as {
    getAll: (sql: string, params: unknown[]) => Promise<DirectoryName[]>;
};

/** Search the names a project invite picker can display, before limiting its results. */
export async function searchOrgDirectoryNames(organizationId: string, query: string, limit: number): Promise<DirectoryName[]> {
    if (!organizationId) return [];
    await initDB();
    return getAll(`
        WITH directory AS (
            SELECT id, COALESCE(NULLIF(TRIM("displayName"), ''), NULLIF(username, ''), id) AS label
            FROM users WHERE "organizationId" = $1 AND COALESCE(status, 'active') = 'active'
        ), names AS (
            SELECT id, CASE WHEN STRPOS(label, '@') > 0 THEN id ELSE label END AS name FROM directory
        )
        SELECT id, name FROM names WHERE STRPOS(LOWER(name), LOWER($2)) > 0
        ORDER BY name, id LIMIT $3
    `, [organizationId, query, limit]);
}
