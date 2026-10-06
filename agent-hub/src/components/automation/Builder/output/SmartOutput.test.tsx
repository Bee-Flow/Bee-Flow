import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setCurrentUser } from '../../../../utils/scopedStorage';
import OutputView from '../OutputView';
import RunNote from './RunNote';
import SmartOutput, { smartRowsOf } from './SmartOutput';
import useOutputColumns from './useOutputColumns';

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
        // A container query shows them from 1100px of table width up, where they fit.
        expect(wideOnly.length).toBeGreaterThan(0);
        expect(wideOnly.every(th => th.className.includes('@min-[1100px]/smt:table-cell'))).toBe(true);
        // The pinned column keeps a width of its own beside them, never squeezed to nothing.
        expect(all[0].className).toContain('min-w-[120px]');
        // The other cells give way below 620px, so four columns fit a 500px drawer without scrolling sideways.
        const otherCell = within(screen.getByTestId('output-smart-table')).getAllByRole('row')[1].querySelectorAll('td')[1];
        expect(otherCell.className).toContain('max-w-[110px]');
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

    it('lines a pinned number up under its header, on the left; other numbers stay right', async () => {
        const taxes = [{ rate: 21, amount: 545.16 }, { rate: 9, amount: 12.5 }];
        const user = userEvent.setup();
        render(<OutputView smartTable value={taxes} />);
        const alignOf = (cell: HTMLElement) => (cell.querySelector('span')?.className.includes('text-right') ? 'right' : 'left');
        const [rate, amount] = within(within(screen.getByTestId('output-smart-table')).getAllByRole('row')[1]).getAllByRole('cell');
        expect([alignOf(rate), alignOf(amount)]).toEqual(['left', 'right']);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        const [wideRate, wideAmount] = within(within(screen.getByTestId('output-wide-grid')).getAllByRole('row')[1]).getAllByRole('cell');
        expect(wideRate.textContent).toBe('21');
        expect([alignOf(wideRate), alignOf(wideAmount)]).toEqual(['left', 'right']);
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
        expect(grid.textContent).toContain('2 rows');
        expect(grid.textContent).not.toContain('lines');
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

/**
 * A Gmail "Read" step that ran once per search result: invented Fabrikam
 * mails, with 16, 1, 3 and no attachments.
 */
const attachment = (m: number, n: number) => ({
    filename: `Invoice_${m}_${n}.pdf`, mimeType: 'application/pdf', size: 48213, attachmentId: `att-${m}-${n}`,
    canOCR: true, messageId: `msg-${m}`, threadId: `thr-${m}`,
});
const mailRow = (count: number, index: number) => {
    const m = index + 1;
    const from = 'Fabrikam Billing <billing@fabrikam.example>';
    return {
        index,
        item: { id: `msg-${m}`, to: 'finance@contoso.example', from, subject: `Fabrikam invoice ${m}`, snippet: 'Your invoice' },
        output: {
            id: `msg-${m}`, threadId: `thr-${m}`, from, to: 'finance@contoso.example', subject: `Fabrikam invoice ${m}`,
            date: `2026-09-2${m}T08:00:00Z`, body: `Invoice F-2026-00${m} is ready.`,
            attachments: Array.from({ length: count }, (_, n) => attachment(m, n)),
        },
        status: 'success',
    };
};
const MAIL_RUN = { iterations: 4, succeeded: 4, failed: 0, results: [16, 1, 3, 0].map(mailRow) };

/** A "Read attachment" step: the PDF worked, the logos had no OCR. */
const logoRow = (index: number, filename: string) => ({
    index, item: { filename, mimeType: 'image/png' }, output: null,
    error: `gmail_read_attachment failed: Could not extract text from ${filename} (image/png): image attachment, no OCR provider configured.`,
    errorClass: 'IntegrationError', attempts: 1, status: 'error',
});
const ATTACHMENT_RUN = {
    iterations: 3, succeeded: 1, failed: 2,
    results: [
        { index: 0, item: { filename: 'Invoice_1.pdf', mimeType: 'application/pdf' }, output: { filename: 'Invoice_1.pdf', mimeType: 'application/pdf', content: 'Invoice', charCount: 7 }, status: 'success' },
        logoRow(1, 'Fabrikam_logo.png'),
        logoRow(2, 'Contoso_icon.png'),
    ],
};

/** The drawer's table on its own, with the large view's opener as a spy. */
function Drawer({ value, onExpand }: { value: unknown; onExpand: (row?: number, key?: string) => void }) {
    const rows = smartRowsOf(value) ?? [];
    const cols = useOutputColumns(rows, null, ['attachments']);
    return <SmartOutput value={value} rows={rows} cols={cols} onExpand={onExpand} />;
}

describe('the drawer table of a step that ran once per item', () => {
    it('shows what each run returned, and says in one line how the runs went', () => {
        render(<OutputView fill fieldsView smartTable value={MAIL_RUN} columnsKey="a.mf_read" usedFields={['attachments']} />);
        const table = screen.getByTestId('output-smart-table');
        const heads = within(table).getAllByRole('columnheader').map(th => th.textContent);
        expect(heads[0]).toBe('Subject');
        expect(heads).toContain('Attachments');
        for (const gone of ['Status', 'Index', 'Item', 'Output', 'Incoming']) expect(heads).not.toContain(gone);
        expect(table.textContent).not.toContain('lines');
        expect(screen.getByText(/technical columns hidden \(id, thread id…\)/)).toBeTruthy();
        expect(screen.getByTestId('output-run-note').textContent).toBe('Ran 4 times · all worked');
        expect(screen.queryByTestId('output-smart-scalars')).toBeNull();
    });

    it('makes a list in a cell a button that opens it, and leaves the row alone', async () => {
        const user = userEvent.setup();
        const onExpand = vi.fn();
        render(<Drawer value={MAIL_RUN} onExpand={onExpand} />);
        const open = screen.getByRole('button', { name: 'Open 16 rows' });
        expect(open.textContent).toBe('16 rows');
        expect(open.getAttribute('data-open-key')).toBe('0:output.attachments');
        await user.click(open);
        expect(onExpand).toHaveBeenCalledTimes(1);
        expect(onExpand).toHaveBeenCalledWith(0, 'output.attachments');
        expect(screen.getByRole('button', { name: 'Open 1 row' }).textContent).toBe('1 row');

        // An empty list reads "0 rows" and opens nothing; a plain cell still opens its row.
        const lastRow = within(screen.getByTestId('output-smart-table')).getAllByRole('row')[4];
        expect(within(lastRow).getByText('0 rows')).toBeTruthy();
        expect(within(lastRow).queryByRole('button')).toBeNull();
        await user.click(within(lastRow).getByText('Fabrikam invoice 4'));
        expect(onExpand).toHaveBeenLastCalledWith(3);
    });

    it('shows a failed item\'s problem next to its name, without the tool in front', () => {
        render(<OutputView fill fieldsView smartTable value={ATTACHMENT_RUN} />);
        const table = screen.getByTestId('output-smart-table');
        const heads = within(table).getAllByRole('columnheader').map(th => th.textContent);
        expect(heads.slice(0, 2)).toEqual(['Filename', 'Problem']);
        const logo = within(table).getAllByRole('row')[2];
        expect(within(logo).getByText('Fabrikam_logo.png')).toBeTruthy();
        const problem = within(logo).getByText(/^Could not extract text from Fabrikam_logo\.png/);
        expect(problem.getAttribute('title')).toBe(problem.textContent);
        expect(table.textContent).not.toContain('gmail_read_attachment failed');
        expect(screen.getByTestId('output-run-note').textContent).toBe("Ran 3 times · 2 didn't work");
    });

    it('says when a run stopped at its limit, and keeps a Loop container\'s own numbers', () => {
        const rows = [{ index: 0, item: { n: 1 }, output: { ok: true }, status: 'success' }];
        const { rerender } = render(<RunNote value={{ iterations: 1, succeeded: 1, failed: 0, results: rows }} />);
        expect(screen.getByTestId('output-run-note').textContent).toBe('Ran once · it worked');
        rerender(<RunNote value={{ iterations: 100, succeeded: 100, failed: 0, truncated: true, totalItems: 250, results: rows }} />);
        expect(screen.getByTestId('output-run-note').textContent).toBe('Ran 100 times · all worked · Stopped at the limit: 100 of 250 done');
        cleanup();

        render(<OutputView fill fieldsView smartTable value={{ iterations: 1, results: [{ index: 0, item: { n: 1 }, output: { total: 3 } }] }} />);
        expect(screen.queryByTestId('output-run-note')).toBeNull();
        expect(within(screen.getByTestId('output-smart-scalars')).getByText('Iterations')).toBeTruthy();
    });
});
