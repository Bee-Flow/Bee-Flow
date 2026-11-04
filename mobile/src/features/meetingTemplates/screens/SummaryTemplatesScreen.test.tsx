/**
 * The summary-templates screen: the list, a new template saved with the
 * route's own body, a delete that asks first, and a failed delete whose error
 * does not follow the sheet to the next template.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { SummaryTemplatesScreen } from './SummaryTemplatesScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const LIST = {
    builtins: [{ id: 'general', name: 'General meeting', prompt: 'Summarise the meeting.' }],
    custom: [{ id: 't1', name: 'Board summary', scope: 'user', isDefault: true, prompt: 'Board style' }],
    defaultTemplateId: 't1',
    canManageOrg: false,
};

const renderScreen = () =>
    renderWithProviders(
        <ConfirmProvider>
            <SummaryTemplatesScreen />
        </ConfirmProvider>
    );

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockResolvedValue(LIST);
    (api.post as jest.Mock).mockResolvedValue({ id: 't2', name: 'General meeting' });
    (api.delete as jest.Mock).mockResolvedValue({ ok: true });
});

describe('SummaryTemplatesScreen', () => {
    it('lists the custom templates with their scope and default mark', async () => {
        await renderScreen();
        expect(await screen.findByText('Board summary')).toBeTruthy();
        expect(screen.getByText('Just me')).toBeTruthy();
        expect(screen.getByText('Default')).toBeTruthy();
    });

    it('marks only the default that applies to new meetings when a personal and an org default are both visible', async () => {
        (api.get as jest.Mock).mockResolvedValue({
            ...LIST,
            custom: [
                ...LIST.custom,
                { id: 'o1', name: 'Org style', scope: 'org', isDefault: true, prompt: 'Org' },
                { id: 'g1', name: 'Team style', scope: 'group', groupId: 'grp', isDefault: true, prompt: 'Team' },
            ],
            defaultTemplateId: 't1',
        });
        await renderScreen();
        await screen.findByText('Org style');
        expect(screen.getByText('Team style')).toBeTruthy();
        expect(screen.getAllByText('Default')).toHaveLength(1);
    });

    it('marks the org default when the person has no default of their own', async () => {
        (api.get as jest.Mock).mockResolvedValue({
            ...LIST,
            custom: [
                { id: 't1', name: 'Board summary', scope: 'user', prompt: 'Board style' },
                { id: 'o1', name: 'Org style', scope: 'org', isDefault: true, prompt: 'Org' },
            ],
            defaultTemplateId: 'o1',
        });
        await renderScreen();
        await screen.findByText('Org style');
        expect(screen.getAllByText('Default')).toHaveLength(1);
    });

    it('creates a template from a built-in', async () => {
        await renderScreen();
        await screen.findByText('Board summary');
        await fireEvent.press(screen.getByLabelText('New template…'));
        await fireEvent.press(await screen.findByText('General meeting'));
        await fireEvent.press(screen.getByText('Save template'));
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith('/api/summary-templates', {
                scope: 'user',
                name: 'General meeting',
                prompt: 'Summarise the meeting.',
                isDefault: false,
            }),
        );
    });

    it('asks before deleting a template', async () => {
        await renderScreen();
        await fireEvent.press(await screen.findByText('Board summary'));
        await fireEvent.press(await screen.findByText('Delete'));
        expect(await screen.findByText('Delete this template?')).toBeTruthy();
        // The sheet's own Delete, then the confirmation's.
        const [, confirmDelete] = screen.getAllByText('Delete');
        await fireEvent.press(confirmDelete!);
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/summary-templates/t1'));
    });

    it('does not carry a failed delete error over to the next template the sheet opens', async () => {
        (api.get as jest.Mock).mockResolvedValue({
            ...LIST,
            custom: [...LIST.custom, { id: 't2', name: 'Weekly sync', scope: 'user', prompt: 'Weekly' }],
        });
        (api.delete as jest.Mock).mockRejectedValue(new Error('Not allowed'));
        await renderScreen();
        await fireEvent.press(await screen.findByText('Board summary'));
        await fireEvent.press(await screen.findByText('Delete'));
        const [, confirmDelete] = screen.getAllByText('Delete');
        await fireEvent.press(confirmDelete!);
        expect(await screen.findByText(/Not allowed/)).toBeTruthy();

        await fireEvent.press(screen.getByText('Cancel'));
        await waitFor(() => expect(screen.queryByText('Edit template')).toBeNull());
        await fireEvent.press(screen.getByText('Weekly sync'));
        expect(await screen.findByText('Edit template')).toBeTruthy();
        expect(screen.queryByText(/Not allowed/)).toBeNull();

        await fireEvent.press(screen.getByText('Cancel'));
        await waitFor(() => expect(screen.queryByText('Edit template')).toBeNull());
        await fireEvent.press(screen.getByLabelText('New template…'));
        expect(await screen.findByText('New summary template')).toBeTruthy();
        expect(screen.queryByText(/Not allowed/)).toBeNull();
    });

    it('lists an org template a member only sees without Save or Delete', async () => {
        (api.get as jest.Mock).mockResolvedValue({
            ...LIST,
            custom: [{ id: 'o1', name: 'Org style', scope: 'org', prompt: 'Org' }],
        });
        await renderScreen();
        await fireEvent.press(await screen.findByText('Org style'));
        expect(screen.queryByText('Delete')).toBeNull();
        expect(screen.queryByText('Save template')).toBeNull();
    });

    it('offers the new-template action on an empty list', async () => {
        (api.get as jest.Mock).mockResolvedValue({ ...LIST, custom: [] });
        await renderScreen();
        expect(await screen.findByText("You haven't saved any templates yet.")).toBeTruthy();
    });
});
