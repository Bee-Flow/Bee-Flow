/**
 * Contract readers for /api/datatables, each verified against the server
 * source it reads:
 *
 *   table      routes/datatables/projection.publicTable (+ usageCount on the list)
 *   list       routes/datatables/tables.js GET / — `{datatables, scope}`
 *   schema     routes/datatables/schema.js — `{fields, modelVersion}`, fields as
 *              dataModel/datatableFields.normalizeFields writes them
 *   rows       routes/datatables/rows.js GET /:id/rows —
 *              `{rows, hasMore, count, nextCursor, total}`
 *   grants     stores/datatableStore/rowMappers.rowToGrant — SNAKE_CASE
 *              `grantee_type`/`grantee_id`, not camelCase
 *   usage      stores/datatableStore/usage.listUsage
 *   draft      core/dataEngine/dataModel/datatableDraft.parseDatatableDraft
 */

import { asCount, field, pick, shapeOf } from '@/core/api/contract';

import { COLUMN_TYPE_IDS } from '../model/types';
import type {
    BulkImportResult,
    Column,
    ColumnDraft,
    ColumnType,
    CreateScope,
    Datatable,
    DatatableList,
    Directory,
    Grant,
    RowsPage,
    Schema,
    TableDraft,
    TableRow,
    UsageRow,
} from '../model/types';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A mirror's `source.writable`; null for a table with no source block. */
function sourceWritable(value: unknown): boolean | null {
    if (!isObj(value)) return null;
    return value.writable !== false;
}

const readTableShape = shapeOf({
    id: field.str(''),
    name: field.str(''),
    key: field.str(''),
    description: field.str(''),
    rowCount: field.num(0),
    rowScope: field.oneOf(['all', 'own'] as const, 'all'),
    isPublished: field.bool(false),
    sharedGroups: field.strArray,
    writeMode: field.oneOf(['grants', 'audience'] as const, 'grants'),
    retentionDays: field.numOrNull,
    retentionField: field.strOrNull,
    lastRetentionAt: field.strOrNull,
    managedKind: field.strOrNull,
    source: sourceWritable,
    ownerUserId: field.strOrNull,
    updatedAt: field.strOrNull,
    // 'user' is the one scope that refuses sharing; anything unreadable reads
    // as an organisation table, which is the one that asks before sharing.
    scopeKind: field.oneOf(['org', 'user'] as const, 'org'),
    grade: field.oneOfOrNull(['owner', 'editor', 'viewer'] as const),
    usageCount: field.num(0),
});

export function readTable(raw: unknown): Datatable {
    const { source, ...rest } = readTableShape(raw);
    return { ...rest, sourceWritable: source };
}

/** `{datatable}` — the answer of GET, POST, PATCH and PUT /sharing. Null without one. */
export function readTableEnvelope(raw: unknown): Datatable | null {
    const table = pick(raw, 'datatable');
    return isObj(table) ? readTable(table) : null;
}

const readScope = (value: unknown): CreateScope | null => {
    if (!isObj(value)) return null;
    const kind = value.kind === 'user' || value.kind === 'org' ? value.kind : null;
    return kind ? { kind, id: field.str('')(value.id) } : null;
};

export function readTableList(raw: unknown): DatatableList {
    const rows = pick(raw, 'datatables');
    return {
        tables: Array.isArray(rows) ? rows.filter(isObj).map(readTable) : [],
        scope: readScope(pick(raw, 'scope')),
    };
}

function readColumn(raw: unknown): Column {
    const c = isObj(raw) ? raw : {};
    const type = typeof c.type === 'string' ? c.type : '';
    return {
        id: field.str('')(c.id),
        key: field.str('')(c.key),
        name: field.str('')(c.name),
        type: (COLUMN_TYPE_IDS as readonly string[]).includes(type) || type === 'relation' ? (type as Column['type']) : 'unknown',
        // Options are stored as strings (normalizeOptions); anything else is dropped.
        options: field.strArray(c.options),
        required: c.required === true,
        unique: c.unique === true,
    };
}

export function readSchema(raw: unknown): Schema {
    const fields = pick(raw, 'fields');
    return {
        fields: Array.isArray(fields) ? fields.filter(isObj).map(readColumn).filter((c) => c.key !== '') : [],
        modelVersion: field.num(0)(pick(raw, 'modelVersion')),
    };
}

/** A row keeps every column it came with; only one without an id is dropped. */
function readRow(raw: unknown): TableRow | null {
    if (!isObj(raw)) return null;
    const id = raw.id;
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    return { ...raw, id: String(id) };
}

export function readRowsPage(raw: unknown): RowsPage {
    const rows = pick(raw, 'rows');
    return {
        rows: Array.isArray(rows) ? rows.map(readRow).filter((r): r is TableRow => r !== null) : [],
        hasMore: pick(raw, 'hasMore') === true,
        nextCursor: field.strOrNull(pick(raw, 'nextCursor')),
        total: field.num(0)(pick(raw, 'total')),
    };
}

/** POST /:id/rows answers `{ok, id}` — the id compileInsert minted. */
export function readInsertedId(raw: unknown): string | null {
    const id = pick(raw, 'id');
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/** PUT /:id/rows/:rowId answers `{row}`, the row as it now is. */
export function readRowEnvelope(raw: unknown): TableRow | null {
    return readRow(pick(raw, 'row'));
}

export function readBulkImport(raw: unknown): BulkImportResult {
    const errors = pick(raw, 'errors');
    return {
        inserted: field.num(0)(pick(raw, 'inserted')),
        errors: Array.isArray(errors)
            ? errors.filter(isObj).map((e) => ({ line: field.num(0)(e.line), error: field.str('')(e.error) }))
            : [],
    };
}

/** POST /:id/rows/bulk-delete: `deleted` is what really went, after the access filter. */
export function readBulkDelete(raw: unknown): { deleted: number; requested: number } {
    return { deleted: field.num(0)(pick(raw, 'deleted')), requested: field.num(0)(pick(raw, 'requested')) };
}

function readGrant(raw: unknown): Grant | null {
    if (!isObj(raw)) return null;
    const type = raw.grantee_type ?? raw.granteeType;
    const granteeId = raw.grantee_id ?? raw.granteeId;
    if ((type !== 'user' && type !== 'group') || typeof granteeId !== 'string' || typeof raw.id !== 'string') return null;
    return { id: raw.id, granteeType: type, granteeId, grade: raw.grade === 'editor' ? 'editor' : 'viewer' };
}

export function readGrants(raw: unknown): Grant[] {
    const grants = pick(raw, 'grants');
    return Array.isArray(grants) ? grants.map(readGrant).filter((g): g is Grant => g !== null) : [];
}

const MODES = ['read', 'write', 'readwrite'] as const;

function readUsageRow(raw: Record<string, unknown>): UsageRow {
    return {
        consumerKind: field.str('automation')(raw.consumerKind),
        consumerId: field.str('')(raw.consumerId ?? raw.automationId),
        title: field.strOrNull(raw.consumerTitle ?? raw.automationTitle),
        ownerId: field.strOrNull(raw.consumerOwner ?? raw.automationOwner),
        mode: field.oneOf(MODES, 'read')(raw.mode),
        stepOrdinal: asCount(raw.stepOrdinal),
        stepOp: field.strOrNull(raw.stepOp ?? raw.stepType),
        columns: field.strArray(raw.columns),
        lastRunAt: field.strOrNull(raw.lastRunAt),
    };
}

/** `{usage}` from GET /:id/usage, or the same list inside a 409 `in_use` refusal. */
export function readUsage(raw: unknown): UsageRow[] {
    const usage = pick(raw, 'usage');
    return Array.isArray(usage) ? usage.filter(isObj).map(readUsageRow) : [];
}

const nameOf = (raw: Record<string, unknown>): string => {
    for (const key of ['displayName', 'name', 'username', 'email']) {
        const v = raw[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
};

/** `/auth/users` and `/auth/groups` answer bare arrays; null means "refused". */
export function readDirectory(users: unknown, groups: unknown): Directory {
    const read = (list: unknown) =>
        Array.isArray(list)
            ? list.filter(isObj).filter((x) => typeof x.id === 'string').map((x) => ({ id: x.id as string, name: nameOf(x) }))
            : [];
    return { users: read(users), groups: read(groups), available: Array.isArray(groups) };
}

function readDraftColumn(raw: unknown): ColumnDraft | null {
    if (!isObj(raw) || typeof raw.key !== 'string') return null;
    const type = (COLUMN_TYPE_IDS as readonly string[]).includes(String(raw.type)) ? (raw.type as ColumnType) : 'text';
    const options = field.strArray(raw.options);
    return { key: raw.key, name: field.str(raw.key)(raw.name), type, ...(options.length ? { options } : {}) };
}

/** POST /ai/draft → `{draft}`; null when there is no usable draft. */
export function readDraft(raw: unknown): TableDraft | null {
    const draft = pick(raw, 'draft');
    if (!isObj(draft) || !Array.isArray(draft.fields)) return null;
    return {
        name: field.str('')(draft.name),
        description: field.str('')(draft.description),
        fields: draft.fields.map(readDraftColumn).filter((c): c is ColumnDraft => c !== null),
        notes: field.strOrNull(draft.notes),
    };
}
