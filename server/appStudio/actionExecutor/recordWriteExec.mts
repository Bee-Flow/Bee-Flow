/**
 * One insert, update or delete statement of the record write path (records.js) on the app's own
 * storage; the number of rows it changed.
 *
 * A write that names its origin (`by.source`, triggers/recordTriggerRule.mts) asks whether the
 * table has an armed record trigger and then goes through it, so the change lands in the
 * outbox (triggers/recordOutbox.mts says what either costs). Every other write, and every table
 * without such a trigger, is the plain `exec` it always was.
 */

import { createRequire } from 'node:module';
import type { WriteThrough } from '../triggers/recordOutbox.mts';

const nodeRequire = createRequire(import.meta.url);

type App = { id: string; userId: string };
type Statement = { sql: string; params: unknown[] };
/** The app's database as records.js holds it (stores/studioAppDbStore). */
export type AppDb = {
    exec: (ownerId: string, appId: string, sql: string, params: unknown[]) => Promise<{ changes?: number } | null | undefined>;
    batch: (ownerId: string, appId: string, statements: Statement[]) => Promise<Array<{ rows?: Record<string, unknown>[]; changes?: number }>>;
};
export type RecordWrite = { event: 'create' | 'update' | 'delete'; recordId: string; sql: string; params: unknown[] };

export async function execWrite(db: AppDb, app: App, table: unknown, write: RecordWrite, by: { source?: unknown; viewer?: unknown }): Promise<number> {
    if (by.source !== undefined && by.source !== null) {
        const outbox = nodeRequire('../triggers/recordOutbox.mts') as { writeThrough: (app: App, table: unknown, source: unknown, viewer: unknown, db: AppDb) => Promise<WriteThrough | null> };
        const through = await outbox.writeThrough(app, table, by.source, by.viewer, db);
        if (through) return through.exec(write.event, write.recordId, { sql: write.sql, params: write.params });
    }
    const res = await db.exec(app.userId, app.id, write.sql, write.params);
    return res && res.changes ? res.changes : 0;
}
