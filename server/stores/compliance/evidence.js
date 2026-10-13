// @typecheck
/**
 * compliance_evidence: the append-only, per-org hash chain (addEvidence,
 * getChainHead) and its reads.
 *
 * The db helpers, the store's initDB and the (lazily required) chain
 * primitives of compliance/evidence/chain.js come in from the barrel
 * (stores/complianceStore.js): the chain is still required on the first
 * addEvidence call, not when the store loads.
 */

// ───────────────────────── Evidence ─────────────────────────

const EVIDENCE_COLUMNS = 'id, check_id, subject_type, subject_id, captured_at, hash, payload, storage_key, seq, prev_hash, payload_hash';

/**
 * Filters shared by listEvidence/countEvidence. `regulation` matches the
 * check-id prefix (`GDPR-…`, `DATA_ACT-…`) — evidence rows carry no
 * regulation column of their own.
 * @param orgId
 * @param {{ checkId?: string, subjectType?: string, subjectId?: string, regulation?: string }} [opts]
 */
function _evidenceWhere(orgId, { checkId, subjectType, subjectId, regulation } = {}) {
    const params = [orgId];
    const where = ['organization_id = $1'];
    if (checkId) { params.push(checkId); where.push(`check_id = $${params.length}`); }
    if (subjectType) { params.push(subjectType); where.push(`subject_type = $${params.length}`); }
    if (subjectId) { params.push(String(subjectId)); where.push(`subject_id = $${params.length}`); }
    if (regulation) {
        params.push(`${String(regulation).replace(/[%_\\]/g, '\\$&')}-%`);
        where.push(`check_id LIKE $${params.length}`);
    }
    return { params, where: where.join(' AND ') };
}

/**
 * @param {{ run: Function, getOne: Function, getAll: Function, withTransaction: Function,
 *           initDB: () => Promise<any>, loadChain: () => any }} deps
 */
function createEvidence({ run, getOne, getAll, withTransaction, initDB, loadChain }) {
    /**
     * Append one evidence row as the next link of the org's hash chain.
     *
     *   payload_hash = sha256(canonicalJSON(payload))            (chain.hashPayload)
     *   hash         = sha256(prev_hash ∥ payload_hash)          (chain.linkHash)
     *   seq          = head.seq + 1  (genesis: seq 1, prev_hash NULL)
     *
     * Runs in one transaction under a per-org advisory lock, so two concurrent
     * writers cannot both read the same head; the partial unique index on
     * (organization_id, seq) is the backstop.
     *
     * Caller-supplied `row.hash` — the file sha256 of an upload, the SoA/RoPA
     * export digest, the runner's own JSON.stringify hash — is NOT the chain
     * hash any more. It is folded into `payload.sha256` when the payload has no
     * `sha256` of its own, so the nine pre-chain call sites keep their digest
     * (now inside the canonical payload, hence covered by payload_hash) without
     * changing a line. `hash` on the row is always the link hash.
     *
     * Rows without an organization_id are stored unchained (seq NULL) — the
     * chain is per org and there is no org to lock on.
     *
     * @returns {Promise<{id:number, seq:number|null, hash:string}>}
     */
    async function addEvidence(row) {
        await initDB();
        const chain = loadChain();
        const orgId = row.organization_id || null;
        const payload = { ...(row.payload || {}) };
        if (row.hash && payload.sha256 === undefined) payload.sha256 = row.hash;
        const payloadHash = chain.hashPayload(payload);
        const common = [
            row.check_id || null,
            row.subject_type || null,
            row.subject_id || null,
            JSON.stringify(payload),
            row.storage_key || null,
            payloadHash,
        ];

        if (orgId === null) {
            const { rows } = await run(`
                INSERT INTO compliance_evidence
                    (organization_id, check_id, subject_type, subject_id, payload, storage_key, payload_hash, hash)
                VALUES (NULL, $1, $2, $3, $4::jsonb, $5, $6, $7)
                RETURNING id, seq, hash
            `, [...common, chain.linkHash(null, payloadHash)]);
            return rows[0];
        }

        return withTransaction(async (client) => {
            await client.query(`SELECT pg_advisory_xact_lock(hashtext('beeflow:evidence:' || $1))`, [orgId]);
            const head = await client.query(`
                SELECT seq, hash FROM compliance_evidence
                WHERE organization_id = $1 AND seq IS NOT NULL
                ORDER BY seq DESC
                LIMIT 1
            `, [orgId]);
            const prev = head.rows[0] || null;
            const prevHash = prev ? prev.hash : null;
            const seq = prev ? Number(prev.seq) + 1 : 1;
            const hash = chain.linkHash(prevHash, payloadHash);
            const { rows } = await client.query(`
                INSERT INTO compliance_evidence
                    (organization_id, check_id, subject_type, subject_id, payload, storage_key, payload_hash,
                     seq, prev_hash, hash)
                VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
                RETURNING id, seq, hash
            `, [orgId, ...common, seq, prevHash, hash]);
            const out = rows[0] || { id: null, seq, hash };
            return { id: out.id, seq: out.seq != null ? Number(out.seq) : seq, hash: out.hash || hash };
        });
    }

    /** Newest chained link of an org — `{seq, hash}` or null when nothing is chained yet. */
    async function getChainHead(orgId) {
        await initDB();
        const row = await getOne(`
            SELECT seq, hash FROM compliance_evidence
            WHERE organization_id = $1 AND seq IS NOT NULL
            ORDER BY seq DESC
            LIMIT 1
        `, [orgId]);
        return row ? { seq: Number(row.seq), hash: row.hash } : null;
    }

    /**
     * @param orgId
     * @param {{ checkId?: string, subjectType?: string, subjectId?: string, regulation?: string, limit?: number, offset?: number }} [opts]
     */
    async function listEvidence(orgId, { checkId, subjectType, subjectId, regulation, limit = 100, offset = 0 } = {}) {
        await initDB();
        const { params, where } = _evidenceWhere(orgId, { checkId, subjectType, subjectId, regulation });
        params.push(Math.max(1, Math.min(Number(limit) || 100, 1000)));
        const limitIdx = params.length;
        params.push(Math.max(0, Number(offset) || 0));
        return getAll(`
            SELECT ${EVIDENCE_COLUMNS}
            FROM compliance_evidence
            WHERE ${where}
            ORDER BY captured_at DESC, id DESC
            LIMIT $${limitIdx} OFFSET $${params.length}
        `, params);
    }

    async function countEvidence(orgId, filters = {}) {
        await initDB();
        const { params, where } = _evidenceWhere(orgId, filters);
        const row = await getOne(`SELECT COUNT(*)::int AS n FROM compliance_evidence WHERE ${where}`, params);
        return row ? Number(row.n) || 0 : 0;
    }

    async function getEvidenceById(orgId, id) {
        await initDB();
        return getOne(`
            SELECT ${EVIDENCE_COLUMNS}
            FROM compliance_evidence
            WHERE organization_id = $1 AND id = $2
        `, [orgId, Number(id)]);
    }

    async function getEvidenceHistory(orgId, checkId, limit = 100) {
        await initDB();
        return getAll(`
            SELECT ${EVIDENCE_COLUMNS}
            FROM compliance_evidence
            WHERE organization_id = $1 AND check_id = $2
            ORDER BY captured_at DESC
            LIMIT $3
        `, [orgId, checkId, limit]);
    }

    return {
        addEvidence,
        getChainHead,
        listEvidence,
        countEvidence,
        getEvidenceById,
        getEvidenceHistory,
    };
}

module.exports = { createEvidence };
