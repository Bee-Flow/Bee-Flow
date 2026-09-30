/**
 * What each datatable call sends. Every body on this router is `.strict()`,
 * so a stray key is a 400 — these pin the exact shapes.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/datatables/api
 */

import { api } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';

import {
    addGrant,
    createDatatable,
    deleteDatatable,
    draftDatatable,
    getDirectory,
    removeGrant,
    saveSchema,
    setSharing,
    updateDatatable,
} from './endpoints';
import { countExpiringRows, deleteRows, exportRows, importRows, listRows, rowsQuery, updateRow } from './rows';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/shareFile', () => ({ shareServerFile: jest.fn(async () => 'file://x') }));

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'delete', jest.Mock>;

beforeEach(() => {
    for (const fn of Object.values(mocked)) {
        fn.mockReset();
        fn.mockResolvedValue({});
    }
});

describe('tables', () => {
    it('creates with the scope word and the key derived by the caller', async () => {
        mocked.post.mockResolvedValue({ datatable: { id: 'tbl_1', name: 'Leads' } });
        const body = { scope: 'personal' as const, name: 'Leads', key: 'leads', description: 'Sales', fields: [] };
        expect((await createDatatable(body))?.id).toBe('tbl_1');
        expect(mocked.post).toHaveBeenCalledWith('/api/datatables', body);
    });

    it('patches only what it is given, and deletes with a confirmation only when asked', async () => {
        await updateDatatable('tbl 1', { name: 'New' });
        expect(mocked.patch).toHaveBeenCalledWith('/api/datatables/tbl%201', { name: 'New' });
        await deleteDatatable('tbl_1');
        expect(mocked.delete).toHaveBeenLastCalledWith('/api/datatables/tbl_1', undefined);
        await deleteDatatable('tbl_1', true);
        expect(mocked.delete).toHaveBeenLastCalledWith('/api/datatables/tbl_1', { query: { confirmBreaking: 'true' } });
    });

    it('sends a retention window with its column, and turning it off as the null alone', async () => {
        await updateDatatable('tbl_1', { retentionDays: 30, retentionField: 'signed_at' });
        expect(mocked.patch).toHaveBeenLastCalledWith('/api/datatables/tbl_1', { retentionDays: 30, retentionField: 'signed_at' });
        await updateDatatable('tbl_1', { retentionDays: null });
        expect(mocked.patch).toHaveBeenLastCalledWith('/api/datatables/tbl_1', { retentionDays: null });
        // An allow-list: a key the route does not take never reaches it.
        await updateDatatable('tbl_1', { name: 'X', key: 'x' } as never);
        expect(mocked.patch).toHaveBeenLastCalledWith('/api/datatables/tbl_1', { name: 'X' });
    });

    it('saves the whole column list against the version it was read at', async () => {
        mocked.put.mockResolvedValue({ fields: [{ id: 'fld_1', key: 'a', type: 'text' }], modelVersion: 5 });
        const schema = await saveSchema('tbl_1', [{ key: 'a', name: 'A', type: 'text' }], 4);
        expect(mocked.put).toHaveBeenCalledWith('/api/datatables/tbl_1/schema', { fields: [{ key: 'a', name: 'A', type: 'text' }], expectedVersion: 4, confirmBreaking: false });
        expect(schema.modelVersion).toBe(5);
    });

    it('drafts in create mode from a brief', async () => {
        mocked.post.mockResolvedValue({ draft: { name: 'X', description: '', fields: [], notes: null } });
        await draftDatatable('invoices');
        expect(mocked.post).toHaveBeenCalledWith('/api/datatables/ai/draft', { mode: 'create', brief: 'invoices' });
    });
});

describe('sharing', () => {
    it('sends the audience word, and a grant from an allow-list only', async () => {
        await setSharing('tbl_1', { audience: 'groups', sharedGroups: ['g1'] });
        expect(mocked.put).toHaveBeenCalledWith('/api/datatables/tbl_1/sharing', { audience: 'groups', sharedGroups: ['g1'] });
        const grant = { id: 'gr_1', granteeType: 'user' as const, granteeId: 'u1', grade: 'editor' as const };
        await addGrant('tbl_1', grant);
        expect(mocked.post).toHaveBeenCalledWith('/api/datatables/tbl_1/grants', { granteeType: 'user', granteeId: 'u1', grade: 'editor' });
        mocked.delete.mockResolvedValue({ grants: [] });
        expect(await removeGrant('tbl_1', 'gr 1')).toEqual([]);
        expect(mocked.delete).toHaveBeenCalledWith('/api/datatables/tbl_1/grants/gr%201');
    });

    it('never throws for a directory the caller may not read', async () => {
        mocked.get.mockRejectedValue(new Error('403'));
        expect(await getDirectory()).toEqual({ users: [], groups: [], available: false });
        expect(mocked.get).toHaveBeenCalledWith('/auth/users', expect.objectContaining({ retry: false }));
    });
});

describe('rows', () => {
    const NONE = { filters: [], match: 'all' as const, sort: null, q: '' };

    it('counts what is about to expire from one full page, never from the table-wide total', async () => {
        mocked.get.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], hasMore: false, nextCursor: null, total: 412 });
        expect(await countExpiringRows('tbl_1', 'signed_at', '2026-09-04T12:00:00.000Z')).toEqual({ count: 3, more: false });
        expect(mocked.get).toHaveBeenCalledWith('/api/datatables/tbl_1/rows', {
            signal: undefined,
            query: { limit: 500, filters: JSON.stringify([{ field: 'signed_at', op: 'lte', value: '2026-09-04T12:00:00.000Z' }]) },
        });
        mocked.get.mockResolvedValue({ rows: [{ id: 1 }], hasMore: true, nextCursor: 'c', total: 100000 });
        expect(await countExpiringRows('tbl_1', 'signed_at', 'x')).toEqual({ count: 1, more: true });
    });

    it('puts only what narrows the question on the wire', () => {
        expect(rowsQuery(NONE, null)).toEqual({ limit: 50, cursor: undefined, filters: undefined, match: undefined, sort: undefined, dir: undefined, q: undefined });
        const narrowed = {
            filters: [{ field: 'a', op: 'eq', value: 1 }, { field: 'b', op: 'isNull', value: null }],
            match: 'any' as const,
            sort: { field: 'a', dir: 'desc' as const },
            q: ' anna ',
        };
        expect(rowsQuery(narrowed, 'c2')).toEqual({
            limit: 50, cursor: 'c2', filters: JSON.stringify(narrowed.filters), match: 'any', sort: 'a', dir: 'desc', q: 'anna',
        });
    });

    it('reads a page with the query it was asked with', async () => {
        mocked.get.mockResolvedValue({ rows: [{ id: 'r1' }], hasMore: false, nextCursor: null, total: 1 });
        const page = await listRows('tbl_1', NONE, null);
        expect(page.rows).toEqual([{ id: 'r1' }]);
        expect(mocked.get).toHaveBeenCalledWith('/api/datatables/tbl_1/rows', expect.objectContaining({ query: expect.objectContaining({ limit: 50 }) }));
    });

    it('edits with the updated_at the row was read at', async () => {
        mocked.put.mockResolvedValue({ row: { id: 'r1', a: 2 } });
        const row = await updateRow('tbl_1', { id: 'r1', updated_at: '2026-09-01T10:00:00Z' }, { a: 2 });
        expect(mocked.put).toHaveBeenCalledWith('/api/datatables/tbl_1/rows/r1', { values: { a: 2 }, expectedUpdatedAt: '2026-09-01T10:00:00Z' });
        expect(row).toEqual({ id: 'r1', a: 2 });
    });

    it('deletes a selection and imports a file in one request each', async () => {
        mocked.post.mockResolvedValueOnce({ deleted: 1, requested: 2 });
        expect(await deleteRows('tbl_1', ['r1', 'r2'])).toEqual({ deleted: 1, requested: 2 });
        expect(mocked.post).toHaveBeenCalledWith('/api/datatables/tbl_1/rows/bulk-delete', { ids: ['r1', 'r2'] });
        mocked.post.mockResolvedValueOnce({ inserted: 2, errors: [] });
        await importRows('tbl_1', [{ a: 1 }, { a: 2 }]);
        expect(mocked.post).toHaveBeenLastCalledWith('/api/datatables/tbl_1/rows/bulk', { rows: [{ a: 1 }, { a: 2 }] }, expect.objectContaining({ retry: false }));
    });

    it('exports through the session to the share sheet', async () => {
        await exportRows('tbl_1', 'leads');
        expect(shareServerFile).toHaveBeenCalledWith('/api/datatables/tbl_1/rows.csv', 'leads.csv', 'text/csv');
    });
});
