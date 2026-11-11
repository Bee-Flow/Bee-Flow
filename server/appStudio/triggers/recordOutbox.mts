/**
 * Record triggers, the WRITE side: the record write path (actionExecutor/records.js) asks here
 * whether the table it is about to write has an armed record trigger, and if so writes through
 * here, so the change lands in the outbox (stores/studioAppData/recordEvents.mts).
 *
 * WHAT A TABLE WITHOUT A TRIGGER PAYS. Nothing but a look in memory. A write that names no
 * origin (recordTriggerRule.mts rule 1) does not even ask. The armed triggers of kind `record`
 * of ALL apps are kept as one small map, read with one query, again after
 * STUDIO_APP_RECORD_TRIGGER_ARMED_REFRESH_MS and at once on the replica that published
 * (`invalidateArmed`, from triggerSync.mts). Another replica therefore starts to record up to
 * that many seconds after a publish, and stops as late after an unpublish; the fire checks the
 * trigger again, so a late event starts nothing it should not.
 *
 * WHAT AN ARMED TABLE PAYS. The write becomes one batch on the app's database (one transaction
 * on both engines): the row as it was (update, delete), the write itself, the row as it is
 * (create, update), read as the owner reads them. Then the deliveries are written to the outbox.
 *
 * NOT ONE TRANSACTION WITH THE OUTBOX. The app's rows live in the app's own database (a file
 * per app, or a schema per app) and the outbox in the platform's. The outbox row is written
 * right after the app's transaction committed: a crash in between loses that one event, and
 * nothing is ever delivered twice. A change whose write failed or touched no row records nothing.
 *
 * A failure to record never fails the write that already happened: it is logged (ids and codes
 * only) and the event is lost.
 */

import { createRequire } from 'node:module';
import type { ArmedRecordTrigger, NewDelivery, RecordEventStore } from '../../stores/studioAppData/recordEvents.mts';
import { recordLimitLabel, recordTriggerLimits } from './recordTriggerLimits.mts';
import type { RecordTriggerLimits } from './recordTriggerLimits.mts';
import { deliveryRefusal, readWriteSource, writerKeyOf, writerKindOf } from './recordTriggerRule.mts';
import type { RecordEvent, WriteSource } from './recordTriggerRule.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

type App = { id: string; userId: string };
type Table = Obj & { id?: string; key: string };
type Statement = { sql: string; params: unknown[]; expectChanges?: boolean };
/** The app's database, as records.js holds it (stores/studioAppDbStore). */
type AppDb = { batch: (ownerId: string, appId: string, statements: Statement[]) => Promise<Array<{ rows?: Obj[]; changes?: number }>> };

export type ArmedHook = { triggerId: string; on: string[]; allowPublicWrites: boolean };

export type OutboxDeps = {
    store: () => RecordEventStore;
    now: () => number;
    limits: () => RecordTriggerLimits;
    log: { warn: (...a: unknown[]) => void };
    /** `SELECT` of one row by id as the owner reads it. */
    compileRead: (table: Table, id: string) => Statement;
};

function defaultDeps(): OutboxDeps {
    return {
        store: () => (nodeRequire('../../stores/studioAppData/recordEvents.mts') as { recordEventStore: () => RecordEventStore }).recordEventStore(),
        now: () => Date.now(),
        limits: () => recordTriggerLimits(),
        log: nodeRequire('../../telemetry/log') as OutboxDeps['log'],
        compileRead: (table, id) => {
            const compiler = nodeRequire('../queryCompiler') as { compileGetById: (t: unknown, id: string, f: { where: string; params: unknown[] }) => Statement };
            const { sql, params } = compiler.compileGetById(table, id, { where: '1=1', params: [] });
            return { sql, params };
        },
    };
}

let given: Partial<OutboxDeps> = {};
const deps = (): OutboxDeps => ({ ...defaultDeps(), ...given });

// ── The armed set ───────────────────────────────────────────────────────────

/** app id -> table id -> the armed record triggers on it. */
let armed: Map<string, Map<string, ArmedHook[]>> | null = null;
let loadedAt = 0;
let loading: Promise<void> | null = null;

function index(rows: ArmedRecordTrigger[]): Map<string, Map<string, ArmedHook[]>> {
    const out = new Map<string, Map<string, ArmedHook[]>>();
    for (const row of rows) {
        const tableId = typeof row.config.tableId === 'string' ? row.config.tableId : '';
        if (!tableId) continue;
        const on = Array.isArray(row.config.on) ? row.config.on.filter((e): e is string => typeof e === 'string') : [];
        const tables = out.get(row.appId) ?? new Map<string, ArmedHook[]>();
        const list = tables.get(tableId) ?? [];
        list.push({ triggerId: row.triggerId, on, allowPublicWrites: row.config.allowPublicWrites === true });
        tables.set(tableId, list);
        out.set(row.appId, tables);
    }
    return out;
}

async function refresh(d: OutboxDeps): Promise<void> {
    try {
        armed = index(await d.store().armedRecordTriggers());
    } catch (e) {
        // Without the list nothing is recorded: an event is lost, never invented.
        armed = armed ?? new Map();
        d.log.warn(`[StudioRecordTriggers] the armed record triggers could not be read (${(e as Error)?.name || 'error'})`);
    }
    loadedAt = d.now();
}

/** Forget the list: the next write reads it again (a publish or an unpublish on this replica). */
export function invalidateArmed(): void {
    armed = null;
    loadedAt = 0;
}

/** The armed record triggers on `table` of `app` (by the table's id or its storage name). */
async function hooksFor(appId: string, table: Table, d: OutboxDeps): Promise<ArmedHook[]> {
    if (armed === null || d.now() - loadedAt >= d.limits().armedRefreshMs) {
        loading = loading ?? refresh(d).finally(() => { loading = null; });
        await loading;
    }
    const tables = armed?.get(appId);
    if (!tables) return [];
    const byId = typeof table.id === 'string' ? tables.get(table.id) ?? [] : [];
    const byKey = table.key !== table.id ? tables.get(table.key) ?? [] : [];
    return byKey.length ? [...byId, ...byKey] : byId;
}

// ── The write ───────────────────────────────────────────────────────────────

const SYSTEM_STAMPS = ['updated_at'];

/** The field names whose value differs between two rows (the update stamp aside). */
export function changedFields(before: Obj | null, after: Obj | null): string[] {
    if (!before || !after) return [];
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...names].filter((name) => !SYSTEM_STAMPS.includes(name) && JSON.stringify(before[name] ?? null) !== JSON.stringify(after[name] ?? null)).sort();
}

export type Change = { event: RecordEvent; rowId: string; before: Obj | null; after: Obj | null };

export type WriteThrough = {
    /**
     * Run one write statement, with `links` (the row's many-relation links, linkWrites.mts) in the
     * same transaction; the number of rows it changed. The change is recorded when it changed one.
     */
    exec: (event: RecordEvent, rowId: string, statement: Statement, links?: Statement[]) => Promise<number>;
};

async function recordChanges(app: App, table: Table, hooks: ArmedHook[], changes: Change[], source: WriteSource, viewer: unknown, d: OutboxDeps): Promise<void> {
    try {
        const limits = d.limits();
        const store = d.store();
        const writerKind = writerKindOf(source, viewer, app.userId);
        const writerKey = writerKeyOf(writerKind, viewer, app.id, source);
        const depth = source.kind === 'trigger' ? source.depth : 0;
        const causeTriggerId = source.kind === 'trigger' ? source.triggerId : null;
        const tableId = typeof table.id === 'string' && table.id ? table.id : table.key;
        const list: NewDelivery[] = [];
        const refusedNotes = new Map<string, string>();
        for (const change of changes) {
            for (const hook of hooks) {
                const refusal = deliveryRefusal({ event: change.event, writerKind, depth, causeTriggerId }, hook, table, limits.maxDepth);
                if (refusal) {
                    // The loop guard and the public-table rule are shown on the trigger; an event it does not listen to is not news.
                    if (refusal.code === 'depth' || refusal.code === 'public_write') refusedNotes.set(hook.triggerId, refusal.reason);
                    continue;
                }
                list.push({ appId: app.id, triggerId: hook.triggerId, tableId, event: change.event, rowId: change.rowId, before: change.before, after: change.after, writerKind, writerKey, depth, causeTriggerId });
            }
        }
        for (const [triggerId, reason] of refusedNotes) await store.noteSkip(app.id, triggerId, 'skipped', reason);
        if (!list.length) return;
        const { dropped } = await store.add(list, d.now(), limits.maxPending);
        for (const triggerId of new Set(dropped)) {
            await store.noteSkip(app.id, triggerId, 'skipped', `Skipped: ${limits.maxPending} changes of this app were already waiting for their run, so this one was dropped (${recordLimitLabel(limits, 'maxPending')}).`);
        }
    } catch (e) {
        d.log.warn(`[StudioRecordTriggers] app=${app.id} a change could not be recorded (${(e as Error)?.name || 'error'}); its triggers do not fire for it`);
    }
}

const firstRow = (result: { rows?: Obj[] } | undefined): Obj | null => (result && Array.isArray(result.rows) && isObject(result.rows[0]) ? result.rows[0] : null);

/**
 * The write-through for a write of `table` that names `source`, or null when the write goes its
 * usual way: no origin, no armed trigger on the table, or a table that is not the app's own.
 */
export async function writeThrough(app: App, table: unknown, rawSource: unknown, viewer: unknown, db: AppDb): Promise<WriteThrough | null> {
    const source = readWriteSource(rawSource);
    if (!source || !isObject(table) || typeof table.key !== 'string' || (table.source !== undefined && table.source !== null)) return null;
    const d = deps();
    const t = table as Table;
    const hooks = await hooksFor(app.id, t, d);
    if (!hooks.length) return null;
    return {
        async exec(event, rowId, statement, links = []) {
            const read = d.compileRead(t, rowId);
            const statements = event === 'create' ? [statement, ...links, read] : event === 'update' ? [read, statement, ...links, read] : [read, statement];
            const results = await db.batch(app.userId, app.id, statements);
            const writeAt = event === 'create' ? 0 : 1;
            const changes = Number(results[writeAt]?.changes) || 0;
            if (changes > 0) {
                const before = event === 'create' ? null : firstRow(results[0]);
                const after = event === 'delete' ? null : firstRow(results[results.length - 1]);
                await recordChanges(app, t, hooks, [{ event, rowId, before, after }], source, viewer, d);
            }
            return changes;
        },
    };
}

/** Test-only: run with other dependencies and an empty armed list. */
export function _setOutboxDeps(over: Partial<OutboxDeps>): void {
    given = over;
    invalidateArmed();
}
