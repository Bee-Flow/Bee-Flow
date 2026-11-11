/**
 * One insert, update or delete statement of the record write path (records.js) on the app's own
 * storage, with the link statements of its many relations (linkWrites.mts); the number of rows
 * it changed.
 *
 * A write that names its origin (`by.source`, triggers/recordTriggerRule.mts) asks whether the
 * table has an armed record trigger and then goes through it, so the change lands in the
 * outbox (triggers/recordOutbox.mts says what either costs). Every other write, and every table
 * without such a trigger, is the plain `exec` it always was (or, with links, one batch).
 *
 * With links the row and its links are ONE transaction, and an update must change its row (so
 * a row outside the writer's update rule changes no link either): such an update that changes
 * nothing answers 0.
 *
 * `execSegments` is the same door for the writes of several rows (a batch create, a transaction
 * step, a replace, a delete that follows delete rules); the filter update and delete of
 * bulkRecords.mts go through triggers/recordCapture.mts themselves.
 */

import { createRequire } from 'node:module';
import type { Capture, Segment, WriteBy } from '../triggers/recordCapture.mts';
import type { WriteThrough } from '../triggers/recordOutbox.mts';

export type { Segment, WriteBy };

const nodeRequire = createRequire(import.meta.url);

type App = { id: string; userId: string };
type Statement = { sql: string; params: unknown[]; expectChanges?: boolean };
/** The app's database as records.js holds it (stores/studioAppDbStore). */
export type AppDb = {
    exec: (ownerId: string, appId: string, sql: string, params: unknown[]) => Promise<{ changes?: number } | null | undefined>;
    batch: (ownerId: string, appId: string, statements: Statement[]) => Promise<Array<{ rows?: Record<string, unknown>[]; changes?: number }>>;
};
/** `links`: the statements that replace the row's many-relation links, run in the same transaction. */
export type RecordWrite = { event: 'create' | 'update' | 'delete'; recordId: string; sql: string; params: unknown[]; links?: Statement[] };

/** An update with links that changed no row rolls back as `batch_no_rows`: that is 0 changes. */
async function noRowsIsZero(write: RecordWrite, run: () => Promise<number>): Promise<number> {
    try {
        return await run();
    } catch (e) {
        if (write.event === 'update' && e && (e as { code?: unknown }).code === 'batch_no_rows') return 0;
        throw e;
    }
}

export async function execWrite(db: AppDb, app: App, table: unknown, write: RecordWrite, by: { source?: unknown; viewer?: unknown }): Promise<number> {
    const links = write.links ?? [];
    const statement: Statement = { sql: write.sql, params: write.params, ...(links.length && write.event === 'update' ? { expectChanges: true } : {}) };
    if (by.source !== undefined && by.source !== null) {
        const outbox = nodeRequire('../triggers/recordOutbox.mts') as { writeThrough: (app: App, table: unknown, source: unknown, viewer: unknown, db: AppDb) => Promise<WriteThrough | null> };
        const through = await outbox.writeThrough(app, table, by.source, by.viewer, db);
        if (through) return noRowsIsZero(write, () => through.exec(write.event, write.recordId, statement, links));
    }
    if (links.length) {
        return noRowsIsZero(write, async () => {
            await db.batch(app.userId, app.id, [statement, ...links]);
            return 1;
        });
    }
    const res = await db.exec(app.userId, app.id, write.sql, write.params);
    return res && res.changes ? res.changes : 0;
}

type BatchResult = { rows?: Record<string, unknown>[]; changes?: number };
type BatchDb = { batch: (ownerId: string, appId: string, statements: Statement[]) => Promise<unknown> };

/**
 * A write of SEVERAL rows on the app's own storage: the caller's statements as the ONE batch
 * they always were, in `segments` that say which rows of which table each part changes
 * (triggers/recordCapture.mts). A write that names its origin and touches a table with an armed
 * record trigger is recorded for it; every other write runs exactly the statements it was handed.
 * Answers the results of the caller's statements, in their order.
 */
export async function execSegments(db: BatchDb, app: App, segments: Segment[], by: WriteBy): Promise<BatchResult[]> {
    const run = (statements: Statement[]): Promise<unknown> => db.batch(app.userId, app.id, statements);
    const capture = by.source === undefined || by.source === null
        ? null
        : await (nodeRequire('../triggers/recordCapture.mts') as { planCapture: (app: App, segments: Segment[], by: WriteBy) => Promise<Capture | null> }).planCapture(app, segments, by);
    if (capture) return capture.run(run);
    return (await run(segments.flatMap((s) => s.statements)) ?? []) as BatchResult[];
}

/** N creates of one table, with their link statements, as one batch (writeRecordBatch). */
export async function execCreates(db: BatchDb, app: App, table: unknown, statements: Statement[], ids: string[], by: WriteBy): Promise<void> {
    await execSegments(db, app, [{ statements, rows: { table, event: 'create', ids } }], by);
}
