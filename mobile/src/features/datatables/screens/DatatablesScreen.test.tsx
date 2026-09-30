/**
 * The Datatables list against canned answers: every table the server graded,
 * where a new one would go, the search, and a new table created and opened.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { DatatablesScreen } from './DatatablesScreen';

let mockCanManage = true;
jest.mock('@/core/access', () => ({ useHasPermission: () => mockCanManage }));
// The list reads one answer and creates with one post; nothing else is called.
jest.mock('@/core/api/client', () => ({ ...jest.requireActual('@/core/api/client'), api: { get: jest.fn(), post: jest.fn() } }));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

jest.setTimeout(30_000);

const TABLES = [
    { id: 'tbl_1', name: 'Leads', key: 'leads', description: 'Sales leads', rowCount: 1284, grade: 'owner', scopeKind: 'org', isPublished: true, sharedGroups: [], usageCount: 2 },
    { id: 'tbl_2', name: 'Notes', key: 'notes', description: '', rowCount: 1, grade: 'viewer', scopeKind: 'user', usageCount: 0 },
];

const render = () =>
    renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>
                <DatatablesScreen />
            </ConfirmProvider>
        </ToastProvider>,
    );

beforeEach(() => {
    mockPush.mockReset();
    mockCanManage = true;
    (api.get as jest.Mock).mockResolvedValue({ datatables: TABLES, scope: { kind: 'org', id: 'o1', label: 'your organisation' } });
});

describe('DatatablesScreen', () => {
    it('lists every table with what it is, what you may do and who can see it', async () => {
        await render();
        expect(await screen.findByText('Leads')).toBeTruthy();
        expect(screen.getByText('Sales leads · You own this table')).toBeTruthy();
        expect(screen.getByText(`${(1284).toLocaleString()} rows · used by 2`)).toBeTruthy();
        expect(screen.getByText('Whole organisation')).toBeTruthy();
        expect(screen.getByText('No description · You can read rows')).toBeTruthy();
        expect(screen.getByText('Personal')).toBeTruthy();
        expect(screen.getByText('New tables here belong to your organisation. You choose afterwards who may read or change them.')).toBeTruthy();
    });

    it('counts the tables in the singular and the plural', async () => {
        await render();
        expect(await screen.findByText('2 tables')).toBeTruthy();
    });

    it('does not say "1 tables"', async () => {
        (api.get as jest.Mock).mockResolvedValue({ datatables: [TABLES[0]], scope: { kind: 'org', id: 'o1', label: 'your organisation' } });
        await render();
        expect(await screen.findByText('1 table')).toBeTruthy();
    });

    it('opens a table', async () => {
        await render();
        await fireEvent.press(await screen.findByTestId('datatable-tbl_1'));
        expect(mockPush).toHaveBeenCalledWith('/datatables/tbl_1');
    });

    it('offers no create in an organisation without manage_datatables', async () => {
        mockCanManage = false;
        await render();
        await screen.findByText('Leads');
        expect(screen.queryByTestId('new-datatable')).toBeNull();
    });

    it('creates a table from a name and a purpose, and opens it', async () => {
        (api.post as jest.Mock).mockResolvedValue({ datatable: { id: 'tbl_9', name: 'Invoice log' } });
        await render();
        await fireEvent.press(await screen.findByTestId('new-datatable'));
        await fireEvent.changeText(screen.getByTestId('new-datatable-name'), 'Invoice log');
        await fireEvent.changeText(screen.getByTestId('new-datatable-purpose'), 'Invoices we sent');
        expect(screen.getByText('Technical name: invoice_log')).toBeTruthy();
        await fireEvent.press(screen.getByText('Create'));
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/datatables/tbl_9'));
        expect(api.post).toHaveBeenCalledWith('/api/datatables', {
            scope: 'organisation', name: 'Invoice log', key: 'invoice_log', description: 'Invoices we sent', fields: [],
        });
    });
});
