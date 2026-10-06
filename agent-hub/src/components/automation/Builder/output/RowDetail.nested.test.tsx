import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RowDetail from './RowDetail';

/**
 * The large view's row details for a Microsoft Graph mail: recipients are
 * records inside records, a sub-table can be wide, and JSON text can hide in
 * a field. Every part must show (never a header over no rows, never a group
 * missing a field), a record in a cell reads as "name · address", and JSON
 * text reads as what it encodes.
 */
const MAIL = {
    subject: 'Invoice F-2026-0917',
    from: { emailAddress: { name: 'Ingrid Möller', address: 'ingrid@supplier.example' } },
    toRecipients: [{ emailAddress: { name: 'Purchasing', address: 'purchasing@acme.example' } }],
    ccRecipients: [
        { emailAddress: { name: 'Jan de Wit', address: 'jan@acme.example' } },
        { emailAddress: { name: 'Eva Smit', address: 'eva@acme.example' } },
    ],
    extensions: [{ extensionName: 'erp', 'Story points': 5, 'Kostenplaats €': 'KP-12', owner: 'ops', region: 'eu' }],
    meta: '{"ticket":{"id":"T-1","status":"open"}}',
};

afterEach(cleanup);

function renderDetail() {
    return render(
        <RowDetail row={MAIL} title="Invoice" index={0} total={3} canPrev={false} canNext onPrev={vi.fn()} onNext={vi.fn()} onClose={vi.fn()} />,
    );
}

describe('RowDetail over nested records', () => {
    it('shows every row of a nested table, a record cell as "name · address"', () => {
        renderDetail();
        expect(screen.getByText('Purchasing · purchasing@acme.example')).toBeTruthy();
        expect(screen.getByText('Jan de Wit · jan@acme.example')).toBeTruthy();
        expect(screen.getByText('Eva Smit · eva@acme.example')).toBeTruthy();
        expect(screen.getByText('KP-12')).toBeTruthy();
    });

    it('lists every field of a group', async () => {
        const user = userEvent.setup();
        renderDetail();
        // Deeper levels start closed; opened, the group shows ALL its fields.
        await user.click(screen.getByRole('button', { name: /Email address/ }));
        expect(screen.getByText('ingrid@supplier.example')).toBeTruthy();
        expect(screen.getByText('Ingrid Möller')).toBeTruthy();
    });

    it('reads JSON text as the record it encodes', async () => {
        const user = userEvent.setup();
        renderDetail();
        expect(screen.queryByText(/\{"ticket"/)).toBeNull();
        await user.click(screen.getByRole('button', { name: /Ticket/ }));
        expect(screen.getByText('T-1')).toBeTruthy();
    });

    it('never lets a card shrink inside the scrolling list (that clipped its rows)', () => {
        renderDetail();
        const list = screen.getByTestId('output-row-detail');
        const blocks = within(list).getAllByTestId('row-detail-field');
        expect(blocks.length).toBeGreaterThan(4);
        for (const b of blocks) expect(b.className).toContain('shrink-0');
    });

    it('counts in words that agree: one row, one column, one field', () => {
        renderDetail();
        // `toRecipients` holds one row with one column.
        expect(screen.getByRole('button', { name: /To recipients/ }).textContent).toContain('1 row · 1 column');
        expect(screen.getByRole('button', { name: /Cc recipients/ }).textContent).toContain('2 rows · 1 column');
        expect(screen.getByRole('button', { name: /From.*group/ }).textContent).toContain('group · 1 field');
    });
});
