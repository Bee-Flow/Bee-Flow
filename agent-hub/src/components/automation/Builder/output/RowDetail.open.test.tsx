import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RowDetail from './RowDetail';

/**
 * The row details of the large view: a nested list that hides rows or
 * columns has a "Show all" button that opens it as a level of its own, and a
 * row of a step that ran once per item shows what it returned, with the item
 * it ran for aside ("Incoming"). Invented Fabrikam / Contoso data.
 */
const attachment = (n: number) => ({
    filename: `Fabrikam_file_${n}.png`, mimeType: 'image/png', size: 1571 + n, attachmentId: `att-${n}`,
    canOCR: false, messageId: 'msg-1', threadId: 'thr-1',
});
const MAIL_ROW = {
    index: 0,
    item: { id: 'msg-1', to: 'finance@contoso.example', from: 'Fabrikam Billing <billing@fabrikam.example>', subject: 'Je Fabrikam factuur' },
    output: {
        id: 'msg-1', threadId: 'thr-1', from: 'Fabrikam Billing <billing@fabrikam.example>', to: 'finance@contoso.example',
        subject: 'Je Fabrikam factuur', body: 'Invoice F-2026-0917 is ready.',
        attachments: Array.from({ length: 16 }, (_, n) => attachment(n)),
    },
    status: 'success',
};
const FAILED_ROW = {
    index: 3,
    item: { filename: 'Fabrikam_logo.png', mimeType: 'image/png' },
    output: null,
    error: 'gmail_read_attachment failed: Could not extract text from Fabrikam_logo.png (image/png): no OCR provider configured.',
    errorClass: 'IntegrationError',
    attempts: 1,
    status: 'error',
};

afterEach(cleanup);

function renderDetail(row: unknown, extra: { perItem?: boolean; onOpenList?: (path: string, label: string) => void; revealPath?: string } = {}) {
    return render(
        <RowDetail row={row} title="Row" index={0} total={4} canPrev={false} canNext onPrev={vi.fn()} onNext={vi.fn()} onClose={vi.fn()} {...extra} />,
    );
}

describe('"Show all" in the row details', () => {
    it('opens a per-item row\'s list by its full path', async () => {
        const user = userEvent.setup();
        const onOpenList = vi.fn();
        renderDetail(MAIL_ROW, { perItem: true, onOpenList });
        const button = screen.getByRole('button', { name: 'Show all 16 rows' });
        expect(button.getAttribute('data-open-path')).toBe('output.attachments');
        await user.click(button);
        expect(onOpenList).toHaveBeenCalledWith('output.attachments', 'Attachments');
        // The fold header is the only button that names the list.
        expect(screen.getAllByRole('button', { name: /Attachments/ })).toHaveLength(1);
    });

    it('passes a list inside a group its full path', async () => {
        const user = userEvent.setup();
        const onOpenList = vi.fn();
        const lines = Array.from({ length: 6 }, (_, n) => ({ sku: `DSK-${n}`, quantity: n + 1 }));
        renderDetail({ order: { number: 'F-2026-0917', lines } }, { onOpenList });
        await user.click(screen.getByRole('button', { name: /Lines/ }));
        await user.click(screen.getByRole('button', { name: 'Show all 6 rows' }));
        expect(onOpenList).toHaveBeenCalledWith('order.lines', 'Lines');
    });

    it('offers the hidden columns when every row fits, and nothing when nothing is hidden', () => {
        renderDetail({
            extensions: [{ name: 'erp', owner: 'ops', region: 'eu', tier: 'gold' }],
            recipients: [{ name: 'Contoso Finance', address: 'finance@contoso.example' }],
        }, { onOpenList: vi.fn() });
        expect(screen.getByRole('button', { name: 'Show all 4 columns' })).toBeTruthy();
        expect(screen.queryAllByRole('button', { name: /^Show all/ })).toHaveLength(1);
    });

    it('has no button without a way to open the list', () => {
        renderDetail(MAIL_ROW, { perItem: true });
        expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
    });
});

describe('the details of a per-item row', () => {
    it('shows what the row returned, the item it ran for folded aside', () => {
        renderDetail(MAIL_ROW, { perItem: true });
        const detail = screen.getByTestId('output-row-detail');
        expect(within(detail).getByText('Subject')).toBeTruthy();
        expect(within(detail).queryByText('Index')).toBeNull();
        expect(within(detail).queryByText('Status')).toBeNull();
        const incoming = screen.getByRole('button', { name: /Incoming/ });
        expect(incoming.getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByRole('button', { name: '+ 2 technical' })).toBeTruthy();
        expect(screen.queryByTestId('row-detail-problem')).toBeNull();
    });

    it('starts a failed row with its problem, the item open', () => {
        renderDetail(FAILED_ROW, { perItem: true });
        const problem = screen.getByTestId('row-detail-problem');
        expect(problem.textContent).toContain('Could not extract text from Fabrikam_logo.png');
        expect(problem.textContent).not.toContain('gmail_read_attachment failed');
        expect(screen.getByRole('button', { name: /Incoming/ }).getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByText('Fabrikam_logo.png')).toBeTruthy();
        expect(screen.getByRole('button', { name: '+ 2 technical' })).toBeTruthy();
    });
});

describe('moving from row to row', () => {
    const OK_ROW = { index: 0, item: { filename: 'Factuur_F-2026-0917.pdf', mimeType: 'application/pdf' }, output: { filename: 'Factuur_F-2026-0917.pdf', content: 'Factuur' }, status: 'success' };
    const props = { title: 'Row', total: 4, canPrev: true, canNext: true, onPrev: vi.fn(), onNext: vi.fn(), onClose: vi.fn(), perItem: true };
    const incoming = () => screen.getByRole('button', { name: /Incoming/ }).getAttribute('aria-expanded');

    it('opens Incoming on a failed row after a working one, and folds it again after', async () => {
        const user = userEvent.setup();
        const { rerender } = render(<RowDetail row={OK_ROW} index={0} {...props} />);
        expect(incoming()).toBe('false');
        rerender(<RowDetail row={FAILED_ROW} index={1} {...props} />);
        expect(screen.getByTestId('row-detail-problem')).toBeTruthy();
        expect(incoming()).toBe('true');
        // Folded by hand on one failed row, open again on the next one.
        await user.click(screen.getByRole('button', { name: /Incoming/ }));
        expect(incoming()).toBe('false');
        rerender(<RowDetail row={{ ...FAILED_ROW, index: 2 }} index={2} {...props} />);
        expect(incoming()).toBe('true');
        rerender(<RowDetail row={OK_ROW} index={0} {...props} />);
        expect(incoming()).toBe('false');
    });
});

describe('coming back from a list opened in the details', () => {
    const lines = Array.from({ length: 16 }, (_, n) => ({ sku: `DSK-${n}`, quantity: n + 1 }));

    it('opens the list again inside its group, so its "Show all" can take focus', () => {
        renderDetail({ number: 'F-2026-001', order: { ref: 'PO-17', lines } }, { onOpenList: vi.fn(), revealPath: 'order.lines' });
        expect(screen.getByRole('button', { name: /Lines/ }).getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByRole('button', { name: 'Show all 16 rows' }).getAttribute('data-open-path')).toBe('order.lines');
    });

    it('opens Incoming and the technical fields when the list was in there', () => {
        renderDetail({ ...MAIL_ROW, item: { subject: 'Je Fabrikam factuur', lines } }, { perItem: true, onOpenList: vi.fn(), revealPath: 'item.lines' });
        expect(screen.getByRole('button', { name: /Incoming/ }).getAttribute('aria-expanded')).toBe('true');
        expect(screen.getAllByRole('button', { name: 'Show all 16 rows' }).map(b => b.getAttribute('data-open-path'))).toContain('item.lines');
        cleanup();
        renderDetail({ number: 'F-2026-001', raw: { lines } }, { onOpenList: vi.fn(), revealPath: 'raw.lines' });
        expect(screen.getByRole('button', { name: 'Hide technical fields' })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Lines/ }).getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByRole('button', { name: 'Show all 16 rows' }).getAttribute('data-open-path')).toBe('raw.lines');
    });

    it('leaves the folds alone without one', () => {
        renderDetail({ number: 'F-2026-001', order: { ref: 'PO-17', lines } }, { onOpenList: vi.fn() });
        expect(screen.getByRole('button', { name: /Lines/ }).getAttribute('aria-expanded')).toBe('false');
    });
});

describe('sizes in the details', () => {
    it('read as the grid reads them, in the fields and in a nested preview', () => {
        renderDetail({ filename: 'Factuur_265092240.pdf', size: 48213, attachments: [{ filename: 'Fabrikam_logo.png', mimeType: 'image/png', size: 1571 }] });
        const detail = screen.getByTestId('output-row-detail');
        expect(within(detail).getByText('47 KB')).toBeTruthy();
        expect(within(detail).getByText('1.5 KB')).toBeTruthy();
        expect(within(detail).queryByText('48,213')).toBeNull();
        expect(within(detail).queryByText('1,571')).toBeNull();
    });
});
