import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppRecordDetail from './AppRecordDetail';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

function withRuntime(ui, overrides = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }), ...overrides };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const RECORD = {
    id: 'rec_1',
    name: 'Beehive audit',
    amount: 12345.6,
    due: '2026-02-01',
    status: 'open',
    site: 'https://example.com/x',
    notes: 'Some **bold** notes',
    created_at: '2026-01-01T10:00:00Z',
};

function rdNode(props = {}) {
    return {
        id: 'cmp_rd', type: 'record_detail', visible: true,
        props: {
            source: { kind: 'static', value: RECORD },
            fields: [
                { key: 'name', label: 'Name', format: 'text' },
                { key: 'amount', label: 'Amount', format: 'number' },
                { key: 'due', label: 'Due', format: 'date' },
                { key: 'status', label: 'Status', format: 'badge' },
                { key: 'site', label: 'Site', format: 'link' },
                { key: 'notes', label: 'Notes', format: 'markdown' },
            ],
            columns: 2,
            emptyText: 'No record selected.',
            ...props,
        },
        style: { span: 12 },
    };
}

describe('AppRecordDetail', () => {
    it('renders each field with its format', () => {
        const { container, getByText } = withRuntime(<AppRecordDetail node={rdNode()} />);
        // text
        expect(getByText('Beehive audit')).toBeTruthy();
        // number → localized
        expect(getByText((12345.6).toLocaleString())).toBeTruthy();
        // date → localized date
        expect(getByText(new Date('2026-02-01').toLocaleDateString())).toBeTruthy();
        // badge → pill
        expect(getByText('open').className).toContain('rounded-full');
        // link → anchor with safe rel
        const a = container.querySelector('a[href="https://example.com/x"]');
        expect(a).toBeTruthy();
        expect(a.getAttribute('rel')).toContain('noopener');
        // markdown → inline bold
        expect(container.querySelector('strong').textContent).toBe('bold');
        // 2-column grid
        const dl = container.querySelector('[data-app-recorddetail]');
        expect(dl.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    });

    it('derives fields from the record keys (minus system columns) when fields is empty', () => {
        const { getByText, queryByText } = withRuntime(<AppRecordDetail node={rdNode({ fields: [] })} />);
        expect(getByText('name')).toBeTruthy();
        expect(getByText('amount')).toBeTruthy();
        expect(queryByText('created_at')).toBeNull();
        expect(queryByText('id')).toBeNull();
    });

    it('takes the first row of an array source and em-dashes missing values', () => {
        const nodeArr = rdNode({
            source: { kind: 'static', value: [{ name: 'First' }, { name: 'Second' }] },
            fields: [{ key: 'name', label: 'Name', format: 'text' }, { key: 'missing', label: 'Gone', format: 'text' }],
        });
        const { getByText, queryByText } = withRuntime(<AppRecordDetail node={nodeArr} />);
        expect(getByText('First')).toBeTruthy();
        expect(queryByText('Second')).toBeNull();
        expect(getByText('—')).toBeTruthy();
    });

    it('shows emptyText when the binding resolves to nothing', () => {
        const { getByText } = withRuntime(<AppRecordDetail node={rdNode({ source: { kind: 'static', value: null } })} />);
        expect(getByText('No record selected.')).toBeTruthy();
    });
});

/**
 * A file field had no honest format here. 'text' printed the raw descriptor —
 * {"kind":"studio_attachment","fileId":"…","mime":"…"} — straight into the
 * panel: unreadable, and not something you could click to see the drawing.
 */
describe('AppRecordDetail — file fields', () => {
    const FILE = {
        kind: 'studio_attachment', fileId: 'f1', name: 'MW2604-01-3021-001.pdf',
        mime: 'application/pdf', size: 177887,
    };

    it('renders a document field as the file, not its JSON', () => {
        const node = rdNode({
            source: { kind: 'static', value: { tekening: FILE } },
            fields: [{ key: 'tekening', label: 'Tekening', format: 'document' }],
        });
        const { container } = withRuntime(<AppRecordDetail node={node} />);
        // Nothing of the descriptor leaks into the text.
        expect(container.textContent).not.toContain('studio_attachment');
        expect(container.textContent).not.toContain('fileId');
        expect(container.textContent).toContain('Tekening');
    });

    it('still prints an empty file field as the em dash', () => {
        const node = rdNode({
            source: { kind: 'static', value: { tekening: null } },
            fields: [{ key: 'tekening', label: 'Tekening', format: 'cad' }],
        });
        const { container } = withRuntime(<AppRecordDetail node={node} />);
        expect(container.textContent).toContain('—');
    });
});

describe('AppRecordDetail — rows layout and groups', () => {
    it("layout 'rows' puts label and value on one line, value right-aligned", () => {
        const { container } = withRuntime(<AppRecordDetail node={rdNode({ layout: 'rows', columns: 2 })} />);
        const dl = container.querySelector('[data-app-recorddetail-layout="rows"]');
        expect(dl).toBeTruthy();
        const first = dl.querySelector('dd');
        expect(first.className).toContain('text-right');
        // A long plain value truncates and carries the whole value on hover.
        expect(dl.querySelector('dd[title="Beehive audit"]')).toBeTruthy();
    });

    it('groups fields under headings, ungrouped first, in order of first appearance', () => {
        const fields = [
            { key: 'name', label: 'Name', group: 'Bron' },
            { key: 'amount', label: 'Amount', format: 'number', group: 'Maten' },
            { key: 'status', label: 'Status' },
            { key: 'due', label: 'Due', format: 'date', group: 'Bron' },
        ];
        const { container } = withRuntime(<AppRecordDetail node={rdNode({ fields, layout: 'rows' })} />);
        const heads = [...container.querySelectorAll('[data-app-recorddetail-group]')].map((h) => h.textContent);
        expect(heads).toEqual(['Bron', 'Maten']);
        // Status (no group) comes before either heading.
        const text = container.textContent;
        expect(text.indexOf('Status')).toBeLessThan(text.indexOf('Bron'));
        // Due joins Name under Bron, in the order written.
        expect(text.indexOf('Name')).toBeLessThan(text.indexOf('Due'));
        expect(text.indexOf('Due')).toBeLessThan(text.indexOf('Maten'));
    });

    it('without layout or groups the stacked rendering is byte-identical', () => {
        const { container } = withRuntime(<AppRecordDetail node={rdNode()} />);
        expect(container.querySelector('[data-app-recorddetail-layout]')).toBe(null);
        expect(container.querySelectorAll('[data-app-recorddetail-group]')).toHaveLength(0);
        expect(container.querySelectorAll('dt')).toHaveLength(6);
    });
});
