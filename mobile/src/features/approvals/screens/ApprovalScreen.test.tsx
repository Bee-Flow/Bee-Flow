/**
 * One approval. A decision the server refuses is said through describeError —
 * the server's own sentence when it wrote one, the category's words when it
 * did not — and never as the client's "HTTP 500" placeholder.
 */

import { fireEvent, screen, userEvent } from '@testing-library/react-native';
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

/**
 * An approval that asks for answers (WI-13): the sheet asks them with a form
 * page's controls and Approve sends them; a run screen opens it at once with
 * `?decide=approve`. What came of it is said from the server's answer.
 */
describe('ApprovalScreen with answers', () => {
    const ASKING = {
        ...DETAIL,
        approval: { ...DETAIL.approval, isTest: true, fields: [{ name: 'amount', type: 'number', label: 'Amount', required: true }] },
    };

    it('opens the decide sheet at once, asks the answers and sends them with the approve', async () => {
        (api.get as jest.Mock).mockResolvedValue(ASKING);
        (api.post as jest.Mock).mockResolvedValueOnce({ accepted: true, pending: true, runId: 'r2', approval: {} });
        await renderScreen(<ApprovalScreen id="ap1" initialDecision="approve" />);
        expect(await screen.findByText('Your answers')).toBeTruthy();
        expect(screen.getAllByTestId('approval-test-chip').length).toBeGreaterThan(0);
        const user = userEvent.setup();
        // Required: Approve without the answer does not leave the phone.
        await user.press(screen.getByTestId('fill-submit'));
        expect(api.post).not.toHaveBeenCalled();
        await fireEvent.changeText(screen.getByTestId('fill-amount'), '12');
        await user.press(screen.getByTestId('fill-submit'));
        expect(api.post).toHaveBeenCalledWith(
            '/api/automation/approvals/ap1/decide',
            { decision: 'approve', answers: expect.objectContaining({ amount: '12' }) },
            { retry: false },
        );
        expect(await screen.findByText('Approved. The run continues.')).toBeTruthy();
    });

    it('says a vote is a vote', async () => {
        (api.post as jest.Mock).mockResolvedValueOnce({ accepted: true, decision: 'vote_recorded', stage: 'final' });
        await approve();
        expect(await screen.findByText('Your vote is recorded. It now waits for the final approver.')).toBeTruthy();
    });
});
