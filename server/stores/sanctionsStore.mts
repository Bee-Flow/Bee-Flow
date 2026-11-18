/**
 * sanctionsStore.mts: the imported sanctions lists, one instance-wide copy that every
 * organisation screens against (public data: nothing here belongs to an organisation or a user,
 * and nothing about a screening is written).
 *
 *   sanctions_lists     one row per list: status, counts, when it was last tried and last
 *                       replaced, the last error, and the download's ETag / Last-Modified /
 *                       content hash (an unchanged file is not parsed again);
 *   sanctions_entities  one row per listed person, organisation, vessel or aircraft;
 *   sanctions_names     every name of an entry with its lookup keys (core/sanctions/entity.mts
 *                       indexEntity, computed by the caller), GIN-indexed: the screening asks for the names that share a key
 *                       with the query and scores those in JavaScript. No pg_trgm needed.
 *
 *   replaceList(id, label, entities, meta)   the list's rows swapped in ONE transaction
 *   recordFailure(id, label, error)          a failed refresh; the rows stay as they were
 *   recordUnchanged(id, label, meta)         the file had not changed since the last import
 *   candidates(keys, lists, limit)           the stored names sharing a key, with their entity
 *   listStatus()                             every list's row
 *   anyOrganisationUses(integrationId)       is the integration switched on anywhere?
 *
 * makeSanctionsStore(db) takes the `{ query, tx }` of testUtils/pgliteDb.js; `sanctionsStore()`
 * is the same store on the server's pool, its schema created through makeStoreInit (the ledger)
 * and registered in storeModules.js.
 */

import { createRequire } from 'node:module';
import type { IndexedEntity } from '../core/sanctions/entity.mts';
import type { CandidateRow } from '../core/sanctions/screen.mts';

const nodeRequire = createRequire(import.meta.url);

export interface Queryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface StoreDb extends Queryable {
    tx<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
}

export const SANCTIONS_DDL: readonly string[] = Object.freeze([
    `CREATE TABLE IF NOT EXISTS sanctions_lists (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'never',
        entity_count INT NOT NULL DEFAULT 0,
        name_count INT NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        last_success_at TIMESTAMPTZ,
        replaced_at TIMESTAMPTZ,
        last_error TEXT,
        etag TEXT,
        last_modified TEXT,
        content_hash TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sanctions_entities (
        list_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'unknown',
        primary_name TEXT NOT NULL,
        birth_dates JSONB NOT NULL DEFAULT '[]',
        countries JSONB NOT NULL DEFAULT '[]',
        programmes JSONB NOT NULL DEFAULT '[]',
        reference TEXT,
        url TEXT,
        PRIMARY KEY (list_id, entity_id)
    )`,
    `CREATE TABLE IF NOT EXISTS sanctions_names (
        list_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        name TEXT NOT NULL,
        keys TEXT[] NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS sanctions_names_keys_idx ON sanctions_names USING GIN (keys)',
    'CREATE INDEX IF NOT EXISTS sanctions_names_entity_idx ON sanctions_names (list_id, entity_id)',
]);

export interface ListStatusRow {
    id: string;
    label: string;
    status: 'never' | 'ok' | 'error';
    entityCount: number;
    nameCount: number;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    replacedAt: string | null;
    lastError: string | null;
    etag: string | null;
    lastModified: string | null;
    contentHash: string | null;
}

export interface DownloadMeta {
    etag?: string | null;
    lastModified?: string | null;
    contentHash?: string | null;
}

export interface SanctionsStore {
    replaceList(listId: string, label: string, entities: IndexedEntity[], meta: DownloadMeta): Promise<{ entities: number; names: number }>;
    recordFailure(listId: string, label: string, error: string): Promise<void>;
    recordUnchanged(listId: string, label: string, meta: DownloadMeta): Promise<void>;
    candidates(keys: string[], lists: string[] | null, limit: number): Promise<CandidateRow[]>;
    listStatus(): Promise<ListStatusRow[]>;
    anyOrganisationUses(integrationId: string): Promise<boolean>;
}

const BATCH = 1000;
const MAX_ERROR_CHARS = 500;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const jsonList = (v: unknown): string[] => {
    const parsed = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return []; } })() : v;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
};

function toStatus(r: Record<string, any>): ListStatusRow {
    return {
        id: r.id, label: r.label, status: r.status, entityCount: Number(r.entity_count) || 0, nameCount: Number(r.name_count) || 0,
        lastAttemptAt: iso(r.last_attempt_at), lastSuccessAt: iso(r.last_success_at), replacedAt: iso(r.replaced_at),
        lastError: r.last_error ?? null, etag: r.etag ?? null, lastModified: r.last_modified ?? null, contentHash: r.content_hash ?? null,
    };
}

/** One row per entity id: a list that names an id twice keeps the first entry. */
function uniqueEntities(entities: IndexedEntity[]): IndexedEntity[] {
    const seen = new Set<string>();
    return entities.filter((e) => (seen.has(e.entityId) ? false : (seen.add(e.entityId), true)));
}

async function insertEntities(c: Queryable, listId: string, batch: IndexedEntity[]): Promise<void> {
    await c.query(
        `INSERT INTO sanctions_entities (list_id, entity_id, kind, primary_name, birth_dates, countries, programmes, reference, url)
         SELECT $1, t.id, t.kind, t.primary_name, t.dates::jsonb, t.countries::jsonb, t.programmes::jsonb, t.reference, t.url
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
                AS t(id, kind, primary_name, dates, countries, programmes, reference, url)`,
        [
            listId, batch.map((e) => e.entityId), batch.map((e) => e.kind), batch.map((e) => e.names[0]),
            batch.map((e) => JSON.stringify(e.birthDates)), batch.map((e) => JSON.stringify(e.countries)),
            batch.map((e) => JSON.stringify(e.programmes)), batch.map((e) => e.reference), batch.map((e) => e.url),
        ],
    );
}

async function insertNames(c: Queryable, listId: string, rows: Array<{ entityId: string; name: string; keys: string }>): Promise<void> {
    await c.query(
        `INSERT INTO sanctions_names (list_id, entity_id, name, keys)
         SELECT $1, t.entity_id, t.name, string_to_array(t.keys, ' ')
           FROM unnest($2::text[], $3::text[], $4::text[]) AS t(entity_id, name, keys)`,
        [listId, rows.map((r) => r.entityId), rows.map((r) => r.name), rows.map((r) => r.keys)],
    );
}

function nameRows(entities: IndexedEntity[]): Array<{ entityId: string; name: string; keys: string }> {
    const out: Array<{ entityId: string; name: string; keys: string }> = [];
    for (const e of entities) {
        e.names.forEach((name, i) => {
            const keys = e.keys[i] ?? [];
            if (keys.length) out.push({ entityId: e.entityId, name, keys: keys.join(' ') });
        });
    }
    return out;
}

const STATUS_UPSERT = `INSERT INTO sanctions_lists (id, label) VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label`;

export function makeSanctionsStore(db: StoreDb, opts: { ready?: () => Promise<unknown> } = {}): SanctionsStore {
    const ready = opts.ready ?? (async () => undefined);

    async function replaceList(listId: string, label: string, entities: IndexedEntity[], meta: DownloadMeta) {
        await ready();
        const unique = uniqueEntities(entities);
        const names = nameRows(unique);
        await db.tx(async (c) => {
            await c.query('DELETE FROM sanctions_names WHERE list_id = $1', [listId]);
            await c.query('DELETE FROM sanctions_entities WHERE list_id = $1', [listId]);
            for (let i = 0; i < unique.length; i += BATCH) await insertEntities(c, listId, unique.slice(i, i + BATCH));
            for (let i = 0; i < names.length; i += BATCH) await insertNames(c, listId, names.slice(i, i + BATCH));
            await c.query(STATUS_UPSERT, [listId, label]);
            await c.query(
                `UPDATE sanctions_lists SET status = 'ok', entity_count = $2, name_count = $3, last_attempt_at = now(),
                        last_success_at = now(), replaced_at = now(), last_error = NULL, etag = $4, last_modified = $5, content_hash = $6
                  WHERE id = $1`,
                [listId, unique.length, names.length, meta.etag ?? null, meta.lastModified ?? null, meta.contentHash ?? null],
            );
        });
        return { entities: unique.length, names: names.length };
    }

    async function recordFailure(listId: string, label: string, error: string) {
        await ready();
        await db.query(
            `INSERT INTO sanctions_lists (id, label, status, last_attempt_at, last_error) VALUES ($1, $2, 'error', now(), $3)
             ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, status = 'error', last_attempt_at = now(), last_error = EXCLUDED.last_error`,
            [listId, label, String(error).slice(0, MAX_ERROR_CHARS)],
        );
    }

    async function recordUnchanged(listId: string, label: string, meta: DownloadMeta) {
        await ready();
        await db.query(
            `INSERT INTO sanctions_lists (id, label, status, last_attempt_at, last_success_at, etag, last_modified, content_hash)
             VALUES ($1, $2, 'ok', now(), now(), $3, $4, $5)
             ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, status = 'ok', last_attempt_at = now(), last_success_at = now(),
                 last_error = NULL, etag = COALESCE(EXCLUDED.etag, sanctions_lists.etag),
                 last_modified = COALESCE(EXCLUDED.last_modified, sanctions_lists.last_modified),
                 content_hash = COALESCE(EXCLUDED.content_hash, sanctions_lists.content_hash)`,
            [listId, label, meta.etag ?? null, meta.lastModified ?? null, meta.contentHash ?? null],
        );
    }

    async function candidates(keys: string[], lists: string[] | null, limit: number): Promise<CandidateRow[]> {
        if (!keys.length) return [];
        await ready();
        const params: unknown[] = [keys, limit];
        const listFilter = lists && lists.length ? (params.push(lists), 'AND n.list_id = ANY($3::text[])') : '';
        const { rows } = await db.query(
            `SELECT n.list_id, n.entity_id, n.name, e.kind, e.primary_name, e.birth_dates, e.countries, e.programmes, e.reference, e.url
               FROM sanctions_names n
               JOIN sanctions_entities e ON e.list_id = n.list_id AND e.entity_id = n.entity_id
              WHERE n.keys && $1::text[] ${listFilter}
              ORDER BY cardinality(ARRAY(SELECT unnest(n.keys) INTERSECT SELECT unnest($1::text[]))) DESC, n.list_id, n.entity_id
              LIMIT $2`,
            params,
        );
        return rows.map((r) => ({
            listId: r.list_id, entityId: r.entity_id, name: r.name, kind: r.kind, primaryName: r.primary_name,
            birthDates: jsonList(r.birth_dates), countries: jsonList(r.countries), programmes: jsonList(r.programmes),
            reference: r.reference ?? null, url: r.url ?? null,
        }));
    }

    async function listStatus() {
        await ready();
        const { rows } = await db.query('SELECT * FROM sanctions_lists ORDER BY id');
        return rows.map(toStatus);
    }

    async function anyOrganisationUses(integrationId: string) {
        const { rows } = await db.query(
            `SELECT 1 FROM organizations WHERE COALESCE(org_enabled_integrations::text, '') LIKE $1 LIMIT 1`,
            [`%${JSON.stringify(integrationId)}%`],
        );
        return rows.length > 0;
    }

    return { replaceList, recordFailure, recordUnchanged, candidates, listStatus, anyOrganisationUses };
}

// ── The store on the server's pool ──────────────────────────────────

type RealDb = {
    pool: Queryable;
    exec: (sql: string) => Promise<unknown>;
    withTransaction: <T>(fn: (client: Queryable) => Promise<T>) => Promise<T>;
};
type StoreInit = { makeStoreInit: (tag: string, fn: () => Promise<void>) => () => Promise<void> };

const realDb = (): RealDb => nodeRequire('../db.js') as RealDb;

/** The schema init (ledgered, memoised); storeModules.js and boot start it. */
export const initDB: () => Promise<void> = (nodeRequire('./lib/storeInit.js') as StoreInit).makeStoreInit('SanctionsStore', async () => {
    const db = realDb();
    for (const sql of SANCTIONS_DDL) await db.exec(sql);
});

let _default: SanctionsStore | null = null;

export function sanctionsStore(): SanctionsStore {
    if (_default) return _default;
    const db = realDb();
    _default = makeSanctionsStore({
        query: (sql, params) => db.pool.query(sql, params),
        tx: (fn) => db.withTransaction(fn),
    }, { ready: initDB });
    return _default;
}
