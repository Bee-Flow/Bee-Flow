/**
 * One Cowork schedule. The server hard-deletes a schedule and its runs, and
 * Delete sits right under "Run now" — so the one thing pinned here is that a
 * tap asks first, cancelling keeps it, and only a confirmation deletes. A
 * failed write is said through describeError, not as the raw message.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { ApiError, api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { CoworkDetailScreen } from './CoworkDetailScreen';

jest.setTimeout(60_000);

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack, navigate: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const SCHEDULE = {
    id: 'c1',
    title: 'Weekly digest',
    prompt: 'Summarise the week.',
    repeatInterval: 'weekly',
    isActive: true,
    runCount: 3,
};

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) =>
        Promise.resolve(path === '/api/cowork/c1' ? SCHEDULE : []),
    );
    (api.delete as jest.Mock).mockResolvedValue({ success: true });
});

async function open() {
    await renderScreen(<CoworkDetailScreen id="c1" />);
    await screen.findByText('Summarise the week.');
}

/** The sheet's Delete; the screen's own Delete button carries the same label and renders first. */
async function confirmDelete() {
    const buttons = screen.getAllByLabelText('Delete');
    await fireEvent.press(buttons[buttons.length - 1]!);
}

describe('CoworkDetailScreen', () => {
    it('asks before deleting, and cancelling keeps the schedule', async () => {
        await open();
        await fireEvent.press(screen.getByTestId('cowork-delete'));
        expect(await screen.findByText('Delete this cowork?')).toBeTruthy();
        expect(screen.getByText('“Weekly digest” stops running and its history is removed. This can’t be undone.')).toBeTruthy();
        expect(api.delete).not.toHaveBeenCalled();

        await fireEvent.press(screen.getByText('Cancel'));
        expect(api.delete).not.toHaveBeenCalled();
        expect(mockBack).not.toHaveBeenCalled();
    });

    it('deletes only once confirmed, then goes back', async () => {
        await open();
        await fireEvent.press(screen.getByTestId('cowork-delete'));
        await screen.findByText('Delete this cowork?');
        await confirmDelete();
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/cowork/c1'));
        await waitFor(() => expect(mockBack).toHaveBeenCalled());
    });

    it('says a failed delete through describeError, not the raw status', async () => {
        (api.delete as jest.Mock).mockRejectedValueOnce(new ApiError('HTTP 500', { status: 500 }));
        await open();
        await fireEvent.press(screen.getByTestId('cowork-delete'));
        await screen.findByText('Delete this cowork?');
        await confirmDelete();
        expect(await screen.findByText('This is not something you did. Try again in a moment.')).toBeTruthy();
        expect(screen.queryByText('HTTP 500')).toBeNull();
        expect(mockBack).not.toHaveBeenCalled();
    });

    it('draws its actions in the web’s words', async () => {
        await open();
        expect(screen.getByText('What it does')).toBeTruthy();
        expect(screen.getByText('Pause')).toBeTruthy();
        expect(screen.getByText('Run now')).toBeTruthy();
        expect(screen.getByText('Changing what this asks for is desktop work — open it in the web app.')).toBeTruthy();
    });
});
