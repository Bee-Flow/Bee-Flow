/**
 * Changing a share's grade from "People and teams": the licence refusal goes
 * to the tab (which offers the upgrade), and any other failure is said in a
 * toast — the menu has closed by then and the badge keeps the old grade, so
 * silence would read as "saved".
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { GrantsSection } from './GrantsSection';
import type { Datatable } from '../model/types';

jest.setTimeout(30_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const TABLE = { id: 'tbl_1', name: 'Customers', ownerUserId: 'me' } as Datatable;
const DIRECTORY = { users: [{ id: 'u1', name: 'Ada' }], groups: [], available: true };

async function draw(onPaywalled = jest.fn()) {
    (api.get as jest.Mock).mockResolvedValue({ grants: [{ id: 'g1', granteeType: 'user', granteeId: 'u1', grade: 'viewer' }] });
    await renderWithProviders(
        <ToastProvider>
            <GrantsSection table={TABLE} canEdit directory={DIRECTORY} onAdd={jest.fn()} onPaywalled={onPaywalled} />
        </ToastProvider>,
    );
    await fireEvent.press(await screen.findByTestId('grants-row-0'));
    return onPaywalled;
}

beforeEach(() => jest.clearAllMocks());

describe('GrantsSection', () => {
    it('says why a re-grade failed', async () => {
        (api.post as jest.Mock).mockRejectedValue(new ApiError('boom', { status: 500 }));
        const onPaywalled = await draw();
        await fireEvent.press(screen.getByLabelText('can change rows'));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/datatables/tbl_1/grants', expect.objectContaining({ grade: 'editor' })));
        expect(await screen.findByText('This is not something you did. Try again in a moment.')).toBeTruthy();
        expect(onPaywalled).not.toHaveBeenCalled();
    });

    it('hands a licence refusal to the tab instead', async () => {
        (api.post as jest.Mock).mockRejectedValue(new ApiError('Upgrade', { status: 402 }));
        const onPaywalled = await draw();
        await fireEvent.press(screen.getByLabelText('can change rows'));
        await waitFor(() => expect(onPaywalled).toHaveBeenCalledTimes(1));
    });
});
