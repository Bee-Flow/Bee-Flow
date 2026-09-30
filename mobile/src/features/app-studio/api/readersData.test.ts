/** An app's data payloads through the allow-list. */

import {
    readBatch,
    readDatasets,
    readMembers,
    readOneRecord,
    readQuery,
    readRecordPage,
    readRecordWrite,
    readSchema,
    readTables,
} from './readersData';

describe('tables and records', () => {
    it('reads tables with their public field shape', () => {
        const [table] = readTables({
            tables: [{
                id: 't1', key: 'orders', name: 'Orders', linked: true, readOnly: true,
                fields: [{ id: 'f1', key: 'total', name: 'Total', type: 'number', relation: { table: 'customers' }, options: ['a'] }],
            }, { key: 'no-id' }],
        });
        expect(table).toMatchObject({ id: 't1', icon: null, linked: true, readOnly: true });
        expect(table?.fields[0]).toEqual({
            id: 'f1', key: 'total', name: 'Total', type: 'number', subtype: null,
            required: false, unique: false, options: ['a'], relation: { table: 'customers' },
        });
    });

    it('reads a record page, one record and a write', () => {
        expect(readRecordPage({ records: [{ id: 1 }, 'x'], nextCursor: 'c2', appVersion: 3 })).toEqual({
            records: [{ id: 1 }], nextCursor: 'c2', appVersion: 3,
        });
        expect(readRecordPage({ records: [] }).nextCursor).toBeNull();
        expect(readOneRecord({ record: { id: 'r' } })).toEqual({ id: 'r' });
        expect(readOneRecord({})).toBeNull();
        expect(readRecordWrite({ success: true, id: 42, record: { id: 42 } })).toEqual({ id: '42', record: { id: 42 } });
    });
});

describe('batch and query', () => {
    it('reads per-read results', () => {
        expect(readBatch({ results: [{ id: 'b1', ok: true, data: { records: [] } }, { id: 'b2', ok: false, status: 404, error: 'gone' }], appVersion: 2 })).toEqual({
            supported: true,
            appVersion: 2,
            results: [
                { id: 'b1', ok: true, status: null, error: null, data: { records: [] } },
                { id: 'b2', ok: false, status: 404, error: 'gone', data: undefined },
            ],
        });
    });

    it('reads a 200 without a results array as "cannot batch", never as empty', () => {
        expect(readBatch('<!doctype html>')).toEqual({ supported: false });
        expect(readBatch({ ok: true })).toEqual({ supported: false });
    });

    it('reads a query answer', () => {
        expect(readQuery({ rows: [{ n: 1 }], columns: ['n'], cached: true, result: [{ n: 1 }] })).toEqual({
            rows: [{ n: 1 }], columns: ['n'], truncated: false, cached: true, result: [{ n: 1 }],
        });
    });
});

describe('the owner side', () => {
    it('reads the schema, datasets and members', () => {
        expect(readSchema({ model: null, modelVersion: 0 })).toEqual({ model: null, modelVersion: 0 });
        expect(readSchema({ model: { tables: [] }, modelVersion: '3' })).toEqual({ model: { tables: [] }, modelVersion: 3 });
        expect(readDatasets({ datasets: [{ id: 'd1', name: 'By month', cacheTtlSeconds: 60 }] })[0]).toMatchObject({
            id: 'd1', tableId: null, source: {}, descriptor: {}, cacheTtlSeconds: 60,
        });
        expect(readMembers({ members: [{ appId: 'a', userId: 'u2', roleKey: 'editor' }, { roleKey: 'x' }] })).toEqual([
            { userId: 'u2', roleKey: 'editor', createdAt: null },
        ]);
    });
});
