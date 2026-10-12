import { describe, expect, it } from 'vitest';
import { hasPendingDatatableRefs, isPendingDatatableId, previewCatalog } from './pendingTables';

describe('isPendingDatatableId', () => {
    it('accepts only the pending:<n> form the server stages', () => {
        expect(isPendingDatatableId('pending:1')).toBe(true);
        expect(isPendingDatatableId('pending:120')).toBe(true);
        for (const id of ['pending:0', 'pending:', 'pending:1x', 'pending:1234', 'tbl_1', '', null, undefined, 3]) expect(isPendingDatatableId(id)).toBe(false);
    });
});

describe('hasPendingDatatableRefs', () => {
    const step = (datatableId: string) => ({ id: 's', type: 'datatable', datatableId });
    it('finds a ref in the root, a loop body, a layer and cacheInto', () => {
        expect(hasPendingDatatableRefs({ steps: [step('pending:1')] })).toBe(true);
        expect(hasPendingDatatableRefs({ steps: [{ id: 'l', type: 'loop', body: { steps: [step('pending:2')] } }] })).toBe(true);
        expect(hasPendingDatatableRefs({ steps: [], layers: { sub: { steps: [step('pending:3')] } } })).toBe(true);
        expect(hasPendingDatatableRefs({ steps: [{ id: 'h', type: 'http_request', cacheInto: { datatableId: 'pending:4' } }] })).toBe(true);
    });
    it('ignores real ids, other keys and empty input', () => {
        expect(hasPendingDatatableRefs({ steps: [step('tbl_9')] })).toBe(false);
        expect(hasPendingDatatableRefs({ steps: [{ id: 'x', label: 'pending:1' }] })).toBe(false);
        expect(hasPendingDatatableRefs(null)).toBe(false);
        expect(hasPendingDatatableRefs(undefined)).toBe(false);
    });
});

describe('previewCatalog', () => {
    const proposal = { pendingDatatables: [{ ref: 'pending:1', name: 'Facturen', key: 'facturen', scope: 'org' as const, fields: [{ key: 'datum', name: 'Datum', type: 'date' }] }] };
    it('adds the staged tables as pending entries and keeps the real ones', () => {
        const catalog = { datatables: [{ id: 'tbl_1', name: 'Klanten' }], steps: [] };
        const merged = previewCatalog(catalog, proposal);
        expect(merged.datatables.map(t => t.id)).toEqual(['tbl_1', 'pending:1']);
        expect(merged.datatables[1]).toMatchObject({ name: 'Facturen', key: 'facturen', pending: true, scope: 'org', columns: [{ key: 'datum', name: 'Datum', type: 'date' }] });
        expect(catalog.datatables).toHaveLength(1);
        expect(merged.steps).toBe(catalog.steps);
    });
    it('returns the catalog itself when there is nothing to add, and null while it loads', () => {
        const catalog = { datatables: [] };
        expect(previewCatalog(catalog, {})).toBe(catalog);
        expect(previewCatalog(catalog, null)).toBe(catalog);
        expect(previewCatalog(null, proposal)).toBeNull();
    });
    it('does not add a ref twice', () => {
        const catalog = { datatables: [{ id: 'pending:1', name: 'x' }] };
        expect(previewCatalog(catalog, proposal).datatables).toHaveLength(1);
    });
});
