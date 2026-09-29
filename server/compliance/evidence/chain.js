/**
 * Evidence hash chain — link computation + verification.
 *
 * Every compliance_evidence row written since the chain was introduced carries
 *
 *   seq          per-org monotonic sequence (BIGINT; NULL = pre-chain row)
 *   payload_hash sha256(canonicalJSON(payload))            — see canonical.js
 *   prev_hash    the previous row's `hash` (NULL for the genesis row, seq 1)
 *   hash         sha256((prev_hash || '') + payload_hash)  — linkHash()
 *
 * complianceStore.addEvidence computes these under a per-org advisory lock
 * (one writer per org at a time, so `seq` is contiguous). This module owns the
 * two hash functions the store calls and the verifier every reader uses:
 * the A.5.28 check (limit 5000), GET /api/compliance/evidence/chain, the
 * counts aggregate (small limit) and scripts/verifyEvidenceChain.js.
 *
 * Two verifications, deliberately separate (PLAN-BACKEND D5):
 *   link     hash === linkHash(prev_hash, payload_hash) and prev_hash equals
 *            the previous row's hash — never touches the JSONB column, so it
 *            cannot be confused by Postgres' JSONB normalisation;
 *   content  payload_hash === hashPayload(payload) — recomputed from the
 *            stored JSONB through the canonical serialiser. A content mismatch
 *            with an intact link means the payload was altered in place (or
 *            the canonical form drifted) — reported as reason 'content'.
 * Rows from before the chain (seq IS NULL) were hashed as
 * sha256(JSON.stringify(payload)) and cannot be recomputed from JSONB; they
 * are shape-checked only (a 64-hex hash is present) and counted separately.
 *
 * The verifier never loads more than `limit` rows: the walk covers the LAST
 * `limit` chained rows, org-wide totals come from COUNT(*).
 */

const crypto = require('crypto');
const { hashPayload } = require('./canonical');
const { writeFailureSummary } = require('./writeFailures');

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// Postgres SQLSTATE for "column does not exist" — the DDL adding seq /
// prev_hash / payload_hash has not run yet on this database.
const PG_UNDEFINED_COLUMN = '42703';

/**
 * The chain link: sha256 over the previous row's hash concatenated with this
 * row's payload hash. The genesis row has no predecessor, so its link is
 * sha256(payloadHash) alone.
 * @param {string|null|undefined} prevHash
 * @param {string} payloadHash
 * @returns {string} 64 lowercase hex characters
 */
function linkHash(prevHash, payloadHash) {
    return crypto.createHash('sha256').update((prevHash || '') + payloadHash).digest('hex');
}

// node-postgres returns BIGINT as a string (no int8 type parser is installed
// in db.js); COUNT(*)::int comes back as a number. Normalise both.
function toInt(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// JSONB is parsed by node-postgres by default; a JSON-typed (not JSONB)
// column or a stub could hand us the text instead. Both must hash the same.
function parsePayload(payload) {
    if (typeof payload === 'string') {
        try { return JSON.parse(payload); } catch { return payload; }
    }
    return payload;
}

function isMissingColumnError(err) {
    return err && err.code === PG_UNDEFINED_COLUMN;
}

/**
 * Walk one org's chain and report on it.
 *
 * @param {string} orgId
 * @param {object} [opts]
 * @param {number} [opts.limit=2000]  max chained rows loaded (the newest ones)
 * @param {object} [opts.db]          db module (`getOne`, `getAll`); injected by tests
 * @returns {Promise<{
 *   ok: boolean|null,
 *   reason?: 'columns_missing',
 *   rows_total: number|null,
 *   chained_rows: number,
 *   pre_chain_rows: number|null,
 *   pre_chain_invalid: number|null,
 *   verified_rows: number,
 *   first_break: { seq: number, reason: 'link'|'gap'|'content' }|null,
 *   head: { seq: number, hash: string }|null,
 *   window: { limit: number, from_seq: number, to_seq: number }|null,
 *   latest_captured_at: string|Date|null,
 *   write_failures: { count, first_at, last_at, recent[] }|null,
 *   checked_at: string
 * }>}
 *   `ok` is false on the first break, null when the chain columns do not
 *   exist yet (callers degrade — nothing to verify), true otherwise (also
 *   for an org with no chained rows: an empty chain is not a broken one).
 *   Pre-chain shape failures do not flip `ok`; they surface as
 *   `pre_chain_invalid` for the caller to weigh.
 *
 *   `write_failures` is the OTHER half of trusting the trail, and the reason
 *   it belongs here: the walk can only prove that the rows present are
 *   unaltered, never that every row that should exist arrived. A row that a
 *   handler failed to append leaves no gap in `seq` (the sequence is
 *   allocated inside the same transaction), so it is invisible to every check
 *   above. `compliance/evidence/writeFailures` counts those rejections and
 *   this report carries them — null when there are none. They do NOT flip
 *   `ok`: the chain itself is intact, it is the trail that is incomplete, and
 *   a reader must be able to tell those apart.
 */
async function verifyChain(orgId, { limit = 2000, db = require('../../db') } = {}) {
    const checked_at = new Date().toISOString();
    // Clamp the window: a non-numeric limit falls back to the default, a
    // non-positive one still walks the head row, and nothing loads more than
    // 50 000 rows in one call whatever the caller asks.
    const n = Number(limit);
    const max = Math.max(1, Math.min(Number.isFinite(n) ? Math.floor(n) : 2000, 50000));

    let totals;
    let window;
    try {
        // One aggregate pass for the org-wide numbers (never loads rows).
        totals = await db.getOne(`
            SELECT
                COUNT(*)::int AS rows_total,
                COUNT(*) FILTER (WHERE seq IS NOT NULL)::int AS chained_rows,
                COUNT(*) FILTER (WHERE seq IS NULL)::int AS pre_chain_rows,
                COUNT(*) FILTER (WHERE seq IS NULL AND (hash IS NULL OR hash !~ '^[0-9a-f]{64}$'))::int AS pre_chain_invalid,
                MAX(captured_at) AS latest_captured_at
            FROM compliance_evidence
            WHERE organization_id = $1
        `, [orgId]);
        // The newest `limit` chained rows, walked oldest → newest.
        window = await db.getAll(`
            SELECT seq, hash, prev_hash, payload_hash, payload
            FROM (
                SELECT seq, hash, prev_hash, payload_hash, payload
                FROM compliance_evidence
                WHERE organization_id = $1 AND seq IS NOT NULL
                ORDER BY seq DESC
                LIMIT $2
            ) w
            ORDER BY seq ASC
        `, [orgId, max]);
    } catch (err) {
        if (!isMissingColumnError(err)) throw err;
        return {
            ok: null,
            reason: 'columns_missing',
            rows_total: null,
            chained_rows: 0,
            pre_chain_rows: null,
            pre_chain_invalid: null,
            verified_rows: 0,
            first_break: null,
            head: null,
            window: null,
            latest_captured_at: null,
            write_failures: writeFailureSummary(orgId),
            checked_at,
        };
    }

    let verified = 0;
    let firstBreak = null;
    let prev = null; // previous row in the window, already verified
    for (const raw of window || []) {
        const row = {
            seq: toInt(raw.seq),
            hash: raw.hash || null,
            prev_hash: raw.prev_hash || null,
            payload_hash: raw.payload_hash || null,
        };
        let reason = null;
        if (prev && row.seq !== prev.seq + 1) {
            // Contiguity: seq must step by exactly one. The first row of the
            // window has no predecessor in view, so it cannot be gap-checked.
            reason = 'gap';
        } else if (
            !row.hash || !row.payload_hash
            || !SHA256_HEX_RE.test(row.hash) || !SHA256_HEX_RE.test(row.payload_hash)
            || (prev ? row.prev_hash !== prev.hash : (row.seq === 1 && row.prev_hash !== null))
            || row.hash !== linkHash(row.prev_hash, row.payload_hash)
        ) {
            // Link: the stored hash must be the link over the stored prev_hash
            // and payload_hash, and prev_hash must point at the row before.
            // Inside the window that is the previous row's hash; for the
            // genesis row it must be NULL. Missing or malformed hashes are a
            // broken link too — there is nothing to verify against.
            reason = 'link';
        } else if (row.payload_hash !== hashPayload(parsePayload(raw.payload))) {
            // Content: the JSONB as stored must still canonicalise to the
            // payload_hash the link was computed over.
            reason = 'content';
        }
        if (reason) {
            firstBreak = { seq: row.seq, reason };
            break;
        }
        verified++;
        prev = row;
    }

    const last = window && window.length ? window[window.length - 1] : null;
    const first = window && window.length ? window[0] : null;
    return {
        ok: firstBreak === null,
        rows_total: toInt(totals?.rows_total) ?? 0,
        chained_rows: toInt(totals?.chained_rows) ?? 0,
        pre_chain_rows: toInt(totals?.pre_chain_rows) ?? 0,
        pre_chain_invalid: toInt(totals?.pre_chain_invalid) ?? 0,
        verified_rows: verified,
        first_break: firstBreak,
        head: last ? { seq: toInt(last.seq), hash: last.hash || null } : null,
        window: last ? { limit: max, from_seq: toInt(first.seq), to_seq: toInt(last.seq) } : null,
        latest_captured_at: totals?.latest_captured_at ?? null,
        write_failures: writeFailureSummary(orgId),
        checked_at,
    };
}

module.exports = { hashPayload, linkHash, verifyChain, SHA256_HEX_RE };
