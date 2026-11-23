/**
 * How Cowork items start, on `cowork_schedules` and `cowork_runs` (core/cowork/startKinds.mts): the item's start, the
 * items that start on another one, on a table or on a call to their address, and where a run came from.
 *
 * `trigger_json` is JSON text; it is read as JSON only for the rows of the start kind asked about (a CASE, so the
 * cast never meets another row's text).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Db = { getOne: (sql: string, params?: unknown[]) => Promise<Row | null>; getAll: (sql: string, params?: unknown[]) => Promise<Row[]>; run: (sql: string, params?: unknown[]) => Promise<unknown> };
type Rows = typeof import('./coworkRows.js');
const { rowToSchedule } = nodeRequire('./coworkRows.js') as Rows;
export type CoworkItem = NonNullable<ReturnType<Rows['rowToSchedule']>>;
const items = (rows: Row[]): CoworkItem[] => rows.map((r) => rowToSchedule(r as unknown as Parameters<Rows['rowToSchedule']>[0])).filter((x): x is CoworkItem => !!x);

export interface RunOrigin { id: string; scheduleId: string; status: string; triggerKind: string | null; triggerRef: string | null; result: string | null }

const BY_FIELD = (kind: string, field: string) => `CASE WHEN trigger_kind = '${kind}' THEN trigger_json::jsonb ->> '${field}' END`;

export function makeCoworkStarts({ db = nodeRequire('../db.js') as Db, ready = async () => {} }: { db?: Db; ready?: () => Promise<unknown> } = {}) {
    /** Set how an item starts. Its plan's approval goes: the plan is approved again for the new start. */
    async function setStart(scheduleId: string, kind: string, trigger: Record<string, unknown> | null): Promise<void> {
        await ready();
        await db.run('UPDATE cowork_schedules SET trigger_kind = $2, trigger_json = $3, plan_id = NULL WHERE id = $1', [scheduleId, kind, trigger ? JSON.stringify(trigger) : null]);
    }

    /** The active items that start when `scheduleId` ended well, of the same owner. */
    async function listFollowers(scheduleId: string, userId: string): Promise<CoworkItem[]> {
        await ready();
        return items(await db.getAll(
            `SELECT * FROM cowork_schedules WHERE is_active = TRUE AND user_id = $2 AND ${BY_FIELD('after_cowork', 'scheduleId')} = $1`,
            [scheduleId, userId],
        ));
    }

    /** The active items that start when rows of `datatableId` change. */
    async function listTableStarters(datatableId: string): Promise<CoworkItem[]> {
        await ready();
        return items(await db.getAll(`SELECT * FROM cowork_schedules WHERE is_active = TRUE AND ${BY_FIELD('row', 'datatableId')} = $1`, [datatableId]));
    }

    /** The item whose address has this token (its sha-256 is stored, never the token). */
    async function findByHookHash(tokenHash: string): Promise<CoworkItem | null> {
        await ready();
        return items(await db.getAll(`SELECT * FROM cowork_schedules WHERE ${BY_FIELD('webhook', 'tokenHash')} = $1 LIMIT 1`, [tokenHash]))[0] ?? null;
    }

    /** Where one run came from, and how it ended. */
    async function runOrigin(runId: string): Promise<RunOrigin | null> {
        await ready();
        const r = await db.getOne('SELECT id, schedule_id, status, trigger_kind, trigger_ref, result FROM cowork_runs WHERE id = $1', [runId]);
        if (!r) return null;
        return {
            id: String(r.id), scheduleId: String(r.schedule_id), status: String(r.status),
            triggerKind: r.trigger_kind ? String(r.trigger_kind) : null, triggerRef: r.trigger_ref ? String(r.trigger_ref) : null,
            result: typeof r.result === 'string' ? r.result : null,
        };
    }

    /** The item's latest run, for the follow-up of a run that just ended. */
    async function latestRunId(scheduleId: string): Promise<string | null> {
        await ready();
        const r = await db.getOne('SELECT id FROM cowork_runs WHERE schedule_id = $1 ORDER BY started_at DESC LIMIT 1', [scheduleId]);
        return r ? String(r.id) : null;
    }

    return { setStart, listFollowers, listTableStarters, findByHookHash, runOrigin, latestRunId };
}

let defaultStarts: ReturnType<typeof makeCoworkStarts> | null = null;

/** The store on the server's pool, after the Cowork schema is there. */
export function coworkStarts(): ReturnType<typeof makeCoworkStarts> {
    if (!defaultStarts) defaultStarts = makeCoworkStarts({ ready: () => (nodeRequire('./coworkStore.js') as { initDB: () => Promise<unknown> }).initDB() });
    return defaultStarts;
}
