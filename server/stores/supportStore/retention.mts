/**
 * Retention of Bee Flow's own company inbox: delete the tickets of people who are not a customer
 * (the website contact form) once their last message is older than the retention term.
 *
 * Which tickets: the company inbox is `inbox_id IS NULL`; a tenant's Support-studio mailbox
 * (`inbox_id` set) is never touched here. Inside the company inbox a ticket is a customer
 * relationship when it is bound to an organisation or to a signed-in account
 * (`organization_id` / `requester_user_id`, set for every in-app ticket); those are kept. What is
 * left is the anonymous website form (source 'marketing') and anything else nobody linked.
 *
 * What goes: the thread row, and with it (ON DELETE CASCADE) its messages, their attachment
 * metadata, the legacy thread events and the issue links; plus the unified audit rows of that
 * thread, which carry the requester's IP address and user agent (data minimisation: an audit
 * row kept for ever would keep that personal data for ever). All in one transaction per batch.
 *
 * Each batch that deleted something writes, in the SAME transaction, one `retention_purge` row
 * to support_audit_log: the count and the term, never a thread or a person. Its scope is the
 * company inbox's own (organization_id and inbox_id NULL, like the audit rows of the threads it
 * removed), so it shows where those rows showed. A batch either deletes and records, or neither.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> };

const { withTransaction } = nodeRequire('../../db.js') as {
    withTransaction: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
};
const { initDB } = nodeRequire('./schema.js') as { initDB: () => Promise<void> };

/**
 * Delete at most `limit` expired company-inbox threads whose last activity is more than
 * `olderThanDays` days ago. Resolves to the number of threads deleted.
 */
export async function purgeExpiredCompanyThreads({ olderThanDays, limit }: { olderThanDays: number; limit: number }): Promise<number> {
    if (!Number.isSafeInteger(olderThanDays) || olderThanDays <= 0) throw new Error('olderThanDays must be a positive integer');
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
    await initDB();
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT id FROM support_threads
              WHERE inbox_id IS NULL
                AND organization_id IS NULL
                AND requester_user_id IS NULL
                AND COALESCE(last_message_at, created_at) < now() - make_interval(days => $1::int)
              ORDER BY COALESCE(last_message_at, created_at)
              LIMIT $2
              FOR UPDATE`,
            [olderThanDays, limit],
        );
        const ids = rows.map((r) => String(r.id));
        if (!ids.length) return 0;
        await client.query(`DELETE FROM support_audit_log WHERE thread_id = ANY($1::uuid[])`, [ids]);
        const deleted = await client.query(`DELETE FROM support_threads WHERE id = ANY($1::uuid[])`, [ids]);
        const n = Number(deleted.rowCount) || 0;
        if (n > 0) {
            await client.query(
                `INSERT INTO support_audit_log (organization_id, inbox_id, thread_id, actor_kind, action, payload)
                 VALUES (NULL, NULL, NULL, 'system', 'retention_purge', $1::jsonb)`,
                [JSON.stringify({ threads: n, retentionDays: olderThanDays })],
            );
        }
        return n;
    });
}
