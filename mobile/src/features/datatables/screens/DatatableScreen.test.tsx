/**
 * One table against canned answers: the columns with the platform's locked,
 * the rows in a grid with their own headers, a row edited with only what
 * changed, sharing on a personal table, and who uses it.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { DatatableScreen, type DatatableTab } from './DatatableScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canDismiss: () => false }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access', () => ({ useHasPermission: () => true }));
jest.mock('@/core/auth/AuthProvider', () => ({ useCurrentUser: () => ({ id: 'me' }) }));
jest.mock('../model/pickCsv', () => ({
    pickCsv: jest.fn(async () => ({ name: 'leads.csv', text: 'Company;Amount\nInitech;12,5\nHooli;lots\n' })),
}));

const TABLE = {
    id: 'tbl_1', name: 'Leads', key: 'leads', description: 'Sales leads', rowCount: 2, grade: 'owner',
    scopeKind: 'org', isPublished: false, sharedGroups: [], writeMode: 'grants', managedKind: null,
};
const FIELDS = [
    { id: 'fld_1', key: 'company', name: 'Company', type: 'text', required: true },
    { id: 'fld_2', key: 'amount', name: 'Amount', type: 'number' },
    { id: 'fld_3', key: 'won', name: 'Won', type: 'bool' },
];
const ROWS = [
    { id: 'rec_1', company: 'Acme', amount: '1200', won: true, created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z' },
    { id: 'rec_2', company: 'Globex', amount: null, won: false, created_at: '2026-09-02T10:00:00Z', updated_at: '2026-09-02T10:00:00Z' },
];

function answer(table: object) {
    return (path: string) => {
        if (path === '/api/datatables/tbl_1') return Promise.resolve({ datatable: table });
        if (path.endsWith('/schema')) return Promise.resolve({ fields: FIELDS, modelVersion: 3 });
        if (path.endsWith('/rows')) return Promise.resolve({ rows: ROWS, hasMore: false, nextCursor: null, total: 2 });
        if (path.endsWith('/usage')) {
            return Promise.resolve({ usage: [{ consumerKind: 'automation', consumerId: 'a1', consumerTitle: 'Nightly import', consumerOwner: 'me', stepOrdinal: 2, stepOp: 'insert', mode: 'write', columns: ['company'] }] });
        }
        if (path.endsWith('/grants')) return Promise.resolve({ grants: [] });
        return Promise.reject(new Error('403'));
    };
}

const render = (tab?: DatatableTab, table: object = TABLE) => {
    (api.get as jest.Mock).mockImplementation(answer(table));
    return renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>
                <DatatableScreen tableId="tbl_1" initialTab={tab} />
            </ConfirmProvider>
        </ToastProvider>,
    );
};

beforeEach(() => {
    for (const fn of Object.values(api)) (fn as jest.Mock).mockReset?.();
});

describe('DatatableScreen', () => {
    it('opens on the columns, with the grade and the counts', async () => {
        await render();
        expect(await screen.findByText('Company')).toBeTruthy();
        expect(screen.getByText('You own this table')).toBeTruthy();
        expect(screen.getByText('3 columns · 2 rows')).toBeTruthy();
        expect(screen.getByTestId('add-column')).toBeTruthy();
    });

    it('draws the rows under the table’s own column headers', async () => {
        await render('rows');
        expect(await screen.findByText('Acme')).toBeTruthy();
        // A NUMERIC arrives as a string and keeps its stored spelling, as on the web.
        expect(screen.getByText('1200')).toBeTruthy();
        expect(screen.getByText('Globex')).toBeTruthy();
        expect(screen.getByText('Company')).toBeTruthy();
        expect(screen.getByText('2026-09-01 10:00')).toBeTruthy();
    });

    it('saves an edited row with only what changed and the updated_at it was read at', async () => {
        (api.put as jest.Mock).mockResolvedValue({ row: { ...ROWS[0], amount: '99' } });
        await render('rows');
        await fireEvent.press(await screen.findByText('Acme'));
        await fireEvent.changeText(screen.getByTestId('field-amount'), '99');
        await fireEvent.press(screen.getByText('Save this row'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/datatables/tbl_1/rows/rec_1', { values: { amount: 99 }, expectedUpdatedAt: '2026-09-01T10:00:00Z' }),
        );
    });

    it('closes the row on a conflict, so the next try starts from the row as it now is', async () => {
        // Staying open would resend the stale updated_at and conflict again.
        (api.put as jest.Mock).mockRejectedValue(new ApiError('conflict', { status: 409, body: { error: 'row_conflict' } }));
        await render('rows');
        await fireEvent.press(await screen.findByText('Acme'));
        await fireEvent.changeText(screen.getByTestId('field-amount'), '99');
        await fireEvent.press(screen.getByText('Save this row'));
        expect(await screen.findByText(/Someone else changed this row/)).toBeTruthy();
        await waitFor(() => expect(screen.queryByText('Save this row')).toBeNull());
    });

    it('states that a personal table cannot be shared', async () => {
        await render('sharing', { ...TABLE, scopeKind: 'user' });
        expect(await screen.findByText('This table cannot be shared')).toBeTruthy();
    });

    it('lists who uses the table, step by step', async () => {
        await render('usage');
        expect(await screen.findByText('Nightly import')).toBeTruthy();
        expect(screen.getByText('routine · step 2 · insert')).toBeTruthy();
        expect(screen.getByText('writes')).toBeTruthy();
    });

    it('says a table that is not there is not available, never whose it is', async () => {
        (api.get as jest.Mock).mockImplementation(() => Promise.resolve({}));
        await renderWithProviders(<DatatableScreen tableId="tbl_1" />);
        expect(await screen.findByText(/not available to you/)).toBeTruthy();
    });
});

describe('DatatableScreen flows', () => {
    it('adds a column: the whole list goes back with the version it was read at', async () => {
        (api.put as jest.Mock).mockResolvedValue({ fields: FIELDS, modelVersion: 4 });
        await render();
        await fireEvent.press(await screen.findByTestId('add-column'));
        await fireEvent.changeText(screen.getByTestId('column-name'), 'Stage');
        await fireEvent.press(screen.getByTestId('column-type-select'));
        await fireEvent.changeText(screen.getByTestId('column-options'), 'New\nWon\nNew');
        await fireEvent.press(screen.getByText('Save column'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/datatables/tbl_1/schema', {
                fields: [
                    { id: 'fld_1', key: 'company', name: 'Company', type: 'text', required: true },
                    { id: 'fld_2', key: 'amount', name: 'Amount', type: 'number' },
                    { id: 'fld_3', key: 'won', name: 'Won', type: 'bool' },
                    { key: 'stage', name: 'Stage', type: 'select', options: ['New', 'Won'] },
                ],
                expectedVersion: 3,
                confirmBreaking: false,
            }),
        );
    });

    it('asks before removing a column, naming the routine that reads it', async () => {
        (api.put as jest.Mock).mockResolvedValue({ fields: FIELDS.slice(1), modelVersion: 4 });
        await render();
        await fireEvent.press(await screen.findByText('Company'));
        await fireEvent.press(screen.getByText('Remove this column'));
        expect(await screen.findByText(/Nightly import/)).toBeTruthy();
        await fireEvent.press(screen.getByText('Save anyway'));
        await waitFor(() => expect(api.put).toHaveBeenCalled());
        expect((api.put as jest.Mock).mock.calls[0]?.[1].fields.map((f: { key: string }) => f.key)).toEqual(['amount', 'won']);
    });

    it('filters the rows through the server’s descriptor', async () => {
        await render('rows');
        await fireEvent.press(await screen.findByTestId('rows-filter'));
        await fireEvent.changeText(screen.getByTestId('filter-value'), 'Acme');
        await fireEvent.press(screen.getByTestId('filter-add'));
        await fireEvent.press(screen.getByTestId('filter-apply'));
        await waitFor(() =>
            expect(api.get).toHaveBeenCalledWith(
                '/api/datatables/tbl_1/rows',
                expect.objectContaining({ query: expect.objectContaining({ filters: JSON.stringify([{ field: 'company', op: 'eq', value: 'Acme' }]) }) }),
            ),
        );
    });

    it('asks before sharing with the whole organisation, then sends the audience word', async () => {
        (api.put as jest.Mock).mockResolvedValue({ datatable: { ...TABLE, isPublished: true } });
        await render('sharing');
        await fireEvent.press(await screen.findByTestId('audience-org'));
        expect(await screen.findByText('Give more people access?')).toBeTruthy();
        await fireEvent.press(screen.getByText('Share it'));
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/datatables/tbl_1/sharing', { audience: 'organisation' }));
    });

    it('imports a picked file, sending only the rows that converted', async () => {
        (api.post as jest.Mock).mockResolvedValue({ inserted: 1, errors: [] });
        await render('rows');
        await fireEvent.press(await screen.findByTestId('table-menu'));
        await fireEvent.press(screen.getByText('Import'));
        await fireEvent.press(await screen.findByTestId('import-start'));
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith('/api/datatables/tbl_1/rows/bulk', { rows: [{ company: 'Initech', amount: 12.5 }] }, expect.anything()),
        );
        expect(await screen.findByText('1 row imported · 1 skipped')).toBeTruthy();
    });

    it('deletes the table only once its name is typed, confirming what depends on it', async () => {
        (api.delete as jest.Mock).mockResolvedValue({ ok: true });
        await render('usage');
        await screen.findByText('Nightly import');
        await fireEvent.press(screen.getByTestId('table-menu'));
        await fireEvent.press(screen.getByText('Delete this table…'));
        await fireEvent.changeText(await screen.findByTestId('guarded-delete-name'), 'Leads');
        await fireEvent.press(screen.getByTestId('guarded-delete-confirm'));
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/datatables/tbl_1', { query: { confirmBreaking: 'true' } }));
    });
});
