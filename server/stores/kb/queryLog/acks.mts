/**
 * acks.mts: the acknowledgements of the KB query log (kb_query_log_ack).
 *
 * The legal basis of the log is legitimate interest, so a user is informed and the acknowledgement is
 * recorded, not asked for as consent. An acknowledgement is valid while it is not older than the last
 * settings change of the base (any change re-asks).
 */

import type { Db } from './types.mts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeAckFns(db: Db, clock: () => Date) {
/** Record that `userId` has seen the notice of these bases (only bases that log; others are skipped). Returns the count. */
async function acknowledge(userId: string, kbIds: string[]): Promise<number> {
    const ids = [...new Set((kbIds || []).filter((id) => typeof id === 'string' && UUID_RE.test(id)))];
    if (!userId || ids.length === 0) return 0;
    const res = await db.query(
        `INSERT INTO kb_query_log_ack (user_id, kb_id, acknowledged_at)
         SELECT $1, k.id, $3::timestamptz FROM knowledge_bases k WHERE k.id = ANY($2::uuid[]) AND k.query_log_enabled = true
         ON CONFLICT (user_id, kb_id) DO UPDATE SET acknowledged_at = EXCLUDED.acknowledged_at`,
        [userId, ids, clock().toISOString()]);
    return res.rowCount ?? 0;
}

/** Of `kbIds`, those for which `userId` holds a VALID acknowledgement (not older than the last settings change). */
async function validAckKbIds(userId: string, kbIds: string[]): Promise<string[]> {
    const ids = [...new Set((kbIds || []).filter((id) => typeof id === 'string' && UUID_RE.test(id)))];
    if (!userId || ids.length === 0) return [];
    const { rows } = await db.query(
        `SELECT a.kb_id FROM kb_query_log_ack a JOIN knowledge_bases k ON k.id = a.kb_id
         WHERE a.user_id = $1 AND a.kb_id = ANY($2::uuid[]) AND a.acknowledged_at >= COALESCE(k.query_log_changed_at, '-infinity'::timestamptz)`,
        [userId, ids]);
    return rows.map((r) => String(r.kb_id));
}

/** Valid acknowledgements per base, for the compliance overview. */
async function ackCountsByKb(kbIds: string[]): Promise<Record<string, number>> {
    const ids = [...new Set((kbIds || []).filter((id) => typeof id === 'string' && UUID_RE.test(id)))];
    const out: Record<string, number> = {};
    if (ids.length === 0) return out;
    const { rows } = await db.query(
        `SELECT a.kb_id, COUNT(*)::int AS n FROM kb_query_log_ack a JOIN knowledge_bases k ON k.id = a.kb_id
         WHERE a.kb_id = ANY($1::uuid[]) AND a.acknowledged_at >= COALESCE(k.query_log_changed_at, '-infinity'::timestamptz) GROUP BY a.kb_id`, [ids]);
    for (const r of rows) out[String(r.kb_id)] = r.n;
    return out;
}

    return { acknowledge, validAckKbIds, ackCountsByKb };
}
