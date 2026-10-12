import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentUser, setJSON } from '../../../../utils/scopedStorage';
import OutputView from '../OutputView';

/**
 * The large "Continues on" view of a Gmail "Read" step that ran once per
 * search result: four invented Fabrikam mails that share one subject, with
 * 16, 16, 3 and 1 attachments. A list in a row opens as a level of its own;
 * the breadcrumb, ‹ and Esc go back exactly where you were.
 */
const attachment = (m: number, n: number) => ({
    filename: `Mail${m}_file${n}.png`, mimeType: 'image/png', size: 1571 + n, attachmentId: `att-${m}-${n}`,
    canOCR: false, messageId: `msg-${m}`, threadId: `thr-${m}`,
});
const FROM = 'Fabrikam Billing <billing@fabrikam.example>';
const mailRow = (count: number, index: number) => {
    const m = index + 1;
    return {
        index,
        item: { id: `msg-${m}`, to: 'finance@contoso.example', date: `2026-09-2${m}`, from: FROM, subject: 'Je Fabrikam factuur', snippet: 'Your invoice' },
        output: {
            id: `msg-${m}`, threadId: `thr-${m}`, from: FROM, to: 'finance@contoso.example', subject: 'Je Fabrikam factuur',
            date: `2026-09-2${m}T08:00:00Z`, body: `Invoice F-2026-00${m} is ready.`,
            attachments: Array.from({ length: count }, (_, n) => attachment(m, n)),
        },
        status: 'success',
    };
};
const mailRun = () => ({ iterations: 4, succeeded: 4, failed: 0, results: [16, 16, 3, 1].map(mailRow) });

const ROOT = 'Continues on · Read';
const ROW_1 = 'Je Fabrikam factuur (row 1)';

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => { cleanup(); setCurrentUser(null); });

const wideView = () => screen.getByTestId('output-wide-view');
const grid = () => screen.getByTestId('output-wide-grid');
const bodyRow = (i: number) => within(grid()).getAllByRole('row')[i + 1];
const heads = () => within(grid()).getAllByRole('columnheader').map(th => th.textContent);
const trail = () => screen.getByRole('navigation', { name: 'Where you are' });
const crumbs = () => Array.from(trail().querySelectorAll('li > button, li > [aria-current]')).map(c => c.textContent);
const focusedKey = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-open-key');

async function openWide(props: Record<string, unknown> = {}) {
    const user = userEvent.setup();
    const view = render(<OutputView smartTable value={mailRun()} stepLabel="Read" {...props} />);
    await user.click(screen.getByRole('button', { name: /Expand/ }));
    return { user, ...view };
}

async function drillRow(user: ReturnType<typeof userEvent.setup>, i: number) {
    await user.click(within(bodyRow(i)).getByRole('button', { name: 'Open 16 rows' }));
}

describe('the large view of a step that ran once per item', () => {
    it('shows what each run returned, and opens a list in a cell as the next level', async () => {
        const { user } = await openWide();
        expect(heads()[0]).toBe('Subject');
        for (const gone of ['Status', 'Index', 'Item', 'Output']) expect(heads()).not.toContain(gone);
        expect(grid().textContent).not.toContain('+8');
        expect(wideView().textContent).not.toContain('lines');

        await drillRow(user, 0);
        expect(crumbs()).toEqual([ROOT, ROW_1, 'Attachments']);
        expect(within(trail()).getByText('Attachments').getAttribute('aria-current')).toBe('page');
        expect(heads()[0]).toBe('Filename');
        expect(within(wideView()).getByText('Rows 1 to 16 of 16')).toBeTruthy();
        expect(screen.queryByTestId('output-row-detail')).toBeNull();
        expect(screen.getByRole('button', { name: 'Back' }).getAttribute('title')).toBe(ROW_1);
    });
});

describe('Esc in the large view', () => {
    it('steps back one thing at a time and never reaches the step drawer', async () => {
        const drawerKeys = vi.fn();
        document.addEventListener('keydown', drawerKeys);
        try {
            const { user } = await openWide();
            await drillRow(user, 0);
            expect(document.activeElement).not.toBe(document.body);
            await user.click(within(bodyRow(2)).getByText('Mail1_file2.png'));
            expect(within(screen.getByTestId('output-row-detail')).getByText('row 3 of 16')).toBeTruthy();

            await user.keyboard('{Escape}');
            expect(screen.queryByTestId('output-row-detail')).toBeNull();
            expect(crumbs()).toEqual([ROOT, ROW_1, 'Attachments']);
            expect(document.activeElement).not.toBe(document.body);

            await user.keyboard('{Escape}');
            expect(crumbs()).toEqual([ROOT]);
            expect(heads()[0]).toBe('Subject');
            expect(focusedKey()).toBe('0:output.attachments');

            await user.keyboard('{Escape}');
            expect(screen.queryByTestId('output-wide-view')).toBeNull();
            expect(drawerKeys.mock.calls.some(([e]) => (e as KeyboardEvent).key === 'Escape')).toBe(false);
        } finally {
            document.removeEventListener('keydown', drawerKeys);
        }
    });

    it('clears a search first, then closes the column picker', async () => {
        const { user } = await openWide();
        const search = within(wideView()).getByRole('searchbox', { name: 'Search rows…' });
        await user.type(search, 'nothing like this');
        await user.keyboard('{Escape}');
        expect((search as HTMLInputElement).value).toBe('');
        await user.click(within(wideView()).getByRole('button', { name: /Columns ·/ }));
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog', { name: 'Choose columns' })).toBeNull();
        expect(screen.getByTestId('output-wide-view')).toBeTruthy();
        expect(document.activeElement).not.toBe(document.body);
    });
});

describe('going back up', () => {
    it('restores the search, the selected row and its details', async () => {
        const { user } = await openWide();
        await user.type(within(wideView()).getByRole('searchbox', { name: 'Search rows…' }), 'factuur');
        await user.click(within(bodyRow(1)).getByText('Je Fabrikam factuur'));
        expect(within(screen.getByTestId('output-row-detail')).getByText('row 2 of 4')).toBeTruthy();
        await drillRow(user, 1);
        expect(crumbs()).toEqual([ROOT, 'Je Fabrikam factuur (row 2)', 'Attachments']);
        expect(within(wideView()).getByRole('searchbox', { name: 'Search rows…' })).toHaveProperty('value', '');

        await user.keyboard('{Escape}');
        expect(within(wideView()).getByRole('searchbox', { name: 'Search rows…' })).toHaveProperty('value', 'factuur');
        expect(within(screen.getByTestId('output-row-detail')).getByText('row 2 of 4')).toBeTruthy();
        expect(focusedKey()).toBe('1:output.attachments');
    });

    it('goes to a row crumb with its details open, and to the root with nothing selected', async () => {
        const { user } = await openWide();
        await drillRow(user, 0);
        await user.click(within(trail()).getByRole('button', { name: ROW_1 }));
        expect(crumbs()).toEqual([ROOT]);
        expect(within(screen.getByTestId('output-row-detail')).getByText('row 1 of 4')).toBeTruthy();
        expect(document.activeElement?.getAttribute('aria-current')).toBe('page');

        await drillRow(user, 0);
        await user.click(within(trail()).getByRole('button', { name: ROOT }));
        expect(crumbs()).toEqual([ROOT]);
        expect(screen.queryByTestId('output-row-detail')).toBeNull();
    });

    it('opens the same level from the row details', async () => {
        const { user } = await openWide();
        await user.click(within(bodyRow(0)).getByText('Je Fabrikam factuur'));
        await user.click(within(screen.getByTestId('output-row-detail')).getByRole('button', { name: 'Show all 16 rows' }));
        expect(crumbs()).toEqual([ROOT, ROW_1, 'Attachments']);
        expect(heads()[0]).toBe('Filename');
        await user.click(screen.getByRole('button', { name: 'Back' }));
        expect(crumbs()).toEqual([ROOT]);
        expect(within(screen.getByTestId('output-row-detail')).getByText('row 1 of 4')).toBeTruthy();
    });
});

describe('columns and JSON per level', () => {
    it('remembers a nested list\'s columns per list shape, apart from the step\'s', async () => {
        setCurrentUser('u1');
        const { user } = await openWide({ columnsKey: 'auto.mf_read' });
        const rootHeads = heads();
        expect(rootHeads).toEqual(['Subject', 'From', 'To', 'Date', 'Body', 'Attachments']);

        await drillRow(user, 0);
        expect(heads()).toContain('Mime type');
        await user.click(within(wideView()).getByRole('button', { name: /Columns · 4 of 7/ }));
        await user.click(screen.getByRole('checkbox', { name: 'Mime type' }));
        expect(heads()).not.toContain('Mime type');
        expect(document.activeElement).not.toBe(document.body);
        await user.keyboard('{Escape}');
        await user.keyboard('{Escape}');
        expect(heads()).toEqual(rootHeads);

        await drillRow(user, 1);
        expect(crumbs()[1]).toBe('Je Fabrikam factuur (row 2)');
        expect(heads()).not.toContain('Mime type');
        await user.click(within(wideView()).getByRole('button', { name: /Columns ·/ }));
        await user.click(screen.getByRole('button', { name: 'Back to suggestion' }));
        expect(heads()).toContain('Mime type');
        await user.click(screen.getByRole('button', { name: 'Back' }));
        expect(heads()).toEqual(rootHeads);
    });

    it('shows the current level\'s rows as JSON, and the crumbs keep working', async () => {
        const { user } = await openWide();
        await drillRow(user, 0);
        await user.click(within(wideView()).getByRole('button', { name: 'JSON' }));
        expect(screen.queryByTestId('output-wide-grid')).toBeNull();
        expect(wideView().textContent).toContain('Mail1_file0.png');
        expect(wideView().textContent).not.toContain('Mail2_file0.png');
        await user.click(within(trail()).getByRole('button', { name: ROOT }));
        expect(crumbs()).toEqual([ROOT]);
        expect(screen.queryByTestId('output-wide-grid')).toBeNull();
    });
});

describe('from the drawer, re-runs and failures', () => {
    it('opens a list from the drawer straight onto its level; Esc goes up, then closes', async () => {
        const user = userEvent.setup();
        render(<OutputView smartTable value={mailRun()} stepLabel="Read" />);
        await user.click(within(screen.getByTestId('output-smart-table')).getAllByRole('button', { name: 'Open 16 rows' })[0]);
        expect(crumbs()).toEqual([ROOT, ROW_1, 'Attachments']);
        await user.keyboard('{Escape}');
        expect(crumbs()).toEqual([ROOT]);
        expect(screen.queryByTestId('output-row-detail')).toBeNull();
        await user.keyboard('{Escape}');
        expect(screen.queryByTestId('output-wide-view')).toBeNull();
    });

    it('returns to the top when a new run arrives', async () => {
        const { user, rerender } = await openWide();
        await drillRow(user, 0);
        rerender(<OutputView smartTable value={mailRun()} stepLabel="Read" />);
        expect(crumbs()).toEqual([ROOT]);
        expect(heads()[0]).toBe('Subject');
    });

    it('names a failed row by its item and shows its problem without the tool in front', async () => {
        const logo = (index: number, filename: string) => ({
            index, item: { filename, mimeType: 'image/png' }, output: null,
            error: `gmail_read_attachment failed: Could not extract text from ${filename} (image/png): no OCR provider configured.`,
            errorClass: 'IntegrationError', attempts: 1, status: 'error',
        });
        const run = {
            iterations: 2, succeeded: 1, failed: 1,
            results: [
                { index: 0, item: { filename: 'Invoice.pdf' }, output: { filename: 'Invoice.pdf', content: 'Invoice' }, status: 'success' },
                logo(1, 'Fabrikam_logo.png'),
            ],
        };
        const user = userEvent.setup();
        render(<OutputView smartTable value={run} stepLabel="Read attachment" />);
        expect(screen.getByTestId('output-run-note').textContent).toMatch(/didn't work/);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        expect(heads().slice(0, 2)).toEqual(['Filename', 'Problem']);
        expect(within(bodyRow(1)).getByText('Fabrikam_logo.png')).toBeTruthy();
        expect(within(bodyRow(1)).getByText(/^Could not extract text from Fabrikam_logo\.png/)).toBeTruthy();
        expect(grid().textContent).not.toContain('gmail_read_attachment failed');
    });

    it('does not apply an old saved choice of the envelope\'s own columns', () => {
        setCurrentUser('u1');
        setJSON('automations.outputColumns.auto.old', { shown: ['status', 'index', 'item', 'output'], split: [] });
        render(<OutputView smartTable value={mailRun()} columnsKey="auto.old" />);
        const drawerHeads = within(screen.getByTestId('output-smart-table')).getAllByRole('columnheader').map(th => th.textContent);
        expect(drawerHeads[0]).toBe('Subject');
        expect(drawerHeads).not.toContain('Incoming');
    });
});

const subtitle = () => within(wideView()).getByText(/^(Table|JSON) · /).textContent;
const focusedPath = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-open-path');

describe('focus after going back up', () => {
    it('lands on "Show all" when the list was opened from the row details', async () => {
        const { user } = await openWide();
        await user.click(within(bodyRow(0)).getByText('Je Fabrikam factuur'));
        await user.click(within(screen.getByTestId('output-row-detail')).getByRole('button', { name: 'Show all 16 rows' }));
        await user.keyboard('{Escape}');
        expect(crumbs()).toEqual([ROOT]);
        // Below 900px the grid hides behind the details: its "16 rows" is not where you came from.
        expect(focusedPath()).toBe('output.attachments');
        expect(focusedKey()).toBeNull();
    });

    it('moves on to the next opener when the browser will not focus the first one', async () => {
        // A browser ignores focus() on a button that is display:none (the grid below 900px).
        const realFocus = HTMLElement.prototype.focus;
        const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, opts?: FocusOptions) {
            if (this.closest('[data-testid="output-wide-grid"]')) return;
            realFocus.call(this, opts);
        });
        try {
            const { user } = await openWide();
            await user.click(within(bodyRow(0)).getByText('Je Fabrikam factuur'));
            await user.click(within(bodyRow(0)).getByRole('button', { name: 'Open 16 rows' }));
            await user.keyboard('{Escape}');
            expect(crumbs()).toEqual([ROOT]);
            expect(focusedPath()).toBe('output.attachments');
        } finally {
            spy.mockRestore();
        }
    });

    it('opens the details\' folds again, so a list inside a group gets focus back', async () => {
        const lines = Array.from({ length: 16 }, (_, n) => ({ sku: `DSK-${n}`, quantity: n + 1 }));
        const rows = [1, 2, 3].map(i => ({ number: `F-2026-00${i}`, customer: 'Contoso B.V.', order: { ref: `PO-${i}`, lines } }));
        const user = userEvent.setup();
        render(<OutputView smartTable value={rows} stepLabel="Extract" />);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        await user.click(within(bodyRow(0)).getByText('F-2026-001'));
        const detail = () => screen.getByTestId('output-row-detail');
        await user.click(within(detail()).getByRole('button', { name: /Lines/ }));
        await user.click(within(detail()).getByRole('button', { name: 'Show all 16 rows' }));
        expect(crumbs()).toEqual(['Continues on · Extract', 'F-2026-001', 'Lines']);
        await user.keyboard('{Escape}');
        expect(crumbs()).toEqual(['Continues on · Extract']);
        expect(within(detail()).getByRole('button', { name: /Lines/ }).getAttribute('aria-expanded')).toBe('true');
        expect(focusedPath()).toBe('order.lines');
    });
});

describe('the header of a level', () => {
    it('says "1 row" for a list of one, and JSON in JSON mode without a second search', async () => {
        const { user } = await openWide();
        expect(subtitle()).toBe('Table · 4 rows · 9 columns');
        await user.click(within(bodyRow(3)).getByRole('button', { name: 'Open 1 row' }));
        expect(subtitle()).toBe('Table · 1 row · 7 columns');
        await user.click(within(wideView()).getByRole('button', { name: 'JSON' }));
        expect(subtitle()).toBe('JSON · 1 row · 7 columns');
        expect(within(wideView()).queryByRole('searchbox', { name: 'Search rows…' })).toBeNull();
        await user.click(within(wideView()).getByRole('button', { name: 'Table' }));
        expect(within(wideView()).getByRole('searchbox', { name: 'Search rows…' })).toBeTruthy();
    });
});

describe('a step that returned a record per item', () => {
    it('names its rows by what it returned, not by the whole item', async () => {
        const pdfText = (n: number) => `FACTUUR F-2026-091${n}\nFabrikam B.V.\nKlant: Contoso B.V.\nTotaal incl. btw: EUR 5570,80`;
        const run = {
            iterations: 2, succeeded: 2, failed: 0,
            results: [7, 8].map((n, index) => ({
                index, item: pdfText(n), status: 'success',
                output: { invoice: { number: `F-2026-091${n}`, total: 5570.8 }, lines: [{ sku: 'DSK-180-OAK', quantity: 2 }, { sku: 'CHR-20', quantity: 4 }] },
            })),
        };
        const user = userEvent.setup();
        render(<OutputView smartTable value={run} stepLabel="Extract invoice lines" />);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        expect(heads()[0]).toBe('Invoice');
        expect(heads()).not.toContain('Incoming');
        await user.click(within(bodyRow(0)).getByRole('button', { name: 'Open 2 rows' }));
        expect(crumbs()).toEqual(['Continues on · Extract invoice lines', 'F-2026-0917', 'Lines']);
    });
});

describe('failed items, row by row', () => {
    it('opens Incoming on a failed row reached with ↓ from a working one', async () => {
        const run = {
            iterations: 2, succeeded: 1, failed: 1,
            results: [
                { index: 0, item: { filename: 'Invoice.pdf' }, output: { filename: 'Invoice.pdf', content: 'Invoice' }, status: 'success' },
                { index: 1, item: { filename: 'Fabrikam_logo.png' }, output: null, error: 'gmail_read_attachment failed: no OCR', errorClass: 'IntegrationError', attempts: 1, status: 'error' },
            ],
        };
        const user = userEvent.setup();
        render(<OutputView smartTable value={run} stepLabel="Read attachment" />);
        await user.click(screen.getByRole('button', { name: /Expand/ }));
        await user.click(within(bodyRow(0)).getByText('Invoice.pdf'));
        const incoming = () => within(screen.getByTestId('output-row-detail')).getByRole('button', { name: /Incoming/ }).getAttribute('aria-expanded');
        expect(incoming()).toBe('false');
        await user.keyboard('{ArrowDown}');
        expect(within(screen.getByTestId('output-row-detail')).getByText('row 2 of 2')).toBeTruthy();
        expect(incoming()).toBe('true');
    });

    it('does not apply an old envelope choice that kept the error column', () => {
        setCurrentUser('u1');
        setJSON('automations.outputColumns.auto.old', { shown: ['index', 'item', 'output', 'status', 'error'], split: [] });
        const run = {
            iterations: 2, succeeded: 1, failed: 1,
            results: [
                { index: 0, item: { filename: 'Invoice.pdf' }, output: { filename: 'Invoice.pdf', content: 'Invoice' }, status: 'success' },
                { index: 1, item: { filename: 'Fabrikam_logo.png' }, output: null, error: 'no OCR', status: 'error' },
            ],
        };
        render(<OutputView smartTable value={run} columnsKey="auto.old" />);
        const drawerHeads = within(screen.getByTestId('output-smart-table')).getAllByRole('columnheader').map(th => th.textContent);
        expect(drawerHeads.slice(0, 2)).toEqual(['Filename', 'Problem']);
        expect(drawerHeads).not.toContain('Incoming');
    });
});
