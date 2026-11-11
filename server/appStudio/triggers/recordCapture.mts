/**
 * Record triggers, the WRITE side of a write of SEVERAL ROWS: a batch create (writeRecordBatch),
 * an update or delete of the rows matching a filter (bulkRecords.mts), the by-id children of a
 * transaction step, a replace (replaceRecords.mts) and a delete that follows delete rules onto
 * linked records (cascadeDelete.mts). Each of them compiles its own statements; they hand those
 * here as SEGMENTS and get back either null (run them as always) or a capture that runs them.
 * The one-row write stays in recordOutbox.mts `writeThrough`; the rules are the same ones
 * (recordTriggerRule.mts), and every change is written by the same `recordChanges`.
 *
 * A SEGMENT is some statements of the caller's batch and, when they change known rows of one
 * table, that table, the event and the ids. Only a segment with FIXED IDS can be recorded: the
 * rows are read by id before and after, so the answer never rests on a filter matching twice.
 *
 * WHAT A WRITE PAYS.
 *   - No origin (recordTriggerRule.mts rule 1): nothing, the armed list is not even asked.
 *   - No segment whose table has an armed trigger for its event: a look in memory; the caller
 *     runs exactly the statements, and the store call, it always ran.
 *   - Otherwise ONE batch on the app's database, the caller's statements in their order with,
 *     around each armed segment, the rows as the owner reads them (queryCompiler.OWNER_ACCESS):
 *     before (update, delete), after (create, update). READ_CHUNK ids per read.
 *
 * WHICH ROWS CHANGED. create: the ids that are there afterwards. update and delete: the rows
 * read before, when the segment's statements changed exactly that many rows. When they changed
 * fewer (a row was changed by someone else between the pick and the write), which ones cannot be
 * told: NOTHING of that segment is recorded and its triggers say so. An event is lost, never
 * invented.
 *
 * THE CAP. A write about to change more than STUDIO_APP_RECORD_TRIGGER_MAX_ROWS_PER_WRITE rows of
 * armed tables (default 1000, 0 = unlimited; counted before the write, over all its segments),
 * or whose reads would not fit one batch, records NOTHING: the statements run as always and
 * every trigger concerned shows "skipped: too many rows in one write". Never a part of the rows:
 * a trigger that saw half a write would be wrong about the other half in silence.
 *
 * One delivery per changed row and armed trigger, in the order of the statements, written after
 * the batch committed (so a transaction step that rolls back records nothing). The limits that
 * hold a burst back count deliveries, so rows: the pending cap of the app at the write, the
 * writer's burst and the per-app limits at the fire (recordDrain.mts).
 */

import { READ_CHUNK, hooksFor, noteHooks, outboxDeps, ownTable, recordChanges } from './recordOutbox.mts';
import type { ArmedHook, Change, OutboxApp, OutboxDeps, OutboxStatement, OutboxTable } from './recordOutbox.mts';
import { recordLimitLabel } from './recordTriggerLimits.mts';
import { readWriteSource } from './recordTriggerRule.mts';
import type { RecordEvent, WriteSource } from './recordTriggerRule.mts';

type Obj = Record<string, unknown>;
type Result = { rows?: Obj[]; changes?: number };

/** The most statements one batch of the app's database takes (stores/lib: MAX_BATCH_STATEMENTS). */
const MAX_BATCH_STATEMENTS = 500;

export type SegmentRows = { table: unknown; event: RecordEvent; ids: string[] };
/** `rows`: the statements change exactly these rows of one table (update, delete), or create them (and may also write their links). */
export type Segment = { statements: OutboxStatement[]; rows?: SegmentRows };
/** Who writes: `source` is the write's origin (rule 1), `viewer` the writer. */
export type WriteBy = { source?: unknown; viewer?: unknown };

export type Capture = {
    /**
     * Run the statements through `batch` (one transaction) with the reads around them, record the
     * changes, and answer the results of the caller's own statements, in their order. A
     * `batch_no_rows` failure names the caller's statement, not a read.
     */
    run: (batch: (statements: OutboxStatement[]) => Promise<unknown>) => Promise<Result[]>;
};

type Armed = { table: OutboxTable; event: RecordEvent; ids: string[]; hooks: ArmedHook[] };
/** Where a segment's statements and reads sit in the batch. */
type Slot = { armed: Armed | null; before: number[]; writes: number[]; after: number[] };
type Built = { statements: OutboxStatement[]; slots: Slot[] };

async function armedOf(app: OutboxApp, segment: Segment, d: OutboxDeps): Promise<Armed | null> {
    const rows = segment.rows;
    const table = rows ? ownTable(rows.table) : null;
    if (!rows || !table || !rows.ids.length) return null;
    const hooks = (await hooksFor(app.id, table, d)).filter((h) => h.on.includes(rows.event));
    return hooks.length ? { table, event: rows.event, ids: rows.ids, hooks } : null;
}

function build(segments: Segment[], armed: Array<Armed | null>, d: OutboxDeps): Built {
    const statements: OutboxStatement[] = [];
    const push = (list: OutboxStatement[]): number[] => list.map((s) => statements.push(s) - 1);
    const reads = (a: Armed): OutboxStatement[] => {
        const out: OutboxStatement[] = [];
        for (let i = 0; i < a.ids.length; i += READ_CHUNK) out.push(d.compileReadMany(a.table, a.ids.slice(i, i + READ_CHUNK)));
        return out;
    };
    const slots = segments.map((segment, i): Slot => {
        const a = armed[i];
        const before = a && a.event !== 'create' ? push(reads(a)) : [];
        const writes = push(segment.statements);
        const after = a && a.event !== 'delete' ? push(reads(a)) : [];
        return { armed: a, before, writes, after };
    });
    return { statements, slots };
}

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function rowsAt(results: Result[], at: number[]): Map<string, Obj> {
    const out = new Map<string, Obj>();
    for (const i of at) for (const row of results[i]?.rows ?? []) if (isObject(row)) out.set(String(row.id), row);
    return out;
}

/** The changes of one armed segment, or null when they cannot be told apart (see the header). */
function changesOf(slot: Slot, a: Armed, results: Result[]): Change[] | null {
    const before = rowsAt(results, slot.before);
    const after = rowsAt(results, slot.after);
    if (a.event === 'create') {
        return a.ids.filter((id) => after.has(id)).map((id) => ({ event: a.event, rowId: id, before: null, after: after.get(id) ?? null }));
    }
    const wrote = slot.writes.reduce((n, i) => n + (Number(results[i]?.changes) || 0), 0);
    if (wrote !== before.size) return null;
    const ids = a.ids.filter((id) => before.has(id) && (a.event === 'delete' || after.has(id)));
    return ids.map((id) => ({ event: a.event, rowId: id, before: before.get(id) ?? null, after: a.event === 'delete' ? null : after.get(id) ?? null }));
}

const CHANGED_MEANWHILE = 'Skipped: rows of this table were changed by someone else while a write of several rows ran, so the changes of that write could not be told apart and none of them started this trigger.';

async function record(app: OutboxApp, built: Built, results: Result[], source: WriteSource, viewer: unknown, d: OutboxDeps): Promise<void> {
    for (const slot of built.slots) {
        const a = slot.armed;
        if (!a) continue;
        const changes = changesOf(slot, a, results);
        if (changes === null) await noteHooks(app, a.hooks, CHANGED_MEANWHILE, d);
        else if (changes.length) await recordChanges(app, a.table, a.hooks, changes, source, viewer, d);
    }
}

/** The reason a write records nothing because of its size, or null. */
function tooMany(rows: number, statements: number, d: OutboxDeps): string | null {
    const limits = d.limits();
    if (limits.maxRowsPerWrite && rows > limits.maxRowsPerWrite) {
        return `Skipped: too many rows in one write. It changed ${rows} rows, and a record trigger takes at most ${limits.maxRowsPerWrite} from one write, so none of them started it (${recordLimitLabel(limits, 'maxRowsPerWrite')}).`;
    }
    if (statements > MAX_BATCH_STATEMENTS) return `Skipped: too many rows in one write. It changed ${rows} rows, more than one write can record, so none of them started this trigger.`;
    return null;
}

/** A failed batch names the statement that changed no row: give the caller the place in ITS list. */
function inCallersTerms(e: unknown, built: Built): unknown {
    const at = isObject(e) ? e.statementIndex : undefined;
    if (!isObject(e) || typeof at !== 'number' || !Number.isInteger(at)) return e;
    const own = built.slots.flatMap((slot) => slot.writes);
    const index = own.indexOf(at);
    if (index >= 0) e.statementIndex = index;
    return e;
}

/**
 * The capture for a write made of `segments`, or null when the write goes its usual way: it names
 * no origin, no segment's table has an armed trigger for its event, or it is too large (then its
 * triggers say so). Never throws: a capture that cannot be prepared is logged and the write goes
 * its usual way.
 */
export async function planCapture(app: OutboxApp, segments: Segment[], by: WriteBy): Promise<Capture | null> {
    const source = by.source === undefined || by.source === null ? null : readWriteSource(by.source);
    if (!source) return null;
    const d = outboxDeps();
    let built: Built;
    try {
        const armed: Array<Armed | null> = [];
        for (const segment of segments) armed.push(await armedOf(app, segment, d));
        const live = armed.filter((a): a is Armed => a !== null);
        if (!live.length) return null;
        built = build(segments, armed, d);
        const reason = tooMany(live.reduce((n, a) => n + a.ids.length, 0), built.statements.length, d);
        if (reason) {
            await noteHooks(app, live.flatMap((a) => a.hooks), reason, d);
            return null;
        }
    } catch (e) {
        d.log.warn(`[StudioRecordTriggers] app=${app.id} a write of several rows could not be prepared for its triggers (${(e as Error)?.name || 'error'}); they do not fire for it`);
        return null;
    }
    return {
        async run(batch) {
            let results: Result[];
            try {
                results = (await batch(built.statements) ?? []) as Result[];
            } catch (e) {
                throw inCallersTerms(e, built);
            }
            try {
                await record(app, built, results, source, by.viewer, d);
            } catch (e) {
                // The write is committed: a failure to record it never fails it.
                d.log.warn(`[StudioRecordTriggers] app=${app.id} a write of several rows could not be recorded (${(e as Error)?.name || 'error'}); its triggers do not fire for it`);
            }
            return built.slots.flatMap((slot) => slot.writes.map((i) => results[i]));
        },
    };
}

/** Does `table` have an armed record trigger for `event`, for a write that names `source`? (A caller that compiles differently when it has.) */
export async function armedOn(app: OutboxApp, table: unknown, rawSource: unknown, event: RecordEvent): Promise<boolean> {
    if (rawSource === undefined || rawSource === null || !readWriteSource(rawSource)) return false;
    const own = ownTable(table);
    if (!own) return false;
    try {
        return (await hooksFor(app.id, own, outboxDeps())).some((h) => h.on.includes(event));
    } catch {
        return false;
    }
}
