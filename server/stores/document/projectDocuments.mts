/**
 * A Studio document's project membership (projects/membership.js, kind
 * 'document'): filing a document into a project, taking it out of one, the
 * cards and counts a project page lists, and detaching everything from a
 * deleted project.
 *
 * Built by stores/documentStore.js (`makeProjectDocuments(deps)`), which
 * re-exports these: the database reads go through its content-decrypting
 * wrappers, and the row mapping and the sharing transition are its own.
 */

type Row = Record<string, unknown>;
type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };

export interface ProjectDocumentDeps<Card, C extends Client> {
    initDB: () => Promise<unknown>;
    run: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null } | null | undefined>;
    getAll: (sql: string, params?: unknown[]) => Promise<Row[]>;
    withTransaction: <T>(fn: (client: C) => Promise<T>) => Promise<T>;
    mapProjectCard: (row: Row) => Card;
    /** The sharing transition a document goes through when its audience changes (lib/documentSharingCrypto.transition). */
    transitionSharing: (client: C, row: Awaited<ReturnType<C['query']>>['rows'][number], audience: string) => Promise<unknown>;
    /** The SQL condition for a document a project lists: filed, a plain document, not archived (alias `d`). */
    projectDocumentSql: string;
}

export function makeProjectDocuments<Card, C extends Client>(deps: ProjectDocumentDeps<Card, C>) {
    const { initDB, run, getAll, withTransaction, mapProjectCard, transitionSharing, projectDocumentSql } = deps;

    /**
     * File a document into a project.
     *
     * Owner-only: filing exposes the document to every member of the project, and
     * that is the owner's call. The route checks the caller's role on the TARGET
     * project; this checks the rest in the statement itself, so there is no gap
     * between a check and the write: the caller owns it, it is a plain document
     * (not a template or section, which have their own team sharing), it is not
     * archived, and the project exists in the document's own organisation.
     */
    async function setDocumentProject(documentId: string, userId: string, projectId: string, callerOrgIds: Iterable<string> = []): Promise<boolean> {
        await initDB();
        if (!documentId || !userId || !projectId) return false;
        // `callerOrgIds`: the organisations the owner belongs to (auth/orgScope), so a document of someone whose
        // organisation only comes from a group (none on the document) can be filed into that organisation's project.
        return withTransaction(async (client) => {
            const { rows } = await client.query(
                `UPDATE studio_documents d SET project_id = $1
                  WHERE d.id = $2 AND d.user_id = $3 AND d.kind = 'document' AND d.archived = false
                    AND EXISTS (SELECT 1 FROM projects p
                        WHERE p.id = $1 AND (COALESCE(p.organization_id, '') = COALESCE(d.organization_id, '')
                            OR (COALESCE(d.organization_id, '') = '' AND p.organization_id = ANY($4::text[])))) RETURNING d.*`,
                [projectId, documentId, userId, [...callerOrgIds]]);
            if (!rows[0]) return false;
            await transitionSharing(client, rows[0], (rows[0].sharing_audience || 'private') as string);
            return true;
        });
    }

    /**
     * Take a document out of ONE project. With `userId`, only when that person
     * owns it; with null, whoever owns it, which projects/membership.js allows
     * only the owner of that project. Scoped to `projectId` either way, so a
     * removal can never reach a document filed somewhere else.
     */
    async function detachDocumentFromProject(documentId: string, projectId: string, userId: string | null = null): Promise<boolean> {
        await initDB();
        if (!documentId || !projectId) return false;
        const result = await run(
            `UPDATE studio_documents SET project_id = NULL
              WHERE id = $1 AND project_id = $2 AND ($3::text IS NULL OR user_id = $3)`,
            [documentId, projectId, userId]
        );
        return (result?.rowCount || 0) > 0;
    }

    /** The documents filed into a project, as cards (no slots), newest first. */
    async function listProjectDocuments(projectId: string, { limit = 100, offset = 0 }: { limit?: number; offset?: number } = {}): Promise<Card[]> {
        await initDB();
        if (!projectId) return [];
        const rows = await getAll(
            `SELECT d.id, d.name, d.doc_type, d.kind, d.user_id, d.project_id, d.updated_by, d.created_at, d.updated_at
               FROM studio_documents d
              WHERE d.project_id = $1 AND ${projectDocumentSql}
              ORDER BY d.updated_at DESC, d.id
              LIMIT $2 OFFSET $3`,
            [projectId, Math.min(Math.max(Number(limit) || 100, 1), 200), Math.max(Number(offset) || 0, 0)]
        );
        return rows.map(mapProjectCard);
    }

    /**
     * How many documents each of these projects holds, in ONE query. A project
     * missing from the map holds none; a failed read rejects, so a caller can
     * tell "none" from "could not count".
     */
    async function countProjectDocuments(projectIds: unknown): Promise<Map<string, number>> {
        await initDB();
        const ids = (Array.isArray(projectIds) ? projectIds : []).filter((id): id is string => typeof id === 'string' && id !== '');
        if (!ids.length) return new Map();
        const rows = await getAll(
            `SELECT d.project_id, COUNT(*)::int AS n FROM studio_documents d
              WHERE d.project_id = ANY($1::text[]) AND ${projectDocumentSql}
              GROUP BY d.project_id`,
            [ids]
        );
        return new Map(rows.map(r => [r.project_id as string, Number(r.n) || 0]));
    }

    /**
     * Detach every document from a deleted project. They go back to being their
     * owners' private documents; deleting a project never deletes what its members
     * wrote in it.
     */
    async function clearProjectFromDocuments(projectId: string): Promise<number> {
        await initDB();
        if (!projectId) return 0;
        const result = await run('UPDATE studio_documents SET project_id = NULL WHERE project_id = $1', [projectId]);
        return result?.rowCount || 0;
    }

    return { setDocumentProject, detachDocumentFromProject, listProjectDocuments, countProjectDocuments, clearProjectFromDocuments };
}
