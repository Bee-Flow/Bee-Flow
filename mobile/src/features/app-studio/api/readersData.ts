/**
 * Contract readers for an app's data: tables, record pages and writes, the
 * batch and query reads, the owner's schema, datasets and members.
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

import { readRecordList } from './readersApps';
import type { OpenRecord } from '../model/apiTypes';
import type {
    AppDataset,
    AppMember,
    AppSchema,
    BatchReadResult,
    BatchResult,
    DataField,
    DataRecord,
    DataTable,
    QueryResult,
    RecordPage,
    RecordWrite,
} from '../model/runtimeTypes';

const readRelation = (value: unknown): { table: string } | null => {
    const table = pick(value, 'table');
    return typeof table === 'string' ? { table } : null;
};

const readField: (raw: unknown) => DataField = shapeOf({
    id: field.str(''),
    key: field.str(''),
    name: field.str(''),
    type: field.str('text'),
    subtype: field.strOrNull,
    required: field.bool(false),
    unique: field.bool(false),
    options: field.arrayOrNull,
    relation: readRelation,
});

const readTable: (raw: unknown) => DataTable = shapeOf({
    id: field.str(''),
    key: field.str(''),
    name: field.str(''),
    icon: field.strOrNull,
    fields: field.list(readField),
    linked: field.bool(false),
    readOnly: field.bool(false),
});

export function readTables(raw: unknown): DataTable[] {
    return field.list(readTable)(pick(raw, 'tables')).filter((t) => t.id !== '');
}

/** A record's columns are the app's own; only "is it an object" is checked. */
export const readRecord = (value: unknown): DataRecord | null => field.recordOrNull<DataRecord>(value);

export const readRecordPage: (raw: unknown) => RecordPage = shapeOf({
    records: readRecordList,
    nextCursor: field.strOrNull,
    appVersion: field.numOrNull,
});

/** `GET …/records/:rid` → `{ record }`. */
export function readOneRecord(raw: unknown): DataRecord | null {
    return readRecord(pick(raw, 'record'));
}

/** POST/PATCH record → `{ success, id?, record }`. */
export const readRecordWrite: (raw: unknown) => RecordWrite = shapeOf({
    id: (value: unknown) => (typeof value === 'number' ? String(value) : field.strOrNull(value)),
    record: readRecord,
});

const readBatchRead: (raw: unknown) => BatchReadResult = shapeOf({
    id: field.strOrNull,
    ok: field.bool(false),
    status: field.numOrNull,
    error: field.strOrNull,
    data: field.raw,
});

/**
 * `POST /:id/data/batch`. A 200 whose body carries no `results` array is NOT
 * an empty answer — it is a transport that swallowed the route — so it reads
 * as `supported: false`, exactly as the web's dataBatchClient treats it.
 */
export function readBatch(raw: unknown): BatchResult {
    const results = pick(raw, 'results');
    if (!Array.isArray(results)) return { supported: false };
    return {
        supported: true,
        results: results.filter((r) => field.recordOrNull(r) !== null).map(readBatchRead),
        appVersion: field.numOrNull(pick(raw, 'appVersion')),
    };
}

export const readQuery: (raw: unknown) => QueryResult = shapeOf({
    rows: readRecordList,
    columns: field.arrayOrNull,
    truncated: field.bool(false),
    cached: field.bool(false),
    result: field.raw,
});

export const readSchema: (raw: unknown) => AppSchema = shapeOf({
    model: field.recordOrNull<OpenRecord>,
    modelVersion: field.num(0),
});

const datasetSpec = {
    id: field.str(''),
    name: field.str(''),
    tableId: field.strOrNull,
    source: field.record<OpenRecord>({}),
    descriptor: field.record<OpenRecord>({}),
    cacheTtlSeconds: field.num(0),
    createdAt: field.strOrNull,
    updatedAt: field.strOrNull,
};

export function readDatasets(raw: unknown): AppDataset[] {
    return shapeListOf(datasetSpec)(pick(raw, 'datasets')).filter((d) => d.id !== '');
}

export function readMembers(raw: unknown): AppMember[] {
    return shapeListOf({
        userId: field.str(''),
        roleKey: field.str('member'),
        createdAt: field.strOrNull,
    })(pick(raw, 'members')).filter((m) => m.userId !== '');
}
