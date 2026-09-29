import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setCurrentUser } from '../../../../utils/scopedStorage';
import OutputView from '../OutputView';

const files = Array.from({ length: 23 }, (_, i) => ({
    id: i + 1,
    etag: `e${i}`,
    fileid: 1000 + i,
    permissions: 'RGDNVW',
    name: i === 0 ? 'Documents' : `File ${i}.pdf`,
    type: i === 0 ? 'dir' : 'file',
    size: 1024 * (i + 1),
    modified: '2026-09-20T10:00:00Z',
    owner: { name: 'Tom', uid: 'tom', email: 'tom@example.org' },
}));
const FILES_OUTPUT = { files, count: 23, folder: '/' };

const invoices = Array.from({ length: 48 }, (_, i) => ({
    id: `inv-${i}`,
    invoiceNumber: `INV-2026-${String(i + 1).padStart(3, '0')}`,
    supplier: { name: i === 1 ? 'Brouwer Techniek' : 'Acme BV', vat: 'NL8124', address: { city: 'Utrecht' } },
    date: '2026-09-26',
    total: 1000 + i,
    lines: [{ d: 'a', n: 1 }, { d: 'b', n: 2 }],
    labels: ['Maintenance', 'Installation', 'Q3', 'Utrecht'],
    status: 'waiting',
}));

beforeEach(() => { cleanup(); try { localStorage.clear(); } catch { /* none */ } });

describe('the drawer table (artboard 4b)', () => {
    it('shows a list as a table with a few useful columns, the plain values under it', () => {
        render(<OutputView fill fieldsView smartTable value={FILES_OUTPUT} columnsKey="a.s1" />);
        const table = screen.getByTestId('output-smart-table');
        // What a narrow column shows: the columns not held back for a wide table.
        const heads = within(table).getAllByRole('columnheader').filter(th => !th.hasAttribute('data-wide-only')).map(th => th.textContent);
        expect(heads[0]).toBe('Name');
        expect(heads.length).toBeLessThanOrEqual(4);
        expect(heads).not.toContain('Etag');
        expect(within(screen.getByTestId('output-smart-scalars')).getByText('Count')).toBeTruthy();
    });

    it('holds the large view\'s extra columns back for a wide table, never a technical one', () => {
        render(<OutputView fill fieldsView smartTable value={FILES_OUTPUT} columnsKey="a.s1" />);
        const all = within(screen.getByTestId('output-smart-table')).getAllByRole('columnheader');
        const wideOnly = all.filter(th => th.hasAttribute('data-wide-only'));
        // A container query shows them from 860px of table width up.
        expect(wideOnly.length).toBeGreaterThan(0);
        expect(wideOnly.every(th => th.className.includes('@min-[860px]/smt:table-cell'))).toBe(true);
        expect(all.length).toBeLessThanOrEqual(7);
        expect(all.map(th => th.textContent)).not.toContain('Etag');
    });

    it('says which technical columns it hid, and shows them on request', async () => {
        const user = userEvent.setup();
        render(<OutputView fill fieldsView smartTable value={FILES_OUTPUT} />);
        expect(screen.getByText(/technical columns hidden \(id, etag…\)/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'show' }));
        expect(within(screen.getByTestId('output-smart-table')).getAllByRole('columnheader').map(th => th.textContent)).toContain('Etag');
    });

    it('summarises nested values instead of printing objects', () => {
        render(<OutputView smartTable value={invoices} />);
        const table = screen.getByTestId('output-smart-table');
        expect(table.textContent).not.toContain('[object Object]');
    });

    it('leaves callers without smartTable on the classic table', () => {
        render(<OutputView value={FILES_OUTPUT} />);
        expect(screen.queryByTestId('output-smart-table')).toBeNull();
    });
});

describe('the large view (artboard 4d)', () => {
    it('opens, searches rows and pages through them', async () => {
        const user = userEvent.setup();
        render(<OutputView smartTable value={invoices} stepLabel="Fetch invoices" />);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        const wide = screen.getByTestId('output-wide-view');
        expect(within(wide).getByText('Continues on · Fetch invoices')).toBeTruthy();
        expect(within(wide).getByText('Rows 1 to 25 of 48')).toBeTruthy();
        await user.click(within(wide).getByRole('button', { name: 'Next page' }));
        expect(within(wide).getByText('Rows 26 to 48 of 48')).toBeTruthy();
        await user.type(within(wide).getByRole('searchbox', { name: 'Search rows…' }), 'Brouwer');
        expect(within(wide).getByText('Rows 1 to 1 of 1')).toBeTruthy();
    });

    it('pins the number column first and shows at most seven by default', async () => {
        const user = userEvent.setup();
        render(<OutputView smartTable value={invoices} />);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        const grid = screen.getByTestId('output-wide-grid');
        const heads = within(grid).getAllByRole('columnheader');
        expect(heads[0].textContent).toContain('Invoice number');
        expect(heads.length).toBeLessThanOrEqual(7);
        expect(grid.textContent).toContain('2 lines');
        expect(grid.textContent).toContain('+3');
        expect(screen.getByRole('button', { name: /Columns · \d+ of 8/ })).toBeTruthy();
    });

    afterEach(() => setCurrentUser(null));

    it('remembers a column choice per step, and goes back to the suggestion', async () => {
        setCurrentUser('u1');
        const user = userEvent.setup();
        const { unmount } = render(<OutputView smartTable value={invoices} columnsKey="auto.step" />);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        await user.click(screen.getByRole('button', { name: /Columns ·/ }));
        await user.click(screen.getByRole('checkbox', { name: 'Status' }));
        expect(within(screen.getByTestId('output-wide-grid')).queryByRole('columnheader', { name: /Status/ })).toBeNull();
        unmount();

        render(<OutputView smartTable value={invoices} columnsKey="auto.step" />);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        expect(within(screen.getByTestId('output-wide-grid')).queryByRole('columnheader', { name: /Status/ })).toBeNull();
        await user.click(screen.getByRole('button', { name: /Columns ·/ }));
        await user.click(screen.getByRole('button', { name: 'Back to suggestion' }));
        expect(within(screen.getByTestId('output-wide-grid')).getByRole('columnheader', { name: /Status/ })).toBeTruthy();
    });

    it('splits a group into its own columns', async () => {
        const user = userEvent.setup();
        render(<OutputView smartTable value={invoices} />);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        await user.click(screen.getByRole('button', { name: /Columns ·/ }));
        await user.click(screen.getByRole('button', { name: 'split' }));
        expect(within(screen.getByTestId('output-wide-grid')).getByRole('columnheader', { name: /Supplier › Name/ })).toBeTruthy();
    });

    it('opens a row as a tree and pages with ↑/↓', async () => {
        const user = userEvent.setup();
        render(<OutputView smartTable value={invoices} />);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        await user.click(within(screen.getByTestId('output-wide-grid')).getByText('INV-2026-002'));
        const detail = screen.getByTestId('output-row-detail');
        expect(within(detail).getByText('row 2 of 48')).toBeTruthy();
        expect(within(detail).getByText('Brouwer Techniek')).toBeTruthy();
        await user.click(within(detail).getByRole('button', { name: 'Next row' }));
        expect(within(screen.getByTestId('output-row-detail')).getByText('row 3 of 48')).toBeTruthy();
        await user.keyboard('{ArrowUp}');
        expect(within(screen.getByTestId('output-row-detail')).getByText('row 2 of 48')).toBeTruthy();
        await user.click(within(screen.getByTestId('output-row-detail')).getByRole('button', { name: 'Close row details' }));
        expect(screen.queryByTestId('output-row-detail')).toBeNull();
    });

    it('closes back to the drawer', async () => {
        const user = userEvent.setup();
        render(<OutputView smartTable value={invoices} />);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        await user.click(screen.getByRole('button', { name: 'Back to the drawer' }));
        expect(screen.queryByTestId('output-wide-view')).toBeNull();
    });
});
