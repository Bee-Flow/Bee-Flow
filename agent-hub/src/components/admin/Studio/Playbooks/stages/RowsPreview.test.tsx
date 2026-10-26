import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RowsPreview from './RowsPreview';
import { datatablesApi } from '../../Datatables/datatablesApi';
import { asMock } from '@/test/mocks';

vi.mock('../../Datatables/datatablesApi', () => ({ datatablesApi: { listRows: vi.fn() } }));

const t = (k: string, f: string, v: unknown) => (v ? Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), f) : f);
const FIELDS = [{ key: 'datum', name: 'Datum', type: 'date' }, { key: 'leverancier', name: 'Leverancier', type: 'text' }, { key: 'totaal', name: 'Totaal', type: 'number' }, { key: 'betaald', name: 'Betaald', type: 'bool' }];

beforeEach(() => vi.resetAllMocks());
afterEach(() => cleanup());

describe('RowsPreview — the values the automation extracted', () => {
    it('reads the first rows of the table and shows them under the column titles, with the count and a door to the table', async () => {
        const user = userEvent.setup();
        asMock(datatablesApi.listRows).mockResolvedValue({ rows: [
            { id: 'r1', datum: '2026-07-01', leverancier: 'Acme BV', totaal: 1554.25, betaald: false },
            { id: 'r2', datum: '2026-07-03', leverancier: 'Globex', totaal: 99, betaald: true },
        ], hasMore: true });
        const onNavigate = vi.fn();
        render(<RowsPreview datatableId="tbl_1" fields={FIELDS} rowCount={32} t={t} onNavigate={onNavigate} reducedMotion />);
        expect(datatablesApi.listRows).toHaveBeenCalledWith('tbl_1', { limit: 8 });
        const rows = await screen.findAllByTestId('playbook-rows-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('Acme BV');
        expect(rows[0].textContent).toContain('1554.25');
        expect(rows[0].textContent).toContain('No');
        expect(rows[1].textContent).toContain('Yes');
        expect(screen.getByText('Leverancier')).toBeTruthy();
        expect(screen.getByText('2 of 32')).toBeTruthy();
        await user.click(screen.getByTestId('playbook-rows-open'));
        expect(onNavigate).toHaveBeenCalledWith('studio/datatables/tbl_1');
    });

    it('re-reads when refreshKey changes (rows arriving while the run lives); an empty table says so', async () => {
        asMock(datatablesApi.listRows).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'r1', datum: '2026-07-01', leverancier: 'Acme', totaal: 1 }] });
        const { rerender } = render(<RowsPreview datatableId="tbl_1" fields={FIELDS} t={t} refreshKey="a" reducedMotion />);
        expect(await screen.findByText('No rows yet.')).toBeTruthy();
        rerender(<RowsPreview datatableId="tbl_1" fields={FIELDS} t={t} refreshKey="b" reducedMotion />);
        await waitFor(() => expect(datatablesApi.listRows).toHaveBeenCalledTimes(2));
        expect(await screen.findByText('Acme')).toBeTruthy();
    });
});
