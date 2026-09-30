/**
 * One approval. A decision the server refuses is said through describeError —
 * the server's own sentence when it wrote one, the category's words when it
 * did not — and never as the client's "HTTP 500" placeholder.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { ApiError, api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { ApprovalScreen } from './ApprovalScreen';

jest.setTimeout(60_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const DETAIL = {
    approval: { id: 'ap1', automationTitle: 'Refunds', prompt: 'Refund order 42?', status: 'pending', createdAt: '2026-09-27T09:00:00Z' },
    canDecide: true,
    canWithdraw: false,
};

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockResolvedValue(DETAIL);
});

async function approve() {
    await renderScreen(<ApprovalScreen id="ap1" />);
    await fireEvent.press(await screen.findByLabelText('Approve'));
    // The bar's Approve renders first; the sheet's confirming one is the last.
    const buttons = screen.getAllByLabelText('Approve');
    await fireEvent.press(buttons[buttons.length - 1]!);
}

describe('ApprovalScreen', () => {
    it('says a failed decision in describeError’s words, not the raw status', async () => {
        (api.post as jest.Mock).mockRejectedValueOnce(new ApiError('HTTP 500', { status: 500 }));
        await approve();
        expect(await screen.findByText('This is not something you did. Try again in a moment.')).toBeTruthy();
        expect(screen.queryByText('HTTP 500')).toBeNull();
    });

    it('says a deadline a week away as a date, not "now"', async () => {
        const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
        (api.get as jest.Mock).mockResolvedValue({ ...DETAIL, approval: { ...DETAIL.approval, expiresAt } });
        await renderScreen(<ApprovalScreen id="ap1" />);
        expect(await screen.findByText(/^Decide before /)).toBeTruthy();
        expect(screen.queryByText(/now/i)).toBeNull();
    });

    it('says a settled approval’s state in the web’s words, not the server’s token', async () => {
        (api.get as jest.Mock).mockResolvedValue({
            ...DETAIL,
            canDecide: false,
            approval: { ...DETAIL.approval, status: 'rejected', decidedAt: '2026-09-27T10:00:00Z', decidedByName: 'Ada' },
        });
        await renderScreen(<ApprovalScreen id="ap1" />);
        expect(await screen.findByText('Declined')).toBeTruthy();
        expect(screen.queryByText('rejected')).toBeNull();
        expect(screen.getByText(/^Requested /)).toBeTruthy();
    });

    it('keeps the server’s own sentence when it wrote one', async () => {
        (api.post as jest.Mock).mockRejectedValueOnce(new ApiError('This approval was already decided.', { status: 409 }));
        await approve();
        expect(await screen.findByText('This approval was already decided.')).toBeTruthy();
    });
});
