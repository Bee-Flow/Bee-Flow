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
 */

import { createRequire } from 'node:module';
import type { WriteThrough } from '../triggers/recordOutbox.mts';

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
