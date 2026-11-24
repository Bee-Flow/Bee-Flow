/**
 * The database the Cowork stores (stores/cowork*.mts) are handed: the server's pool (../../db.js) or, in a test, a
 * PGlite with the same four calls. Types only.
 */

export type Row = Record<string, unknown>;
export type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };
export type CoworkDb = {
    getAll: (sql: string, params?: unknown[]) => Promise<Row[]>;
    getOne: (sql: string, params?: unknown[]) => Promise<Row | null>;
    run: (sql: string, params?: unknown[]) => Promise<unknown>;
    withTransaction: <T>(fn: (client: Client) => Promise<T>) => Promise<T>;
};
