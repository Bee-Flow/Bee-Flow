/**
 * "It notices what you repeat" (core/cowork/habits/habitSignals.mts): per person, and only for a person who switched
 * it on, which kind of chat turn they had on which weekday of which week. A row holds the person, the agent, a hash of
 * the app tools the turn used, the weekday and the ISO week — never what they asked, never what came back. Rows older
 * than eight weeks go; switching it off removes them all.
 *
 *   cowork_habit_signals (user_id, agent_id, tools_hash, weekday, iso_week)  one per kind of turn per week
 *   cowork_habit_offers  (user_id, tools_hash)                               offered once, so it never nags
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Db = { getAll: (sql: string, params?: unknown[]) => Promise<Row[]>; run: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null } | unknown> };

export const COWORK_HABITS_DDL: readonly string[] = Object.freeze([
    `CREATE TABLE IF NOT EXISTS cowork_habit_signals (
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        tools_hash TEXT NOT NULL,
        weekday SMALLINT NOT NULL,
        iso_week TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, tools_hash, iso_week)
    )`,
    `CREATE TABLE IF NOT EXISTS cowork_habit_offers (
        user_id TEXT NOT NULL,
        tools_hash TEXT NOT NULL,
        offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, tools_hash)
    )`,
]);

export interface HabitSignal { agentId: string; toolsHash: string; weekday: number; isoWeek: string }

export function makeCoworkHabits({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** Note one kind of turn for this week; a second one in the same week changes nothing. */
    async function note(userId: string, s: HabitSignal): Promise<void> {
        await ready();
        await db.run(
            `INSERT INTO cowork_habit_signals (user_id, agent_id, tools_hash, weekday, iso_week) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, tools_hash, iso_week) DO NOTHING`,
            [userId, s.agentId, s.toolsHash, s.weekday, s.isoWeek],
        );
    }

    /** The weeks this kind of turn happened on this weekday. */
    async function weeksOf(userId: string, toolsHash: string, weekday: number): Promise<string[]> {
        await ready();
        const rows = await db.getAll('SELECT iso_week FROM cowork_habit_signals WHERE user_id = $1 AND tools_hash = $2 AND weekday = $3', [userId, toolsHash, weekday]);
        return rows.map((r) => String(r.iso_week));
    }

    /** Claim the one offer for this kind of turn; false when it was offered before. */
    async function claimOffer(userId: string, toolsHash: string): Promise<boolean> {
        await ready();
        const res = await db.run('INSERT INTO cowork_habit_offers (user_id, tools_hash) VALUES ($1, $2) ON CONFLICT (user_id, tools_hash) DO NOTHING', [userId, toolsHash]);
        return ((res as { rowCount?: number | null })?.rowCount ?? 0) > 0;
    }

    /** Forget what is older than `before`. */
    async function prune(userId: string, before: Date): Promise<void> {
        await ready();
        await db.run('DELETE FROM cowork_habit_signals WHERE user_id = $1 AND created_at < $2', [userId, before.toISOString()]);
    }

    /** Forget everything of this person (switching it off). */
    async function forget(userId: string): Promise<void> {
        await ready();
        await db.run('DELETE FROM cowork_habit_signals WHERE user_id = $1', [userId]);
        await db.run('DELETE FROM cowork_habit_offers WHERE user_id = $1', [userId]);
    }

    return { note, weeksOf, claimOffer, prune, forget };
}

type StoreInit = { makeStoreInit: (tag: string, fn: () => Promise<void>) => () => Promise<void> };

/** The schema init (ledgered, memoised); storeModules.js starts it at boot. No foreign keys. */
export const initDB: () => Promise<void> = (nodeRequire('./lib/storeInit.js') as StoreInit).makeStoreInit('CoworkHabitsStore', async () => {
    const db = nodeRequire('../db.js') as { exec: (sql: string) => Promise<unknown> };
    for (const sql of COWORK_HABITS_DDL) await db.exec(sql);
});

let defaultStore: ReturnType<typeof makeCoworkHabits> | null = null;

/** The store on the server's pool. */
export function coworkHabits(): ReturnType<typeof makeCoworkHabits> {
    if (!defaultStore) defaultStore = makeCoworkHabits({ ready: initDB });
    return defaultStore;
}
