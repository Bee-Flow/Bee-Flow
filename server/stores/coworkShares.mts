/**
 * Who a cowork is shared with (usecases/coworkShares.mts), on `cowork_shares`: per item, the colleagues who may see
 * it (viewer) or also decide its runs' questions (approver).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/**
 * The shares that still count, as `c` (the share) and `s` (the item): the holder is an active member of the owner's
 * organisation now. Someone who left, moved to another organisation or was switched off keeps the row until the owner
 * changes the list, but no longer sees the item or decides its questions.
 */
const LIVE_SHARES = `cowork_shares c
    JOIN cowork_schedules s ON s.id = c.schedule_id
    JOIN users o ON o.id = s.user_id
    JOIN users m ON m.id = c.user_id AND m."organizationId" = o."organizationId" AND COALESCE(m.status, 'active') = 'active'
   WHERE o."organizationId" <> ''`;

type Row = Record<string, unknown>;
type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };
type Db = {
    getAll: (sql: string, params?: unknown[]) => Promise<Row[]>;
    getOne: (sql: string, params?: unknown[]) => Promise<Row | null>;
    withTransaction: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
};

export type ShareRole = 'viewer' | 'approver';
export interface Share { userId: string; role: ShareRole }
export interface SharedItem { id: string; ownerId: string; title: string; role: ShareRole; lastStatus: string | null; lastRunAt: string | null; isActive: boolean }

export function makeCoworkShares({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** Replace the item's shares with `shares`, in one go. */
    async function setShares(scheduleId: string, shares: Share[], addedBy: string, expected?: Share[]): Promise<boolean> {
        await ready();
        return db.withTransaction(async (client) => {
            // Even a task with no shares has a parent row to serialize writers on.
            await client.query('SELECT id FROM cowork_schedules WHERE id = $1 FOR UPDATE', [scheduleId]);
            if (expected) {
                const current = await client.query(`SELECT c.user_id, c.role FROM ${LIVE_SHARES} AND c.schedule_id = $1`, [scheduleId]);
                const roles = new Map(expected.map(s => [s.userId, s.role]));
                if (current.rows.length !== roles.size || current.rows.some(s => roles.get(String(s.user_id)) !== s.role)) {
                    return false;
                }
            }
            await client.query('DELETE FROM cowork_shares WHERE schedule_id = $1', [scheduleId]);
            for (const share of shares) {
                await client.query('INSERT INTO cowork_shares (schedule_id, user_id, role, added_by) VALUES ($1, $2, $3, $4)', [scheduleId, share.userId, share.role, addedBy]);
            }
            return true;
        });
    }

    async function listShares(scheduleId: string): Promise<Share[]> {
        await ready();
        return (await db.getAll('SELECT user_id, role FROM cowork_shares WHERE schedule_id = $1 ORDER BY created_at, user_id', [scheduleId]))
            .map((r) => ({ userId: String(r.user_id), role: r.role === 'approver' ? 'approver' : 'viewer' }));
    }

    /** The colleague who decides the item's questions, or null. */
    async function approverOf(scheduleId: string): Promise<string | null> {
        await ready();
        const row = await db.getOne(`SELECT c.user_id FROM ${LIVE_SHARES} AND c.schedule_id = $1 AND c.role = 'approver' LIMIT 1`, [scheduleId]);
        return row ? String(row.user_id) : null;
    }

    /** The items shared with one person, with what they may do. */
    async function sharedWith(userId: string): Promise<SharedItem[]> {
        await ready();
        const rows = await db.getAll(
            `SELECT s.id, s.user_id AS owner_id, s.title, s.last_status, s.last_run_at, s.is_active, c.role
               FROM ${LIVE_SHARES}
                AND c.user_id = $1 ORDER BY s.title`,
            [userId],
        );
        return rows.map((r) => ({
            id: String(r.id), ownerId: String(r.owner_id), title: String(r.title ?? ''), role: r.role === 'approver' ? 'approver' : 'viewer',
            lastStatus: r.last_status ? String(r.last_status) : null, lastRunAt: r.last_run_at ? new Date(r.last_run_at as string).toISOString() : null, isActive: r.is_active === true,
        }));
    }

    /** This person's role on this item, or null. */
    async function roleOf(scheduleId: string, userId: string): Promise<ShareRole | null> {
        await ready();
        const row = await db.getOne(`SELECT c.role FROM ${LIVE_SHARES} AND c.schedule_id = $1 AND c.user_id = $2`, [scheduleId, userId]);
        return row ? (row.role === 'approver' ? 'approver' : 'viewer') : null;
    }

    return { setShares, listShares, approverOf, sharedWith, roleOf };
}

let defaultShares: ReturnType<typeof makeCoworkShares> | null = null;

/** The store on the server's pool, after the Cowork schema is there. */
export function coworkShares(): ReturnType<typeof makeCoworkShares> {
    if (!defaultShares) defaultShares = makeCoworkShares({ ready: () => (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB() });
    return defaultShares;
}
