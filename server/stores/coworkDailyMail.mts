/**
 * The daily Cowork e-mail of one owner (jobs/coworkDailyMail.mts sends it): whether it is on, in which time zone the
 * owner's morning is, and the local day it was last sent.
 *
 * Sending is claimed per day: `claimDay` only moves `last_sent_on` forward, so two servers, or a restart in the
 * middle of a pass, send the mail of one day once. Off by default: a row exists only once the owner chose.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const COWORK_DAILY_MAIL_DDL: readonly string[] = Object.freeze([
    `CREATE TABLE IF NOT EXISTS cowork_daily_mail (
        user_id TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        time_zone TEXT NOT NULL DEFAULT 'UTC',
        last_sent_on DATE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // The pass reads the owners who have it on and were not sent today's yet.
    `CREATE INDEX IF NOT EXISTS idx_cowork_daily_mail_due ON cowork_daily_mail (user_id) WHERE enabled`,
]);

export interface DailyMailSetting { enabled: boolean; timeZone: string }
export interface DailyMailOwner { userId: string; timeZone: string; lastSentOn: string | null }

export interface CoworkDailyMailStore {
    getSetting(userId: string): Promise<DailyMailSetting>;
    setSetting(userId: string, setting: DailyMailSetting): Promise<DailyMailSetting>;
    /** Owners with the mail on, by id after `afterUserId`, at most `limit`. */
    listEnabled(limit: number, afterUserId?: string | null): Promise<DailyMailOwner[]>;
    /** Claim `day` (YYYY-MM-DD, the owner's local day) for one owner; false when it was sent or is off. */
    claimDay(userId: string, day: string): Promise<boolean>;
}

const OFF: DailyMailSetting = Object.freeze({ enabled: false, timeZone: 'UTC' });

export function makeCoworkDailyMailStore(db: Queryable, { ready = async () => {} }: { ready?: () => Promise<unknown> } = {}): CoworkDailyMailStore {
    return {
        async getSetting(userId) {
            await ready();
            const { rows } = await db.query('SELECT enabled, time_zone FROM cowork_daily_mail WHERE user_id = $1', [userId]);
            const row = rows[0];
            return row ? { enabled: row.enabled === true, timeZone: String(row.time_zone || 'UTC') } : { ...OFF };
        },
        async setSetting(userId, { enabled, timeZone }) {
            await ready();
            await db.query(
                `INSERT INTO cowork_daily_mail (user_id, enabled, time_zone) VALUES ($1, $2, $3)
                 ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, time_zone = EXCLUDED.time_zone, updated_at = NOW()`,
                [userId, enabled, timeZone],
            );
            return { enabled, timeZone };
        },
        async listEnabled(limit, afterUserId = null) {
            await ready();
            const { rows } = await db.query(
                `SELECT user_id, time_zone, to_char(last_sent_on, 'YYYY-MM-DD') AS last_sent_on FROM cowork_daily_mail
                 WHERE enabled AND ($2::text IS NULL OR user_id > $2) ORDER BY user_id LIMIT $1`,
                [limit, afterUserId],
            );
            return rows.map((r) => ({ userId: String(r.user_id), timeZone: String(r.time_zone || 'UTC'), lastSentOn: r.last_sent_on ? String(r.last_sent_on) : null }));
        },
        async claimDay(userId, day) {
            await ready();
            const { rows } = await db.query(
                `UPDATE cowork_daily_mail SET last_sent_on = $2::date
                 WHERE user_id = $1 AND enabled AND (last_sent_on IS NULL OR last_sent_on < $2::date) RETURNING user_id`,
                [userId, day],
            );
            return rows.length > 0;
        },
    };
}

type RealDb = { pool: Queryable; exec: (sql: string) => Promise<unknown> };
type StoreInit = { makeStoreInit: (tag: string, fn: () => Promise<void>) => () => Promise<void> };
const realDb = (): RealDb => nodeRequire('../db.js') as RealDb;

/** The schema init (ledgered, memoised); storeModules.js starts it at boot. */
export const initDB: () => Promise<void> = (nodeRequire('./lib/storeInit.js') as StoreInit).makeStoreInit('CoworkDailyMailStore', async () => {
    const db = realDb();
    for (const sql of COWORK_DAILY_MAIL_DDL) await db.exec(sql);
});

let defaultStore: CoworkDailyMailStore | null = null;

/** The store on the server's pool. */
export function coworkDailyMailStore(): CoworkDailyMailStore {
    if (!defaultStore) defaultStore = makeCoworkDailyMailStore({ query: (sql, params) => realDb().pool.query(sql, params) }, { ready: initDB });
    return defaultStore;
}
