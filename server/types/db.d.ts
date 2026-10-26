// Ambient types for the database layer in JSDoc (scripts/typecheck.mjs). Types only: nothing here
// exists at runtime.

import type { QueryResultRow } from 'pg';

declare global {
    /**
     * What a store factory needs of a database: a pool, a transaction client or a test fake.
     * `rowCount` is `null` for statements that report no count, as in `pg`.
     */
    interface DbQueryable {
        query(sql: string, params?: unknown[]): Promise<{ rows: QueryResultRow[]; rowCount?: number | null }>;
    }
}

export {};
