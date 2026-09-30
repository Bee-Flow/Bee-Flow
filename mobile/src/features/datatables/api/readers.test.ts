/**
 * The datatable readers against the shapes the server source writes
 * (projection.publicTable, rowMappers.rowToGrant, usage.listUsage, …).
 */

import {
    readBulkImport,
    readDirectory,
    readDraft,
    readGrants,
    readRowsPage,
    readSchema,
    readTable,
    readTableEnvelope,
    readTableList,
    readUsage,
} from './readers';

describe('readTable', () => {
    it('reads publicTable, with a mirror’s writability and a list’s usage count', () => {
        const table = readTable({
            id: 'tbl_1', name: 'Leads', key: 'leads', description: 'Sales leads', rowCount: '12', rowScope: 'own',
            isPublished: true, sharedGroups: ['g1', 7], writeMode: 'audience', retentionDays: 30, managedKind: 'spreadsheet_file',
            source: { kind: 'spreadsheet_file', writable: false }, ownerUserId: 'u1', updatedAt: '2026-09-01', scopeKind: 'user',
            grade: 'editor', usageCount: 2,
        });
        expect(table).toMatchObject({ rowCount: 12, rowScope: 'own', sharedGroups: ['g1'], sourceWritable: false, scopeKind: 'user', grade: 'editor', usageCount: 2 });
    });

    it('degrades an unreadable table to the narrow reading', () => {
        expect(readTable('nonsense')).toMatchObject({ id: '', scopeKind: 'org', grade: null, writeMode: 'grants', rowScope: 'all', sourceWritable: null });
    });

    it('reads the retention pair and when the sweep last ran, and no window as none', () => {
        const kept = readTable({ id: 'tbl_1', retentionDays: 30, retentionField: 'signed_at', lastRetentionAt: '2026-09-26T03:00:00.000Z' });
        expect(kept).toMatchObject({ retentionDays: 30, retentionField: 'signed_at', lastRetentionAt: '2026-09-26T03:00:00.000Z' });
        // The column's server default travels even while nothing is ever deleted.
        expect(readTable({ id: 'tbl_1', retentionDays: null, retentionField: 'created_at', lastRetentionAt: null }))
            .toMatchObject({ retentionDays: null, retentionField: 'created_at', lastRetentionAt: null });
        expect(readTable({ id: 'tbl_1', retentionDays: 'soon', retentionField: 7 })).toMatchObject({ retentionDays: null, retentionField: null, lastRetentionAt: null });
    });

    it('reads the envelopes and the list', () => {
        expect(readTableEnvelope({ datatable: { id: 'tbl_1' } })?.id).toBe('tbl_1');
        expect(readTableEnvelope({})).toBeNull();
        const list = readTableList({ datatables: [{ id: 'a' }, 'x'], scope: { kind: 'user', id: 'u1', label: 'this account' } });
        expect(list.tables.map((t) => t.id)).toEqual(['a']);
        expect(list.scope).toEqual({ kind: 'user', id: 'u1' });
        expect(readTableList({ datatables: [], scope: null, reason: 'no_scope' }).scope).toBeNull();
        expect(readTableList({ scope: { kind: 'team' } }).scope).toBeNull();
    });
});

describe('readSchema', () => {
    it('reads normalizeFields’ columns and keeps an unknown type visible as such', () => {
        const schema = readSchema({
            fields: [
                { id: 'fld_1', key: 'stage', name: 'Stage', type: 'select', options: ['a', 1], required: true },
                { id: 'fld_2', key: 'link', type: 'relation' },
                { key: 'x', type: 'hologram' },
                { name: 'no key' },
            ],
            modelVersion: '4',
        });
        expect(schema.modelVersion).toBe(4);
        expect(schema.fields.map((f) => [f.key, f.type])).toEqual([['stage', 'select'], ['link', 'relation'], ['x', 'unknown']]);
        expect(schema.fields[0]).toMatchObject({ options: ['a'], required: true, unique: false });
    });
});

describe('readRowsPage', () => {
    it('keeps every column of a row, drops a row without an id, and reads the cursor', () => {
        const page = readRowsPage({ rows: [{ id: 1, name: 'a' }, { name: 'no id' }, null], hasMore: true, count: 1, nextCursor: 'c2', total: '40' });
        expect(page).toEqual({ rows: [{ id: '1', name: 'a' }], hasMore: true, nextCursor: 'c2', total: 40 });
        expect(readRowsPage(null)).toEqual({ rows: [], hasMore: false, nextCursor: null, total: 0 });
    });

    it('reads a bulk import’s per-line errors', () => {
        expect(readBulkImport({ inserted: 3, errors: [{ line: 2, error: 'bad' }, 'x'] })).toEqual({ inserted: 3, errors: [{ line: 2, error: 'bad' }] });
    });
});

describe('readGrants', () => {
    it('reads the snake_case rowToGrant shape, and drops a row it cannot place', () => {
        const grants = readGrants({
            grants: [
                { id: 'g1', datatableId: 't', grantee_type: 'group', grantee_id: 'grp', grade: 'editor' },
                { id: 'g2', granteeType: 'user', granteeId: 'u', grade: 'owner' },
                { id: 'g3', grantee_type: 'robot', grantee_id: 'r' },
            ],
        });
        expect(grants).toEqual([
            { id: 'g1', granteeType: 'group', granteeId: 'grp', grade: 'editor' },
            { id: 'g2', granteeType: 'user', granteeId: 'u', grade: 'viewer' },
        ]);
    });
});

describe('readUsage', () => {
    it('reads listUsage rows, falling back to the automation aliases', () => {
        const [row] = readUsage({
            usage: [{ automationId: 'a1', automationTitle: 'Nightly', automationOwner: 'u1', stepOrdinal: 2, stepType: 'datatable', mode: 'write', columns: ['x'] }],
        });
        expect(row).toEqual({ consumerKind: 'automation', consumerId: 'a1', title: 'Nightly', ownerId: 'u1', mode: 'write', stepOrdinal: 2, stepOp: 'datatable', columns: ['x'], lastRunAt: null });
    });
});

describe('readDirectory and readDraft', () => {
    it('treats a refused directory as unavailable, not as empty', () => {
        expect(readDirectory(null, null)).toEqual({ users: [], groups: [], available: false });
        const dir = readDirectory([{ id: 'u1', displayName: 'Anna', email: 'a@x' }, { id: 'u2', email: 'b@x' }, { name: 'no id' }], [{ id: 'g1', name: 'Sales' }]);
        expect(dir).toEqual({ users: [{ id: 'u1', name: 'Anna' }, { id: 'u2', name: 'b@x' }], groups: [{ id: 'g1', name: 'Sales' }], available: true });
    });

    it('reads a draft’s columns, reading an unknown type as text', () => {
        const draft = readDraft({ draft: { name: 'Invoices', description: 'd', notes: null, fields: [{ key: 'n', name: 'N', type: 'number' }, { key: 's', type: 'odd', options: ['a'] }, { name: 'no key' }] } });
        expect(draft).toEqual({ name: 'Invoices', description: 'd', notes: null, fields: [{ key: 'n', name: 'N', type: 'number' }, { key: 's', name: 's', type: 'text', options: ['a'] }] });
        expect(readDraft({ draft: {} })).toBeNull();
    });
});
