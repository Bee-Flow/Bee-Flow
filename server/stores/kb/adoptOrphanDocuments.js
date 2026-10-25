// @typecheck strict
/**
 * Adopting source-less documents into kb_sources (a sibling of stores/kbSources.js;
 * routes/knowledgeBases/sources.js builds it with KbSourcesStore.initDB).
 * Dependencies are injected (`deps`), so the tests need no module mocking.
 */

const { planSourcesForKb, truncate } = require('./sourcePlan');

/**
 * @param {() => Promise<any>} initDB  the owning store's init
 * @param {{ getOne?: Function, withTransaction?: Function, managedParts?: any }} [deps]
 */
function makeAdoptOrphanDocuments(initDB, deps = {}) {
    const getOne = deps.getOne || ((/** @type {string} */ sql, /** @type {any[]} */ params) => require('../../db').getOne(sql, params));
    const withTransaction = deps.withTransaction || ((/** @type {any} */ fn) => require('../../db').withTransaction(fn));
    const managedInfoForKb = (/** @type {string} */ id) => (deps.managedParts || require('../managedPartsDefault')).managedInfoForKb(id);

    /**
     * Give the documents of ONE knowledge base that predate the source model
     * (documents.source_id IS NULL) a source, so the Sources tab shows what the
     * KB overview counts. Lazy twin of migrations/kb-sources-backfill.js stage 1:
     * same plan (stores/kb/sourcePlan.js), same find-or-create keys, so a re-run
     * or the migration itself finds the rows this created.
     *
     * Scoped strictly to `kbId`: every statement filters on knowledge_base_id,
     * and the caller has already authorised that KB. Idempotent; a per-KB
     * advisory lock keeps two concurrent listings from creating a source twice
     * (the manual migration does not take this lock; it is a deploy step run
     * alone, and a re-run finds whatever this created).
     *
     * A base whose content a Solution stage manages (any managed/stage base,
     * shell mode included) is never touched: its documents arrive by deploy
     * without a source_id, and a read must not write there. The caller also
     * skips system and project-files bases.
     *
     * @param {string} kbId
     * @returns {Promise<number>} documents assigned (0 on the normal, fast path)
     */
    async function adoptOrphanDocuments(kbId) {
        await initDB();
        if (!kbId) return 0;
        if (await managedInfoForKb(String(kbId))) return 0;
        const any = await getOne(
            `SELECT 1 AS ok FROM documents WHERE knowledge_base_id = $1 AND source_id IS NULL LIMIT 1`,
            [kbId],
        );
        if (!any) return 0;
        return withTransaction(async (/** @type {import('pg').PoolClient} */ client) => {
            await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`kb-adopt:${kbId}`]);
            const owner = await client.query(`SELECT tenant_id FROM knowledge_bases WHERE id = $1`, [kbId]);
            const createdBy = (owner.rows[0] && owner.rows[0].tenant_id) || null;
            // Re-read under the lock: a concurrent request may have adopted them.
            const { rows: docs } = await client.query(
                `SELECT id, title, source_type, source_uri
                   FROM documents
                  WHERE knowledge_base_id = $1 AND source_id IS NULL
                  ORDER BY created_at ASC, id ASC`,
                [kbId],
            );
            let assigned = 0;
            for (const entry of planSourcesForKb(docs)) {
                const found = await client.query(
                    `SELECT id FROM kb_sources
                      WHERE knowledge_base_id = $1 AND kind = $2 AND config @> $3::jsonb
                      ORDER BY created_at ASC LIMIT 1`,
                    [kbId, entry.kind, JSON.stringify(entry.configMatch || {})],
                );
                let sourceId = found.rows[0] ? found.rows[0].id : null;
                if (!sourceId) {
                    const ins = await client.query(
                        `INSERT INTO kb_sources (knowledge_base_id, kind, name, config, refresh_mode, created_by)
                         VALUES ($1, $2, $3, $4::jsonb, 'manual', $5)
                         RETURNING id`,
                        [kbId, entry.kind, truncate(entry.name), JSON.stringify(entry.config || {}), createdBy],
                    );
                    sourceId = ins.rows[0].id;
                }
                const res = await client.query(
                    `UPDATE documents SET source_id = $1, updated_at = now()
                      WHERE id = ANY($2::uuid[]) AND knowledge_base_id = $3 AND source_id IS NULL`,
                    [sourceId, entry.documentIds, kbId],
                );
                assigned += res.rowCount || 0;
            }
            return assigned;
        });
    }

    return { adoptOrphanDocuments };
}

module.exports = makeAdoptOrphanDocuments;
