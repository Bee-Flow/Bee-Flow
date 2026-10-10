import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import TransferOwnerDialog from './TransferOwnerDialog';
import { EDITOR_ID, makeFakeApi, makeMembers, OWNER_ID, reply } from './workspaceTestApi';

const { fetchMock, toastMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));
vi.mock('../../shared/Toast', () => ({ default: toastMock, toast: toastMock }));

function setup(transfer: unknown = { success: true }) {
    const api = makeFakeApi({
        'GET /api/projects/p1/members': makeMembers(),
        'POST /api/projects/p1/transfer-owner': transfer,
    });
    fetchMock.mockImplementation(api.fetchImpl);
    const onClose = vi.fn();
    render(withQueryClient(<TransferOwnerDialog open onClose={onClose} projectId="p1" ownerId={OWNER_ID} currentUserId={OWNER_ID} />));
    return { api, onClose, user: userEvent.setup() };
}

beforeEach(() => { fetchMock.mockReset(); toastMock.success.mockReset(); });

describe('TransferOwnerDialog', () => {
    it('lists only user members and posts the choice with the owner it saw', async () => {
        const { api, onClose, user } = setup();
        const select = await screen.findByTestId('transfer-target');
        await waitFor(() => expect(screen.getByRole('option', { name: 'Eddie Editor' })).toBeInTheDocument());
        expect(screen.queryByRole('option', { name: 'Olivia Owner' })).toBeNull();
        expect(screen.queryByRole('option', { name: 'Marketing' })).toBeNull();
        await user.selectOptions(select, EDITOR_ID);
        await user.click(screen.getByRole('radio', { name: 'Stay as viewer' }));
        await user.click(screen.getByTestId('transfer-confirm'));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(api.callsTo('POST', '/api/projects/p1/transfer-owner')[0].body).toEqual({
            toUserId: EDITOR_ID, keepMeAs: 'viewer', expectedOwnerId: OWNER_ID,
        });
        expect(toastMock.success).toHaveBeenCalledWith('Ownership transferred.');
    });

    it('shows an inline error and stays open on 409 owner_changed', async () => {
        const { onClose, user } = setup(reply(409, { error: 'The owner of this project changed in the meantime.', code: 'owner_changed' }));
        await waitFor(() => expect(screen.getByRole('option', { name: 'Eddie Editor' })).toBeInTheDocument());
        await user.selectOptions(screen.getByTestId('transfer-target'), EDITOR_ID);
        await user.click(screen.getByTestId('transfer-confirm'));
        expect(await screen.findByTestId('transfer-error')).toHaveTextContent('The owner changed in the meantime. Reload the page and try again.');
        expect(onClose).not.toHaveBeenCalled();
        expect(toastMock.success).not.toHaveBeenCalled();
    });

    it('asks for a target first', async () => {
        const { api, user } = setup();
        await user.click(await screen.findByTestId('transfer-confirm'));
        expect(await screen.findByText('Choose the new owner first.')).toBeInTheDocument();
        expect(api.callsTo('POST', '/api/projects/p1/transfer-owner')).toHaveLength(0);
    });
});
