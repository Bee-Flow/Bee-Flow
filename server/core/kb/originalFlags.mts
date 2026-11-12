/**
 * originalFlags.mts: the knowledge base and `has_original` of the documents behind retrieval rows, for the
 * citation shape (core/kb/citation.js), so a citation can offer the kept original (core/kb/originals.mts).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Retrieval rows with the knowledge base and `has_original` of their document added, for the citation
 * shape (core/kb/citation.js). One query for the whole list; best effort: on a failure the rows come
 * back as they were, and a citation without the flags simply offers no download.
 */
export async function withOriginalFlags<T extends { document_id?: unknown }>(
    rows: T[],
    query: (ids: string[]) => Promise<Array<{ id: string; kb_id: string; has_original: boolean }>> = defaultFlagQuery,
): Promise<Array<T & { knowledge_base_id?: string; has_original?: boolean }>> {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    const ids = [...new Set(rows.map((r) => String(r?.document_id ?? '').toLowerCase()).filter((id) => UUID.test(id)))];
    if (ids.length === 0) return rows;
    try {
        const found = new Map((await query(ids)).map((r) => [String(r.id).toLowerCase(), r]));
        return rows.map((r) => {
            const hit = found.get(String(r?.document_id ?? '').toLowerCase());
            return hit ? { ...r, knowledge_base_id: hit.kb_id, has_original: !!hit.has_original } : r;
        });
    } catch {
        return rows;
    }
}

async function defaultFlagQuery(ids: string[]): Promise<Array<{ id: string; kb_id: string; has_original: boolean }>> {
    return nodeRequire('../../db.js').getAll(
        `SELECT id::text AS id, knowledge_base_id::text AS kb_id, (original_storage_key IS NOT NULL) AS has_original
           FROM documents WHERE id = ANY($1::uuid[])`,
        [ids],
    );
}
