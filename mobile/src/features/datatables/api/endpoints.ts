/**
 * Datatable endpoints, under /api/datatables (server/routes/datatables/**):
 * the tables, their columns, their sharing and who uses them. The rows are in
 * rows.ts.
 *
 * NOTHING HERE TAKES SQL. Every body is the server's closed descriptor, and
 * every body is `.strict()` on the server: a key it does not know is a 400,
 * so nothing here sends a convenience field and hopes.
 *
 * The mount is gated by the `automations` beta; reads and row writes on a
 * table the caller already holds a grade on are never licence-gated, while
 * SHARING is the paid boundary (402 `capability_required`).
 */

import { api } from '@/core/api/client';

import {
    readDirectory,
    readDraft,
    readGrants,
    readSchema,
    readTableEnvelope,
    readTableList,
    readUsage,
} from './readers';
import type {
    ColumnDraft,
    Datatable,
    DatatableList,
    Directory,
    Grant,
    Schema,
    SharingDescriptor,
    TableDraft,
    TablePatch,
    UsageRow,
} from '../model/types';

const BASE = '/api/datatables';
export const tablePath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

/** Every table the caller holds any grade on, across both scopes, and where a new one would go. */
export async function listDatatables(signal?: AbortSignal): Promise<DatatableList> {
    return readTableList(await api.get<unknown>(BASE, { signal }));
}

export async function getDatatable(id: string, signal?: AbortSignal): Promise<Datatable | null> {
    return readTableEnvelope(await api.get<unknown>(tablePath(id), { signal }));
}

export interface CreateBody {
    /** 'organisation' or 'personal' — a word, judged by the server (`bad_scope`). */
    scope?: 'organisation' | 'personal';
    name: string;
    key: string;
    /** The Art. 30 purpose; the server refuses it blank. */
    description: string;
    fields: ColumnDraft[];
}

/** POST / — the table row, its model and its CREATE TABLE land in one transaction. */
export async function createDatatable(body: CreateBody): Promise<Datatable | null> {
    return readTableEnvelope(await api.post<unknown>(BASE, body));
}

/** The keys PATCH /:id takes from the phone; the server refuses any other by name (`unknown_field`). */
const PATCH_KEYS = ['name', 'description', 'retentionDays', 'retentionField'] as const;

/**
 * PATCH /:id — name, purpose, and the retention window with the date column it
 * counts from. The body is built from an allow-list, and a key left undefined
 * is not sent: `{retentionDays: null}` must reach the server as exactly that.
 * The pair itself is held together by `TablePatch` (see RetentionPatch).
 */
export async function updateDatatable(id: string, patch: TablePatch): Promise<Datatable | null> {
    const body = Object.fromEntries(PATCH_KEYS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
    return readTableEnvelope(await api.patch<unknown>(tablePath(id), body));
}

/**
 * DELETE /:id. Refused 409 `in_use` (with the usage list) while automations
 * still name the table; `confirmBreaking` only after that list was shown.
 * On the query string: a DELETE body is dropped by enough proxies.
 */
export async function deleteDatatable(id: string, confirmBreaking = false): Promise<void> {
    await api.delete(tablePath(id), confirmBreaking ? { query: { confirmBreaking: 'true' } } : undefined);
}

export async function getSchema(id: string, signal?: AbortSignal): Promise<Schema> {
    return readSchema(await api.get<unknown>(`${tablePath(id)}/schema`, { signal }));
}

/**
 * PUT /:id/schema — the WHOLE column list against the version it was read at.
 * Two different 409s come back: `version_conflict` (reload) and
 * `breaking_change` (an automation reads a column this drops — ask, then send
 * `confirmBreaking`).
 */
export async function saveSchema(
    id: string,
    fields: ColumnDraft[],
    expectedVersion: number,
    confirmBreaking = false,
): Promise<Schema> {
    return readSchema(await api.put<unknown>(`${tablePath(id)}/schema`, { fields, expectedVersion, confirmBreaking }));
}

/** PUT /:id/sharing — one audience word, never the old `{isPublished, sharedGroups}` pair. */
export async function setSharing(id: string, descriptor: SharingDescriptor): Promise<Datatable | null> {
    return readTableEnvelope(await api.put<unknown>(`${tablePath(id)}/sharing`, descriptor));
}

export async function listGrants(id: string, signal?: AbortSignal): Promise<Grant[]> {
    return readGrants(await api.get<unknown>(`${tablePath(id)}/grants`, { signal }));
}

/** POST /:id/grants upserts on (table, principal): re-granting is how a grade changes. */
export async function addGrant(
    id: string,
    grant: Pick<Grant, 'granteeType' | 'granteeId' | 'grade'>,
): Promise<Grant[]> {
    // Built from an allow-list: the body is `.strict()`, so a stray `id` would be a 400.
    const body = { granteeType: grant.granteeType, granteeId: grant.granteeId, grade: grant.grade };
    return readGrants(await api.post<unknown>(`${tablePath(id)}/grants`, body));
}

/** Never licence-gated: removing access must always be possible. */
export async function removeGrant(id: string, grantId: string): Promise<Grant[]> {
    return readGrants(await api.delete<unknown>(`${tablePath(id)}/grants/${encodeURIComponent(grantId)}`));
}

export async function listUsage(id: string, signal?: AbortSignal): Promise<UsageRow[]> {
    return readUsage(await api.get<unknown>(`${tablePath(id)}/usage`, { signal }));
}

/**
 * Names for grant rows. `/auth/users` and `/auth/groups` refuse anyone
 * without a directory permission, so this never throws: a refusal is an
 * empty list and the sheet shows ids.
 */
export async function getDirectory(signal?: AbortSignal): Promise<Directory> {
    const [users, groups] = await Promise.all([
        api.get<unknown>('/auth/users', { signal, retry: false }).catch(() => null),
        api.get<unknown>('/auth/groups', { signal, retry: false }).catch(() => null),
    ]);
    return readDirectory(users, groups);
}

/** POST /ai/draft, create mode: columns drafted from a brief. Nothing is stored. */
export async function draftDatatable(brief: string): Promise<TableDraft | null> {
    return readDraft(await api.post<unknown>(`${BASE}/ai/draft`, { mode: 'create', brief }));
}
