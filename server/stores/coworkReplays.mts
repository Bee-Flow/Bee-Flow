/**
 * The replays of Cowork plans (usecases/coworkReplay.mts): "replay on last month". One row per replay of an item's
 * changed plan, `cowork_replays`, and one per past run it replayed, `cowork_replay_events`.
 *
 * Counts and step ids only, never content: a replay row holds how many past runs came out the same, differed, were
 * replayed in part or could not be replayed; an event holds one past run's verdict, the reason it could not be
 * replayed (a code), how many steps had no recording and the ids of the steps that differed.
 *
 * At most one replay runs per item: a partial unique index on the running row, so two presses at once give one
 * replay. A replay that was left running by a server that stopped is closed as failed once it is older than
 * STALE_MINUTES. An item keeps its last KEEP replays; both tables go with their item (and with the account of its
 * owner, stores/user/erasureCoverage.js).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };
type Db = {
    getAll: (sql: string, params?: unknown[]) => Promise<Row[]>;
    getOne: (sql: string, params?: unknown[]) => Promise<Row | null>;
    run: (sql: string, params?: unknown[]) => Promise<unknown>;
    withTransaction: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
};

export const COWORK_REPLAYS_DDL: readonly string[] = Object.freeze([
    `CREATE TABLE IF NOT EXISTS cowork_replays (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES cowork_schedules(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        total INTEGER NOT NULL DEFAULT 0,
        same INTEGER NOT NULL DEFAULT 0,
        differs INTEGER NOT NULL DEFAULT 0,
        partial INTEGER NOT NULL DEFAULT 0,
        not_replayable INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
    )`,
    'CREATE INDEX IF NOT EXISTS idx_cowork_replays_schedule ON cowork_replays (schedule_id, started_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_cowork_replays_user ON cowork_replays (user_id)',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cowork_replays_one_running ON cowork_replays (schedule_id) WHERE status = 'running'`,
    `CREATE TABLE IF NOT EXISTS cowork_replay_events (
        replay_id TEXT NOT NULL REFERENCES cowork_replays(id) ON DELETE CASCADE,
        past_run_id TEXT NOT NULL,
        past_started_at TIMESTAMPTZ,
        verdict TEXT NOT NULL,
        reason TEXT,
        missing_steps INTEGER NOT NULL DEFAULT 0,
        differing_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (replay_id, past_run_id)
    )`,
]);

export const VERDICTS = ['same', 'differs', 'partial', 'not_replayable'] as const;
export type ReplayVerdictName = typeof VERDICTS[number];
const COUNTER: Readonly<Record<ReplayVerdictName, string>> = Object.freeze({ same: 'same', differs: 'differs', partial: 'partial', not_replayable: 'not_replayable' });

/** A replay left running this long was stopped with its server. */
export const STALE_MINUTES = 120;
/** Replays kept per item. */
export const KEEP = 5;

export interface StoredReplay {
    id: string;
    scheduleId: string;
    fingerprint: string;
    status: string;
    total: number;
    same: number;
    differs: number;
    partial: number;
    notReplayable: number;
    startedAt: string | null;
    finishedAt: string | null;
}

export interface ReplayEvent {
    pastRunId: string;
    pastStartedAt: string | null;
    verdict: ReplayVerdictName;
    reason: string | null;
    missingSteps: number;
    differingSteps: string[];
}

/** A finished run of the item, as a replay reads it (newest first). */
export interface PastRunRow {
    id: string;
    startedAt: string | null;
    automationRunId: string | null;
    planDefinition: unknown;
    independence: string | null;
    trustedSteps: string[];
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const parsed = (v: unknown): unknown => {
    if (typeof v !== 'string') return v ?? null;
    try {
        return JSON.parse(v);
    } catch {
        return null;
    }
};
const ids = (v: unknown): string[] => {
    const list = parsed(v);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
};

function replayOf(r: Row): StoredReplay {
    return {
        id: String(r.id), scheduleId: String(r.schedule_id), fingerprint: String(r.fingerprint), status: String(r.status),
        total: Number(r.total) || 0, same: Number(r.same) || 0, differs: Number(r.differs) || 0, partial: Number(r.partial) || 0,
        notReplayable: Number(r.not_replayable) || 0, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
    };
}

function eventOf(r: Row): ReplayEvent {
    const verdict = (VERDICTS as readonly string[]).includes(String(r.verdict)) ? String(r.verdict) as ReplayVerdictName : 'not_replayable';
    return {
        pastRunId: String(r.past_run_id), pastStartedAt: iso(r.past_started_at), verdict, reason: r.reason ? String(r.reason) : null,
        missingSteps: Number(r.missing_steps) || 0, differingSteps: ids(r.differing_steps),
    };
}

export function makeCoworkReplays({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /**
     * Start a replay of an item: answers false, and writes nothing, while another replay of it is running. A replay
     * left running by a stopped server is closed first, and only the item's last KEEP replays stay.
     */
    async function beginReplay(input: { id: string; scheduleId: string; userId: string; fingerprint: string; total: number }): Promise<boolean> {
        await ready();
        return db.withTransaction(async (client) => {
            await client.query(
                `UPDATE cowork_replays SET status = 'failed', finished_at = NOW()
                  WHERE schedule_id = $1 AND status = 'running' AND started_at < NOW() - ($2::int * INTERVAL '1 minute')`,
                [input.scheduleId, STALE_MINUTES],
            );
            const { rows } = await client.query(
                `INSERT INTO cowork_replays (id, schedule_id, user_id, fingerprint, total) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT DO NOTHING RETURNING id`,
                [input.id, input.scheduleId, input.userId, input.fingerprint, input.total],
            );
            if (rows.length === 0) return false;
            await client.query(
                `DELETE FROM cowork_replays WHERE schedule_id = $1 AND id NOT IN (
                    SELECT id FROM cowork_replays WHERE schedule_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2)`,
                [input.scheduleId, KEEP],
            );
            return true;
        });
    }

    /** One past run's verdict, and the replay's count for it, together. */
    async function addEvent(replayId: string, event: ReplayEvent): Promise<void> {
        await ready();
        await db.withTransaction(async (client) => {
            const { rows } = await client.query(
                `INSERT INTO cowork_replay_events (replay_id, past_run_id, past_started_at, verdict, reason, missing_steps, differing_steps)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT DO NOTHING RETURNING past_run_id`,
                [replayId, event.pastRunId, event.pastStartedAt, event.verdict, event.reason, event.missingSteps, JSON.stringify(event.differingSteps)],
            );
            if (rows.length === 0) return;
            await client.query(`UPDATE cowork_replays SET ${COUNTER[event.verdict]} = ${COUNTER[event.verdict]} + 1 WHERE id = $1`, [replayId]);
        });
    }

    /** Close a replay: done, or failed when it stopped before every past run was replayed. */
    async function finishReplay(replayId: string, status: 'done' | 'failed'): Promise<void> {
        await ready();
        await db.run(`UPDATE cowork_replays SET status = $2, finished_at = NOW() WHERE id = $1 AND status = 'running'`, [replayId, status]);
    }

    /** A replay of this item with its events (oldest past run last), or null. */
    async function getReplay(scheduleId: string, replayId: string): Promise<{ replay: StoredReplay; events: ReplayEvent[] } | null> {
        await ready();
        const row = await db.getOne('SELECT * FROM cowork_replays WHERE id = $1 AND schedule_id = $2', [replayId, scheduleId]);
        if (!row) return null;
        const events = await db.getAll(
            'SELECT * FROM cowork_replay_events WHERE replay_id = $1 ORDER BY past_started_at DESC NULLS LAST, past_run_id',
            [replayId],
        );
        return { replay: replayOf(row), events: events.map(eventOf) };
    }

    /** The item's finished runs, newest first, each with the plan it followed then (null when it followed none). */
    async function pastRunsOf(scheduleId: string, limit: number): Promise<PastRunRow[]> {
        await ready();
        const rows = await db.getAll(
            `SELECT r.id, r.started_at, r.automation_run_id, r.independence, r.trusted_steps, p.definition_json
               FROM cowork_runs r LEFT JOIN cowork_plans p ON p.id = r.plan_id AND p.schedule_id = r.schedule_id
              WHERE r.schedule_id = $1 AND r.finished_at IS NOT NULL AND r.status <> 'waiting'
              ORDER BY r.started_at DESC, r.id DESC LIMIT $2`,
            [scheduleId, Math.max(1, Math.min(100, Math.floor(limit) || 1))],
        );
        return rows.map((r) => ({
            id: String(r.id), startedAt: iso(r.started_at), automationRunId: r.automation_run_id ? String(r.automation_run_id) : null,
            planDefinition: parsed(r.definition_json), independence: r.independence ? String(r.independence) : null, trustedSteps: ids(r.trusted_steps),
        }));
    }

    return { beginReplay, addEvent, finishReplay, getReplay, pastRunsOf };
}

type StoreInit = { makeStoreInit: (tag: string, fn: () => Promise<void>) => () => Promise<void> };

/** The schema init (ledgered, memoised), after the Cowork schema it refers to; storeModules.js starts it at boot. */
export const initDB: () => Promise<void> = (nodeRequire('./lib/storeInit.js') as StoreInit).makeStoreInit('CoworkReplaysStore', async () => {
    await (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB();
    const db = nodeRequire('../db.js') as { exec: (sql: string) => Promise<unknown> };
    for (const sql of COWORK_REPLAYS_DDL) await db.exec(sql);
});

let defaultStore: ReturnType<typeof makeCoworkReplays> | null = null;

/** The store on the server's pool. */
export function coworkReplays(): ReturnType<typeof makeCoworkReplays> {
    if (!defaultStore) defaultStore = makeCoworkReplays({ ready: initDB });
    return defaultStore;
}
