import { describe, it, expect } from 'vitest';
import { discoverColumns, isTechnicalKey, nameColumn, resolveShown, suggestColumns } from './columns';
import { rowMatches, summariseCell } from './cellSummary';

const INVOICES = [
    {
        id: 'a1', etag: 'x', tenant: 't', created_at: '2026-09-01T10:00:00Z',
        invoiceNumber: 'INV-2026-001',
        supplier: { name: 'Acme BV', vat: 'NL1', address: { city: 'Utrecht' } },
        date: '2026-09-26', total: 1452, lines: [{ d: 'a', n: 1 }, { d: 'b', n: 2 }, { d: 'c', n: 3 }],
        labels: ['IT', 'Q3'], status: 'waiting', attachment: 'Invoice-2026-001.pdf',
        netAmount: 1200, vatAmount: 252, approvedBy: { name: 'S. de Boer', role: 'cfo' }, dueDate: '2026-10-26', costCentre: 'OPS',
    },
];

describe('the column model', () => {
    it('calls plumbing technical and readable fields not', () => {
        for (const k of ['id', 'etag', 'tenant', 'created_at', 'fileId', 'owner_id', '_meta']) expect(isTechnicalKey(k)).toBe(true);
        for (const k of ['name', 'total', 'status', 'invoiceNumber', 'size', 'mimetype', 'hidden']) expect(isTechnicalKey(k)).toBe(false);
    });

    it('learns what each column holds', () => {
        const cols = discoverColumns(INVOICES);
        const kind = (k: string) => cols.find(c => c.key === k)?.kind;
        expect(kind('supplier')).toBe('group');
        expect(kind('lines')).toBe('table');
        expect(kind('labels')).toBe('list');
        expect(kind('date')).toBe('date');
        expect(kind('total')).toBe('number');
        expect(cols.find(c => c.key === 'supplier')?.groupSize).toBe(3);
    });

    it('suggests at most seven columns, the number first, no technical ones', () => {
        const cols = discoverColumns(INVOICES);
        const shown = suggestColumns(cols, { max: 7 });
        expect(shown).toHaveLength(7);
        expect(shown[0]).toBe('invoiceNumber');
        expect(shown).toEqual(expect.arrayContaining(['date', 'total', 'status']));
        expect(shown.some(k => ['id', 'etag', 'tenant', 'created_at'].includes(k))).toBe(false);
    });

    it('lets a field a next step uses into a short suggestion', () => {
        const cols = discoverColumns(INVOICES);
        expect(suggestColumns(cols, { max: 5, usedFields: ['costCentre'] })).toContain('costCentre');
        expect(suggestColumns(cols, { max: 5 })).not.toContain('costCentre');
    });

    it('prefers a name over a number for the pinned column', () => {
        const cols = discoverColumns([{ id: 1, number: 'F-1', title: 'Hello' }]);
        expect(nameColumn(cols)?.key).toBe('title');
    });

    it('splits a group into "Supplier › Name" columns', () => {
        const cols = discoverColumns(INVOICES, ['supplier']);
        const split = cols.filter(c => c.parent === 'supplier');
        expect(split.map(c => c.label)).toEqual(['Supplier › Name', 'Supplier › Vat', 'Supplier › Address']);
        expect(cols.some(c => c.key === 'supplier')).toBe(false);
    });

    it('keeps a remembered choice, dropping columns the data no longer has', () => {
        const cols = discoverColumns(INVOICES);
        expect(resolveShown(cols, { shown: ['status', 'gone', 'total'], split: [] })).toEqual(['status', 'total']);
        expect(resolveShown(cols, { shown: ['gone'], split: [] }, { max: 3 })).toHaveLength(3);
    });
});

describe('a nested cell', () => {
    it('never reads [object Object]', () => {
        expect(summariseCell({ name: 'Brouwer Techniek', vat: 'NL', address: {} })).toEqual({ type: 'group', text: 'Brouwer Techniek', more: 2 });
        expect(summariseCell([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }])).toEqual({ type: 'table', count: 5 });
        expect(summariseCell(['Maintenance', 'Installation', 'Q3', 'Utrecht'])).toEqual({ type: 'list', chips: ['Maintenance'], more: 3 });
        expect(summariseCell(['IT', 'Q3'])).toEqual({ type: 'list', chips: ['IT', 'Q3'], more: 0 });
    });

    it('colours a status by what it says', () => {
        const status = { key: 'status', label: 'Status', kind: 'text', technical: false, role: 'status', groupSize: null, parent: null } as const;
        expect(summariseCell('waiting', status)).toMatchObject({ type: 'status', tone: 'warning' });
        expect(summariseCell('paid', status)).toMatchObject({ type: 'status', tone: 'success' });
        expect(summariseCell('failed', status)).toMatchObject({ type: 'status', tone: 'error' });
    });

    it('searches values, not field names', () => {
        expect(rowMatches({ name: 'Acme' }, 'acme')).toBe(true);
        expect(rowMatches({ name: 'Acme' }, 'name')).toBe(false);
        expect(rowMatches({ supplier: { city: 'Utrecht' } }, 'utr')).toBe(true);
    });
});
