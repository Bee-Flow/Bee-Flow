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
import { SharedDetailScreen } from './SharedDetailScreen';

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

    describe('a run that asked its owner', () => {
        const RUNS = [
            {
                id: 'r1',
                status: 'needs_review',
                startedAt: '2026-09-02T10:00:00Z',
                review: { reason: 'Needs a discount', question: 'May I offer 10%?', summary: null, resolution: null },
            },
            { id: 'r0', status: 'completed', result: 'Sent the digest.', startedAt: '2026-09-01T10:00:00Z', review: null },
        ];
        const noReceipt = () => Promise.reject(new ApiError('HTTP 404', { status: 404 }));
        const serve = (receipt: () => Promise<unknown>) =>
            (api.get as jest.Mock).mockImplementation((path: string) => {
                if (path === '/api/cowork/c1') return Promise.resolve(SCHEDULE);
                if (path === '/api/cowork/c1/runs') return Promise.resolve({ runs: RUNS });
                if (path === '/api/cowork/c1/runs/r0/receipt') return receipt();
                return Promise.resolve([]);
            });

        it('shows the question on top, and sends the answer to that run', async () => {
            serve(noReceipt);
            (api.post as jest.Mock).mockResolvedValue({ ok: true });
            await open();
            expect(await screen.findByText('May I offer 10%?')).toBeTruthy();
            expect(screen.getByText('Needs a discount')).toBeTruthy();
            await fireEvent.changeText(screen.getByTestId('cowork-review-answer'), '  Yes, 10%  ');
            await fireEvent.press(screen.getByTestId('cowork-review-send'));
            await waitFor(() =>
                expect(api.post).toHaveBeenCalledWith('/api/cowork/c1/runs/r1/review', { action: 'answer', answer: 'Yes, 10%' }),
            );
        });

        it('closes it as done by hand without an answer', async () => {
            serve(noReceipt);
            (api.post as jest.Mock).mockResolvedValue({ ok: true });
            await open();
            await screen.findByText('May I offer 10%?');
            await fireEvent.press(screen.getByTestId('cowork-review-done'));
            await waitFor(() =>
                expect(api.post).toHaveBeenCalledWith('/api/cowork/c1/runs/r1/review', { action: 'done_myself' }),
            );
        });

        it('reads a receipt only when a run is opened', async () => {
            serve(() => Promise.resolve({ seq: 7, runId: 'r0', at: null, signed: true }));
            await open();
            await screen.findByText('Sent the digest.');
            expect(api.get).not.toHaveBeenCalledWith('/api/cowork/c1/runs/r0/receipt', expect.anything());
            await fireEvent.press(screen.getByLabelText('Completed'));
            expect(await screen.findByText('Receipt #7 · signed')).toBeTruthy();
        });

        it('shows no receipt line for a 404', async () => {
            serve(noReceipt);
            await open();
            await screen.findByText('Sent the digest.');
            await fireEvent.press(screen.getByLabelText('Completed'));
            await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/cowork/c1/runs/r0/receipt', expect.anything()));
            expect(screen.queryByTestId('cowork-receipt')).toBeNull();
        });
    });
});

describe('SharedDetailScreen', () => {
    it('shows what it does and its runs, and nothing to pause, run or delete', async () => {
        (api.get as jest.Mock).mockImplementation((path: string) => {
            if (path === '/api/cowork/shared') {
                return Promise.resolve({ items: [{ id: 's1', ownerId: 'u2', ownerName: 'Ann', title: 'Weekly digest', role: 'viewer' }] });
            }
            if (path === '/api/cowork/shared/s1') {
                return Promise.resolve({
                    role: 'viewer',
                    item: { id: 's1', title: 'Weekly digest', prompt: 'Summarise the week.', isActive: true, nextRunAt: null },
                    runs: [{ id: 'r1', status: 'completed', result: 'Sent it.', startedAt: null, durationMs: 10 }],
                });
            }
            return Promise.resolve([]);
        });
        await renderScreen(<SharedDetailScreen id="s1" />);
        expect(await screen.findByText('Summarise the week.')).toBeTruthy();
        expect(screen.getByText('Sent it.')).toBeTruthy();
        expect(await screen.findByText('Ann’s, you can see it')).toBeTruthy();
        expect(screen.getByText('You can look along here. Changing it is up to Ann.')).toBeTruthy();
        for (const label of ['Pause', 'Resume', 'Run now', 'Delete']) expect(screen.queryByLabelText(label)).toBeNull();
        expect(api.post).not.toHaveBeenCalled();
    });
});
