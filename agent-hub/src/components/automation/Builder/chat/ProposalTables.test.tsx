import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProposalTables from './ProposalTables';

vi.mock('../../../../hooks/useTranslation', () => ({
    default: () => ({ t: (_k: string, d: string) => d }),
    useTranslation: () => ({ t: (_k: string, d: string) => d }),
}));

afterEach(cleanup);

const facturen = { ref: 'pending:1', name: 'Facturen', key: 'facturen', scope: 'org' as const, fields: [
    { key: 'datum', name: 'Datum', type: 'date' },
    { key: 'status', name: 'Status', type: 'select', options: ['open', 'betaald'] },
] };

describe('ProposalTables', () => {
    it('renders nothing for a proposal without tables', () => {
        const { container } = render(<ProposalTables proposal={{}} />);
        expect(container.firstChild).toBeNull();
        cleanup();
        const none = render(<ProposalTables proposal={null} />);
        expect(none.container.firstChild).toBeNull();
    });

    it('shows a new table with its columns, its scope and the created-on-apply badge', () => {
        render(<ProposalTables proposal={{ pendingDatatables: [facturen], usedDatatables: [{ id: 'pending:1', name: 'Facturen', pending: true, newlyBound: true, stepIds: ['s1'] }] }} />);
        const card = screen.getByTestId('proposal-new-table');
        expect(within(card).getByText('Facturen')).toBeTruthy();
        expect(within(card).getByText('Organisation table')).toBeTruthy();
        expect(within(card).getByText('Datum · date')).toBeTruthy();
        // The select column carries its options in a title, not in the chip text.
        expect(within(card).getByText('Status · select').getAttribute('title')).toBe('open, betaald');
        expect(within(card).getByText('Created when you press Apply')).toBeTruthy();
        expect(within(card).queryByText('Not used by a step yet')).toBeNull();
    });

    it('says a staged table is not used by a step yet', () => {
        render(<ProposalTables proposal={{ pendingDatatables: [{ ...facturen, scope: 'personal' }], usedDatatables: [] }} />);
        expect(screen.getByText('Not used by a step yet')).toBeTruthy();
        expect(screen.getByText('Personal table')).toBeTruthy();
    });

    it('lists existing tables the steps use and marks the newly linked one', () => {
        render(<ProposalTables proposal={{ usedDatatables: [
            { id: 'tbl_1', name: 'Klanten', pending: false, newlyBound: true, stepIds: ['s1'] },
            { id: 'tbl_2', name: 'Orders', pending: false, newlyBound: false, stepIds: ['s2'] },
            { id: 'pending:1', name: 'Facturen', pending: true, newlyBound: true, stepIds: ['s3'] },
        ] }} />);
        const rows = screen.getAllByTestId('proposal-used-table');
        expect(rows).toHaveLength(2);
        expect(within(rows[0]).getByText('Klanten')).toBeTruthy();
        expect(within(rows[0]).getByText('newly linked')).toBeTruthy();
        expect(within(rows[1]).queryByText('newly linked')).toBeNull();
        expect(within(rows[1]).getByText('existing')).toBeTruthy();
        expect(screen.queryByText('New tables')).toBeNull();
    });
});
